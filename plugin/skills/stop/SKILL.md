---
name: stop
description: Stop this project's cc-whatsapp router. Use when the user wants the bot offline for this project.
user-invocable: true
allowed-tools:
  - Read
  - Bash(cat *)
  - Bash(kill *)
  - Bash(pkill *)
  - Bash(pgrep *)
  - Bash(test *)
---

# /cc-whatsapp:stop — stop the router for this project

## Steps

1. **Read** `.claude/cc-whatsapp/router.pid`. If file missing, the router was never started — say so and stop.

2. **Verify the PID is actually OURS** (not a stale file pointing at someone else's process):
   ```bash
   ps -p <PID> -o command= | grep -q "router.ts" && echo OURS
   ```
   If not ours, just delete the stale `router.pid` and exit.

3. **Kill it:**
   ```bash
   kill <PID>          # graceful first
   sleep 1
   kill -9 <PID> 2>/dev/null || true   # force if still alive
   ```

4. **Also kill the wacli sync sidecar** (read `.claude/cc-whatsapp/sync.pid`):
   ```bash
   kill <SYNC_PID> 2>/dev/null
   ```

5. **Confirm dead:** `pgrep -fl router.ts | grep <project-path>` should return empty.

6. **Print:**
   ```
   ✓ Router stopped. Bot is now offline for this project.
   ```

## Notes

- Closing the Terminal window with the live router ALSO stops it (cleanly). /cc-whatsapp:stop is for when the window is hidden or you're in another session.
- Other projects' routers are NOT affected — we only target the PID associated with this project's `router.pid`.
