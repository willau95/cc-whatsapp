#!/bin/bash
# cc-whatsapp — one-line installer for macOS (Apple Silicon).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/willau95/cc-whatsapp/main/install.sh | bash
#
# What this does (zero manual steps after):
#   1. Installs Bun, nvm, Node 22, and Claude Code if missing.
#   2. Clones the cc-whatsapp repo to ~/.cc-whatsapp/repo/.
#   3. Downloads the pre-built WhatsApp daemon binary from GitHub Releases.
#   4. Installs plugin dependencies.
#   5. Registers a LaunchAgent so the dashboard auto-starts on every login
#      and auto-restarts if it ever dies.
#   6. Starts the dashboard now and opens it in your browser.
#
# After install:
#   - Dashboard runs forever at http://localhost:38500 (auto-restart on reboot).
#   - All state lives under ~/.cc-whatsapp/projects/ — never inside project folders.
#   - No macOS TCC prompts.

set -euo pipefail

# ───────────────────────────────────────────────────────────────────────────
# Config
# ───────────────────────────────────────────────────────────────────────────
CC_HOME="${HOME}/.cc-whatsapp"
REPO_URL="https://github.com/willau95/cc-whatsapp.git"
REPO_DIR="${CC_HOME}/repo"
BIN_DIR="${REPO_DIR}/bin"
BIN_PATH="${BIN_DIR}/cc-whatsapp"
RELEASE_TAG="v0.2.0"
NODE_VERSION="22"
LAUNCH_LABEL="com.cc-whatsapp.dashboard"
LAUNCH_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
WRAPPER="${CC_HOME}/launchd-wrapper.sh"
LOG_FILE="${CC_HOME}/dashboard.log"
DASH_PORT=38500

# ───────────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────────────
c()   { printf "\033[1;34m▶\033[0m %s\n" "$1"; }
ok()  { printf "\033[32m✓\033[0m %s\n" "$1"; }
warn(){ printf "\033[33m!\033[0m %s\n" "$1"; }
err() { printf "\033[31m✗\033[0m %s\n" "$1" >&2; exit 1; }

# ───────────────────────────────────────────────────────────────────────────
# Preflight: macOS + arch
# ───────────────────────────────────────────────────────────────────────────
c "cc-whatsapp installer — one line, then nothing else."

[ "$(uname -s)" = "Darwin" ] || err "macOS only. Detected: $(uname -s)"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET="cc-whatsapp-darwin-arm64" ;;
  x86_64)
    err "Intel Macs not supported yet. Open an issue at https://github.com/willau95/cc-whatsapp/issues"
    ;;
  *) err "Unsupported arch: $ARCH" ;;
esac

command -v curl >/dev/null 2>&1 || err "curl missing — should be on every Mac."
command -v git  >/dev/null 2>&1 || err "git missing. Run: xcode-select --install"
ok "macOS Apple Silicon — git + curl present."

mkdir -p "$CC_HOME"

# ───────────────────────────────────────────────────────────────────────────
# 1. Bun
# ───────────────────────────────────────────────────────────────────────────
if [ ! -x "${HOME}/.bun/bin/bun" ] && ! command -v bun >/dev/null 2>&1; then
  c "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || err "Bun install failed."
fi
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"
command -v bun >/dev/null 2>&1 || err "Bun not on PATH after install."
ok "Bun: $(bun --version 2>/dev/null)"

# ───────────────────────────────────────────────────────────────────────────
# 2. nvm + Node 22
# ───────────────────────────────────────────────────────────────────────────
export NVM_DIR="${HOME}/.nvm"
if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
  c "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >/dev/null 2>&1 || err "nvm install failed."
fi
# shellcheck disable=SC1091
. "${NVM_DIR}/nvm.sh"

if ! nvm ls "${NODE_VERSION}" >/dev/null 2>&1; then
  c "Installing Node ${NODE_VERSION} via nvm..."
  nvm install "${NODE_VERSION}" --no-progress >/dev/null 2>&1 || err "Node ${NODE_VERSION} install failed."
fi
# --delete-prefix avoids any stale npm_config_prefix from ~/.npmrc
nvm use --delete-prefix "${NODE_VERSION}" >/dev/null 2>&1 || nvm use "${NODE_VERSION}" >/dev/null 2>&1
ok "Node: $(node -v) — npm: $(npm -v)"

# ───────────────────────────────────────────────────────────────────────────
# 3. Claude Code CLI
# ───────────────────────────────────────────────────────────────────────────
if ! command -v claude >/dev/null 2>&1; then
  c "Installing @anthropic-ai/claude-code (Claude Code CLI)..."
  npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 || err "claude-code install failed."
fi
ok "Claude Code: $(claude --version 2>/dev/null | head -1)"

# ───────────────────────────────────────────────────────────────────────────
# 4. Clone / update repo
# ───────────────────────────────────────────────────────────────────────────
if [ ! -d "${REPO_DIR}/.git" ]; then
  c "Cloning ${REPO_URL}..."
  rm -rf "${REPO_DIR}"
  git clone --depth 1 "${REPO_URL}" "${REPO_DIR}" >/dev/null 2>&1 || err "Clone failed."
else
  c "Updating repo..."
  (cd "${REPO_DIR}" && git pull --ff-only >/dev/null 2>&1) || warn "  pull failed — using existing checkout."
fi
ok "Repo at ${REPO_DIR}"

# ───────────────────────────────────────────────────────────────────────────
# 5. Pre-built binary from GitHub Release (no Go required)
# ───────────────────────────────────────────────────────────────────────────
mkdir -p "${BIN_DIR}"
c "Downloading cc-whatsapp daemon (${RELEASE_TAG} / ${ASSET})..."
curl -fsSL "https://github.com/willau95/cc-whatsapp/releases/download/${RELEASE_TAG}/${ASSET}" -o "${BIN_PATH}" \
  || err "Binary download failed."
chmod +x "${BIN_PATH}"
ok "Binary: ${BIN_PATH}"

# ───────────────────────────────────────────────────────────────────────────
# 6. Plugin deps
# ───────────────────────────────────────────────────────────────────────────
c "Installing plugin dependencies..."
(cd "${REPO_DIR}/plugin" && bun install --no-summary >/dev/null 2>&1) || err "bun install failed."
ok "Plugin deps installed."

# ───────────────────────────────────────────────────────────────────────────
# 7. (Optional) migrate legacy per-project state
# ───────────────────────────────────────────────────────────────────────────
if [ -f "${REPO_DIR}/plugin/migrate-state-to-central.ts" ]; then
  bun "${REPO_DIR}/plugin/migrate-state-to-central.ts" >/dev/null 2>&1 || true
fi

# ───────────────────────────────────────────────────────────────────────────
# 8. LaunchAgent: auto-start on every login, auto-restart on crash
# ───────────────────────────────────────────────────────────────────────────
c "Registering LaunchAgent for auto-start..."

# Wrapper script — plist calls this; this sources nvm + sets PATH.
cat > "${WRAPPER}" <<'WRAP'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null 2>&1 || true
export PATH="$HOME/.bun/bin:$PATH"
export CC_WHATSAPP_DASHBOARD_AUTO_OPEN=0
exec bun "$HOME/.cc-whatsapp/repo/plugin/dashboard.ts"
WRAP
chmod +x "${WRAPPER}"

mkdir -p "${HOME}/Library/LaunchAgents"

# Plist — substitute $HOME at install time (launchd does NOT expand env vars).
cat > "${LAUNCH_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${WRAPPER}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
PLIST

# Unload any previous instance (idempotent), then load fresh.
GUI="gui/$(id -u)"
launchctl bootout "${GUI}/${LAUNCH_LABEL}" 2>/dev/null || true
# Also kill any orphan dashboard listening on the port.
LSOF_PID="$(lsof -iTCP:${DASH_PORT} -sTCP:LISTEN -t 2>/dev/null || true)"
[ -n "${LSOF_PID}" ] && kill -9 ${LSOF_PID} 2>/dev/null || true
sleep 1

launchctl bootstrap "${GUI}" "${LAUNCH_PLIST}" 2>/dev/null \
  || err "launchctl bootstrap failed. Check ${LAUNCH_PLIST}"
launchctl enable "${GUI}/${LAUNCH_LABEL}" 2>/dev/null || true
ok "LaunchAgent registered — dashboard will auto-start on every login."

# ───────────────────────────────────────────────────────────────────────────
# 9. Wait for dashboard to be ready, then open browser
# ───────────────────────────────────────────────────────────────────────────
c "Waiting for dashboard to come up on port ${DASH_PORT}..."
TRIES=0
until curl -sS -o /dev/null -w "" "http://127.0.0.1:${DASH_PORT}/api/projects" 2>/dev/null; do
  TRIES=$((TRIES+1))
  if [ "$TRIES" -gt 30 ]; then
    err "Dashboard didn't start within 30s. See ${LOG_FILE}"
  fi
  sleep 1
done
ok "Dashboard live at http://localhost:${DASH_PORT}"

# Open in default browser (one-time — launchd reload won't re-open).
open "http://localhost:${DASH_PORT}" 2>/dev/null || true

echo ""
printf "\033[1;32m═════════════════════════════════════════════════════════════════\033[0m\n"
printf "\033[1;32m  cc-whatsapp is installed and running.\033[0m\n"
printf "\033[1;32m═════════════════════════════════════════════════════════════════\033[0m\n"
echo ""
echo "  Dashboard:  http://localhost:${DASH_PORT}  (already open in browser)"
echo "  Logs:       tail -f ${LOG_FILE}"
echo ""
echo "  Auto-start: enabled via LaunchAgent (${LAUNCH_LABEL})."
echo "              Reboot your Mac — dashboard comes back automatically."
echo ""
echo "  Next: click 'Create new bot' and scan the QR with your WhatsApp."
echo ""
echo "  To stop forever:   launchctl bootout gui/\$(id -u)/${LAUNCH_LABEL}"
echo "  To uninstall:      rm -rf ${CC_HOME} ${LAUNCH_PLIST}"
echo ""
