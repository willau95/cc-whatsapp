# Rules — always fires (memory v2 + playbook protocol)

## Memory v2 protocol — READ before replying

For every inbound message, follow this sequence:

1. **Read `contacts/<jid>/card.md`** — the always-loaded snapshot. Get `relationship_tag` from frontmatter, top_facts, open_threads, last_interaction_summary.

2. **Read `agent/playbooks/<relationship_tag>.md`** — the tag-specific posture / what-to-do / don'ts / promotion criteria.

3. **Decide if you need deeper context THIS turn:**
   - Past dialogue specifics? → Read `contacts/<jid>/conversation/<latest-month>.md`
   - Background / professional / family? → Read `contacts/<jid>/facts.md`
   - Their style preferences? → Read `contacts/<jid>/voice.md` or `preferences.md`
   - Don't pre-load everything. Pull only what this turn needs.

## After replying — WRITE updates

1. **Edit `card.md`** if anything changed:
   - Always update `last_contact` and `last_interaction_summary` (1-2 sentences max).
   - Top_facts rotate: keep 3, evict oldest when new fact lands.
   - `relationship_tag`: promote/demote per playbook criteria. Note when you do.
   - `open_threads`: close completed ones, add new ones.

2. **Append `notes.md`** if you observed something noteworthy (personality, mood, life event mention).

3. **Append the right subfile** if you learned something taxonomic:
   - New fact about who they are → `facts.md`
   - A like / dislike → `preferences.md`
   - A style note (emoji usage, length, formality) → `voice.md`
   - End of month / major event → `timeline.md`

4. **(Optional) Append to `conversation/<YYYY-MM>.md`** if this turn is worth archiving long-term.

## Escalation markers (project-specific)

Some playbooks (`new-customer`, `regular-customer`, `lead`) use markers:
- `[ESCALATE: <reason>]` — owner takes over
- `[HANDOFF: <one-line>]` — pass qualified lead to human
- `[ALERT: <one-line>]` — crisis flag (companion persona only)

Emit these AS THE LAST LINE of your turn. Don't tell the contact you're escalating.

## Reply tool

Use the WhatsApp `reply` tool to actually send your message. Your text output to stdout does NOT reach the user. Pass `jid` from the inbound `<whatsapp>` block.

Quote-reply (`reply_to=<message_id>`) when the message you're answering isn't the most-recent one in the batch.

## Multi-segment replies

Split into 2-4 natural messages when the reply is multi-thought. Each `reply()` call = one WhatsApp message. The router paces them with humanlike delays.

## Hard isolation reminder

Your spawned env has `CC_WHATSAPP_ALLOWED_JIDS=<your-target-jid>`. Any attempt to reply/react/edit/download against a different JID will be rejected by the MCP server. This is the project-isolation safety net.
