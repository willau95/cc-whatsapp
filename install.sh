#!/bin/bash
# cc-whatsapp one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/willau95/cc-whatsapp/main/install.sh | bash
#
# Installs:
#   - Bun (if missing)
#   - cc-whatsapp repo to ~/.cc-whatsapp/repo/
#   - Plugin dependencies (qrcode, MCP SDK, etc.)
#   - Builds the Go binary (server/cc-whatsapp)
#
# All state lives at ~/.cc-whatsapp/projects/<id>/ — zero macOS TCC prompts
# even if you later link projects from Desktop/Documents/iCloud.

set -euo pipefail

CC_HOME="${HOME}/.cc-whatsapp"
REPO_URL="https://github.com/willau95/cc-whatsapp.git"
REPO_DIR="${CC_HOME}/repo"

c() { printf "\033[1;34m▶\033[0m %s\n" "$1"; }
ok() { printf "\033[32m✓\033[0m %s\n" "$1"; }
err() { printf "\033[31m✗\033[0m %s\n" "$1" >&2; exit 1; }

c "cc-whatsapp installer"

# 1. Check / install bun
if ! command -v bun >/dev/null 2>&1; then
  c "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # Make it available in this script
  export BUN_INSTALL="${HOME}/.bun"
  export PATH="${BUN_INSTALL}/bin:${PATH}"
  command -v bun >/dev/null 2>&1 || err "Bun installation failed — see https://bun.sh"
  ok "Bun installed at ${BUN_INSTALL}/bin/bun"
else
  ok "Bun already installed: $(command -v bun)"
fi

# 2. Check git
command -v git >/dev/null 2>&1 || err "git is required — install from https://git-scm.com"
ok "git: $(command -v git)"

# 3. Check Go (for building the cc-whatsapp binary)
if ! command -v go >/dev/null 2>&1; then
  c "Note: Go not found — needed to build the cc-whatsapp binary."
  c "      Install: brew install go    (or https://go.dev/dl/)"
  c "      Continuing — plugin will still install, just no built binary."
  HAS_GO=0
else
  ok "Go: $(go version 2>&1 | head -1)"
  HAS_GO=1
fi

# 4. Clone / update repo
mkdir -p "${CC_HOME}"
if [ ! -d "${REPO_DIR}" ]; then
  c "Cloning ${REPO_URL} → ${REPO_DIR}"
  git clone --depth 1 "${REPO_URL}" "${REPO_DIR}"
  ok "Cloned"
else
  c "Updating existing checkout at ${REPO_DIR}"
  (cd "${REPO_DIR}" && git pull --ff-only) || c "  (pull failed — continuing with existing checkout)"
  ok "Up to date"
fi

# 5. Install plugin npm deps
c "Installing plugin dependencies via bun..."
(cd "${REPO_DIR}/plugin" && bun install --no-summary)
ok "Plugin dependencies installed"

# 6. Build Go binary
if [ "${HAS_GO}" = "1" ]; then
  c "Building cc-whatsapp binary..."
  if [ -f "${REPO_DIR}/server/Makefile" ]; then
    (cd "${REPO_DIR}/server" && make build 2>&1 | tail -5) && ok "Binary built at ${REPO_DIR}/bin/cc-whatsapp" || c "  Build failed — see ${REPO_DIR}/server/Makefile"
  else
    c "  No Makefile found — manually run: cd ${REPO_DIR}/server && go build -o ../bin/cc-whatsapp ./cmd/cc-whatsapp"
  fi
fi

# 7. Migrate any legacy state from old <project>/.claude/cc-whatsapp/ layout
if [ -x "${REPO_DIR}/plugin/migrate-state-to-central.ts" ] || [ -f "${REPO_DIR}/plugin/migrate-state-to-central.ts" ]; then
  c "Checking for legacy state to migrate..."
  bun "${REPO_DIR}/plugin/migrate-state-to-central.ts" 2>&1 | sed 's/^/  /'
fi

# 8. Done — instructions
echo ""
c "Installed."
echo ""
echo "  Start the dashboard:"
echo "    bun ${REPO_DIR}/plugin/dashboard.ts"
echo ""
echo "  Then open:"
echo "    http://localhost:38500"
echo ""
echo "  First-time WhatsApp setup:"
echo "    1. Click 'Create new bot' (top-level Projects tab)"
echo "    2. Pick a name + persona template"
echo "    3. Scan the QR with your WhatsApp"
echo "    4. Done"
echo ""
echo "  All state lives under ${CC_HOME}/projects/ — never inside your project folders."
echo "  No macOS TCC prompts needed, no Full Disk Access required."
