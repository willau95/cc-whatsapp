#!/bin/bash
# Deep verification: every edit endpoint round-trips to disk.
# For each PUT/POST/DELETE, we:
#   1. perform the API call
#   2. GET the value back
#   3. inspect the on-disk file directly
#   4. assert all three match
#
# Uses a throwaway "deepprobe" project under ~/Projects/ so we never touch
# user's live projects. Cleans up at the end.

set -u

DASH=http://127.0.0.1:38500
PROBE_DIR=~/Projects/deepprobe
PROBE_ACCT=deepprobe

PASS=0
FAIL=0
FAILS=()
TOTAL=0

ok()   { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); FAILS+=("$1"); printf "  \033[31m✗\033[0m %s\n  %s\n" "$1" "$2"; }
hdr()  { printf "\n\033[1;34m── %s ──\033[0m\n" "$1"; }

cleanup() {
  hdr "Cleanup"
  rm -rf "$PROBE_DIR"
  /Users/mad-imac1/Projects/cc-whatsapp/bin/cc-whatsapp accounts remove "$PROBE_ACCT" >/dev/null 2>&1
  rm -rf ~/.wacli/accounts/"$PROBE_ACCT"
  echo "  removed $PROBE_DIR + wacli account"
}
trap cleanup EXIT

# Ensure dashboard alive
if ! curl -sS -o /dev/null "$DASH/api/projects"; then
  echo "Dashboard NOT reachable on $DASH — start it first"
  exit 1
fi

# ── 1. createProject ──
hdr "1. POST /api/projects (createProject)"
rm -rf "$PROBE_DIR"
/Users/mad-imac1/Projects/cc-whatsapp/bin/cc-whatsapp accounts remove "$PROBE_ACCT" >/dev/null 2>&1
rm -rf ~/.wacli/accounts/"$PROBE_ACCT"
CREATE=$(curl -sS -X POST "$DASH/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"parentDir\":\"$HOME/Projects\",\"name\":\"deepprobe\",\"account\":\"$PROBE_ACCT\",\"template\":\"eva\"}")
PID=$(echo "$CREATE" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('id',''))" 2>/dev/null)
[ -z "$PID" ] && { fail "create" "create returned no id: $CREATE"; exit 1; }
ok "create returned id"

# Verify project dir + config exist on disk
if [ -d "$PROBE_DIR/.claude/cc-whatsapp" ] && [ -f "$PROBE_DIR/.claude/cc-whatsapp/config.json" ]; then
  ok "project dir + config.json on disk"
else
  fail "project files on disk" "missing files"
fi
# Verify persona templates were copied
PERSONA_OK=true
for n in IDENTITY SOUL STYLE AGENTS MEMORY; do
  [ -f "$PROBE_DIR/.claude/cc-whatsapp/agent/$n.md" ] || PERSONA_OK=false
done
$PERSONA_OK && ok "persona files installed" || fail "persona files installed" "missing some .md"
# Verify playbooks installed
PB_COUNT=$(ls "$PROBE_DIR/.claude/cc-whatsapp/agent/playbooks" 2>/dev/null | wc -l | tr -d ' ')
[ "$PB_COUNT" -ge 5 ] && ok "playbooks installed ($PB_COUNT files)" || fail "playbooks installed" "only $PB_COUNT files"

# ── 2. PUT persona files ──
hdr "2. PUT /api/projects/:id/persona/*.md"
SENTINEL="DEEP-PROBE-PERSONA-$(date +%s)"
for n in IDENTITY SOUL STYLE AGENTS MEMORY; do
  curl -sS -X PUT "$DASH/api/projects/$PID/persona/$n.md" \
    -H 'Content-Type: text/plain' -d "$SENTINEL $n" >/dev/null
  DISK=$(cat "$PROBE_DIR/.claude/cc-whatsapp/agent/$n.md" 2>/dev/null)
  GOT=$(curl -sS "$DASH/api/projects/$PID/persona" | python3 -c "import json,sys; print(json.load(sys.stdin)['$n.md'])" 2>/dev/null)
  if [ "$DISK" = "$SENTINEL $n" ] && [ "$GOT" = "$SENTINEL $n" ]; then
    ok "persona/$n.md: API == GET == disk"
  else
    fail "persona/$n.md" "disk=[$DISK] got=[$GOT] want=[$SENTINEL $n]"
  fi
done

# ── 3. PUT tunables ──
hdr "3. PUT /api/projects/:id/tunables"
curl -sS -X PUT "$DASH/api/projects/$PID/tunables" \
  -H 'Content-Type: application/json' \
  -d '{"collect_window_ms":12345,"quote_reply_probability":0.77,"chat_model":"deeptest-model"}' >/dev/null
DISK_CW=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/tunables.json'))['collect_window_ms'])" 2>/dev/null)
GOT_CW=$(curl -sS "$DASH/api/projects/$PID/tunables" | python3 -c "import json,sys; print(json.load(sys.stdin)['collect_window_ms'])" 2>/dev/null)
[ "$DISK_CW" = "12345" ] && [ "$GOT_CW" = "12345" ] && ok "tunables.collect_window_ms persisted" || fail "tunables" "disk=$DISK_CW got=$GOT_CW"
DISK_QP=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/tunables.json'))['quote_reply_probability'])" 2>/dev/null)
[ "$DISK_QP" = "0.77" ] && ok "tunables.quote_reply_probability persisted" || fail "tunables.quote_reply_probability" "disk=$DISK_QP"
DISK_M=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/tunables.json'))['chat_model'])" 2>/dev/null)
[ "$DISK_M" = "deeptest-model" ] && ok "tunables.chat_model persisted" || fail "tunables.chat_model" "disk=$DISK_M"

# ── 4. PUT access ──
hdr "4. PUT /api/projects/:id/access"
curl -sS -X PUT "$DASH/api/projects/$PID/access" \
  -H 'Content-Type: application/json' \
  -d '{"allowFrom":["111@lid","222@s.whatsapp.net"],"disabled":true,"mode":"closed"}' >/dev/null
DISK_AC=$(cat "$PROBE_DIR/.claude/cc-whatsapp/access.json")
echo "$DISK_AC" | grep -q '"disabled": *true' && ok "access.disabled = true on disk" || fail "access.disabled" "$DISK_AC"
echo "$DISK_AC" | grep -q '"mode": *"closed"' && ok "access.mode = closed on disk" || fail "access.mode" "$DISK_AC"
echo "$DISK_AC" | grep -q '"111@lid"' && ok "access.allowFrom[0] on disk" || fail "access.allowFrom" "$DISK_AC"

# ── 5. PUT contact memory v2 (per subfile) ──
hdr "5. PUT /api/projects/:id/contacts-v2/:jid/:sub"
TEST_JID="999111222@lid"
for sub in card facts preferences voice timeline notes; do
  curl -sS -X PUT "$DASH/api/projects/$PID/contacts-v2/$TEST_JID/$sub" \
    -H 'Content-Type: text/plain' -d "MEMORY-V2-$sub-SENTINEL" >/dev/null
  FILE="$PROBE_DIR/.claude/cc-whatsapp/agent/contacts/$TEST_JID/$sub.md"
  DISK=$(cat "$FILE" 2>/dev/null)
  if [ "$DISK" = "MEMORY-V2-$sub-SENTINEL" ]; then
    ok "contacts-v2/$TEST_JID/$sub: written to disk"
  else
    fail "contacts-v2/$sub" "disk=[$DISK]"
  fi
done
GOT_CARD=$(curl -sS "$DASH/api/projects/$PID/contacts-v2/$TEST_JID" | python3 -c "import json,sys; print(json.load(sys.stdin)['card'])" 2>/dev/null)
[ "$GOT_CARD" = "MEMORY-V2-card-SENTINEL" ] && ok "contacts-v2 GET returns latest subfiles" || fail "contacts-v2 GET" "got=$GOT_CARD"

# ── 6. PUT extra MCPs ──
hdr "6. PUT /api/projects/:id/mcps"
curl -sS -X PUT "$DASH/api/projects/$PID/mcps" \
  -H 'Content-Type: application/json' \
  -d '{"mcpServers":{"testmcp":{"command":"echo","args":["hello"]}}}' >/dev/null
DISK_MCP=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/extra_mcps.json'))['mcpServers']['testmcp']['command'])" 2>/dev/null)
[ "$DISK_MCP" = "echo" ] && ok "extra_mcps.json on disk" || fail "extra_mcps" "disk=[$DISK_MCP]"

# ── 7. PUT owner-jid ──
hdr "7. PUT /api/projects/:id/owner-jid"
curl -sS -X PUT "$DASH/api/projects/$PID/owner-jid" \
  -H 'Content-Type: application/json' -d '{"ownerJid":"888@lid"}' >/dev/null
DISK_OJ=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/config.json')).get('ownerJid', ''))" 2>/dev/null)
[ "$DISK_OJ" = "888@lid" ] && ok "config.ownerJid on disk" || fail "ownerJid" "disk=[$DISK_OJ]"

# ── 8. dispatcher bindings ──
hdr "8. POST /api/projects/:id/dispatcher/bindings"
# Create a second project to bind to
curl -sS -X POST "$DASH/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"parentDir\":\"$HOME/Projects\",\"name\":\"deepprobe-target\",\"account\":\"deepprobe-target\",\"template\":\"eva\"}" > /tmp/.dp-create2
TARGET_PID=$(python3 -c "import json; print(json.load(open('/tmp/.dp-create2'))['id'])")
curl -sS -X POST "$DASH/api/projects/$PID/dispatcher/bindings" \
  -H 'Content-Type: application/json' \
  -d "{\"jid\":\"120363xxxabc@g.us\",\"targetProjectId\":\"$TARGET_PID\"}" >/dev/null
DISK_BIND=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/config.json')).get('bindings', {}).get('120363xxxabc@g.us', ''))" 2>/dev/null)
[[ "$DISK_BIND" == *deepprobe-target* ]] && ok "dispatcher.bindings written to config.json" || fail "dispatcher binding" "disk=[$DISK_BIND]"

# Verify GET reflects it
GET_BIND=$(curl -sS "$DASH/api/projects/$PID/dispatcher" | python3 -c "import json,sys; print(json.load(sys.stdin)['bindings'].get('120363xxxabc@g.us', ''))")
[[ "$GET_BIND" == *deepprobe-target* ]] && ok "GET /dispatcher reflects binding" || fail "GET dispatcher" "got=[$GET_BIND]"

# DELETE binding
curl -sS -X DELETE "$DASH/api/projects/$PID/dispatcher/bindings/120363xxxabc@g.us" >/dev/null
GONE=$(python3 -c "import json; print('120363xxxabc@g.us' in json.load(open('$PROBE_DIR/.claude/cc-whatsapp/config.json')).get('bindings', {}))" 2>/dev/null)
[ "$GONE" = "False" ] && ok "DELETE binding removed from disk" || fail "DELETE binding" "still present"

# PUT default project
curl -sS -X PUT "$DASH/api/projects/$PID/dispatcher/default" \
  -H 'Content-Type: application/json' \
  -d "{\"targetProjectId\":\"$TARGET_PID\"}" >/dev/null
DISK_DEF=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/config.json')).get('defaultProject', ''))" 2>/dev/null)
[[ "$DISK_DEF" == *deepprobe-target* ]] && ok "dispatcher.defaultProject on disk" || fail "default project" "disk=[$DISK_DEF]"

# ── 9. PUT playbook ──
hdr "9. PUT /api/projects/:id/playbooks/:name"
curl -sS -X PUT "$DASH/api/projects/$PID/playbooks/new-stranger" \
  -H 'Content-Type: text/plain' -d "# OVERRIDDEN PLAYBOOK CONTENT" >/dev/null
DISK_PB=$(cat "$PROBE_DIR/.claude/cc-whatsapp/agent/playbooks/new-stranger.md")
[ "$DISK_PB" = "# OVERRIDDEN PLAYBOOK CONTENT" ] && ok "playbook saved to disk" || fail "playbook" "disk=[$DISK_PB]"

# ── 10. apply-template ──
hdr "10. POST /api/projects/:id/persona/apply-template"
curl -sS -X POST "$DASH/api/projects/$PID/persona/apply-template" \
  -H 'Content-Type: application/json' -d '{"template":"customer-support"}' >/dev/null
DISK_IDENT=$(cat "$PROBE_DIR/.claude/cc-whatsapp/agent/IDENTITY.md")
echo "$DISK_IDENT" | grep -q 'customer support agent' && ok "apply-template wrote customer-support to IDENTITY.md" || fail "apply-template" "IDENTITY content unexpected"

# ── 11. survive restart? ──
hdr "11. SURVIVES dashboard restart"
DASH_PID=$(lsof -iTCP:38500 -sTCP:LISTEN -t)
kill -9 $DASH_PID 2>/dev/null
sleep 1
CC_WHATSAPP_DASHBOARD_AUTO_OPEN=0 bun /Users/mad-imac1/Projects/cc-whatsapp/plugin/dashboard.ts >/tmp/dash-restart.log 2>&1 &
sleep 2.5
NEW_OJ=$(curl -sS "$DASH/api/projects/$PID/owner-jid" | python3 -c "import json,sys; print(json.load(sys.stdin)['ownerJid'])")
[ "$NEW_OJ" = "888@lid" ] && ok "ownerJid survived dashboard restart" || fail "post-restart" "got=$NEW_OJ"

# ── 12. DELETE project ──
hdr "12. DELETE /api/projects/:id (target project)"
curl -sS -X DELETE "$DASH/api/projects/$TARGET_PID" >/dev/null
GONE=$([ -d "$HOME/Projects/deepprobe-target/.claude/cc-whatsapp" ] && echo "still" || echo "gone")
[ "$GONE" = "gone" ] && ok "project state dir removed from disk" || fail "DELETE project" "$GONE"
rm -rf "$HOME/Projects/deepprobe-target"
/Users/mad-imac1/Projects/cc-whatsapp/bin/cc-whatsapp accounts remove deepprobe-target >/dev/null 2>&1
rm -rf ~/.wacli/accounts/deepprobe-target

# ── 13. link-existing (drops cc-whatsapp into existing dir without writing persona) ──
hdr "13. POST /api/projects/link-existing (no overwrite + correct mode)"
LINK_DIR=/tmp/link-existing-probe
rm -rf "$LINK_DIR"; mkdir -p "$LINK_DIR/agent"
echo "USER-CUSTOM-IDENTITY" > "$LINK_DIR/agent/IDENTITY.md"   # pre-existing file we MUST NOT overwrite
curl -sS -X POST "$DASH/api/projects/link-existing" \
  -H 'Content-Type: application/json' \
  -d "{\"projectDir\":\"$LINK_DIR\",\"account\":\"linkprobe\"}" >/dev/null
# Verify cc-whatsapp installed
[ -f "$LINK_DIR/.claude/cc-whatsapp/config.json" ] && ok "linkExisting wrote config.json" || fail "linkExisting" "no config"
# Verify our pre-existing file is untouched
ORIG=$(cat "$LINK_DIR/agent/IDENTITY.md")
[ "$ORIG" = "USER-CUSTOM-IDENTITY" ] && ok "linkExisting did NOT overwrite user's pre-existing agent/IDENTITY.md" || fail "link no-overwrite" "got=[$ORIG]"
# Verify mode field is terminal-extension
LINK_MODE=$(python3 -c "import json; print(json.load(open('$LINK_DIR/.claude/cc-whatsapp/config.json')).get('mode',''))")
[ "$LINK_MODE" = "terminal-extension" ] && ok "linkExisting wrote mode=terminal-extension" || fail "link mode" "got=[$LINK_MODE]"
# Verify tunables are aggressive zero-delay
LINK_CW=$(python3 -c "import json; print(json.load(open('$LINK_DIR/.claude/cc-whatsapp/tunables.json')).get('collect_window_ms', ''))")
[ "$LINK_CW" = "0" ] && ok "linkExisting set collect_window_ms=0 (instant)" || fail "link tunables" "collect_window=[$LINK_CW]"
LINK_TYP=$(python3 -c "import json; print(json.load(open('$LINK_DIR/.claude/cc-whatsapp/tunables.json')).get('enable_typing_indicator', ''))")
[ "$LINK_TYP" = "False" ] && ok "linkExisting set enable_typing_indicator=false" || fail "link tunables typing" "got=[$LINK_TYP]"
# Cleanup
rm -rf "$LINK_DIR"
/Users/mad-imac1/Projects/cc-whatsapp/bin/cc-whatsapp accounts remove linkprobe >/dev/null 2>&1
rm -rf ~/.wacli/accounts/linkprobe

# ── 14. mode toggle ──
hdr "14. PUT /api/projects/:id/mode"
curl -sS -X PUT "$DASH/api/projects/$PID/mode" \
  -H 'Content-Type: application/json' -d '{"mode":"terminal-extension"}' >/dev/null
DISK_MODE=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/config.json')).get('mode',''))")
[ "$DISK_MODE" = "terminal-extension" ] && ok "mode toggle to terminal-extension persisted" || fail "mode toggle" "got=[$DISK_MODE]"
curl -sS -X PUT "$DASH/api/projects/$PID/mode" \
  -H 'Content-Type: application/json' -d '{"mode":"bot"}' >/dev/null
DISK_MODE=$(python3 -c "import json; print(json.load(open('$PROBE_DIR/.claude/cc-whatsapp/config.json')).get('mode',''))")
[ "$DISK_MODE" = "bot" ] && ok "mode toggle back to bot persisted" || fail "mode toggle back" "got=[$DISK_MODE]"
# Verify invalid mode rejected
INVALID=$(curl -sS -X PUT "$DASH/api/projects/$PID/mode" \
  -H 'Content-Type: application/json' -d '{"mode":"garbage"}')
echo "$INVALID" | grep -q '"ok":false' && ok "invalid mode rejected" || fail "invalid mode" "$INVALID"

# ── Summary ──
echo ""
echo "════════════════════════════════════════════"
printf "  Total: %d   \033[32mPass: %d\033[0m   \033[31mFail: %d\033[0m\n" $TOTAL $PASS $FAIL
echo "════════════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failures:"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All edits round-tripped to disk ✓"
