#!/usr/bin/env bun
/**
 * cc-whatsapp dashboard — local web UI for managing all bots on this machine.
 *
 * Standalone Bun server. Discovers cc-whatsapp projects on disk, lets you
 * create / pair / read / edit / control them via browser. No SaaS, no auth —
 * strictly localhost.
 *
 * Run:   bun dashboard.ts
 * Open:  http://localhost:38500/
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  rmSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'
import QRCode from 'qrcode'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(PLUGIN_ROOT)
const WEB_ROOT = join(PLUGIN_ROOT, 'web')
const TEMPLATES_PERSONAS = join(PLUGIN_ROOT, 'templates', 'personas')
const TEMPLATES_AGENT = join(PLUGIN_ROOT, 'templates', 'agent')   // legacy default
const TEMPLATES_PLAYBOOKS = join(PLUGIN_ROOT, 'templates', 'playbooks')
const PORT = Number(process.env.CC_WHATSAPP_DASHBOARD_PORT ?? 38500)
const CC_WHATSAPP_BIN = join(REPO_ROOT, 'bin', 'cc-whatsapp')

// ─── Centralized state architecture ───────────────────────────────────────
// State now lives at ~/.cc-whatsapp/projects/<id>/, NOT inside the project.
// Each project's config.json carries `project_path` (the original cwd, used
// as claude's cwd when spawning so CLAUDE.md auto-loads from there).
// Discovery just scans the central projects dir — no filesystem-roots scan.

const CC_HOME = join(homedir(), '.cc-whatsapp')
const CC_PROJECTS_DIR = join(CC_HOME, 'projects')

function discoverProjects(): Project[] {
  if (!existsSync(CC_PROJECTS_DIR)) return []
  const out: Project[] = []
  let ids: string[]
  try { ids = readdirSync(CC_PROJECTS_DIR) } catch { return [] }
  for (const id of ids) {
    const stateDir = join(CC_PROJECTS_DIR, id)
    const cfgPath = join(stateDir, 'config.json')
    if (!existsSync(cfgPath)) continue
    const cfg = readJsonSafe(cfgPath)
    if (!cfg?.project_path) continue
    if (!existsSync(cfg.project_path)) {
      // Orphan: project dir was deleted/renamed. Skip (or surface later).
      continue
    }
    out.push(projectInfo(cfg.project_path, id))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

type Project = {
  id: string
  path: string
  name: string
  account: string
  phone?: string
  mode: 'bot' | 'terminal-extension'
  routerAlive: boolean
  routerPid?: number
  syncAlive: boolean
  syncPid?: number
  allowFrom: string[]
  disabled: boolean
  contactCount: number
  paired: boolean
  ownerJid?: string
  health?: {
    connection_unstable: boolean
    disconnects_60s: number
    last_disconnect_at?: string
    last_connected_at?: string
  }
}

function pathToId(absPath: string): string {
  return Buffer.from(absPath).toString('base64url')
}
function idToPath(id: string): string {
  return Buffer.from(id, 'base64url').toString('utf8')
}

function projectInfo(absPath: string, id?: string): Project {
  if (!id) id = pathToId(absPath)
  const stateDir = join(CC_PROJECTS_DIR, id)
  const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
  const access = readJsonSafe(join(stateDir, 'access.json')) ?? {}
  const routerPid = readPidSafe(join(stateDir, 'router.pid'))
  const syncPid = readPidSafe(join(stateDir, 'sync.pid'))
  let contactCount = 0
  try {
    const cdir = join(stateDir, 'agent', 'contacts')
    contactCount = readdirSync(cdir).filter(f => f.endsWith('.md') && f !== 'TEMPLATE.md').length
  } catch {}
  const account = cfg.account ?? 'main'
  const health = readJsonSafe(join(stateDir, 'health.json')) ?? undefined
  let mode: 'bot' | 'terminal-extension' = cfg.mode
  if (!mode) {
    mode = existsSync(join(stateDir, 'agent', 'IDENTITY.md')) ? 'bot' : 'terminal-extension'
  }
  return {
    id,
    path: absPath,
    name: absPath.split('/').filter(Boolean).pop() ?? absPath,
    account,
    phone: getAccountPhone(account),
    mode,
    routerAlive: isPidAlive(routerPid),
    routerPid,
    syncAlive: isPidAlive(syncPid),
    syncPid,
    allowFrom: access.allowFrom ?? [],
    disabled: !!access.disabled,
    contactCount,
    paired: isAccountPaired(account),
    ownerJid: cfg.ownerJid,
    health,
  }
}

// Phone-number cache. Resolves via `cc-whatsapp --account X auth status --json`
// which returns the linked phone. ~50ms shell per uncached lookup.
const phoneCache = new Map<string, string>()
function getAccountPhone(account: string): string | undefined {
  if (phoneCache.has(account)) return phoneCache.get(account)
  try {
    const r = Bun.spawnSync({
      cmd: [CC_WHATSAPP_BIN, '--account', account, 'auth', 'status', '--json'],
      stdout: 'pipe', stderr: 'pipe',
    })
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
    const phone = parsed?.data?.phone
    if (phone) { phoneCache.set(account, phone); return phone }
  } catch {}
  return undefined
}

// An account is "paired" if cc-whatsapp lists it AND its store .db is sizable.
// The default 'main' account stores at ~/.wacli/wacli.db; named accounts at
// ~/.wacli/accounts/<name>/wacli.db. We get the canonical store_dir from
// `cc-whatsapp accounts list --json`.
function isAccountPaired(account: string): boolean {
  try {
    const r = Bun.spawnSync({
      cmd: [CC_WHATSAPP_BIN, 'accounts', 'list', '--json'],
      stdout: 'pipe', stderr: 'pipe',
    })
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
    const accounts: any[] = parsed?.data?.accounts ?? []
    const match = accounts.find(a => a.name === account)
    if (!match) return false
    const storeDir = match.store_dir
    if (!storeDir) return false
    const dbPath = join(storeDir, 'wacli.db')
    return statSync(dbPath).size > 8000
  } catch { return false }
}

function readJsonSafe(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readPidSafe(path: string): number | undefined {
  try { const n = parseInt(readFileSync(path, 'utf8').trim(), 10); return Number.isFinite(n) ? n : undefined } catch { return undefined }
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// SECURITY: validate project id matches the base64url charset BEFORE we use it
// in any filesystem operation. Without this, an id of ".." or "../foo" would
// make getStateDir return a path that escapes CC_PROJECTS_DIR, and rmSync
// on that path would obliterate state for unrelated projects (or worse).
const VALID_ID_RE = /^[A-Za-z0-9_-]+$/
function getStateDir(id: string): string {
  if (!VALID_ID_RE.test(id)) {
    throw new Error(`invalid project id: ${id.slice(0, 50)} (must be base64url chars only)`)
  }
  return join(CC_PROJECTS_DIR, id)
}

function writeJsonAtomic(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

// ─── Tunables ──────────────────────────────────────────────────────────────

type Tunables = {
  collect_window_ms?: number
  pre_reply_min_ms?: number
  pre_reply_max_ms?: number
  inter_segment_min_ms?: number
  inter_segment_max_ms?: number
  quote_reply_probability?: number
  multi_msg_max_segments?: number
  enable_typing_indicator?: boolean
  chat_model?: string
  max_prompt_chars?: number
  length_factor_short?: number
  length_factor_medium?: number
  length_factor_long?: number
  allowed_tools?: string[]
  disallowed_tools?: string[]
  quiet_hours_start?: number
  quiet_hours_end?: number
}

const TUNABLES_DEFAULTS: Tunables = {
  collect_window_ms: 60_000,
  pre_reply_min_ms: 30_000,
  pre_reply_max_ms: 60_000,
  inter_segment_min_ms: 800,
  inter_segment_max_ms: 2200,
  quote_reply_probability: 0.4,
  multi_msg_max_segments: 4,
  enable_typing_indicator: true,
  chat_model: 'claude-haiku-4-5-20251001',
  max_prompt_chars: 8000,
  length_factor_short: 0.5,
  length_factor_medium: 1.0,
  length_factor_long: 1.6,
  allowed_tools: [],
  disallowed_tools: [],
}

function loadTunables(id: string): Tunables {
  const path = join(getStateDir(id), 'tunables.json')
  const stored = readJsonSafe(path) ?? {}
  return { ...TUNABLES_DEFAULTS, ...stored }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
function notFound(): Response { return new Response('not found', { status: 404 }) }

function readPersonaFiles(id: string): Record<string, string> {
  const agentDir = join(getStateDir(id), 'agent')
  const out: Record<string, string> = {}
  for (const name of ['IDENTITY.md', 'SOUL.md', 'STYLE.md', 'AGENTS.md', 'MEMORY.md']) {
    try { out[name] = readFileSync(join(agentDir, name), 'utf8') } catch { out[name] = '' }
  }
  return out
}

function listContacts(id: string): { jid: string; size: number; mtime: string }[] {
  const cdir = join(getStateDir(id), 'agent', 'contacts')
  if (!existsSync(cdir)) return []
  const out: { jid: string; size: number; mtime: string }[] = []
  for (const f of readdirSync(cdir)) {
    if (!f.endsWith('.md') || f === 'TEMPLATE.md') continue
    try {
      const st = statSync(join(cdir, f))
      out.push({ jid: f.replace(/\.md$/, ''), size: st.size, mtime: st.mtime.toISOString() })
    } catch {}
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

function listConversations(id: string): Array<{
  jid: string
  displayName: string
  lastText: string
  lastTimestamp: string
  lastFromMe: boolean
  initials: string
  contactFileExists: boolean
}> {
  const stateDir = getStateDir(id)
  const access = readJsonSafe(join(stateDir, 'access.json')) ?? { allowFrom: [] }
  const account = readJsonSafe(join(stateDir, 'config.json'))?.account ?? 'main'
  const seen = new Set<string>(access.allowFrom ?? [])

  try {
    for (const f of readdirSync(join(stateDir, 'agent', 'contacts'))) {
      if (f.endsWith('.md') && f !== 'TEMPLATE.md') seen.add(f.replace(/\.md$/, ''))
    }
  } catch {}

  const conversations: any[] = []
  for (const jid of seen) {
    let displayName = jid
    let lastText = ''
    let lastTimestamp = ''
    let lastFromMe = false
    try {
      const r = Bun.spawnSync({
        cmd: [CC_WHATSAPP_BIN, '--account', account, 'messages', 'list', '--chat', jid, '--limit', '1', '--json'],
        stdout: 'pipe', stderr: 'pipe',
      })
      const out = new TextDecoder().decode(r.stdout)
      const parsed = JSON.parse(out)
      const m = parsed?.data?.messages?.[0]
      if (m) {
        displayName = m.SenderName === 'me' ? (m.ChatName || jid) : (m.SenderName || m.ChatName || jid)
        lastText = m.Text || (m.MediaType ? `[${m.MediaType}]` : '')
        lastTimestamp = m.Timestamp ?? ''
        lastFromMe = !!m.FromMe
      }
    } catch {}

    if (displayName === jid) {
      try {
        const md = readFileSync(join(stateDir, 'agent', 'contacts', `${jid}.md`), 'utf8')
        const m = md.match(/PushName[:：]\s*(.+)/i) || md.match(/真名[^：:]*[:：]\s*(.+)/i)
        if (m && m[1] && !m[1].includes('*')) displayName = m[1].trim()
      } catch {}
    }

    const initials = displayName
      .split(/\s+/).slice(0, 2)
      .map(s => s.match(/[a-zA-Z]/) ? s[0]!.toUpperCase() : s[0])
      .filter(Boolean).join('') || '?'

    conversations.push({
      jid, displayName, lastText, lastTimestamp, lastFromMe, initials,
      contactFileExists: existsSync(join(stateDir, 'agent', 'contacts', `${jid}.md`)),
    })
  }
  return conversations.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''))
}

function fetchConversationMessages(id: string, jid: string, limit: number): {
  jid: string; messages: Array<{ id: string; text: string; mediaType: string; ts: string; fromMe: boolean; sender: string }>;
} {
  const account = readJsonSafe(join(getStateDir(id), 'config.json'))?.account ?? 'main'
  try {
    const r = Bun.spawnSync({
      cmd: [CC_WHATSAPP_BIN, '--account', account, 'messages', 'list', '--chat', jid, '--limit', String(limit), '--json', '--full'],
      stdout: 'pipe', stderr: 'pipe',
    })
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
    const msgs = (parsed?.data?.messages ?? []).map((m: any) => ({
      id: m.MsgID, text: m.Text || '', mediaType: m.MediaType || '',
      ts: m.Timestamp, fromMe: !!m.FromMe, sender: m.SenderName || '',
    })).reverse()
    return { jid, messages: msgs }
  } catch {
    return { jid, messages: [] }
  }
}

function listTurns(id: string, limit: number): Array<{
  turnId: string; startedAt: string; endedAt: string; durationMs?: number;
  jid: string; batchSize: number; code?: number; model: string;
}> {
  const tdir = join(getStateDir(id), 'turns')
  if (!existsSync(tdir)) return []
  let dirs: string[]
  try { dirs = readdirSync(tdir) } catch { return [] }
  dirs.sort().reverse()
  const out: any[] = []
  for (const d of dirs.slice(0, limit)) {
    const dir = join(tdir, d)
    const batch = readJsonSafe(join(dir, 'batch.json'))
    const exit = readJsonSafe(join(dir, 'exit.json'))
    if (!batch) continue
    out.push({
      turnId: d,
      startedAt: batch.started_at,
      endedAt: exit?.ended_at ?? null,
      durationMs: exit?.durationMs ?? null,
      jid: batch.jid,
      batchSize: batch.batchSize,
      code: exit?.code ?? null,
      model: batch.model,
    })
  }
  return out
}

function loadTurn(id: string, turnId: string): any {
  const dir = join(getStateDir(id), 'turns', turnId)
  if (!existsSync(dir)) return null
  const safeRead = (name: string): string => {
    try { return readFileSync(join(dir, name), 'utf8') } catch { return '' }
  }
  return {
    turnId,
    batch: readJsonSafe(join(dir, 'batch.json')),
    exit: readJsonSafe(join(dir, 'exit.json')),
    prompt: safeRead('prompt.txt'),
    persona: safeRead('persona.txt'),
    stdout: safeRead('stdout.txt'),
    stderr: safeRead('stderr.txt'),
    error: safeRead('error.txt'),
  }
}

function tailTrace(id: string, lines = 100): string[] {
  const path = join(getStateDir(id), 'trace.log')
  try {
    const text = readFileSync(path, 'utf8')
    const all = text.trimEnd().split('\n')
    return all.slice(-lines)
  } catch { return [] }
}

// ─── Playbooks (memory v2 — relationship-tag-driven interaction guides) ───
function installPlaybooks(agentDir: string): void {
  try {
    const dst = join(agentDir, 'playbooks')
    mkdirSync(dst, { recursive: true, mode: 0o700 })
    if (!existsSync(TEMPLATES_PLAYBOOKS)) return
    for (const f of readdirSync(TEMPLATES_PLAYBOOKS)) {
      if (!f.endsWith('.md')) continue
      const target = join(dst, f)
      if (existsSync(target)) continue   // don't overwrite user customizations
      copyFileSync(join(TEMPLATES_PLAYBOOKS, f), target)
    }
  } catch {}
}

function listPlaybooks(projectId: string): { name: string; content: string }[] {
  const dir = join(getStateDir(projectId), 'agent', 'playbooks')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f.replace(/\.md$/, ''), content: (() => { try { return readFileSync(join(dir, f), 'utf8') } catch { return '' } })() }))
}

// ─── Memory v2 (per-contact directory) ─────────────────────────────────────
const MEMORY_V2_SUBFILES = ['card', 'facts', 'preferences', 'voice', 'timeline', 'notes'] as const

function readContactV2(projectId: string, jid: string): Record<string, string> {
  const stateDir = getStateDir(projectId)
  const dir = join(stateDir, 'agent', 'contacts', jid)
  const out: Record<string, string> = {}
  let usedLegacy = false
  for (const sub of MEMORY_V2_SUBFILES) {
    try { out[sub] = readFileSync(join(dir, `${sub}.md`), 'utf8') }
    catch { out[sub] = '' }
  }
  // Legacy fallback: <jid>.md → goes into card field
  if (!out.card) {
    try { out.card = readFileSync(join(stateDir, 'agent', 'contacts', `${jid}.md`), 'utf8'); usedLegacy = true }
    catch {}
  }
  return { ...out, _legacy: usedLegacy ? '1' : '' }
}

function writeContactV2Subfile(projectId: string, jid: string, sub: string, content: string): { ok: boolean; err?: string } {
  if (!(MEMORY_V2_SUBFILES as readonly string[]).includes(sub)) {
    return { ok: false, err: `invalid subfile: ${sub} (must be one of ${MEMORY_V2_SUBFILES.join(',')})` }
  }
  const stateDir = getStateDir(projectId)
  const dir = join(stateDir, 'agent', 'contacts', jid)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileAtomic(join(dir, `${sub}.md`), content)
  return { ok: true }
}

// ─── Dispatcher / Accounts ────────────────────────────────────────────────
function readDispatcher(projectId: string): { defaultProject: string; bindings: Record<string, string> } {
  const cfg = readJsonSafe(join(getStateDir(projectId), 'config.json')) ?? {}
  return {
    defaultProject: cfg.defaultProject ?? '',
    bindings: cfg.bindings ?? {},
  }
}
function writeDispatcher(projectId: string, dispatcher: { defaultProject?: string; bindings?: Record<string, string> }): void {
  const cfgPath = join(getStateDir(projectId), 'config.json')
  const cfg = readJsonSafe(cfgPath) ?? {}
  if (dispatcher.defaultProject !== undefined) cfg.defaultProject = dispatcher.defaultProject || undefined
  if (dispatcher.bindings !== undefined) cfg.bindings = dispatcher.bindings
  writeJsonAtomic(cfgPath, cfg)
}

// Group all known projects by wacli account name
function listAccounts(): Array<{ name: string; phone?: string; paired: boolean; storeDir?: string; projects: Project[]; hubProjectId?: string; routerAlive: boolean }> {
  const projects = discoverProjects()
  const byAccount = new Map<string, Project[]>()
  for (const p of projects) {
    if (!byAccount.has(p.account)) byAccount.set(p.account, [])
    byAccount.get(p.account)!.push(p)
  }

  // Also discover wacli accounts that have no projects yet (paired but unbound)
  let wacliAccts: any[] = []
  try {
    const r = Bun.spawnSync({ cmd: [CC_WHATSAPP_BIN, 'accounts', 'list', '--json'], stdout: 'pipe', stderr: 'pipe' })
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
    wacliAccts = parsed?.data?.accounts ?? []
  } catch {}

  const all = new Set<string>()
  for (const a of wacliAccts) all.add(a.name)
  for (const k of byAccount.keys()) all.add(k)

  const out: any[] = []
  for (const acctName of all) {
    const projs = byAccount.get(acctName) ?? []
    const wcli = wacliAccts.find(a => a.name === acctName)
    // Phone: prefer authoritative `auth status` lookup, fallback to listed linked_jid
    const phone = isAccountPaired(acctName)
      ? (getAccountPhone(acctName) ?? wcli?.linked_jid ?? wcli?.phone ?? undefined)
      : undefined
    // Hub = the project that owns the dispatcher (first one with bindings, else first one with router alive, else first)
    const hub = projs.find(p => Object.keys(readDispatcher(p.id).bindings).length > 0)
              ?? projs.find(p => p.routerAlive)
              ?? projs[0]
    out.push({
      name: acctName,
      phone,
      paired: isAccountPaired(acctName),
      storeDir: wcli?.store_dir,
      projects: projs,
      hubProjectId: hub?.id,
      routerAlive: projs.some(p => p.routerAlive),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Pull JIDs we've seen in trace.log recently but aren't bound yet (helps user
// "detect-then-bind" without manually copying JIDs).
function recentUnboundJids(projectId: string, limit = 50): Array<{ jid: string; firstSeen: string; lastSeen: string; sampleText: string; isGroup: boolean }> {
  const trace = join(getStateDir(projectId), 'trace.log')
  if (!existsSync(trace)) return []
  let lines: string[]
  try {
    const content = readFileSync(trace, 'utf8')
    lines = content.trimEnd().split('\n').slice(-2000)
  } catch { return [] }
  const seen = new Map<string, { firstSeen: string; lastSeen: string; sampleText: string; isGroup: boolean }>()
  const dispatcher = readDispatcher(projectId)
  const bound = new Set(Object.keys(dispatcher.bindings))
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+webhook_received\s+(.+)$/)
    if (!m) continue
    try {
      const evt = JSON.parse(m[2]!)
      const jid = evt.chat
      if (!jid || bound.has(jid)) continue
      if (!seen.has(jid)) {
        seen.set(jid, { firstSeen: m[1]!, lastSeen: m[1]!, sampleText: evt.text_preview ?? '', isGroup: jid.endsWith('@g.us') })
      } else {
        seen.get(jid)!.lastSeen = m[1]!
        if (!seen.get(jid)!.sampleText && evt.text_preview) seen.get(jid)!.sampleText = evt.text_preview
      }
    } catch {}
  }
  return Array.from(seen.entries())
    .map(([jid, info]) => ({ jid, ...info }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit)
}

// ─── Persona templates ─────────────────────────────────────────────────────

const TEMPLATE_METADATA: Record<string, { label: string; description: string; icon: string }> = {
  eva:                { label: 'Eva (friendly assistant)',   icon: '🌸', description: 'Cute, casual AI friend — the original default. Good for personal projects.' },
  'customer-support': { label: 'Customer support agent',     icon: '🎧', description: 'Professional, calm, escalates billing/legal. End-of-turn [ESCALATE:] marker.' },
  'sales-lead':       { label: 'Sales lead qualifier',        icon: '🎯', description: 'Friendly SDR. Asks BANT naturally. Hands off to humans with [HANDOFF:] marker.' },
  companion:          { label: 'Personal companion',           icon: '💛', description: 'Warm, listens first, no life-coaching. Crisis [ALERT:] marker for serious flags.' },
}

function listTemplates(): Array<{ id: string; label: string; description: string; icon: string }> {
  try {
    const dirs = readdirSync(TEMPLATES_PERSONAS)
    return dirs.filter(d => statSync(join(TEMPLATES_PERSONAS, d)).isDirectory())
      .map(d => ({
        id: d,
        label: TEMPLATE_METADATA[d]?.label ?? d,
        description: TEMPLATE_METADATA[d]?.description ?? '',
        icon: TEMPLATE_METADATA[d]?.icon ?? '📄',
      }))
  } catch { return [] }
}

function readTemplateFiles(templateId: string): Record<string, string> | null {
  const dir = join(TEMPLATES_PERSONAS, templateId)
  if (!existsSync(dir)) return null
  const out: Record<string, string> = {}
  for (const name of ['IDENTITY.md', 'SOUL.md', 'STYLE.md', 'AGENTS.md', 'MEMORY.md']) {
    try { out[name] = readFileSync(join(dir, name), 'utf8') } catch { out[name] = '' }
  }
  return out
}

function applyPersonaTemplate(projectId: string, templateId: string): { ok: boolean; err?: string } {
  const tpl = readTemplateFiles(templateId)
  if (!tpl) return { ok: false, err: `unknown template "${templateId}"` }
  const agentDir = join(getStateDir(projectId), 'agent')
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(tpl)) {
    writeFileAtomic(join(agentDir, name), content)
  }
  return { ok: true }
}

// ─── New project creation ──────────────────────────────────────────────────

// Look up the most-recently-active claude code session UUID for a given cwd.
// Used when Owner JID is set: we pre-populate sessions.json[ownerJid] with this
// UUID so the WhatsApp chat from that JID shares state with the user's terminal.
function findLatestSessionUuid(projectPath: string): string | null {
  // claude code stores sessions at ~/.claude/projects/<hashed-cwd>/<uuid>.jsonl
  // The hashed cwd: every `/` AND every whitespace becomes `-`. Consecutive
  // get collapsed. So `/Users/.../Desktop/quant trade` → `-Users-...-Desktop-quant-trade`.
  const claudeHash = projectPath.replace(/[\/\s]+/g, '-')
  const dir = join(homedir(), '.claude', 'projects', claudeHash)
  if (!existsSync(dir)) return null
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    return files[0]!.replace(/\.jsonl$/, '')
  } catch { return null }
}

// Init a cc-whatsapp project in an EXISTING directory.
// Philosophy: this is "import an existing claude-code project", NOT "set up a
// bot persona". We do NOT write persona files, NOT write tunables (defaults
// at read time), NOT touch the project's existing files. Just drop the minimum
// IPC state under .claude/cc-whatsapp/ and let the user's CLAUDE.md /
// .claude/agents/ define the persona at claude --resume time.
function linkExistingProject(opts: { projectDir: string; account: string; ownerJid?: string }): { ok: boolean; id?: string; err?: string; warnings?: string[]; sessionUuid?: string } {
  const { projectDir, account } = opts
  if (!SAFE_NAME.test(account)) return { ok: false, err: 'account name must be a-z 0-9 _ - (max 40 chars)' }
  if (!existsSync(projectDir)) return { ok: false, err: `directory does not exist: ${projectDir}` }
  try {
    const st = statSync(projectDir)
    if (!st.isDirectory()) return { ok: false, err: `not a directory: ${projectDir}` }
  } catch (err) { return { ok: false, err: String(err) } }

  const id = pathToId(projectDir)
  const stateDir = join(CC_PROJECTS_DIR, id)
  if (existsSync(join(stateDir, 'config.json'))) {
    return { ok: false, err: `already a cc-whatsapp project: ${projectDir}` }
  }
  const warnings: string[] = []
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  // Owner-JID auto-binding to most-recent terminal session
  const sessions: Record<string, string> = {}
  let sessionUuid: string | undefined
  if (opts.ownerJid) {
    sessionUuid = findLatestSessionUuid(projectDir) ?? undefined
    if (sessionUuid) {
      sessions[opts.ownerJid] = sessionUuid
    } else {
      warnings.push('No claude session found yet for this cwd. Run "claude" once in the project to start one — then this WhatsApp chat will share its session.')
    }
  }

  writeJsonAtomic(join(stateDir, 'config.json'), {
    account,
    mode: 'terminal-extension',
    project_path: projectDir,
    ...(opts.ownerJid ? { ownerJid: opts.ownerJid } : {}),
  })
  // mode:'closed' = strict allowlist (owner-only is the point of terminal-extension).
  // Owner JID is auto-added below if provided.
  writeJsonAtomic(join(stateDir, 'access.json'), {
    allowFrom: opts.ownerJid ? [opts.ownerJid] : [],
    mode: 'closed',
  })
  writeJsonAtomic(join(stateDir, 'sessions.json'), sessions)

  // Terminal-extension defaults: all humanlike behaviors DISABLED.
  // User wants instant, direct, single-message replies — like a real terminal.
  // They can re-enable any of these from Tunables tab if needed.
  writeJsonAtomic(join(stateDir, 'tunables.json'), {
    collect_window_ms: 0,             // no batching — process each msg as it arrives
    pre_reply_min_ms: 0,
    pre_reply_max_ms: 1,              // no humanlike delay
    inter_segment_min_ms: 0,
    inter_segment_max_ms: 1,
    quote_reply_probability: 0,       // single-user, no need to disambiguate
    multi_msg_max_segments: 1,        // single block reply
    enable_typing_indicator: false,   // no fake typing
  })

  generateRunCommand(id)
  return { ok: true, id, warnings, sessionUuid }
}

const SAFE_NAME = /^[a-z0-9_-]{1,40}$/i

function createProject(opts: { parentDir: string; name: string; account: string; template?: string }): { ok: boolean; id?: string; err?: string } {
  const { parentDir, name, account } = opts
  if (!SAFE_NAME.test(name)) return { ok: false, err: 'project name must be a-z 0-9 _ - (max 40 chars)' }
  if (!SAFE_NAME.test(account)) return { ok: false, err: 'account name must be a-z 0-9 _ - (max 40 chars)' }
  let parent: string
  try {
    parent = parentDir.startsWith('~') ? join(homedir(), parentDir.slice(1).replace(/^\//, '')) : parentDir
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  } catch (err) {
    return { ok: false, err: `cannot create parent dir: ${err}` }
  }
  const projectPath = join(parent, name)
  if (existsSync(projectPath)) {
    const cfgPath = join(projectPath, '.claude', 'cc-whatsapp', 'config.json')
    if (existsSync(cfgPath)) return { ok: false, err: `${projectPath} already exists as a cc-whatsapp project` }
  }
  mkdirSync(projectPath, { recursive: true })
  const id = pathToId(projectPath)
  const stateDir = join(CC_PROJECTS_DIR, id)
  const agentDir = join(stateDir, 'agent')
  const contactsDir = join(agentDir, 'contacts')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  mkdirSync(contactsDir, { recursive: true, mode: 0o700 })

  // mode='bot' (default) — full chatbot with personas, playbooks, humanlike batching.
  // project_path is the original cwd — claude spawns there (CLAUDE.md auto-loads from it).
  writeJsonAtomic(join(stateDir, 'config.json'), { account, mode: 'bot', project_path: projectPath })
  // mode:'open' = anyone can message + bot auto-onboards them (default for bot mode).
  writeJsonAtomic(join(stateDir, 'access.json'), { allowFrom: [], mode: 'open' })
  writeJsonAtomic(join(stateDir, 'sessions.json'), {})
  writeJsonAtomic(join(stateDir, 'tunables.json'), {})

  const tplId = opts.template || 'eva'
  const tpl = readTemplateFiles(tplId) ?? readTemplateFiles('eva')
  if (tpl) {
    for (const [name, content] of Object.entries(tpl)) {
      writeFileAtomic(join(agentDir, name), content)
    }
  }

  // Install playbooks for memory-v2 relationship-tag-driven routing
  installPlaybooks(agentDir)

  // Copy contact TEMPLATE.md
  try {
    const src = join(TEMPLATES_AGENT, 'contacts', 'TEMPLATE.md')
    if (existsSync(src)) copyFileSync(src, join(contactsDir, 'TEMPLATE.md'))
  } catch {}

  // Generate run.command for one-click router start
  generateRunCommand(id)
  return { ok: true, id }
}

// ─── Router control ────────────────────────────────────────────────────────

function routerLaunchScript(id: string): string {
  return join(getStateDir(id), 'run.command')
}

// Each project's router listens on its own port (whatsmeow webhook). Picks
// 38600 first, then 38601, ... skipping ports already claimed by other
// projects on this machine. Cached in config.json so it stays stable across
// restarts.
function getOrAssignRouterPort(id: string): number {
  const stateDir = getStateDir(id)
  const cfgPath = join(stateDir, 'config.json')
  const cfg = readJsonSafe(cfgPath) ?? {}
  if (cfg.port && Number.isInteger(cfg.port)) return cfg.port

  const used = new Set<number>()
  for (const p of discoverProjects()) {
    if (p.id === id) continue
    const otherCfg = readJsonSafe(join(getStateDir(p.id), 'config.json'))
    if (otherCfg?.port) used.add(otherCfg.port)
  }
  let port = 38600
  while (used.has(port)) port++
  cfg.port = port
  writeJsonAtomic(cfgPath, cfg)
  return port
}

async function startRouter(id: string): Promise<{ ok: boolean; pid?: number; err?: string; trace_tail?: string }> {
  const path = idToPath(id)
  const stateDir = getStateDir(id)
  const cfg = readJsonSafe(join(stateDir, 'config.json'))
  if (!cfg?.account) return { ok: false, err: 'no config.account — initialize first' }
  if (!isAccountPaired(cfg.account)) return { ok: false, err: `account "${cfg.account}" not paired yet — run pair first` }

  // Check if account's wacli store is already locked by another router (port collision is
  // separate — store lock is the bigger issue when multiple projects share an account).
  // We CAN'T pre-check the lock cheaply, so we rely on post-spawn verification below.

  const runCmd = routerLaunchScript(id)
  generateRunCommand(id)

  // Capture stderr to a file so if router dies fast we can report WHY.
  const errLog = join(stateDir, '.start-stderr.log')
  try { writeFileSync(errLog, '') } catch {}

  // Spawn detached + capture stderr (via shell redirect, since detached suppresses our pipe)
  const child = spawn('bash', ['-c', `exec bash "${runCmd}" 2>"${errLog}"`], {
    cwd: stateDir,   // stateDir is ~/.cc-whatsapp/projects/<id>/, always accessible
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
    detached: true,
  })
  child.unref()
  const spawnedPid = child.pid

  // Wait up to 3s, then verify the router process is actually alive AND wrote to trace.log
  await new Promise(r => setTimeout(r, 3000))

  // The PID we got is the bash wrapper. Look up the actual router PID from
  // the project's router.pid file (router.ts writes its own PID on startup).
  const routerPidFile = join(stateDir, 'router.pid')
  let actualPid: number | undefined
  try { actualPid = parseInt(readFileSync(routerPidFile, 'utf8').trim(), 10) } catch {}

  const traceLog = join(stateDir, 'trace.log')
  const traceExists = existsSync(traceLog)
  let traceTail = ''
  if (traceExists) {
    try {
      const lines = readFileSync(traceLog, 'utf8').trimEnd().split('\n')
      traceTail = lines.slice(-5).join('\n')
    } catch {}
  }

  // Read whatever the launcher / router printed to stderr
  let errOutput = ''
  try { errOutput = readFileSync(errLog, 'utf8').slice(-1000) } catch {}

  if (actualPid && isPidAlive(actualPid)) {
    return { ok: true, pid: actualPid, trace_tail: traceTail }
  }

  // Router DIDN'T start successfully — explain why
  let err = 'router process exited shortly after spawn'
  if (errOutput.trim()) err = `router exited — stderr: ${errOutput.trim().slice(0, 400)}`
  if (errOutput.includes('Operation not permitted')) {
    err = `macOS Desktop/Documents folder access denied. Grant access to Bun (or run dashboard from a Terminal with the perm) — System Settings → Privacy & Security → Files and Folders. Then retry.`
  } else if (errOutput.includes('store is locked')) {
    err = `wacli store is locked (account "${cfg.account}" already in use by another project's router). Stop the other router first.`
  } else if (errOutput.includes('EADDRINUSE')) {
    err = `port already in use — check config.json port field, restart dashboard so it picks a new one.`
  }
  return { ok: false, pid: spawnedPid, err, trace_tail: traceTail }
}

function generateRunCommand(id: string): void {
  const projectPath = idToPath(id)
  const stateDir = getStateDir(id)
  const port = getOrAssignRouterPort(id)
  const title = `cc-whatsapp · ${projectPath.split('/').pop()}`
  // cwd of the launcher = stateDir (in ~/.cc-whatsapp/, no TCC issue).
  // Router internally spawns claude with cwd=projectPath; claude has its own
  // TCC permission for Desktop/Documents so it works regardless.
  const content = `#!/bin/zsh
# Generated by cc-whatsapp dashboard
STATE_DIR="${stateDir}"
REPO="${REPO_ROOT}"
TITLE="${title}"
cd "$STATE_DIR" || exit 1
pkill -9 -f "router.ts.*$STATE_DIR" 2>/dev/null
sleep 0.5
export CC_WHATSAPP_PROJECT_DIR="$STATE_DIR"
export CC_WHATSAPP_BIN="$REPO/bin/cc-whatsapp"
export CC_WHATSAPP_PORT=${port}
exec bun "$REPO/plugin/router.ts"
`
  writeFileAtomic(routerLaunchScript(id), content)
  try { require('fs').chmodSync(routerLaunchScript(id), 0o755) } catch {}
}

// ─── Interactive claude terminal launcher ─────────────────────────────────
// Opens Terminal.app with claude code pre-loaded in the project's dir.
// Two modes:
//   - project-level: fresh interactive session (no --resume)
//   - conversation-level: --resume <session-uuid> from sessions.json[jid]
// Each click writes a tiny .command file in /tmp; macOS Terminal opens it.

function cleanStaleLaunchers(): void {
  try {
    for (const f of readdirSync(tmpdir())) {
      if (!f.startsWith('cc-whatsapp-open-') || !f.endsWith('.command')) continue
      const p = join(tmpdir(), f)
      try {
        const st = statSync(p)
        if (Date.now() - st.mtimeMs > 3_600_000) unlinkSync(p)   // > 1 hour old
      } catch {}
    }
  } catch {}
}

function openClaudeTerminal(id: string, jid?: string): { ok: boolean; err?: string } {
  const projectPath = idToPath(id)
  if (!existsSync(projectPath)) return { ok: false, err: 'project not found' }
  const name = projectPath.split('/').pop()!

  let resumeArgs = ''
  let titleSuffix = 'interactive'
  if (jid) {
    const sessions = readJsonSafe(join(getStateDir(id), 'sessions.json')) ?? {}
    const uuid = sessions[jid]
    if (!uuid) return { ok: false, err: `no claude session for ${jid} yet — bot hasn't processed any message from them` }
    resumeArgs = ` --resume ${uuid}`
    titleSuffix = jid
  }

  const title = `cc-whatsapp · ${name} · ${titleSuffix}`
  const tmpPath = join(tmpdir(), `cc-whatsapp-open-${name}-${Date.now()}.command`)
  // .command files: macOS Terminal runs them on open. printf sets the window title via OSC 0.
  const script = `#!/bin/bash
printf '\\033]0;${title.replace(/'/g, "'\\''")}\\007'
cd ${JSON.stringify(projectPath)} || exit 1
exec claude --plugin-dir ${JSON.stringify(PLUGIN_ROOT)} --dangerously-skip-permissions${resumeArgs}
`
  try {
    writeFileSync(tmpPath, script)
    chmodSync(tmpPath, 0o755)
    spawn('open', ['-a', 'Terminal', tmpPath], { stdio: 'ignore', detached: true }).unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, err: String(err) }
  }
}

function stopRouter(id: string): { ok: boolean; err?: string } {
  const stateDir = getStateDir(id)
  const routerPid = readPidSafe(join(stateDir, 'router.pid'))
  const syncPid = readPidSafe(join(stateDir, 'sync.pid'))
  let killed = 0
  for (const pid of [routerPid, syncPid]) {
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); killed++ } catch {}
    }
  }
  if (killed === 0) return { ok: false, err: 'no live router/sync to stop' }
  return { ok: true }
}

// ─── Pairing flow (cc-whatsapp accounts add + SSE stream) ──────────────────
// We spawn the pair process per-account. Its stdout has the QR string;
// stderr has progress events when --events is set. We broadcast both as SSE.

type PairSession = {
  child: ChildProcess
  account: string
  projectId: string
  qrText: string                       // latest QR string (text format)
  qrDataUrl: string                    // latest QR rendered to data:image/png base64
  qrRotateCount: number                // how many fresh QRs we've broadcast
  status: 'qr' | 'paired' | 'error' | 'timeout' | 'starting'
  errorMsg?: string
  subscribers: Set<(evt: string) => void>
}
const pairSessions = new Map<string, PairSession>()   // key = projectId

// Does cc-whatsapp's config already know about this account name?
function accountExistsInConfig(account: string): boolean {
  try {
    const r = Bun.spawnSync({
      cmd: [CC_WHATSAPP_BIN, 'accounts', 'list', '--json'],
      stdout: 'pipe', stderr: 'pipe',
    })
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
    const accounts: any[] = parsed?.data?.accounts ?? []
    return accounts.some(a => a.name === account)
  } catch { return false }
}

function startPair(projectId: string): { ok: boolean; err?: string } {
  if (pairSessions.has(projectId)) {
    return { ok: false, err: 'pair already running for this project (stop it first)' }
  }
  const stateDir = getStateDir(projectId)
  const account = readJsonSafe(join(stateDir, 'config.json'))?.account
  if (!account) return { ok: false, err: 'no config.account' }

  // Route to the right command:
  //   - account in config + already paired → no-op (re-pair only if user explicitly logged out)
  //   - account in config, store empty (or expired)  → `auth` (just runs QR flow)
  //   - account NOT in config                        → `accounts add` (registers + auths)
  const exists = accountExistsInConfig(account)
  const args = exists
    ? ['--account', account, 'auth', '--qr-format', 'text', '--events']
    : ['--account', account, 'accounts', 'add', account, '--qr-format', 'text', '--events']
  process.stderr.write(`[dashboard] spawning pair (${exists ? 'auth' : 'accounts add'}): ${CC_WHATSAPP_BIN} ${args.join(' ')}\n`)

  let child: ChildProcess
  try {
    child = spawn(CC_WHATSAPP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { ok: false, err: `spawn failed: ${err}` }
  }

  const sess: PairSession = {
    child, account, projectId,
    qrText: '', qrDataUrl: '', qrRotateCount: 0,
    status: 'starting',
    subscribers: new Set(),
  }
  pairSessions.set(projectId, sess)

  const broadcast = (evt: string, data: string): void => {
    const msg = `event: ${evt}\ndata: ${data}\n\n`
    for (const sub of sess.subscribers) {
      try { sub(msg) } catch {}
    }
  }

  // Server-side render QR text → PNG dataURL. Run async; broadcast when ready.
  const renderAndBroadcastQr = async (qrText: string): Promise<void> => {
    try {
      const dataUrl = await QRCode.toDataURL(qrText, { margin: 2, width: 280, errorCorrectionLevel: 'M' })
      sess.qrDataUrl = dataUrl
      sess.qrRotateCount++
      broadcast('qr_image', dataUrl)
      broadcast('qr_rotate', String(sess.qrRotateCount))
      process.stderr.write(`[pair:${sess.account}] qr rendered (rotate #${sess.qrRotateCount}, len=${dataUrl.length})\n`)
    } catch (err) {
      process.stderr.write(`[pair:${sess.account}] QR render failed: ${err}\n`)
      broadcast('status', `error:QR render failed: ${err}`)
    }
  }

  let stdoutBuf = ''
  let stderrBuf = ''

  child.stdout?.on('data', d => {
    const text = d.toString()
    stdoutBuf += text
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      if (line.startsWith('2@') && line.length > 50) {
        if (line === sess.qrText) continue   // de-dup if stderr already broadcast it
        sess.qrText = line
        sess.status = 'qr'
        broadcast('qr', line)
        renderAndBroadcastQr(line)
      }
    }
  })

  child.stderr?.on('data', d => {
    const text = d.toString()
    stderrBuf += text
    // Stderr carries NDJSON lifecycle events with --events.
    // Real format (verified empirically):
    //   {"event":"qr_code","data":{"code":"2@..."},"ts":...}
    //   {"event":"warning","data":{"code":"sync_storage_uncapped","message":"..."}}
    //   {"event":"error","data":{"message":"..."},"ts":...}
    //   {"event":"login_success",...}  // assumed
    //   {"event":"auth_starting",...}
    let nl: number
    while ((nl = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, nl).trim()
      stderrBuf = stderrBuf.slice(nl + 1)
      if (!line) continue
      try {
        const evt = JSON.parse(line)
        if (!evt || typeof evt !== 'object') continue
        const name: string = evt.event ?? ''
        const code: string | undefined = evt.data?.code
        const msg: string | undefined = evt.data?.message
        process.stderr.write(`[pair:${sess.account}] ${name} ${code ? '(code: ' + String(code).slice(0,40) + '...)' : ''} ${msg ?? ''}\n`)
        if (name === 'qr_code' && typeof code === 'string' && code.length > 10) {
          if (code !== sess.qrText) {
            sess.qrText = code
            sess.status = 'qr'
            broadcast('qr', code)
            renderAndBroadcastQr(code)
          }
        } else if (name === 'connected' || name === 'login_success' || name === 'paired' || name === 'logged_in' || name === 'auth_complete' || name === 'authenticated' || name === 'pair_success') {
          // 'connected' fires FIRST when WhatsApp accepts the QR scan, before
          // history_sync starts. That's the moment to tell the user "linked!"
          // — waiting for the whole process to exit can take 30s+ on big accounts.
          if (sess.status !== 'paired') {
            sess.status = 'paired'
            broadcast('status', 'paired')
            // Auto-start router so the bot is alive without an extra user click.
            // Kick off async; toast appears in browser via subsequent /projects refresh.
            setTimeout(() => {
              try {
                const r = startRouter(projectId)
                process.stderr.write(`[pair:${sess.account}] auto-start router → ${JSON.stringify(r)}\n`)
              } catch (err) {
                process.stderr.write(`[pair:${sess.account}] auto-start router failed: ${err}\n`)
              }
            }, 1500)   // give wacli a beat to release its lock from auth process
          }
        } else if (name === 'error' || name === 'pair_error' || name === 'auth_failed') {
          sess.status = 'error'
          sess.errorMsg = msg ?? code ?? 'unknown'
          broadcast('status', `error:${sess.errorMsg}`)
        } else if (name === 'timeout' || name === 'auth_timeout') {
          sess.status = 'timeout'
          broadcast('status', 'timeout')
        }
      } catch {
        broadcast('log', line.slice(0, 300))
      }
    }
  })

  child.on('exit', code => {
    if (sess.status !== 'paired' && sess.status !== 'error') {
      if (code === 0) {
        sess.status = 'paired'
        broadcast('status', 'paired')
      } else {
        sess.status = 'error'
        sess.errorMsg = `process exited with code ${code}`
        broadcast('status', `error:exited code ${code}`)
      }
    }
    broadcast('close', String(code))
    // Keep the session around briefly so late SSE reconnects can replay
    // the final state instead of seeing 404 (which makes EventSource
    // auto-reconnect in a tight loop). 30s is plenty for the browser to
    // notice paired and close the connection cleanly.
    setTimeout(() => { pairSessions.delete(projectId) }, 30_000)
  })
  child.on('error', err => {
    sess.status = 'error'
    sess.errorMsg = String(err)
    broadcast('status', `error:${err}`)
  })

  return { ok: true }
}

function stopPair(projectId: string): { ok: boolean } {
  const sess = pairSessions.get(projectId)
  if (!sess) return { ok: false }
  try { sess.child.kill('SIGTERM') } catch {}
  pairSessions.delete(projectId)
  return { ok: true }
}

// ─── MCP & Tools (per-project) ─────────────────────────────────────────────

function readExtraMcps(id: string): { mcpServers: Record<string, any> } {
  const f = join(getStateDir(id), 'extra_mcps.json')
  try {
    const o = JSON.parse(readFileSync(f, 'utf8'))
    if (o && o.mcpServers && typeof o.mcpServers === 'object') return o
  } catch {}
  return { mcpServers: {} }
}

function writeExtraMcps(id: string, data: { mcpServers: Record<string, any> }): void {
  const path = join(getStateDir(id), 'extra_mcps.json')
  writeJsonAtomic(path, data)
}

// ─── Trace WS ──────────────────────────────────────────────────────────────

const wsClients = new Map<string, Set<any>>()

function broadcastTraceLine(id: string, line: string): void {
  const set = wsClients.get(id)
  if (!set) return
  for (const ws of set) {
    try { ws.send(line) } catch {}
  }
}

const traceWatchers = new Map<string, { mtime: number; size: number }>()
function startTraceWatchers(): void {
  setInterval(() => {
    for (const p of discoverProjects()) {
      const traceLog = join(getStateDir(p.id), 'trace.log')
      if (!existsSync(traceLog)) continue
      const st = statSync(traceLog)
      const prev = traceWatchers.get(p.id)
      if (!prev) {
        traceWatchers.set(p.id, { mtime: st.mtimeMs, size: st.size })
        continue
      }
      if (st.size > prev.size) {
        try {
          const fd = require('fs').openSync(traceLog, 'r')
          const buf = Buffer.alloc(st.size - prev.size)
          require('fs').readSync(fd, buf, 0, buf.length, prev.size)
          require('fs').closeSync(fd)
          const newText = buf.toString('utf8')
          for (const line of newText.split('\n')) {
            if (line.trim()) broadcastTraceLine(p.id, line)
          }
        } catch {}
      }
      traceWatchers.set(p.id, { mtime: st.mtimeMs, size: st.size })
    }
  }, 500)
}

// ─── Server ────────────────────────────────────────────────────────────────

// @ts-expect-error Bun global
const server = (globalThis as any).Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 255,    // SSE pairing streams sit idle between QR rotates (~20s) — default 10s breaks them
  websocket: {
    message() {},
    open(ws: any) {
      const id = ws.data?.projectId
      if (!id) return
      if (!wsClients.has(id)) wsClients.set(id, new Set())
      wsClients.get(id)!.add(ws)
      for (const line of tailTrace(id, 50)) {
        try { ws.send(line) } catch {}
      }
    },
    close(ws: any) {
      const id = ws.data?.projectId
      if (!id) return
      wsClients.get(id)?.delete(ws)
    },
  },
  async fetch(req: Request, srv: any) {
    const url = new URL(req.url)
    const p = url.pathname

    // WS upgrade for trace
    if (p.startsWith('/ws/projects/') && p.endsWith('/trace')) {
      const id = p.split('/')[3]
      if (!id || !existsSync(idToPath(id))) return notFound()
      const upgraded = srv.upgrade(req, { data: { projectId: id } })
      if (upgraded) return undefined as any
      return new Response('upgrade failed', { status: 400 })
    }

    // ─── REST API ───
    if (p === '/api/projects' && req.method === 'GET') {
      return json(discoverProjects())
    }
    if (p === '/api/accounts' && req.method === 'GET') {
      return json(listAccounts())
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const body = await req.json() as any
      const result = createProject({
        parentDir: body.parentDir ?? join(homedir(), 'Projects'),
        name: body.name ?? '',
        account: body.account ?? body.name ?? '',
        template: body.template ?? 'eva',
      })
      return json(result, result.ok ? 200 : 400)
    }
    // Link an EXISTING directory (no persona, no overwrite — just QR-scan attach)
    if (p === '/api/projects/link-existing' && req.method === 'POST') {
      const body = await req.json() as any
      const result = linkExistingProject({
        projectDir: body.projectDir,
        account: body.account,
        ownerJid: body.ownerJid,
      })
      return json(result, result.ok ? 200 : 400)
    }

    if (p === '/api/templates' && req.method === 'GET') {
      return json(listTemplates())
    }
    const templateRead = p.match(/^\/api\/templates\/([^/]+)$/)
    if (templateRead && req.method === 'GET') {
      const t = readTemplateFiles(templateRead[1])
      if (!t) return notFound()
      return json(t)
    }

    // Default scan locations + suggested name (for wizard)
    if (p === '/api/host-info' && req.method === 'GET') {
      return json({
        home: homedir(),
        defaultParent: join(homedir(), 'Projects'),
        existingProjectNames: discoverProjects().map(p => p.name),
      })
    }

    // Native macOS folder picker (osascript). Returns selected path or null.
    if (p === '/api/pick-folder' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as { defaultPath?: string }
      const defaultPath = body.defaultPath || homedir()
      const script = `tell application "System Events"
  activate
  set f to choose folder with prompt "Pick a project directory" default location POSIX file "${defaultPath.replace(/"/g, '\\"')}"
end tell
return POSIX path of f`
      try {
        const r = Bun.spawnSync({ cmd: ['osascript', '-e', script], stdout: 'pipe', stderr: 'pipe' })
        const stdout = new TextDecoder().decode(r.stdout).trim()
        const stderr = new TextDecoder().decode(r.stderr).trim()
        if (r.exitCode !== 0) {
          // User cancel: osascript returns non-zero + 'User canceled' in stderr
          if (stderr.includes('canceled') || stderr.includes('cancelled')) {
            return json({ ok: false, cancelled: true })
          }
          return json({ ok: false, err: stderr || 'osascript failed' })
        }
        // Strip trailing slash POSIX path puts there
        const folder = stdout.replace(/\/$/, '')
        return json({ ok: true, folder })
      } catch (err) {
        return json({ ok: false, err: String(err) })
      }
    }

    // List existing wacli accounts (for dropdown in link/create forms)
    if (p === '/api/wacli-accounts' && req.method === 'GET') {
      try {
        const r = Bun.spawnSync({ cmd: [CC_WHATSAPP_BIN, 'accounts', 'list', '--json'], stdout: 'pipe', stderr: 'pipe' })
        const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
        const accounts = parsed?.data?.accounts ?? []
        return json(accounts.map((a: any) => ({
          name: a.name,
          phone: a.linked_jid || a.phone || null,
          isDefault: !!a.default,
          paired: isAccountPaired(a.name),
        })))
      } catch {
        return json([])
      }
    }

    const projectMatch = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/)
    if (projectMatch) {
      const id = projectMatch[1]
      const sub = projectMatch[2] ?? ''
      if (!existsSync(idToPath(id))) return notFound()
      const stateDir = getStateDir(id)

      if (sub === '' && req.method === 'GET') {
        return json(projectInfo(idToPath(id)))
      }

      // PAIR FLOW
      if (sub === '/pair/start' && req.method === 'POST') {
        return json(startPair(id))
      }
      if (sub === '/pair/stop' && req.method === 'POST') {
        return json(stopPair(id))
      }
      if (sub === '/pair/stream' && req.method === 'GET') {
        const sess = pairSessions.get(id)
        // 410 Gone (not 404) signals to EventSource: don't auto-reconnect.
        // The browser also calls es.close() on paired — this is belt-and-suspenders
        // for clients that miss the explicit close.
        if (!sess) return new Response('pair session not active (already done or never started)', {
          status: 410,
          headers: { 'Content-Type': 'text/plain' },
        })

        let queue: string[] = []
        let pushFn: ((s: string) => void) | null = null
        const subscriber = (s: string) => {
          if (pushFn) pushFn(s); else queue.push(s)
        }
        sess.subscribers.add(subscriber)

        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            pushFn = (s: string) => {
              try { controller.enqueue(enc.encode(s)) } catch {}
            }
            controller.enqueue(enc.encode(`event: status\ndata: ${sess.status}\n\n`))
            if (sess.qrText) controller.enqueue(enc.encode(`event: qr\ndata: ${sess.qrText}\n\n`))
            if (sess.qrDataUrl) controller.enqueue(enc.encode(`event: qr_image\ndata: ${sess.qrDataUrl}\n\n`))
            if (sess.qrRotateCount > 0) controller.enqueue(enc.encode(`event: qr_rotate\ndata: ${sess.qrRotateCount}\n\n`))
            for (const m of queue) controller.enqueue(enc.encode(m))
            queue = []
            // heartbeat every 7s — must be < Bun's idleTimeout (per-request) AND
            // < any reverse-proxy timeout. Also keeps the EventSource browser-side from reconnecting.
            const hb = setInterval(() => {
              try { controller.enqueue(enc.encode(`: heartbeat\n\n`)) } catch { clearInterval(hb) }
            }, 7_000)
            ;(this as any)._hb = hb
          },
          cancel() {
            sess.subscribers.delete(subscriber)
            const hb = (this as any)._hb
            if (hb) clearInterval(hb)
          },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // PERSONA
      if (sub === '/persona' && req.method === 'GET') {
        return json(readPersonaFiles(id))
      }
      const personaWrite = sub.match(/^\/persona\/(IDENTITY|SOUL|STYLE|AGENTS|MEMORY)\.md$/)
      if (personaWrite && req.method === 'PUT') {
        const body = await req.text()
        writeFileAtomic(join(stateDir, 'agent', `${personaWrite[1]}.md`), body)
        return json({ ok: true })
      }
      if (sub === '/persona/apply-template' && req.method === 'POST') {
        const body = await req.json() as { template: string }
        return json(applyPersonaTemplate(id, body.template))
      }

      // TUNABLES
      if (sub === '/tunables' && req.method === 'GET') {
        return json(loadTunables(id))
      }
      if (sub === '/tunables' && req.method === 'PUT') {
        const body = await req.json() as Tunables
        const cleaned: Tunables = {}
        for (const k of Object.keys(TUNABLES_DEFAULTS) as (keyof Tunables)[]) {
          if (body[k] !== undefined) (cleaned as any)[k] = body[k]
        }
        writeJsonAtomic(join(stateDir, 'tunables.json'), cleaned)
        return json({ ok: true, tunables: { ...TUNABLES_DEFAULTS, ...cleaned } })
      }

      // ACCESS
      if (sub === '/access' && req.method === 'GET') {
        const raw = readJsonSafe(join(stateDir, 'access.json')) ?? { allowFrom: [] }
        return json({
          allowFrom: raw.allowFrom ?? [],
          disabled: !!raw.disabled,
          mode: (raw.mode === 'closed' ? 'closed' : 'open'),   // default open
        })
      }
      if (sub === '/access' && req.method === 'PUT') {
        const body = await req.json() as { allowFrom?: string[]; disabled?: boolean; mode?: string }
        const next = {
          allowFrom: Array.from(new Set(body.allowFrom ?? [])).filter(Boolean),
          disabled: !!body.disabled,
          mode: (body.mode === 'closed' ? 'closed' : 'open'),
        }
        writeJsonAtomic(join(stateDir, 'access.json'), next)
        return json({ ok: true, access: next })
      }

      // CONTACTS
      if (sub === '/contacts' && req.method === 'GET') {
        return json(listContacts(id))
      }
      const contactRead = sub.match(/^\/contacts\/([^/]+)$/)
      if (contactRead && req.method === 'GET') {
        const jid = decodeURIComponent(contactRead[1])
        try { return json({ jid, content: readFileSync(join(stateDir, 'agent', 'contacts', `${jid}.md`), 'utf8') }) }
        catch {
          // Return empty so user can start writing
          return json({ jid, content: '' })
        }
      }
      if (contactRead && req.method === 'PUT') {
        const jid = decodeURIComponent(contactRead[1])
        const body = await req.text()
        writeFileAtomic(join(stateDir, 'agent', 'contacts', `${jid}.md`), body)
        return json({ ok: true })
      }

      // CONVERSATIONS
      if (sub === '/conversations' && req.method === 'GET') {
        return json(listConversations(id))
      }
      const convoMsgs = sub.match(/^\/conversations\/([^/]+)\/messages$/)
      if (convoMsgs && req.method === 'GET') {
        const jid = decodeURIComponent(convoMsgs[1])
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return json(fetchConversationMessages(id, jid, limit))
      }

      // STATE
      if (sub === '/state' && req.method === 'GET') {
        try { return json(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))) }
        catch { return json({}) }
      }

      // TURNS
      if (sub === '/turns' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 30)
        return json(listTurns(id, limit))
      }
      const turnDetail = sub.match(/^\/turns\/([^/]+)$/)
      if (turnDetail && req.method === 'GET') {
        return json(loadTurn(id, turnDetail[1]))
      }

      // TRACE
      if (sub === '/trace' && req.method === 'GET') {
        const lines = Number(url.searchParams.get('lines') ?? 200)
        return json({ lines: tailTrace(id, lines) })
      }

      // ROUTER CONTROL
      if (sub === '/router/start' && req.method === 'POST') {
        return json(await startRouter(id))
      }
      if (sub === '/router/stop' && req.method === 'POST') {
        return json(stopRouter(id))
      }

      // MODE toggle (bot ↔ terminal-extension)
      if (sub === '/mode' && req.method === 'PUT') {
        const body = await req.json() as { mode: 'bot' | 'terminal-extension' }
        if (body.mode !== 'bot' && body.mode !== 'terminal-extension') {
          return json({ ok: false, err: 'mode must be bot or terminal-extension' }, 400)
        }
        const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
        cfg.mode = body.mode
        writeJsonAtomic(join(stateDir, 'config.json'), cfg)
        return json({ ok: true, mode: cfg.mode })
      }

      // OPEN CLAUDE TERMINAL (project-level or conversation-level)
      if (sub === '/open-terminal' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as { jid?: string }
        return json(openClaudeTerminal(id, body.jid))
      }

      // ─── DISPATCHER (group-binding CRUD) ───
      if (sub === '/dispatcher' && req.method === 'GET') {
        return json(readDispatcher(id))
      }
      if (sub === '/dispatcher' && req.method === 'PUT') {
        const body = await req.json() as { defaultProject?: string; bindings?: Record<string, string> }
        writeDispatcher(id, body)
        return json({ ok: true, dispatcher: readDispatcher(id) })
      }
      if (sub.match(/^\/dispatcher\/bindings$/) && req.method === 'POST') {
        const body = await req.json() as { jid: string; targetProjectId: string }
        const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
        const bindings = cfg.bindings ?? {}
        const targetProjectPath = idToPath(body.targetProjectId)
        if (!existsSync(targetProjectPath)) return json({ ok: false, err: 'target project not found' }, 400)
        bindings[body.jid] = targetProjectPath
        cfg.bindings = bindings
        writeJsonAtomic(join(stateDir, 'config.json'), cfg)
        return json({ ok: true, bindings })
      }
      const bindingDelete = sub.match(/^\/dispatcher\/bindings\/(.+)$/)
      if (bindingDelete && req.method === 'DELETE') {
        const jid = decodeURIComponent(bindingDelete[1]!)
        const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
        const bindings = cfg.bindings ?? {}
        delete bindings[jid]
        cfg.bindings = bindings
        writeJsonAtomic(join(stateDir, 'config.json'), cfg)
        return json({ ok: true, bindings })
      }
      if (sub === '/dispatcher/default' && req.method === 'PUT') {
        const body = await req.json() as { targetProjectId: string | null }
        const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
        if (body.targetProjectId) {
          const targetPath = idToPath(body.targetProjectId)
          if (!existsSync(targetPath)) return json({ ok: false, err: 'target project not found' }, 400)
          cfg.defaultProject = targetPath
        } else {
          delete cfg.defaultProject
        }
        writeJsonAtomic(join(stateDir, 'config.json'), cfg)
        return json({ ok: true, defaultProject: cfg.defaultProject ?? null })
      }
      if (sub === '/recent-jids' && req.method === 'GET') {
        return json(recentUnboundJids(id))
      }

      // ─── MEMORY v2 (per-contact subfiles) ───
      const contactV2Read = sub.match(/^\/contacts-v2\/([^/]+)$/)
      if (contactV2Read && req.method === 'GET') {
        const jid = decodeURIComponent(contactV2Read[1]!)
        return json({ jid, ...readContactV2(id, jid) })
      }
      const contactV2Write = sub.match(/^\/contacts-v2\/([^/]+)\/([a-z]+)$/)
      if (contactV2Write && req.method === 'PUT') {
        const jid = decodeURIComponent(contactV2Write[1]!)
        const subfile = contactV2Write[2]!
        const body = await req.text()
        const result = writeContactV2Subfile(id, jid, subfile, body)
        return json(result, result.ok ? 200 : 400)
      }

      // ─── PLAYBOOKS ───
      if (sub === '/playbooks' && req.method === 'GET') {
        return json(listPlaybooks(id))
      }
      const pbWrite = sub.match(/^\/playbooks\/([a-z0-9_-]+)$/)
      if (pbWrite && req.method === 'PUT') {
        const name = pbWrite[1]!
        const body = await req.text()
        writeFileAtomic(join(stateDir, 'agent', 'playbooks', `${name}.md`), body)
        return json({ ok: true })
      }
      if (sub === '/playbooks/install-defaults' && req.method === 'POST') {
        installPlaybooks(join(stateDir, 'agent'))
        return json({ ok: true, playbooks: listPlaybooks(id).map(p => p.name) })
      }

      // OWNER JID (the JID whose WA chat shares session UUID with terminal)
      if (sub === '/owner-jid' && req.method === 'GET') {
        const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
        return json({ ownerJid: cfg.ownerJid ?? null })
      }
      if (sub === '/owner-jid' && req.method === 'PUT') {
        const body = await req.json() as { ownerJid: string | null }
        const cfg = readJsonSafe(join(stateDir, 'config.json')) ?? {}
        const projectPath = cfg.project_path ?? idToPath(id)   // use config's stored path (TCC-safe)
        const sessions = readJsonSafe(join(stateDir, 'sessions.json')) ?? {}
        const access = readJsonSafe(join(stateDir, 'access.json')) ?? { allowFrom: [], mode: 'open' }
        if (body.ownerJid) {
          cfg.ownerJid = body.ownerJid
          // Pre-populate the JID's session UUID with the latest terminal session
          // for this cwd. If user later runs `claude --resume <uuid>` in terminal,
          // both will share state.
          const uuid = findLatestSessionUuid(projectPath)
          if (uuid && !sessions[body.ownerJid]) {
            sessions[body.ownerJid] = uuid
            writeJsonAtomic(join(stateDir, 'sessions.json'), sessions)
          }
          // CRITICAL: in closed-mode access, the owner JID would otherwise still
          // be dropped. Auto-add to allowFrom — the user clearly wants this
          // person to reach the bot.
          if (!(access.allowFrom ?? []).includes(body.ownerJid)) {
            access.allowFrom = [...(access.allowFrom ?? []), body.ownerJid]
            writeJsonAtomic(join(stateDir, 'access.json'), access)
          }
        } else {
          delete cfg.ownerJid
        }
        writeJsonAtomic(join(stateDir, 'config.json'), cfg)
        return json({
          ok: true,
          ownerJid: cfg.ownerJid ?? null,
          sessionUuid: sessions[body.ownerJid || ''] ?? null,
          allowFrom: access.allowFrom,
        })
      }

      // EXTRA MCPS
      if (sub === '/mcps' && req.method === 'GET') {
        return json(readExtraMcps(id))
      }
      if (sub === '/mcps' && req.method === 'PUT') {
        const body = await req.json() as { mcpServers: Record<string, any> }
        if (!body.mcpServers || typeof body.mcpServers !== 'object') {
          return json({ ok: false, err: 'must be {mcpServers: {...}}' }, 400)
        }
        writeExtraMcps(id, body)
        return json({ ok: true })
      }

      // PROJECT DELETE
      if (sub === '' && req.method === 'DELETE') {
        // Stop router first, then nuke the state dir in ~/.cc-whatsapp/projects/
        // (leaves the project folder itself completely untouched)
        stopRouter(id)
        try {
          rmSync(getStateDir(id), { recursive: true, force: true })
          return json({ ok: true })
        } catch (err) {
          return json({ ok: false, err: String(err) }, 500)
        }
      }
    }

    // ─── Static files ───
    if (p === '/' || p === '/index.html') {
      return serveStatic('index.html', 'text/html; charset=utf-8')
    }
    if (p.startsWith('/assets/')) {
      const file = p.slice('/assets/'.length)
      const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain'
      return serveStatic(`assets/${file}`, mime)
    }

    return notFound()
  },
})

function serveStatic(name: string, mime: string): Response {
  const path = join(WEB_ROOT, name)
  try {
    return new Response(readFileSync(path), { headers: { 'Content-Type': mime } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

startTraceWatchers()

process.stderr.write(`\n✓ cc-whatsapp dashboard on http://127.0.0.1:${PORT}\n`)
process.stderr.write(`  open in browser, manage all your bots\n\n`)

if (process.platform === 'darwin' && process.env.CC_WHATSAPP_DASHBOARD_AUTO_OPEN !== '0') {
  spawn('open', [`http://127.0.0.1:${PORT}/`], { stdio: ['ignore', 'ignore', 'ignore'] })
}
