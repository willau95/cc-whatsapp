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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  rmSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'
import QRCode from 'qrcode'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(PLUGIN_ROOT)
const WEB_ROOT = join(PLUGIN_ROOT, 'web')
const TEMPLATES_PERSONAS = join(PLUGIN_ROOT, 'templates', 'personas')
const TEMPLATES_AGENT = join(PLUGIN_ROOT, 'templates', 'agent')   // legacy default
const PORT = Number(process.env.CC_WHATSAPP_DASHBOARD_PORT ?? 38500)
const CC_WHATSAPP_BIN = join(REPO_ROOT, 'bin', 'cc-whatsapp')

// ─── Project discovery ─────────────────────────────────────────────────────

function discoverProjects(): Project[] {
  const found = new Map<string, Project>()
  const roots = [
    join(homedir(), 'Projects'),
    homedir(),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries: string[]
    try { entries = readdirSync(root) } catch { continue }
    for (const name of entries) {
      const abs = join(root, name)
      const cfgPath = join(abs, '.claude', 'cc-whatsapp', 'config.json')
      if (existsSync(cfgPath) && !found.has(abs)) {
        found.set(abs, projectInfo(abs))
      }
    }
  }
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name))
}

type Project = {
  id: string
  path: string
  name: string
  account: string
  routerAlive: boolean
  routerPid?: number
  syncAlive: boolean
  syncPid?: number
  allowFrom: string[]
  disabled: boolean
  contactCount: number
  paired: boolean
}

function pathToId(absPath: string): string {
  return Buffer.from(absPath).toString('base64url')
}
function idToPath(id: string): string {
  return Buffer.from(id, 'base64url').toString('utf8')
}

function projectInfo(absPath: string): Project {
  const stateDir = join(absPath, '.claude', 'cc-whatsapp')
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
  return {
    id: pathToId(absPath),
    path: absPath,
    name: absPath.split('/').filter(Boolean).pop() ?? absPath,
    account,
    routerAlive: isPidAlive(routerPid),
    routerPid,
    syncAlive: isPidAlive(syncPid),
    syncPid,
    allowFrom: access.allowFrom ?? [],
    disabled: !!access.disabled,
    contactCount,
    paired: isAccountPaired(account),
  }
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

function getStateDir(id: string): string {
  return join(idToPath(id), '.claude', 'cc-whatsapp')
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
  const stateDir = join(projectPath, '.claude', 'cc-whatsapp')
  const agentDir = join(stateDir, 'agent')
  const contactsDir = join(agentDir, 'contacts')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  mkdirSync(contactsDir, { recursive: true, mode: 0o700 })

  writeJsonAtomic(join(stateDir, 'config.json'), { account })
  writeJsonAtomic(join(stateDir, 'access.json'), { allowFrom: [] })
  writeJsonAtomic(join(stateDir, 'sessions.json'), {})
  writeJsonAtomic(join(stateDir, 'tunables.json'), {})

  const tplId = opts.template || 'eva'
  const tpl = readTemplateFiles(tplId) ?? readTemplateFiles('eva')
  if (tpl) {
    for (const [name, content] of Object.entries(tpl)) {
      writeFileAtomic(join(agentDir, name), content)
    }
  }

  // Copy contact TEMPLATE.md
  try {
    const src = join(TEMPLATES_AGENT, 'contacts', 'TEMPLATE.md')
    if (existsSync(src)) copyFileSync(src, join(contactsDir, 'TEMPLATE.md'))
  } catch {}

  const id = pathToId(projectPath)
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

function startRouter(id: string): { ok: boolean; pid?: number; err?: string } {
  const path = idToPath(id)
  const stateDir = getStateDir(id)
  const cfg = readJsonSafe(join(stateDir, 'config.json'))
  if (!cfg?.account) return { ok: false, err: 'no config.account — initialize first' }
  if (!isAccountPaired(cfg.account)) return { ok: false, err: `account "${cfg.account}" not paired yet — run pair first` }
  const runCmd = routerLaunchScript(id)
  // Always regenerate — picks up port assignments + any template updates.
  generateRunCommand(id)
  const child = spawn('bash', [runCmd], {
    cwd: path,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
    detached: true,
  })
  child.unref()
  return { ok: true, pid: child.pid }
}

function generateRunCommand(id: string): void {
  const path = idToPath(id)
  const stateDir = getStateDir(id)
  const port = getOrAssignRouterPort(id)
  const title = `cc-whatsapp · ${path.split('/').pop()}`
  const content = `#!/bin/zsh
# Generated by cc-whatsapp dashboard
PROJECT="${path}"
REPO="${REPO_ROOT}"
TITLE="${title}"
cd "$PROJECT" || exit 1
pkill -9 -f "router.ts.*$PROJECT" 2>/dev/null
sleep 0.5
export CC_WHATSAPP_PROJECT_DIR="$PROJECT/.claude/cc-whatsapp"
export CC_WHATSAPP_BIN="$REPO/bin/cc-whatsapp"
export CC_WHATSAPP_PORT=${port}
exec bun "$REPO/plugin/router.ts"
`
  writeFileAtomic(routerLaunchScript(id), content)
  try { require('fs').chmodSync(routerLaunchScript(id), 0o755) } catch {}
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
        return json(readJsonSafe(join(stateDir, 'access.json')) ?? { allowFrom: [] })
      }
      if (sub === '/access' && req.method === 'PUT') {
        const body = await req.json() as { allowFrom?: string[]; disabled?: boolean }
        const next = {
          allowFrom: Array.from(new Set(body.allowFrom ?? [])).filter(Boolean),
          disabled: !!body.disabled,
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
        return json(startRouter(id))
      }
      if (sub === '/router/stop' && req.method === 'POST') {
        return json(stopRouter(id))
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
        const projPath = idToPath(id)
        // Stop router first, then nuke the .claude/cc-whatsapp dir only (leave project folder alone)
        stopRouter(id)
        try {
          rmSync(join(projPath, '.claude', 'cc-whatsapp'), { recursive: true, force: true })
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
