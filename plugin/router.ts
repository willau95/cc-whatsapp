#!/usr/bin/env bun
/**
 * cc-whatsapp router daemon (per-project).
 *
 * - State / config / persona live in <consumer-project>/.claude/cc-whatsapp/
 *   (override with env CC_WHATSAPP_PROJECT_DIR).
 * - Binary location resolves to repo bin/cc-whatsapp by default
 *   (override with env CC_WHATSAPP_BIN).
 * - Account name read from <project>/.claude/cc-whatsapp/config.json;
 *   passed as --account to every cc-whatsapp call so projects can share
 *   one host but own their WhatsApp identity.
 */

import { spawn, spawnSync } from 'child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

// ─── Plugin self-discovery (where am I installed?) ───
// PLUGIN_ROOT = .../cc-whatsapp/plugin/
// REPO_ROOT  = .../cc-whatsapp/  (binary lives at REPO_ROOT/bin/cc-whatsapp)
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(PLUGIN_ROOT)

// ─── State dir architecture (centralized) ───
// State lives at ~/.cc-whatsapp/projects/<id>/, NOT inside the project itself.
// Avoids macOS TCC issues when projects sit in Desktop/Documents/iCloud.
// env CC_WHATSAPP_PROJECT_DIR is the absolute path to this state dir, set by
// the dashboard-generated run.command.
const STATE_DIR = process.env.CC_WHATSAPP_PROJECT_DIR
              ?? join(homedir(), '.cc-whatsapp', 'projects', 'default')

const ACCESS_FILE   = join(STATE_DIR, 'access.json')
const SECRET_FILE   = join(STATE_DIR, '.secret')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
const CONFIG_FILE   = join(STATE_DIR, 'config.json')
const ROUTER_PID    = join(STATE_DIR, 'router.pid')
const SYNC_PID      = join(STATE_DIR, 'sync.pid')
const TRACE_FILE    = join(STATE_DIR, 'trace.log')
const STATE_SNAP    = join(STATE_DIR, 'state.json')   // live state machine snapshot (dashboard polls)
const HEALTH_SNAP   = join(STATE_DIR, 'health.json')  // wacli connection health (dashboard surfaces as banner)
const TURNS_DIR     = join(STATE_DIR, 'turns')         // per-turn prompt/response snapshots
const AGENT_DIR     = join(STATE_DIR, 'agent')
const CONTACTS_DIR  = join(AGENT_DIR, 'contacts')

// server.ts is plugin source, not per-project — always in PLUGIN_ROOT.
const SERVER_FILE = join(PLUGIN_ROOT, 'server.ts')

// Binary discovery: env → repo bin → PATH lookup.
const CC_WHATSAPP_BIN = process.env.CC_WHATSAPP_BIN
                     ?? (existsSync(join(REPO_ROOT, 'bin', 'cc-whatsapp'))
                         ? join(REPO_ROOT, 'bin', 'cc-whatsapp')
                         : 'cc-whatsapp')
const WACLI_BIN = CC_WHATSAPP_BIN  // alias for legacy code paths below
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
const CHAT_MODEL = process.env.CC_WHATSAPP_CHAT_MODEL ?? 'claude-haiku-4-5-20251001'
const PORT = Number(process.env.CC_WHATSAPP_PORT ?? 38600)
const MAX_PROMPT_CHARS = 8_000

// ─── Per-project wacli account ───
// Each project pairs its own WhatsApp number under wacli's multi-account
// system. Account name is set by /cc-whatsapp:init wizard.
function loadProjectConfig(): { account?: string; ownerJid?: string; port?: number; defaultProject?: string; bindings?: Record<string, string>; mode?: string; project_path?: string } {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  catch { return {} }
}
const WACLI_ACCOUNT = loadProjectConfig().account ?? 'main'
const HUB_PROJECT_PATH = loadProjectConfig().project_path ?? process.cwd()

// Map a project cwd → its central state dir (~/.cc-whatsapp/projects/<id>/).
// `id` = base64url(absPath) — same encoding dashboard uses.
function stateDirFor(projectPath: string): string {
  const id = Buffer.from(projectPath).toString('base64url')
  return join(homedir(), '.cc-whatsapp', 'projects', id)
}

// Project mode — bot (full chatbot) vs terminal-extension (lean, owner-only).
// Per-spawn lookup since dispatcher routes to different projects.
function getProjectMode(stateDir: string): 'bot' | 'terminal-extension' {
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
    if (cfg.mode === 'terminal-extension') return 'terminal-extension'
    if (cfg.mode === 'bot') return 'bot'
  } catch {}
  // Fallback by file presence (legacy projects without mode field)
  return existsSync(join(stateDir, 'agent', 'IDENTITY.md')) ? 'bot' : 'terminal-extension'
}

// ─── Dispatcher: route by JID to target project ────────────────────────────
// This (the "hub") project's config.json can carry routing info:
//   defaultProject: <abs-path>  — where DMs land (default: this project)
//   bindings:                    — group JID → project path
//     "120363xxx@g.us": "/Users/me/Projects/quant-trade"
//     "120363yyy@g.us": "/Users/me/Projects/eva-chat"
//
// If no bindings/default specified, the hub IS the default project (legacy).
// Account-level owner-personal-chat tracking. JIDs the owner has DM'd first
// (from_me=true) are stored here, and ANY project on this account silently
// drops subsequent traffic from those JIDs — your personal chats never reach
// the bot pipeline.
const CC_ACCOUNTS_DIR = join(homedir(), '.cc-whatsapp', 'accounts')
const OWNER_PERSONAL_FILE = join(CC_ACCOUNTS_DIR, WACLI_ACCOUNT, 'owner_personal_chats.json')

function loadOwnerPersonalChats(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(OWNER_PERSONAL_FILE, 'utf8'))) } catch { return new Set() }
}
function markOwnerPersonal(jid: string): void {
  const s = loadOwnerPersonalChats()
  if (s.has(jid)) return
  s.add(jid)
  try {
    mkdirSync(dirname(OWNER_PERSONAL_FILE), { recursive: true, mode: 0o700 })
    writeFileSync(OWNER_PERSONAL_FILE, JSON.stringify(Array.from(s).sort(), null, 2))
  } catch {}
}

// Enumerate all projects on this wacli account (used for sticky + eligible auto-pick).
type SiblingProject = { stateDir: string; cwd: string; mode: 'bot' | 'terminal-extension'; accessMode: 'open' | 'closed'; allowFrom: Set<string>; activityMtime: number }
function listSameAccountProjects(): SiblingProject[] {
  const projectsRoot = join(homedir(), '.cc-whatsapp', 'projects')
  const out: SiblingProject[] = []
  let ids: string[]
  try { ids = readdirSync(projectsRoot) } catch { return out }
  for (const id of ids) {
    const stateDir = join(projectsRoot, id)
    let cfg: any
    try { cfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')) } catch { continue }
    if (cfg.account !== WACLI_ACCOUNT) continue
    if (!cfg.project_path || !existsSync(cfg.project_path)) continue
    let access: any = { allowFrom: [], mode: 'open' }
    try { access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) } catch {}
    const mode: 'bot' | 'terminal-extension' = (cfg.mode === 'terminal-extension') ? 'terminal-extension' :
                                                (cfg.mode === 'bot') ? 'bot' :
                                                (existsSync(join(stateDir, 'agent', 'IDENTITY.md')) ? 'bot' : 'terminal-extension')
    let mtime = 0
    try { mtime = statSync(join(stateDir, 'trace.log')).mtimeMs } catch {}
    out.push({
      stateDir, cwd: cfg.project_path, mode,
      accessMode: (access.mode === 'closed' ? 'closed' : 'open'),
      allowFrom: new Set(access.allowFrom ?? []),
      activityMtime: mtime,
    })
  }
  return out
}

// 5-tier resolution. See top-of-file comment for full design.
function resolveTargetProject(jid: string): { stateDir: string; cwd: string; account: string; resolvedBy: string } {
  const cfg = loadProjectConfig()
  const bindings = cfg.bindings ?? {}

  // ❶ Explicit binding (groups OR DMs the user explicitly bound)
  if (bindings[jid]) {
    const cwd = bindings[jid]!
    return { stateDir: stateDirFor(cwd), cwd, account: WACLI_ACCOUNT, resolvedBy: 'binding' }
  }

  const siblings = listSameAccountProjects()

  // ❷ Sticky: any sibling has this JID in its allowFrom → that's home
  const sticky = siblings.find(p => p.allowFrom.has(jid))
  if (sticky) {
    return { stateDir: sticky.stateDir, cwd: sticky.cwd, account: WACLI_ACCOUNT, resolvedBy: 'sticky_allowFrom' }
  }

  // ❹ Explicit default
  if (cfg.defaultProject && cfg.defaultProject !== HUB_PROJECT_PATH && existsSync(cfg.defaultProject)) {
    return { stateDir: stateDirFor(cfg.defaultProject), cwd: cfg.defaultProject, account: WACLI_ACCOUNT, resolvedBy: 'explicit_default' }
  }

  // ❺ Eligible auto-pick: bot-mode + open access projects, sorted by recent activity
  const eligible = siblings.filter(p => p.mode === 'bot' && p.accessMode === 'open')
  if (eligible.length > 0) {
    eligible.sort((a, b) => b.activityMtime - a.activityMtime)
    const picked = eligible[0]!
    return { stateDir: picked.stateDir, cwd: picked.cwd, account: WACLI_ACCOUNT, resolvedBy: `eligible_auto(${eligible.length} candidates)` }
  }

  // Last resort: hub (likely drops if its access is closed — that's correct, no eligible target)
  return { stateDir: STATE_DIR, cwd: HUB_PROJECT_PATH, account: WACLI_ACCOUNT, resolvedBy: 'hub_fallback' }
}

// ─── Contact memory v2 ─────────────────────────────────────────────────────
// Per-contact memory used to be ONE flat .md. Now it's a directory with a
// small always-loaded card.md + on-demand subfiles. Backward-compatible: if
// `<jid>.md` already exists (old format), we keep it AND create card.md
// alongside on first touch.
function contactDirFor(stateDir: string, jid: string): string {
  return join(stateDir, 'agent', 'contacts', jid)
}
function contactCardPath(stateDir: string, jid: string): string {
  return join(contactDirFor(stateDir, jid), 'card.md')
}
function legacyContactPath(stateDir: string, jid: string): string {
  return join(stateDir, 'agent', 'contacts', `${jid}.md`)
}
function contactExists(stateDir: string, jid: string): boolean {
  return existsSync(contactCardPath(stateDir, jid)) || existsSync(legacyContactPath(stateDir, jid))
}

// Track our own spawned claude PIDs so we can distinguish from external
// `claude --resume <uuid>` processes (i.e., user running claude in a terminal
// with the same session UUID — happens when Owner JID is set so the WA chat
// shares state with the user's terminal session).
const ourClaudePids = new Set<number>()

// Smart defer: only defer when terminal claude is ACTIVELY writing to the
// session jsonl (= jsonl mtime within last SESSION_BUSY_WINDOW_MS). This
// lets terminal + WhatsApp run concurrently 99% of the time (terminal sits
// idle most of the time) and only blocks during active terminal generation.
const SESSION_BUSY_WINDOW_MS = 60_000   // 60s — covers a typical claude turn
function jsonlPathFor(projectPath: string, uuid: string): string {
  // Same hash transform as findLatestSessionUuid (claude-code's convention)
  const claudeHash = projectPath.replace(/[\/\s]+/g, '-')
  return join(homedir(), '.claude', 'projects', claudeHash, `${uuid}.jsonl`)
}
function isSessionInUseByExternal(uuid: string, projectPath?: string): boolean {
  try {
    const r = spawnSync('pgrep', ['-f', `claude.*${uuid}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    if (r.status !== 0 || !r.stdout) return false
    const pids = r.stdout.toString().trim().split('\n').map(s => parseInt(s, 10)).filter(Number.isFinite)
    const external = pids.some(p => !ourClaudePids.has(p))
    if (!external) return false
    // External claude exists. Only consider it "in use" if jsonl was touched
    // in the recent past — otherwise it's idle and we can spawn safely.
    if (projectPath) {
      try {
        const st = statSync(jsonlPathFor(projectPath, uuid))
        const idleMs = Date.now() - st.mtimeMs
        if (idleMs > SESSION_BUSY_WINDOW_MS) {
          trace('external_claude_idle_proceed', { uuid, idleMs })
          return false   // idle long enough — safe to proceed
        }
        return true   // recently active — defer
      } catch {
        // Can't stat the jsonl — be conservative and defer
        return true
      }
    }
    return true
  } catch { return false }
}

// ─── Tunables (re-read from disk every time so dashboard edits go live) ───
// tunables.json overrides env-var defaults. Dashboard writes it; we read it.
const TUNABLES_FILE = join(STATE_DIR, 'tunables.json')
type Tunables = {
  collect_window_ms: number
  pre_reply_min_ms: number
  pre_reply_max_ms: number
  quote_reply_probability: number
  multi_msg_max_segments: number
  inter_segment_min_ms: number
  inter_segment_max_ms: number
  enable_typing_indicator: boolean
  max_prompt_chars: number
  length_factor_short: number
  length_factor_medium: number
  length_factor_long: number
  dry_run: boolean

  // Claude Code launch flags (added Commit 3)
  chat_model: string
  fallback_model: string
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  permission_mode: 'bypassPermissions' | 'acceptEdits' | 'auto' | 'default' | 'dontAsk' | 'plan'
  allowed_tools: string[]
  disallowed_tools: string[]
  add_dirs: string[]
  max_budget_usd_per_turn: number
  system_prompt_override: string
  plugin_dirs: string[]
  plugin_urls: string[]
  setting_sources: string
  exclude_dynamic_system_prompt_sections: boolean
}
// tunables(forStateDir?) — when called with a target project's state dir, reads
// THAT project's tunables.json. Without arg, reads the hub's (router's own).
// Used so satellite projects' batching / pre-reply delays / model / typing-
// indicator preferences actually take effect — hub's router was previously the
// only tunables source which made satellite Tunables UI a no-op for routed JIDs.
function tunables(forStateDir?: string): Tunables {
  let stored: any = {}
  const file = forStateDir ? join(forStateDir, 'tunables.json') : TUNABLES_FILE
  try { stored = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    collect_window_ms: stored.collect_window_ms ?? Number(process.env.CC_WHATSAPP_COLLECT_WINDOW_MS ?? 60_000),
    pre_reply_min_ms:  stored.pre_reply_min_ms  ?? Number(process.env.CC_WHATSAPP_PRE_REPLY_MIN_MS  ?? 30_000),
    pre_reply_max_ms:  stored.pre_reply_max_ms  ?? Number(process.env.CC_WHATSAPP_PRE_REPLY_MAX_MS  ?? 60_000),
    quote_reply_probability: stored.quote_reply_probability ?? 0.4,
    multi_msg_max_segments:  stored.multi_msg_max_segments  ?? 4,
    inter_segment_min_ms:    stored.inter_segment_min_ms    ?? 800,
    inter_segment_max_ms:    stored.inter_segment_max_ms    ?? 2200,
    enable_typing_indicator: stored.enable_typing_indicator !== false,
    max_prompt_chars: stored.max_prompt_chars ?? 8000,
    length_factor_short:  stored.length_factor_short  ?? 0.5,
    length_factor_medium: stored.length_factor_medium ?? 1.0,
    length_factor_long:   stored.length_factor_long   ?? 1.6,
    dry_run: process.env.CC_WHATSAPP_DRY_RUN === '1',

    chat_model: stored.chat_model ?? (process.env.CC_WHATSAPP_CHAT_MODEL ?? 'claude-haiku-4-5-20251001'),
    fallback_model: typeof stored.fallback_model === 'string' ? stored.fallback_model : '',
    effort: ['low','medium','high','xhigh','max'].includes(stored.effort) ? stored.effort : '',
    permission_mode: ['bypassPermissions','acceptEdits','auto','default','dontAsk','plan'].includes(stored.permission_mode) ? stored.permission_mode : 'bypassPermissions',
    allowed_tools:    arr(stored.allowed_tools),
    disallowed_tools: arr(stored.disallowed_tools),
    add_dirs:         arr(stored.add_dirs),
    max_budget_usd_per_turn: typeof stored.max_budget_usd_per_turn === 'number' ? stored.max_budget_usd_per_turn : 0,
    system_prompt_override: typeof stored.system_prompt_override === 'string' ? stored.system_prompt_override : '',
    plugin_dirs: arr(stored.plugin_dirs),
    plugin_urls: arr(stored.plugin_urls),
    setting_sources: typeof stored.setting_sources === 'string' && stored.setting_sources ? stored.setting_sources : 'user,project,local',
    exclude_dynamic_system_prompt_sections: stored.exclude_dynamic_system_prompt_sections === true,
  }
}

// ─── Extra per-project MCP servers (merged into MCP_JSON each turn) ─────────
const EXTRA_MCPS_FILE = join(STATE_DIR, 'extra_mcps.json')
function loadExtraMcps(): Record<string, any> {
  try {
    const obj = JSON.parse(readFileSync(EXTRA_MCPS_FILE, 'utf8'))
    if (obj && typeof obj === 'object' && obj.mcpServers && typeof obj.mcpServers === 'object') {
      return obj.mcpServers
    }
  } catch {}
  return {}
}
// Legacy aliases (referenced elsewhere; resolve fresh each call)
const DRY_RUN = process.env.CC_WHATSAPP_DRY_RUN === '1'

// ─── persona system prompt (loaded once at startup) ───
// Composed from agent/IDENTITY.md + SOUL.md + STYLE.md + AGENTS.md + MEMORY.md
function loadPersonaPrompt(): string {
  const parts: string[] = []
  for (const name of ['IDENTITY', 'SOUL', 'STYLE', 'AGENTS', 'MEMORY']) {
    const path = join(AGENT_DIR, `${name}.md`)
    try {
      parts.push(`════════════════════════════════════════\n${name}.md (${path})\n════════════════════════════════════════\n${readFileSync(path, 'utf8').trim()}`)
    } catch {}
  }
  return parts.join('\n\n')
}
const PERSONA_PROMPT = loadPersonaPrompt()

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

function trace(evt: string, details?: unknown): void {
  const line = `${new Date().toISOString()} ${evt}${details !== undefined ? ' ' + JSON.stringify(details) : ''}\n`
  try { appendFileSync(TRACE_FILE, line) } catch {}
  process.stderr.write(line)
}

function getOrCreateSecret(): string {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim()
  const s = randomBytes(32).toString('hex')
  writeFileSync(SECRET_FILE, s, { mode: 0o600 })
  return s
}

type AccessMode = 'open' | 'closed'
type Access = { allowFrom: string[]; disabled?: boolean; mode?: AccessMode }
function loadAccess(): Required<Access> {
  try {
    const p = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      allowFrom: p.allowFrom ?? [],
      disabled: !!p.disabled,
      mode: (p.mode === 'closed' ? 'closed' : 'open') as AccessMode,  // default open
    }
  } catch { return { allowFrom: [], disabled: false, mode: 'open' } }
}

// Atomically add a new sender + (bot mode only) create contact memory v2 dir.
// Terminal-extension mode skips the memory v2 dir — the project's CLAUDE.md +
// session JSONL is the memory; per-contact directories don't make sense for
// owner-only use.
function autoOnboardSender(targetStateDir: string, jid: string, pushName?: string): void {
  const mode = getProjectMode(targetStateDir)
  const targetAccessFile = join(targetStateDir, 'access.json')
  // 1. add to allowFrom (target project's access.json)
  try {
    let access: any = { allowFrom: [], mode: 'open' }
    try { access = JSON.parse(readFileSync(targetAccessFile, 'utf8')) } catch {}
    if (!access.allowFrom) access.allowFrom = []
    if (!access.allowFrom.includes(jid)) {
      access.allowFrom.push(jid)
      const tmp = targetAccessFile + '.tmp'
      mkdirSync(dirname(targetAccessFile), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, targetAccessFile)
    }
  } catch (err) { trace('auto_onboard_allowlist_err', { jid, err: String(err) }) }

  // 2. (bot mode only) create contacts/<jid>/{card.md, ...} (memory v2)
  if (mode === 'terminal-extension') {
    trace('contact_v2_skip_terminal_extension', { jid, mode })
    return
  }
  try {
    const contactDir = contactDirFor(targetStateDir, jid)
    const cardPath = contactCardPath(targetStateDir, jid)
    if (existsSync(cardPath)) return  // already onboarded
    mkdirSync(contactDir, { recursive: true, mode: 0o700 })
    mkdirSync(join(contactDir, 'conversation'), { recursive: true, mode: 0o700 })

    const today = new Date().toISOString().slice(0, 10)
    const card = `---
jid: ${jid}
push_name: ${pushName ?? '?'}
relationship_tag: new-stranger
language: ?
first_contact: ${today}
last_contact: ${today}
---

## Top facts (≤ 3 bullets, always loaded — keep tight)
- *(first interaction — fill in as you learn)*

## Open threads (things to follow up)
- *(none yet)*

## Last interaction summary
*(empty — auto-update after each turn)*

## Deep links (Read on demand)
- Background → facts.md
- Speaking style → voice.md
- Likes/avoids → preferences.md
- Full timeline → timeline.md
- Recent dialogue → conversation/${today.slice(0,7)}.md
`
    writeFileSync(cardPath, card, { mode: 0o600 })
    writeFileSync(join(contactDir, 'facts.md'), `# Facts — ${jid}\n\n*(fill in biographical, professional, family, location as you learn)*\n`, { mode: 0o600 })
    writeFileSync(join(contactDir, 'preferences.md'), `# Preferences — ${jid}\n\n## Likes\n\n## Avoid\n\n## Observed reactions\n`, { mode: 0o600 })
    writeFileSync(join(contactDir, 'voice.md'), `# Voice — ${jid}\n\n*(how they write: length, slang, emoji habits, formality)*\n`, { mode: 0o600 })
    writeFileSync(join(contactDir, 'timeline.md'), `# Timeline — ${jid}\n\n## ${today}\nFirst contact.\n`, { mode: 0o600 })
    writeFileSync(join(contactDir, 'notes.md'), `# Notes — ${jid}\n\n*(append-only stream of observations)*\n`, { mode: 0o600 })

    trace('contact_auto_created_v2', { jid, pushName, dir: contactDir })
  } catch (err) { trace('auto_onboard_contact_err', { jid, err: String(err) }) }
}

type Sessions = Record<string, string>  // jid → claude session UUID
function loadSessions(): Sessions {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Sessions } catch { return {} }
}
function saveSessions(s: Sessions): void {
  const tmp = SESSIONS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, SESSIONS_FILE)
}
function getOrCreateSession(jid: string): { uuid: string; isNew: boolean } {
  const s = loadSessions()
  if (s[jid]) return { uuid: s[jid], isNew: false }
  const uuid = randomUUID()
  s[jid] = uuid
  saveSessions(s)
  return { uuid, isNew: true }
}

// Strip characters that could break the <whatsapp> tag boundary so a sender
// cannot inject context that looks like further system instructions.
function sanitizeForTag(s: string | undefined): string {
  return (s ?? '').toString().replace(/[<>\r\n]/g, ' ').slice(0, 200)
}

const INBOX_DIR = join(STATE_DIR, 'inbox')
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// ─── media resolver via WhatsApp Desktop's local cache ───
// wacli sync holds an exclusive SQLite lock so any second `wacli media
// download` call fails. But WhatsApp Desktop (the macOS app) shares the
// same linked-device session and pre-downloads every media file we receive
// into its Group Container. Webhook payload has FileSHA256 + FileLength,
// which lets us locate the exact file there with zero ambiguity.
const WA_DESKTOP_MEDIA_DIR = join(
  homedir(),
  'Library', 'Group Containers',
  'group.net.whatsapp.WhatsApp.shared',
  'Message', 'Media',
)

function* walkFiles(dir: string): Generator<string> {
  let ents: any[]
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of ents) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walkFiles(p)
    else if (ent.isFile()) yield p
  }
}

// Find a local file matching the webhook's Media metadata. Polls briefly
// because WhatsApp Desktop may take a few seconds to finish downloading.
async function findMediaFile(fileLength: number, sha256Base64: string, maxWaitMs = 8_000): Promise<string | null> {
  if (!existsSync(WA_DESKTOP_MEDIA_DIR)) return null
  const deadline = Date.now() + maxWaitMs
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const sizeMatches: string[] = []
    for (const f of walkFiles(WA_DESKTOP_MEDIA_DIR)) {
      try {
        const st = statSync(f)
        if (st.size === fileLength) sizeMatches.push(f)
      } catch {}
    }
    if (sizeMatches.length === 1 && !sha256Base64) return sizeMatches[0]
    for (const f of sizeMatches) {
      try {
        const h = createHash('sha256').update(readFileSync(f)).digest('base64')
        if (h === sha256Base64) {
          trace('media_resolved', { path: f, attempt, sizeMatches: sizeMatches.length })
          return f
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 500))
  }
  trace('media_resolve_failed', { fileLength, sha256Base64: sha256Base64.slice(0, 16), maxWaitMs })
  return null
}

async function buildPrompt(evt: any): Promise<{ prompt: string; jid: string; message_id: string } | null> {
  if (!evt || typeof evt !== 'object') return null
  if (evt.FromMe === true || evt.Revoked === true) return null
  const jid: string | undefined = evt.Chat
  if (!jid) return null

  const text: string = (evt.Text ?? '').toString()
  // Real wacli webhook schema (discovered empirically — Media IS a nested object):
  //   Media: { Type: 'image'|'video'|'audio'|'ptt'|'document'|'sticker',
  //            Caption, Filename, MimeType,
  //            DirectPath, MediaKey, FileSHA256, FileEncSHA256, FileLength }
  //   No LocalPath in webhook — file lookup goes via WhatsApp Desktop cache.
  const media = evt.Media as {
    Type?: string; Caption?: string; Filename?: string; MimeType?: string;
    FileSHA256?: string; FileLength?: number;
  } | null
  const reaction = evt.ReactionEmoji as string | undefined
  const reactionTo = evt.ReactionToID as string | undefined
  const replyTo = evt.ReplyToID as string | undefined
  const msgId = String(evt.ID ?? '')

  let body: string
  const tagExtras: string[] = []

  if (reaction && reactionTo) {
    body = `(reacted ${reaction} to message ${reactionTo})`
  } else if (media && media.Type) {
    const mediaType = media.Type.toLowerCase()
    const mediaCaption = media.Caption ?? ''
    const mimeType = media.MimeType ?? ''
    const isImage = /^image$/.test(mediaType) || /jpeg|jpg|png|webp|gif/.test(mimeType)
    const isVoice = /^ptt$|^audio$/.test(mediaType) || /audio|opus|ogg|m4a|mp3/.test(mimeType)
    const isVideo = /^video$/.test(mediaType) || /mp4|mov|webm/.test(mimeType)
    const k = sanitizeForTag(mediaType || mimeType || 'media')
    const cap = mediaCaption ? `: ${sanitizeForTag(mediaCaption)}` : ''

    // Resolve via WhatsApp Desktop's local cache by FileLength + FileSHA256.
    const localPath = (media.FileLength && media.FileSHA256)
      ? await findMediaFile(media.FileLength, media.FileSHA256)
      : null

    if (!localPath) {
      body = `[${k}${cap}] (couldn't locate the local file — tell the user the media didn't make it through, ask them to resend)`
    } else if (isImage) {
      tagExtras.push(`image_path="${sanitizeForTag(localPath)}"`)
      body = `[image attached${cap}]`
    } else if (isVoice) {
      tagExtras.push(`voice_path="${sanitizeForTag(localPath)}"`)
      body = `[voice note attached at ${localPath}] (audio transcription not wired yet — acknowledge politely and ask the user to type if substantive)`
    } else if (isVideo) {
      tagExtras.push(`video_path="${sanitizeForTag(localPath)}"`)
      body = `[video attached${cap}] (you can't view video directly — acknowledge and ask user to describe)`
    } else {
      tagExtras.push(`attachment_path="${sanitizeForTag(localPath)}"`)
      body = `[${k} attached${cap} at ${localPath}]`
    }
  } else if (text) {
    body = text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) + ' …[truncated]' : text
  } else {
    return null
  }

  const tagAttrs = [
    `jid="${sanitizeForTag(jid)}"`,
    `message_id="${sanitizeForTag(msgId)}"`,
    `user="${sanitizeForTag(evt.PushName)}"`,
    `ts="${sanitizeForTag(evt.Timestamp)}"`,
    ...(replyTo ? [`reply_to_id="${sanitizeForTag(replyTo)}"`] : []),
    ...tagExtras,
  ].join(' ')

  const contactFile = join(CONTACTS_DIR, `${jid}.md`)
  const contactExists = existsSync(contactFile)

  const tag = `<whatsapp ${tagAttrs}>`
  const hints: string[] = []
  hints.push(`Contact file: ${contactFile} (${contactExists ? 'exists — Read it first to recall who this is' : 'does NOT exist yet — copy TEMPLATE.md to this path and fill in basic info from PushName + any context you learn'})`)
  if (tagExtras.some(t => t.startsWith('image_path='))) {
    hints.push('User sent an image — Read the image_path to view it.')
  }
  hints.push('Reply via the reply tool. If your reply is long, split into 2-4 calls (one per "natural message"). Use reply_to=<message_id> only when answering a specific NON-latest message from the user. Then update the contact file with anything new you learned.')

  const prompt = `${tag}\n${body}\n</whatsapp>\n\n${hints.join('\n\n')}`
  return { prompt, jid, message_id: msgId }
}

// ─────────── humanlike presence ───────────

// Keep typing indicator alive for the whole claude turn. WhatsApp expires it
// after ~10s so we re-fire every 7s until the heartbeat is cleared.
//
// IMPORTANT: presence is fired via the `presence` secondary account, not the
// main `sync` account. Reason: `wacli sync --follow` holds the main store's
// SQLite lock indefinitely, so any direct `wacli presence` on main fails
// with "store is locked". The secondary account has its own store and no
// sync running, so presence can briefly open a connection to send the typing
// indicator without lock conflict.
// With the patched wacli, `presence` runs against the MAIN account: it tries
// to take the local store lock first, fails (sync owns it), then falls back
// to the .send.sock IPC and the running sync executes the presence call. No
// secondary account needed.
function startTyping(jid: string, kind: 'text' | 'voice' = 'text'): NodeJS.Timer {
  // Tunable: respect enable_typing_indicator from TARGET project (the satellite
  // that owns this JID), not the hub.
  const targetDir = resolveTargetProject(jid).stateDir
  if (!tunables(targetDir).enable_typing_indicator) return setInterval(() => {}, 60_000)
  const args = ['--account', WACLI_ACCOUNT, 'presence', 'typing', '--to', jid]
  if (kind === 'voice') args.push('--media', 'audio')
  const fire = () => spawn(WACLI_BIN, args, { stdio: 'ignore' }).on('error', () => {})
  fire()
  return setInterval(fire, 7_000)
}
function stopTyping(jid: string): void {
  spawn(WACLI_BIN, ['--account', WACLI_ACCOUNT, 'presence', 'paused', '--to', jid], { stdio: 'ignore' }).on('error', () => {})
}

// Build MCP_JSON dynamically each turn so extra_mcps.json edits go live.
function buildMcpJson(): string {
  const base: Record<string, any> = {
    whatsapp: {
      command: 'bun',
      args: [SERVER_FILE],
    },
  }
  const extras = loadExtraMcps()
  // user-defined MCPs cannot override our whatsapp server
  const { whatsapp: _ignore, ...userExtras } = extras
  return JSON.stringify({ mcpServers: { ...base, ...userExtras } })
}

// Spawn `claude -p` to handle one inbound message. Fires WhatsApp typing
// indicator continuously while claude works, stops on exit.
function spawnClaude(jid: string, prompt: string, onExit?: () => void): void {
  const sess = getOrCreateSession(jid)
  const sessFlag = sess.isNew ? ['--session-id', sess.uuid] : ['--resume', sess.uuid]
  const args = [
    '-p',
    '--model', tunables().chat_model,
    '--mcp-config', MCP_JSON,
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--append-system-prompt', PERSONA_PROMPT,
    ...sessFlag,
    prompt,
  ]
  trace('claude_spawn', { jid, sessId: sess.uuid, sessNew: sess.isNew, model: CHAT_MODEL, promptLen: prompt.length })

  const heartbeat = startTyping(jid)

  const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdoutBuf = ''
  let stderrBuf = ''
  child.stdout.on('data', d => { stdoutBuf += d.toString() })
  child.stderr.on('data', d => { stderrBuf += d.toString() })
  child.on('exit', code => {
    clearInterval(heartbeat)
    stopTyping(jid)
    trace('claude_exit', { jid, code, durationMs: undefined, stdoutTail: stdoutBuf.slice(-200), stderrTail: stderrBuf.slice(-300) })
    onExit?.()
  })
  child.on('error', err => {
    clearInterval(heartbeat)
    stopTyping(jid)
    trace('claude_error', { jid, err: String(err) })
    onExit?.()
  })
}

// ─────────── humanlike batching state machine (per JID) ───────────
//
// IDLE ──msg──► COLLECTING (60s, resettable)
//                  │
//                  └── timer ──► PRE_REPLY (random 30-60s, abortable by new msg)
//                                    │
//                                    └── timer ──► CLAUDE_RUNNING
//                                                      │
//                                                      └── claude exit ──► IDLE
//                                                          (or COLLECTING if msgs buffered during run)
//
// Real humans don't insta-reply. Collecting + delayed reply mimics that.

type BatchState = 'IDLE' | 'COLLECTING' | 'PRE_REPLY' | 'CLAUDE_RUNNING'
type Pending = {
  state: BatchState
  batch: any[]   // raw webhook event objects awaiting processing
  timer: ReturnType<typeof setTimeout> | null
}
const pending = new Map<string, Pending>()

function getPending(jid: string): Pending {
  let p = pending.get(jid)
  if (!p) {
    p = { state: 'IDLE', batch: [], timer: null }
    pending.set(jid, p)
  }
  return p
}

function clearPendingTimer(p: Pending): void {
  if (p.timer) { clearTimeout(p.timer); p.timer = null }
}

function enqueueMessage(jid: string, evt: any): void {
  const p = getPending(jid)
  p.batch.push(evt)
  trace('batch_enqueue', { jid, batchSize: p.batch.length, prevState: p.state })

  if (p.state === 'CLAUDE_RUNNING') {
    writeStateSnapshot()
    return
  }

  if (p.state === 'PRE_REPLY') {
    clearPendingTimer(p)
    trace('pre_reply_aborted_by_new_msg', { jid })
  } else if (p.state === 'COLLECTING') {
    clearPendingTimer(p)
  }

  p.state = 'COLLECTING'
  const targetDir = resolveTargetProject(jid).stateDir
  p.timer = setTimeout(() => closeCollectWindow(jid), tunables(targetDir).collect_window_ms)
  writeStateSnapshot()
}

function closeCollectWindow(jid: string): void {
  const p = getPending(jid)
  p.timer = null
  if (p.batch.length === 0) { p.state = 'IDLE'; return }
  const t = tunables(resolveTargetProject(jid).stateDir)
  const preDelay = t.pre_reply_min_ms + Math.floor(Math.random() * Math.max(1, t.pre_reply_max_ms - t.pre_reply_min_ms))
  p.state = 'PRE_REPLY'
  trace('collect_closed_pre_reply', { jid, batchSize: p.batch.length, preDelayMs: preDelay })
  p.timer = setTimeout(() => triggerClaude(jid), preDelay)
}

async function triggerClaude(jid: string): Promise<void> {
  const p = getPending(jid)
  p.timer = null
  if (p.batch.length === 0) { p.state = 'IDLE'; return }

  // Owner-JID session sharing: if this JID's session UUID is currently held
  // by an external claude process (user's terminal) AND that claude is
  // ACTIVELY generating (jsonl modified recently), defer to avoid interleaved
  // appends. If terminal is idle, proceed in parallel.
  const ownerJid = loadProjectConfig().ownerJid
  if (ownerJid && jid === ownerJid) {
    const target = resolveTargetProject(jid)
    const sess = getOrCreateSessionFor(target.stateDir, jid)
    if (isSessionInUseByExternal(sess.uuid, target.cwd)) {
      trace('claude_deferred_session_in_use', { jid, uuid: sess.uuid, retry_in_s: 30, reason: 'terminal claude actively writing jsonl' })
      writeStateSnapshot()
      p.timer = setTimeout(() => triggerClaude(jid), 30_000)
      return
    }
  }

  p.state = 'CLAUDE_RUNNING'
  const batchSnapshot = p.batch.slice()
  p.batch = []  // new msgs from now on accumulate to the NEXT batch

  if (DRY_RUN) {
    trace('claude_trigger_DRY_RUN', { jid, batchSize: batchSnapshot.length, msg_ids: batchSnapshot.map((m: any) => m.ID) })
    setTimeout(() => onClaudeExit(jid), 1_000)
    return
  }

  // Resolve target project from the batch's first message tagged earlier.
  const target = (batchSnapshot[0] as any).__target ?? resolveTargetProject(jid)

  const prompt = await buildBatchPrompt(jid, batchSnapshot, target.stateDir)
  if (!prompt) {
    trace('batch_unmapped', { jid })
    onClaudeExit(jid)
    return
  }
  // Per-turn snapshot — write into TARGET project's turns/, not hub's.
  const targetTurnsDir = join(target.stateDir, 'turns')
  const turnId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${jid.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`
  const turnDir = join(targetTurnsDir, turnId)
  mkdirSync(turnDir, { recursive: true, mode: 0o700 })
  // Reload persona from TARGET project's agent/*.md (NOT hub's)
  const targetPersona = loadPersonaFor(target.stateDir)
  writeFileSync(join(turnDir, 'prompt.txt'), prompt)
  writeFileSync(join(turnDir, 'persona.txt'), targetPersona)
  writeFileSync(join(turnDir, 'batch.json'), JSON.stringify({ jid, project: target.cwd, batchSize: batchSnapshot.length, messages: batchSnapshot, model: tunables(target.stateDir).chat_model, started_at: new Date().toISOString() }, null, 2))

  trace('claude_trigger', { jid, project: target.cwd, batchSize: batchSnapshot.length, promptLen: prompt.length, turnId })
  const startMs = Date.now()
  spawnClaudeWithTurn(jid, prompt, turnId, startMs, target, targetPersona, targetTurnsDir, () => onClaudeExit(jid))
}

function spawnClaudeWithTurn(jid: string, prompt: string, turnId: string, startMs: number, target: { stateDir: string; cwd: string; account: string }, targetPersona: string, targetTurnsDir: string, onExit: () => void): void {
  // Session lookup against TARGET project's sessions.json (not hub's)
  const sess = getOrCreateSessionFor(target.stateDir, jid)
  const sessFlag = sess.isNew ? ['--session-id', sess.uuid] : ['--resume', sess.uuid]
  const t = tunables(target.stateDir)

  // Tool / dir allowlist flags
  const toolFlags: string[] = []
  if (t.allowed_tools.length > 0)    toolFlags.push('--allowedTools', t.allowed_tools.join(','))
  if (t.disallowed_tools.length > 0) toolFlags.push('--disallowedTools', t.disallowed_tools.join(','))
  for (const d of t.add_dirs) toolFlags.push('--add-dir', d)

  // System prompt: if override is set, REPLACE claude code's default (drop
  // --append-system-prompt) and inject persona inside the override so the
  // bot still has its identity. Otherwise append persona to the default.
  const systemPromptFlags = t.system_prompt_override
    ? ['--system-prompt', `${t.system_prompt_override}\n\n${targetPersona}`]
    : ['--append-system-prompt', targetPersona]

  // Permission mode: bypassPermissions is the default and equivalent to the
  // old hardcoded --dangerously-skip-permissions. Users can switch to e.g.
  // acceptEdits if they want stricter behavior (chatbot has no human to
  // approve risky stuff so anything stricter than bypassPermissions will
  // make some tool calls fail — surfaced as a warning in the UI).
  const permFlag = ['--permission-mode', t.permission_mode]

  // Optional flags — only added when non-default
  const optionalFlags: string[] = []
  if (t.effort) optionalFlags.push('--effort', t.effort)
  if (t.fallback_model) optionalFlags.push('--fallback-model', t.fallback_model)
  if (t.max_budget_usd_per_turn > 0) optionalFlags.push('--max-budget-usd', String(t.max_budget_usd_per_turn))
  for (const p of t.plugin_dirs) optionalFlags.push('--plugin-dir', p)
  for (const p of t.plugin_urls) optionalFlags.push('--plugin-url', p)
  if (t.setting_sources && t.setting_sources !== 'user,project,local') {
    optionalFlags.push('--setting-sources', t.setting_sources)
  }
  if (t.exclude_dynamic_system_prompt_sections) optionalFlags.push('--exclude-dynamic-system-prompt-sections')

  const args = [
    '-p',
    '--model', t.chat_model,
    '--mcp-config', buildMcpJsonFor(target.stateDir),
    '--strict-mcp-config',
    ...permFlag,
    ...systemPromptFlags,
    ...toolFlags,
    ...optionalFlags,
    ...sessFlag,
    prompt,
  ]
  trace('claude_spawn', { jid, project: target.cwd, sessId: sess.uuid, sessNew: sess.isNew, model: t.chat_model, promptLen: prompt.length, turnId, toolFlags, optionalFlags, permission_mode: t.permission_mode, sys_override: !!t.system_prompt_override })

  const heartbeat = startTyping(jid)
  // Spawn with TARGET project's cwd + per-spawn ALLOWED_JIDS for hard-isolation
  const child = spawn(CLAUDE_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: target.cwd,
    env: {
      ...process.env,
      CC_WHATSAPP_PROJECT_DIR: target.stateDir,
      CC_WHATSAPP_ALLOWED_JIDS: jid,   // hard isolation: claude can only reply to this JID
    },
  })
  if (child.pid) ourClaudePids.add(child.pid)
  let stdoutBuf = ''
  let stderrBuf = ''
  child.stdout.on('data', d => { stdoutBuf += d.toString() })
  child.stderr.on('data', d => { stderrBuf += d.toString() })
  child.on('exit', code => {
    if (child.pid) ourClaudePids.delete(child.pid)
    clearInterval(heartbeat)
    stopTyping(jid)
    const durationMs = Date.now() - startMs
    try {
      writeFileSync(join(targetTurnsDir, turnId, 'stdout.txt'), stdoutBuf)
      writeFileSync(join(targetTurnsDir, turnId, 'stderr.txt'), stderrBuf)
      writeFileSync(join(targetTurnsDir, turnId, 'exit.json'), JSON.stringify({
        jid, code, durationMs, ended_at: new Date().toISOString(),
      }, null, 2))
    } catch {}
    trace('claude_exit', { jid, code, durationMs, stdoutTail: stdoutBuf.slice(-200), stderrTail: stderrBuf.slice(-300), turnId })
    onExit()
  })
  child.on('error', err => {
    clearInterval(heartbeat)
    stopTyping(jid)
    try { writeFileSync(join(targetTurnsDir, turnId, 'error.txt'), String(err)) } catch {}
    trace('claude_error', { jid, err: String(err), turnId })
    onExit()
  })
}

// Per-target helpers (memory v2 + dispatcher made them necessary)
function loadPersonaFor(stateDir: string): string {
  const parts: string[] = []
  for (const name of ['IDENTITY', 'SOUL', 'STYLE', 'AGENTS', 'MEMORY']) {
    const path = join(stateDir, 'agent', `${name}.md`)
    try { parts.push(`════════════════════════════════════════\n${name}.md (${path})\n════════════════════════════════════════\n${readFileSync(path, 'utf8').trim()}`) } catch {}
  }
  return parts.join('\n\n')
}

function getOrCreateSessionFor(stateDir: string, jid: string): { uuid: string; isNew: boolean } {
  const sessFile = join(stateDir, 'sessions.json')
  let s: Sessions = {}
  try { s = JSON.parse(readFileSync(sessFile, 'utf8')) as Sessions } catch {}
  if (s[jid]) return { uuid: s[jid]!, isNew: false }
  const uuid = randomUUID()
  s[jid] = uuid
  const tmp = sessFile + '.tmp'
  mkdirSync(dirname(sessFile), { recursive: true, mode: 0o700 })
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, sessFile)
  return { uuid, isNew: true }
}

function buildMcpJsonFor(stateDir: string): string {
  const base: Record<string, any> = {
    whatsapp: { command: 'bun', args: [SERVER_FILE] },
  }
  let extras: Record<string, any> = {}
  try {
    const obj = JSON.parse(readFileSync(join(stateDir, 'extra_mcps.json'), 'utf8'))
    if (obj && obj.mcpServers && typeof obj.mcpServers === 'object') extras = obj.mcpServers
  } catch {}
  const { whatsapp: _ignore, ...userExtras } = extras
  return JSON.stringify({ mcpServers: { ...base, ...userExtras } })
}

// Lightweight live state snapshot for the dashboard. Written on every state
// transition; dashboard reads + polls.
function writeStateSnapshot(): void {
  const out: Record<string, { state: string; batch: number; since: string }> = {}
  const now = new Date().toISOString()
  for (const [jid, p] of pending.entries()) {
    if (p.state === 'IDLE' && p.batch.length === 0) continue
    out[jid] = { state: p.state, batch: p.batch.length, since: now }
  }
  try { writeFileSync(STATE_SNAP, JSON.stringify(out, null, 2)) } catch {}
}

function onClaudeExit(jid: string): void {
  const p = getPending(jid)
  if (p.batch.length === 0) {
    p.state = 'IDLE'
    trace('claude_done_idle', { jid })
    writeStateSnapshot()
    return
  }
  trace('claude_done_pending_batch', { jid, batchSize: p.batch.length })
  p.state = 'COLLECTING'
  const targetDir = resolveTargetProject(jid).stateDir
  p.timer = setTimeout(() => closeCollectWindow(jid), tunables(targetDir).collect_window_ms)
  writeStateSnapshot()
}

// Build a prompt that wraps every msg in the batch as a <whatsapp> tag, then
// appends one batch-level instruction block (contact memory + multi-msg
// guidance + quote-reply guidance).
async function buildBatchPrompt(jid: string, batch: any[], targetStateDir: string = STATE_DIR): Promise<string | null> {
  const fragments: string[] = []
  for (const evt of batch) {
    const mapped = await buildPrompt(evt)
    if (!mapped) continue
    const m = mapped.prompt.match(/<whatsapp [^>]*>[\s\S]*?<\/whatsapp>/)
    if (m) fragments.push(m[0])
  }
  if (fragments.length === 0) return null

  const mode = getProjectMode(targetStateDir)
  const trailer: string[] = []
  if (mode === 'terminal-extension') {
    // Lean trailer: this is the owner's remote terminal; CLAUDE.md + project files
    // already define behavior. Skip memory v2 / playbook hints entirely.
    trailer.push(`This message arrived via WhatsApp (terminal-extension mode for this project). Reply using the WhatsApp \`reply\` tool. The user is the project owner — treat this like a terminal request: short, direct, no bot-roleplay.`)
  } else {
    // Bot mode: full memory v2 + playbook protocol
    const contactDir = contactDirFor(targetStateDir, jid)
    const cardPath = contactCardPath(targetStateDir, jid)
    const cardExists = existsSync(cardPath)
    const legacyPath = legacyContactPath(targetStateDir, jid)
    const legacyExists = existsSync(legacyPath)
    if (cardExists) {
      trailer.push(`Contact card: ${cardPath} (Read this FIRST — small summary + relationship_tag).`)
      trailer.push(`Detail files (Read only if you need them this turn): ${join(contactDir, 'facts.md')}, ${join(contactDir, 'preferences.md')}, ${join(contactDir, 'voice.md')}, ${join(contactDir, 'timeline.md')}, ${join(contactDir, 'notes.md')}.`)
      trailer.push(`Playbook: after reading card, Read agent/playbooks/<relationship_tag>.md for tag-specific guidance.`)
      trailer.push(`After reply: Edit card.md if anything changed (last_contact, top_facts, open_threads, relationship_tag promotion). Append to notes.md for noteworthy observations.`)
    } else if (legacyExists) {
      trailer.push(`Contact file (legacy single-md format): ${legacyPath} — Read first.`)
    } else {
      trailer.push(`No contact memory yet for this JID — start a fresh one if the message is substantive.`)
    }
  }
  const t = tunables(targetStateDir)
  const quotePct = Math.round(t.quote_reply_probability * 100)
  const maxSeg = t.multi_msg_max_segments
  if (batch.length > 1) {
    trailer.push(`The user sent ${batch.length} messages in a short burst. Treat them as ONE combined turn from them. Reply ONCE — you may use multiple reply tool calls to split into ${maxSeg <= 2 ? '1-2' : `2-${maxSeg}`} natural messages, but it's one response to the whole burst.`)
    trailer.push(`Quote-reply guidance: about ${quotePct}% of the time, pick ONE message in the burst and quote-reply it by passing reply_to=<message_id> in ONE of your reply calls — pick a message that benefits from the disambiguation. Don't quote-reply just to be flashy.`)
  } else {
    trailer.push(`Reply via the reply tool. If your reply is long, split into up to ${maxSeg} calls for natural multi-segment delivery.`)
  }
  if (fragments.some(f => f.includes('image_path='))) {
    trailer.push(`One or more messages have image_path attached — Read each one to view the image, then reply.`)
  }

  return fragments.join('\n\n') + '\n\n' + trailer.join('\n\n')
}

// ─────────── webhook listener ───────────

const SECRET = getOrCreateSecret()
writeFileSync(ROUTER_PID, String(process.pid))

// @ts-expect-error Bun global at runtime
const server = (globalThis as any).Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch: async (req: Request) => {
    if (req.method !== 'POST') return new Response('POST only', { status: 405 })
    const url = new URL(req.url)
    if (url.pathname !== '/in') return new Response('not found', { status: 404 })

    const body = await req.text()
    const sigHeader = req.headers.get('x-wacli-signature') ?? ''
    const sig = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader
    const expected = createHmac('sha256', SECRET).update(body).digest('hex')
    let sigOk = false
    try {
      const a = Buffer.from(sig, 'hex'); const b = Buffer.from(expected, 'hex')
      sigOk = a.length === b.length && timingSafeEqual(a, b)
    } catch {}
    if (!sigOk) {
      trace('webhook_bad_signature', { sigHeader: sigHeader.slice(0, 24) })
      return new Response('bad signature', { status: 401 })
    }

    try {
      const evt = JSON.parse(body)
      // Temporary: dump full evt structure for any non-text message so we can
      // see real webhook schema for images/voice/etc.
      const isProbablyText = evt && typeof evt.Text === 'string' && evt.Text.length > 0 && !evt.Media && !evt.ReactionEmoji
      trace('webhook_received', { chat: evt.Chat, from_me: evt.FromMe, text_preview: (evt.Text ?? '').slice(0, 80), keys: Object.keys(evt ?? {}) })
      if (!isProbablyText) {
        trace('webhook_raw_body', body.slice(0, 2000))
      }

      // ── DISPATCHER: figure out target project for this JID ─────────
      const target = resolveTargetProject(evt.Chat)
      trace('resolve_target', { jid: evt.Chat, project: target.cwd, via: target.resolvedBy })
      const targetAccessFile = join(target.stateDir, 'access.json')
      let targetAccess: any = { allowFrom: [], mode: 'open' }
      try { targetAccess = JSON.parse(readFileSync(targetAccessFile, 'utf8')) } catch {}

      if (targetAccess.disabled) { trace('drop_disabled', { jid: evt.Chat, project: target.cwd }); return new Response('ok') }

      // OWNER-PERSONAL-CHAT detection — account-level. The bot's phone is
      // also the owner's personal phone. Friend chats must not enter the bot
      // pipeline. JIDs the owner ever sent to (from_me=true) are remembered
      // permanently and all subsequent traffic on those JIDs is silently
      // dropped regardless of routing target.
      const personal = loadOwnerPersonalChats()

      if (evt.FromMe === true && !personal.has(evt.Chat)) {
        markOwnerPersonal(evt.Chat)
        trace('owner_personal_chat_marked', { jid: evt.Chat })
      }
      if (evt.Revoked === true) {
        trace('drop_revoked', { jid: evt.Chat })
        return new Response('ok')
      }
      if (evt.FromMe === true) {
        trace('drop_from_me', { jid: evt.Chat })
        return new Response('ok')
      }
      if (personal.has(evt.Chat)) {
        trace('drop_owner_personal_chat', { jid: evt.Chat })
        return new Response('ok')
      }

      // If this JID was routed here by an EXPLICIT hub binding, the binding
      // IS the authorization — don't re-check satellite's access.json. This
      // fixes the case where a freshly-linked terminal-extension project has
      // mode=closed + empty allowFrom and would otherwise drop bound traffic.
      const hubBindings = loadProjectConfig().bindings ?? {}
      const isBoundDispatch = hubBindings[evt.Chat] !== undefined

      if (!isBoundDispatch) {
        // Normal access check (DM fallback / hub-as-default cases)
        if (!(targetAccess.allowFrom ?? []).includes(evt.Chat)) {
          if (targetAccess.mode === 'closed') {
            trace('drop_not_allowlisted', { jid: evt.Chat, project: target.cwd })
            return new Response('ok')
          }
          autoOnboardSender(target.stateDir, evt.Chat, evt.PushName)
          trace('auto_onboarded', { jid: evt.Chat, pushName: evt.PushName, project: target.cwd })
        }
      } else {
        // Bound dispatch — ensure satellite's allowFrom contains this JID
        // (so MCP-layer assertAllowed in legacy mode would also pass) +
        // create contact directory if bot-mode satellite.
        if (!(targetAccess.allowFrom ?? []).includes(evt.Chat)) {
          autoOnboardSender(target.stateDir, evt.Chat, evt.PushName)
          trace('bound_dispatch_onboard', { jid: evt.Chat, project: target.cwd })
        }
      }

      // Hand off to the batching state machine, tagged with target project.
      // Each JID's batch is processed against ONE target — bindings don't
      // change mid-conversation.
      ;(evt as any).__target = target
      enqueueMessage(evt.Chat, evt)
    } catch (err) {
      trace('webhook_handler_error', String(err))
    }
    return new Response('ok')
  },
})

// ─────────── wacli sync sidecar (self-healing) ───────────
//
// CRITICAL FIX: wacli `sync --follow` exits permanently after its own
// --max-reconnect window (default 5m) elapses on a sustained disconnect, e.g.
// WhatsApp replacing the linked-device socket, or a >5m network outage. The
// router process itself keeps running, the webhook listener stays up, but NO
// messages arrive — a silent outage that previously required a human to notice
// "the bot stopped replying" and manually restart. This caused 3 production
// outages. We now supervise the sidecar: respawn on unexpected exit with
// exponential backoff, and surface wacli liveness in health.json so the
// dashboard can show "router up but WhatsApp disconnected".

// Track wacli connection health. WhatsApp's MD protocol allows only ONE
// active websocket per linked-device — if WhatsApp Desktop / Web is running
// for the same account, both fight for the socket and we see a tight
// Disconnect/Reconnect loop. Detect that and surface to dashboard.
const disconnectTimes: number[] = []
let lastConnectedAt = ''
let wacliAlive = false
let lastWacliExitAt = ''
let lastWacliExitCode: number | null = null
function writeHealth(unstable: boolean): void {
  try {
    writeFileSync(HEALTH_SNAP, JSON.stringify({
      connection_unstable: unstable,
      disconnects_60s: disconnectTimes.length,
      last_connected_at: lastConnectedAt,
      last_disconnect_at: disconnectTimes.length ? new Date(disconnectTimes[disconnectTimes.length - 1]!).toISOString() : '',
      account: WACLI_ACCOUNT,
      // wacli liveness (added with the self-healing supervisor)
      wacli_alive: wacliAlive,
      last_wacli_exit_at: lastWacliExitAt,
      last_wacli_exit_code: lastWacliExitCode,
    }, null, 2))
  } catch {}
}

let syncProc: ReturnType<typeof spawn> | null = null
let shuttingDown = false
let syncRestartDelayMs = 2_000          // grows on repeated quick failures
const SYNC_RESTART_MAX_MS = 60_000      // cap backoff at 60s
let syncRestartTimer: ReturnType<typeof setTimeout> | null = null
let syncSpawnedAt = 0

function startSync(): void {
  if (shuttingDown) return
  syncSpawnedAt = Date.now()
  const proc = spawn(
    WACLI_BIN,
    [
      '--account', WACLI_ACCOUNT,  // project-specific wacli account
      'sync', '--follow',
      '--download-media',  // sync owns the store lock; auto-download media so we never need a second wacli process
      '--webhook', `http://127.0.0.1:${PORT}/in`,
      '--webhook-secret', SECRET,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  syncProc = proc
  wacliAlive = true
  try { writeFileSync(SYNC_PID, String(proc.pid)) } catch {}
  writeHealth(false)

  proc.stderr?.on('data', d => {
    const txt = d.toString()
    const now = Date.now()
    if (txt.includes('Disconnected')) {
      disconnectTimes.push(now)
      while (disconnectTimes.length && now - disconnectTimes[0]! > 60_000) disconnectTimes.shift()
      if (disconnectTimes.length > 10) writeHealth(true)
    } else if (txt.includes('Connected.')) {
      lastConnectedAt = new Date(now).toISOString()
      disconnectTimes.length = 0
      // Sidecar has been healthy for a real connection — reset the backoff so
      // a future failure starts from a short delay again.
      syncRestartDelayMs = 2_000
      writeHealth(false)
    }
    trace('wacli_stderr', txt.trim().slice(0, 300))
  })

  proc.on('exit', code => {
    wacliAlive = false
    lastWacliExitAt = new Date().toISOString()
    lastWacliExitCode = code
    trace('wacli_exit', { code })
    writeHealth(false)
    if (shuttingDown) return
    // If wacli ran healthily for a while before dying, restart promptly;
    // if it died almost immediately (e.g. store-locked, bad auth), back off
    // harder so we don't hot-loop.
    const ranMs = Date.now() - syncSpawnedAt
    if (ranMs > 30_000) syncRestartDelayMs = 2_000
    const delay = syncRestartDelayMs
    syncRestartDelayMs = Math.min(syncRestartDelayMs * 2, SYNC_RESTART_MAX_MS)
    trace('wacli_respawn_scheduled', { inMs: delay, lastCode: code, ranMs })
    if (syncRestartTimer) clearTimeout(syncRestartTimer)
    syncRestartTimer = setTimeout(() => { syncRestartTimer = null; startSync() }, delay)
  })

  proc.on('error', err => {
    trace('wacli_spawn_error', String(err))
  })
}

startSync()

// ─────────── lifecycle ───────────

function shutdown(reason: string): void {
  shuttingDown = true
  trace('shutdown', { reason })
  if (syncRestartTimer) { clearTimeout(syncRestartTimer); syncRestartTimer = null }
  try { syncProc?.kill('SIGTERM') } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', err => trace('unhandled_rejection', String(err)))
process.on('uncaughtException', err => trace('uncaught_exception', String(err)))

trace('router_ready', { port: PORT, pid: process.pid, state: STATE_DIR, account: WACLI_ACCOUNT, bin: CC_WHATSAPP_BIN })
process.stderr.write(`\n✓ cc-whatsapp router on http://127.0.0.1:${PORT} · pid ${process.pid}\n  project: ${STATE_DIR}\n  account: ${WACLI_ACCOUNT}\n  binary:  ${CC_WHATSAPP_BIN}\n  ctrl-c to stop\n\n`)
