'use strict';

// Wiring for the device-persona control, front to back.
//
// The setting only works if four places agree: the option values in index.html, the read and
// write paths in renderer.js, and the whitelist in engine.sanitizeProfile — which silently
// drops anything it does not recognise, so a typo here fails quietly rather than loudly.
//
// It also pins the safety property: an existing profile with no stored value stays on
// 'default', so its hardware identity is never re-rolled underneath it.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BrowserEngine } = require('./engine.js');
const { buildFingerprint } = require('./automation/fingerprint');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// --- markup ---
const selectMatch = html.match(/<select id="editor-device-profile">([\s\S]*?)<\/select>/);
ok('index.html has the device profile select', Boolean(selectMatch));
const optionValues = [...(selectMatch?.[1] || '').matchAll(/value="([^"]*)"/g)].map((m) => m[1]).sort();
ok(`select offers exactly persona/default (got ${optionValues.join(',')})`, JSON.stringify(optionValues) === JSON.stringify(['default', 'persona']));

// --- renderer read + write ---
ok('renderer reads the select into the draft', /deviceProfile: \$\('#editor-device-profile'\)\?\.value \|\| 'default'/.test(renderer));
ok('renderer populates the select from the profile', /editorSet\('#editor-device-profile', privacy\.deviceProfile \|\| 'default'\)/.test(renderer));
ok('normalizing keeps an existing profile off by default', /deviceProfile: String\(privacy\.deviceProfile \|\| 'default'\)/.test(renderer));
ok('newly created profiles opt in', /privacy: \{[^}]*deviceProfile: 'persona'[^}]*\}/.test(renderer));
ok('new profiles default to the host platform', /const DEFAULT_PROFILE_OS = HOST_PROFILE_OS;/.test(renderer));
ok('host consistency remains exposed but defaults off', /id="editor-match-host-os"/.test(html)
  && !/id="editor-match-host-os" type="checkbox" checked/.test(html)
  && /matchHostOs: privacy\.matchHostOs !== false/.test(renderer));
ok('new profiles default to device-isolation persona mode', (renderer.match(/privacy: \{[^}]*matchHostOs: false[^}]*deviceProfile: 'persona'/g) || []).length >= 2);

// --- engine whitelist accepts exactly those values ---
{
  const sanitize = BrowserEngine.prototype.sanitizeProfile;
  const ctx = { profiles: new Map() };
  const of = (value) => sanitize.call(ctx, { id: 'w', name: 'w', privacy: value === undefined ? {} : { deviceProfile: value } }).privacy.deviceProfile;
  ok('engine keeps "persona"', of('persona') === 'persona');
  ok('engine keeps "default"', of('default') === 'default');
  ok('engine defaults a missing value to "default"', of(undefined) === 'default');
  ok('engine rejects anything else', of('nonsense') === 'default' && of('') === 'default');
  const hostOf = (value) => sanitize.call(ctx, { id: 'w', name: 'w', privacy: value === undefined ? {} : { matchHostOs: value } }).privacy.matchHostOs;
  ok('engine defaults host consistency on', hostOf(undefined) === true);
  ok('engine preserves explicit cross-platform opt-out', hostOf(false) === false);
}

// --- the setting actually changes the fingerprint it is supposed to ---
{
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const off = buildFingerprint({ id: 'wire', userAgent: WIN, privacy: { deviceProfile: 'default' }, advanced: {} });
  const on = buildFingerprint({ id: 'wire', userAgent: WIN, privacy: { deviceProfile: 'persona' }, advanced: {} });
  ok('turning it on changes the reported hardware', JSON.stringify([on.hardwareConcurrency, on.deviceMemory, on.webgl.renderer]) !== JSON.stringify([off.hardwareConcurrency, off.deviceMemory, off.webgl.renderer]));
  ok('turning it on keeps the profile seed stable', on.seed === off.seed);
}

console.log(`\ndevice-profile-wiring-selftest: ${passed} checks passed.`);
