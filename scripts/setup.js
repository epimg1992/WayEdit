'use strict';
/*
 * Runs on `npm install` (postinstall) and `npm run build:renderer`.
 *   1. Copies Cesium's built assets into renderer/vendor/cesium so the app
 *      runs fully offline (no CDN).
 *   2. Bundles renderer/app.js (+ the shared kmz engine, jszip, xmldom) into
 *      renderer/app.bundle.js for the browser context.
 *
 * Pass --bundle-only to skip the Cesium copy (faster rebuilds during dev).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bundleOnly = process.argv.includes('--bundle-only');

function vendorCesium() {
  const src = path.join(root, 'node_modules', 'cesium', 'Build', 'Cesium');
  const dest = path.join(root, 'renderer', 'vendor', 'cesium');
  if (!fs.existsSync(src)) {
    console.warn('[setup] Cesium build not found yet — run `npm install` first. Skipping copy.');
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log('[setup] Vendored Cesium ->', path.relative(root, dest));
}

function bundleRenderer() {
  let esbuild;
  try { esbuild = require('esbuild'); }
  catch { console.warn('[setup] esbuild not installed — skipping bundle.'); return; }
  esbuild.buildSync({
    entryPoints: [path.join(root, 'renderer', 'app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: path.join(root, 'renderer', 'app.bundle.js'),
    logLevel: 'info',
    // Cesium is provided as a global via <script>, not bundled.
    external: ['cesium'],
  });
  console.log('[setup] Bundled renderer -> renderer/app.bundle.js');
}

if (!bundleOnly) vendorCesium();
bundleRenderer();
