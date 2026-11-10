'use strict';

const assert = require('assert');
const { PERSONAS_BY_OS, PERSONAS_V2_BY_OS, PERSONAS_V3_BY_OS, PERSONAS_V4_BY_OS, PERSONAS_V5_BY_OS, pickPersona, isCoherent } = require('./automation/device-personas');
const { buildFingerprint } = require('./automation/fingerprint');
const { BrowserEngine } = require('./engine');

for (const os of Object.keys(PERSONAS_BY_OS)) {
  const old = PERSONAS_BY_OS[os];
  const expanded = PERSONAS_V2_BY_OS[os];
  if (os === 'windows') assert.deepStrictEqual(expanded, old, 'Windows personas only remain for compatibility');
  else assert(expanded.length > old.length, `${os} must have new personas`);
  assert.deepStrictEqual(expanded.slice(0, old.length), old);
  assert(expanded.every(isCoherent), `${os} contains an invalid persona`);
  for (let i = 0; i < 200; i++) {
    assert.strictEqual(pickPersona(os, i), old[i % old.length]);
    assert.strictEqual(pickPersona(os, i, 2), expanded[i % expanded.length]);
  }
}
for (const os of ['macos', 'macos_arm']) {
  const v2 = PERSONAS_V2_BY_OS[os];
  const v3 = PERSONAS_V3_BY_OS[os];
  const v4 = PERSONAS_V4_BY_OS[os];
  assert(v3.length >= 60, `${os} needs a broad display selection`);
  assert(v3.every(isCoherent));
  assert.strictEqual(new Set(v3.map(JSON.stringify)).size, v3.length, `${os} contains duplicates`);
  assert(v4.length > v3.length && v4.every(isCoherent), `${os} v4 must expand coherent configurations`);
  assert.strictEqual(new Set(v4.map(JSON.stringify)).size, v4.length);
  for (let i = 0; i < 500; i++) {
    assert.strictEqual(pickPersona(os, i, 2), v2[i % v2.length], 'v2 mapping must remain stable');
    assert.strictEqual(pickPersona(os, i, 3), v3[i % v3.length]);
    assert.strictEqual(pickPersona(os, i, 4), v4[i % v4.length]);
  }
}

const profile = { id: 'pool-version-test', name: 'test', os: 'Windows', privacy: { deviceProfile: 'persona' } };
const before = buildFingerprint(profile);
const legacy = buildFingerprint({ ...profile, privacy: { ...profile.privacy, personaVersion: 1 } });
assert.deepStrictEqual(before, legacy, 'missing version must retain the legacy fingerprint');
const sanitized = BrowserEngine.prototype.sanitizeProfile(profile);
assert.strictEqual(sanitized.privacy.personaVersion, 1);
const updated = BrowserEngine.prototype.sanitizeProfile({ ...profile, privacy: { ...profile.privacy, personaVersion: 2 } });
assert.strictEqual(updated.privacy.personaVersion, 2);
assert.strictEqual(BrowserEngine.prototype.sanitizeProfile({ ...profile, privacy: { personaVersion: 3 } }).privacy.personaVersion, 3);
assert.strictEqual(BrowserEngine.prototype.sanitizeProfile({ ...profile, privacy: { personaVersion: 4 } }).privacy.personaVersion, 4);
assert.strictEqual(BrowserEngine.prototype.sanitizeProfile({ ...profile, privacy: { personaVersion: 5 } }).privacy.personaVersion, 5);
assert.deepStrictEqual(buildFingerprint(updated), buildFingerprint(updated), 'v2 must remain deterministic');
const selected = new Set();
for (let i = 0; i < 500; i++) {
  const fp = buildFingerprint({ ...profile, id: `pool-version-${i}`, os: 'macOS', privacy: { deviceProfile: 'persona', personaVersion: 2 } });
  assert.strictEqual(fp.uaProfile.metadata.platform, 'macOS');
  assert(!fp.mediaDevices.devices.some((device) => /realtek|conexant|synaptics/i.test(device.label)), 'macOS media devices must not use Windows labels');
  const apple = fp.webgl.gpu.vendor === 'apple';
  assert.strictEqual(fp.uaProfile.metadata.architecture, apple ? 'arm' : 'x86');
  selected.add(fp.webgl.renderer);
}
for (const os of ['macos', 'macos_arm']) {
  for (const persona of PERSONAS_V2_BY_OS[os].slice(PERSONAS_BY_OS[os].length)) {
    assert(selected.has(persona.webgl.renderer), `new persona was not selected: ${persona.webgl.renderer}`);
  }
}
const v3Displays = new Set();
for (let i = 0; i < 1000; i++) {
  const fp = buildFingerprint({ ...profile, id: `mac-v3-${i}`, os: 'macOS', privacy: { deviceProfile: 'persona', personaVersion: 3 } });
  assert.strictEqual(fp.uaProfile.metadata.platform, 'macOS');
  assert.strictEqual(fp.uaProfile.metadata.architecture, fp.webgl.gpu.vendor === 'apple' ? 'arm' : 'x86');
  assert(!fp.mediaDevices.devices.some((device) => /realtek|conexant|synaptics/i.test(device.label)));
  v3Displays.add(`${fp.screen.width}x${fp.screen.height}`);
}
assert.deepStrictEqual([...v3Displays], ['1920x1080'], 'screen resolution is unified at 1920x1080');
const v4Renderers = new Set();
for (let i = 0; i < 3000; i++) {
  const fp = buildFingerprint({ ...profile, id: `mac-v4-${i}`, os: 'macOS', privacy: { deviceProfile: 'persona', personaVersion: 4 } });
  assert.strictEqual(fp.uaProfile.metadata.architecture, fp.webgl.gpu.vendor === 'apple' ? 'arm' : 'x86');
  assert(!fp.mediaDevices.devices.some((device) => /realtek|conexant|synaptics/i.test(device.label)));
  assert.strictEqual(fp.consistency.ok, true);
  v4Renderers.add(fp.webgl.renderer);
}
for (const gpu of ['Apple M1 Max', 'Apple M2 Max', 'Apple M3 Max', 'Apple M4 Max', 'UHD Graphics 630']) {
  assert([...v4Renderers].some((renderer) => renderer.includes(gpu)), `missing selected GPU ${gpu}`);
}
const v5 = PERSONAS_V5_BY_OS.macos_arm;
assert(v5.length > PERSONAS_V4_BY_OS.macos_arm.length);
assert(v5.every(isCoherent));
assert.strictEqual(new Set(v5.map(JSON.stringify)).size, v5.length);
for (let i = 0; i < 500; i++) {
  assert.strictEqual(pickPersona('macos_arm', i, 4), PERSONAS_V4_BY_OS.macos_arm[i % PERSONAS_V4_BY_OS.macos_arm.length]);
  assert.strictEqual(pickPersona('macos_arm', i, 5), v5[i % v5.length]);
}
const newChips = new Set();
for (let i = 0; i < 5000; i++) {
  const input = { ...profile, id: `mac-v5-${i}`, os: 'macOS', privacy: { deviceProfile: 'persona', personaVersion: 5 } };
  const fp = buildFingerprint(input);
  const family = fp.webgl.gpu.architecture;
  if (family !== 'apple-m5' && family !== 'apple-m6') continue;
  newChips.add(`${family}:${fp.hardwareConcurrency}`);
  const expected = family === 'apple-m6' ? '27.0.0' : '26.0.0';
  assert.strictEqual(fp.userAgentMetadata.platformVersion, expected);
  assert.strictEqual(fp.clientHints.platform_version, expected);
  const custom = buildFingerprint({ ...input, privacy: { ...input.privacy, fingerprint: { clientHints: { platform_version: '26.3.0' } } } });
  assert.strictEqual(custom.userAgentMetadata.platformVersion, '26.3.0');
}
for (const chip of ['apple-m5:10', 'apple-m5:15', 'apple-m5:18', 'apple-m6:10', 'apple-m6:12']) assert(newChips.has(chip), `missing ${chip}`);
console.log('persona pool versions: all checks passed');
