'use strict';
const { loadMission, createBlankMission, validateRouteName } = require('../src/kmz');

const Cesium = window.Cesium;

const state = {
  mission: null,
  routeName: 'route-edited',
  routePath: null,    // file path of the opened KMZ (for session saving)
  modelDir: null,     // folder path of the 3D model
  modelLoaded: false, // a model was actually added to the scene (modelDir alone just means a folder was picked)
  placingWaypoint: false, // "Create new route" click-to-place mode is active
  photosDir: null,    // folder path of mission photos
  photosDirCreatedAt: null,
  photosFolderName: null,
  selected: -1,
  dirty: false,
  photos: [],
  photoByWp: new Map(), // wpIndex -> [photo]
  entities: { points: [], lines: [], path: null, heading: null },
  imageryLayer: null,
  labelsLayer: null,   // "hybrid" overlay: place names + borders on top of the satellite imagery
  roadsLayer: null,    // "hybrid" overlay: street/road linework, drawn under the labels above
  tileset: null,
  fpv: false,
  routeBounds: null,   // { lat, lng, h, radius } computed from waypoints
  stripFilter: null,   // null = all bands; else 'ir'|'wide'|'zoom'|'pano'
  takeOffRefAltitude: null, // mission takeoff ellipsoid altitude, for FPV AGL readout
  visibleWpIndices: [],     // waypoint indices currently shown in the (filtered) list
  heightMode: 'absolute',   // how to read the route's heights: absolute | alt | asl
  heightOffset: 0,          // metres added to every waypoint's height for 3D placement
  heightUnit: 'm',          // display/input unit for heights: 'm' | 'ft' (internal values stay metres)
  shownPhoto: null,         // photo currently rendered in the image-info panel (for unit re-render)
  aimShot: 0,               // which photo action (shot) on the selected waypoint the aim editor edits
  editingShotName: null,    // shot index currently being renamed in the Photo actions panel, or null
  aircraftIrOverride: true, // whether this aircraft is treated as IR-capable — defaults ON, operator disables per-route
};

// West Texas geoid separation (ellipsoid − MSL ≈ −25.4 m): used to place ASL/MSL routes.
const GEOID_SEP = -25.4;

// Height display units. Every height in the engine/state is metres; these helpers only
// affect how heights are shown and how typed input is interpreted.
const M_TO_FT = 3.280839895;
function hUnit() { return state.heightUnit === 'ft' ? 'ft' : 'm'; }
function toDisp(m) { return state.heightUnit === 'ft' ? m * M_TO_FT : m; }   // metres → display unit
function fromDisp(v) { return state.heightUnit === 'ft' ? v / M_TO_FT : v; } // display unit → metres
// Display (3D-placement) height for a waypoint = its stored height + the chosen offset.
function wpDisplayHeight(wp) { return (wp.height ?? 0) + (state.heightOffset || 0); }

// FPV keyboard movement
let fpvZoomMode = 1;   // 1 = wide view, 2 = zoom-lens view
let fpvManualZoom = null; // null = use WP's zoomFocalLength; number = manual override (zoom factor)
const FPV_SPEEDS = [2, 10, 30]; // m per tick (slow / medium / fast)
const FPV_SPEED_LABELS = ['Slow', 'Medium', 'Fast'];
let fpvKeys = new Set();
let fpvSpeedMode = 0;
let fpvRaf = null;
let fpvLastT = null;

// Shift+Up/Down camera-height nudge for the normal (non-FPV) map camera — same held-key +
// requestAnimationFrame pattern as the FPV W/S/A/D/C/Z loop, so it ramps smoothly instead of
// jumping in fixed steps per keypress.
let mapHeightKeys = new Set();
let mapHeightRaf = null;
let mapHeightLastT = null;

// Numbered teardrop pins (FlightHub-style). Built once, cached per number+color.
const pinBuilder = new Cesium.PinBuilder();
const pinCache = new Map();
function pin(num, hex, size) {
  const key = `${num}|${hex}|${size}`;
  let img = pinCache.get(key);
  if (!img) {
    img = pinBuilder.fromText(String(num), Cesium.Color.fromCssColorString(hex), size).toDataURL();
    pinCache.set(key, img);
  }
  return img;
}
const WP_BLUE = '#2f7bf6';
const WP_AMBER = '#ffb454';
const WP_CYAN = '#4fd1e0';

// M4TD optics: wide camera = 24mm equiv = 1x. Zoom factor = focalLength / 24.
// Native optical: 24/70/168mm; digital presets: 14x, 56x, 112x (matching FlightHub UI).
const WIDE_MM = 24;
const ZOOM_STEPS = { 1: 24, 3: 70, 7: 168, 14: 336, 56: 1344, 112: 2688 };
const ZOOM_PRESETS = [1, 3, 7, 14, 56, 112]; // for slider tick marks
const SLIDER_LOG_MAX = Math.log10(112); // log-scale slider: 0..SLIDER_LOG_MAX
function sliderToZoom(v) { return Math.pow(10, parseFloat(v)); }
function zoomToSlider(z) { return Math.log10(Math.max(1, Math.min(112, z))); }
function zoomFromFocal(mm) { return (mm == null || Number.isNaN(mm)) ? null : mm / WIDE_MM; }
function zoomLabel(mm) {
  const z = zoomFromFocal(mm);
  if (z == null) return '·';
  const r = Math.round(z);
  return (Math.abs(z - r) <= 0.15 ? String(r) : z.toFixed(1)) + 'x';
}
function zoomInputValue(mm) {
  const z = zoomFromFocal(mm);
  if (z == null) return '';
  const r = Math.round(z);
  return Math.abs(z - r) <= 0.15 ? r : Math.round(z * 10) / 10;
}
function focalFromZoom(zoom) {
  if (zoom == null || Number.isNaN(zoom)) return null;
  const r = Math.round(zoom);
  if (Math.abs(zoom - r) <= 0.05 && ZOOM_STEPS[r] != null) return ZOOM_STEPS[r];
  return Math.round(zoom * WIDE_MM * 10) / 10;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
let viewer = null;
let cesiumOK = false;

function boot() {
  try {
    initCesium();
    cesiumOK = true;
  } catch (e) {
    console.error('Cesium failed to init:', e);
    setStatus('3D viewer unavailable — editing still works. ' + e.message);
  }
  wireUi();
  renderImageInfo(null);
  renderWpActions(null);
}

function initCesium() {
  viewer = new Cesium.Viewer('viewer', {
    baseLayer: false,            // offline by default; no online imagery until toggled
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    timeline: false,
    animation: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    creditContainer: document.createElement('div'),
  });
  viewer.scene.globe.show = true;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#11161d');
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0d12');
  // High-detail imagery: load finer tiles sooner and keep neighbours warm.
  viewer.scene.globe.maximumScreenSpaceError = 1.0; // default 2 — lower = sharper
  viewer.scene.globe.preloadSiblings = true;
  viewer.scene.globe.tileCacheSize = 1000;
  viewer.scene.logarithmicDepthBuffer = true; // avoids z-fighting at site scale
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
  enableDefaultImagery(); // show a normal-looking map (like Google Maps) until a 3D model is loaded
  enableRealTerrain(); // real ground elevation, so the map isn't a flat plane the 3D model floats above

  // Click-to-select waypoints (or, in "Create new route" placement mode, click-to-place one).
  viewer.screenSpaceEventHandler.setInputAction((click) => {
    if (state.placingWaypoint) { handlePlacementClick(click); return; }
    const picked = viewer.scene.pick(click.position);
    if (picked && picked.id && typeof picked.id.wpIndex === 'number') {
      selectWaypoint(picked.id.wpIndex);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  initFpvMouseLook();
}

// ---------------------------------------------------------------------------
// FPV mouse-look — while in FPV the mouse steers the CAMERA (yaw + tilt) by dragging,
// like grabbing the view in Street View, instead of orbiting/panning the map. Position
// stays on the keyboard (W/S/A/D move, C/Z up/down). The map controller is disabled for
// the duration and restored when FPV turns off.
// ---------------------------------------------------------------------------
let fpvLookDrag = null; // { x, y } of the last pointer position while steering

function setFpvMouseMode(on) {
  if (!cesiumOK) return;
  viewer.scene.screenSpaceCameraController.enableInputs = !on;
  viewer.scene.canvas.style.cursor = on ? 'grab' : '';
  if (!on) fpvLookDrag = null;
}

function initFpvMouseLook() {
  const canvas = viewer.scene.canvas;
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.fpv || e.button !== 0) return;
    fpvLookDrag = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!fpvLookDrag || !state.fpv || !cesiumOK) return;
    const dx = e.clientX - fpvLookDrag.x;
    const dy = e.clientY - fpvLookDrag.y;
    fpvLookDrag = { x: e.clientX, y: e.clientY };
    if (!dx && !dy) return;
    // When a waypoint shot is selected, dragging IS an aim edit — the camera turns AND the
    // shot's yaw/tilt update live in the aim panel as an unconfirmed draft (Confirm keeps it,
    // Cancel snaps everything back). With no shot selected it's a pure free-look.
    const wp = aimCurrentWp();
    const s = wp && curAimShot(wp);
    // 1:1 "grab the world" feel — degrees per pixel tracks the current FOV, so the
    // look speed automatically slows down when the FPV zoom is punched in.
    const cam = viewer.camera;
    const degPerPx = Cesium.Math.toDegrees(cam.frustum.fov) / Math.max(1, canvas.clientWidth);
    const heading = Cesium.Math.toDegrees(cam.heading) + dx * degPerPx; // drag right → look right
    const maxPitch = s ? 30 : 45; // editing: cap at the gimbal's +30° limit so view == shot
    const pitch = Math.max(-89, Math.min(maxPitch,
      Cesium.Math.toDegrees(cam.pitch) - dy * degPerPx));              // drag up → look up
    cam.setView({
      destination: Cesium.Cartesian3.clone(cam.position),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0,
      },
    });
    if (s) {
      applyAim('yaw', heading, true);  // skipFpv — camera already oriented above
      applyAim('tilt', pitch, true);
    }
  });
  const endLook = (e) => {
    if (!fpvLookDrag) return;
    fpvLookDrag = null;
    if (state.fpv) canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
  // Scroll wheel in FPV: with a shot selected it EDITS the shot's capture zoom — a confirmable
  // draft, same as the panel's Zoom row — updating the panel number, the green capture box, and
  // the zoomed view live. With no shot selected it only adjusts the view zoom (like +/-).
  canvas.addEventListener('wheel', (e) => {
    if (!state.fpv) return;
    e.preventDefault();
    const wp = aimCurrentWp();
    const s = wp && curAimShot(wp);
    if (s && s.zoomFocalLength != null) {
      const cur = zoomFromFocal(s.zoomFocalLength) || 1;
      // step ladder matches FH2's zoom scale up to 112×
      const step = cur >= 28 ? 14 : cur >= 10 ? 5 : cur >= 3 ? 1 : 0.5;
      applyAim('zoom', cur + (e.deltaY < 0 ? step : -step), true); // skipFpv: don't snap position
    } else {
      const step = fpvManualZoom != null && fpvManualZoom >= 10 ? 5
        : fpvManualZoom != null && fpvManualZoom >= 3 ? 1 : 0.5;
      fpvAdjustZoom(e.deltaY < 0 ? step : -step);
    }
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function wireUi() {
  // Dropdown menus — toggle on click, close on outside click or item select
  document.querySelectorAll('.dropdown-toggle').forEach((toggle) => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = toggle.closest('.dropdown');
      const wasOpen = dd.classList.contains('open');
      document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
      if (!wasOpen) dd.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  });
  document.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
    });
  });

  $('btn-sessions').onclick = openSessionModal;
  $('btn-new-window').onclick = () => { if (window.api.newSession) window.api.newSession(); };
  $('btn-open').onclick = openRoute;
  $('btn-model').onclick = openModel;
  $('btn-photos').onclick = openPhotos;
  $('btn-load-all').onclick = loadAll;
  $('btn-uniquify').onclick = uniquifyWpNames;
  $('btn-rename-photos').onclick = renameMatchedPhotos;
  $('btn-shift').onclick = openShiftPanel;
  $('btn-export').onclick = exportKmz;
  $('btn-reset').onclick = resetSession;
  $('btn-new-route').onclick = openCreateRouteModal;
  initShiftPanel();
  updateFilesBadge();
  syncCreateRouteEnabled();

  // Add-action bar (Photo actions panel): insert a new action onto the selected waypoint.
  document.querySelectorAll('.add-act-btn').forEach((btn) => {
    btn.onclick = () => addWpAction(btn.dataset.add);
  });

  // Route-wide Camera Settings (default Visible/IR lens set) + aircraft IR-capability override.
  document.querySelectorAll('#camera-settings-row .lens-pill').forEach((btn) => {
    btn.onclick = () => toggleGlobalLens(btn.dataset.glens);
  });
  $('ir-support-toggle').onclick = toggleIrSupport;

  // Global undo/redo: top-bar buttons + Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z also redoes).
  // Skipped while typing in a text field so native text-editing undo still works there.
  $('btn-undo').onclick = undoAim;
  $('btn-redo').onclick = redoAim;
  updateUndoButtons();
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoAim(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoAim(); }
  });
  $('route-name').oninput = (e) => { state.routeName = e.target.value; };

  // Captured-images band filter (ALL / WIDE / IR / ZOOM / PANO)
  document.querySelectorAll('#strip-filters .strip-filter').forEach((btn) => {
    btn.onclick = () => {
      const band = btn.dataset.band;
      state.stripFilter = band === 'all' ? null : band;
      document.querySelectorAll('#strip-filters .strip-filter').forEach((b) =>
        b.classList.toggle('active', b.dataset.band === band));
      const q = $('photo-search').value.trim();
      if (q) renderPhotoSearch(q);
      else renderPhotos(state.selected);
    };
  });

  // FPV camera-aim editor: ▲▼ steppers, type-to-edit value, and wheel/arrow nudging.
  // Yaw/tilt/zoom act on the currently-selected photo action (shot); alt is per-waypoint.
  const curAim = (kind) => {
    const wp = aimCurrentWp(); if (!wp) return null;
    if (kind === 'alt') return wp.aglHeight == null ? null : toDisp(wp.aglHeight); // display unit (m/ft)
    const s = curAimShot(wp); if (!s) return null;
    if (kind === 'zoom') return s.zoomFocalLength == null ? null : zoomFromFocal(s.zoomFocalLength);
    return kind === 'yaw' ? s.aircraftHeading : s.gimbalPitch;
  };
  ['yaw', 'tilt', 'zoom', 'alt'].forEach((kind) => {
    const inp = $('aim-' + kind);
    if (!inp) return;
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = curAim(kind); if (cur == null) return;
      applyAim(kind, cur + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 5 : 0.5));
    }, { passive: false });
    inp.addEventListener('keydown', (e) => {
      const cur = curAim(kind);
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (cur == null) return;
        e.preventDefault(); e.stopPropagation();
        applyAim(kind, cur + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 0.5));
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation(); // apply only; Confirm still commits
        const v = parseFloat(inp.value);
        if (!isNaN(v)) applyAim(kind, v); else refreshAimControls();
      }
    });
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) applyAim(kind, v); else refreshAimControls();
    });
  });
  document.querySelectorAll('#fpv-aim .aim-step').forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.aim, dir = parseInt(btn.dataset.dir, 10);
      const cur = curAim(kind); if (cur == null) return;
      applyAim(kind, cur + dir * 0.5);
    };
  });
  $('aim-confirm').onclick = confirmAim;
  $('aim-cancel').onclick = revertAim;
  $('aim-undo').onclick = undoAim;
  $('aim-redo').onclick = redoAim;
  // Shot selector (multi-photo waypoints): click a shot chip to edit that photo action.
  $('aim-shots').addEventListener('click', (e) => {
    const btn = e.target.closest('.aim-shot'); if (!btn) return;
    selectAimShot(parseInt(btn.dataset.shot, 10));
  });

  // Collapsible keyboard-controls panel
  $('fpv-keys-toggle').onclick = () => $('fpv-hint').classList.toggle('collapsed');

  // Resizable FPV panels — scale font-size proportional to width (em-based contents scale
  // with it), and remember each panel's size across sessions. Max size is capped in CSS.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) {
        const el = ent.target;
        if (!el.offsetWidth) continue; // skip while hidden
        const base = parseFloat(el.dataset.baseW) || el.offsetWidth || 1;
        const scale = Math.max(0.8, Math.min(1.7, el.offsetWidth / base));
        el.style.fontSize = (12 * scale).toFixed(2) + 'px';
        try { localStorage.setItem('fpvpanel-' + el.id, el.style.width + '|' + el.style.height); } catch {}
      }
    });
    document.querySelectorAll('.fpv-panel').forEach((el) => {
      // Restore last session's size (the user-set width/height; CSS max-* still clamps it).
      try {
        const saved = (localStorage.getItem('fpvpanel-' + el.id) || '').split('|');
        if (saved[0]) el.style.width = saved[0];
        if (saved[1]) el.style.height = saved[1];
      } catch {}
      ro.observe(el);
    });
  }

  // Collapsible right-rail sections: click a header to collapse it to just its title.
  // State persists per section. Photo actions + Image info also remember their dragged height.
  document.querySelectorAll('#rail-right .section-toggle').forEach((head) => {
    const sec = head.closest('.rail-section');
    if (!sec) return;
    const key = 'railsec-' + sec.id;
    try { if (localStorage.getItem(key) === '1') sec.classList.add('collapsed'); } catch {}
    head.addEventListener('click', () => {
      const collapsed = sec.classList.toggle('collapsed');
      try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
    });
  });
  ['wp-actions', 'img-info'].forEach((id) => {
    const el = $(id); if (!el) return;
    try { const h = localStorage.getItem('railsize-' + id); if (h) el.style.height = h; } catch {}
  });
  if (window.ResizeObserver) {
    const rro = new ResizeObserver((ents) => {
      for (const e of ents) {
        const el = e.target;
        if (el.style.height) { try { localStorage.setItem('railsize-' + el.id, el.style.height); } catch {} }
      }
    });
    ['wp-actions', 'img-info'].forEach((id) => { const el = $(id); if (el) rro.observe(el); });
  }

  // Height reference: how to read the route's stored heights for 3D placement.
  $('height-mode').onchange = applyHeightMode;
  $('ground-alt').oninput = () => { if (state.heightMode === 'alt') applyHeightMode(); };
  $('ground-auto').onclick = autoGroundFromModel;

  // Height units (m/ft) — display+input only; restore the saved choice and wire the toggle.
  try { const u = localStorage.getItem('heightUnit'); if (u === 'ft' || u === 'm') state.heightUnit = u; } catch {}
  syncHeightUnitLabels();
  $('height-unit').onclick = () => setHeightUnit(state.heightUnit === 'm' ? 'ft' : 'm');

  $('imagery').onchange = toggleImagery;
  $('imagery-labels').onchange = toggleImageryLabels;
  $('fpv').onchange = (e) => {
    state.fpv = e.target.checked;
    $('fpv-keys-toggle').classList.toggle('hidden', !state.fpv);
    $('fpv-alt').classList.toggle('hidden', !state.fpv);
    if (state.fpv) {
      $('fpv-hint').classList.remove('hidden'); // collapsed until expanded via the toggle
      setFpvMouseMode(true); // mouse = camera aim (drag) + zoom (wheel); map inputs off
      applyFpv(); updateFpvOverlay(); updateFpvAltReadout(); refreshAimControls();
    } else {
      revertAim();
      $('fpv-hint').classList.add('hidden', 'collapsed');
      $('fpv-aim').classList.add('hidden');
      $('fpv-overlay').classList.add('hidden'); // hide the green capture box + lens overlay
      stopFpvLoop(); fpvKeys.clear();
      setFpvMouseMode(false); // restore normal map mouse controls
      if (cesiumOK) { viewer.camera.frustum.fov = Cesium.Math.toRadians(60); }
      fitView();
    }
  };

  // Lightbox (full-screen, single image)
  const closeLightbox = () => $('lightbox').classList.add('hidden');
  $('lightbox').onclick = (e) => { if (e.target.id === 'lightbox-stage' || e.target.id === 'lightbox') closeLightbox(); };
  $('lightbox-close').onclick = (e) => { e.stopPropagation(); closeLightbox(); };

  // Session modal
  $('session-modal-close').onclick = () => $('session-modal').classList.add('hidden');
  $('session-modal').onclick = (e) => { if (e.target.id === 'session-modal') $('session-modal').classList.add('hidden'); };

  // Create new route modal
  const closeNewRoute = () => $('newroute-modal').classList.add('hidden');
  $('newroute-modal-close').onclick = closeNewRoute;
  $('newroute-cancel').onclick = closeNewRoute;
  $('newroute-modal').onclick = (e) => { if (e.target.id === 'newroute-modal') closeNewRoute(); };
  $('newroute-create').onclick = confirmCreateRoute;
  ['newroute-lens-wide', 'newroute-lens-ir'].forEach((id) => {
    $(id).onclick = () => {
      const wide = $('newroute-lens-wide'), ir = $('newroute-lens-ir');
      const btn = $(id);
      // At least one of Visible/IR must stay selected.
      if (btn.classList.contains('active') && (id === 'newroute-lens-wide' ? !ir.classList.contains('active') : !wide.classList.contains('active'))) return;
      btn.classList.toggle('active');
    };
  });
  $('placing-done').onclick = exitPlacingWaypoint;
  $('placing-cancel').onclick = discardRoute;

  // Generic confirm dialog
  $('confirm-ok').onclick = () => resolveConfirm(true);
  $('confirm-cancel').onclick = () => resolveConfirm(false);
  $('confirm-modal').onclick = (e) => { if (e.target.id === 'confirm-modal') resolveConfirm(false); };

  // Column resize handles
  initColResize();

  // Font size control — uses webFrame.setZoomFactor so ALL UI elements scale proportionally
  (function initFontScale() {
    const MIN = 0.7, MAX = 1.6, STEP = 0.1;
    let scale = parseFloat(localStorage.getItem('fontScale') || '1');
    const apply = () => {
      if (window.api.setZoomFactor) window.api.setZoomFactor(scale);
      localStorage.setItem('fontScale', scale);
    };
    apply();
    $('btn-font-down').onclick = () => { scale = Math.max(MIN, parseFloat((scale - STEP).toFixed(1))); apply(); };
    $('btn-font-up').onclick = () => { scale = Math.min(MAX, parseFloat((scale + STEP).toFixed(1))); apply(); };
  })();

  // Route-name field: single-line (no newlines), drag-to-widen, width remembered.
  (function initRouteName() {
    const ta = $('route-name');
    if (!ta) return;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ta.blur(); } });
    try { const w = localStorage.getItem('routeNameWidth'); if (w) ta.style.width = w; } catch {}
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (ta.style.width) { try { localStorage.setItem('routeNameWidth', ta.style.width); } catch {} }
      }).observe(ta);
    }
  })();

  // Waypoint search
  $('wp-search').oninput = (e) => renderList(e.target.value.trim());

  // Photo search — searches ALL loaded photos across every waypoint
  $('photo-search').oninput = (e) => {
    const q = e.target.value.trim();
    if (q) renderPhotoSearch(q);
    else if (state.selected >= 0) renderPhotos(state.selected);
    else $('photo-strip').innerHTML = '<div class="hint">No photos loaded for this waypoint.</div>';
  };

  // Global keyboard: Esc for lightbox, FPV movement keys
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
    if (e.key === 'Escape' && !$('confirm-modal').classList.contains('hidden')) { resolveConfirm(false); return; }
    if (e.key === 'Escape' && state.placingWaypoint) { exitPlacingWaypoint(); return; }
    // Shift+F toggles Camera view (FPV).
    if (e.shiftKey && (e.key === 'F' || e.key === 'f') && !isInputFocused()) {
      e.preventDefault();
      const cb = $('fpv');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
      return;
    }
    // Confirm / cancel a pending aim edit (works even while a slider is focused).
    if (state.fpv && aimDraft) {
      if (e.key === 'Enter') { confirmAim(); e.preventDefault(); return; }
      if (e.key === 'Escape') { revertAim(); e.preventDefault(); return; }
    }
    // Shift+Up/Down raises/lowers the map camera itself — normal (non-FPV) navigation only;
    // FPV has its own C/Z height controls tied to the aircraft, not the free-look camera. Held
    // key -> continuous ramp (startMapHeightLoop), same feel as FPV's C/Z, not a per-press jump.
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !state.fpv && cesiumOK && !isInputFocused()) {
      e.preventDefault();
      mapHeightKeys.add(e.key === 'ArrowUp' ? 'up' : 'down');
      startMapHeightLoop();
      return;
    }
    if (!isInputFocused() && $('lightbox').classList.contains('hidden') && state.mission) {
      if (e.key === 'Delete' && state.selected >= 0) { e.preventDefault(); deleteSelectedWaypoint(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        // Step through the currently-visible (filtered) waypoint list in display order,
        // so a search like "PRV" lets the arrows jump WP 115 → 200 → 300 → 332.
        const allIdx = (state.visibleWpIndices && state.visibleWpIndices.length)
          ? state.visibleWpIndices
          : state.mission.waypoints.map((w) => w.index).sort((a, b) => a - b);
        let cur = allIdx.indexOf(state.selected);
        if (cur === -1) cur = e.key === 'ArrowDown' ? -1 : 0; // selection not in list → start at edge
        const next = e.key === 'ArrowDown'
          ? Math.min(cur + 1, allIdx.length - 1)
          : Math.max(cur - 1, 0);
        if (allIdx[next] != null && next !== cur) {
          selectWaypoint(allIdx[next]);
          const row = document.querySelector(`#wp-body tr[data-idx="${allIdx[next]}"]`);
          if (row) row.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
    }
    if (state.fpv && cesiumOK && !isInputFocused()) {
      const k = e.key.toLowerCase();
      if (!e.repeat) {
        if (k === '1') { fpvZoomMode = 1; fpvManualZoom = null; setFpvFov(); return; }
        if (k === '2') { fpvZoomMode = 2; fpvManualZoom = null; setFpvFov(); return; }
        if (k === 'x') { fpvSpeedMode = (fpvSpeedMode + 1) % FPV_SPEEDS.length; updateFpvSpeedLabel(); return; }
        if (k === 'v') { applyFpv(); return; }
        if (k === 'f') { addWpAction('takePhotoFixed'); return; } // capture at current camera aim
      }
      // Zoom adjust with + / - (allow repeat for smooth ramp)
      if (e.key === '+' || e.key === '=') { fpvAdjustZoom(fpvManualZoom != null && fpvManualZoom >= 10 ? 5 : fpvManualZoom != null && fpvManualZoom >= 3 ? 1 : 0.5); return; }
      if (e.key === '-') { fpvAdjustZoom(fpvManualZoom != null && fpvManualZoom > 10 ? -5 : fpvManualZoom != null && fpvManualZoom > 3 ? -1 : -0.5); return; }
      if ('wsadqezc'.includes(k) && k.length === 1) {
        fpvKeys.add(k);
        startFpvLoop();
      }
    }
  });
  document.addEventListener('keyup', (e) => {
    fpvKeys.delete(e.key.toLowerCase());
    if (fpvKeys.size === 0) stopFpvLoop();
    if (e.key === 'ArrowUp') mapHeightKeys.delete('up');
    if (e.key === 'ArrowDown') mapHeightKeys.delete('down');
    if (mapHeightKeys.size === 0) stopMapHeightLoop();
  });
}

// Raise/lower the (non-FPV) map camera in place — same lat/lng and look direction, just altitude.
// Same held-key + requestAnimationFrame loop as FPV's C/Z, so it ramps smoothly instead of
// jumping per keypress. Rate is a fraction of current altitude per second (not a fixed m/s) so it
// feels equally useful zoomed to the ground or zoomed way out over the whole site.
const MAP_HEIGHT_RATE = 0.8; // fraction of current altitude, per second
function startMapHeightLoop() {
  if (mapHeightRaf != null) return;
  mapHeightLastT = performance.now();
  function tick(t) {
    if (state.fpv || !cesiumOK || mapHeightKeys.size === 0) { mapHeightRaf = null; return; }
    const dt = Math.min((t - mapHeightLastT) / 1000, 0.1);
    mapHeightLastT = t;
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const rate = Math.max(1, carto.height * MAP_HEIGHT_RATE);
    let dir = 0;
    if (mapHeightKeys.has('up')) dir += 1;
    if (mapHeightKeys.has('down')) dir -= 1;
    if (dir !== 0) {
      carto.height += dir * rate * dt;
      viewer.camera.position = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height);
    }
    mapHeightRaf = requestAnimationFrame(tick);
  }
  mapHeightRaf = requestAnimationFrame(tick);
}
function stopMapHeightLoop() {
  if (mapHeightRaf != null) { cancelAnimationFrame(mapHeightRaf); mapHeightRaf = null; }
}

function setStatus(msg) { $('status').textContent = msg; }

// ---------------------------------------------------------------------------
// Column resize
// ---------------------------------------------------------------------------
function initColResize() {
  const root = document.documentElement;
  const grid = $('main-grid');

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function makeDragger(handleId, cssVar, getStartPx, sign, min, max) {
    const handle = $(handleId);
    let startX = 0, startPx = 0;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startPx = parseInt(getComputedStyle(root).getPropertyValue(cssVar)) || getStartPx();
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const delta = (e.clientX - startX) * sign;
        root.style.setProperty(cssVar, clamp(startPx + delta, min, max) + 'px');
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Remember this width for next session.
        try { localStorage.setItem('colw' + cssVar, getComputedStyle(root).getPropertyValue(cssVar).trim()); } catch {}
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Restore the saved width from a previous session (clamped to current limits).
    const saved = (() => { try { return parseInt(localStorage.getItem('colw' + cssVar), 10); } catch { return NaN; } })();
    if (!isNaN(saved)) root.style.setProperty(cssVar, clamp(saved, min, max) + 'px');
  }

  // Left handle: dragging right makes left rail wider
  makeDragger('handle-left', '--left-w', () => 220, 1, 70, 520);
  // Right handle: dragging left makes right rail wider (sign=-1)
  makeDragger('handle-right', '--right-w', () => 380, -1, 220, 700);
}
function enterFpv() {
  if (!cesiumOK) return;
  $('fpv').checked = true;
  state.fpv = true;
  $('fpv-hint').classList.remove('hidden');
  setFpvMouseMode(true);
  applyFpv();
}

// Capture zoom (focal mm) of the shot the aim editor is on — falls back to the waypoint's
// first zoom action. Keeps the FPV FOV, green box and readout in step with per-shot edits.
function activeShotFocal() {
  const wp = wpByIndex(state.selected);
  if (!wp) return null;
  const s = curAimShot(wp);
  if (s && s.zoomFocalLength != null) return s.zoomFocalLength;
  return wp.zoomFocalLength;
}

function setFpvFov() {
  if (!cesiumOK || !state.fpv) return;
  if (fpvZoomMode === 2) {
    let zoom = fpvManualZoom;
    if (zoom == null) zoom = zoomFromFocal(activeShotFocal()) || 3;
    viewer.camera.frustum.fov = Cesium.Math.toRadians(Math.max(2, WIDE_FOV_DEG / zoom));
  } else {
    viewer.camera.frustum.fov = Cesium.Math.toRadians(WIDE_FOV_DEG);
  }
  updateFpvOverlay();
}

function fpvAdjustZoom(delta) {
  if (!state.fpv) return;
  if (fpvManualZoom == null) {
    fpvManualZoom = zoomFromFocal(activeShotFocal()) || 3;
  }
  // Snap to whole numbers for clean steps; allow fine fractions below 3×
  const raw = fpvManualZoom + delta;
  fpvManualZoom = Math.max(1, Math.min(112, parseFloat(raw.toFixed(1))));
  fpvZoomMode = 2;
  setFpvFov();
}
// ---------------------------------------------------------------------------
// Global undo / redo — one history for EVERY route edit (aim yaw/tilt, height, route shift,
// name uniquify). Each entry is { label, undo(), redo() }; the top-bar ↶/↷ buttons and
// Ctrl+Z / Ctrl+Y walk it. Disk operations (renaming photo files) are deliberately NOT
// undoable and never enter this history. Cleared when a new route loads.
// ---------------------------------------------------------------------------
const histUndo = [];
const histRedo = [];

function pushHistory(entry) {
  histUndo.push(entry);
  histRedo.length = 0;
  setDirty(true);
  updateUndoButtons();
}

function doUndo() {
  const e = histUndo.pop();
  if (!e) return;
  e.undo();
  histRedo.push(e);
  setStatus('Undid: ' + e.label);
  updateUndoButtons();
}

function doRedo() {
  const e = histRedo.pop();
  if (!e) return;
  e.redo();
  histUndo.push(e);
  setStatus('Redid: ' + e.label);
  updateUndoButtons();
}

function clearHistory() {
  histUndo.length = 0;
  histRedo.length = 0;
  updateUndoButtons();
}

function updateUndoButtons() {
  const set = (id, en, tip) => {
    const b = $(id); if (!b) return;
    b.disabled = !en;
    if (tip) b.title = tip;
  };
  const uTop = histUndo[histUndo.length - 1], rTop = histRedo[histRedo.length - 1];
  set('btn-undo', histUndo.length > 0, uTop ? `Undo: ${uTop.label} (Ctrl+Z)` : 'Undo (Ctrl+Z)');
  set('btn-redo', histRedo.length > 0, rTop ? `Redo: ${rTop.label} (Ctrl+Y)` : 'Redo (Ctrl+Y)');
  // the aim panel's ↶/↷ act on the same global history
  set('aim-undo', histUndo.length > 0, uTop ? `Undo: ${uTop.label}` : 'Undo');
  set('aim-redo', histRedo.length > 0, rTop ? `Redo: ${rTop.label}` : 'Redo');
}

// ---- Live camera-aim editor (FPV): yaw + gimbal tilt of the selected waypoint ----
// Edits are TENTATIVE: adjusting a slider previews on the waypoint + FPV view, but the
// change only "sticks" when Confirmed. Navigating away or Cancelling reverts to the
// original values. Confirmed edits are recorded in the global history.
let aimDraft = null;        // { wpIndex, shot, origYaw, origTilt, origAlt } while previewing
const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180;
const round1 = (v) => parseFloat(v.toFixed(1));
const round2 = (v) => parseFloat(v.toFixed(2));

// Raw WPML lens token for a normalized wide/ir/zoom value (mirrors kmz.js's rawLensToken).
const rawLensToken = (n) => (n === 'wide' ? 'visable' : n);

function aimCurrentWp() { return state.selected >= 0 ? wpByIndex(state.selected) : null; }

// The photo action (shot) the aim editor is currently editing. state.aimShot is clamped to the
// waypoint's shot count. Waypoints with one shot always resolve to shot 0.
function aimShotList(wp) { return (wp && wp.photoShots) || []; }
function curAimShot(wp) {
  const shots = aimShotList(wp); if (!shots.length) return null;
  if (state.aimShot >= shots.length) state.aimShot = shots.length - 1;
  if (state.aimShot < 0) state.aimShot = 0;
  return shots[state.aimShot];
}

// Switch which shot the editor edits. Discards any unconfirmed preview on the current shot first.
function selectAimShot(k) {
  if (aimDraft) revertAim();
  state.aimShot = k;
  refreshAimControls();
  renderWpActions(aimCurrentWp()); // keep the Photo actions panel's highlighted row in sync
  if (state.fpv) applyFpv(); // re-aim the preview camera to the chosen shot
}

// Build the per-shot chips (only shown when a waypoint has >1 photo action).
function renderAimShots(shots) {
  const el = $('aim-shots'); if (!el) return;
  if (!shots || shots.length <= 1) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  // Follow Route shots already resolve to their actual lens set here (waylines carries a
  // snapshot of the route default), so this reflects the real camera used either way — no
  // separate "follow route" color.
  const bandCls = (s) => {
    const wide = s.lenses.includes('wide'), ir = s.lenses.includes('ir');
    if (wide && ir) return 'band-both';
    if (ir) return 'band-ir';
    if (s.lenses.includes('zoom')) return 'band-zoom';
    return 'band-wide';
  };
  el.innerHTML = '<span class="aim-shots-lbl">SHOT</span>' + shots.map((s) => {
    const active = s.index === state.aimShot ? ' active' : '';
    const tip = (s.name || 'shot ' + (s.index + 1)).replace(/"/g, '');
    return `<button class="aim-shot ${bandCls(s)}${active}" data-shot="${s.index}" title="${tip}">${s.index + 1}</button>`;
  }).join('');
}

function setAimRow(kind, v) {
  const inp = $('aim-' + kind);
  if (!inp) return;
  if (v == null) { inp.disabled = true; inp.value = '—'; return; }
  inp.disabled = false;
  // Don't overwrite what the user is mid-typing. Alt is shown in the chosen unit (m/ft);
  // yaw/tilt are always degrees.
  if (document.activeElement !== inp) inp.value = (kind === 'alt' ? toDisp(v) : v).toFixed(1);
}

function updateAimButtons() {
  const hasDraft = !!aimDraft;
  const setEn = (id, en) => { const b = $(id); if (b) b.disabled = !en; };
  setEn('aim-confirm', hasDraft);
  setEn('aim-cancel', hasDraft);
  updateUndoButtons(); // aim panel ↶/↷ mirror the global history
}

// Set a waypoint's AGL height to an exact value by bumping all height fields by the delta.
function setWpAgl(wp, targetAgl) {
  const cur = wp.aglHeight;
  if (cur == null) return;
  const delta = parseFloat((targetAgl - cur).toFixed(2));
  if (delta) wp.bumpHeight(delta);
}

function refreshAimControls() {
  const panel = $('fpv-aim');
  if (!panel) return;
  const wp = aimCurrentWp();
  if (!state.fpv || !wp) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const shots = aimShotList(wp);
  renderAimShots(shots);
  const s = curAimShot(wp);
  setAimRow('yaw', s ? s.aircraftHeading : wp.aircraftHeading);
  setAimRow('tilt', s ? s.gimbalPitch : wp.gimbalPitch);
  setAimRow('zoom', s && s.zoomFocalLength != null ? zoomFromFocal(s.zoomFocalLength) : null);
  setAimRow('alt', wp.aglHeight);
  updateAimButtons();
}

// Preview a yaw / tilt / zoom / alt change on the selected shot (not yet committed). Yaw/tilt/zoom
// act on state.aimShot; alt is shared across the waypoint's shots. skipFpv=true is used by FPV
// mouse-look, which has already oriented the camera itself and must not have its position snapped.
function applyAim(kind, value, skipFpv) {
  const wp = aimCurrentWp();
  if (!wp) return;
  const k = state.aimShot;
  const s = curAimShot(wp);
  // Begin a draft the first time this (waypoint, shot) is touched.
  if (!aimDraft || aimDraft.wpIndex !== wp.index || aimDraft.shot !== k) {
    aimDraft = { wpIndex: wp.index, shot: k,
      origYaw: s ? s.aircraftHeading : wp.aircraftHeading,
      origTilt: s ? s.gimbalPitch : wp.gimbalPitch,
      origZoom: s ? s.zoomFocalLength : null, // exact focal mm, so Cancel restores 52.8-style natives
      origAlt: wp.aglHeight };
  }
  if (kind === 'yaw') {
    if (!s || s.aircraftHeading == null) return; // no rotateYaw action to edit
    wp.setShotAircraftHeading(k, round1(wrap180(value)));
    setAimRow('yaw', (wp.photoShots[k] || {}).aircraftHeading);
  } else if (kind === 'tilt') {
    if (!s || s.gimbalPitch == null) return; // no gimbalRotate action to edit
    wp.setShotGimbalPitch(k, round1(Math.max(-90, Math.min(30, value))));
    setAimRow('tilt', (wp.photoShots[k] || {}).gimbalPitch);
  } else if (kind === 'zoom') { // capture zoom factor; 1/3/7 snap to native 24/70/168 mm
    if (!s || s.zoomFocalLength == null) return; // no zoom action to edit
    const z = Math.max(1, Math.min(112, value)); // FH2's hybrid-zoom ceiling is 112×
    const focal = Math.abs(z - 1) < 0.05 ? 24 : Math.abs(z - 3) < 0.05 ? 70
      : Math.abs(z - 7) < 0.05 ? 168 : parseFloat((round1(z) * WIDE_MM).toFixed(1));
    wp.setShotZoomFocalLength(k, focal);
    setAimRow('zoom', zoomFromFocal((wp.photoShots[k] || {}).zoomFocalLength));
    fpvManualZoom = null;   // pressing 2 (or being in zoom view) now shows the edited level
    setFpvFov();            // live FOV update if the zoom view is active
    updateFpvOverlay();     // green capture box resizes proportionally in the wide view
  } else { // alt (AGL height) — `value` is in the current display unit (m/ft)
    if (wp.aglHeight == null) return;
    const meters = Math.max(0, Math.min(300, fromDisp(value))); // clamp 0–300 m
    setWpAgl(wp, round2(meters));
    setAimRow('alt', wp.aglHeight);
  }
  if (!skipFpv) applyFpv(); // re-aim FPV camera + overlay + readouts live (preview)
  updateAimButtons();       // enable Confirm/Cancel
}

// Commit the current draft as a recorded (undoable) edit.
function confirmAim() {
  if (!aimDraft) return;
  const wp = wpByIndex(aimDraft.wpIndex);
  if (wp) {
    const s = (wp.photoShots || [])[aimDraft.shot] || {};
    const before = { yaw: aimDraft.origYaw, tilt: aimDraft.origTilt, zoom: aimDraft.origZoom, alt: aimDraft.origAlt };
    const after = { yaw: s.aircraftHeading, tilt: s.gimbalPitch, zoom: s.zoomFocalLength, alt: wp.aglHeight };
    if (before.yaw !== after.yaw || before.tilt !== after.tilt || before.zoom !== after.zoom || before.alt !== after.alt) {
      const wpIndex = wp.index, shot = aimDraft.shot;
      pushHistory({
        label: `aim edit WP ${wpIndex + 1}` + (shot ? ` shot ${shot + 1}` : ''),
        undo: () => applyAimRecord(wpIndex, shot, before),
        redo: () => applyAimRecord(wpIndex, shot, after),
      });
    }
  }
  aimDraft = null;
  updateAimButtons();
}

// Discard the current draft, restoring the waypoint to its pre-edit values.
function revertAim() {
  if (!aimDraft) return;
  const wp = wpByIndex(aimDraft.wpIndex);
  if (wp) {
    if (aimDraft.origYaw != null) wp.setShotAircraftHeading(aimDraft.shot, aimDraft.origYaw);
    if (aimDraft.origTilt != null) wp.setShotGimbalPitch(aimDraft.shot, aimDraft.origTilt);
    if (aimDraft.origZoom != null) wp.setShotZoomFocalLength(aimDraft.shot, aimDraft.origZoom);
    if (aimDraft.origAlt != null) setWpAgl(wp, aimDraft.origAlt);
  }
  const wasSelected = wp && wp.index === state.selected;
  aimDraft = null;
  if (state.fpv && wasSelected) { fpvManualZoom = null; applyFpv(); updateFpvOverlay(); }
  refreshAimControls();
}

// Apply a recorded edit's value set to a specific shot on its waypoint (used by undo/redo).
function applyAimRecord(wpIndex, shot, vals) {
  const wp = wpByIndex(wpIndex);
  if (!wp) return;
  if (vals.yaw != null) wp.setShotAircraftHeading(shot, vals.yaw);
  if (vals.tilt != null) wp.setShotGimbalPitch(shot, vals.tilt);
  if (vals.zoom != null) { wp.setShotZoomFocalLength(shot, vals.zoom); fpvManualZoom = null; }
  if (vals.alt != null) setWpAgl(wp, vals.alt);
  setDirty(true);
  if (state.fpv) selectWaypoint(wpIndex); // jump to the affected waypoint (may reset aimShot)
  state.aimShot = shot;                   // then focus the shot the edit belongs to
  if (state.fpv) applyFpv(); else refreshAimControls();
  updateAimButtons();
}

// The aim panel's ↶/↷ act on the global history. Any unconfirmed preview is discarded
// first so the undo applies to committed state, not a half-typed draft.
function undoAim() { if (aimDraft) revertAim(); doUndo(); }
function redoAim() { if (aimDraft) revertAim(); doRedo(); }

function setDirty(d) {
  state.dirty = d;
  $('dirty').classList.toggle('hidden', !d);
}

// ---------------------------------------------------------------------------
// Loaded-files badge — collapsed pill in the viewer's top-right corner; hover expands it to
// show which route / 3D model / photo set this window is working with (full path in tooltip).
// ---------------------------------------------------------------------------
function updateFilesBadge() {
  const base = (p) => (p ? String(p).split(/[\\/]/).pop() : null);
  const set = (id, name, full) => {
    const el = $(id); if (!el) return;
    el.textContent = name || '—';
    el.title = full || '';
    el.classList.toggle('files-missing', !name);
  };
  set('files-route', base(state.routePath), state.routePath);
  set('files-model', base(state.modelDir), state.modelDir);
  set('files-photos', state.photosFolderName || base(state.photosDir), state.photosDir);
  const n = [state.routePath, state.modelDir, state.photosDir].filter(Boolean).length;
  const cnt = $('files-badge-count'); if (cnt) cnt.textContent = n + '/3';
  const badge = $('files-badge');
  if (badge) badge.title = ''; // rows carry their own tooltips
}

// ---------------------------------------------------------------------------
// Route shift (RTK re-base) — translate the whole route E/N/Up so a route authored
// against one RTK correction source (mount point / dock antenna) aligns with another.
// Workflow: load the 3D model for the source you'll fly with, open the panel, nudge the
// route onto the structures, Done, then Export KMZ.
// ---------------------------------------------------------------------------
const shiftTotal = { e: 0, n: 0, u: 0 };
let renderShiftPresets = null; // set by initShiftPanel; re-rendered on unit toggle

function openShiftPanel() {
  if (!state.mission) { setStatus('Open a route first.'); return; }
  $('shift-panel').classList.remove('hidden');
  updateShiftReadout();
}

function applyShift(dE, dN, dU) {
  if (!state.mission) return;
  state.mission.shiftRoute(dE, dN, dU);
  shiftTotal.e += dE; shiftTotal.n += dN; shiftTotal.u += dU;
  // takeOffRefPoint moved with the route — refresh the cached altitude so AGL readouts stay right.
  const g = state.mission.globals();
  if (g.takeOffRefAltitude != null) state.takeOffRefAltitude = g.takeOffRefAltitude;
  setDirty(true);
  if (cesiumOK) { drawWaypoints(); if (state.fpv) applyFpv(); }
  updateShiftReadout();
}

function updateShiftReadout() {
  const el = $('shift-total'); if (!el) return;
  const u = hUnit();
  const f = (v) => toDisp(v).toFixed(2);
  el.textContent = `E ${f(shiftTotal.e)} · N ${f(shiftTotal.n)} · U ${f(shiftTotal.u)} ${u}`;
}

function initShiftPanel() {
  const step = () => {
    const v = parseFloat($('shift-step').value);
    return fromDisp(isNaN(v) ? 0.5 : Math.abs(v)); // step typed in the display unit (m/ft)
  };
  const fmtShift = (dE, dN, dU) => {
    const parts = [];
    if (dE) parts.push(`E${dE > 0 ? '+' : ''}${toDisp(dE).toFixed(2)}`);
    if (dN) parts.push(`N${dN > 0 ? '+' : ''}${toDisp(dN).toFixed(2)}`);
    if (dU) parts.push(`U${dU > 0 ? '+' : ''}${toDisp(dU).toFixed(2)}`);
    return parts.join(' ') + ' ' + hUnit();
  };
  document.querySelectorAll('#shift-panel .shift-nudge').forEach((btn) => {
    btn.onclick = () => {
      const dx = parseInt(btn.dataset.dx || '0', 10);
      const dy = parseInt(btn.dataset.dy || '0', 10);
      const dz = parseInt(btn.dataset.dz || '0', 10);
      const s = step(); if (!s) return;
      const dE = dx * s, dN = dy * s, dU = dz * s;
      applyShift(dE, dN, dU);
      pushHistory({
        label: 'route shift ' + fmtShift(dE, dN, dU),
        undo: () => applyShift(-dE, -dN, -dU),
        redo: () => applyShift(dE, dN, dU),
      });
    };
  });
  $('shift-reset').onclick = () => {
    if (shiftTotal.e || shiftTotal.n || shiftTotal.u) {
      const dE = -shiftTotal.e, dN = -shiftTotal.n, dU = -shiftTotal.u;
      applyShift(dE, dN, dU);
      shiftTotal.e = 0; shiftTotal.n = 0; shiftTotal.u = 0; // clear residual fp dust
      updateShiftReadout();
      pushHistory({
        label: 'route shift reset',
        undo: () => applyShift(-dE, -dN, -dU),
        redo: () => applyShift(dE, dN, dU),
      });
      setStatus('Route shift reset to original position.');
    }
  };
  const close = () => {
    $('shift-panel').classList.add('hidden');
    if (shiftTotal.e || shiftTotal.n || shiftTotal.u) {
      const u = hUnit(), f = (v) => toDisp(v).toFixed(2);
      setStatus(`Route shifted E ${f(shiftTotal.e)} / N ${f(shiftTotal.n)} / Up ${f(shiftTotal.u)} ${u} — Export KMZ to save.`);
    }
  };
  $('shift-done').onclick = close;
  $('shift-close').onclick = close;

  // ---- Saved RTK offsets (per-site, persisted) -----------------------------------
  // Measure a site's frame offset ONCE (align the route against the target source's model,
  // then Save the Applied total under a name like "Lavaca LOCAL→DOCK"). From then on, any
  // route on that site converts with one click: Apply (LOCAL→DOCK) or Apply ⇄ (DOCK→LOCAL).
  // Offsets are stored in metres; valid as long as the dock's self-surveyed base position
  // hasn't changed (re-survey/re-site the dock → re-measure the offset).
  const loadPresets = () => {
    try { const a = JSON.parse(localStorage.getItem('rtkOffsets') || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  };
  const storePresets = (arr) => { try { localStorage.setItem('rtkOffsets', JSON.stringify(arr)); } catch {} };
  const renderPresets = (selectName) => {
    const sel = $('shift-preset'); if (!sel) return;
    const cur = selectName != null ? selectName : sel.value;
    const f = (v) => toDisp(v).toFixed(2);
    sel.innerHTML = '<option value="">— pick a saved offset —</option>' + loadPresets().map((p) =>
      `<option value="${p.name.replace(/"/g, '&quot;')}">${p.name} (E ${f(p.e)} N ${f(p.n)} U ${f(p.u)} ${hUnit()})</option>`
    ).join('');
    if (cur) sel.value = cur;
  };
  const selectedPreset = () => loadPresets().find((p) => p.name === $('shift-preset').value) || null;
  const applyPreset = (sign, tag) => {
    const p = selectedPreset();
    if (!p) { setStatus('Pick a saved offset first.'); return; }
    if (!state.mission) { setStatus('Open a route first.'); return; }
    const dE = sign * p.e, dN = sign * p.n, dU = sign * p.u;
    applyShift(dE, dN, dU);
    pushHistory({
      label: `offset "${p.name}"${tag}`,
      undo: () => applyShift(-dE, -dN, -dU),
      redo: () => applyShift(dE, dN, dU),
    });
    setStatus(`Applied offset "${p.name}"${tag} — check alignment, then Export KMZ.`);
  };
  $('shift-apply-preset').onclick = () => applyPreset(1, '');
  $('shift-apply-preset-inv').onclick = () => applyPreset(-1, ' (reversed)');
  $('shift-save-preset').onclick = () => {
    const name = $('shift-preset-name').value.trim();
    if (!name) { setStatus('Type a name for the offset (e.g. "Lavaca LOCAL→DOCK").'); return; }
    if (!shiftTotal.e && !shiftTotal.n && !shiftTotal.u) {
      setStatus('Nothing to save — nudge the route into alignment first; the Applied total is what gets saved.');
      return;
    }
    const arr = loadPresets().filter((p) => p.name !== name); // overwrite same name
    arr.push({ name, e: round2(shiftTotal.e), n: round2(shiftTotal.n), u: round2(shiftTotal.u) });
    storePresets(arr);
    renderPresets(name);
    $('shift-preset-name').value = '';
    setStatus(`Saved offset "${name}" — reusable on any route via Apply / Apply ⇄.`);
  };
  // Save a preset from TYPED E/N/U offsets (e.g. values measured from a photo test flight).
  // Fields are in the current display unit (m/ft); blank counts as 0.
  $('shift-save-manual').onclick = () => {
    const name = $('shift-preset-name').value.trim();
    if (!name) { setStatus('Type a name first (e.g. "Office LOCAL→DOCK"), then Add.'); return; }
    const num = (id) => { const v = parseFloat($(id).value); return isNaN(v) ? 0 : fromDisp(v); };
    const e = num('shift-new-e'), n = num('shift-new-n'), u = num('shift-new-u');
    if (!e && !n && !u) { setStatus('Enter at least one E / N / U offset value.'); return; }
    const arr = loadPresets().filter((p) => p.name !== name);
    arr.push({ name, e: round2(e), n: round2(n), u: round2(u) });
    storePresets(arr);
    renderPresets(name);
    $('shift-preset-name').value = '';
    ['shift-new-e', 'shift-new-n', 'shift-new-u'].forEach((id) => { $(id).value = ''; });
    setStatus(`Saved offset "${name}" from typed values.`);
  };
  $('shift-del-preset').onclick = async () => {
    const p = selectedPreset();
    if (!p) { setStatus('Pick a saved offset to delete.'); return; }
    if (!(await confirmDialog(`Delete saved offset "${p.name}"?`))) return;
    storePresets(loadPresets().filter((x) => x.name !== p.name));
    renderPresets('');
  };
  renderShiftPresets = renderPresets;
  renderPresets('');
}

// ---------------------------------------------------------------------------
// Export KMZ
// ---------------------------------------------------------------------------
async function exportKmz() {
  if (!state.mission) { setStatus('No route loaded.'); return; }
  const buf = await state.mission.toBuffer('browser');
  const name = state.routeName || 'route-edited';
  const result = await window.api.saveKmz(buf, name);
  if (result) setStatus('Exported → ' + result.path);
}

// ---------------------------------------------------------------------------
// Reset session
// ---------------------------------------------------------------------------
async function resetSession() {
  if (!(await confirmDialog('Clear all loaded data and start a fresh session?'))) return;

  shiftTotal.e = 0; shiftTotal.n = 0; shiftTotal.u = 0;
  $('shift-panel').classList.add('hidden');
  clearHistory();

  // Tear down the Cesium scene FIRST, while we still hold references to what's loaded.
  if (cesiumOK) {
    stopFpvLoop();
    fpvKeys.clear();
    viewer.entities.removeAll();
    state.entities.points = [];
    state.entities.lines = [];
    state.entities.path = null;
    state.entities.heading = null;
    if (state.tileset) { try { viewer.scene.primitives.remove(state.tileset); } catch {} }
    if (state.imageryLayer) { try { viewer.imageryLayers.remove(state.imageryLayer); } catch {} }
    if (state.labelsLayer) { try { viewer.imageryLayers.remove(state.labelsLayer); } catch {} }
    if (state.roadsLayer) { try { viewer.imageryLayers.remove(state.roadsLayer); } catch {} }
    viewer.camera.frustum.fov = Cesium.Math.toRadians(60);
    setFpvMouseMode(false); // restore map mouse controls + cursor
  }

  // Clear all session state
  state.mission = null;
  state.routeName = 'route-edited';
  state.routePath = null;
  state.modelDir = null;
  state.photosDir = null;
  state.photosDirCreatedAt = null;
  state.photosFolderName = null;
  state.selected = -1;
  state.dirty = false;
  state.photos = [];
  state.photoByWp = new Map();
  state.imageryLayer = null;
  state.labelsLayer = null;
  state.roadsLayer = null;
  state.tileset = null;
  state.modelLoaded = false;
  state.placingWaypoint = false;
  state.fpv = false;
  state.routeBounds = null;
  state.takeOffRefAltitude = null;
  state.stripFilter = null;
  updateFilesBadge();
  syncCreateRouteEnabled();
  exitPlacingWaypoint();

  // Reset all UI controls to their initial state
  $('route-name').value = 'route-edited';
  const fpvCb = $('fpv'); if (fpvCb) fpvCb.checked = false;
  if (cesiumOK) enableDefaultImagery(); // back to the plain-map default until a model is loaded again
  $('fpv-hint').classList.add('hidden');
  $('fpv-alt').classList.add('hidden');
  $('fpv-aim').classList.add('hidden');
  $('fpv-overlay').classList.add('hidden');
  const search = $('photo-search'); if (search) search.value = '';
  document.querySelectorAll('#strip-filters .strip-filter').forEach((b) =>
    b.classList.toggle('active', b.dataset.band === 'all'));
  $('viewer-empty').classList.remove('hidden'); // show the "Open a route to begin" overlay

  renderList();
  renderPhotos();
  renderImageInfo(null);
  renderWpActions(null);
  state.editingShotName = null;
  state.aircraftIrOverride = true;
  renderCameraSettingsRow();
  $('ph-count').textContent = '—';
  $('sel-idx').textContent = 'none';
  setStatus('Session cleared — open a route to begin.');
}

// ---------------------------------------------------------------------------
// Rename matched photos on disk to embed the WP's unique fileSuffix
// ---------------------------------------------------------------------------
async function renameMatchedPhotos() {
  if (!state.mission || !state.photos.length) {
    setStatus('Load a route and photos first.');
    return;
  }

  // Verify all WP photo-action names are unique — renaming is useless otherwise.
  const shooterWps = state.mission.waypoints.filter((w) => w.hasPhotoAction);
  const names = shooterWps.map((w) => w.photoActionName).filter(Boolean);
  const unique = new Set(names);
  if (unique.size < names.length || names.length < shooterWps.length) {
    if (!(await confirmDialog(
      'Some waypoints share the same photo name or have no name.\n\n' +
      'Run "Uniquify WP names" first (Route menu), then Export KMZ before renaming photos.\n\n' +
      'Continue anyway? (photos without a unique WP name will be skipped)'
    ))) return;
  }

  // Count how many photos will be renamed.
  let total = 0;
  for (const [, photos] of state.photoByWp) {
    for (const p of photos) {
      if (p.type !== 'video') total++;
    }
  }
  if (!total) { setStatus('No matched photos to rename.'); return; }

  if (!(await confirmDialog(
    `Rename ${total} photos on disk?\n\n` +
    'Each file will be renamed so its DJI action-name matches its assigned waypoint.\n' +
    'This cannot be undone automatically — make a copy of the folder first if unsure.'
  ))) return;

  // DJI filename up to and including the band char: DJI_YYYYMMDDHHMMSS_SEQNUM_BAND
  // Everything after (the old action name) is replaced with the WP's current suffix.
  const BASE_RE = /^(DJI_\d+_\d+_[TWZV])(?:_.+)?(\.[^.]+)$/i;

  let renamed = 0, skipped = 0, errors = 0;
  for (const [wpIdx, photos] of state.photoByWp) {
    const wp = state.mission.waypoints[wpIdx];
    const suffix = wp && wp.photoActionName;
    if (!suffix) { skipped += photos.length; continue; }

    for (const p of photos) {
      if (p.type === 'video') continue;
      const m = p.name.match(BASE_RE);
      if (!m) { skipped++; continue; }

      const newName = m[1] + '_' + suffix + m[2];
      if (newName === p.name) { skipped++; continue; } // already correct

      const result = await window.api.renamePhoto(p.name, newName);
      if (result && result.ok) {
        // Update in-memory state so the UI reflects the new name.
        p.name = newName;
        p.url = 'appfile://photos/' + encodeURIComponent(newName);
        if (p.thumb && p.thumb.startsWith('appfile://')) {
          p.thumb = p.url;
        }
        p.photoActionName = suffix;
        renamed++;
      } else {
        console.warn('rename failed:', p.name, '→', newName, result && result.error);
        errors++;
      }
    }
  }

  setStatus(`Renamed ${renamed} photos${skipped ? `, ${skipped} skipped` : ''}${errors ? `, ${errors} errors` : ''}.`);
  renderPhotos();
  if (state.selected >= 0) renderImageInfo(state.photoByWp.get(state.selected)?.[0] ?? null);
}

// ---------------------------------------------------------------------------
// Uniquify WP photo-action names
// ---------------------------------------------------------------------------
function uniquifyWpNames() {
  if (!state.mission) { setStatus('No route loaded.'); return; }
  // Chars: uppercase alpha + digits, excluding visually ambiguous I/O/0/1
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const gen6 = () => Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

  // Count how many WPs share each photoActionName
  const counts = new Map();
  for (const wp of state.mission.waypoints) {
    if (!wp.hasPhotoAction) continue;
    const n = wp.photoActionName || '';
    counts.set(n, (counts.get(n) || 0) + 1);
  }

  // All names already assigned (to avoid collisions when generating new ones)
  const taken = new Set(state.mission.waypoints.map((wp) => wp.photoActionName).filter(Boolean));

  const changes = []; // { i, before, after } per renamed waypoint — feeds undo/redo
  for (const wp of state.mission.waypoints) {
    if (!wp.hasPhotoAction) continue;
    const base = wp.photoActionName || '';
    if (counts.get(base) <= 1 && base) continue; // already unique

    let code;
    let candidate;
    do {
      code = gen6();
      candidate = base ? base + '-' + code : code;
    } while (taken.has(candidate));

    taken.add(candidate);
    changes.push({ i: wp.index, before: base, after: candidate });
    wp.setPhotoActionName(candidate);
  }

  if (changes.length > 0) {
    const applyNames = (key) => {
      for (const c of changes) {
        const wp = wpByIndex(c.i);
        if (wp) wp.setPhotoActionName(c[key]);
      }
      renderList();
      setDirty(true);
    };
    pushHistory({
      label: `uniquify ${changes.length} WP names`,
      undo: () => applyNames('before'),
      redo: () => applyNames('after'),
    });
    setStatus(`Uniquified ${changes.length} WP photo names — export KMZ to save.`);
    renderList();
  } else {
    setStatus('All WP photo names are already unique — no changes needed.');
  }
}

// ---------------------------------------------------------------------------
// Route open / draw
// ---------------------------------------------------------------------------
async function openRoute() {
  const res = await window.api.openKmz();
  if (!res) return;
  await applyRoute(res);
}

async function applyRoute(res) {
  try {
    state.mission = await loadMission(res.buffer);
  } catch (e) {
    setStatus('Could not open route: ' + e.message);
    return;
  }
  state.routePath = res.path || null;
  state.routeName = res.name + '-edited';
  $('route-name').value = state.routeName;
  state.selected = -1;
  $('viewer-empty').classList.add('hidden');
  setDirty(false);
  // Fresh route = fresh shift baseline and fresh edit history (old entries reference old objects).
  shiftTotal.e = 0; shiftTotal.n = 0; shiftTotal.u = 0;
  $('shift-panel').classList.add('hidden');
  updateShiftReadout();
  updateFilesBadge();
  clearHistory();
  state.aircraftIrOverride = true; // fresh route defaults to IR-capable; operator disables per-route if needed
  renderList();
  matchPhotos();
  drawWaypoints();
  fitView();
  renderCameraSettingsRow();
  const g = state.mission.globals();
  state.takeOffRefAltitude = g.takeOffRefAltitude ?? null; // cached for FPV AGL readout

  // Pick a sensible height reference: routes whose heights are small (or flagged relative)
  // are stored above the takeoff point, so default to ALT + the takeoff ground altitude.
  const maxH = Math.max(0, ...state.mission.waypoints.map((w) => w.height || 0));
  const looksRelative = g.heightMode === 'relativeToStartPoint' || maxH < 300;
  const sel = $('height-mode'), groundField = $('ground-alt');
  if (sel) {
    if (looksRelative) {
      sel.value = 'alt';
      // Prefer the route's own takeoff altitude; else reuse the last ground you entered
      // (same site usually = same value). If neither, the Auto button reads it off the model.
      let g = state.takeOffRefAltitude;
      if (g == null) { try { const s = parseFloat(localStorage.getItem('lastGroundAlt')); if (!isNaN(s)) g = s; } catch {} }
      if (groundField) groundField.value = (g != null ? toDisp(g).toFixed(1) : '');
    } else {
      sel.value = 'absolute';
    }
    applyHeightMode();
  }

  setStatus(`Loaded ${state.mission.waypoints.length} waypoints · height mode ${g.heightMode || 'unknown'}` +
    (looksRelative ? ' · placed via ALT reference' : ''));
}

function renderList(query) {
  const body = $('wp-body');
  body.innerHTML = '';
  if (!state.mission) return;
  const wps = state.mission.waypoints;
  $('wp-count').textContent = wps.length;

  // Filter: match waypoint number (1-based) OR photoActionName (case-insensitive substring)
  const q = (query || '').toLowerCase();
  const visible = q
    ? wps.filter((wp) => {
        const num = String(wp.index + 1);
        const name = (wp.photoActionName || '').toLowerCase();
        return num.includes(q) || name.includes(q);
      })
    : wps;

  // Remember what's shown (in display order) so ArrowUp/Down steps through the filtered
  // results rather than the full sequence.
  state.visibleWpIndices = visible.map((wp) => wp.index);

  const photosLoaded = state.photos.length > 0;
  visible.forEach((wp) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = wp.index;
    if (wp.index === state.selected) tr.classList.add('sel');
    const photos = state.photoByWp.get(wp.index) || [];
    // With photos loaded: show how many matched this waypoint. Before loading: show how many
    // photo ACTIONS are planned here — one fixed-angle shot counts as 1 even if it captures both
    // Visible and IR (that split is a lens choice, decided in the Photo actions panel, not a
    // second action) — styled dimmer.
    let cell = '';
    if (photosLoaded) {
      if (photos.length) cell = `<span class="img-count">${photos.length}</span>`;
    } else {
      const ex = wp.photoActions.length;
      if (ex) cell = `<span class="img-count expected" title="${ex} photo action${ex === 1 ? '' : 's'} planned at this waypoint">${ex}</span>`;
    }
    tr.innerHTML = `<td class="mono">${wp.index + 1}</td><td class="ph">${cell}</td>`;
    tr.onclick = () => selectWaypoint(wp.index);
    tr.ondblclick = () => { selectWaypoint(wp.index); enterFpv(); };
    body.appendChild(tr);
  });
}

function renderPhotoSearch(query) {
  const strip = $('photo-strip');
  strip.innerHTML = '';
  if (!query || !state.photos.length) {
    strip.innerHTML = '<div class="hint">Type to search images.</div>';
    return;
  }
  const q = query.toLowerCase();
  let matches = state.photos.filter((p) => p.name.toLowerCase().includes(q));
  if (state.stripFilter) matches = matches.filter((p) => p.band === state.stripFilter);
  if (!matches.length) {
    strip.innerHTML = `<div class="hint">No images match "${query}".</div>`;
    return;
  }
  matches.forEach((p) => strip.appendChild(makeThumb(p, state.photos, state.photos.indexOf(p))));
}

function fmt(v) { return v === null || v === undefined || Number.isNaN(v) ? '·' : v; }
function lensDots(list) {
  const map = { wide: '#4fd1e0', zoom: '#9b8cff', ir: '#ff7a59' };
  return ['wide', 'zoom', 'ir'].map((k) =>
    `<span class="dot" style="background:${list.includes(k) ? map[k] : 'transparent'};border-color:${map[k]}"></span>`
  ).join('');
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function selectWaypoint(index, opts = {}) {
  // Leaving a waypoint with an unconfirmed aim edit discards it (back to original).
  if (aimDraft && aimDraft.wpIndex !== index) revertAim();
  if (index !== state.selected) { state.aimShot = 0; state.editingShotName = null; } // start on the first shot of a new waypoint
  state.selected = index;
  const wp = wpByIndex(index);
  if (!wp) return;
  $('sel-idx').textContent = '#' + (index + 1);

  document.querySelectorAll('#wp-body tr').forEach((tr) => {
    tr.classList.toggle('sel', parseInt(tr.dataset.idx, 10) === index);
  });

  // Reset image info panel when switching waypoints; show this WP's photo actions.
  renderImageInfo(null);
  renderWpActions(wp);

  // Clear photo search when navigating to a waypoint
  const photoSearch = $('photo-search');
  if (photoSearch && photoSearch.value) { photoSearch.value = ''; }
  renderPhotos(index);
  highlightWaypoint(index, opts);
  if (state.fpv) updateFpvOverlay();
}

// A shot's planned name/label must be safe for FlightHub the same way a route name is (no
// underscores or other forbidden characters) — but unlike a route name, an empty label is fine
// (it just means "unnamed").
function validateShotName(name) {
  if (!name) return { ok: true, message: '' };
  return validateRouteName(name);
}

// DJI's placeholder prefix for a shot's real captured filename, filled in by the drone at flight
// time: DJI_<14-digit datetime>_<4-digit seq>_<band letter(s)>_ — band letter per lens (V=visible,
// T=thermal/IR, Z=zoom); a shot with more than one lens produces one file per lens, same label.
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
// DJI's placeholder prefix for a shot's real captured filename, filled in by the drone at flight
// time. Photos: DJI_<14-digit datetime>_<4-digit seq>_<band letter(s)>_ (V=visible, T=thermal/IR,
// Z=zoom; more than one lens produces one file per lens, same label). Recordings use a shorter
// placeholder with no band letter (FlightHub's own convention — a recording session isn't split
// into per-lens files the same way a single photo shot is).
function djiNamePrefix(a) {
  if (a.func === 'startRecord') return 'DJI_YYYYMMDDhhmm_XXX_';
  const letters = { wide: 'V', ir: 'T', zoom: 'Z' };
  const bands = (a.lenses && a.lenses.length ? a.lenses : ['wide']).map((l) => letters[l] || 'V');
  return `DJI_YYYYMMDDhhmmss_XXXX_${[...new Set(bands)].join('/')}_`;
}

// Actions with no name/lens config of their own (kmz.js's _photoActionInfo returns null for
// these) — shown as a simple labelled row with just a delete button.
const SIMPLE_ACTION_LABELS = { panoShot: '360° Panorama', stopRecord: '■ Stop Recording' };

// Show the selected waypoint's actions: photo/recording shots get the full per-shot name editor
// (DJI-format placeholder prefix + editable label, Confirm-gated) + clickable VISIBLE/IR/Follow-
// Route pills; pano/stop-recording get a simple confirmation row. Every row has a delete button.
function renderWpActions(wp) {
  const el = $('wp-actions'); if (!el) return;
  if (!wp) { el.innerHTML = '<div class="info-hint">—</div>'; $('wp-act-count').textContent = '—'; return; }
  const acts = wp.photoShots || [];
  $('wp-act-count').textContent = acts.length || '0';
  if (!acts.length) { el.innerHTML = '<div class="info-hint">No actions at this waypoint.</div>'; return; }
  const multi = acts.length > 1;
  el.innerHTML = acts.map((a, i) => {
    const num = multi ? `<span class="wp-act-no">${i + 1}</span>` : '';
    const sel = multi && i === state.aimShot ? ' shot-active' : '';
    const clickable = multi ? ' wp-act-pick' : '';
    const deleteBtn = `<button class="wp-act-delete-btn" data-shot="${i}" title="Delete this action">🗑</button>`;

    const nameable = a.func === 'takePhoto' || a.func === 'orientedShoot' || a.func === 'startRecord';
    let bodyHtml;
    if (!nameable) {
      bodyHtml = `<div class="wp-act-name">${SIMPLE_ACTION_LABELS[a.func] || a.func}</div>`;
    } else {
      let nameHtml;
      if (state.editingShotName === i) {
        nameHtml = `<div class="wp-act-name-editor">
          <span class="wp-act-name-prefix">${djiNamePrefix(a)}</span>
          <input type="text" class="wp-act-name-input" data-shot="${i}" value="${escapeAttr(a.name || '')}" />
          <button class="wp-name-action confirm wp-act-name-confirm" data-shot="${i}" title="Confirm (Enter)">✓</button>
          <button class="wp-name-action cancel wp-act-name-cancel" data-shot="${i}" title="Discard (Esc)">✗</button>
        </div>`;
      } else {
        const nm = a.name ? a.name : '<span class="info-dim">(unnamed)</span>';
        nameHtml = `<div class="wp-act-name-view">
          <span class="wp-act-name">${djiNamePrefix(a)}${nm}</span>
          <button class="wp-act-name-edit-btn" data-shot="${i}" title="Edit this shot's name">✎</button>
        </div>`;
      }

      const wideOn = a.lenses.includes('wide'), irOn = a.lenses.includes('ir');
      const disabled = a.followRoute ? 'disabled' : '';
      const irDisabled = (a.followRoute || !aircraftHasIr()) ? 'disabled' : '';
      // "Follow Route" exists for orientedShoot and startRecord in this schema — takePhoto always
      // carries its own explicit lens list (verified against a real FlightHub-exported KMZ).
      const followPill = (a.func === 'orientedShoot' || a.func === 'startRecord')
        ? `<button class="lens-pill follow${a.followRoute ? ' active' : ''}" data-shot="${i}" data-follow="1" title="Follow the route's default lens set (Camera Settings)">FOLLOW ROUTE</button>`
        : '';
      const lensRow = `<div class="wp-act-lenses">
        <button class="lens-pill wide${wideOn ? ' active' : ''}" data-shot="${i}" data-lens="wide" ${disabled}>VISIBLE</button>
        <button class="lens-pill ir${irOn ? ' active' : ''}" data-shot="${i}" data-lens="ir" ${irDisabled} ${irDisabled ? 'title="This aircraft has no IR sensor"' : ''}>IR</button>
        ${followPill}
      </div>`;
      bodyHtml = nameHtml + lensRow;
    }

    return `<div class="wp-act${clickable}${sel}" data-shot="${i}" ${multi ? 'title="Click to edit this shot in the camera-aim editor"' : ''}>${num}<div class="wp-act-body">${bodyHtml}</div>${deleteBtn}</div>`;
  }).join('');

  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.wp-act-name-edit-btn');
      if (editBtn) {
        state.editingShotName = parseInt(editBtn.dataset.shot, 10);
        renderWpActions(aimCurrentWp());
        const input = el.querySelector('.wp-act-name-input');
        if (input) { input.focus(); input.select(); }
        return;
      }
      const cancelBtn = e.target.closest('.wp-act-name-cancel');
      if (cancelBtn) { state.editingShotName = null; renderWpActions(aimCurrentWp()); return; }
      const confirmBtn = e.target.closest('.wp-act-name-confirm');
      if (confirmBtn) { confirmShotName(parseInt(confirmBtn.dataset.shot, 10)); return; }
      const deleteBtn = e.target.closest('.wp-act-delete-btn');
      if (deleteBtn) { deleteWpShotAction(parseInt(deleteBtn.dataset.shot, 10)); return; }
      const lensPill = e.target.closest('.lens-pill');
      if (lensPill && !lensPill.disabled) {
        const k = parseInt(lensPill.dataset.shot, 10);
        if (lensPill.dataset.follow) toggleShotFollowRoute(k);
        else toggleShotLens(k, lensPill.dataset.lens);
        return;
      }
      // .wp-act-pick is only present on rows the CURRENT render marked multi-shot-pickable —
      // don't gate on the `multi` closure var, it's stale after the first wiring (this listener
      // is attached once, but re-renders for different waypoints happen on every selection).
      const row = e.target.closest('.wp-act-pick');
      if (row) selectAimShot(parseInt(row.dataset.shot, 10)); // re-renders this panel itself
    });
    el.addEventListener('keydown', (e) => {
      const input = e.target.closest('.wp-act-name-input'); if (!input) return;
      if (e.key === 'Enter') { e.preventDefault(); confirmShotName(parseInt(input.dataset.shot, 10)); }
      else if (e.key === 'Escape') { e.preventDefault(); state.editingShotName = null; renderWpActions(aimCurrentWp()); }
    });
  }
}

// Confirm an in-progress shot-name edit (Photo actions panel) and write it into the route.
function confirmShotName(k) {
  const wp = aimCurrentWp(); if (!wp) return;
  const el = $('wp-actions');
  const input = el && el.querySelector(`.wp-act-name-input[data-shot="${k}"]`);
  if (!input) return;
  const value = input.value.trim();
  const v = validateShotName(value);
  if (!v.ok) { setStatus(v.message); return; }
  const before = (wp.photoShots[k] || {}).name || '';
  wp.setShotPhotoActionName(k, value);
  state.editingShotName = null;
  setDirty(true);
  renderWpActions(wpByIndex(state.selected));
  pushHistory({
    label: `rename shot ${k + 1} · WP ${wp.index + 1}`,
    undo: () => { wp.setShotPhotoActionName(k, before); setDirty(true); renderWpActions(wpByIndex(state.selected)); },
    redo: () => { wp.setShotPhotoActionName(k, value); setDirty(true); renderWpActions(wpByIndex(state.selected)); },
  });
  setStatus(`Renamed shot ${k + 1} on WP ${wp.index + 1} — Export KMZ to save.`);
}

// Toggle one shot's VISIBLE/IR lens selection (only while it's NOT following the route default).
function toggleShotLens(k, lens) {
  const wp = aimCurrentWp(); if (!wp) return;
  const shot = wp.photoShots[k]; if (!shot || shot.followRoute) return;
  const before = shot.lenses.slice();
  if (lens === 'ir' && !before.includes('ir') && !aircraftHasIr()) {
    setStatus('This aircraft has no IR sensor — mark it IR-capable first if that\'s wrong.');
    return;
  }
  const after = before.includes(lens) ? before.filter((l) => l !== lens) : [...before, lens];
  applyShotLenses(wp, k, before, after);
}

// Toggle a shot between an explicit Visible/IR override and following the route's default.
function toggleShotFollowRoute(k) {
  const wp = aimCurrentWp(); if (!wp) return;
  const shot = wp.photoShots[k]; if (!shot) return;
  const wasFollowing = shot.followRoute;
  const beforeLenses = shot.lenses.slice();
  const refresh = () => { setDirty(true); renderWpActions(wpByIndex(state.selected)); if (state.fpv) updateFpvOverlay(); };
  if (wasFollowing) {
    // Turning it off: keep whatever lenses were currently displayed (the resolved route default).
    wp.setShotLenses(k, { followRoute: false, lenses: beforeLenses });
  } else {
    wp.setShotLenses(k, { followRoute: true, lenses: beforeLenses });
  }
  refresh();
  pushHistory({
    label: `${wasFollowing ? 'unlink' : 'follow route'} · shot ${k + 1} WP ${wp.index + 1}`,
    undo: () => { wp.setShotLenses(k, { followRoute: wasFollowing, lenses: beforeLenses }); refresh(); },
    redo: () => { wp.setShotLenses(k, { followRoute: !wasFollowing, lenses: beforeLenses }); refresh(); },
  });
}

function applyShotLenses(wp, k, before, after) {
  const refresh = () => { setDirty(true); renderWpActions(wpByIndex(state.selected)); if (state.fpv) updateFpvOverlay(); };
  wp.setShotLenses(k, { followRoute: false, lenses: after });
  refresh();
  pushHistory({
    label: `set lenses · shot ${k + 1} WP ${wp.index + 1}`,
    undo: () => { wp.setShotLenses(k, { followRoute: false, lenses: before }); refresh(); },
    redo: () => { wp.setShotLenses(k, { followRoute: false, lenses: after }); refresh(); },
  });
}

// Delete ONE action (shot index k) from the selected waypoint — no confirmation, matches the
// other per-shot edits (lens/name) which are all immediate and just an undo away.
function deleteWpShotAction(k) {
  const wp = aimCurrentWp(); if (!wp) return;
  const rec = wp.deleteShot(k);
  const refresh = () => {
    setDirty(true);
    renderWpActions(wpByIndex(state.selected));
    if (cesiumOK) { drawWaypoints(); if (state.fpv) { updateFpvOverlay(); refreshAimControls(); } }
  };
  refresh();
  pushHistory({
    label: `delete action ${k + 1} · WP ${wp.index + 1}`,
    undo: () => { rec.undo(); refresh(); },
    redo: () => { rec.redo(); refresh(); },
  });
  setStatus(`Deleted action ${k + 1} on WP ${wp.index + 1} — Export KMZ to save.`);
}

// Delete the whole selected waypoint (and every action on it). Bound to the Delete key. Confirmed
// first since, unlike a single action, this also shifts every later waypoint's index down by one.
async function deleteSelectedWaypoint() {
  const wp = wpByIndex(state.selected);
  if (!wp) return;
  const idx = wp.index;
  if (!(await confirmDialog(`Delete waypoint ${idx + 1}? This removes all of its actions too.`))) return;
  const rec = state.mission.deleteWaypoint(idx);
  const refresh = () => { setDirty(true); renderList(); drawWaypoints(); };
  const selectAfterDelete = () => {
    const remaining = state.mission.waypoints.length;
    selectWaypoint(remaining ? Math.min(idx, remaining - 1) : -1);
  };
  refresh();
  selectAfterDelete();
  pushHistory({
    label: `delete waypoint ${idx + 1}`,
    undo: () => { rec.undo(); refresh(); selectWaypoint(idx); },
    redo: () => { rec.redo(); refresh(); selectAfterDelete(); },
  });
  setStatus(`Deleted waypoint ${idx + 1} — Export KMZ to save.`);
}

// Best-effort friendly label for the route's aircraft/payload — from DJI's published WPML enum
// (https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/dji-wpml/common-element.html)
// where known. The Matrice 4 series isn't in DJI's published table as of this writing (both an
// M4D-only and an M4TD route report the same droneEnumValue/droneSubEnumValue), so its variant
// (E/T/D/TD) can't be told apart from these codes alone — labeled generically. IR capability is a
// separate, manually-set toggle (see aircraftHasIr), not inferred from these codes.
const DRONE_LABELS = {
  60: 'M300 RTK', 67: 'M30/M30T', 77: 'M3E/M3T/M3M', 89: 'M350 RTK', 91: 'M3D/M3TD',
  // Not in DJI's published table as of this writing — confirmed empirically (an M4D-only route
  // and an M4TD route both report 100/1), so the exact camera variant isn't encoded here.
  100: 'Matrice 4-series (E/T/D/TD — exact camera not encoded in WPML)',
};
function droneLabel(mission) {
  if (!mission) return '—';
  const g = mission.globals();
  if (!g.droneEnumValue) return '—';
  const code = `${g.droneEnumValue}/${g.droneSubEnumValue ?? '?'}`;
  const known = DRONE_LABELS[parseInt(g.droneEnumValue, 10)];
  return known ? `${known} (code ${code})` : `Unknown aircraft (code ${code})`;
}

// Whether the aircraft's camera has an IR/thermal sensor at all. WPML's drone/payload codes don't
// reliably disambiguate this for the Matrice 4 series (verified: an M4D-only route and an M4TD
// route report identical codes), so this isn't auto-detected — it defaults ON (the operator's
// primary aircraft is IR-capable) and the operator disables it manually for the rare Visible-only
// (M4D/M4E/M3E/M30) mission.
function aircraftHasIr() { return state.aircraftIrOverride; }

function renderCameraSettingsRow() {
  const label = $('drone-info-label'); if (label) label.textContent = droneLabel(state.mission);
  const irOk = aircraftHasIr();
  const irSupportBtn = $('ir-support-toggle');
  if (irSupportBtn) {
    irSupportBtn.classList.toggle('active', irOk);
    irSupportBtn.title = irOk
      ? 'This aircraft is treated as IR-capable — click to mark it Visible-only (e.g. Matrice 4D/3E/30).'
      : 'This aircraft is treated as Visible-only (no IR sensor) — click if it actually has IR/thermal.';
  }
  const row = $('camera-settings-row'); if (!row) return;
  const list = state.mission ? state.mission.globalLenses : [];
  const wideBtn = $('glens-wide'), irBtn = $('glens-ir');
  if (wideBtn) wideBtn.classList.toggle('active', list.includes('wide'));
  if (irBtn) {
    irBtn.classList.toggle('active', list.includes('ir'));
    irBtn.disabled = !irOk;
    irBtn.title = irOk ? '' : 'This aircraft has no IR sensor';
  }
}

function toggleIrSupport() {
  state.aircraftIrOverride = !aircraftHasIr();
  renderCameraSettingsRow();
  renderWpActions(wpByIndex(state.selected));
}

function toggleGlobalLens(lens) {
  const mission = state.mission; if (!mission) return;
  if (lens === 'ir' && !mission.globalLenses.includes('ir') && !aircraftHasIr()) {
    setStatus('This aircraft has no IR sensor — mark it IR-capable first if that\'s wrong.');
    return;
  }
  const before = mission.globalLenses.slice();
  const after = before.includes(lens) ? before.filter((l) => l !== lens) : [...before, lens];
  const refresh = () => {
    setDirty(true);
    renderCameraSettingsRow();
    renderWpActions(wpByIndex(state.selected));
    if (state.fpv) updateFpvOverlay();
  };
  mission.globalLenses = after;
  refresh();
  pushHistory({
    label: 'set route default lenses (Camera Settings)',
    undo: () => { mission.globalLenses = before; refresh(); },
    redo: () => { mission.globalLenses = after; refresh(); },
  });
}

// Add a new action to the selected waypoint (Photo actions bar + F key in FPV). For a
// fixed-angle photo in the camera view, the current FPV camera aim + zoom are baked in.
// Minimum 3D move (metres) from the waypoint's actual position before a photo gets its own
// new waypoint instead of being baked onto the one you were at — small enough to catch a
// deliberate W/S/A/D/C/Z nudge, large enough to ignore GPS/float jitter.
const REPOSITION_THRESHOLD_M = 0.5;

function addWpAction(kind) {
  const wp = wpByIndex(state.selected);
  if (!wp) { setStatus('Select a waypoint first.'); return; }
  const mission = state.mission;
  const opts = {};
  if (kind === 'takePhotoFixed' && state.fpv && cesiumOK) {
    opts.heading = round1(wrap180(Cesium.Math.toDegrees(viewer.camera.heading)));
    opts.pitch = round1(Math.max(-90, Math.min(30, Cesium.Math.toDegrees(viewer.camera.pitch))));
    const f = activeShotFocal(); if (f != null) opts.focal = f;
  }
  if (kind === 'takePhotoFixed' || kind === 'startRecord') {
    // A brand-new shot defaults to "Follow Route" (the operator can disable it per-shot
    // afterward) — opts.lens still carries the resolved value for the waylines snapshot, and
    // never includes IR on an aircraft that isn't IR-capable even if the route's own default does.
    let routeLenses = (mission && mission.globalLenses.length) ? mission.globalLenses : ['wide', 'ir'];
    if (!aircraftHasIr()) routeLenses = routeLenses.filter((l) => l !== 'ir');
    opts.lens = routeLenses.map(rawLensToken).join(',');
    opts.useGlobalLens = 1;
  }

  const labels = { takePhotoFixed: 'fixed-angle photo', pano: 'pano', startRecord: 'start recording', stopRecord: 'stop recording' };
  const label = labels[kind] || 'action';

  // If the FPV camera has moved away from this waypoint's actual position/height, the shot
  // belongs at a NEW waypoint — flying to the old one and shooting from the new vantage would be
  // wrong — rather than baked onto the existing one.
  if (kind === 'takePhotoFixed' && state.fpv && cesiumOK && wp.coordinates && mission) {
    const wpPos = Cesium.Cartesian3.fromDegrees(wp.coordinates.lng, wp.coordinates.lat, wpDisplayHeight(wp));
    const delta = Cesium.Cartesian3.distance(wpPos, viewer.camera.position);
    if (delta >= REPOSITION_THRESHOLD_M) {
      const cc = viewer.camera.positionCartographic;
      const coordinates = { lng: Cesium.Math.toDegrees(cc.longitude), lat: Cesium.Math.toDegrees(cc.latitude) };
      const absHeight = cc.height - (state.heightOffset || 0);
      const rec = mission.insertWaypointAfter(wp.index, { coordinates, absHeight }, opts);
      const insertedAt = rec.waypoint.index;
      const refreshTo = (selIndex) => {
        setDirty(true);
        state.selected = selIndex;
        renderList();
        renderWpActions(wpByIndex(state.selected));
        if (cesiumOK) { drawWaypoints(); if (state.fpv) { updateFpvOverlay(); refreshAimControls(); } }
      };
      refreshTo(insertedAt);
      pushHistory({
        label: `add ${label} · new WP ${insertedAt + 1} (repositioned)`,
        undo: () => { rec.undo(); refreshTo(wp.index); },
        redo: () => { rec.redo(); refreshTo(insertedAt); },
      });
      setStatus(`Added a new waypoint (WP ${insertedAt + 1}) for the repositioned shot — Export KMZ to save.`);
      return;
    }
  }

  const rec = wp.addAction(kind, opts);
  const refresh = () => {
    setDirty(true);
    renderWpActions(wpByIndex(state.selected));
    if (cesiumOK) { drawWaypoints(); if (state.fpv) { updateFpvOverlay(); refreshAimControls(); } }
  };
  refresh();
  pushHistory({
    label: `add ${label} · WP ${wp.index + 1}`,
    undo: () => { rec.undo(); refresh(); },
    redo: () => { rec.redo(); refresh(); },
  });
  setStatus(`Added ${label} to WP ${wp.index + 1} — Export KMZ to save.`);
}

function renderImageInfo(photo) {
  state.shownPhoto = photo; // remembered so a unit toggle can re-render with new units
  if (!photo) {
    $('img-info').innerHTML =
      `<div class="info-row"><span class="info-label">File</span><span class="info-val info-filename info-dim">—</span></div>` +
      `<div class="info-row"><span class="info-label">Band</span><span class="info-val info-dim">—</span></div>` +
      `<div class="info-row"><span class="info-label">Zoom</span><span class="info-val info-dim">—</span></div>` +
      `<div class="info-row"><span class="info-label">Seq #</span><span class="info-val info-dim">—</span></div>` +
      `<div class="info-row"><span class="info-label">Altitude</span><span class="info-val info-dim">—</span></div>` +
      `<div class="info-row"><span class="info-label">Captured</span><span class="info-val info-dim">—</span></div>` +
      `<div class="info-row"><span class="info-label">GPS</span><span class="info-val info-dim">—</span></div>`;
    return;
  }
  if (photo.type === 'video') {
    const bandColors = { ir: '#ff7a59', wide: '#4fd1e0' };
    const bandLabel = { ir: 'IR', wide: 'WIDE' };
    const bandHtml = photo.band
      ? `<span class="info-lens" style="background:${bandColors[photo.band] || '#888'}">${bandLabel[photo.band] || photo.band.toUpperCase()}</span>`
      : '<span class="info-dim">—</span>';
    $('img-info').innerHTML =
      `<div class="info-row"><span class="info-label">File</span><span class="info-val info-filename">${photo.name}</span></div>` +
      `<div class="info-row"><span class="info-label">Type</span><span class="info-val"><span class="info-lens" style="background:#4a9eff">VIDEO</span></span></div>` +
      `<div class="info-row"><span class="info-label">Band</span><span class="info-val">${bandHtml}</span></div>` +
      `<div class="info-row"><span class="info-label">Zoom</span><span class="info-val">${photo.band === 'ir' ? '2×' : '<span class="info-dim">varies</span>'}</span></div>`;
    return;
  }
  const bandColors = { ir: '#ff7a59', zoom: '#9b8cff', wide: '#4fd1e0' };
  const bandLabel = { ir: 'IR', zoom: 'ZOOM', wide: 'WIDE' };
  const bandHtml = photo.band
    ? `<span class="info-lens" style="background:${bandColors[photo.band] || '#888'}">${bandLabel[photo.band] || photo.band.toUpperCase()}</span>`
    : '<span class="info-dim">—</span>';

  let timeStr = '—';
  if (photo.time != null) {
    const d = new Date(photo.time);
    timeStr = d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0') + ' ' +
      String(d.getUTCHours()).padStart(2, '0') + ':' +
      String(d.getUTCMinutes()).padStart(2, '0') + ':' +
      String(d.getUTCSeconds()).padStart(2, '0') + ' UTC';
  }

  // Altitude of the waypoint this photo was taken at — AGL (height above ground) with the
  // absolute ASL value alongside, matching what FlightHub shows on the waypoint.
  const ownerIdx = wpIndexForPhoto(photo);
  const ownerWp = ownerIdx != null ? wpByIndex(ownerIdx) : null;
  let altHtml = '<span class="info-dim">—</span>';
  if (ownerWp) {
    const agl = ownerWp.aglHeight, abs = ownerWp.height, u = hUnit();
    if (agl != null) {
      altHtml = `${toDisp(agl).toFixed(1)} ${u} AGL` +
        (abs != null ? ` <span class="info-dim">(${toDisp(abs).toFixed(1)} ${u} ellip.)</span>` : '');
    } else if (abs != null) {
      altHtml = `${toDisp(abs).toFixed(1)} ${u} ellip.`;
    }
  }

  // Zoom: IR is always shot at 2× (thermal). The visible photo uses the waypoint's zoom.
  let zoomStr = '<span class="info-dim">—</span>';
  if (photo.band === 'ir') zoomStr = '2×';
  else if (ownerWp && ownerWp.zoomFocalLength != null) zoomStr = zoomLabel(ownerWp.zoomFocalLength).replace('x', '×');

  // Yaw / tilt: the actual gimbal aim recorded in the photo's own EXIF/XMP (DJI). Only shown
  // when the image carries it — this is the captured angle, independent of the route's plan.
  const aimRows =
    (photo.gimbalYaw != null ? `<div class="info-row"><span class="info-label">Yaw</span><span class="info-val">${photo.gimbalYaw.toFixed(1)}°</span></div>` : '') +
    (photo.gimbalPitch != null ? `<div class="info-row"><span class="info-label">Tilt</span><span class="info-val">${photo.gimbalPitch.toFixed(1)}°</span></div>` : '');

  $('img-info').innerHTML =
    `<div class="info-row"><span class="info-label">File</span><span class="info-val info-filename">${photo.name}</span></div>` +
    `<div class="info-row"><span class="info-label">Band</span><span class="info-val">${bandHtml}</span></div>` +
    `<div class="info-row"><span class="info-label">Zoom</span><span class="info-val">${zoomStr}</span></div>` +
    `<div class="info-row"><span class="info-label">Seq #</span><span class="info-val">${photo.seqNum != null ? photo.seqNum : '—'}</span></div>` +
    `<div class="info-row"><span class="info-label">Altitude</span><span class="info-val">${altHtml}</span></div>` +
    aimRows +
    `<div class="info-row"><span class="info-label">Captured</span><span class="info-val info-gps">${timeStr}</span></div>` +
    (photo.lat != null ? `<div class="info-row"><span class="info-label">GPS</span><span class="info-val info-gps">${photo.lat.toFixed(6)}°, ${photo.lng.toFixed(6)}°</span></div>` : '');
}

function wpByIndex(i) { return state.mission ? state.mission.waypoints.find((w) => w.index === i) : null; }
function wpIndexForPhoto(photo) {
  for (const [wi, list] of state.photoByWp) {
    if (list.includes(photo)) return wi;
  }
  return null;
}

// Return all photos with _wpIndex (1-based) added, suitable for passing to the image viewer.
function photosForViewer() {
  return state.photos.map((p) => {
    const wi = wpIndexForPhoto(p);
    return wi != null ? Object.assign({}, p, { _wpIndex: wi + 1 }) : p;
  });
}
// ---------------------------------------------------------------------------
// Route bounds — used to constrain camera movement
// ---------------------------------------------------------------------------
function computeRouteBounds() {
  if (!state.mission) return null;
  const wps = state.mission.waypoints.filter((wp) => wp.coordinates);
  if (!wps.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, sumH = 0;
  for (const wp of wps) {
    minLat = Math.min(minLat, wp.coordinates.lat);
    maxLat = Math.max(maxLat, wp.coordinates.lat);
    minLng = Math.min(minLng, wp.coordinates.lng);
    maxLng = Math.max(maxLng, wp.coordinates.lng);
    sumH += wpDisplayHeight(wp) || 850;
  }
  const lat = (minLat + maxLat) / 2;
  const lng = (minLng + maxLng) / 2;
  const h = sumH / wps.length;
  const radius = Math.max(haversine(lat, lng, maxLat, maxLng), 200);
  return { lat, lng, h, radius };
}

function applyRouteCameraLimits() {
  if (!cesiumOK || !state.routeBounds) return;
  const b = state.routeBounds;
  const ctrl = viewer.scene.screenSpaceCameraController;
  ctrl.minimumZoomDistance = 20;
  // Max zoom-out: enough to see the whole route with comfortable margin, capped at 5 km.
  ctrl.maximumZoomDistance = Math.min(Math.max(b.radius * 6, 800), 5000);
}

// ---------------------------------------------------------------------------
// Cesium drawing
// ---------------------------------------------------------------------------
// Apply the chosen height reference and re-place the route on the model.
function applyHeightMode() {
  const sel = $('height-mode');
  const groundField = $('ground-alt');
  const mode = sel ? sel.value : 'absolute';
  state.heightMode = mode;
  const autoBtn = $('ground-auto');
  if (mode === 'alt') {            // heights are above the takeoff point → add ground altitude
    if (groundField) groundField.style.display = '';
    if (autoBtn) autoBtn.style.display = '';
    const g = groundField ? fromDisp(parseFloat(groundField.value)) : NaN; // field is in display unit → metres
    state.heightOffset = isNaN(g) ? 0 : g;
    state.takeOffRefAltitude = isNaN(g) ? state.takeOffRefAltitude : g; // keep FPV AGL correct
    if (!isNaN(g)) { try { localStorage.setItem('lastGroundAlt', String(g)); } catch {} } // remember for next time
  } else if (mode === 'asl') {     // heights are mean-sea-level → shift to ellipsoid
    if (groundField) groundField.style.display = 'none';
    if (autoBtn) autoBtn.style.display = 'none';
    state.heightOffset = GEOID_SEP;
  } else {                         // absolute (WGS84) → use as-is
    if (groundField) groundField.style.display = 'none';
    if (autoBtn) autoBtn.style.display = 'none';
    state.heightOffset = 0;
  }
  if (cesiumOK && state.mission) {
    drawWaypoints();
    if (state.fpv) applyFpv(); else fitView();
  }
}

// Refresh every height label/value to the current unit. Static labels only (no conversion of
// stored data — everything stays in metres internally).
function syncHeightUnitLabels() {
  const u = hUnit();
  const btn = $('height-unit'); if (btn) { btn.textContent = u; btn.classList.toggle('active', u === 'ft'); }
  const au = $('aim-alt-unit'); if (au) au.textContent = u;
  const fu = $('fpv-alt-unit'); if (fu) fu.textContent = u + ' AGL';
  const gf = $('ground-alt');
  if (gf) { gf.placeholder = 'ground ' + u; gf.title = `Takeoff ground altitude (${u}), for ALT`; }
  const su = $('shift-step-unit'); if (su) su.textContent = u;
  if (typeof updateShiftReadout === 'function') updateShiftReadout();
  if (renderShiftPresets) renderShiftPresets(); // preset labels show values in the active unit
}

// Switch height display/input units between metres and feet. The ground field holds a value
// in the OLD unit, so reinterpret it to metres and re-render it in the NEW unit; all other
// height readouts are recomputed from the (metre-based) model.
function setHeightUnit(unit) {
  if (unit !== 'm' && unit !== 'ft') return;
  if (unit === state.heightUnit) return;
  const gf = $('ground-alt');
  let groundM = NaN;
  if (gf && gf.value.trim() !== '') groundM = fromDisp(parseFloat(gf.value)); // fromDisp uses the OLD unit
  state.heightUnit = unit;
  try { localStorage.setItem('heightUnit', unit); } catch {}
  syncHeightUnitLabels();
  if (gf && !isNaN(groundM)) gf.value = toDisp(groundM).toFixed(1); // re-render in the NEW unit
  refreshAimControls();
  updateFpvAltReadout();
  renderImageInfo(state.shownPhoto); // re-render altitude row in the new unit
}

// Read the ground altitude straight off the loaded 3D model, under the route's first
// waypoint, and use it as the ALT reference — no guessing the number.
function autoGroundFromModel() {
  if (!cesiumOK || !state.mission) { setStatus('Open a route first.'); return; }
  if (!state.tileset) { setStatus('Load the 3D model first — Auto reads the ground from it.'); return; }
  if (!viewer.scene.sampleHeightSupported) { setStatus('This GPU can’t sample the model surface; type the ground altitude instead.'); return; }
  // Sample the model surface under MANY waypoints and take the median — far more stable
  // than one point, and the median ignores the occasional sample that lands on a tank/pipe.
  const wps = state.mission.waypoints.filter((w) => w.coordinates);
  const samples = [];
  for (const wp of wps) {
    const h = viewer.scene.sampleHeight(
      Cesium.Cartographic.fromDegrees(wp.coordinates.lng, wp.coordinates.lat), state.entities.points);
    if (h != null && !isNaN(h)) samples.push(h);
  }
  if (samples.length < 3) {
    setStatus('Couldn’t read the model ground yet — zoom in so the model loads to full detail over the route, then click Auto again.');
    return;
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  $('height-mode').value = 'alt';
  $('ground-alt').value = toDisp(median).toFixed(1);
  applyHeightMode();
  setStatus(`Ground read from 3D model: ${toDisp(median).toFixed(1)} ${hUnit()} (median of ${samples.length} points). ` +
    'If it looks off, let the model finish loading and click Auto again, or type the value.');
}

function drawWaypoints() {
  if (!cesiumOK || !state.mission) return;
  // clear previous
  state.entities.points.forEach((e) => viewer.entities.remove(e));
  state.entities.points = [];
  state.entities.lines.forEach((e) => viewer.entities.remove(e));
  state.entities.lines = [];
  if (state.entities.path) { viewer.entities.remove(state.entities.path); state.entities.path = null; }

  const pathPositions = [];
  for (const wp of state.mission.waypoints) {
    const c = wp.coordinates;
    if (!c) continue;
    const h = wpDisplayHeight(wp); // stored height + chosen reference offset
    const pos = Cesium.Cartesian3.fromDegrees(c.lng, c.lat, h);
    pathPositions.push(pos);
    const selected = wp.index === state.selected;
    const color = selected ? WP_AMBER : WP_BLUE;

    // Numbered teardrop pin.
    const e = viewer.entities.add({
      position: pos,
      billboard: {
        image: pin(wp.index + 1, color, selected ? 52 : 40),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 1,
        eyeOffset: new Cesium.Cartesian3(0, 0, selected ? -50 : 0), // selected draws on top
      },
    });
    e.wpIndex = wp.index;
    state.entities.points.push(e);
  }

  if (pathPositions.length > 1) {
    state.entities.path = viewer.entities.add({
      polyline: {
        positions: pathPositions,
        width: 2,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.15,
          color: Cesium.Color.fromCssColorString(WP_CYAN).withAlpha(0.85),
        }),
        clampToGround: false,
      },
    });
  }

  // Recompute bounds and apply camera limits every time the route is drawn.
  state.routeBounds = computeRouteBounds();
  applyRouteCameraLimits();
}

function highlightWaypoint(index, opts = {}) {
  if (!cesiumOK) return;
  drawWaypoints();
  // While placing waypoints, selecting the just-placed one should NOT relocate the camera — the
  // operator is navigating the model freely to choose the next spot, and a camera jump on every
  // click (snapping the FPV view to the new waypoint) fights that.
  if (opts.skipCameraJump) return;
  if (state.fpv) { applyFpv(); return; }
  const wp = wpByIndex(index);
  if (!wp || !wp.coordinates) return;
  const h = wpDisplayHeight(wp);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(wp.coordinates.lng, wp.coordinates.lat, h + 80),
    duration: 0.6,
  });
}

// ---------------------------------------------------------------------------
// FPV loop — keyboard-driven camera movement while FPV is active
// ---------------------------------------------------------------------------
function isInputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

function updateFpvSpeedLabel() {
  $('fpv-speed-label').textContent = FPV_SPEED_LABELS[fpvSpeedMode];
}

function startFpvLoop() {
  if (fpvRaf != null) return;
  fpvLastT = performance.now();
  const _v3 = () => new Cesium.Cartesian3();
  function tick(t) {
    if (!state.fpv || !cesiumOK) { fpvRaf = null; return; }
    const dt = Math.min((t - fpvLastT) / 1000, 0.1);
    fpvLastT = t;
    const mv = FPV_SPEEDS[fpvSpeedMode] * dt;
    const turn = Cesium.Math.toRadians(60 * dt);
    const cam = viewer.camera;

    // World-space vertical axis at camera position (radially outward from Earth).
    const worldUp = Cesium.Cartesian3.normalize(cam.position, _v3());

    // Camera forward / right projected onto the horizontal plane so W/S/A/D
    // move level regardless of where the camera is looking (pitch).
    const fwdH = Cesium.Cartesian3.subtract(
      cam.direction,
      Cesium.Cartesian3.multiplyByScalar(worldUp, Cesium.Cartesian3.dot(cam.direction, worldUp), _v3()),
      _v3()
    );
    const fwdLen = Cesium.Cartesian3.magnitude(fwdH);
    if (fwdLen > 1e-4) Cesium.Cartesian3.divideByScalar(fwdH, fwdLen, fwdH);

    const rtH = Cesium.Cartesian3.subtract(
      cam.right,
      Cesium.Cartesian3.multiplyByScalar(worldUp, Cesium.Cartesian3.dot(cam.right, worldUp), _v3()),
      _v3()
    );
    const rtLen = Cesium.Cartesian3.magnitude(rtH);
    if (rtLen > 1e-4) Cesium.Cartesian3.divideByScalar(rtH, rtLen, rtH);

    // Horizontal movement — world-level regardless of camera pitch.
    if (fpvKeys.has('w')) cam.move(fwdH,  mv);
    if (fpvKeys.has('s')) cam.move(fwdH, -mv);
    if (fpvKeys.has('a')) cam.move(rtH,  -mv);
    if (fpvKeys.has('d')) cam.move(rtH,   mv);

    // Vertical movement — always world up/down, never camera-relative.
    if (fpvKeys.has('c')) cam.move(worldUp,  mv);   // ascend
    if (fpvKeys.has('z')) cam.move(worldUp, -mv);   // descend

    // Yaw — rotate around the world-up axis so the horizon stays level.
    if (fpvKeys.has('q')) cam.look(worldUp, -turn);  // left
    if (fpvKeys.has('e')) cam.look(worldUp,  turn);  // right

    // Clamp camera to route area so it can't fly off into empty space.
    const b = state.routeBounds;
    if (b) {
      const pos = cam.positionCartographic;
      const camLat = Cesium.Math.toDegrees(pos.latitude);
      const camLng = Cesium.Math.toDegrees(pos.longitude);
      const dist = haversine(camLat, camLng, b.lat, b.lng);
      const limit = Math.max(b.radius * 3, 400);
      if (dist > limit) {
        // Pull back to boundary along the same bearing.
        const ratio = limit / dist;
        const clampLat = b.lat + (camLat - b.lat) * ratio;
        const clampLng = b.lng + (camLng - b.lng) * ratio;
        cam.setView({
          destination: Cesium.Cartesian3.fromDegrees(clampLng, clampLat, pos.height),
          orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
        });
      }
      // Altitude: stay within ±300 m of average waypoint height.
      const minH = b.h - 100, maxH = b.h + 400;
      if (pos.height < minH || pos.height > maxH) {
        const clampH = Math.max(minH, Math.min(maxH, pos.height));
        cam.setView({
          destination: Cesium.Cartesian3.fromDegrees(
            Cesium.Math.toDegrees(pos.longitude),
            Cesium.Math.toDegrees(pos.latitude),
            clampH
          ),
          orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
        });
      }
    }

    updateFpvAltReadout();
    fpvRaf = requestAnimationFrame(tick);
  }
  fpvRaf = requestAnimationFrame(tick);
}

// Live AGL readout for the FPV camera: current camera ellipsoid height minus the
// mission takeoff-reference altitude (same basis as the per-waypoint AGL display).
function updateFpvAltReadout() {
  if (!state.fpv || !cesiumOK) return;
  const el = $('fpv-alt-val');
  if (!el) return;
  const h = viewer.camera.positionCartographic.height;
  const refAlt = state.takeOffRefAltitude;
  if (refAlt != null && h != null) el.textContent = toDisp(h - refAlt).toFixed(1);
  else if (h != null) el.textContent = toDisp(h).toFixed(1);
  else el.textContent = '—';

  // Capture zoom of the active shot (what the drone shoots at this stop).
  const zEl = $('fpv-zoom-val');
  if (zEl) {
    const focal = activeShotFocal();
    zEl.textContent = focal != null ? zoomLabel(focal).replace('x', '×') : '—';
  }
}

function stopFpvLoop() {
  if (fpvRaf != null) { cancelAnimationFrame(fpvRaf); fpvRaf = null; }
}

const WIDE_FOV_DEG = 82; // M4TD wide-angle horizontal FOV

// FPV — always render at the wide FOV so overlay boxes are meaningful.
function fpvParams(wp) {
  const j = wp.toJSON();
  const h = wpDisplayHeight(wp);
  // Aim at the shot currently selected in the editor (so multi-shot previews match what you edit).
  const s = curAimShot(wp);
  const heading = (s && s.aircraftHeading != null ? s.aircraftHeading : j.aircraftHeading) ?? j.headingAngle ?? bearingToNext(wp) ?? 0;
  const pitch = (s && s.gimbalPitch != null ? s.gimbalPitch : j.gimbalPitch);
  return { h, heading, pitch: pitch != null ? pitch : -30 };
}

function applyFpv() {
  if (!cesiumOK || !state.fpv) return;
  const wp = wpByIndex(state.selected);
  if (!wp || !wp.coordinates) return;
  const { h, heading, pitch } = fpvParams(wp);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(wp.coordinates.lng, wp.coordinates.lat, h),
    orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(pitch), roll: 0 },
  });
  setFpvFov();
  updateFpvAltReadout(); // match the marker to the waypoint we just snapped to
  refreshAimControls();  // sync the yaw/tilt editor to this waypoint
}

// ---------------------------------------------------------------------------
// FPV camera overlay — lens bar, bounding boxes, heading
// ---------------------------------------------------------------------------
// FOV at a given mm focal length (horizontal, in degrees, relative to 24 mm wide = 82°)
function lensHFov(mm) { return 2 * Math.atan(Math.tan(Cesium.Math.toRadians(WIDE_FOV_DEG / 2)) * (WIDE_MM / mm)); }

// Box size as a fraction of viewport width/height for a given lens FOV vs the wide FOV.
function boxFrac(lensFovRad) {
  return Math.tan(lensFovRad / 2) / Math.tan(Cesium.Math.toRadians(WIDE_FOV_DEG / 2));
}

function updateFpvOverlay() {
  const overlay = $('fpv-overlay');
  if (!state.fpv || state.selected < 0) { overlay.classList.add('hidden'); return; }
  const wp = wpByIndex(state.selected);
  if (!wp) { overlay.classList.add('hidden'); return; }
  overlay.classList.remove('hidden');

  const src = wp.toJSON();
  const lenses = src.lenses || [];
  const shotFocal = activeShotFocal(); // green box follows the ACTIVE shot's (possibly edited) zoom
  const zoom = zoomFromFocal(shotFocal) || 1;
  const focalMm = shotFocal || WIDE_MM;
  const heading = src.aircraftHeading ?? src.headingAngle ?? bearingToNext(wp) ?? 0;

  // --- lens bar ---
  const bar = $('fpv-lens-bar');
  bar.innerHTML = '';
  const addLens = (label, key, color) => {
    if (!lenses.includes(key)) return;
    const pill = document.createElement('span');
    pill.className = 'fpv-lens-pill';
    pill.style.background = color;
    pill.textContent = label;
    bar.appendChild(pill);
  };
  const zoomLabel2 = `Zoom ${zoom <= 1 ? '1' : Math.round(zoom * 10) / 10}×`;
  addLens(zoomLabel2, 'zoom', '#555');

  // --- bounding boxes SVG ---
  const svg = $('fpv-boxes-svg');
  svg.innerHTML = '';
  const vw = svg.clientWidth || svg.parentElement.clientWidth;
  const vh = svg.clientHeight || svg.parentElement.clientHeight;
  const cx = vw / 2, cy = vh / 2;

  function drawBox(fracW, fracH, stroke, label, corner = false) {
    const hw = fracW * vw / 2, hh = fracH * vh / 2;
    const x1 = cx - hw, y1 = cy - hh, x2 = cx + hw, y2 = cy + hh;
    const cs = Math.min(hw, hh) * 0.25; // corner segment length
    if (corner) {
      // Only draw corners
      const corners = [
        `M${x1},${y1+cs} L${x1},${y1} L${x1+cs},${y1}`,
        `M${x2-cs},${y1} L${x2},${y1} L${x2},${y1+cs}`,
        `M${x2},${y2-cs} L${x2},${y2} L${x2-cs},${y2}`,
        `M${x1+cs},${y2} L${x1},${y2} L${x1},${y2-cs}`,
      ];
      corners.forEach((d) => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        p.setAttribute('stroke', stroke);
        p.setAttribute('stroke-width', '2');
        p.setAttribute('fill', 'none');
        svg.appendChild(p);
      });
    } else {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x1); rect.setAttribute('y', y1);
      rect.setAttribute('width', hw * 2); rect.setAttribute('height', hh * 2);
      rect.setAttribute('stroke', stroke); rect.setAttribute('stroke-width', '1.5');
      rect.setAttribute('fill', 'none');
      svg.appendChild(rect);
      // Label bottom-right
      if (label) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', x2 - 4); t.setAttribute('y', y2 + 14);
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('fill', stroke); t.setAttribute('font-size', '11');
        t.setAttribute('font-family', 'monospace');
        t.textContent = label;
        svg.appendChild(t);
      }
    }
  }

  // Green box: the footprint the camera ACTUALLY captures at this waypoint's zoom,
  // drawn relative to the current FPV field of view (so it's correct whether you're
  // viewing wide or zoomed, and updates live as you change zoom with 1/2/+/−).
  // Shown whenever the capture is tighter than the current view (zoom > rendered zoom).
  const renderFovH = viewer.camera.frustum.fov; // actual horizontal FOV in radians
  const captureFovH = lensHFov(focalMm);
  if (focalMm > WIDE_MM && captureFovH < renderFovH - 1e-4) {
    const PHOTO_ASPECT = 4 / 3; // M4TD still image (w:h)
    const viewFovV = 2 * Math.atan(Math.tan(renderFovH / 2) * (vh / vw));
    const captureFovV = 2 * Math.atan(Math.tan(captureFovH / 2) / PHOTO_ASPECT);
    const fracW = Math.tan(captureFovH / 2) / Math.tan(renderFovH / 2);
    const fracH = Math.tan(captureFovV / 2) / Math.tan(viewFovV / 2);
    drawBox(fracW, fracH, '#00e676', zoomLabel(focalMm).replace('x', '×'));
  }

  // Crosshair at center
  const crossSize = 8;
  ['line'].forEach(() => {
    const h1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    h1.setAttribute('x1', cx - crossSize); h1.setAttribute('y1', cy);
    h1.setAttribute('x2', cx + crossSize); h1.setAttribute('y2', cy);
    h1.setAttribute('stroke', 'white'); h1.setAttribute('stroke-width', '1');
    svg.appendChild(h1);
    const v1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    v1.setAttribute('x1', cx); v1.setAttribute('y1', cy - crossSize);
    v1.setAttribute('x2', cx); v1.setAttribute('y2', cy + crossSize);
    v1.setAttribute('stroke', 'white'); v1.setAttribute('stroke-width', '1');
    svg.appendChild(v1);
  });

}

// Initial great-circle bearing from a waypoint to the next one by index.
function bearingToNext(wp) {
  const wps = state.mission.waypoints;
  const i = wps.findIndex((w) => w.index === wp.index);
  const next = wps[i + 1] || wps[i - 1];
  if (!next || !next.coordinates || !wp.coordinates) return null;
  const φ1 = Cesium.Math.toRadians(wp.coordinates.lat);
  const φ2 = Cesium.Math.toRadians(next.coordinates.lat);
  const Δλ = Cesium.Math.toRadians(next.coordinates.lng - wp.coordinates.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function fitView() {
  if (!cesiumOK || !state.entities.points.length) return;
  viewer.flyTo(state.entities.points, { duration: 0.8 }).catch(() => {});
}

// Esri's elevation service documents its heights as orthometric (mean-sea-level), not WGS84
// ellipsoidal — but Cesium places terrain directly at "ellipsoid height = raw value," and the 3D
// model/route heights are true WGS84 ellipsoid (per GEOID_SEP above, confirmed against NGS
// GEOID18 for this region: ~-24.5 to -25.4 m). Left uncorrected, the terrain surface renders
// ~25 m too high relative to the ellipsoid the model sits on — i.e. the model appears to float in
// a gap below the surrounding "map." Wrapping the provider to shift every returned height by
// GEOID_SEP converts it to the same ellipsoidal convention the model uses, closing that gap.
function makeOffsetTerrainProvider(base, offsetMeters) {
  const wrapper = Object.create(base);
  wrapper.requestTileGeometry = function (x, y, level, request) {
    const result = base.requestTileGeometry(x, y, level, request);
    if (!result || typeof result.then !== 'function') return result; // undefined = throttled; pass through
    return result.then((data) => {
      if (data && data._structure) {
        data._structure = Object.assign({}, data._structure, {
          heightOffset: (data._structure.heightOffset || 0) + offsetMeters,
        });
      }
      return data;
    });
  };
  return wrapper;
}

// Real ground elevation for the bare globe (Esri's public elevation service — no API key, same as
// the imagery layers above). Without this the globe is a flat WGS84 ellipsoid at 0 m everywhere,
// while a loaded 3D model sits at its true elevation (often several hundred metres) — the model
// then visually "floats" above the map instead of sitting on it. Applied once, at boot, regardless
// of the imagery/labels toggles — it's what makes the ground surface itself sit at the right
// height, not just what's drawn on it. Silently keeps the flat ellipsoid without a network.
function enableRealTerrain() {
  if (!cesiumOK) return;
  Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
    'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'
  ).then((terrainProvider) => {
    if (cesiumOK) viewer.terrainProvider = makeOffsetTerrainProvider(terrainProvider, GEOID_SEP);
  }).catch(() => {});
}

// Online satellite imagery — ArcGIS World Imagery, draped on the bare globe so it reads like an
// ordinary map (Google Maps-style) before the (large, offline) site 3D model is loaded, or any
// time the model isn't loaded. Silently does nothing without a network connection.
function addImageryLayer() {
  if (!cesiumOK || state.imageryLayer) return;
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 21,
    });
    state.imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    return true;
  } catch { return false; }
}
// "Hybrid" overlay — two free, keyless ArcGIS reference layers stacked on top of the satellite
// imagery above: road/street linework first, then place names + borders on top of that (so text
// isn't drawn under road lines). Both are the same public tile service family as the imagery
// layer (services.arcgisonline.com) — no API key, no billing account, same as everything else in
// this app. (An actual Google-branded basemap would need a Google Maps Platform API key + billing
// on file — not used here on purpose.)
function addRoadsLayer() {
  if (!cesiumOK || state.roadsLayer) return;
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      tileWidth: 512,
      tileHeight: 512,
      maximumLevel: 20,
    });
    state.roadsLayer = viewer.imageryLayers.addImageryProvider(provider);
    return true;
  } catch { return false; }
}
function removeRoadsLayer() {
  if (state.roadsLayer) { try { viewer.imageryLayers.remove(state.roadsLayer); } catch {} state.roadsLayer = null; }
}
function addLabelsLayer() {
  if (!cesiumOK || state.labelsLayer) return;
  addRoadsLayer(); // roads first so they sit under the place-name text added below
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      // Real tiles are 256x256, but the text/labels baked into them read tiny until zoomed in
      // fairly close. Declaring a larger size than the tiles really are tricks Cesium into
      // fetching one zoom level coarser than it normally would for the current view and
      // stretching it to fill the same screen space — the labels enlarge right along with it, so
      // they're legible sooner instead of staying small until a much closer zoom.
      tileWidth: 512,
      tileHeight: 512,
      maximumLevel: 20, // +1 over the service's real deepest level, since requests now land one level coarser
    });
    state.labelsLayer = viewer.imageryLayers.addImageryProvider(provider);
    return true;
  } catch { removeRoadsLayer(); return false; }
}
function removeLabelsLayer() {
  if (state.labelsLayer) { try { viewer.imageryLayers.remove(state.labelsLayer); } catch {} state.labelsLayer = null; }
  removeRoadsLayer();
}

function enableDefaultImagery() {
  const ok = addImageryLayer();
  const cb = $('imagery');
  if (cb) cb.checked = !!ok;
  const labelsOk = ok && addLabelsLayer();
  const labelsCb = $('imagery-labels');
  if (labelsCb) labelsCb.checked = !!labelsOk;
}

function toggleImagery(e) {
  if (!cesiumOK) return;
  if (e.target.checked) {
    if (!addImageryLayer()) setStatus('Imagery requires an internet connection.');
  } else if (state.imageryLayer) {
    viewer.imageryLayers.remove(state.imageryLayer);
    state.imageryLayer = null;
    // Labels only make sense drawn over the satellite imagery — turning it off takes them with it.
    removeLabelsLayer();
    const labelsCb = $('imagery-labels'); if (labelsCb) labelsCb.checked = false;
  }
}

function toggleImageryLabels(e) {
  if (!cesiumOK) return;
  if (e.target.checked) {
    // Labels need the base imagery underneath them — turn it on first if it isn't already.
    if (!state.imageryLayer) {
      const cb = $('imagery');
      if (!addImageryLayer()) { setStatus('Labels require an internet connection.'); e.target.checked = false; return; }
      if (cb) cb.checked = true;
    }
    if (!addLabelsLayer()) { setStatus('Labels require an internet connection.'); e.target.checked = false; }
  } else {
    removeLabelsLayer();
  }
}

// ---------------------------------------------------------------------------
// 3D model
// ---------------------------------------------------------------------------
async function openModel() {
  if (!cesiumOK) { setStatus('3D viewer unavailable in this session.'); return; }
  const res = await window.api.openModel();
  if (!res) return;
  state.modelDir = res.dir || null;
  await applyModel(res);
  maybeSaveSession();
}

async function applyModel(res) {
  if (!res || !res.entry) {
    setStatus(`No tileset.json, glTF/GLB, or OBJ found under that folder (scanned 3 levels).`);
    return;
  }
  try {
    if (res.kind === '3dtiles') {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(res.entry, {
        maximumScreenSpaceError: 2,
        cacheBytes: 1024 * 1024 * 1024,
        maximumCacheOverflowBytes: 2 * 1024 * 1024 * 1024,
        preloadWhenHidden: true,
        skipLevelOfDetail: false,
      });
      state.tileset = tileset;
      viewer.scene.primitives.add(tileset);
      await viewer.zoomTo(tileset);
      state.modelLoaded = true;
      setStatus('3D Tiles model loaded at full detail. Waypoints sit at their true height over it.');
    } else {
      const wp0 = state.mission && state.mission.waypoints[0] && state.mission.waypoints[0].coordinates;
      const origin = wp0
        ? Cesium.Cartesian3.fromDegrees(wp0.lng, wp0.lat, 0)
        : Cesium.Cartesian3.fromDegrees(0, 0, 0);
      const model = await Cesium.Model.fromGltfAsync({
        url: res.entry,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(origin),
      });
      viewer.scene.primitives.add(model);
      state.modelLoaded = true;
      setStatus(`Mesh model loaded (${res.kind}). It is georeferenced to waypoint 0.`);
    }
  } catch (e) {
    setStatus('Could not load model: ' + e.message);
  }
  updateFilesBadge();
  syncCreateRouteEnabled();
}

// "Create new route" needs a model to click on — state.modelDir alone just means a folder was picked,
// not that a model actually loaded into the scene (see applyModel's early-return branch above).
function hasModel() { return state.modelLoaded; }
function syncCreateRouteEnabled() {
  const btn = $('btn-new-route');
  if (btn) btn.disabled = !hasModel();
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
async function openPhotos() {
  const res = await window.api.openPhotos();
  if (!res) return;
  applyPhotos(res);
}

function applyPhotos(res) {
  state.photos = res.photos;
  state.photosDir = res.dir || null;
  state.photosDirCreatedAt = res.folderCreatedAt || null;
  state.photosFolderName = res.dir ? res.dir.split(/[\\/]/).pop() : null;
  $('ph-count').textContent = state.photos.length;
  matchPhotos();
  renderList();
  if (state.selected >= 0) renderPhotos(state.selected);
  const withGps = state.photos.filter((p) => p.lat != null).length;
  setStatus(`Loaded ${state.photos.length} images · ${withGps} geotagged · matched to waypoints.`);
  updateFilesBadge();
  maybeSaveSession();
}

async function loadAll() {
  setStatus('Load all — step 1/3: select route KMZ…');
  await openRoute();
  if (!state.mission) { setStatus('Load all cancelled — no route loaded.'); return; }
  setStatus('Load all — step 2/3: select 3D model folder…');
  await openModel();
  setStatus('Load all — step 3/3: select mission photos folder…');
  await openPhotos();
  setStatus('All loaded.');
}

function maybeSaveSession() {
  if (!state.routePath || !state.photosDir) return;
  window.api.saveSession({
    routePath: state.routePath,
    modelDir: state.modelDir || '',
    photosDir: state.photosDir,
    photosFolderName: state.photosFolderName,
    photosDirCreatedAt: state.photosDirCreatedAt,
  });
}

// ---------------------------------------------------------------------------
// Generic in-page confirm (replaces window.confirm — see index.html for why)
// ---------------------------------------------------------------------------
let confirmResolve = null;
function confirmDialog(message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirm-message').textContent = message;
    $('confirm-modal').classList.remove('hidden');
    setTimeout(() => { const b = $('confirm-ok'); if (b) b.focus(); }, 0);
  });
}
function resolveConfirm(v) {
  $('confirm-modal').classList.add('hidden');
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(v); }
}

// ---------------------------------------------------------------------------
// Create new route
// ---------------------------------------------------------------------------

function openCreateRouteModal() {
  if (!hasModel()) { setStatus('Load a 3D model first — new waypoints are placed by clicking on it.'); return; }
  // Camera View captures canvas pointer input for mouse-look/drag — leave it off before showing any
  // dialog on top of the 3D view, so a lingering drag/pointer-capture can't swallow clicks meant for it.
  if (state.fpv) { const cb = $('fpv'); cb.checked = false; cb.dispatchEvent(new Event('change')); }
  $('newroute-name').value = '';
  $('newroute-lens-wide').classList.add('active');
  $('newroute-lens-ir').classList.add('active');
  $('newroute-height').value = toDisp(20).toFixed(1);
  $('newroute-height-unit').textContent = hUnit();
  $('newroute-speed').value = '10';
  // Blur whatever currently has focus (e.g. a dropdown item, or a stale focus target left over
  // from a native dialog like the "Load 3D model" folder picker) before showing the modal, and
  // defer the actual focus() a tick — calling it immediately after a native dialog closes can
  // silently fail to move real keyboard focus even though the DOM reports the input as focused.
  // (Confirmations in this app are an in-page dialog, not window.confirm(), for the same reason.)
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $('newroute-modal').classList.remove('hidden');
  setTimeout(() => { const inp = $('newroute-name'); if (inp) { inp.focus(); inp.select(); } }, 0);
}

async function confirmCreateRoute() {
  const name = $('newroute-name').value.trim();
  const v = validateRouteName(name);
  if (!v.ok) { setStatus(v.message || 'Enter a route name.'); return; }
  const imageFormat = [];
  if ($('newroute-lens-wide').classList.contains('active')) imageFormat.push('wide');
  if ($('newroute-lens-ir').classList.contains('active')) imageFormat.push('ir');
  const globalHeight = fromDisp(parseFloat($('newroute-height').value) || 20);
  const autoFlightSpeed = parseFloat($('newroute-speed').value) || 10;

  const blank = createBlankMission({ globalHeight, autoFlightSpeed, imageFormat });
  const buf = await blank.toBuffer('browser');
  await applyRoute({ buffer: buf, name, path: null });
  // applyRoute appends "-edited" (meant for an opened existing route) — a brand-new route has
  // nothing to be "edited" from, so restore the clean typed name.
  state.routeName = name;
  $('route-name').value = name;
  state.aircraftIrOverride = imageFormat.includes('ir');
  renderCameraSettingsRow();
  // applyRoute's height-mode auto-detect looks at the tallest waypoint height to guess ALT vs.
  // Absolute — on a brand-new route that has zero waypoints yet, that heuristic always sees 0 and
  // wrongly guesses ALT. A new route's heights are unambiguous (real absolute ellipsoid heights,
  // taken directly off the clicked model surface), so force Absolute explicitly.
  $('height-mode').value = 'absolute';
  applyHeightMode();
  $('newroute-modal').classList.add('hidden');
  enterPlacingWaypoint();
  setStatus(`Created "${name}" — click the 3D model to place waypoints.`);
}

function enterPlacingWaypoint() {
  if (!cesiumOK) return;
  state.placingWaypoint = true;
  $('placing-banner').classList.remove('hidden');
  viewer.canvas.style.cursor = 'crosshair';
}

function exitPlacingWaypoint() {
  state.placingWaypoint = false;
  $('placing-banner').classList.add('hidden');
  if (cesiumOK) viewer.canvas.style.cursor = '';
  if (state.mission) setStatus(`${state.mission.waypoints.length} waypoint(s) — Export KMZ to save.`);
}

// Discard the current route entirely (e.g. a "Create new route" attempt started over) — clears
// state.mission and route-only UI, but deliberately leaves the 3D model and photos loaded so
// "Create new route" can be used again immediately, without reopening the model.
async function discardRoute() {
  if (state.mission && state.mission.waypoints.length &&
      !(await confirmDialog('Discard this route and its waypoints? The 3D model and photos stay loaded.'))) return;
  exitPlacingWaypoint();
  clearHistory();
  state.mission = null;
  state.routeName = 'route-edited';
  state.routePath = null;
  state.selected = -1;
  state.dirty = false;
  state.photoByWp = new Map();
  state.routeBounds = null;
  state.takeOffRefAltitude = null;
  shiftTotal.e = 0; shiftTotal.n = 0; shiftTotal.u = 0;
  $('shift-panel').classList.add('hidden');
  $('route-name').value = 'route-edited';
  $('viewer-empty').classList.remove('hidden');
  if (cesiumOK) {
    state.entities.points.forEach((e) => viewer.entities.remove(e));
    state.entities.points = [];
    if (state.entities.path) { viewer.entities.remove(state.entities.path); state.entities.path = null; }
  }
  renderList();
  renderWpActions(null);
  renderImageInfo(null);
  renderPhotos();
  updateFilesBadge();
  syncCreateRouteEnabled();
  setStatus('Route discarded — the 3D model and photos are still loaded.');
}

// Click-to-place a new waypoint against the loaded 3D model (Create new route mode).
function handlePlacementClick(click) {
  if (!cesiumOK || !state.mission) return;
  const picked = viewer.scene.pickPosition(click.position);
  if (!Cesium.defined(picked)) { setStatus('Click on the 3D model to place a waypoint.'); return; }
  const carto = Cesium.Cartographic.fromCartesian(picked);
  const lng = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const groundHeight = carto.height;
  const globalHeight = parseFloat(state.mission.globals().globalHeight) || 20;
  const absHeight = groundHeight + globalHeight;

  // The FIRST waypoint placed is also the launch point — set it as the mission's takeoff reference
  // so AGL readouts (here and in FlightHub) are meaningful from the start, not just the raw absolute
  // height. Folded into the same undo/redo entry as placing the waypoint itself.
  const isFirst = state.mission.waypoints.length === 0;
  const prevRefAlt = state.takeOffRefAltitude;
  if (isFirst) {
    state.mission.setTakeOffRefPoint(lat, lng, groundHeight, 0);
    state.takeOffRefAltitude = groundHeight;
  }

  const rec = state.mission.appendWaypoint({ coordinates: { lng, lat }, absHeight });
  const idx = rec.waypoint.index;
  const refresh = () => { setDirty(true); renderList(); drawWaypoints(); if (state.fpv) updateFpvAltReadout(); };
  // Placing a waypoint selects it (so the list/panel reflect it), but must NOT move the camera —
  // the operator is freely navigating the model to choose where to click next, and snapping the
  // view (or the FPV camera) to every newly placed waypoint fights that navigation.
  const selectQuiet = (i) => selectWaypoint(i, { skipCameraJump: true });
  refresh();
  selectQuiet(idx);
  pushHistory({
    label: `place waypoint ${idx + 1}`,
    undo: () => {
      rec.undo();
      if (isFirst) { state.mission.clearTakeOffRefPoint(); state.takeOffRefAltitude = prevRefAlt; }
      refresh();
      selectQuiet(idx > 0 ? idx - 1 : -1);
    },
    redo: () => {
      if (isFirst) { state.mission.setTakeOffRefPoint(lat, lng, groundHeight, 0); state.takeOffRefAltitude = groundHeight; }
      rec.redo();
      refresh();
      selectQuiet(idx);
    },
  });
  // Confirms explicitly that the takeoff reference is a one-time thing, set only from this first
  // click — every later waypoint just gets placed, the reference point is never touched again.
  setStatus(isFirst
    ? `Placed waypoint 1 and set it as the takeoff reference point — click to add another waypoint, or Done to finish.`
    : `Placed waypoint ${idx + 1} — click to add another, or Done to finish.`);
}

async function openSessionModal() {
  const list = $('session-list');
  list.innerHTML = '';
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
           ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };
  const hide = () => $('session-modal').classList.add('hidden');

  // --- Full sessions (route + model + photos together) ---
  const sessions = await window.api.loadSessions();
  if (sessions.length) {
    const h = document.createElement('div'); h.className = 'session-section-h'; h.textContent = 'Full sessions';
    list.appendChild(h);
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'session-row';
      row.innerHTML =
        `<div class="session-info">` +
          `<div class="session-route">${s.routeName || s.routePath}</div>` +
          `<div class="session-photos">📷 ${s.photosFolderName || s.photosDir}` +
            (s.photosDirCreatedAt ? ` &nbsp;·&nbsp; <span class="session-date-small">Folder created ${fmtDate(s.photosDirCreatedAt)}</span>` : '') +
          `</div>` +
          `<div class="session-saved">Saved ${fmtDate(s.savedAt)}</div>` +
        `</div>` +
        `<div class="session-btns">` +
          `<button class="btn primary s-load">Load</button>` +
          `<button class="btn s-del">✕</button>` +
        `</div>`;
      row.querySelector('.s-load').onclick = async () => { hide(); await loadSessionData(s); };
      row.querySelector('.s-del').onclick = async () => { await window.api.deleteSession(s.id); openSessionModal(); };
      list.appendChild(row);
    }
  }

  // --- Recent individual files (load one at a time) ---
  const recents = (window.api.getRecents) ? await window.api.getRecents() : { routes: [], models: [], photos: [] };
  const section = (title, kind, items, onPick) => {
    if (!items || !items.length) return;
    const h = document.createElement('div'); h.className = 'session-section-h'; h.textContent = title;
    list.appendChild(h);
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'session-row recent-row';
      row.innerHTML =
        `<div class="session-info"><div class="session-route">${it.name}</div>` +
        `<div class="session-saved">${it.path}</div></div>` +
        `<div class="session-btns">` +
          `<button class="btn primary r-load">Load</button>` +
          `<button class="btn r-del" title="Remove from list">✕</button>` +
        `</div>`;
      row.querySelector('.r-load').onclick = async () => { hide(); await onPick(it); };
      row.querySelector('.r-del').onclick = async () => { await window.api.removeRecent(kind, it.path); openSessionModal(); };
      list.appendChild(row);
    }
  };
  // Order matches how a mission is typically loaded: the 3D model first (so waypoints have
  // something to sit on), then the route, then the photos it produced.
  section('Recent 3D models', 'models', recents.models, async (it) => {
    const res = await window.api.loadRecentModel(it.path);
    if (res && res.entry) { state.modelDir = res.dir || it.path; await applyModel(res); maybeSaveSession(); }
    else setStatus('Could not load 3D model from ' + it.path);
  });
  section('Recent routes', 'routes', recents.routes, async (it) => {
    const res = await window.api.loadRecentRoute(it.path);
    if (res && !res.error) await applyRoute(res); else setStatus('Could not load route: ' + (res && res.error || 'missing'));
  });
  section('Recent photo sets', 'photos', recents.photos, async (it) => {
    const res = await window.api.loadRecentPhotos(it.path);
    if (res) applyPhotos(res); else setStatus('Could not load photos from ' + it.path);
  });

  if (!list.children.length) list.innerHTML = '<div class="session-empty">Nothing yet. Open a route, 3D model, or photos and they’ll show here.</div>';
  $('session-modal').classList.remove('hidden');
}

async function loadSessionData(session) {
  setStatus('Loading session…');
  const res = await window.api.loadSessionData(session);
  if (res.error) { setStatus('Session load failed: ' + res.error); return; }
  await applyRoute(res.kmz);
  if (res.model && res.model.entry) {
    state.modelDir = res.model.dir || null;
    await applyModel(res.model);
  }
  applyPhotos(res.photos);
  setStatus('Session loaded.');
}

function matchPhotos() {
  state.photoByWp = new Map();
  if (!state.mission || !state.photos.length) return;
  const wps = state.mission.waypoints.slice().sort((a, b) => a.index - b.index);

  // ---- Build seqNum → WP map (used only as fallback for photos without GPS) ----
  let counter = 0;
  const seqToWp = new Map();
  const wpToSeq = new Map();
  for (const wp of wps) {
    for (const func of (wp.actionFuncs || [])) {
      if (func === 'startRecord') counter++;
      if (func === 'takePhoto') {
        counter++;
        if (!seqToWp.has(counter)) seqToWp.set(counter, wp);
        if (!wpToSeq.has(wp.index)) wpToSeq.set(wp.index, counter);
      }
      if (func === 'orientedShoot') {
        counter++;
        seqToWp.set(counter, wp);
        if (!wpToSeq.has(wp.index)) wpToSeq.set(wp.index, counter);
      }
    }
  }

  const shooterWps = [...new Set(seqToWp.values())];
  const fallbackWps = shooterWps.length ? shooterWps : wps;
  const maxMappedSeq = seqToWp.size ? Math.max(...seqToWp.keys()) : 0;
  const lastShooterWp = seqToWp.get(maxMappedSeq) || null;
  const overflowWp = (lastShooterWp && (lastShooterWp.actionFuncs || []).includes('panoShot'))
    ? lastShooterWp : null;

  // fileSuffix → [WPs]: cross-references the route action name embedded in the photo filename.
  // suffixToWps: maps every fileSuffix (from ALL takePhoto actions on a WP) → [WPs].
  // A WP can have multiple takePhoto actions (different assets captured at one stop),
  // each with its own fileSuffix. We index all of them so every photo's action name
  // can be resolved regardless of which action slot it came from.
  const suffixToWps = new Map();
  for (const wp of shooterWps) {
    const names = wp.photoActionNames; // all fileSuffix values on this WP
    for (const s of names) {
      if (!suffixToWps.has(s)) suffixToWps.set(s, []);
      suffixToWps.get(s).push(wp);
    }
  }

  const parseFilenameTime = (name) => {
    const m = name.match(/DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  };
  const getTime = (p) => (p.time != null ? p.time : parseFilenameTime(p.name));

  // Name-match fallback: only for photos with no seqNum, and only when the name maps
  // to exactly one WP. (Ambiguous names — shared across WPs — are left for GPS.)
  const nameMatch = (p) => {
    if (!p.photoActionName || !suffixToWps.has(p.photoActionName)) return null;
    const candidates = suffixToWps.get(p.photoActionName);
    return candidates.length === 1 ? candidates[0] : null;
  };

  // GPS-match fallback: nearest shooter WP by haversine.
  const gpsMatch = (p, candidates) => {
    if (p.lat == null) return null;
    let best = null, bestD = Infinity;
    for (const wp of candidates) {
      const c = wp.coordinates; if (!c) continue;
      const d = haversine(p.lat, p.lng, c.lat, c.lng);
      if (d < bestD) { bestD = d; best = wp; }
    }
    return best;
  };

  // Sort all non-video photos by capture time so leg detection works on time order.
  const sorted = state.photos.slice().sort((a, b) => {
    const ta = getTime(a), tb = getTime(b);
    if (ta == null && tb == null) return a.name.localeCompare(b.name);
    if (ta == null) return 1; if (tb == null) return -1;
    return ta - tb;
  });
  // ---- Panoramic frames (PANO_NNNN.JPG) ----
  // These carry no DJI seqNum/band/action name and all belong to a panoShot waypoint.
  // GPS is unreliable here (panoShot WPs sit in tight clusters), so assign by the route:
  // every pano frame → the nearest panoShot WP (there is normally exactly one).
  const panoWps = shooterWps.filter((wp) => (wp.actionFuncs || []).includes('panoShot'));
  const panoPhotos = sorted.filter((p) => p.isPano)
    .sort((a, b) => (a.panoFrame ?? 0) - (b.panoFrame ?? 0));
  if (panoPhotos.length && panoWps.length) {
    for (const p of panoPhotos) {
      let target = panoWps[0];
      if (panoWps.length > 1 && p.lat != null) {
        let bestD = Infinity;
        for (const wp of panoWps) {
          const c = wp.coordinates; if (!c) continue;
          const d = haversine(p.lat, p.lng, c.lat, c.lng);
          if (d < bestD) { bestD = d; target = wp; }
        }
      }
      pushPhoto(target.index, p);
    }
  }

  // Everything else (exclude videos and already-handled pano frames) goes through seqNum.
  const realPhotos = sorted.filter((p) => p.type !== 'video' && !p.isPano);

  // ---- PRIMARY: seqNum → WP via the route's media counter (seqToWp) ----
  //
  // DJI stamps each photo with a sequence number that increments once per shutter
  // trigger, in the exact order the route fires its takePhoto actions. seqToWp maps that
  // counter → WP (built above, accounting for startRecord/video offsets). So the photo's
  // seqNum IS the slot index into the route — seqToWp.get(seqNum) is the correct WP,
  // regardless of GPS clustering or whether the photo's embedded name matches the route.
  //
  // Battery swaps reset the counter to 1, so we split photos into legs (>3 min gap) and
  // compute a per-leg seqOffset. Leg 0 needs no offset (seqNum is already the absolute
  // slot). Later legs re-anchor via GPS of the leg's first photo.
  const LEG_GAP_MS = 3 * 60 * 1000;
  const legs = [[]];
  for (const p of realPhotos) {
    const cur = legs[legs.length - 1];
    if (cur.length) {
      const tPrev = getTime(cur[cur.length - 1]), tCur = getTime(p);
      if (tPrev != null && tCur != null && tCur - tPrev > LEG_GAP_MS) legs.push([]);
    }
    legs[legs.length - 1].push(p);
  }

  // runningMax = highest absolute slot (fullSeq) assigned so far across all prior legs.
  // A resumable DJI mission continues at the NEXT waypoint after the one it last shot,
  // so the first shot of a post-swap leg maps to slot (runningMax + 1). This is exact and
  // deterministic — far more reliable than a GPS guess, which mis-picks when waypoints are
  // physically clustered (that caused the off-by-one: a neighbouring WP looked "nearest").
  let runningMax = 0;
  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const legPhotos = legs[legIdx];
    if (!legPhotos.length) continue;
    const legSeqs = legPhotos.map((p) => p.seqNum).filter((s) => s != null);
    const minLegSeq = legSeqs.length ? Math.min(...legSeqs) : null;

    // Per-leg offset:
    //  - Leg 0: photo seqNum is already the absolute DJI counter (seqToWp bakes in any
    //    video startRecord offset), so use it directly — offset 0.
    //  - Later legs: a battery swap resets the counter. We anchor the leg by its FIRST
    //    shot's action name when that name is unique to one waypoint (uniquified routes).
    //    This is exact and self-correcting: if the drone re-shot the SAME waypoint after
    //    the swap (a duplicate seq-1 photo of the prior WP), the name points back to that
    //    WP so the rest of the leg isn't shifted by one. If the name isn't usable, fall
    //    back to the cumulative assumption that it resumed at the next slot (runningMax+1).
    let seqOffset = 0;
    if (legIdx > 0 && minLegSeq != null) {
      seqOffset = runningMax + 1 - minLegSeq; // cumulative fallback
      const firstShot = legPhotos.find((p) => p.seqNum === minLegSeq && p.photoActionName);
      if (firstShot && suffixToWps.has(firstShot.photoActionName)) {
        const cands = suffixToWps.get(firstShot.photoActionName);
        if (cands.length === 1 && wpToSeq.has(cands[0].index)) {
          seqOffset = wpToSeq.get(cands[0].index) - minLegSeq; // anchor to the named WP's slot
        }
      }
    }

    let legMaxFull = runningMax;
    for (const p of legPhotos) {
      // 1) seqNum direct index (primary, proven exact)
      if (p.seqNum != null) {
        const fullSeq = p.seqNum + seqOffset;
        const wp = seqToWp.get(fullSeq);
        if (wp) {
          pushPhoto(wp.index, p);
          if (fullSeq > legMaxFull) legMaxFull = fullSeq;
          continue;
        }
        if (fullSeq > maxMappedSeq && overflowWp) { pushPhoto(overflowWp.index, p); continue; }
      }
      // 2) unique-name fallback (photos missing a seqNum)
      const named = nameMatch(p);
      if (named) { pushPhoto(named.index, p); continue; }
      // 3) GPS fallback
      const gps = gpsMatch(p, fallbackWps);
      if (gps) { pushPhoto(gps.index, p); continue; }
      // 4) last resort
      if (fallbackWps.length) pushPhoto(fallbackWps[0].index, p);
    }
    runningMax = legMaxFull;
  }

  // ---- Post-pass: seqNum consolidation ----
  // T/V/Z bands of the same physical shot share a seqNum but can GPS slightly differently,
  // potentially landing at adjacent WPs. Consolidate them to the majority WP — BUT only
  // within the same temporal shot (capture times within 5 s of each other). After a battery
  // swap the counter resets, so a later leg can produce seqNum 31 again at a completely
  // different location. Without the time guard those cross-leg duplicates would collapse.
  const SAME_SHOT_MS = 5000; // T and V fire within ~1 s; 5 s is a safe tolerance

  // Collect all photos across all WPs, grouped by seqNum
  const bySeq = new Map(); // seqNum → [photo]
  for (const photos of state.photoByWp.values()) {
    for (const p of photos) {
      if (p.seqNum == null) continue;
      if (!bySeq.has(p.seqNum)) bySeq.set(p.seqNum, []);
      bySeq.get(p.seqNum).push(p);
    }
  }

  for (const [, group] of bySeq) {
    if (group.length < 2) continue;
    // Sub-group by temporal proximity: sort by time, then cluster with a 5 s window.
    group.sort((a, b) => (getTime(a) ?? 0) - (getTime(b) ?? 0));
    const clusters = [];
    let cur = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const tA = getTime(group[i - 1]), tB = getTime(group[i]);
      if (tA != null && tB != null && tB - tA <= SAME_SHOT_MS) {
        cur.push(group[i]);
      } else {
        clusters.push(cur); cur = [group[i]];
      }
    }
    clusters.push(cur);

    // Consolidate each cluster independently
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      // Find which WPs this cluster is spread across
      const clusterWps = new Map(); // wpIdx → [photos]
      for (const p of cluster) {
        for (const [wi, list] of state.photoByWp) {
          if (list.includes(p)) {
            if (!clusterWps.has(wi)) clusterWps.set(wi, []);
            clusterWps.get(wi).push(p);
            break;
          }
        }
      }
      if (clusterWps.size <= 1) continue;
      // Move all to the WP that has the most from this cluster
      let targetIdx = null, maxCount = 0;
      for (const [wi, ps] of clusterWps) {
        if (ps.length > maxCount) { maxCount = ps.length; targetIdx = wi; }
      }
      for (const [wi, ps] of clusterWps) {
        if (wi === targetIdx) continue;
        const list = state.photoByWp.get(wi);
        for (const p of ps) {
          const i = list.indexOf(p);
          if (i >= 0) list.splice(i, 1);
          pushPhoto(targetIdx, p);
        }
      }
    }
  }

  // Attach video files to the first WP that has startRecord (= beginning of recording).
  // If no startRecord exists, fall back to the first waypoint.
  const videos = state.photos.filter((p) => p.type === 'video');
  if (videos.length) {
    const recordWp = wps.find((wp) => (wp.actionFuncs || []).includes('startRecord')) || wps[0];
    if (recordWp) {
      for (const v of videos) pushPhoto(recordWp.index, v);
    }
  }
}

function pushPhoto(wpIndex, photo) {
  if (!state.photoByWp.has(wpIndex)) state.photoByWp.set(wpIndex, []);
  state.photoByWp.get(wpIndex).push(photo);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function renderPhotos(index) {
  const strip = $('photo-strip');
  let list = state.photoByWp.get(index) || [];
  if (state.stripFilter) list = list.filter((p) => p.band === state.stripFilter);
  if (!list.length) {
    const why = state.stripFilter ? `No ${state.stripFilter.toUpperCase()} photos at this waypoint.`
      : 'No photos matched to this waypoint.';
    strip.innerHTML = `<div class="hint">${why}</div>`;
    return;
  }
  strip.innerHTML = '';
  list.forEach((p) => strip.appendChild(makeThumb(p, state.photos, state.photos.indexOf(p))));
}

function makeThumb(p, allPhotos, idx) {
  const fig = document.createElement('figure');
  fig.className = 'thumb';
  fig.title = p.name;  // native hover tooltip

  let img;
  if (p.type === 'video') {
    img = document.createElement('video');
    img.src = p.url;
    img.muted = true;
    img.preload = 'metadata';
    img.addEventListener('loadedmetadata', () => { img.currentTime = 0.5; });
    img.style.cssText = 'width:100%;height:96px;object-fit:cover;display:block;background:#000;cursor:pointer;';
    const play = document.createElement('span');
    play.className = 'video-play-icon';
    play.textContent = '▶';
    fig.appendChild(play);
  } else {
    img = document.createElement('img');
    img.src = p.thumb; img.alt = p.name; img.loading = 'lazy';
  }

  img.onclick = () => {
    document.querySelectorAll('figure.thumb').forEach((f) => f.classList.remove('img-selected'));
    fig.classList.add('img-selected');
    renderImageInfo(p);
    // Update the waypoint # badge to reflect the wp that owns this photo
    const ownerWp = wpIndexForPhoto(p);
    $('sel-idx').textContent = ownerWp != null ? '#' + (ownerWp + 1) : 'none';
    // If FPV is active, reposition camera to that waypoint without wiping the photo strip
    if (ownerWp != null && ownerWp !== state.selected) {
      if (aimDraft && aimDraft.wpIndex !== ownerWp) revertAim(); // discard unconfirmed edit
      state.selected = ownerWp;
      if (state.fpv) highlightWaypoint(ownerWp);
      document.querySelectorAll('#wp-body tr').forEach((tr) => {
        tr.classList.toggle('sel', parseInt(tr.dataset.idx, 10) === ownerWp);
      });
      const row = document.querySelector(`#wp-body tr[data-idx="${ownerWp}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  };
  img.ondblclick = (e) => {
    e.stopPropagation();
    if (window.api && window.api.openImageViewer) {
      const vp = photosForViewer();
      const vi = vp.findIndex((x) => x.name === p.name);
      // If a search is active, scope the popup's navigation to just those results, so
      // prev/next steps through only the matches (e.g. PRV → WP 111, 125, 266).
      // Two independent search boxes can drive the scope:
      //   • image-name search (right column) → photos whose filename matches
      //   • waypoint search (left column)    → photos belonging to the matched waypoints
      const imgQ = ($('photo-search').value || '').trim();
      const wpQ = ($('wp-search').value || '').trim();
      let scope = null, filter = p.band || null;
      if (imgQ) {
        const ql = imgQ.toLowerCase();
        const names = vp.filter((x) => x.name.toLowerCase().includes(ql)).map((x) => x.name);
        if (names.length) { scope = { names, label: imgQ }; filter = null; }
      } else if (wpQ && state.mission) {
        const ql = wpQ.toLowerCase();
        const matchWp = (wp) => String(wp.index + 1).includes(ql) ||
          (wp.photoActionName || '').toLowerCase().includes(ql);
        const names = [];
        for (const wp of state.mission.waypoints) {
          if (!matchWp(wp)) continue;
          for (const ph of (state.photoByWp.get(wp.index) || [])) names.push(ph.name);
        }
        if (names.length) { scope = { names, label: wpQ }; filter = null; }
      }
      window.api.openImageViewer(vp, vi >= 0 ? vi : 0, filter, scope);
    }
  };
  fig.appendChild(img);

  if (p.band) {
    const b = document.createElement('span');
    b.className = 'band band-' + p.band;
    b.textContent = p.band === 'ir' ? 'IR' : p.band === 'zoom' ? 'ZOOM'
      : p.band === 'pano' ? 'PANO' : 'WIDE';
    fig.appendChild(b);
  }

  const cap = document.createElement('figcaption');
  cap.textContent = p.name;
  fig.appendChild(cap);

  return fig;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function exportRoute() {
  if (!state.mission) return;
  const name = ($('route-name').value || state.routeName).trim();
  const v = validateRouteName(name);
  if (!v.ok) { setStatus(v.message || 'Invalid route name.'); return; }
  setStatus('Packaging KMZ…');
  try {
    const buffer = await state.mission.toBuffer('renderer');
    const r = await window.api.saveKmz(buffer, name);
    if (r) {
      setDirty(false);
      setStatus('Exported: ' + r.path + ' — ready to upload to FlightHub 2.');
    } else {
      setStatus('Export cancelled.');
    }
  } catch (e) {
    setStatus('Export failed: ' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', boot);
