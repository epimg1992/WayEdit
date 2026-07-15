# WayEdit

An offline Windows 11 desktop app for editing DJI FlightHub 2 routes (KMZ /
WPML) against the 3D model you already built in FlightHub, reviewing the photos
from your last flown mission alongside the waypoints, and re-exporting a
FlightHub-compatible KMZ — all with no connectivity.

---

## The spec this was built from

Your request, tightened into a build spec:

> Build an offline Windows 11 desktop application that replicates DJI FlightHub
> 2's route-editing capability. It must:
>
> 1. **Open a route KMZ** exported from FlightHub 2 and parse the full WPML
>    structure without losing any field on re-export.
> 2. **Load the georeferenced 3D model** exported from FlightHub for that site
>    and render it in a 3D view with the waypoints overlaid in their real-world
>    positions.
> 3. **Load the photo set from the most recent mission** flown on that route and
>    match each photo to the waypoint that captured it, shown in a side panel.
> 4. **Edit every per-waypoint parameter FlightHub exposes** — height, heading
>    (yaw), gimbal pitch, speed, camera zoom (focal length), and active lens
>    (wide / zoom / IR) — per waypoint or applied in bulk.
> 5. **Re-export a KMZ that FlightHub 2 accepts**: WPML 1.0.6, `wpmz/` archive
>    layout preserved, route-name character rules enforced, both `template.kml`
>    and `waylines.wpml` kept in sync, and every untouched element preserved
>    byte-for-byte.

The guiding implementation rule is **edit the XML DOM in place** — never
regenerate the route from a partial in-memory model. That is what guarantees a
FlightHub-clean round trip: anything WayEdit doesn't explicitly touch comes back
out exactly as DJI wrote it.

---

## Requirements

- Windows 11 (x64)
- [Node.js 18+](https://nodejs.org) (LTS recommended), which includes npm
- An internet connection **for the one-time `npm install` only** — once built,
  the app runs fully offline. Cesium is vendored into the app at install time,
  not loaded from a CDN.

## Install / run / build

From the project folder, in a terminal (PowerShell or Command Prompt):

```powershell
npm install        # downloads deps, vendors Cesium locally, bundles the renderer
npm start          # launches the app in development
npm run dist       # builds a Windows installer (.exe) + portable .exe
```

- `npm start` runs WayEdit directly — use this to try it.
- `npm run dist` produces installers in `dist-build/`: an NSIS installer
  (choose your install directory) and a standalone portable `.exe`.
- `npm test` runs the KMZ round-trip engine test (no GUI needed).

> If `npm install` is interrupted, delete `node_modules` and
> `package-lock.json` and run it again. The `postinstall` step both copies
> Cesium into `renderer/vendor/cesium` and bundles `renderer/app.js`; if you
> ever edit renderer code, re-run `npm run build:renderer`.

---

## Using it

1. **Open Route** — pick a route `.kmz` exported from FlightHub 2. The waypoint
   table fills in and the path draws in the 3D view.
2. **Open Model** — pick the folder containing the 3D model you exported from
   FlightHub. WayEdit scans the folder (up to 3 levels) and auto-detects the
   format (see assumptions below). The model loads georeferenced, with the
   waypoints sitting in it.
3. **Open Photos** — pick the folder of images from your most recent flight.
   Each photo is matched to a waypoint and shown in the right-hand strip; click
   one for a full-resolution lightbox. The detected lens band (wide / zoom / IR)
   is read from the DJI filename suffix.
4. **Edit** — select a waypoint and change height, heading/yaw, gimbal pitch,
   speed, zoom focal length, and lenses in the inspector. "Apply to all" pushes
   a height / gimbal / focal / lens value across every waypoint.
5. **Export** — set a route name (rules enforced) and export. WayEdit writes a
   FlightHub-compatible KMZ.

The **height-align slider** in the overlay lets you nudge the waypoint altitudes
visually against the model surface, to reconcile the relative-vs-absolute height
datum (see assumptions). The **satellite imagery toggle** is the only thing in
the app that would use the network — leave it off to stay fully offline.

---

## What is verified vs. what needs your machine

This was developed in a headless Linux environment that can't run a Windows GUI,
launch Electron, or render Cesium. So the split is:

**Verified here**

- The **KMZ / WPML engine** (`src/kmz.js`) — the highest-risk piece. An
  automated test (`test/kmz.test.js`) builds a realistic 2-waypoint DJI KMZ,
  edits every supported parameter, re-zips, re-parses, and asserts:
  - every edited value persisted,
  - `template.kml` and `waylines.wpml` stayed in sync,
  - mission config, turn params, drone info, `res/` files, and untouched
    waypoints were preserved losslessly,
  - route-name validation rejects DJI's forbidden characters.
  - **Result: 7/7 checks pass.**
- The **renderer bundles cleanly** — `renderer/app.js` plus the engine compile
  through esbuild with no syntax or resolution errors.

**Needs your Windows machine to exercise**

- The Electron shell (window, file dialogs, IPC, the `appfile://` local file
  server) — written but not launched here.
- The Cesium 3D view (model loading, waypoint rendering, camera).
- EXIF reading of your actual photos (`exifr`).

None of these are unusual integrations, but they should be tried on real data on
your machine; that's what `npm start` is for.

---

## Two assumptions to confirm (most important: the 3D format)

I had to make two judgment calls without your sample files. Both are handled
flexibly, but if either is wrong it's a quick fix:

1. **3D model export format.** I don't have a confirmed sample of what FlightHub
   2 hands you when you "download the 3D map," so WayEdit auto-detects, in
   priority order: a 3D Tiles `tileset.json`, then `.glb` / `.gltf`, then
   `.obj`. If FlightHub gives you something else (e.g. a different tiles layout,
   an OSGB/B3DM pyramid, or a bare point cloud), tell me the actual format /
   folder structure and I'll wire it in directly.

2. **Photo → waypoint matching.** WayEdit first tries each photo's **EXIF GPS**
   and assigns it to the nearest waypoint (haversine). If photos lack GPS, it
   falls back to **capture-time order** across the photo-taking waypoints. If
   your mission images carry a more reliable link (e.g. a waypoint index encoded
   in the filename or a sidecar), point me at an example and I'll match on that
   instead.

The **height datum** is the other ambiguity: waypoint heights in WPML can be
relative to takeoff while the model is in absolute/ellipsoidal height. The
align slider is the manual reconciliation; if you know the exact datum
relationship for your sites I can make it automatic.

---

## FlightHub 2 compatibility notes

- **WPML namespace 1.0.6.**
- Both `wpmz/template.kml` and `wpmz/waylines.wpml` are edited in sync — every
  setter touches both documents.
- The `wpmz/` archive prefix and any `res/` resources are preserved on
  re-export; the original zip entries are kept and only the XML you changed is
  rewritten.
- Route-name validation forbids `< > : " / | ? * . _ \` (hyphens are safe).
- Lossless: untouched elements survive byte-for-byte because edits are made to
  the parsed DOM in place rather than regenerated.

## Editable parameters

Per waypoint, and most via "apply to all":

| Parameter      | WPML target |
|----------------|-------------|
| Height         | `executeHeight` (waylines) + `height` / `ellipsoidHeight` (template) |
| Speed          | `waypointSpeed` |
| Heading (yaw)  | `waypointHeadingParam` (mode + angle; sets `headingAngleEnable`) |
| Gimbal pitch   | `gimbalRotate` action `gimbalPitchRotateAngle` (fallback `gimbalPitchAngle`) |
| Zoom           | zoom action `focalLength` |
| Lens (W/Z/IR)  | `takePhoto` `payloadLensIndex` (comma list) |

---

## Project layout

```
src/kmz.js        WPML engine (runs in Node and in the browser via esbuild)
src/main.js       Electron main process (windows, dialogs, IPC, appfile://)
src/preload.js    contextBridge API exposed to the renderer
renderer/         UI: index.html, app.js, style.css (3-pane GCS layout)
scripts/setup.js  postinstall: vendor Cesium + bundle the renderer
test/kmz.test.js  KMZ round-trip test (npm test)
```

## License

MIT
