---
name: allow
description: Add or remove a WhatsApp JID from this project's allowlist. Use when the user says "let X message the bot" or "remove Y from allowlist".
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(cat *)
---

# /cc-whatsapp:allow — manage who can reach the bot for this project

## Dispatch on `$ARGUMENTS`

### `<jid>` — add this JID to allowFrom

1. Read `.claude/cc-whatsapp/access.json`.
2. If `<jid>` already in `allowFrom`, say so, no-op.
3. Otherwise add it (deduplicate), write atomically.
4. Confirm: `✓ Added <jid> to allowlist. They can now reach the bot.`

JID format examples:
- `1234567890@s.whatsapp.net`   ← phone-number form (older)
- `123456789012345@lid`         ← privacy-preserving LID form (newer)
- `120363xxx@g.us`              ← group chat

The JID is what you see in the inbound `<channel source="whatsapp" jid="...">` block or in trace.log's `drop_not_allowlisted` events.

### `remove <jid>` — drop from allowFrom

Read access.json, remove `<jid>` from `allowFrom`, write atomically.

### `list` (or no args) — show current allowlist

Read access.json. Print:
```
Allowed JIDs (<N> total):
  - <jid1>
  - <jid2>
Status: <enabled/disabled>
```

### `disable` / `enable` — kill switch

Set `"disabled": true` (or remove the field) in access.json. When disabled, ALL inbound is dropped regardless of allowlist. Useful for quick mute.

## Notes

- `access.json` is re-read on every inbound message — changes take effect IMMEDIATELY, no router restart needed.
- For a new contact whose JID you don't know yet: have them message the bot once, then read `trace.log` for the `drop_not_allowlisted` event to capture their JID, then run `/cc-whatsapp:allow <captured-jid>`.
