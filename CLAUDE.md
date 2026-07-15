# WayEdit — context for Claude Code

Offline Windows desktop app that replicates DJI FlightHub 2 route editing: open a
route KMZ, load the FlightHub 3D model + the flown mission's photos, view/edit
waypoint parameters offline, and re-export a FlightHub-compatible KMZ. Built for a
commercial drone operator flying DJI Dock 3 + Matrice 4TD over oil & gas sites
(Midland, TX). Primary use: tuning capture routes for AI-training imagery of
gauges, tank lids, and site infrastructure.

## Run / build (Windows, Node 18+)

```
npm install        # installs deps, vendors Cesium into renderer/vendor, bundles renderer
npm start          # build:renderer (esbuild) then electron .
npm run dist       # electron-builder → Windows installer + portable exe
npm test           # KMZ round-trip engine test (node, no GUI)
npm run build:renderer   # re-bundle renderer/app.js → renderer/app.bundle.js
```

The renderer is bundled by `scripts/setup.js` (esbuild, IIFE, `cesium` external,
loaded as `window.Cesium`). After editing `renderer/app.js` you must re-bundle
(`npm start` does it automatically). `src/*.js` run in the Electron main process
(not bundled). Known environment gotcha: Electron's binary download has failed on
this user's machine; if `dist/electron.exe` is missing, extract the cached zip from
`%LOCALAPPDATA%\electron\Cache` into `node_modules\electron\dist` and write
`node_modules\electron\path.txt` = `electron.exe`.

## Layout

```
src/kmz.js        WPML engine (runs in Node + browser). Parse/edit/re-zip KMZ.
src/main.js       Electron main: window, IPC (open-kmz, save-kmz, open-model,
                  open-photos, rename-photo), appfile:// local file server.
src/preload.js    contextBridge → window.api
renderer/app.js   UI logic + CesiumJS scene (the file you'll edit most)
renderer/index.html, style.css
scripts/setup.js  postinstall: vendor Cesium + bundle renderer
test/kmz.test.js  round-trip test (7 checks; keep it green)
```

## KMZ / WPML facts (verified against this operator's real routes)

- WPML namespace 1.0.6. Archive layout: `wpmz/template.kml` + `wpmz/waylines.wpml`.
  Edits must touch BOTH docs in sync; preserve everything untouched byte-for-byte
  (edit the parsed DOM in place, never regenerate). Re-zip keeps the `wpmz/` prefix
  and any `res/` files.
- Route-name forbidden chars: `< > : " / | ? * . _ \` (hyphens are safe).
- **Heights**: waypoints carry absolute WGS84 ellipsoid height. `waylines`
  `executeHeight` == `template` `ellipsoidHeight` (~838–872 m on the sample route);
  `template` also has `height` (AGL, small). The renderer places waypoints at the
  absolute height directly — they align with the model with no offset.
- **Per-waypoint camera aim** is set by a `rotateYaw` action →
  `<wpml:aircraftHeading>` (e.g. wp0 = −121.4°), NOT by `waypointHeadingParam`
  (which is `followWayline`/0 here). `gimbalRotate` sets pitch only
  (`gimbalYawRotateEnable`=0). So true shot direction = aircraftHeading + gimbal pitch.
  `kmz.js` exposes `aircraftHeading` (read-only getter, in toJSON).
- Actions present per waypoint: focus, gimbalRotate, rotateYaw, takePhoto, zoom
  (+ rare orientedShoot). Editable getters/setters exist for height, speed, heading,
  gimbalPitch (gimbalPitchRotateAngle), zoomFocalLength (focalLength), lenses
  (takePhoto payloadLensIndex; wide/zoom/ir).

## Camera (M4TD) — zoom factor

Wide = 24 mm equiv = 1×. Zoom factor = focalLength ÷ 24. Native lenses: 24→1×,
70→3× (medium tele), 168→7× (tele); thermal = 53 mm. UI shows "Nx" (snaps native
lenses to clean integers, else 1 decimal). Editing a zoom value writes
`zoom×24` mm, snapping 1/3/7 to the exact native 24/70/168.

## 3D model

FlightHub exports the site as **3D Tiles (B3DM), ECEF-georeferenced** — root
`tileset.json` references 4 block tilesets (BlockXY/XB/AY/AB), each a b3dm LOD
pyramid. Total ~10 GB; Cesium streams it (don't copy/convert). `open-model` scans
the folder (3 levels), positively identifies the ROOT tileset (the one referencing
child tilesets), and loads it with low `maximumScreenSpaceError` (2) for full detail.
The model self-georeferences onto the route; no manual transform/offset needed.
Processing CRS in the report is NAD83 Texas Central ftUS (EPSG:2277) but the
delivered tiles carry an ECEF transform, so Cesium places it correctly.

## Photos

`open-photos` reads EXIF GPS + DateTimeOriginal + embedded thumbnail + DJI XMP gimbal angles
(exifr) and serves full-res via `appfile://photos/...`. The captured aim comes from
`drone-dji:GimbalYawDegree`/`GimbalPitchDegree` in the XMP block → photo `gimbalYaw`/`gimbalPitch`
(the image-info panel shows Yaw/Tilt when present). GOTCHA: exifr's `pick` option drops
XMP-parsed keys — parse the block with `{ xmp: true, mergeOutput: true }` and read fields off the
result, don't `pick` them. These are the *actual* captured angles, independent of the route plan. Matching: nearest-waypoint by GPS
(haversine), else capture-time order. Sample mission: 835–846 images, all RTK-fixed
(GPS matching is reliable). Photo names are editable: the DJI base name is kept and
a user label is appended (`rename-photo` IPC renames the file on disk, refusing
overwrite / paths outside the opened folder).

## Feature state / UI

3-pane GCS layout: waypoint list (# + matched image name) | Cesium 3D view |
inspector + photo strip. Top bar: Open route, Load 3D model, Load mission photos,
route-name field, Export KMZ. Overlay: Satellite basemap toggle (ArcGIS World
Imagery, online), **Camera view (FPV)** toggle. FPV puts the camera AT the selected
waypoint using aircraftHeading + gimbal pitch + zoom-matched FOV; updates live as
you edit. Lightbox closes via ✕ / backdrop / Esc.

## Open items / things to check

1. **setHeight writes the absolute value into BOTH executeHeight/ellipsoidHeight AND
   the template AGL `height` field** (kmz.js setHeight). Editing altitude corrupts the
   AGL field. If the operator will edit heights and push back to FlightHub, fix this to
   keep AGL and absolute consistent (recompute AGL from a ground/ellipsoid reference,
   or only write the absolute fields). Flight-safety relevant — verify before relying on
   height edits.
2. EXIF band detection in `open-photos` matches `_T/_Z/_W/_V` only at the very end of
   the filename, but DJI names are `..._T_P00046....JPG` (band in the middle), so the
   `band` flag is often null → lens badges don't show. Fix the regex to match the band
   token mid-name.
3. FPV uses M4TD wide FOV ~82°/zoom as the frustum; fine for judging framing, not
   metrically exact. Improve if needed.
4. Couldn't test Electron/Cesium/fs paths in the original build env — validate on the
   operator's machine (esp. rename-photo on a COPY first).

## Sample data on hand (for testing)

Operator's real files referenced in dev: route `Rio-Lavaca-commissioning-v1-AGL-Alt-
update.kmz` (424 waypoints), model folder `Rio Lavaca 3D 3-2-26` (10.2 GB B3DM,
EPSG:2277), ~846 mission photos.

## Session handoff (state as of this build)

App is renamed **"Route View"** in the UI (folder still `wayedit`). Build/run unchanged
(`npm install`, `npm start`, or the **Route View** desktop shortcut → `electron.exe .`).
After editing `renderer/app.js` always `npm run build:renderer`; `src/main.js` is read live.

**Two route formats now supported by the engine (kmz.js):**
- `takePhoto` actions → name in `wpml:fileSuffix`, lens "wide"/"ir".
- `orientedShoot` actions → name in `wpml:orientedFileSuffix`, lens "visable"(sic)/"ir".
  The `flight-plan-fixed` routes use orientedShoot. `_photoActionInfo()` handles both;
  `photoActionName(s)`, `photoActions`, `expectedImageCount`, `hasPhotoAction`,
  `setPhotoActionName` all cover both. **orientedShoot bakes its OWN
  gimbalPitchRotateAngle/aircraftHeading/gimbalYawRotateAngle/focalLength into the shot action — and
  in FlightHub THAT is what actually aims the photo** (the separate gimbalRotate/rotateYaw/zoom
  actions only pre-position). FIXED: `setGimbalPitch`/`setAircraftHeading`/`setZoomFocalLength` mirror
  the edit into the orientedShoot param via `_syncOrientedShoot` (only if that param already exists —
  never injects/reorders tags). YAW GOTCHA: orientedShoot stores yaw in BOTH `aircraftHeading` AND
  `gimbalYawRotateAngle` (equal natively) — `setAircraftHeading` now syncs BOTH; syncing only one
  leaves the photo yawed off by the stale gap (symptom: picture "shifts to the side" though tilt is
  right — seen on v2 wp347/FH2#348, −119.2 vs −121.2). Before this, editing tilt moved only gimbalRotate and the photo
  fired at the stale angle (e.g. height-fixed wp42 gimbalRotate=−13.9 but orientedShoot=−18.9).
  NOTE: orientedShoot focalLength can natively differ from the zoom action (52 vs 52.8 thermal on
  Lavaca) — that gap is pre-existing on ALL these routes, not an edit; don't blanket-sync focal.

**Height modes / AGL (kmz.js + app):** routes come in three forms — absolute WGS84,
`relativeToStartPoint` (ALT, small heights, sinks under the model), and the working
`aboveGroundLevel`+WGS84 form. App has a **Height** selector (Absolute / ALT / ASL) with
an editable ground field + **Auto** (samples the 3D model under all WPs, median). Per-site
ground ellipsoid altitudes: **Lavaca ≈ 836.6, Concho ≈ 790.1, Rojo ≈ 812.6 m.** Convert an
ALT route → AGL by adding the ground to executeHeight+ellipsoidHeight, setting
heightMode=aboveGroundLevel / executeHeightMode=WGS84, adding takeOffRefPoint (this is the
`-AGL.kmz` / fix-route flow). `bumpHeight(delta)` moves all three height fields together
(used by the FPV Alt editor). `raiseHeight(delta)` moves only the absolute fields (keeps AGL).
**When editing routes, prefer exporting AGL, not ALT.**

**CRITICAL — `wpml:useGlobalHeight` (FIXED):** a waypoint with `wpml:useGlobalHeight=1` flies at the
mission `globalHeight` (30 on these routes) and FlightHub **ignores its per-waypoint height entirely**.
The original routes deliberately parked the whole separator band on this global default (why they were
uniformly 30 m). Lowering their height did nothing in FH2 because the flag stayed 1 — the edit was
silently dropped. FIXED: `setHeight`/`bumpHeight`/`raiseHeight` now call `_useOwnHeight()` which sets
`useGlobalHeight=0` (template + waylines) so height edits actually take effect. Any "4m" KMZ exported
BEFORE this fix (the earlier `-equip4m` files) has the latent bug — those separators still fly at 30 m
in FlightHub; re-export with the fixed engine. Also: FH2 caches routes by name — import edited files
under a NEW filename or delete the old route first, or it shows stale heights.

**Photo→waypoint matching** (renderer matchPhotos): seqNum-primary via `seqToWp`; battery
swaps handled by a cumulative resume offset (`runningMax+1-minLegSeq`, NOT GPS); a re-shot
waypoint after a swap is re-anchored by the leg's first shot's unique name. Pano frames
(`PANO_*.JPG`) routed to the panoShot WP. See memory `project_photo_matching`.

**FlightHub rules:** no underscores in route/waypoint names — replace with `-` on export.

**App features added this session:** dropdown menus (Open ▾ / Route ▾), Reset session,
New window (per-window file roots in main.js), resizable+persistent FPV panels, collapsible
keyboard hints, **Shift+F** toggles FPV, live AGL + zoom readout, green capture-footprint
box, **camera-aim editor** (Yaw/Tilt/Alt with steppers + type + Confirm/Cancel/Undo/Redo),
**Photo actions panel** (name + VISIBLE/IR per shot), per-waypoint shot counts + name
search (search the WP list too; arrows walk the filtered list), strip band filters
(ALL/WIDE/IR/ZOOM/PANO), video Range-seek, **Recent files** (routes/models/photos load
individually from the Sessions modal, with ✕ to remove), resizable route-name field,
Image-info shows Altitude + Zoom (IR/video = 2×), drone-glyph app icon. **Height unit toggle
(m/ft)** in the top bar (`#height-unit`): display+input only — all heights stay metres internally
(engine/KMZ unchanged); converts the aim-editor Alt field+steppers, FPV AGL readout, image-info
altitude, and the ALT ground field. Persisted in localStorage (`heightUnit`). Helpers in app.js:
`toDisp`/`fromDisp`/`hUnit`, `setHeightUnit`, `syncHeightUnitLabels`. **Collapsible right-rail
sections:** the three right-rail panels are wrapped in `.rail-section` (`#sec-actions`/`#sec-info`/
`#sec-photos`); clicking the `.rail-head.section-toggle` collapses to just the title (caret ▾/▸),
state persisted (`railsec-<id>`). Photo actions (`#wp-actions`) + Image info (`#img-info`) are
`resize: vertical` with height persisted (`railsize-<id>`); Captured images (`#sec-photos`, `.grow`)
is `flex:1` and fills the remainder, so resizing/collapsing the two above it sizes it.

**Route shift / RTK re-base (kmz.js + app):** the operator flies with different RTK correction
sources — Point One NTRIP (trueRTK/virtualrtk.pointonenav, mount points LOCAL or POLARIS, port 2101)
or the DJI Dock 3's own RTK antenna. Each source anchors the site in a slightly different frame
(dock base is self-surveyed ~1 m class; LOCAL vs POLARIS can differ by frame/epoch ~1.5 m), so a
route authored against one source's 3D model sits offset under another (confirmed side-by-side in
FH2; Mapping Quality Reports: Midland LOCAL / Midland DOCK RTK / RioRojo POLARIS, all EPSG:2277,
all RTK-fixed). Fix = constant translation. `Mission.shiftRoute(dEastM, dNorthM, dUpM)` translates
every waypoint's `<coordinates>` (both docs, 9-dp), shifts executeHeight/ellipsoidHeight and the
takeOffRefPoint (lat,lng,alt) together so **AGL is unchanged**; headings/gimbals untouched; does
NOT clear useGlobalHeight (datum move, not a height edit). Verified invertible, exact E/N/U, AGL
stable through save/reload. UI: **Route ▾ → Shift route (RTK re-base)…** opens `#shift-panel`
(floating, top-right of viewer): N/S/E/W nudge pad + Up ▲▼, step field (m/ft aware), cumulative
E/N/U readout, Reset (applies inverse), Done. Live redraw per nudge; refreshes cached
takeOffRefAltitude; new route load / Reset session zero the accumulator. Workflow: load the model
built with the target RTK source, nudge the route onto the structures, Done, Export KMZ.
**Saved RTK offsets** (bottom of the shift panel, localStorage `rtkOffsets`, metres): after aligning
a route once, Save the Applied total under a name (e.g. "Lavaca LOCAL→DOCK"); thereafter any route
on that site converts with **Apply** (forward) or **Apply ⇄** (inverted, DOCK→LOCAL). Applies are
history entries (undoable). Valid while the dock's self-surveyed base position is unchanged — if
the dock re-surveys/re-sites, re-measure. Preset labels re-render on m/ft toggle
(`renderShiftPresets` hook in syncHeightUnitLabels). Alternative worth trying dock-side: FH2 dock
RTK settings allow entering surveyed base coordinates manually — surveying the dock antenna once
with Point One and pinning it would put dock RTK in the same frame permanently (no per-route
conversion needed at all).

**Global undo/redo:** one command-pattern history (`histUndo`/`histRedo` in app.js, entries
`{label, undo(), redo()}` via `pushHistory`) covers ALL route edits — aim yaw/tilt/alt (confirmAim),
route-shift nudges + reset (each nudge is an entry), and Uniquify WP names (before/after snapshot).
Top-bar `#btn-undo`/`#btn-redo` (↶/↷, tooltips show the entry label) + Ctrl+Z / Ctrl+Y /
Ctrl+Shift+Z (skipped while typing in inputs); the FPV aim panel's ↶/↷ act on the SAME stack
(`undoAim`/`redoAim` discard any unconfirmed draft, then `doUndo`/`doRedo`). History cleared on
new-route load and Reset session (entries hold old waypoint refs). `renameMatchedPhotos` (disk
renames) is deliberately NOT in the history. Also fixed in passing: uniquifyWpNames called a
nonexistent `renderWaypoints()` → now `renderList()` (was a latent crash after renaming).

**FPV mouse-look:** while FPV is on, the map controller is disabled (`setFpvMouseMode(on)`) and
dragging on the canvas steers the CAMERA — yaw+tilt, FPS-style per operator preference: **drag
right → look right, drag up → look up**; 1:1 feel via degrees-per-pixel = current FOV / canvas
width (so it slows when zoomed). Roll pinned 0. Wheel = FPV zoom (same steps as +/−). Position
stays on the keyboard (W/S/A/D/C/Z). Pointer-captured drag (`initFpvMouseLook` in app.js, called
from initCesium); cursor grab/grabbing. All FPV entry/exit paths wired: checkbox onchange,
`enterFpv()` (row double-click), Shift+F (dispatches change), resetSession. Exiting FPV restores
normal map mouse controls. **Drag IS an aim edit:** when a shot is selected (aim panel visible),
dragging previews the shot's yaw/tilt live via `applyAim(kind, value, skipFpv=true)` (camera
already oriented; no position snap) — Confirm/Cancel/undo apply as with typed edits; pitch capped
at +30° while editing (gimbal limit; free-look cap +45°). **Zoom row in the aim editor**
(`#aim-zoom`, factor ×): steppers/typed, snaps 1/3/7 → native 24/70/168 mm, else factor×24 (round1);
draft stores exact orig focal (restores 52.8-style natives on Cancel); edits go through
`setShotZoomFocalLength` (pre-position zoom + orientedShoot focal). `activeShotFocal()` feeds
setFpvFov / updateFpvOverlay / the zoom readout, so the green capture box resizes with the edited
zoom in wide view (key 1) and key 2 zooms the FPV to the edited level (edits clear fpvManualZoom).
The hints panel opens ABOVE the ⌨ Controls button (bottom: 46px) so the button doesn't cover it.

**Loaded-files badge:** collapsed `🗂 n/3` pill at the viewer's top-right (`#files-badge`); hovering
expands it to Route / 3D model / Photos rows (basename shown, full path in tooltip, "—" when not
loaded). Updated by `updateFilesBadge()` from `state.routePath/modelDir/photosDir` — called at boot,
applyRoute, applyModel, applyPhotos, resetSession (recents/session restores flow through these).
The shift panel sits below it (top: 48px) to avoid overlap.

**Multi-shot waypoints — per-action aim editing (kmz.js + app):** a waypoint can hold several
capture blocks (each = `[rotateYaw, gimbalRotate, zoom, orientedShoot]`; e.g. Lavaca v2 wp323/FH2#324
has 8). `_shotBlocks(node)` splits a placemark's actions into per-shot blocks; `get photoShots`
exposes each shot's tilt/heading/zoom; `setShotGimbalPitch/AircraftHeading/ZoomFocalLength(k, v)`
edit block k in BOTH docs (pre-position action + the orientedShoot's baked params, incl. both yaw
fields). The old single getters/setters still act on block 0. UI: the FPV aim editor has a **shot
selector** (`#aim-shots` chips, shown only when >1 shot) and the right-rail **Photo actions** rows
are click-to-select on multi-shot WPs (`.wp-act-pick`/`.shot-active`); `state.aimShot` tracks the
active shot (reset to 0 on WP change), and Yaw/Tilt edit that shot while Alt stays waypoint-wide.
FPV preview aims at the selected shot. Undo/redo entries carry the shot index.

**Helper scripts in `scripts/`** (kept): `route-variant.js` (height/zoom/tilt variants,
auto/fixed tilt model), `raise-heights.js`. (One-off diag/edit scripts were created and
deleted as used — recreate as needed.)

**Boss-facing report artifacts (split into two, cross-linked):**
- **Functionality / "What It Does"** → https://claude.ai/code/artifact/89e52995-e097-4dca-8af0-0b4d98efbf2f
  (scratchpad `route-view-functionality.html`) — evergreen capabilities guide; keeps the original URL.
- **Troubleshooting Log** → https://claude.ai/code/artifact/b86fc18f-dac2-4a9f-94e3-03597ceb3e59
  (scratchpad `route-view-troubleshooting.html`) — the debugging history (bumps + fixes).
Same design system (amber brand; troubleshooting uses orange eyebrow/nodes). Redeploy by editing
the scratchpad file and calling Artifact with the matching URL. Each links to the other in its hero.

**Open follow-ups:**
- **PENDING — RTK offset measurement flight (Midland office):** operator will author a new test
  route over a better reference point (a first draft, `Testing-offset-check.kmz` in
  `Downloads/Midland Office/`, was prepared — all shots forced to −90°/wide via the per-shot
  setters — but is on hold). Plan: fly the same route 3× (LOCAL / POLARIS / DOCK 3 RTK, each
  RTK-FIXED), then analyze the photo sets — match ground features across sets, pixels→metres via
  AGL+camera geometry, heading from XMP, vertical via AbsoluteAltitude−LRFTargetDistance — to
  quantify pairwise E/N/U offsets and save them as Shift-panel presets (`rtkOffsets`).
- **TODO (placemarker, raised by operator):** double-check heights on all waypoints carrying a
  relief-valve or thief-hatch short code — suspected route mixup. Final scope: `TKPRV` (tank P/V
  relief valve), `SEPPRV` (separator PRV popped), `SEPRFV` (separator relief-valve discharge),
  `THFHT` (thief hatch). Not yet investigated — parked here; sweep AGL heights + tilts when asked.
- ~~In-app editing of oriented-shot tilt/zoom~~ DONE — setters mirror into orientedShoot
  (`_syncOrientedShoot`). The aim-editor Tilt/Yaw and zoom edits now move the actual capture angle.
- **(RESOLVED via height-lower)** The shallow-gimbal equipment shots stuck at a constant
  ~30 m AGL were lowered to **4 m AGL** (gimbal/yaw/zoom untouched) by `bumpHeight(4−agl)`.
  Selection rule = shallow gimbal (gp > −45°) AND ~30 m AGL AND an equipment short code
  (SEPEXT/SEPTMPPRO/HTEXT/HTBRNON/HTSHLTEMP/WLINL). The −88.9° top-views and the elevated
  "Area"/"General*" context shots (Lavaca 36 m, Rojo 28 m) are intentional overview bands —
  left as-is. Outputs (originals kept): `…-flight-plan-fixed-IR-equip4m.kmz`.
  · **Lavaca** = 38 WPs (124,125,129,132; 271–277; 288–303; 306–313; 417–419).
  · **Rojo** = 14 WPs (37,38,43,44,56,57,58,60,61,62,67,68,91,92), separators only.
  · **Concho** = no issue — its equipment shots already sit at 5–15 m; nothing changed.
  Helper scripts in scratchpad (survey.js / edit4m.js / edit_rojo.js). Eyeball 4 m near tall
  vessels before flying.
- IR was added to the 3 `flight-plan-fixed-IR.kmz` routes (lens → `visable,ir`,
  useGlobalPayloadLensIndex → 1) to match the SAN-GABRIEL reference.
