#!/usr/bin/env bun
/**
 * cc-whatsapp dashboard — local web UI for managing all bots on this machine.
 *
 * Standalone Bun server. Discovers cc-whatsapp projects on disk, lets you
 * read/edit/control them via browser. No SaaS, no auth — strictly localhost.
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
  watchFile,
  writeFileSync,
  renameSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(PLUGIN_ROOT)
const WEB_ROOT = join(PLUGIN_ROOT, 'web')
const PORT = Number(process.env.CC_WHATSAPP_DASHBOARD_PORT ?? 38500)

// ─── Project discovery ─────────────────────────────────────────────────────

// A cc-whatsapp project is any dir containing .claude/cc-whatsapp/config.json.
// Discovery locations (deduped): ~/Projects/*, $HOME (top-level cc-whatsapp dirs).
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
  id: string          // base64url of abs path
  path: string        // abs path to project root
  name: string        // basename
  account: string
  routerAlive: boolean
  routerPid?: number
  syncAlive: boolean
  syncPid?: number
  allowFrom: string[]
  disabled: boolean
  contactCount: number
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
  return {
    id: pathToId(absPath),
    path: absPath,
    name: absPath.split('/').filter(Boolean).pop() ?? absPath,
    account: cfg.account ?? 'main',
    routerAlive: isPidAlive(routerPid),
    routerPid,
    syncAlive: isPidAlive(syncPid),
    syncPid,
    allowFrom: access.allowFrom ?? [],
    disabled: !!access.disabled,
    contactCount,
  }
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

// Atomic JSON write (tmp + rename).
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
// Per-project tunables.json — overrides default env-var-driven settings.
// Router reads on every turn (fresh per webhook), so changes apply live.

type Tunables = {
  // ─ Basics: timing of replies (the most-visible humanlike feel) ─
  collect_window_ms?: number
  pre_reply_min_ms?: number
  pre_reply_max_ms?: number
  inter_segment_min_ms?: number
  inter_segment_max_ms?: number
  // ─ Reply behaviour ─
  quote_reply_probability?: number    // 0–1
  multi_msg_max_segments?: number     // 1–8
  enable_typing_indicator?: boolean   // shows "typing…" in WhatsApp
  // ─ Brain ─
  chat_model?: string                 // anthropic model id
  max_prompt_chars?: number           // truncate single inbound msg at this length
  // ─ Length-scaling factors for inter-segment delay (multiplied with min/max) ─
  length_factor_short?: number        // text < 20 chars (default 0.5)
  length_factor_medium?: number       // text 20–100 chars (default 1.0)
  length_factor_long?: number         // text > 100 chars (default 1.6)
  // ─ Experimental — future-flagged ─
  quiet_hours_start?: number          // 0–23, empty = disabled (not yet wired)
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
}

function loadTunables(id: string): Tunables {
  const path = join(getStateDir(id), 'tunables.json')
  const stored = readJsonSafe(path) ?? {}
  return { ...TUNABLES_DEFAULTS, ...stored }
}

// ─── HTTP API ───────────────────────────────────────────────────────────────

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

// Conversation list: WhatsApp-native (display name, last msg, count).
// Combines: allowlist JIDs ∪ contact files ∪ recent webhook traces.
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

  // Also include JIDs that have a contact file
  try {
    for (const f of readdirSync(join(stateDir, 'agent', 'contacts'))) {
      if (f.endsWith('.md') && f !== 'TEMPLATE.md') seen.add(f.replace(/\.md$/, ''))
    }
  } catch {}

  const conversations: any[] = []
  for (const jid of seen) {
    // Pull display name + last msg via wacli messages list
    let displayName = jid
    let lastText = ''
    let lastTimestamp = ''
    let lastFromMe = false
    try {
      const r = Bun.spawnSync({
        cmd: [join(REPO_ROOT, 'bin', 'cc-whatsapp'), '--account', account, 'messages', 'list', '--chat', jid, '--limit', '1', '--json'],
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

    // Fallback display name from contact file's "PushName:" field
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
      cmd: [join(REPO_ROOT, 'bin', 'cc-whatsapp'), '--account', account, 'messages', 'list', '--chat', jid, '--limit', String(limit), '--json', '--full'],
      stdout: 'pipe', stderr: 'pipe',
    })
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout))
    const msgs = (parsed?.data?.messages ?? []).map((m: any) => ({
      id: m.MsgID, text: m.Text || '', mediaType: m.MediaType || '',
      ts: m.Timestamp, fromMe: !!m.FromMe, sender: m.SenderName || '',
    })).reverse()  // oldest first for chat display
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

// Tail last N lines of trace.log (cheap; trace.log is small).
function tailTrace(id: string, lines = 100): string[] {
  const path = join(getStateDir(id), 'trace.log')
  try {
    const text = readFileSync(path, 'utf8')
    const all = text.trimEnd().split('\n')
    return all.slice(-lines)
  } catch { return [] }
}

// ─── Router control ────────────────────────────────────────────────────────

function routerLaunchScript(id: string): string {
  return join(getStateDir(id), 'run.command')
}

function startRouter(id: string): { ok: boolean; pid?: number; err?: string } {
  const path = idToPath(id)
  const stateDir = getStateDir(id)
  const cfg = readJsonSafe(join(stateDir, 'config.json'))
  if (!cfg?.account) return { ok: false, err: 'no config.account — run /cc-whatsapp:init' }
  // Ensure run.command exists (generate if missing).
  const runCmd = routerLaunchScript(id)
  if (!existsSync(runCmd)) generateRunCommand(id)
  // Just spawn it directly (no Terminal); dashboard provides UI for trace.
  // Spawn with detached + setsid so it survives dashboard restart.
  const child = Bun.spawn(['bash', runCmd], {
    cwd: path,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  })
  // Detach
  ;(child as any).unref?.()
  return { ok: true, pid: child.pid }
}

function generateRunCommand(id: string): void {
  const path = idToPath(id)
  const stateDir = getStateDir(id)
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

// ─── Bun.serve dispatcher ──────────────────────────────────────────────────

const wsClients = new Map<string, Set<any>>()  // projectId → Set<WebSocket>

function broadcastTraceLine(id: string, line: string): void {
  const set = wsClients.get(id)
  if (!set) return
  for (const ws of set) {
    try { ws.send(line) } catch {}
  }
}

// Watch each project's trace.log; broadcast new lines to subscribed WS clients.
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
        // New content appended.
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

// @ts-expect-error Bun global at runtime
const server = (globalThis as any).Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  websocket: {
    message() {},
    open(ws: any) {
      const id = ws.data?.projectId
      if (!id) return
      if (!wsClients.has(id)) wsClients.set(id, new Set())
      wsClients.get(id)!.add(ws)
      // Send initial backlog
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

    // WebSocket upgrade for trace streaming
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

    const projectMatch = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/)
    if (projectMatch) {
      const id = projectMatch[1]
      const sub = projectMatch[2] ?? ''
      if (!existsSync(idToPath(id))) return notFound()
      const stateDir = getStateDir(id)

      // GET /api/projects/:id
      if (sub === '' && req.method === 'GET') {
        return json(projectInfo(idToPath(id)))
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

      // TUNABLES
      if (sub === '/tunables' && req.method === 'GET') {
        return json(loadTunables(id))
      }
      if (sub === '/tunables' && req.method === 'PUT') {
        const body = await req.json() as Tunables
        // Filter to known keys + basic validation
        const cleaned: Tunables = {}
        for (const k of Object.keys(TUNABLES_DEFAULTS) as (keyof Tunables)[]) {
          if (body[k] !== undefined) (cleaned as any)[k] = body[k]
        }
        writeJsonAtomic(join(stateDir, 'tunables.json'), cleaned)
        return json({ ok: true, tunables: { ...TUNABLES_DEFAULTS, ...cleaned } })
      }

      // ACCESS / ALLOWLIST
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
        catch { return notFound() }
      }
      if (contactRead && req.method === 'PUT') {
        const jid = decodeURIComponent(contactRead[1])
        const body = await req.text()
        writeFileAtomic(join(stateDir, 'agent', 'contacts', `${jid}.md`), body)
        return json({ ok: true })
      }

      // CONVERSATIONS (WhatsApp-native view: display name + last msg)
      if (sub === '/conversations' && req.method === 'GET') {
        return json(listConversations(id))
      }
      const convoMsgs = sub.match(/^\/conversations\/([^/]+)\/messages$/)
      if (convoMsgs && req.method === 'GET') {
        const jid = decodeURIComponent(convoMsgs[1])
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return json(fetchConversationMessages(id, jid, limit))
      }

      // LIVE STATE (state machine snapshot the router writes)
      if (sub === '/state' && req.method === 'GET') {
        try { return json(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))) }
        catch { return json({}) }
      }

      // TURNS (per-invocation snapshots — see what Claude saw + did)
      if (sub === '/turns' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 30)
        return json(listTurns(id, limit))
      }
      const turnDetail = sub.match(/^\/turns\/([^/]+)$/)
      if (turnDetail && req.method === 'GET') {
        return json(loadTurn(id, turnDetail[1]))
      }

      // TRACE (one-shot tail; live updates via WS)
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

// Auto-open browser on first launch (macOS).
if (process.platform === 'darwin' && process.env.CC_WHATSAPP_DASHBOARD_AUTO_OPEN !== '0') {
  Bun.spawn(['open', `http://127.0.0.1:${PORT}/`], { stdio: ['ignore', 'ignore', 'ignore'] })
}
