---
name: pair
description: Pair a WhatsApp number for this project via QR code. Renders QR to a PNG, opens Preview, user scans. Use after /cc-whatsapp:init or to re-pair if linked device was unlinked.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(bun *)
  - Bash(cat *)
  - Bash(open *)
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/pair.sh *)
---

# /cc-whatsapp:pair — link a WhatsApp number to this project

## Steps

1. **Read `.claude/cc-whatsapp/config.json`** to get the account name. If missing, tell the user to run `/cc-whatsapp:init` first.

2. **Run the pair script:**

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/pair.sh <account-name>
   ```

   This script:
   - Spawns `cc-whatsapp accounts add <account-name> --qr-format text`
   - Pipes the QR string to a renderer that writes `/tmp/cc-wa-qr.png`
   - Opens Preview so the user can scan with WhatsApp → Settings → Linked Devices → Link a Device
   - QR rotates every ~20s; the same PNG file gets overwritten so re-scanning works
   - Script exits cleanly when WhatsApp reports a successful pair (account stays in `~/.wacli/accounts/<name>/`)

3. **Verify:** after the user says they scanned, run `cc-whatsapp --account <name> auth status` and confirm authenticated.

4. **Print next steps:**

   ```
   ✓ Paired. The WhatsApp number bound to this project is:
     <authenticated-jid>

   Next:
     /cc-whatsapp:allow <jid>   ← whitelist who can reach the bot
     /cc-whatsapp:start         ← launch the router
   ```

## Caveats

- WhatsApp limits linked devices to 5 per primary phone. Each cc-whatsapp project consumes 1 slot.
- If the QR window doesn't pop, tell the user to `open /tmp/cc-wa-qr.png` manually.
- Pair attaches the user's WhatsApp identity to wacli — they'll see "linked device" entries in their phone's WhatsApp settings. Unlinking from the phone breaks our bot until re-paired.
