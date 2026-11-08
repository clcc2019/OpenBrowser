'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { BrowserEngine } = require('./engine');
const { buildFingerprint, applyFingerprintToTab, createBatteryFromSeed } = require('./automation/fingerprint');
const { mapFingerprintToInitFields } = require('./automation/kernel-init-sync');

async function geo(profile) {
  const fp = buildFingerprint({ id: 'geo-test', ...profile });
  const calls = [];
  await applyFingerprintToTab(async (method, params) => { calls.push({ method, params }); return {}; }, null, fp, profile);
  const cdp = calls.find((entry) => entry.method === 'Emulation.setGeolocationOverride');
  assert.deepStrictEqual(cdp?.params || null, fp.dynamicConfig.geoposition);
  const native = mapFingerprintToInitFields(fp, profile).geoposition;
  const location = cdp?.params;
  assert.strictEqual(native, location ? `${location.latitude},${location.longitude},${location.accuracy}` : '');
  return cdp?.params || null;
}

(async () => {
  for (const profile of [
    { exitLatitude: null, exitLongitude: null },
    { exitLatitude: '', exitLongitude: '139' },
    { exitLatitude: 91, exitLongitude: 10 },
    { privacy: { geoMode: 'custom', latitude: null, longitude: null }, exitLatitude: 35, exitLongitude: 139 },
    { privacy: { geoMode: 'disabled' }, exitLatitude: 35, exitLongitude: 139 },
    { privacy: { geoMode: 'prompt' }, exitLatitude: 35, exitLongitude: 139 },
  ]) assert.strictEqual(await geo(profile), null);
  assert.deepStrictEqual(await geo({ exitLatitude: 0, exitLongitude: 0 }), { latitude: 0, longitude: 0, accuracy: 100 });
  assert.deepStrictEqual(await geo({ privacy: { geoMode: 'custom', latitude: '35', longitude: '139', accuracy: 50 } }), { latitude: 35, longitude: 139, accuracy: 50 });
  const blankCustom = BrowserEngine.prototype.sanitizeProfile({ id: 'blank-geo', name: 'blank', privacy: { geoMode: 'custom', latitude: ' ', longitude: ' ' } });
  assert.strictEqual(blankCustom.privacy.latitude, null);
  assert.strictEqual(blankCustom.privacy.longitude, null);
  assert.strictEqual(await geo(blankCustom), null);

  const ctx = { networkInfo: new Map([['geo-test', { latitude: null, longitude: null }]]) };
  const resolved = BrowserEngine.prototype.applyResolvedLocale.call(ctx, { id: 'geo-test', exitLatitude: null, exitLongitude: null, privacy: { geoMode: 'ip' } });
  assert.strictEqual(resolved.exitLatitude, null);
  assert.strictEqual(resolved.exitLongitude, null);

  const profile = BrowserEngine.prototype.sanitizeProfile({ id: 'battery-test', name: 'battery', privacy: { battery: 'noise', batterySnapshot: { charging: false, level: 0, chargingTime: null, dischargingTime: 120 } } });
  assert.deepStrictEqual(profile.privacy.batterySnapshot, { charging: false, level: 0, chargingTime: null, dischargingTime: 120 });
  const value = createBatteryFromSeed('battery-test', profile.privacy.batterySnapshot);
  assert.deepStrictEqual(value, profile.privacy.batterySnapshot);
  const fp = buildFingerprint(profile);
  assert.deepStrictEqual(fp.battery.value, profile.privacy.batterySnapshot);
  const battery = mapFingerprintToInitFields(fp, profile).battery;
  assert.strictEqual(battery.level, 0);
  assert.strictEqual(battery.chargingTime, -1);
  assert.strictEqual(battery.dischargingTime, 120);
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const normalizeSource = renderer.slice(renderer.indexOf('function positiveProfileNumber('), renderer.indexOf('function normalizeOptionalWebUrl('));
  const normalize = vm.runInNewContext(`${normalizeSource}\nnormalizeProfileSettings`, { UNGROUPED_ID: 'ungrouped' });
  const fromUi = normalize(profile);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fromUi.privacy.batterySnapshot)), profile.privacy.batterySnapshot);
  const roundTrip = BrowserEngine.prototype.sanitizeProfile(fromUi);
  assert.deepStrictEqual(roundTrip.privacy.batterySnapshot, profile.privacy.batterySnapshot);
  assert.deepStrictEqual(buildFingerprint(roundTrip).battery.value, fp.battery.value);
  for (const privacy of [{}, { deviceProfile: 'persona', personaVersion: 5 }]) {
    const profile = { id: 'shared-gpu-regression', os: 'Windows', privacy };
    const original = buildFingerprint(profile);
    const changed = buildFingerprint({ ...profile, privacy: { ...privacy, webglMeta: 'custom', fingerprint: { webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, Apple M1)' } } });
    assert.strictEqual(changed.webgl.gpu.vendor, 'apple');
    assert.strictEqual(changed.webgl.gpu.architecture, '');
    assert.deepStrictEqual(buildFingerprint(profile).webgl.gpu, original.webgl.gpu, 'custom GPU must not mutate a shared preset');
  }
  const smallMemory = buildFingerprint({ id: 'small-memory', privacy: { fingerprint: { memory: 0.5 } } });
  assert.strictEqual(smallMemory.deviceMemory, 0.5);
  assert(!smallMemory.consistency.issues.some((issue) => issue.code === 'memory-invalid'));
  const marks = (fp) => [fp.canvas.mark, fp.webgl.mark, fp.audio.mark, fp.clientRects.mark];
  const auto = buildFingerprint({ id: 'mark-test' });
  const unset = buildFingerprint({ id: 'mark-test', privacy: { fingerprint: { canvasId: null, webglId: '', audioId: null, clientRectsId: ' ' } } });
  assert.deepStrictEqual(marks(unset), marks(auto));
  const zero = buildFingerprint({ id: 'mark-test', privacy: { fingerprint: { canvasId: 0, webglId: 0, audioId: 0, clientRectsId: 0 } } });
  assert.deepStrictEqual(marks(zero), [0, 0, 0, 0]);
  for (const metaMode of ['real', 'blocked']) {
    const fp = buildFingerprint({ id: 'webgl-hidden', os: 'macOS', privacy: { webglMeta: metaMode } });
    assert(!fp.consistency.issues.some(issue => issue.code === 'webgl-ua-mismatch'), `${metaMode} metadata is not a fabricated renderer`);
  }
  const mismatch = buildFingerprint({ id: 'webgl-mismatch', os: 'macOS', privacy: { webglMeta: 'custom', fingerprint: { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, GeForce RTX Direct3D11)' } } });
  assert(mismatch.consistency.issues.some(issue => issue.code === 'webgl-ua-mismatch'));
  const legacyMac = buildFingerprint({ id: 'legacy-mac-surfaces', os: 'macOS', privacy: { speech: 'noise', mediaDevices: 'noise' } });
  const issueCodes = legacyMac.consistency.issues.map(issue => issue.code);
  assert(issueCodes.includes('media-label-os-mismatch'));
  assert(issueCodes.includes('speech-voice-os-mismatch'));
  assert(issueCodes.includes('synthetic-media-device-id'));
  const alignedMac = buildFingerprint({ id: 'legacy-mac-surfaces', os: 'macOS', privacy: { speech: 'noise', mediaDevices: 'noise', fingerprint: { osAwareSurfaces: true } } });
  assert(!alignedMac.mediaDevices.devices.some(device => /realtek|conexant|synaptics/i.test(device.label)));
  assert(!alignedMac.speech.voices.some(voice => /^Microsoft\s/i.test(voice.name)));
  assert.deepStrictEqual(alignedMac.mediaDevices.devices.map(device => [device.deviceId, device.groupId]), legacyMac.mediaDevices.devices.map(device => [device.deviceId, device.groupId]));
  for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'screen', 'webgl', 'canvas', 'audio', 'clientRects']) assert.deepStrictEqual(alignedMac[key], legacyMac[key], `${key} should remain stable when aligning OS-specific surfaces`);
  const explicitLabel = buildFingerprint({ id: 'legacy-mac-surfaces', os: 'macOS', privacy: { fingerprint: { osAwareSurfaces: true, mediaLabels: { audioinput: 'Custom microphone' } } } });
  assert.strictEqual(explicitLabel.mediaDevices.devices[0].label, 'Custom microphone');
  console.log('location and battery fingerprint checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
