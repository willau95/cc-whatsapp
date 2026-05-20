---
name: dashboard
description: Open the cc-whatsapp web dashboard — visual control panel for tunables, persona editor, allowlist, contacts, live trace. Use when the user says "open dashboard" / "show me the bot UI" / "let me tune the settings".
user-invocable: true
allowed-tools:
  - Bash(bun *)
  - Bash(open *)
  - Bash(pgrep *)
---

# /cc-whatsapp:dashboard — open the visual control panel

## Steps

1. **Check if a dashboard is already running** on port 38500:
   ```bash
   pgrep -fl "dashboard.ts" | grep cc-whatsapp
   ```
   If alive, just `open http://127.0.0.1:38500/` and tell the user it's already up.

2. **If not running, spawn it** in background:
   ```bash
   nohup bun ${CLAUDE_PLUGIN_ROOT}/dashboard.ts > /tmp/cc-whatsapp-dashboard.log 2>&1 &
   ```
   The dashboard will auto-open the browser on first launch (macOS).

3. **Confirm:**
   ```
   ✓ Dashboard running at http://127.0.0.1:38500/
   ```

## What the dashboard offers

- **Project list** (left rail) — all cc-whatsapp projects discovered on disk
- **Tabs per project:**
  - **tunables** — collect window, pre-reply delay, quote-reply probability, multi-msg, model, etc. — every behavior parameter, live-saved (router reads each turn)
  - **persona** — IDENTITY/SOUL/STYLE/AGENTS/MEMORY editor with ⌘S save
  - **contacts** — per-contact memory files browser + editor
  - **access** — allowlist + bot kill-switch
  - **trace** — live WebSocket stream of state machine events
- **Router controls** — start / stop buttons per project

## Notes

- Localhost only (no auth, no public exposure)
- All edits write directly to the project's `.claude/cc-whatsapp/` dir; router re-reads on every turn so no restart needed for most changes
- Close the dashboard via `pkill -f dashboard.ts` if needed
