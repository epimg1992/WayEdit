'use strict';
// ---------------------------------------------------------------------------
// WingtraRay / PX4 ULog reader — self-contained, no dependencies.
//
// WingtraRay logs are PX4 ULog files (magic "ULog", version 2). Two quirks vs
// the stock PX4 format, both verified empirically across this operator's logs
// (2025–2026, multiple firmware dates):
//   1. Every message is followed by 2 trailing bytes, so the stride from one
//      message header to the next is  3 (header) + msg_size + 2.  A stock parser
//      (and pyulog) desyncs immediately without this; with it, the whole file
//      parses cleanly to EOF (345k msgs, zero desync on the 25 MB sample).
//   2. The trailing `uint8_t[N] _padding0` field of a message is NOT written to
//      the logged data, so a data record is shorter than the declared format —
//      we stop decoding a record when the body runs out.
//
// We pull the flown track from `vehicle_global_position` (lat/lon/alt-MSL),
// yaw from `vehicle_local_position.heading`, and photo marks from
// `camera_trigger_wingtra`. Output matches the DJI/Aloft CSV shape consumed by
// the renderer: { points:[{t,lat,lon,alt,agl,yaw,gp,spd,onGround,photo}], meta }.
// ---------------------------------------------------------------------------

const PRIM = {
  int8_t: 1, uint8_t: 1, int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4,
  int64_t: 8, uint64_t: 8, float: 4, double: 8, bool: 1, char: 1,
};

const WANT = ['vehicle_global_position', 'vehicle_local_position', 'camera_trigger_wingtra'];

function isUlog(buf) {
  return buf && buf.length >= 4 &&
    buf[0] === 0x55 && buf[1] === 0x4c && buf[2] === 0x6f && buf[3] === 0x67; // "ULog"
}

// Parse one format-definition string: "name:type field;type field;...".
function parseFormat(s) {
  const ci = s.indexOf(':');
  if (ci < 0) return null;
  const name = s.slice(0, ci);
  const fields = [];
  for (const fld of s.slice(ci + 1).split(';')) {
    if (!fld) continue;
    const sp = fld.lastIndexOf(' ');
    if (sp < 0) continue;
    let type = fld.slice(0, sp);
    const fname = fld.slice(sp + 1);
    let arr = 1;
    const m = /^(.*?)\[(\d+)\]$/.exec(type);
    if (m) { type = m[1]; arr = parseInt(m[2], 10); }
    fields.push({ type, name: fname, arr });
  }
  return { name, fields };
}

// Read a single primitive field from the buffer at absolute offset `p`.
function readPrim(buf, type, p) {
  switch (type) {
    case 'int8_t': return buf.readInt8(p);
    case 'uint8_t': case 'bool': case 'char': return buf.readUInt8(p);
    case 'int16_t': return buf.readInt16LE(p);
    case 'uint16_t': return buf.readUInt16LE(p);
    case 'int32_t': return buf.readInt32LE(p);
    case 'uint32_t': return buf.readUInt32LE(p);
    case 'int64_t': return Number(buf.readBigInt64LE(p));
    case 'uint64_t': return Number(buf.readBigUInt64LE(p));
    case 'float': return buf.readFloatLE(p);
    case 'double': return buf.readDoubleLE(p);
    default: return null;
  }
}

// Parse the whole ULog buffer, returning { points, meta } for the flight track.
function parseUlog(buf, fileName) {
  if (!isUlog(buf)) throw new Error('Not a ULog file (bad magic).');
  const N = buf.length;
  const formats = {};                // name -> {name, fields}
  const wantedId = {};               // message name -> first msg_id (multi 0)
  const idToName = {};               // msg_id -> message name (only wanted)
  const gp = [];                     // global position records
  const lp = [];                     // local position (heading) records
  const ct = [];                     // camera-trigger timestamps (us)

  // Recursive struct size (for skipping nested-type fields we don't decode).
  function fsize(fields) {
    let tot = 0;
    for (const f of fields) {
      if (PRIM[f.type] != null) tot += PRIM[f.type] * f.arr;
      else if (formats[f.type]) {
        const s = fsize(formats[f.type].fields);
        if (s == null) return null;
        tot += s * f.arr;
      } else return null;
    }
    return tot;
  }

  // Decode only the primitive fields we need into a flat record, stopping when
  // the body runs out (trailing padding is not logged).
  function decode(fields, body) {
    const rec = {};
    let p = 2; // skip msg_id (uint16)
    for (const f of fields) {
      if (PRIM[f.type] != null) {
        const need = PRIM[f.type] * f.arr;
        if (p + need > body.length) break;
        if (f.arr > 1) { p += need; }            // arrays: not needed by targets
        else { rec[f.name] = readPrim(body, f.type, p); p += need; }
      } else {
        const s = fsize(formats[f.type] ? formats[f.type].fields : []) || 0;
        p += s * f.arr;
        if (p > body.length) break;
      }
    }
    return rec;
  }

  let off = 16; // skip the 16-byte file header
  while (off + 3 <= N) {
    const size = buf.readUInt16LE(off);
    const type = buf[off + 2];
    const bodyStart = off + 3;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > N) break;
    const body = buf.subarray(bodyStart, bodyEnd);

    if (type === 0x46) {             // 'F' format definition
      const def = parseFormat(body.toString('latin1'));
      if (def) formats[def.name] = def;
    } else if (type === 0x41) {      // 'A' add-logged-message (subscription)
      if (body.length >= 3) {
        const msgId = body.readUInt16LE(1);
        const name = body.toString('latin1', 3);
        if (WANT.includes(name) && wantedId[name] == null) {
          wantedId[name] = msgId;
          idToName[msgId] = name;
        }
      }
    } else if (type === 0x44) {      // 'D' logged data
      if (body.length >= 2) {
        const msgId = body.readUInt16LE(0);
        const name = idToName[msgId];
        if (name) {
          const fmt = formats[name];
          if (fmt) {
            const rec = decode(fmt.fields, body);
            if (name === 'vehicle_global_position' && rec.lat != null && rec.lon != null) {
              gp.push({ ts: rec.timestamp, lat: rec.lat, lon: rec.lon, alt: rec.alt });
            } else if (name === 'vehicle_local_position' && rec.heading != null) {
              lp.push({ ts: rec.timestamp, heading: rec.heading });
            } else if (name === 'camera_trigger_wingtra' && rec.timestamp != null) {
              ct.push(rec.timestamp);
            }
          }
        }
      }
    }
    off = bodyEnd + 2;               // +2 for the Wingtra trailing bytes
  }

  if (gp.length < 2) return { error: 'ULog has no usable GPS track (vehicle_global_position).' };
  gp.sort((a, b) => a.ts - b.ts);
  lp.sort((a, b) => a.ts - b.ts);
  ct.sort((a, b) => a - b);

  const t0 = gp[0].ts;
  const groundAlt = gp[0].alt;       // takeoff AMSL — AGL is measured from here

  // Merge nearest heading (rad -> deg, 0..360) onto each track point.
  const R2D = 180 / Math.PI;
  let li = 0;
  const D = 6378137; // not used; placeholder to keep intent clear
  void D;
  const mPerDegLat = 111320;
  const cosLat = Math.cos((gp[0].lat * Math.PI) / 180);

  const points = [];
  let dist = 0;
  for (let i = 0; i < gp.length; i++) {
    const g = gp[i];
    // nearest heading by timestamp
    let yaw = null;
    if (lp.length) {
      while (li < lp.length - 1 && lp[li + 1].ts <= g.ts) li++;
      let best = lp[li];
      if (li + 1 < lp.length && Math.abs(lp[li + 1].ts - g.ts) < Math.abs(best.ts - g.ts)) best = lp[li + 1];
      yaw = ((best.heading * R2D) % 360 + 360) % 360;
    }
    // horizontal speed from position delta
    let spd = null;
    if (i > 0) {
      const dt = (g.ts - gp[i - 1].ts) / 1e6;
      const dx = (g.lon - gp[i - 1].lon) * mPerDegLat * cosLat;
      const dy = (g.lat - gp[i - 1].lat) * mPerDegLat;
      const d = Math.sqrt(dx * dx + dy * dy);
      dist += d;
      spd = dt > 0 ? d / dt : null;
    }
    points.push({
      t: (g.ts - t0) / 1e6,
      lat: g.lat, lon: g.lon,
      alt: g.alt,                        // MSL metres
      agl: g.alt != null && groundAlt != null ? g.alt - groundAlt : null,
      yaw,
      gp: null,                          // fixed nadir payload; no gimbal-pitch stream
      spd,
      onGround: null,                    // renderer filters airborne by agl
      photo: false,
    });
  }

  // Mark the nearest track point to each camera trigger as a photo capture.
  let pi = 0;
  for (const cts of ct) {
    while (pi < gp.length - 1 && gp[pi + 1].ts <= cts) pi++;
    let idx = pi;
    if (pi + 1 < gp.length && Math.abs(gp[pi + 1].ts - cts) < Math.abs(gp[pi].ts - cts)) idx = pi + 1;
    if (points[idx]) points[idx].photo = true;
  }

  let maxAgl = 0;
  for (const p of points) if (p.agl != null && p.agl > maxAgl) maxAgl = p.agl;

  const meta = {
    aircraft: 'WingtraRay',
    date: '',
    totalTime: points.length ? points[points.length - 1].t : null,
    distance: dist,
    maxHeight: maxAgl,
    photoNum: ct.length,
    name: fileName || 'ULog',
  };
  return { points, meta };
}

module.exports = { parseUlog, isUlog };
