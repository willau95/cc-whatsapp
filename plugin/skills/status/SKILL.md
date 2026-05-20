---
name: status
description: Show this project's cc-whatsapp status — config, allowlist, router alive, recent traces. Use when the user asks "is the bot running" / "what's happening" / "show status".
user-invocable: true
allowed-tools:
  - Read
  - Bash(cat *)
  - Bash(ps *)
  - Bash(pgrep *)
  - Bash(tail *)
  - Bash(test *)
---

# /cc-whatsapp:status — show project status

## Output

Read the project's `.claude/cc-whatsapp/` state and print:

```
cc-whatsapp · <project-basename>
─────────────────────────────────
config:    .claude/cc-whatsapp/config.json
  account:   <X>
  version:   0.1.0
  created:   <YYYY-MM-DD>

allowlist: <N> JID(s)
  - <jid1>
  - <jid2>
disabled:  <true/false>

persona:   .claude/cc-whatsapp/agent/
  IDENTITY.md  <size>
  SOUL.md      <size>
  STYLE.md     <size>
  AGENTS.md    <size>
  MEMORY.md    <size>
  contacts/    <N> files

router:    <PID> (alive <X>m <Y>s) | not running
sync:      <PID> (alive ...)        | not running

recent trace (last 5):
  <ISO ts> webhook_received | text_preview="..."
  <ISO ts> claude_trigger   | batchSize=2
  ...
```

## Steps

1. Read `.claude/cc-whatsapp/config.json` — bail if missing.
2. Read `access.json` — count allowFrom, show disabled.
3. ls `.claude/cc-whatsapp/agent/*.md` for persona, count contacts/.
4. Read `router.pid` + `sync.pid`. For each:
   - `test -d /proc/<PID>` doesn't work on macOS — use `ps -p <PID> -o pid,etime,command`.
   - If alive: get etime; if dead: say "not running" + suggest `/cc-whatsapp:start`.
5. `tail -n 5 trace.log` for recent events.

Make the output compact and scannable — user is checking "is this thing on?".
