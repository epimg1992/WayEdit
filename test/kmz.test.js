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
