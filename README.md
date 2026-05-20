# cc-whatsapp

Bind a WhatsApp number to a Claude Code project. Each project gets its own
WhatsApp identity, persona, allowlist, and a humanlike batching state
machine — so the bot reads as a real person, not a 0-millisecond robot.

**Status:** alpha. Works for the maintainer's daily use. Open-source, MIT-licensed.

> ⚠️ Uses the unofficial WhatsApp multidevice protocol via [whatsmeow](https://github.com/tulir/whatsmeow) (through a [wacli](https://github.com/openclaw/wacli) fork). Each cc-whatsapp project consumes one of your WhatsApp linked-device slots. Use at your own risk — automated WhatsApp accounts are against Meta's TOS and can be banned.

## What it gives you

- **One WhatsApp number per project.** Pair once with QR, owned by that project's wacli account. No mixing identities.
- **Per-project persona.** `agent/IDENTITY.md` / `SOUL.md` / `STYLE.md` / `AGENTS.md` / `MEMORY.md` — edit these and the bot acts differently per project.
- **Humanlike timing.** A per-JID state machine collects bursts of messages for 60s, waits a random 30-60s "pre-reply" pause, then routes the whole batch to Claude as one combined turn. Multi-segment replies have length-scaled jitter between sends. Typing indicator is real (not faked) thanks to a patched IPC path in our wacli fork.
- **Long-term memory per contact.** `agent/contacts/<jid>.md` — Claude reads it before replying, edits it after. Persists across restarts.
- **Multimodal input.** Images you send to the bot are detected, resolved via WhatsApp Desktop's local cache (by FileLength + SHA256), and read directly by Claude Opus/Haiku's vision.
- **All Claude Code's tools available.** The bot can write code, search the web, edit files, run bash. It's just Claude Code with WhatsApp I/O grafted on.

## Install (local development)

Requires: macOS (for now), [Go](https://go.dev/) 1.25+, [Bun](https://bun.sh/), [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

```sh
git clone https://github.com/willau95/cc-whatsapp.git ~/Projects/cc-whatsapp
cd ~/Projects/cc-whatsapp
make            # builds bin/cc-whatsapp + installs plugin deps
```

## Use

In any project where you want a WhatsApp bot:

```sh
cd ~/my-project
claude --plugin-dir ~/Projects/cc-whatsapp/plugin --dangerously-skip-permissions
```

Inside the Claude Code session:

```
/cc-whatsapp:init             # one-time wizard: pick account name, copy persona templates
/cc-whatsapp:pair             # scan QR to link a WhatsApp number to this project
/cc-whatsapp:allow <jid>      # whitelist who can message the bot
/cc-whatsapp:start            # launch router (opens visible Terminal window)
/cc-whatsapp:status           # check state
/cc-whatsapp:stop             # take bot offline
```

After `/cc-whatsapp:start`, the bot stays online in a background Terminal window even if you close Claude Code.

## How it's wired

```
WhatsApp (incoming) ──► wacli sync (per-project account) ──webhook──► router.ts (state machine)
                                                                          │
                                                                          │  60s collect + random 30-60s pre-reply
                                                                          ▼
                                                              claude -p --resume <per-JID UUID>
                                                                          │  (uses agent/ persona + contact memory)
                                                                          ▼
                                                                  reply / react / edit tools
                                                                          │
                                                                          ▼
WhatsApp (outgoing) ◄─── wacli send ◄──── server.ts (MCP tools)
```

Per-project state lives under `<your-project>/.claude/cc-whatsapp/` — config, allowlist, persona, sessions, trace log.

The repo layout:

```
cc-whatsapp/
├── server/      Go CLI (fork of openclaw/wacli, MIT — see server/LICENSE)
├── plugin/      Claude Code plugin (.claude-plugin/ + .mcp.json + skills/ + scripts/ + templates/)
├── bin/         Built binary (gitignored; produced by make build)
├── marketplace/ Manifest skeleton for Phase 2 (channel-mode + claude plugin install)
└── Makefile
```

## Architecture decision: localhost only, not SaaS

This is a **self-hosted tool**, not a hosted service. You install it on your own machine; your WhatsApp credentials and conversations never leave it. We will NOT offer a SaaS version because:

1. Running multi-tenant automated WhatsApp is against Meta's TOS — there are precedents of Meta suing such providers.
2. Keeping users' WhatsApp sessions on a central server is a privacy nightmare we don't want to be responsible for.
3. Self-hosted matches the "everyone can own their own AI agent" democratising vision behind Claude Code.

If you want a managed deployment, use one-click deploy buttons (Render / Fly / Railway / etc.) into **your own** cloud account. We won't keep your data.

## Status / roadmap

- ✅ Phase 1: router-daemon mode + Eva-style humanlike batching + multi-project + patched socket-presence
- ⏳ Phase 2: dashboard (local web UI), multi-platform binary builds via GitHub Actions
- ⏳ Phase 3: channel-mode (inbound messages flow directly into active Claude Code sessions as `<channel source="whatsapp">` blocks; needs marketplace registration)
- ⏳ Phase 4: voice transcription, group chats with @-mention triggering, scheduled offline simulation

## Contributing

Issues + PRs welcome. Note: anything that depends on Meta's TOS-violating capabilities will probably get bigger over time, not smaller. Be patient with breakage.

## License

MIT — see [LICENSE](LICENSE). The `server/` subtree retains its upstream MIT
from openclaw/wacli (see `server/LICENSE`).

## Credits

- [openclaw/wacli](https://github.com/openclaw/wacli) by Peter Steinberger — the WhatsApp CLI this is forked from.
- [tulir/whatsmeow](https://github.com/tulir/whatsmeow) by Tulir Asokan — the underlying Go WhatsApp library.
- [Anthropic Claude Code](https://docs.anthropic.com/en/docs/claude-code) — the brain.
