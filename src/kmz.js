/*
 * kmz.js — WPML route engine for DJI FlightHub 2 / Pilot 2 KMZ files.
 *
 * Design rule: EDIT THE DOM IN PLACE. We never rebuild XML from a partial
 * model, because that would silently drop any element we didn't model
 * (POI points, turn params, RC-lost actions, payload info, etc.). We parse
 * both wpmz/template.kml and wpmz/waylines.wpml into DOM trees, mutate only
 * the specific nodes the operator changes, and re-serialize the whole tree.
 * Untouched config survives unchanged.
 *
 * Runs unmodified in Node (tests) and in the Electron renderer.
 */

const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const WPML_NS = 'http://www.dji.com/wpmz/1.0.6';

// FlightHub 2 forbids these characters in route names. Hyphens are safe.
const FORBIDDEN_ROUTE_CHARS = ['<', '>', ':', '"', '/', '|', '?', '*', '.', '_', '\\'];

// ---------------------------------------------------------------------------
// DOM helpers (qualified-name based; DJI files use the literal "wpml:" prefix)
// ---------------------------------------------------------------------------

function directChildren(node, tagName) {
  const out = [];
  if (!node) return out;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === tagName) out.push(c);
  }
  return out;
}

function firstChildEl(node, tagName) {
  const c = directChildren(node, tagName);
  return c.length ? c[0] : null;
}

function childText(node, tagName) {
  const el = firstChildEl(node, tagName);
  return el ? el.textContent.trim() : null;
}

// Set text on a direct child; create the child (preserving wpml: prefix) if missing.
// `before` optionally controls insertion position for newly created nodes.
function setChildText(doc, node, tagName, value) {
  let el = firstChildEl(node, tagName);
  if (!el) {
    el = doc.createElement(tagName);
    node.appendChild(el);
  }
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(doc.createTextNode(String(value)));
  return el;
}

function descendants(node, tagName) {
  // getElementsByTagName matches qualified names in @xmldom/xmldom.
  const list = node.getElementsByTagName(tagName);
  return Array.prototype.slice.call(list);
}

// UUID v4 for new orientedShoot/panoShot actions (uses the platform crypto when available).
function uuidv4() {
  const g = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Build the <wpml:action> XML string(s) for a new action/block, matching FlightHub's format.
// `ctx` = { kind, heading, pitch, focal, lens, useGlobalLens, isWl }; `nextId()` yields ids.
function actionBlockXml(ctx, nextId) {
  const { kind, heading, pitch, focal, lens, useGlobalLens, shared, isWl } = ctx;
  const A = (func, params) =>
    '<wpml:action xmlns:wpml="http://www.dji.com/wpmz/1.0.6">'
    + `<wpml:actionId>${nextId()}</wpml:actionId>`
    + `<wpml:actionActuatorFunc>${func}</wpml:actionActuatorFunc>`
    + `<wpml:actionActuatorFuncParam>${params}</wpml:actionActuatorFuncParam></wpml:action>`;
  const rotateYaw = () => A('rotateYaw',
    `<wpml:aircraftHeading>${heading}</wpml:aircraftHeading>`
    + '<wpml:aircraftPathMode>counterClockwise</wpml:aircraftPathMode>');
  const gimbalRotate = () => A('gimbalRotate',
    '<wpml:gimbalHeadingYawBase>north</wpml:gimbalHeadingYawBase>'
    + '<wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>'
    + '<wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>'
    + `<wpml:gimbalPitchRotateAngle>${pitch}</wpml:gimbalPitchRotateAngle>`
    + '<wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>'
    + '<wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>'
    + '<wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>'
    + '<wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>'
    + '<wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>'
    + '<wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>'
    + '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>');
  const zoom = () => A('zoom',
    `<wpml:focalLength>${focal}</wpml:focalLength>`
    + '<wpml:isUseFocalFactor>0</wpml:isUseFocalFactor>'
    + '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>');
  const orientedShoot = () => {
    const lensLine = isWl ? `<wpml:payloadLensIndex>${lens}</wpml:payloadLensIndex>` : '';
    return A('orientedShoot',
      `<wpml:gimbalPitchRotateAngle>${pitch}</wpml:gimbalPitchRotateAngle>`
      + '<wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>'
      + `<wpml:gimbalYawRotateAngle>${heading}</wpml:gimbalYawRotateAngle>`
      + '<wpml:focusX>0</wpml:focusX><wpml:focusY>0</wpml:focusY>'
      + '<wpml:focusRegionWidth>0</wpml:focusRegionWidth><wpml:focusRegionHeight>0</wpml:focusRegionHeight>'
      + `<wpml:focalLength>${focal}</wpml:focalLength>`
      + `<wpml:aircraftHeading>${heading}</wpml:aircraftHeading>`
      + '<wpml:accurateFrameValid>0</wpml:accurateFrameValid>'
      + '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>'
      + `<wpml:useGlobalPayloadLensIndex>${useGlobalLens}</wpml:useGlobalPayloadLensIndex>`
      + lensLine
      + '<wpml:targetAngle>0</wpml:targetAngle>'
      + `<wpml:actionUUID>${shared.uuid}</wpml:actionUUID>`
      + '<wpml:imageWidth>0</wpml:imageWidth><wpml:imageHeight>0</wpml:imageHeight>'
      + '<wpml:AFPos>0</wpml:AFPos><wpml:gimbalPort>0</wpml:gimbalPort>'
      + '<wpml:orientedCameraType>99</wpml:orientedCameraType>'
      + `<wpml:orientedFilePath>${shared.file}</wpml:orientedFilePath>`
      + '<wpml:orientedFileMD5/><wpml:orientedFileSize>0</wpml:orientedFileSize>'
      + '<wpml:orientedPhotoMode>normalPhoto</wpml:orientedPhotoMode>');
  };
  if (kind === 'takePhotoFixed') return [rotateYaw(), gimbalRotate(), zoom(), orientedShoot()];
  if (kind === 'pano') return [A('panoShot',
    '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>'
    + '<wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>'
    + '<wpml:payloadLensIndex>wide</wpml:payloadLensIndex>'
    + `<wpml:actionUUID>${shared.uuid}</wpml:actionUUID>`
    + '<wpml:panoShotSubMode>panoShot_360</wpml:panoShotSubMode>')];
  if (kind === 'startRecord') {
    const lensLine = isWl ? `<wpml:payloadLensIndex>${lens}</wpml:payloadLensIndex>` : '';
    return [A('startRecord',
      '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>'
      + `<wpml:useGlobalPayloadLensIndex>${useGlobalLens}</wpml:useGlobalPayloadLensIndex>` + lensLine)];
  }
  if (kind === 'stopRecord') return [A('stopRecord', '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>')];
  return [];
}

// ---------------------------------------------------------------------------
// Mission model
// ---------------------------------------------------------------------------

/**
 * A Mission wraps the zip + both DOM trees and exposes a flat waypoint list.
 * Each waypoint holds direct references to its Placemark node in *both*
 * documents so edits stay in sync.
 */
class Mission {
  constructor(zip, entries, templateDoc, waylinesDoc, paths) {
    this.zip = zip;
    this.entries = entries;          // { path: Uint8Array } for every zip member
    this.templateDoc = templateDoc;
    this.waylinesDoc = waylinesDoc;
    this.paths = paths;              // { template, waylines, prefix }
    this.waypoints = [];
    this._index();
  }

  _index() {
    const tplPlacemarks = this.templateDoc
      ? indexPlacemarks(this.templateDoc)
      : new Map();
    const wlPlacemarks = this.waylinesDoc
      ? indexPlacemarks(this.waylinesDoc)
      : new Map();

    const allIdx = new Set([...tplPlacemarks.keys(), ...wlPlacemarks.keys()]);
    const ordered = [...allIdx].sort((a, b) => a - b);

    this.waypoints = ordered.map((idx) => {
      const tpl = tplPlacemarks.get(idx) || null;
      const wl = wlPlacemarks.get(idx) || null;
      return new Waypoint(this, idx, tpl, wl);
    });
  }

  /** Mission-level config read from template.kml (folder + missionConfig). */
  globals() {
    const out = {};
    const doc = this.templateDoc || this.waylinesDoc;
    if (!doc) return out;
    const cfg = descendants(doc, 'wpml:missionConfig')[0];
    if (cfg) {
      out.finishAction = childText(cfg, 'wpml:finishAction');
      out.flyToWaylineMode = childText(cfg, 'wpml:flyToWaylineMode');
      out.takeOffSecurityHeight = childText(cfg, 'wpml:takeOffSecurityHeight');
      out.globalTransitionalSpeed = childText(cfg, 'wpml:globalTransitionalSpeed');
      // takeOffRefPoint = "lat,lng,ellipsoidAltitude". FlightHub's per-waypoint "ALT"
      // (height above ground) = waypoint ellipsoid height − this takeoff altitude.
      const ref = childText(cfg, 'wpml:takeOffRefPoint');
      if (ref) {
        const parts = ref.split(',').map((s) => parseFloat(s));
        if (parts.length === 3 && !isNaN(parts[2])) out.takeOffRefAltitude = parts[2];
      }
    }
    const folder = descendants(doc, 'Folder')[0];
    if (folder) {
      out.autoFlightSpeed = childText(folder, 'wpml:autoFlightSpeed');
      out.globalHeight = childText(folder, 'wpml:globalHeight');
      const coordSys = firstChildEl(folder, 'wpml:waylineCoordinateSysParam');
      if (coordSys) {
        out.coordinateMode = childText(coordSys, 'wpml:coordinateMode');
        out.heightMode = childText(coordSys, 'wpml:heightMode');
      }
    }
    return out;
  }

  /**
   * Translate the WHOLE route by metres East / North / Up. Used to re-base a route onto a
   * different RTK correction source (mount point / dock antenna): each source anchors the site
   * in a slightly different reference frame, so a route authored against one shifts by a
   * constant offset under another. A pure translation — headings, gimbals, zooms and the AGL
   * height field are untouched; the absolute heights and takeoff reference move together so
   * AGL stays identical. Deliberately does NOT clear wpml:useGlobalHeight (flight height is
   * not being changed, only the datum).
   */
  shiftRoute(dEastM, dNorthM, dUpM) {
    const dE = parseFloat(dEastM) || 0, dN = parseFloat(dNorthM) || 0, dU = parseFloat(dUpM) || 0;
    if (!dE && !dN && !dU) return;
    const M_PER_DEG_LAT = 111320; // good to ~0.1% — far below RTK shift magnitudes
    const shiftCoords = (doc, node) => {
      if (!node) return;
      const pt = firstChildEl(node, 'Point');
      const el = pt && firstChildEl(pt, 'coordinates');
      if (!el) return;
      const parts = el.textContent.trim().split(',').map((s) => parseFloat(s));
      if (parts.length < 2 || parts.some((v, i) => i < 2 && isNaN(v))) return;
      const [lng, lat] = parts;
      const nLat = lat + dN / M_PER_DEG_LAT;
      const nLng = lng + dE / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
      // keep any trailing altitude component untouched
      const rest = parts.length > 2 ? ',' + parts.slice(2).join(',') : '';
      setChildText(doc, pt, 'coordinates', nLng.toFixed(9) + ',' + nLat.toFixed(9) + rest);
    };
    const bumpTag = (doc, node, tag) => {
      if (!node || !dU) return;
      const el = firstChildEl(node, tag); if (!el) return;
      const cur = parseFloat(el.textContent); if (isNaN(cur)) return;
      setChildText(doc, node, tag, parseFloat((cur + dU).toFixed(4)));
    };
    for (const wp of this.waypoints) {
      shiftCoords(this.templateDoc, wp.tplNode);
      shiftCoords(this.waylinesDoc, wp.wlNode);
      bumpTag(this.waylinesDoc, wp.wlNode, 'wpml:executeHeight');
      bumpTag(this.templateDoc, wp.tplNode, 'wpml:ellipsoidHeight');
      // wpml:height is AGL — same physical ground, unchanged.
    }
    // takeOffRefPoint = "lat,lng,ellipsoidAltitude" in each doc's missionConfig.
    for (const doc of [this.templateDoc, this.waylinesDoc]) {
      if (!doc) continue;
      const cfg = descendants(doc, 'wpml:missionConfig')[0];
      const el = cfg && firstChildEl(cfg, 'wpml:takeOffRefPoint');
      if (!el) continue;
      const p = el.textContent.trim().split(',').map((s) => parseFloat(s));
      if (p.length !== 3 || p.some(isNaN)) continue;
      const nLat = p[0] + dN / M_PER_DEG_LAT;
      const nLng = p[1] + dE / (M_PER_DEG_LAT * Math.cos((p[0] * Math.PI) / 180));
      setChildText(doc, cfg, 'wpml:takeOffRefPoint',
        nLat.toFixed(9) + ',' + nLng.toFixed(9) + ',' + parseFloat((p[2] + dU).toFixed(4)));
    }
  }

  /** Re-zip into a Buffer/Uint8Array, replacing only the two edited XML files. */
  async toBuffer(platform) {
    const ser = new XMLSerializer();
    const zip = new JSZip();
    // Re-add every original entry, swapping the two docs we may have edited.
    for (const [path, data] of Object.entries(this.entries)) {
      if (path === this.paths.template && this.templateDoc) {
        zip.file(path, ser.serializeToString(this.templateDoc));
      } else if (path === this.paths.waylines && this.waylinesDoc) {
        zip.file(path, ser.serializeToString(this.waylinesDoc));
      } else {
        zip.file(path, data);
      }
    }
    const type = platform === 'node' ? 'nodebuffer' : 'arraybuffer';
    return zip.generateAsync({
      type,
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }
}

function indexPlacemarks(doc) {
  const map = new Map();
  const placemarks = descendants(doc, 'Placemark');
  let fallback = 0;
  for (const pm of placemarks) {
    let idxText = childText(pm, 'wpml:index');
    let idx = idxText !== null ? parseInt(idxText, 10) : fallback;
    if (Number.isNaN(idx)) idx = fallback;
    map.set(idx, pm);
    fallback++;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Waypoint — reads/writes the same logical parameter in both DOM trees
// ---------------------------------------------------------------------------

class Waypoint {
  constructor(mission, index, tplNode, wlNode) {
    this.mission = mission;
    this.index = index;
    this.tplNode = tplNode;   // Placemark in template.kml
    this.wlNode = wlNode;     // Placemark in waylines.wpml
  }

  get _primary() { return this.wlNode || this.tplNode; }

  // --- coordinates ---------------------------------------------------------
  get coordinates() {
    const pt = firstChildEl(this._primary, 'Point');
    const txt = pt ? childText(pt, 'coordinates') : null;
    if (!txt) return null;
    const [lng, lat] = txt.split(',').map((s) => parseFloat(s));
    return { lng, lat };
  }

  // --- height (m). template uses height/ellipsoidHeight; waylines uses executeHeight
  get height() {
    const wl = this.wlNode && childText(this.wlNode, 'wpml:executeHeight');
    if (wl !== null && wl !== undefined) return parseFloat(wl);
    const tpl = this.tplNode && childText(this.tplNode, 'wpml:height');
    return tpl !== null && tpl !== undefined ? parseFloat(tpl) : null;
  }
  // Height above ground (m) — matches FlightHub's per-waypoint "ALT" readout.
  // Computed as the waypoint's absolute ellipsoid height minus the mission's
  // takeOffRefPoint ellipsoid altitude. This is reliable even after a height raise
  // (both come from the absolute fields), unlike the route's stored wpml:height which
  // can drift out of sync. Falls back to wpml:height if no takeoff ref is present.
  get aglHeight() {
    const refAlt = this.mission.globals().takeOffRefAltitude;
    const abs = this.height; // absolute WGS84 ellipsoid height (executeHeight)
    if (refAlt != null && abs != null) {
      return parseFloat((abs - refAlt).toFixed(2));
    }
    const tpl = this.tplNode && childText(this.tplNode, 'wpml:height');
    return tpl !== null && tpl !== undefined ? parseFloat(tpl) : null;
  }
  setHeight(v) {
    const doc = this.mission;
    if (this.wlNode) setChildText(doc.waylinesDoc, this.wlNode, 'wpml:executeHeight', v);
    if (this.tplNode) {
      setChildText(doc.templateDoc, this.tplNode, 'wpml:height', v);
      // ellipsoidHeight is an absolute reference; only touch it if present.
      if (firstChildEl(this.tplNode, 'wpml:ellipsoidHeight')) {
        setChildText(doc.templateDoc, this.tplNode, 'wpml:ellipsoidHeight', v);
      }
    }
    this._useOwnHeight();
  }

  // A waypoint flagged wpml:useGlobalHeight=1 flies at the mission's globalHeight and IGNORES its
  // own per-waypoint height — so any height edit is silently dropped by FlightHub. Whenever we
  // change a waypoint's height we must clear this flag so the edit actually takes effect.
  _useOwnHeight() {
    if (this.tplNode && firstChildEl(this.tplNode, 'wpml:useGlobalHeight'))
      setChildText(this.mission.templateDoc, this.tplNode, 'wpml:useGlobalHeight', 0);
    if (this.wlNode && firstChildEl(this.wlNode, 'wpml:useGlobalHeight'))
      setChildText(this.mission.waylinesDoc, this.wlNode, 'wpml:useGlobalHeight', 0);
  }

  // Raise (or lower) the absolute height by delta metres without corrupting the
  // AGL wpml:height field. Only executeHeight (waylines) and ellipsoidHeight
  // (template) are touched — both are absolute WGS84 ellipsoid heights.
  raiseHeight(delta) {
    if (this.wlNode) {
      const cur = parseFloat(childText(this.wlNode, 'wpml:executeHeight') || '0');
      if (!isNaN(cur)) setChildText(this.mission.waylinesDoc, this.wlNode, 'wpml:executeHeight',
        parseFloat((cur + delta).toFixed(4)));
    }
    if (this.tplNode && firstChildEl(this.tplNode, 'wpml:ellipsoidHeight')) {
      const cur = parseFloat(childText(this.tplNode, 'wpml:ellipsoidHeight') || '0');
      if (!isNaN(cur)) setChildText(this.mission.templateDoc, this.tplNode, 'wpml:ellipsoidHeight',
        parseFloat((cur + delta).toFixed(4)));
    }
    // wpml:height is AGL — intentionally not touched.
    this._useOwnHeight();
  }

  // Change the AGL flight height by delta metres, keeping all height fields consistent:
  // bumps executeHeight (waylines) AND wpml:height + ellipsoidHeight (template) together,
  // so the above-ground value and the absolute value both move. Used by the FPV Alt editor.
  bumpHeight(delta) {
    const bump = (doc, node, tag) => {
      if (!node) return;
      const el = firstChildEl(node, tag); if (!el) return;
      const cur = parseFloat(el.textContent); if (isNaN(cur)) return;
      setChildText(doc, node, tag, parseFloat((cur + delta).toFixed(4)));
    };
    bump(this.mission.waylinesDoc, this.wlNode, 'wpml:executeHeight');
    bump(this.mission.templateDoc, this.tplNode, 'wpml:height');
    bump(this.mission.templateDoc, this.tplNode, 'wpml:ellipsoidHeight');
    this._useOwnHeight();
  }

  // --- speed (m/s) ---------------------------------------------------------
  get speed() {
    const v = childText(this._primary, 'wpml:waypointSpeed');
    return v !== null ? parseFloat(v) : null;
  }
  setSpeed(v) {
    if (this.wlNode) setChildText(this.mission.waylinesDoc, this.wlNode, 'wpml:waypointSpeed', v);
    if (this.tplNode) setChildText(this.mission.templateDoc, this.tplNode, 'wpml:waypointSpeed', v);
  }

  // --- heading / yaw -------------------------------------------------------
  _headingParam(node) { return node ? firstChildEl(node, 'wpml:waypointHeadingParam') : null; }
  get headingMode() {
    const p = this._headingParam(this._primary);
    return p ? childText(p, 'wpml:waypointHeadingMode') : null;
  }
  get headingAngle() {
    const p = this._headingParam(this._primary);
    const v = p ? childText(p, 'wpml:waypointHeadingAngle') : null;
    return v !== null ? parseFloat(v) : null;
  }
  setHeading(mode, angle) {
    const apply = (doc, node) => {
      if (!node) return;
      let p = firstChildEl(node, 'wpml:waypointHeadingParam');
      if (!p) {
        p = doc.createElement('wpml:waypointHeadingParam');
        node.appendChild(p);
      }
      if (mode != null) setChildText(doc, p, 'wpml:waypointHeadingMode', mode);
      if (angle != null) {
        setChildText(doc, p, 'wpml:waypointHeadingAngle', angle);
        // When a fixed angle is set, DJI expects the enable flag on.
        if (mode === 'fixed' || mode === 'smoothTransition') {
          setChildText(doc, p, 'wpml:waypointHeadingAngleEnable', 1);
        }
      }
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  // --- actions: gimbal pitch, zoom focal length, photo lens ----------------
  _actions(node) {
    if (!node) return [];
    return descendants(node, 'wpml:action');
  }
  _findAction(node, func) {
    return this._actions(node).find((a) => childText(a, 'wpml:actionActuatorFunc') === func) || null;
  }
  _actionParam(action) {
    return action ? firstChildEl(action, 'wpml:actionActuatorFuncParam') : null;
  }
  // orientedShoot bakes its OWN gimbal pitch / aircraft heading / focal length into the shot
  // action, and in FlightHub THAT is what actually aims the captured photo (the separate
  // gimbalRotate/rotateYaw/zoom actions only pre-position the gimbal). So when one of those is
  // edited, mirror the change into the orientedShoot param too — otherwise the photo fires at the
  // stale angle. Only updates a param that already exists (never injects new tags / reorders).
  _syncOrientedShoot(doc, node, tag, value) {
    const os = this._findAction(node, 'orientedShoot');
    if (!os) return;
    const op = this._actionParam(os);
    if (op && firstChildEl(op, tag)) setChildText(doc, op, tag, value);
  }

  get gimbalPitch() {
    // Prefer a gimbalRotate action; fall back to a placemark-level pitch.
    const a = this._findAction(this._primary, 'gimbalRotate');
    if (a) {
      const p = this._actionParam(a);
      const v = p && childText(p, 'wpml:gimbalPitchRotateAngle');
      if (v !== null && v !== undefined) return parseFloat(v);
    }
    const direct = childText(this._primary, 'wpml:gimbalPitchAngle');
    return direct !== null ? parseFloat(direct) : null;
  }
  setGimbalPitch(v) {
    const apply = (doc, node) => {
      if (!node) return;
      const a = this._findAction(node, 'gimbalRotate');
      if (a) {
        const p = this._actionParam(a);
        if (p) setChildText(doc, p, 'wpml:gimbalPitchRotateAngle', v);
      } else if (firstChildEl(node, 'wpml:gimbalPitchAngle')) {
        setChildText(doc, node, 'wpml:gimbalPitchAngle', v);
      }
      this._syncOrientedShoot(doc, node, 'wpml:gimbalPitchRotateAngle', v);
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  get zoomFocalLength() {
    const a = this._findAction(this._primary, 'zoom');
    if (!a) return null;
    const p = this._actionParam(a);
    const v = p && childText(p, 'wpml:focalLength');
    return v !== null && v !== undefined ? parseFloat(v) : null;
  }
  setZoomFocalLength(v) {
    const apply = (doc, node) => {
      if (!node) return;
      const a = this._findAction(node, 'zoom');
      const p = a && this._actionParam(a);
      if (p) setChildText(doc, p, 'wpml:focalLength', v);
      this._syncOrientedShoot(doc, node, 'wpml:focalLength', v);
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  // Aircraft yaw the camera is actually aimed with, from the rotateYaw action.
  get aircraftHeading() {
    const a = this._findAction(this._primary, 'rotateYaw');
    if (!a) return null;
    const p = this._actionParam(a);
    const v = p && childText(p, 'wpml:aircraftHeading');
    return v !== null && v !== undefined ? parseFloat(v) : null;
  }
  setAircraftHeading(v) {
    const apply = (doc, node) => {
      if (!node) return;
      const a = this._findAction(node, 'rotateYaw');
      const p = a && this._actionParam(a);
      if (p) setChildText(doc, p, 'wpml:aircraftHeading', v);
      // orientedShoot stores the shot's yaw in BOTH aircraftHeading and gimbalYawRotateAngle —
      // they're equal natively, so keep both in sync or the photo yaws off by the stale gap.
      this._syncOrientedShoot(doc, node, 'wpml:aircraftHeading', v);
      this._syncOrientedShoot(doc, node, 'wpml:gimbalYawRotateAngle', v);
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  // Ordered list of action function names at this waypoint, as they appear in the XML.
  // Used to simulate the DJI media counter (startRecord increments it, takePhoto increments it,
  // stopRecord does NOT — it only closes the current video clip without creating a new file).
  get actionFuncs() {
    return this._actions(this._primary)
      .map((a) => childText(a, 'wpml:actionActuatorFunc'))
      .filter(Boolean);
  }

  // Whether this waypoint fires the camera at all (takePhoto, orientedShoot, or panoShot).
  // orientedShoot takes a directed photo at a specific gimbal angle (also increments the counter).
  // panoShot takes a panoramic sequence (multiple frames, drone stationary, GPS-matched).
  get hasPhotoAction() {
    return ['takePhoto', 'orientedShoot', 'panoShot'].some(
      (f) => this._findAction(this._primary, f) !== null
    );
  }

  // Extract { name, lenses } from one action IF it's a photo capture. Handles both
  // forms FlightHub produces:
  //   • takePhoto    → name in <wpml:fileSuffix>,        lens token "wide"/"ir"/"zoom"
  //   • orientedShoot→ name in <wpml:orientedFileSuffix>, lens token "visable"(sic)/"ir"
  // Lens tokens are normalized to wide/ir/zoom for display. Returns null for non-photo actions.
  _photoActionInfo(a) {
    const func = childText(a, 'wpml:actionActuatorFunc');
    if (func !== 'takePhoto' && func !== 'orientedShoot') return null;
    const p = this._actionParam(a);
    const nm = p && (childText(p, 'wpml:fileSuffix') || childText(p, 'wpml:orientedFileSuffix'));
    const raw = p && childText(p, 'wpml:payloadLensIndex');
    const norm = (l) => { const x = l.toLowerCase(); return (x.includes('ir') || x.includes('therm')) ? 'ir' : x.includes('zoom') ? 'zoom' : 'wide'; };
    const lenses = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean).map(norm) : [];
    return { name: (nm && nm.trim()) || null, lenses };
  }

  // First photo action's name (backwards-compat); use photoActionNames for all.
  get photoActionName() {
    for (const a of this._actions(this._primary)) {
      const info = this._photoActionInfo(a);
      if (info && info.name) return info.name;
    }
    return null;
  }
  // Every photo action's name on this WP (a stop can capture several named shots).
  get photoActionNames() {
    return this._actions(this._primary)
      .map((a) => this._photoActionInfo(a))
      .filter((i) => i && i.name)
      .map((i) => i.name);
  }
  // Each photo action as { name, lenses } — drives the per-waypoint Photo actions panel.
  get photoActions() {
    return this._actions(this._primary)
      .map((a) => this._photoActionInfo(a))
      .filter(Boolean);
  }

  // Split a placemark's actions into per-shot blocks. FlightHub emits one
  // [rotateYaw, gimbalRotate, zoom, orientedShoot] group per shot; a capture action closes a
  // block and the yaw/gimbal/zoom seen since the previous capture are that shot's pre-position.
  // Lets us edit ANY shot on a multi-shot waypoint, not just the first.
  _shotBlocks(node) {
    const out = [];
    let cur = { yaw: null, gimbal: null, zoom: null, shot: null, func: null };
    for (const a of this._actions(node)) {
      const fn = childText(a, 'wpml:actionActuatorFunc');
      if (fn === 'rotateYaw') cur.yaw = a;
      else if (fn === 'gimbalRotate') cur.gimbal = a;
      else if (fn === 'zoom') cur.zoom = a;
      else if (fn === 'takePhoto' || fn === 'orientedShoot') {
        cur.shot = a; cur.func = fn; out.push(cur);
        cur = { yaw: null, gimbal: null, zoom: null, shot: null, func: null };
      }
    }
    return out;
  }

  // Per-shot aim/info (index matches photoActions order). Each entry reports the shot's own
  // tilt/heading/zoom, preferring the pre-position action's value and falling back to the
  // orientedShoot's baked value.
  get photoShots() {
    return this._shotBlocks(this._primary).map((b, i) => {
      const info = this._photoActionInfo(b.shot) || { name: null, lenses: [] };
      const os = b.func === 'orientedShoot' ? this._actionParam(b.shot) : null;
      const read = (action, tag) => {
        const p = action && this._actionParam(action);
        const v = p && childText(p, tag);
        return v !== null && v !== undefined ? parseFloat(v) : null;
      };
      const osv = (tag) => { const v = os && childText(os, tag); return v !== null && v !== undefined ? parseFloat(v) : null; };
      const pitch = read(b.gimbal, 'wpml:gimbalPitchRotateAngle');
      const heading = read(b.yaw, 'wpml:aircraftHeading');
      const focal = read(b.zoom, 'wpml:focalLength');
      return {
        index: i, name: info.name, lenses: info.lenses, func: b.func,
        gimbalPitch: pitch != null ? pitch : osv('wpml:gimbalPitchRotateAngle'),
        aircraftHeading: heading != null ? heading : osv('wpml:aircraftHeading'),
        zoomFocalLength: focal != null ? focal : osv('wpml:focalLength'),
      };
    });
  }

  // Edit ONE shot's tilt/heading/zoom (block index k) in both docs. Updates that block's
  // gimbalRotate/rotateYaw/zoom pre-position AND the orientedShoot's baked params (the latter is
  // what FlightHub actually captures with). Other shots on the same waypoint are untouched.
  setShotGimbalPitch(k, v) {
    const apply = (doc, node) => {
      const b = this._shotBlocks(node)[k]; if (!b) return;
      if (b.gimbal) { const p = this._actionParam(b.gimbal); if (p) setChildText(doc, p, 'wpml:gimbalPitchRotateAngle', v); }
      if (b.func === 'orientedShoot') { const p = this._actionParam(b.shot); if (p && firstChildEl(p, 'wpml:gimbalPitchRotateAngle')) setChildText(doc, p, 'wpml:gimbalPitchRotateAngle', v); }
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }
  setShotAircraftHeading(k, v) {
    const apply = (doc, node) => {
      const b = this._shotBlocks(node)[k]; if (!b) return;
      if (b.yaw) { const p = this._actionParam(b.yaw); if (p) setChildText(doc, p, 'wpml:aircraftHeading', v); }
      if (b.func === 'orientedShoot') { const p = this._actionParam(b.shot); if (p) {
        // orientedShoot stores yaw in both aircraftHeading and gimbalYawRotateAngle — keep both.
        if (firstChildEl(p, 'wpml:aircraftHeading')) setChildText(doc, p, 'wpml:aircraftHeading', v);
        if (firstChildEl(p, 'wpml:gimbalYawRotateAngle')) setChildText(doc, p, 'wpml:gimbalYawRotateAngle', v);
      } }
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }
  setShotZoomFocalLength(k, v) {
    const apply = (doc, node) => {
      const b = this._shotBlocks(node)[k]; if (!b) return;
      if (b.zoom) { const p = this._actionParam(b.zoom); if (p) setChildText(doc, p, 'wpml:focalLength', v); }
      if (b.func === 'orientedShoot') { const p = this._actionParam(b.shot); if (p && firstChildEl(p, 'wpml:focalLength')) setChildText(doc, p, 'wpml:focalLength', v); }
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  // --- add actions ---------------------------------------------------------
  // Insert a new action (or capture block) into this waypoint's reachPoint action group, in BOTH
  // docs, with fresh sequential actionIds. Serialization matches what FlightHub emits (verified
  // against the APP INFO.kmz specimen — see WPML action catalog in CLAUDE.md), including the quirk
  // that orientedShoot/startRecord carry payloadLensIndex in waylines but not template.
  // kinds: 'takePhotoFixed' (rotateYaw+gimbalRotate+zoom+orientedShoot), 'pano', 'startRecord',
  // 'stopRecord'. Returns { undo, redo } that remove/re-append the created nodes (for history).
  addAction(kind, opts = {}) {
    const shared = { uuid: uuidv4(), file: uuidv4() }; // orientedShoot/panoShot GUIDs — same in both docs
    const heightless = { kind, shared,
      heading: opts.heading != null ? opts.heading : (this.aircraftHeading != null ? this.aircraftHeading : 0),
      pitch: opts.pitch != null ? opts.pitch : (this.gimbalPitch != null ? this.gimbalPitch : -90),
      focal: opts.focal != null ? opts.focal : (this.zoomFocalLength != null ? this.zoomFocalLength : 24),
      lens: opts.lens || 'visable,ir',
      useGlobalLens: opts.useGlobalLens != null ? opts.useGlobalLens : 1,
    };
    const created = [];
    const buildInto = (doc, node, isWl) => {
      if (!node) return;
      const group = this._reachPointGroup(doc, node);
      if (!group) return;
      const acts = group.getElementsByTagName('wpml:action');
      let nextId = 0;
      for (let i = 0; i < acts.length; i++) {
        const v = parseInt(childText(acts[i], 'wpml:actionId'), 10);
        if (!isNaN(v) && v >= nextId) nextId = v + 1;
      }
      const xmls = actionBlockXml({ ...heightless, isWl }, () => nextId++);
      for (const xml of xmls) {
        let el = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
        el.removeAttribute('xmlns:wpml'); // parent doc already declares it — avoid redundant decls
        if (doc.importNode) el = doc.importNode(el, true);
        group.appendChild(el);
        created.push({ parent: group, el });
      }
    };
    buildInto(this.mission.waylinesDoc, this.wlNode, true);
    buildInto(this.mission.templateDoc, this.tplNode, false);
    return {
      undo: () => created.forEach((c) => { if (c.el.parentNode) c.parent.removeChild(c.el); }),
      redo: () => created.forEach((c) => { if (!c.el.parentNode) c.parent.appendChild(c.el); }),
    };
  }

  // Find (or create) the reachPoint action group in a placemark node.
  _reachPointGroup(doc, node) {
    const groups = node.getElementsByTagName('wpml:actionGroup');
    for (let i = 0; i < groups.length; i++) {
      const t = groups[i].getElementsByTagName('wpml:actionTriggerType')[0];
      if (t && t.textContent.trim() === 'reachPoint') return groups[i];
    }
    // None present — create a minimal one scoped to this waypoint.
    const idx = childText(node, 'wpml:index') || '0';
    let gid = 0;
    for (let i = 0; i < groups.length; i++) {
      const v = parseInt(childText(groups[i], 'wpml:actionGroupId'), 10);
      if (!isNaN(v) && v >= gid) gid = v + 1;
    }
    const xml = '<wpml:actionGroup xmlns:wpml="http://www.dji.com/wpmz/1.0.6">'
      + `<wpml:actionGroupId>${gid}</wpml:actionGroupId>`
      + `<wpml:actionGroupStartIndex>${idx}</wpml:actionGroupStartIndex>`
      + `<wpml:actionGroupEndIndex>${idx}</wpml:actionGroupEndIndex>`
      + '<wpml:actionGroupMode>sequence</wpml:actionGroupMode>'
      + '<wpml:actionTrigger><wpml:actionTriggerType>reachPoint</wpml:actionTriggerType></wpml:actionTrigger>'
      + '</wpml:actionGroup>';
    let el = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
    el.removeAttribute('xmlns:wpml');
    if (doc.importNode) el = doc.importNode(el, true);
    node.appendChild(el);
    return el;
  }

  // Number of images this waypoint is expected to produce — the sum, over every
  // takePhoto / orientedShoot action, of how many lenses that shot uses (e.g. a
  // wide+IR shot counts as 2). Used to show expected shots before photos are loaded.
  get expectedImageCount() {
    let total = 0;
    for (const a of this._actions(this._primary)) {
      const func = childText(a, 'wpml:actionActuatorFunc');
      if (func !== 'takePhoto' && func !== 'orientedShoot') continue;
      const p = this._actionParam(a);
      const v = p && childText(p, 'wpml:payloadLensIndex');
      const lenses = v ? v.split(',').map((s) => s.trim()).filter(Boolean).length : 0;
      total += lenses || 1; // at least one image per shot even if no lens list
    }
    return total;
  }
  setPhotoActionName(name) {
    const apply = (doc, node) => {
      if (!node) return;
      // takePhoto stores the name in fileSuffix; orientedShoot in orientedFileSuffix.
      const tp = this._findAction(node, 'takePhoto');
      if (tp) { const p = this._actionParam(tp); if (p) setChildText(doc, p, 'wpml:fileSuffix', name); }
      const os = this._findAction(node, 'orientedShoot');
      if (os) { const p = this._actionParam(os); if (p) setChildText(doc, p, 'wpml:orientedFileSuffix', name); }
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  // payload lens selection on the takePhoto action, e.g. "wide,ir" / "zoom"
  get lenses() {
    const a = this._findAction(this._primary, 'takePhoto');
    if (!a) return [];
    const p = this._actionParam(a);
    const v = p && childText(p, 'wpml:payloadLensIndex');
    if (!v) return [];
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  setLenses(list) {
    const value = list.join(',');
    const apply = (doc, node) => {
      if (!node) return;
      const a = this._findAction(node, 'takePhoto');
      if (!a) return;
      const p = this._actionParam(a);
      if (p) setChildText(doc, p, 'wpml:payloadLensIndex', value);
    };
    apply(this.mission.waylinesDoc, this.wlNode);
    apply(this.mission.templateDoc, this.tplNode);
  }

  /** Plain snapshot for the UI. */
  toJSON() {
    return {
      index: this.index,
      coordinates: this.coordinates,
      height: this.height,
      aglHeight: this.aglHeight,
      speed: this.speed,
      headingMode: this.headingMode,
      headingAngle: this.headingAngle,
      gimbalPitch: this.gimbalPitch,
      zoomFocalLength: this.zoomFocalLength,
      aircraftHeading: this.aircraftHeading,
      lenses: this.lenses,
      hasPhotoAction: this.hasPhotoAction,
      photoActionName: this.photoActionName,
      actionFuncs: this.actionFuncs,
    };
  }
}

// ---------------------------------------------------------------------------
// Load / validate
// ---------------------------------------------------------------------------

async function loadMission(arrayBufferOrBuffer) {
  const zip = await JSZip.loadAsync(arrayBufferOrBuffer);
  const entries = {};
  const filePaths = [];
  await Promise.all(
    Object.keys(zip.files).map(async (path) => {
      const f = zip.files[path];
      if (f.dir) return;
      entries[path] = await f.async('uint8array');
      filePaths.push(path);
    })
  );

  const templatePath = filePaths.find((p) => /(^|\/)template\.kml$/i.test(p));
  const waylinesPath = filePaths.find((p) => /(^|\/)waylines\.wpml$/i.test(p));
  if (!templatePath && !waylinesPath) {
    throw new Error(
      'Not a DJI route KMZ: could not find wpmz/template.kml or wpmz/waylines.wpml inside the archive.'
    );
  }

  const parser = new DOMParser();
  const decode = (path) =>
    path ? new TextDecoder('utf-8').decode(entries[path]) : null;

  const templateDoc = templatePath ? parser.parseFromString(decode(templatePath), 'text/xml') : null;
  const waylinesDoc = waylinesPath ? parser.parseFromString(decode(waylinesPath), 'text/xml') : null;

  const prefix = (waylinesPath || templatePath).replace(/(template\.kml|waylines\.wpml)$/i, '');
  return new Mission(zip, entries, templateDoc, waylinesDoc, {
    template: templatePath,
    waylines: waylinesPath,
    prefix,
  });
}

function validateRouteName(name) {
  const bad = FORBIDDEN_ROUTE_CHARS.filter((ch) => name.includes(ch));
  return {
    ok: bad.length === 0 && name.trim().length > 0,
    offending: bad,
    message:
      bad.length === 0
        ? ''
        : `Route name contains characters FlightHub 2 rejects: ${bad.join(' ')} — use hyphens instead.`,
  };
}

module.exports = {
  loadMission,
  validateRouteName,
  Mission,
  Waypoint,
  WPML_NS,
  FORBIDDEN_ROUTE_CHARS,
};
