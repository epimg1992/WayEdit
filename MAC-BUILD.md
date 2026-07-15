# Building Route View (WayEdit) for macOS

Everything is staged — the build itself is **one command on a Mac**. It produces an
unsigned `.dmg` + `.zip` (no Apple Developer account needed).

## 1. Get the project onto the Mac

Copy the whole `wayedit` folder **except** these (they're Windows-only or regenerated):

- `node_modules/` (Windows binaries — `npm install` on the Mac fetches macOS ones)
- `dist-build/` (old build output)
- `renderer/vendor/` (Cesium — re-vendored by `npm install`)

A ready-made source zip with those excluded can be built with:
`git archive` (if this ever becomes a repo) or just zip the folder minus those dirs.

## 2. Install Node 18+ on the Mac

From https://nodejs.org (LTS). Verify: `node -v`.

## 3. Build

```bash
cd wayedit
chmod +x build-mac.sh
./build-mac.sh
```

Or, if using Claude Code on the Mac, just say: **"run build-mac.sh"** — the project's
`CLAUDE.md` gives it full context.

The script checks Node, runs `npm install` (vendors Cesium + downloads the macOS
Electron), regenerates a 1024px Mac icon, and runs `electron-builder --mac`.
Artifacts land in `dist-build/`:

- `WayEdit-<version>-arm64.dmg` (Apple Silicon) and `x64` (Intel), plus `.zip`s.
- Apple-Silicon-only build is faster: drop `"x64"` from `build.mac.target[].arch`
  in `package.json`.

## 4. First launch (unsigned app)

Gatekeeper blocks unsigned apps once. Either **right-click the app → Open → Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/WayEdit.app"
```

## Day-to-day on the Mac (no packaging)

`npm install` once, then `npm start` runs the app directly — same as Windows.
Mac-native menu/shortcuts are already handled in `src/main.js`.

## No Mac available?

Alternative: push the project to a GitHub repo and build on a free macOS GitHub
Actions runner (`runs-on: macos-14`, steps: checkout → setup-node → `npm install` →
`npm run dist:mac` → upload `dist-build/*.dmg` as an artifact). Ask Claude Code to
stage the workflow file if needed.
