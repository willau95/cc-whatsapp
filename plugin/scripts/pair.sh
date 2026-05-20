#!/bin/zsh
# Pair a WhatsApp number for a given cc-whatsapp account.
# Usage: pair.sh <account-name>
# Renders QR to /tmp/cc-wa-qr.png, opens Preview, runs cc-whatsapp accounts add.

set -u
ACCOUNT="${1:?usage: pair.sh <account-name>}"

SCRIPT_DIR="${0:A:h}"
PLUGIN_ROOT="${SCRIPT_DIR}/.."
REPO_ROOT="${PLUGIN_ROOT}/.."
CC_BIN="${CC_WHATSAPP_BIN:-${REPO_ROOT}/bin/cc-whatsapp}"

if [[ ! -x "$CC_BIN" ]]; then
  echo "✗ binary not found at $CC_BIN — run 'make build' from $REPO_ROOT" >&2
  exit 1
fi

# Ensure qrcode npm dep present in plugin
cd "$PLUGIN_ROOT" && bun install --no-summary >/dev/null 2>&1

# QR renderer (tiny inline bun script)
RENDER_SCRIPT="/tmp/cc-wa-qr-render.ts"
cat > "$RENDER_SCRIPT" <<'TSEOF'
import QRCode from 'qrcode'
import { spawn } from 'child_process'
import { statSync } from 'fs'
const OUT = '/tmp/cc-wa-qr.png'
let opened = false, last = '', n = 0
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', async chunk => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n'); if (nl === -1) break
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (/^2@[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+/.test(line) && line !== last) {
      last = line; n++
      try {
        await QRCode.toFile(OUT, line, { width: 600, margin: 2, errorCorrectionLevel: 'M' })
        process.stderr.write(`[qr #${n}] ${OUT} (${statSync(OUT).size}B)\n`)
        if (!opened) { opened = true; spawn('open', [OUT], { detached: true }).unref() }
      } catch (e) { process.stderr.write(`render fail: ${e}\n`) }
    } else if (line.toLowerCase().match(/logged in|paired|authenticated/)) {
      process.stderr.write(`[auth ok] ${line}\n`)
    } else if (line) {
      process.stderr.write(`[cc-whatsapp] ${line}\n`)
    }
  }
})
TSEOF

echo "→ pairing account '$ACCOUNT' — scan the QR that pops up in Preview"
exec "$CC_BIN" accounts add "$ACCOUNT" --qr-format text 2>&1 | bun "$RENDER_SCRIPT"
