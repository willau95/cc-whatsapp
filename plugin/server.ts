#!/usr/bin/env bun
/**
 * cc-whatsapp MCP server — child of each headless `claude -p` invocation.
 *
 * Tools: reply / react / edit_message / download_attachment.
 * Each shells out to the per-project cc-whatsapp binary, passing
 * --account <project-account> from the project's config.json.
 *
 * State location: <consumer-project>/.claude/cc-whatsapp/
 *   (override with env CC_WHATSAPP_PROJECT_DIR)
 * Binary location: <repo-root>/bin/cc-whatsapp by default
 *   (override with env CC_WHATSAPP_BIN)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(PLUGIN_ROOT)

const STATE_DIR = process.env.CC_WHATSAPP_PROJECT_DIR
              ?? join(process.cwd(), '.claude', 'cc-whatsapp')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const INBOX_DIR   = join(STATE_DIR, 'inbox')
const CONFIG_FILE = join(STATE_DIR, 'config.json')

const CC_WHATSAPP_BIN = process.env.CC_WHATSAPP_BIN
                     ?? (existsSync(join(REPO_ROOT, 'bin', 'cc-whatsapp'))
                         ? join(REPO_ROOT, 'bin', 'cc-whatsapp')
                         : 'cc-whatsapp')
const WACLI_BIN = CC_WHATSAPP_BIN  // legacy alias

const WACLI_ACCOUNT = (() => {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).account ?? 'main' }
  catch { return 'main' }
})()

type Access = { allowFrom: string[]; disabled?: boolean }

function loadAccess(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return { allowFrom: parsed.allowFrom ?? [], disabled: parsed.disabled }
  } catch { return { allowFrom: [] } }
}

function assertAllowed(jid: string): void {
  const a = loadAccess()
  if (a.disabled) throw new Error('whatsapp channel disabled in access.json')
  if (!a.allowFrom.includes(jid)) {
    throw new Error(`jid ${jid} not in allowFrom — edit ${ACCESS_FILE}`)
  }
}

function wacli(args: string[]): string {
  const fullArgs = ['--account', WACLI_ACCOUNT, ...args]
  const r = spawnSync(WACLI_BIN, fullArgs, { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) {
    throw new Error(`cc-whatsapp ${args[0]} ${args[1]} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
  }
  return r.stdout ?? ''
}

function extractMessageId(jsonOut: string): string {
  try {
    const obj = JSON.parse(jsonOut.trim())
    return String(obj.message_id ?? obj.id ?? obj.messageId ?? '?')
  } catch { return '?' }
}

const mcp = new Server(
  { name: 'whatsapp', version: '0.0.2' },
  {
    capabilities: { tools: {} },
    instructions: [
      'WhatsApp tools. You are answering a single WhatsApp message that the router has piped in as your prompt.',
      '',
      'Always call the `reply` tool to respond — your text output does NOT reach the user. Pass the jid from the prompt back into the reply tool.',
      '',
      'For quote-replies use reply_to=<message_id>. For an emoji reaction use the `react` tool. To edit a prior bot message use `edit_message` (WhatsApp allows 15min edit window).',
      '',
      'Be concise unless the user asks for length. Plain text is fine — no markdown headers (WhatsApp will not render them).',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a WhatsApp message. Pass jid from the inbound block. Optional reply_to to quote an earlier message; optional files (absolute paths) to attach images/documents.',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          text: { type: 'string' },
          reply_to: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['jid', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction. Pass empty string to remove.',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['jid', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message YOU previously sent (15-minute window).',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['jid', 'message_id', 'text'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download media from a WhatsApp message into the inbox; returns the local path. Use when the inbound block has attachment_kind but no image_path.',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          message_id: { type: 'string' },
        },
        required: ['jid', 'message_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params as { name: string; arguments: Record<string, unknown> }

  try {
    if (name === 'reply') {
      const jid = String(args.jid)
      const text = String(args.text ?? '')
      const replyTo = args.reply_to ? String(args.reply_to) : undefined
      const files = Array.isArray(args.files) ? (args.files as unknown[]).map(String) : []
      assertAllowed(jid)

      // Humanlike pre-send delay: random, scaled by text length.
      // Short msgs feel snappier; long msgs feel like real typing.
      const len = text.length
      const min = len < 20 ? 300 : len < 100 ? 800 : 1500
      const max = len < 20 ? 900 : len < 100 ? 2200 : 3500
      const delay = min + Math.floor(Math.random() * (max - min))
      await new Promise(r => setTimeout(r, delay))

      const sent: string[] = []
      if (text.length > 0) {
        // Quote-reply is just `send text` with --reply-to MSG_ID — NOT a `send reply`
        // subcommand (no such subcommand exists in wacli; earlier code was wrong
        // and silently fell back to plain text).
        const cliArgs = ['send', 'text', '--to', jid, '--message', text, '--json']
        if (replyTo) { cliArgs.push('--reply-to', replyTo) }
        sent.push(extractMessageId(wacli(cliArgs)))
      }
      for (const f of files) {
        sent.push(extractMessageId(wacli(['send', 'file', '--to', jid, '--file', f, '--json'])))
      }
      return { content: [{ type: 'text', text: `sent ${sent.length} message(s): ${sent.join(', ')} (after ${delay}ms humanlike delay)` }] }
    }

    if (name === 'react') {
      const jid = String(args.jid)
      assertAllowed(jid)
      // wacli send react: --id (not --message-id), --reaction (not --emoji).
      // Empty string removes reaction.
      wacli(['send', 'react', '--to', jid, '--id', String(args.message_id), '--reaction', String(args.emoji ?? '')])
      return { content: [{ type: 'text', text: 'reaction sent' }] }
    }

    if (name === 'edit_message') {
      const jid = String(args.jid)
      assertAllowed(jid)
      wacli(['messages', 'edit', '--chat', jid, '--id', String(args.message_id), '--message', String(args.text)])
      return { content: [{ type: 'text', text: 'edit sent' }] }
    }

    if (name === 'download_attachment') {
      const jid = String(args.jid)
      assertAllowed(jid)
      const out = wacli(['media', 'download', '--chat', jid, '--id', String(args.message_id), '--output', INBOX_DIR, '--json'])
      let path = out.trim()
      try { const obj = JSON.parse(out.trim()); path = obj.path ?? obj.file ?? path } catch {}
      return { content: [{ type: 'text', text: path }] }
    }

    throw new Error(`unknown tool: ${name}`)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] }
  }
})

await mcp.connect(new StdioServerTransport())
process.stderr.write(`whatsapp MCP server ready (pid=${process.pid})\n`)
