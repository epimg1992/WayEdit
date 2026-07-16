/* Run with: node test/kmz.test.js
 * Validates the critical path: parse -> edit -> re-zip -> re-parse with no data loss.
 */
const assert = require('assert');
const JSZip = require('jszip');
const { loadMission, validateRouteName } = require('../src/kmz');

function placemark(index, lng, lat, height, focal, lenses, heightTag) {
  return `
      <Placemark>
        <Point><coordinates>${lng},${lat}</coordinates></Point>
        <wpml:index>${index}</wpml:index>
        <wpml:${heightTag}>${height}</wpml:${heightTag}>
        <wpml:waypointSpeed>5</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.0,0.0,0.0</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>0</wpml:waypointHeadingAngleEnable>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithContinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:actionGroup>
          <wpml:actionGroupId>${index}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${index}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>parallel</wpml:actionGroupMode>
          <wpml:actionTrigger><wpml:actionTriggerType>reachPoint</wpml:actionTriggerType></wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>0</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalPitchRotateAngle>-90</wpml:gimbalPitchRotateAngle>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>1</wpml:actionId>
            <wpml:actionActuatorFunc>zoom</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:focalLength>${focal}</wpml:focalLength>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>2</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:payloadLensIndex>${lenses}</wpml:payloadLensIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>
      </Placemark>`;
}

function doc(heightTag) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <wpml:author>fly</wpml:author>
    <wpml:createTime>1700000000000</wpml:createTime>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>15</wpml:globalTransitionalSpeed>
      <wpml:droneInfo><wpml:droneEnumValue>99</wpml:droneEnumValue></wpml:droneInfo>
      <wpml:payloadInfo><wpml:payloadEnumValue>89</wpml:payloadEnumValue><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:payloadInfo>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>5</wpml:autoFlightSpeed>
      <wpml:globalHeight>100</wpml:globalHeight>
      ${placemark(0, -102.07, 31.99, 100, 120, 'wide,ir', heightTag)}
      ${placemark(1, -102.08, 31.98, 100, 120, 'wide,ir', heightTag)}
    </Folder>
  </Document>
</kml>`;
}

async function buildSampleKmz() {
  const zip = new JSZip();
  const w = zip.folder('wpmz');
  w.file('template.kml', doc('height'));
  w.file('waylines.wpml', doc('executeHeight'));
  // a resource file that must survive untouched
  w.file('res/placeholder.txt', 'keep me');
  return zip.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  let pass = 0;
  const buf = await buildSampleKmz();

  // 1. Load
  let m = await loadMission(buf);
  assert.strictEqual(m.waypoints.length, 2, 'should parse 2 waypoints');
  pass++;

  // 2. Read params
  const wp = m.waypoints[0];
  assert.strictEqual(wp.height, 100);
  assert.strictEqual(wp.zoomFocalLength, 120);
  assert.strictEqual(wp.gimbalPitch, -90);
  assert.deepStrictEqual(wp.lenses, ['wide', 'ir']);
  assert.ok(Math.abs(wp.coordinates.lng + 102.07) < 1e-6);
  pass++;

  // 3. Edit everything the operator cares about
  wp.setHeight(135);
  wp.setSpeed(3);
  wp.setHeading('fixed', 270);
  wp.setGimbalPitch(-45);
  wp.setZoomFocalLength(168);
  wp.setLenses(['zoom']); // switch to zoom-only
  pass++;

  // 4. Re-zip and re-load
  const out = await m.toBuffer('node');
  const m2 = await loadMission(out);
  const wp2 = m2.waypoints[0];
  assert.strictEqual(wp2.height, 135, 'height persisted');
  assert.strictEqual(wp2.speed, 3, 'speed persisted');
  assert.strictEqual(wp2.headingMode, 'fixed', 'heading mode persisted');
  assert.strictEqual(wp2.headingAngle, 270, 'heading angle persisted');
  assert.strictEqual(wp2.gimbalPitch, -45, 'gimbal pitch persisted');
  assert.strictEqual(wp2.zoomFocalLength, 168, 'focal length persisted');
  assert.deepStrictEqual(wp2.lenses, ['zoom'], 'lens selection persisted');
  pass++;

  // 5. Both files edited in sync — re-open the raw zip and confirm BOTH docs changed
  const rawZip = await JSZip.loadAsync(out);
  const tplTxt = await rawZip.file('wpmz/template.kml').async('string');
  const wlTxt = await rawZip.file('wpmz/waylines.wpml').async('string');
  assert.ok(tplTxt.includes('<wpml:height>135</wpml:height>'), 'template height synced');
  assert.ok(wlTxt.includes('<wpml:executeHeight>135</wpml:executeHeight>'), 'waylines executeHeight synced');
  assert.ok(tplTxt.includes('168') && wlTxt.includes('168'), 'focal length synced to both');
  pass++;

  // 6. Lossless: untouched config + resource files survive
  assert.ok(tplTxt.includes('<wpml:finishAction>goHome</wpml:finishAction>'), 'missionConfig preserved');
  assert.ok(tplTxt.includes('waypointTurnDampingDist'), 'turn params preserved');
  assert.ok(tplTxt.includes('droneEnumValue'), 'drone info preserved');
  const res = await rawZip.file('wpmz/res/placeholder.txt').async('string');
  assert.strictEqual(res, 'keep me', 'resource files preserved untouched');
  // waypoint 1 was never edited and must be identical (still 100m, wide,ir)
  assert.strictEqual(m2.waypoints[1].height, 100, 'unedited waypoint untouched');
  assert.deepStrictEqual(m2.waypoints[1].lenses, ['wide', 'ir'], 'unedited lens untouched');
  pass++;

  // 7. Route-name validation matches FlightHub 2 rules
  assert.strictEqual(validateRouteName('Rio-Lavaca-from-wp183').ok, true);
  assert.strictEqual(validateRouteName('Rio_Lavaca.v1').ok, false);
  assert.deepStrictEqual(validateRouteName('a/b:c').offending, [':', '/']);
  pass++;

  console.log(`\n  All ${pass} engine checks passed ✓`);
})().catch((e) => {
  console.error('\n  TEST FAILED:', e.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Round 2: per-shot lens control, route-wide lens default, per-shot naming,
// and waypoint insertion — built against a fixture shaped like a real
// FlightHub-exported KMZ (orientedShoot shots, ellipsoidHeight/AGL, payloadParam).
// ---------------------------------------------------------------------------

function osShotXml(startId, { pitch, heading, focal, followRoute, lens, name, uuid, file, isWl }) {
  const lensLine = (followRoute && !isWl) ? '' : `<wpml:payloadLensIndex>${lens}</wpml:payloadLensIndex>`;
  const suffixLine = name ? `<wpml:orientedFileSuffix>${name}</wpml:orientedFileSuffix>` : '';
  return `
          <wpml:action>
            <wpml:actionId>${startId}</wpml:actionId>
            <wpml:actionActuatorFunc>rotateYaw</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam><wpml:aircraftHeading>${heading}</wpml:aircraftHeading></wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>${startId + 1}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam><wpml:gimbalPitchRotateAngle>${pitch}</wpml:gimbalPitchRotateAngle></wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>${startId + 2}</wpml:actionId>
            <wpml:actionActuatorFunc>zoom</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam><wpml:focalLength>${focal}</wpml:focalLength></wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>${startId + 3}</wpml:actionId>
            <wpml:actionActuatorFunc>orientedShoot</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalPitchRotateAngle>${pitch}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalYawRotateAngle>${heading}</wpml:gimbalYawRotateAngle>
              <wpml:focalLength>${focal}</wpml:focalLength>
              <wpml:aircraftHeading>${heading}</wpml:aircraftHeading>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:useGlobalPayloadLensIndex>${followRoute ? 1 : 0}</wpml:useGlobalPayloadLensIndex>
              ${lensLine}
              ${suffixLine}
              <wpml:actionUUID>${uuid}</wpml:actionUUID>
              <wpml:orientedFilePath>${file}</wpml:orientedFilePath>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function osPlacemark({ index, lng, lat, absHeight, aglHeight, isWl, shots }) {
  const heightXml = isWl
    ? `<wpml:executeHeight>${absHeight}</wpml:executeHeight>`
    : `<wpml:ellipsoidHeight>${absHeight}</wpml:ellipsoidHeight><wpml:height>${aglHeight}</wpml:height>`;
  let id = 0;
  const shotsXml = shots.map((s) => { const xml = osShotXml(id, { ...s, isWl }); id += 4; return xml; }).join('');
  return `
      <Placemark>
        <Point><coordinates>${lng},${lat}</coordinates></Point>
        <wpml:index>${index}</wpml:index>
        ${heightXml}
        <wpml:waypointSpeed>8</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:actionGroup>
          <wpml:actionGroupId>${index}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${index}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger><wpml:actionTriggerType>reachPoint</wpml:actionTriggerType></wpml:actionTrigger>
          ${shotsXml}
        </wpml:actionGroup>
      </Placemark>`;
}

// wp0: 2 shots — shot0 explicit Visible-only override, shot1 follows the route default.
const WP0_SHOTS = [
  { pitch: -90, heading: 10, focal: 24, followRoute: false, lens: 'visable', name: 'Override-Visible', uuid: 'u0', file: 'f0' },
  { pitch: -90, heading: 10, focal: 24, followRoute: true, lens: 'visable,ir', name: '', uuid: 'u1', file: 'f1' },
];
// wp1 / wp2: single shot each, both following the route default.
const WP1_SHOTS = [{ pitch: -45, heading: 90, focal: 24, followRoute: true, lens: 'visable,ir', name: 'Existing', uuid: 'u2', file: 'f2' }];
const WP2_SHOTS = [{ pitch: -45, heading: 180, focal: 24, followRoute: true, lens: 'visable,ir', name: 'Tail', uuid: 'u3', file: 'f3' }];

function osDoc(isWl) {
  const heightMode = isWl ? '' : '<wpml:waylineCoordinateSysParam><wpml:coordinateMode>WGS84</wpml:coordinateMode><wpml:heightMode>aboveGroundLevel</wpml:heightMode></wpml:waylineCoordinateSysParam>';
  const payloadParam = isWl ? '' : '<wpml:payloadParam><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex><wpml:imageFormat>visable,ir</wpml:imageFormat></wpml:payloadParam>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <wpml:missionConfig>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:takeOffRefPoint>31.982600,-102.106947,840.000000</wpml:takeOffRefPoint>
      <wpml:globalTransitionalSpeed>15</wpml:globalTransitionalSpeed>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:autoFlightSpeed>8</wpml:autoFlightSpeed>
      ${heightMode}
      ${osPlacemark({ index: 0, lng: -102.10, lat: 31.98, absHeight: 850, aglHeight: 10, isWl, shots: WP0_SHOTS })}
      ${osPlacemark({ index: 1, lng: -102.11, lat: 31.97, absHeight: 850, aglHeight: 10, isWl, shots: WP1_SHOTS })}
      ${osPlacemark({ index: 2, lng: -102.12, lat: 31.96, absHeight: 850, aglHeight: 10, isWl, shots: WP2_SHOTS })}
      ${payloadParam}
    </Folder>
  </Document>
</kml>`;
}

async function buildOsSampleKmz() {
  const zip = new JSZip();
  const w = zip.folder('wpmz');
  w.file('template.kml', osDoc(false));
  w.file('waylines.wpml', osDoc(true));
  return zip.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  let pass = 0;
  const buf = await buildOsSampleKmz();
  let m = await loadMission(buf);
  assert.strictEqual(m.waypoints.length, 3, 'round 2 fixture: 3 waypoints');
  pass++;

  // 8. Route-wide default lens set reads the Folder's payloadParam > imageFormat.
  assert.deepStrictEqual(m.globalLenses, ['wide', 'ir'], 'globalLenses reads imageFormat');
  pass++;

  // 9. Per-shot followRoute/lenses read correctly, including the template-omits-payloadLensIndex
  // quirk (shot 1 on wp0 follows the route but still resolves to wide+ir via waylines' snapshot).
  const wp0 = m.waypoints[0];
  const shots0 = wp0.photoShots;
  assert.strictEqual(shots0.length, 2, 'wp0 has 2 shots');
  assert.strictEqual(shots0[0].followRoute, false, 'shot0 is an explicit override');
  assert.deepStrictEqual(shots0[0].lenses, ['wide'], 'shot0 lenses = visible only');
  assert.strictEqual(shots0[1].followRoute, true, 'shot1 follows the route');
  assert.deepStrictEqual(shots0[1].lenses, ['wide', 'ir'], 'shot1 resolves to the route default');
  pass++;

  // 10. setShotLenses: switch shot1 to an explicit IR-only override, and shot0 to follow the route.
  wp0.setShotLenses(1, { followRoute: false, lenses: ['ir'] });
  wp0.setShotLenses(0, { followRoute: true, lenses: [] });
  const outA = await m.toBuffer('node');
  const rawA = await JSZip.loadAsync(outA);
  const tplA = await rawA.file('wpmz/template.kml').async('string');
  const wlA = await rawA.file('wpmz/waylines.wpml').async('string');
  const mA = await loadMission(outA);
  const shotsA = mA.waypoints[0].photoShots;
  assert.strictEqual(shotsA[1].followRoute, false, 'shot1 override persisted');
  assert.deepStrictEqual(shotsA[1].lenses, ['ir'], 'shot1 lenses persisted as IR-only');
  assert.strictEqual(shotsA[0].followRoute, true, 'shot0 now follows the route');
  assert.deepStrictEqual(shotsA[0].lenses, ['wide', 'ir'], 'shot0 resolves to the (unchanged) route default');
  // template omits payloadLensIndex for every follow-route orientedShoot (shot0 here, plus wp1/
  // wp2's untouched shots) — only shot1's explicit override remains. Waylines keeps a snapshot
  // for all 4 shots regardless of follow/override.
  const tplLensCount = (tplA.match(/<wpml:payloadLensIndex>/g) || []).length;
  const wlLensCount = (wlA.match(/<wpml:payloadLensIndex>/g) || []).length;
  assert.strictEqual(tplLensCount, 1, 'template omits payloadLensIndex on every follow-route shot');
  assert.strictEqual(wlLensCount, 4, 'waylines snapshots payloadLensIndex on every shot');
  assert.ok(wlA.includes('<wpml:payloadLensIndex>visable,ir</wpml:payloadLensIndex>'), 'waylines snapshot present for the newly-followed shot');
  pass++;

  // 11. Mission.globalLenses setter updates imageFormat AND re-snapshots every following shot.
  mA.globalLenses = ['wide'];
  const outB = await mA.toBuffer('node');
  const mB = await loadMission(outB);
  assert.deepStrictEqual(mB.globalLenses, ['wide'], 'globalLenses setter persisted');
  assert.deepStrictEqual(mB.waypoints[0].photoShots[0].lenses, ['wide'], 'following shot re-snapshotted to the new default');
  pass++;

  // 12. setShotPhotoActionName only touches the targeted shot index.
  mB.waypoints[0].setShotPhotoActionName(1, 'Renamed-Shot');
  const outC = await mB.toBuffer('node');
  const mC = await loadMission(outC);
  assert.strictEqual(mC.waypoints[0].photoShots[1].name, 'Renamed-Shot', 'targeted shot renamed');
  assert.strictEqual(mC.waypoints[0].photoShots[0].name, 'Override-Visible', 'other shot on the same WP untouched');
  assert.strictEqual(mC.waypoints[1].photoShots[0].name, 'Existing', 'other waypoint untouched');
  pass++;

  // 13. insertWaypointAfter: splice a new waypoint after index 1, renumbering index 2 onward.
  const mD = await loadMission(await buildOsSampleKmz());
  const rec = mD.insertWaypointAfter(1, { coordinates: { lng: -102.115, lat: 31.965 }, absHeight: 860 },
    { kind: 'takePhotoFixed', heading: 45, pitch: -60, focal: 24, lens: 'visable,ir', useGlobalLens: 0, name: 'Inserted' });
  assert.strictEqual(mD.waypoints.length, 4, 'waypoint count +1 after insert');
  assert.strictEqual(rec.waypoint.index, 2, 'new waypoint takes index 2');
  assert.strictEqual(rec.waypoint.photoShots[0].name, 'Inserted', 'new waypoint carries the requested shot name');
  const tail = mD.waypoints.find((w) => w.photoShots[0] && w.photoShots[0].name === 'Tail');
  assert.strictEqual(tail.index, 3, 'the waypoint after the insert point was renumbered');
  assert.strictEqual(mD.waypoints[0].photoShots[0].name, 'Override-Visible', 'waypoint before the insert point untouched');

  // Round-trip through re-zip/re-load.
  const outD = await mD.toBuffer('node');
  const mE = await loadMission(outD);
  assert.strictEqual(mE.waypoints.length, 4, 'insert survives re-zip/re-load');
  assert.ok(mE.waypoints.some((w) => w.photoShots[0] && w.photoShots[0].name === 'Inserted'), 'inserted waypoint survives round trip');

  // Undo removes the new waypoint and restores original numbering; redo re-applies it.
  rec.undo();
  assert.strictEqual(mD.waypoints.length, 3, 'undo removes the inserted waypoint');
  const tailAfterUndo = mD.waypoints.find((w) => w.photoShots[0] && w.photoShots[0].name === 'Tail');
  assert.strictEqual(tailAfterUndo.index, 2, 'undo restores original numbering');
  rec.redo();
  assert.strictEqual(mD.waypoints.length, 4, 'redo re-adds the inserted waypoint');
  pass++;

  console.log(`  All ${pass} round-2 engine checks passed ✓`);
})().catch((e) => {
  console.error('\n  TEST FAILED (round 2):', e.message);
  process.exit(1);
});
