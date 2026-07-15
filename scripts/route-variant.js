'use strict';
/*
 * route-variant.js — generate an angle/zoom variation of a DJI route.
 *
 * For each waypoint:
 *   • raises the absolute flight height by <delta> m (same safe method as raise-heights.js;
 *     touches executeHeight/ellipsoidHeight only, never the AGL field)
 *   • re-tilts the gimbal so the SAME target stays framed after the height change. Two models:
 *       - "auto" (default): per-waypoint, assumes each shot targets a point at ground level,
 *         so the implied distance d = AGL/tan(|tilt|) adapts to every waypoint. Straight-down
 *         lid shots stay straight down; shallow shots get small corrections. Best for routes
 *         with mixed angles. Formula: new_down = atan( (AGL+delta)/AGL * tan(old_down) ).
 *       - a number: a single fixed horizontal target distance for ALL waypoints:
 *         new_down = atan( tan(old_down) + delta/distance ).
 *   • sets the zoom to <zoomX> (native lenses snap to 24/70/168 mm)
 *
 * Usage:
 *   node scripts/route-variant.js <input.kmz> [distance=auto] [delta_m=1] [zoomX=3]
 *   (distance is "auto" or a number in metres)
 */
const { loadMission } = require('../src/kmz');
const fs = require('fs/promises');

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Snap to native M4TD lens focal lengths where possible (CLAUDE.md camera notes).
function zoomToFocal(zoomX) {
  if (zoomX === 1) return 24;
  if (zoomX === 3) return 70;
  if (zoomX === 7) return 168;
  return Math.round(zoomX * 24);
}

async function main() {
  const input = process.argv[2];
  const distArg = (process.argv[3] ?? 'auto').toLowerCase();
  const autoMode = distArg === 'auto';
  const distance = autoMode ? null : parseFloat(distArg);
  const delta = parseFloat(process.argv[4] ?? '1');
  const zoomArg = (process.argv[5] ?? 'keep').toLowerCase();
  const keepZoom = (zoomArg === 'keep' || zoomArg === 'none' || zoomArg === '0');
  // "rule": zoom > 4× → halve (zoom out); 1× (no zoom) → 2×; in between → unchanged.
  const zoomRule = (zoomArg === 'rule');
  const zoomX = (keepZoom || zoomRule) ? null : parseFloat(zoomArg);
  if (!input || (!autoMode && isNaN(distance)) || isNaN(delta) || (!keepZoom && !zoomRule && isNaN(zoomX))) {
    console.error('Usage: node scripts/route-variant.js <input.kmz> [distance=auto] [delta_m=1] [zoomX=keep|rule|<number>]');
    process.exit(1);
  }

  const buf = await fs.readFile(input);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const mission = await loadMission(ab);
  const focal = zoomToFocal(zoomX);

  const samples = [];
  let tilted = 0, zoomed = 0;
  for (const wp of mission.waypoints) {
    // 1) raise absolute height
    wp.raiseHeight(delta);

    // 2) re-tilt to hold the same target after raising
    const p0 = wp.gimbalPitch; // negative = looking down
    let p1 = p0;
    if (p0 != null && p0 < 0) {
      const down0 = -p0;        // downward angle, positive degrees
      const agl = wp.aglHeight; // already includes +delta (raiseHeight ran above)
      let down1;
      if (autoMode) {
        // aim-at-ground: implied distance scales the tangent by (AGL)/(AGL-delta).
        const aglBefore = (agl != null ? agl - delta : null);
        down1 = (aglBefore && aglBefore > 0.01)
          ? toDeg(Math.atan((agl / aglBefore) * Math.tan(toRad(down0))))
          : down0; // degenerate (≈ground or straight down) → leave as-is
      } else {
        down1 = toDeg(Math.atan(Math.tan(toRad(down0)) + delta / distance));
      }
      p1 = parseFloat((-down1).toFixed(1));
      wp.setGimbalPitch(p1);
      tilted++;
    }

    // 3) set zoom
    let zNote = null;
    if (wp.zoomFocalLength != null) {
      if (zoomRule) {
        const z = wp.zoomFocalLength / 24; // current zoom factor
        let nz = z;
        if (z > 4) nz = z / 2;           // strong tele → zoom out (halve)
        else if (z <= 1.05) nz = 2;      // no zoom → 2×
        if (Math.abs(nz - z) > 1e-3) {
          wp.setZoomFocalLength(zoomToFocal(nz)); zoomed++;
          zNote = `${z.toFixed(1)}×→${nz.toFixed(1)}×`;
        }
      } else if (!keepZoom) {
        wp.setZoomFocalLength(focal); zoomed++;
      }
    }

    if (samples.length < 8) samples.push({ i: wp.index, p0, p1, agl: wp.aglHeight, z: zNote });
  }

  const sign = delta >= 0 ? '+' : '';
  const zoomTag = keepZoom ? 'origzoom' : zoomRule ? 'zoomrule' : `${zoomX}x`;
  const outPath = input.replace(/\.kmz$/i, `-var${sign}${delta}m-${zoomTag}.kmz`);
  const out = await mission.toBuffer('node');
  await fs.writeFile(outPath, Buffer.from(out));

  const zoomDesc = keepZoom ? 'zoom unchanged'
    : zoomRule ? `zoom rule (>4×→halve, 1×→2×): adjusted ${zoomed} WPs`
    : `${zoomX}× (${focal} mm) on ${zoomed} WPs`;
  console.log(`Variant: ${sign}${delta} m height · ${zoomDesc} · tilt model: ${autoMode ? 'auto (per-waypoint, aim-at-ground)' : 'fixed ' + distance + ' m'}`);
  console.log(`Re-tilted ${tilted} waypoints.`);
  console.log('\nSample (idx | old tilt → new tilt | new AGL | zoom):');
  for (const s of samples) {
    console.log(`  WP${s.i + 1}: ${s.p0}° → ${s.p1}°  (AGL ${s.agl != null ? s.agl.toFixed(1) : '?'} m)${s.z ? '  zoom ' + s.z : ''}`);
  }
  console.log(`\nOutput: ${outPath}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
