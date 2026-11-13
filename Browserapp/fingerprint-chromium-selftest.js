'use strict';

const assert = require('assert');
const {
  CURRENT_VERSION,
  PINNED_RELEASE,
  normalizeFingerprintRelease,
  selectFingerprintAsset,
  sha256Digest,
} = require('./automation/fingerprint-chromium');
const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  fingerprintChromiumArgs,
  hostConsistentProfile,
  applyFingerprintToTab,
} = require('./automation/fingerprint');

async function main() {
  assert.strictEqual(CURRENT_VERSION, '150.0.7871.186');
  const release = normalizeFingerprintRelease(PINNED_RELEASE);
  assert.strictEqual(release.version, CURRENT_VERSION);
  assert.ok(selectFingerprintAsset(release, 'linux', 'x64'));
  assert.ok(selectFingerprintAsset(release, 'win32', 'x64'));
  assert.strictEqual(selectFingerprintAsset(release, 'darwin', 'arm64'), null);
  assert.strictEqual(sha256Digest(release.assets[0].digest).length, 64);
  assert.throws(() => normalizeFingerprintRelease({
    tag_name: '150.0.7871.186',
    assets: [{ name: 'bad.zip', browser_download_url: 'https://example.com/bad.zip', digest: '', size: 1 }],
  }));
  console.log('  PASS  release assets, platform selection and SHA-256 validation');

  const windowsPersona = buildFingerprint({
    id: 'native-persona-windows',
    os: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    language: 'en-US',
    privacy: {
      matchHostOs: false,
      deviceProfile: 'persona',
      personaVersion: 5,
      canvas: 'noise',
      webgl: 'noise',
      webglMeta: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      webrtc: 'proxy',
      webgpu: 'blocked',
    },
    kernelVersion: '150.0.7871.186',
  });
  const personaArgs = fingerprintChromiumArgs(windowsPersona, windowsPersona, {
    kernelVersion: '150.0.7871.186',
    timezone: 'America/New_York',
  });
  assert.ok(personaArgs.includes('--fingerprint-platform=windows'));
  assert.ok(personaArgs.includes('--fingerprint-brand=Chrome'));
  assert.ok(personaArgs.includes('--fingerprint-brand-version=150.0.7871.186'));
  assert.ok(personaArgs.includes(`--fingerprint-hardware-concurrency=${windowsPersona.hardwareConcurrency}`));
  assert.ok(personaArgs.includes('--disable-non-proxied-udp'));
  assert.ok(personaArgs.includes('--disable-quic'));
  assert.ok(personaArgs.includes('--disable-features=WebGPU,WebGPUService'));
  assert.ok(!personaArgs.some((arg) => /^--disable-spoofing=.*canvas/.test(arg)));
  console.log('  PASS  persona values map to native fingerprint flags');

  const hostProfile = hostConsistentProfile({ id: 'native-host-flags', privacy: { matchHostOs: true } });
  const hostFp = buildFingerprint({ ...hostProfile, kernelVersion: '150.0.7871.186' });
  const hostArgs = fingerprintChromiumArgs(hostFp, hostProfile, { kernelVersion: '150.0.7871.186' });
  const disabled = hostArgs.find((arg) => arg.startsWith('--disable-spoofing='));
  assert.ok(disabled && ['font', 'audio', 'canvas', 'clientrects', 'gpu'].every((key) => disabled.includes(key)));
  console.log('  PASS  real-device modes disable corresponding native spoofing');

  const nativeProfile = {
    id: 'native-persona-windows',
    os: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    language: 'en-US',
    privacy: {
      matchHostOs: false,
      deviceProfile: 'persona',
      personaVersion: 5,
      canvas: 'noise',
      webgl: 'noise',
      webglMeta: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      webrtc: 'proxy',
      webgpu: 'blocked',
      fingerprint: { chromeMajor: 157 },
    },
    nativeKernelFingerprint: true,
    kernelVersion: '150.0.7871.186',
  };
  const nativeFp = buildFingerprint(nativeProfile);
  assert.strictEqual(nativeFp.consistencyMode, 'native-kernel');
  assert.strictEqual(nativeFp.nativeKernelFingerprint, true);
  assert.ok(nativeFp.userAgent.includes('Chrome/150.0.0.0'));
  assert.strictEqual(nativeFp.userAgentMetadata.uaFullVersion, '150.0.7871.186');
  assert.strictEqual(nativeFp.userAgentMetadata.bitness, '64');
  assert.ok(nativeFp.userAgentMetadata.fullVersionList.every((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item.version)));
  assert.strictEqual(buildInjectionScript(nativeFp), '');
  assert.strictEqual(buildWorkerInjectionScript(nativeFp), '');
  const calls = [];
  await applyFingerprintToTab(async (...args) => calls.push(args), 'ws://unused', nativeFp, nativeProfile);
  const methods = calls.map((args) => args[1]);
  assert.ok(methods.includes('Emulation.setUserAgentOverride'));
  assert.ok(methods.includes('Network.setUserAgentOverride'));
  assert.ok(methods.includes('Emulation.setLocaleOverride'));
  assert.ok(!methods.includes('Page.enable'));
  assert.ok(!methods.includes('Runtime.enable'));
  assert.ok(!calls.some((args) => args[1] === 'Page.addScriptToEvaluateOnNewDocument'));
  const uaOverride = calls.find((args) => args[1] === 'Emulation.setUserAgentOverride')?.[2];
  assert.strictEqual(uaOverride.userAgentMetadata.bitness, '64');
  assert.strictEqual(uaOverride.userAgentMetadata.architecture, 'x86');
  const localeOverride = calls.find((args) => args[1] === 'Emulation.setLocaleOverride')?.[2];
  assert.strictEqual(localeOverride.locale, 'en-US');
  assert.strictEqual(uaOverride.acceptLanguage, 'en-US,en');
  console.log('  PASS  native kernel keeps native JS surfaces and fixes only CDP UA-CH/locale metadata');

  const rotatedProfile = {
    ...nativeProfile,
    privacy: {
      ...nativeProfile.privacy,
      fingerprint: { ...nativeProfile.privacy.fingerprint, seed: 'persistent-rotation-v1' },
    },
  };
  const rotatedA = buildFingerprint(rotatedProfile);
  const rotatedB = buildFingerprint(rotatedProfile);
  assert.notStrictEqual(rotatedA.seed, nativeFp.seed);
  assert.strictEqual(rotatedA.seed, rotatedB.seed);
  console.log('  PASS  persisted seed rotation changes the device identity without per-launch drift');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
