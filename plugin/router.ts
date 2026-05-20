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

// ─── Per-project state dir ───
// Convention: <consumer-project>/.claude/cc-whatsapp/
// Override with env if launching outside a project root.
const STATE_DIR = process.env.CC_WHATSAPP_PROJECT_DIR
              ?? join(process.cwd(), '.claude', 'cc-whatsapp')

const ACCESS_FILE   = join(STATE_DIR, 'access.json')
const SECRET_FILE   = join(STATE_DIR, '.secret')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
const CONFIG_FILE   = join(STATE_DIR, 'config.json')
const ROUTER_PID    = join(STATE_DIR, 'router.pid')
const SYNC_PID      = join(STATE_DIR, 'sync.pid')
const TRACE_FILE    = join(STATE_DIR, 'trace.log')
const STATE_SNAP    = join(STATE_DIR, 'state.json')   // live state machine snapshot (dashboard polls)
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
function loadProjectConfig(): { account?: string } {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  catch { return {} }
}
const WACLI_ACCOUNT = loadProjectConfig().account ?? 'main'

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
  chat_model: string
  max_prompt_chars: number
  length_factor_short: number
  length_factor_medium: number
  length_factor_long: number
  dry_run: boolean
}
function tunables(): Tunables {
  let stored: any = {}
  try { stored = JSON.parse(readFileSync(TUNABLES_FILE, 'utf8')) } catch {}
  return {
    collect_window_ms: stored.collect_window_ms ?? Number(process.env.CC_WHATSAPP_COLLECT_WINDOW_MS ?? 60_000),
    pre_reply_min_ms:  stored.pre_reply_min_ms  ?? Number(process.env.CC_WHATSAPP_PRE_REPLY_MIN_MS  ?? 30_000),
    pre_reply_max_ms:  stored.pre_reply_max_ms  ?? Number(process.env.CC_WHATSAPP_PRE_REPLY_MAX_MS  ?? 60_000),
    quote_reply_probability: stored.quote_reply_probability ?? 0.4,
    multi_msg_max_segments:  stored.multi_msg_max_segments  ?? 4,
    inter_segment_min_ms:    stored.inter_segment_min_ms    ?? 800,
    inter_segment_max_ms:    stored.inter_segment_max_ms    ?? 2200,
    enable_typing_indicator: stored.enable_typing_indicator !== false,  // default true
    chat_model: stored.chat_model ?? (process.env.CC_WHATSAPP_CHAT_MODEL ?? 'claude-haiku-4-5-20251001'),
    max_prompt_chars: stored.max_prompt_chars ?? 8000,
    length_factor_short:  stored.length_factor_short  ?? 0.5,
    length_factor_medium: stored.length_factor_medium ?? 1.0,
    length_factor_long:   stored.length_factor_long   ?? 1.6,
    dry_run: process.env.CC_WHATSAPP_DRY_RUN === '1',
  }
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

type Access = { allowFrom: string[]; disabled?: boolean }
function loadAccess(): Access {
  try {
    const p = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return { allowFrom: p.allowFrom ?? [], disabled: p.disabled }
  } catch { return { allowFrom: [] } }
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
  // Tunable: respect enable_typing_indicator (per-project toggle).
  if (!tunables().enable_typing_indicator) return setInterval(() => {}, 60_000)
  const args = ['--account', WACLI_ACCOUNT, 'presence', 'typing', '--to', jid]
  if (kind === 'voice') args.push('--media', 'audio')
  const fire = () => spawn(WACLI_BIN, args, { stdio: 'ignore' }).on('error', () => {})
  fire()
  return setInterval(fire, 7_000)
}
function stopTyping(jid: string): void {
  spawn(WACLI_BIN, ['--account', WACLI_ACCOUNT, 'presence', 'paused', '--to', jid], { stdio: 'ignore' }).on('error', () => {})
}

const MCP_JSON = JSON.stringify({
  mcpServers: {
    whatsapp: {
      command: 'bun',
      args: [SERVER_FILE],
    },
  },
})

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
  p.timer = setTimeout(() => closeCollectWindow(jid), tunables().collect_window_ms)
  writeStateSnapshot()
}

function closeCollectWindow(jid: string): void {
  const p = getPending(jid)
  p.timer = null
  if (p.batch.length === 0) { p.state = 'IDLE'; return }
  const t = tunables()
  const preDelay = t.pre_reply_min_ms + Math.floor(Math.random() * Math.max(1, t.pre_reply_max_ms - t.pre_reply_min_ms))
  p.state = 'PRE_REPLY'
  trace('collect_closed_pre_reply', { jid, batchSize: p.batch.length, preDelayMs: preDelay })
  p.timer = setTimeout(() => triggerClaude(jid), preDelay)
}

async function triggerClaude(jid: string): Promise<void> {
  const p = getPending(jid)
  p.timer = null
  if (p.batch.length === 0) { p.state = 'IDLE'; return }
  p.state = 'CLAUDE_RUNNING'
  const batchSnapshot = p.batch.slice()
  p.batch = []  // new msgs from now on accumulate to the NEXT batch

  if (DRY_RUN) {
    trace('claude_trigger_DRY_RUN', { jid, batchSize: batchSnapshot.length, msg_ids: batchSnapshot.map((m: any) => m.ID) })
    setTimeout(() => onClaudeExit(jid), 1_000)
    return
  }

  const prompt = await buildBatchPrompt(jid, batchSnapshot)
  if (!prompt) {
    trace('batch_unmapped', { jid })
    onClaudeExit(jid)
    return
  }
  // Per-turn snapshot — dashboard reads this for the "Production" view.
  const turnId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${jid.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`
  const turnDir = join(TURNS_DIR, turnId)
  mkdirSync(turnDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(turnDir, 'prompt.txt'), prompt)
  writeFileSync(join(turnDir, 'persona.txt'), PERSONA_PROMPT)
  writeFileSync(join(turnDir, 'batch.json'), JSON.stringify({ jid, batchSize: batchSnapshot.length, messages: batchSnapshot, model: tunables().chat_model, started_at: new Date().toISOString() }, null, 2))

  trace('claude_trigger', { jid, batchSize: batchSnapshot.length, promptLen: prompt.length, turnId })
  const startMs = Date.now()
  spawnClaudeWithTurn(jid, prompt, turnId, startMs, () => onClaudeExit(jid))
}

function spawnClaudeWithTurn(jid: string, prompt: string, turnId: string, startMs: number, onExit: () => void): void {
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
  trace('claude_spawn', { jid, sessId: sess.uuid, sessNew: sess.isNew, model: tunables().chat_model, promptLen: prompt.length, turnId })

  const heartbeat = startTyping(jid)
  const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdoutBuf = ''
  let stderrBuf = ''
  child.stdout.on('data', d => { stdoutBuf += d.toString() })
  child.stderr.on('data', d => { stderrBuf += d.toString() })
  child.on('exit', code => {
    clearInterval(heartbeat)
    stopTyping(jid)
    const durationMs = Date.now() - startMs
    // Write turn outcome snapshot
    try {
      writeFileSync(join(TURNS_DIR, turnId, 'stdout.txt'), stdoutBuf)
      writeFileSync(join(TURNS_DIR, turnId, 'stderr.txt'), stderrBuf)
      writeFileSync(join(TURNS_DIR, turnId, 'exit.json'), JSON.stringify({
        jid, code, durationMs, ended_at: new Date().toISOString(),
      }, null, 2))
    } catch {}
    trace('claude_exit', { jid, code, durationMs, stdoutTail: stdoutBuf.slice(-200), stderrTail: stderrBuf.slice(-300), turnId })
    onExit()
  })
  child.on('error', err => {
    clearInterval(heartbeat)
    stopTyping(jid)
    try { writeFileSync(join(TURNS_DIR, turnId, 'error.txt'), String(err)) } catch {}
    trace('claude_error', { jid, err: String(err), turnId })
    onExit()
  })
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
  p.timer = setTimeout(() => closeCollectWindow(jid), tunables().collect_window_ms)
  writeStateSnapshot()
}

// Build a prompt that wraps every msg in the batch as a <whatsapp> tag, then
// appends one batch-level instruction block (contact memory + multi-msg
// guidance + quote-reply guidance).
async function buildBatchPrompt(jid: string, batch: any[]): Promise<string | null> {
  const fragments: string[] = []
  for (const evt of batch) {
    const mapped = await buildPrompt(evt)
    if (!mapped) continue
    // Keep only the <whatsapp ...>…</whatsapp> block (strip per-msg trailing hints).
    const m = mapped.prompt.match(/<whatsapp [^>]*>[\s\S]*?<\/whatsapp>/)
    if (m) fragments.push(m[0])
  }
  if (fragments.length === 0) return null

  const contactFile = join(CONTACTS_DIR, `${jid}.md`)
  const contactExists = existsSync(contactFile)

  const trailer: string[] = []
  trailer.push(`Contact file: ${contactFile} (${contactExists ? 'exists — Read it first to recall who this is' : 'does NOT exist yet — copy TEMPLATE.md to this path and fill in basic info from PushName + any context you learn'})`)
  const t = tunables()
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

      const access = loadAccess()
      if (access.disabled) { trace('drop_disabled'); return new Response('ok') }
      if (!access.allowFrom.includes(evt.Chat)) {
        trace('drop_not_allowlisted', { jid: evt.Chat })
        return new Response('ok')
      }
      if (evt.FromMe === true || evt.Revoked === true) {
        trace('drop_from_me_or_revoked', { jid: evt.Chat })
        return new Response('ok')
      }

      // Hand off to the batching state machine. It will collect more msgs,
      // wait the pre-reply delay, then spawn claude with the whole batch.
      enqueueMessage(evt.Chat, evt)
    } catch (err) {
      trace('webhook_handler_error', String(err))
    }
    return new Response('ok')
  },
})

// ─────────── wacli sync sidecar ───────────

const syncProc = spawn(
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
writeFileSync(SYNC_PID, String(syncProc.pid))
syncProc.stderr.on('data', d => trace('wacli_stderr', d.toString().trim().slice(0, 300)))
syncProc.on('exit', code => trace('wacli_exit', { code }))

// ─────────── lifecycle ───────────

function shutdown(reason: string): void {
  trace('shutdown', { reason })
  try { syncProc.kill('SIGTERM') } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', err => trace('unhandled_rejection', String(err)))
process.on('uncaughtException', err => trace('uncaught_exception', String(err)))

trace('router_ready', { port: PORT, pid: process.pid, state: STATE_DIR, account: WACLI_ACCOUNT, bin: CC_WHATSAPP_BIN })
process.stderr.write(`\n✓ cc-whatsapp router on http://127.0.0.1:${PORT} · pid ${process.pid}\n  project: ${STATE_DIR}\n  account: ${WACLI_ACCOUNT}\n  binary:  ${CC_WHATSAPP_BIN}\n  ctrl-c to stop\n\n`)
