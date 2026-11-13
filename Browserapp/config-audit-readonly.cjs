'use strict';

const path = require('path');
const { app, safeStorage } = require('electron');

const BASE = '/home/narwal/workdir/tools/OpenBrowser/Browserapp';
const DB = '/home/narwal/.config/openbrowser/openbrowser-state-v1.db';

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function bump(map, key) {
  const value = String(key == null || key === '' ? '(empty)' : key);
  map.set(value, (map.get(value) || 0) + 1);
}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-vulkan');
app.setName('OpenBrowser');
app.setPath('userData', '/home/narwal/.config/openbrowser');

app.whenReady().then(() => {
  const { DatabaseSync } = require('node:sqlite');
  const credentialCrypto = require(path.join(BASE, 'automation/credential-crypto.js'));
  const { buildFingerprint, hostConsistentProfile } = require(path.join(BASE, 'automation/fingerprint.js'));
  const db = new DatabaseSync(DB, { readOnly: true });
  const decode = (row) => JSON.parse(credentialCrypto.decrypt(Buffer.from(row.data)));
  const stateRow = db.prepare('SELECT data FROM engine_state WHERE id=1').get();
  const state = stateRow ? decode(stateRow) : {};
  const profiles = db.prepare('SELECT data FROM profiles ORDER BY position').all().map(decode);
  db.close();

  const counts = {
    os: new Map(), browser: new Map(), language: new Map(), networkMode: new Map(), proxyConfidence: new Map(),
    customTimezone: new Map(), exitCountry: new Map(), timezoneAlignment: new Map(),
    matchHostOs: new Map(), deviceProfile: new Map(), personaVersion: new Map(),
    canvas: new Map(), webgl: new Map(), webglMeta: new Map(), webgpu: new Map(),
    audio: new Map(), clientRects: new Map(), mediaDevices: new Map(), speech: new Map(),
    battery: new Map(), deviceNameMode: new Map(), webrtc: new Map(), timezoneMode: new Map(),
    geoMode: new Map(), uaMajor: new Map(), uaOs: new Map(), kernelMajor: new Map(),
    effectiveConsistency: new Map(), consistencyCodes: new Map(), errors: new Map(),
  };
  let uaEmpty = 0;
  let fpUaEmpty = 0;
  let proxyWithVerifiedExit = 0;
  let proxyWithoutVerifiedExit = 0;
  const samples = [];

  for (const profile of profiles) {
    const privacy = profile?.privacy || {};
    bump(counts.os, profile?.os);
    bump(counts.browser, profile?.browser);
    bump(counts.language, profile?.language);
    bump(counts.networkMode, profile?.networkMode || ((/^(direct|offline|none)?$/i.test(String(profile?.proxy || ''))) ? 'direct' : 'proxy'));
    const isProxy = String(profile?.networkMode || '').toLowerCase() === 'proxy'
      || Boolean(profile?.proxy && !/^(direct|offline|none)?$/i.test(String(profile.proxy)));
    if (isProxy) {
      if (profile?.exitIp && profile?.exitTimezone) proxyWithVerifiedExit += 1;
      else proxyWithoutVerifiedExit += 1;
    }
    bump(counts.proxyConfidence, isProxy ? (profile?.exitIp && profile?.exitTimezone ? 'verified-exit' : 'unverified-exit') : 'direct');
    bump(counts.matchHostOs, privacy.matchHostOs === false ? 'false' : 'true');
    bump(counts.deviceProfile, privacy.deviceProfile || 'default');
    bump(counts.personaVersion, privacy.personaVersion || '(default)');
    bump(counts.canvas, privacy.canvas);
    bump(counts.webgl, privacy.webgl);
    bump(counts.webglMeta, privacy.webglMeta);
    bump(counts.webgpu, privacy.webgpu);
    bump(counts.audio, privacy.audio);
    bump(counts.clientRects, privacy.clientRects);
    bump(counts.mediaDevices, privacy.mediaDevices || privacy.media);
    bump(counts.speech, privacy.speech);
    bump(counts.battery, privacy.battery);
    bump(counts.deviceNameMode, privacy.deviceNameMode);
    bump(counts.webrtc, privacy.webrtc);
    bump(counts.timezoneMode, privacy.timezoneMode || 'ip');
    bump(counts.customTimezone, privacy.timezoneMode === 'custom' ? privacy.timezone : '(not-custom)');
    bump(counts.exitCountry, profile?.exitCountryCode);
    if (privacy.timezoneMode !== 'custom') bump(counts.timezoneAlignment, 'no-custom-timezone');
    else if (!profile?.exitTimezone) bump(counts.timezoneAlignment, 'exit-timezone-unverified');
    else if (String(privacy.timezone || '').trim() === String(profile.exitTimezone || '').trim()) bump(counts.timezoneAlignment, 'custom-matches-exit');
    else bump(counts.timezoneAlignment, 'custom-differs-from-exit');
    bump(counts.geoMode, privacy.geoMode || 'disabled');
    if (!String(profile?.userAgent || '').trim()) uaEmpty += 1;
    if (!String(privacy?.fingerprint?.userAgent || '').trim()) fpUaEmpty += 1;

    try {
      const source = privacy.matchHostOs !== false ? hostConsistentProfile(profile) : profile;
      const fp = buildFingerprint({
        ...source,
        nativeKernelFingerprint: true,
        kernelVersion: '150.0.7871.186',
        exitTimezone: profile?.exitTimezone,
      });
      bump(counts.uaMajor, fp?.uaProfile?.chromeMajor || '(none)');
      bump(counts.uaOs, fp?.uaProfile?.os || '(none)');
      bump(counts.kernelMajor, String(fp?.uaProfile?.chromeFull || '').split('.')[0] || '(none)');
      bump(counts.effectiveConsistency, fp?.consistency?.ok ? 'ok' : 'error');
      for (const issue of fp?.consistency?.issues || []) bump(counts.consistencyCodes, issue.code);
      if (!fp?.consistency?.ok && samples.length < 12) {
        samples.push({ os: profile?.os, matchHostOs: privacy.matchHostOs, codes: fp?.consistency?.issues || [] });
      }
    } catch (error) {
      bump(counts.errors, error?.message || error);
    }
  }

  const output = {
    profileCount: profiles.length,
    enginePolicy: {
      preferIndependentKernel: state?.preferIndependentKernel,
      allowSystemBrowserFallback: state?.allowSystemBrowserFallback,
      systemBrowserPathSet: Boolean(state?.systemBrowserPath),
      kernelPolicyVersion: state?.kernelPolicyVersion,
    },
    userAgentStorage: { profileUserAgentEmpty: uaEmpty, fingerprintUserAgentEmpty: fpUaEmpty },
    proxy: { withVerifiedExit: proxyWithVerifiedExit, withoutVerifiedExit: proxyWithoutVerifiedExit },
    distributions: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, sortedCounts(value)])),
    errorSamples: samples,
  };
  console.log(JSON.stringify(output, null, 2));
  app.quit();
}).catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
