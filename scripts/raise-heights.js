'use strict';
const { loadMission } = require('../src/kmz');
const fs = require('fs/promises');

async function main() {
  const input = process.argv[2];
  const delta = parseFloat(process.argv[3] ?? '1.7');
  if (!input || isNaN(delta)) {
    console.error('Usage: node scripts/raise-heights.js <input.kmz> [delta_metres]');
    process.exit(1);
  }

  const buf = await fs.readFile(input);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const mission = await loadMission(ab);

  for (const wp of mission.waypoints) wp.raiseHeight(delta);

  const sign = delta >= 0 ? '+' : '';
  const outPath = input.replace(/\.kmz$/i, `-raised${sign}${delta}m.kmz`);
  const out = await mission.toBuffer('node');
  await fs.writeFile(outPath, Buffer.from(out));

  // Sanity check: read back a few heights
  const samples = mission.waypoints.slice(0, 3).map((wp) => wp.height?.toFixed(2)).join(', ');
  console.log(`✓ ${mission.waypoints.length} waypoints raised ${sign}${delta} m`);
  console.log(`  Sample heights (WP 1-3): ${samples} m`);
  console.log(`  Output: ${outPath}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
