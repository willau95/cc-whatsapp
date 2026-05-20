---
name: init
description: Initialize cc-whatsapp for the current project — pick an account name, create state dir, copy persona templates, prepare for pairing. Use when the user asks to set up WhatsApp for this project / says "configure cc-whatsapp" / runs this for the first time.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(mkdir *)
  - Bash(cp *)
  - Bash(ls *)
  - Bash(basename *)
  - Bash(pwd)
  - Bash(test *)
  - Bash(cat *)
---

# /cc-whatsapp:init — first-time setup for THIS project

Sets up `.claude/cc-whatsapp/` under the current project root.

## Steps

1. **Check cwd is a project root.** Use `pwd`. If user looks confused or in `$HOME`, ask if they meant a different dir.

2. **Check existing state.** If `.claude/cc-whatsapp/config.json` already exists, ask before overwriting. Read it and offer:
   - "Already configured for account `<X>`. Re-init (overwrite config + persona)?  / Just open allowlist? / Cancel?"

3. **Pick account name.** Default = slugified basename of cwd (lowercase, hyphens). Confirm with user. Examples: `my-saas`, `sales-bot`, `eva-prod`. Must be `[a-z0-9-]+`, no spaces.
   - This will become `~/.wacli/accounts/<name>/` for the pairing store.
   - It must be unique across ALL cc-whatsapp projects on this machine.

4. **Create the project state dir + copy persona templates.**

   ```bash
   mkdir -p .claude/cc-whatsapp/agent/contacts .claude/cc-whatsapp/inbox
   cp ${CLAUDE_PLUGIN_ROOT}/templates/agent/IDENTITY.md   .claude/cc-whatsapp/agent/
   cp ${CLAUDE_PLUGIN_ROOT}/templates/agent/SOUL.md       .claude/cc-whatsapp/agent/
   cp ${CLAUDE_PLUGIN_ROOT}/templates/agent/STYLE.md      .claude/cc-whatsapp/agent/
   cp ${CLAUDE_PLUGIN_ROOT}/templates/agent/AGENTS.md     .claude/cc-whatsapp/agent/
   cp ${CLAUDE_PLUGIN_ROOT}/templates/agent/MEMORY.md     .claude/cc-whatsapp/agent/
   cp ${CLAUDE_PLUGIN_ROOT}/templates/agent/contacts/TEMPLATE.md .claude/cc-whatsapp/agent/contacts/
   ```

5. **Write `.claude/cc-whatsapp/config.json`:**

   ```json
   {
     "version": "0.1.0",
     "account": "<chosen-account-name>",
     "created": "<YYYY-MM-DD>"
   }
   ```

6. **Write `.claude/cc-whatsapp/access.json`:**

   ```json
   { "allowFrom": [] }
   ```

   Empty allowlist = nobody can reach the bot yet. User adds JIDs via `/cc-whatsapp:allow <jid>` (or by editing the file directly) after they know what JIDs to allow.

7. **Print next steps:**

   ```
   ✓ cc-whatsapp initialised for this project.
     account:  <name>
     state:    <abs-path-to>/.claude/cc-whatsapp/
     persona:  edit .claude/cc-whatsapp/agent/*.md to customise

   Next:
     /cc-whatsapp:pair    ← pair the WhatsApp number (QR scan)
     /cc-whatsapp:allow <jid>   ← whitelist allowed contacts
     /cc-whatsapp:start   ← launch the router (opens visible Terminal)
   ```

## Notes

- Persona files (IDENTITY/SOUL/STYLE/AGENTS/MEMORY) are TEMPLATES — user should
  edit them to make this project's bot have its own personality. The default
  Eva persona is a friendly assistant; user-specific projects (sales, customer
  support, etc.) should rewrite SOUL.md + AGENTS.md + STYLE.md.
- Account name is the link between this project and the wacli store. Once
  paired, this account belongs to this project — DO NOT reuse the same name
  for another project unless you intend them to share the WhatsApp identity.
