# cc-whatsapp marketplace (Phase 2)

This directory holds a marketplace manifest that lets `cc-whatsapp` be loaded
via the official `--channels plugin:<name>@<marketplace>` mechanism (instead
of `--plugin-dir`), which unblocks `notifications/claude/channel` routing for
incoming messages to flow into the active Claude Code session.

## Status

**Phase 1 (current):** load via `--plugin-dir ~/Projects/cc-whatsapp/plugin`
and use router-daemon mode. Bot is online 24/7 regardless of Claude Code
sessions.

**Phase 2 (future):** load via `--channels plugin:cc-whatsapp@cc-whatsapp-marketplace`
and use channel-injection mode. Inbound messages appear as
`<channel source="whatsapp" jid="..." />` blocks in the active session — same
pattern as the official telegram plugin.

## To activate Phase 2

Two pieces still need wiring (deferred):

1. **server.ts** needs to register `experimental.claude/channel` capability
   and fire `mcp.notification({method: 'notifications/claude/channel', ...})`
   on inbound webhook events. The router daemon becomes optional.

2. **Marketplace registration** with Claude Code's plugin system — likely
   needs `claude plugin marketplace add ...` pointing at this dir, then
   `claude plugin install cc-whatsapp`.

These will follow once router-mode is fully proven in production.
