#!/usr/bin/env bash
#
# build-mac.sh — build the macOS app (WayEdit / Route View) on a Mac.
#
# Usage (from the project folder, on a Mac):
#   chmod +x build-mac.sh && ./build-mac.sh
# or just tell Claude Code: "run build-mac.sh".
#
# Produces an UNSIGNED .dmg and .zip in dist-build/ (no Apple Developer account needed).
# The macOS-specific app menu / keyboard shortcuts are already baked into src/main.js.
#
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Checking Node…"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node $NODE_MAJOR detected; need Node 18+." >&2
  exit 1
fi
echo "    Node $(node -v) OK"

echo "==> Installing dependencies (vendors Cesium, bundles renderer, downloads macOS Electron)…"
npm install

echo "==> Generating a high-res macOS icon (assets/icon-mac.png, 1024×1024)…"
node scripts/make-icon.js 1024 icon-mac.png

echo "==> Building the macOS app (.dmg + .zip, unsigned)…"
npm run dist:mac

echo
echo "==> Done. Artifacts are in: dist-build/"
ls -1 dist-build/*.dmg dist-build/*.zip 2>/dev/null || true
cat <<'NOTE'

First launch (unsigned app): macOS Gatekeeper will block it the first time.
Either right-click the app -> Open -> Open, or run:
  xattr -dr com.apple.quarantine "/Applications/WayEdit.app"

Tip: for a smaller/faster build on Apple Silicon you can drop "x64" from the
"mac" -> "target" arch arrays in package.json (keep "arm64").
NOTE
