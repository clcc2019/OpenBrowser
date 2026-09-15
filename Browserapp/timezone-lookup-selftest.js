'use strict';

const assert = require('assert');
const { BrowserEngine } = require('./engine');
const {
  mergeNetworkLookups,
  normalizeTimezoneValue,
  timezoneFromLookup,
} = require('./proxy-forwarder');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  PASS  ' + name);
}

const values = [
  [{ timezone: 'Asia/Shanghai' }, 'Asia/Shanghai'],
  [{ time_zone: 'Europe/London' }, 'Europe/London'],
  [{ timeZone: 'America/New_York' }, 'America/New_York'],
  [{ timezoneId: 'Etc/UTC' }, 'Etc/UTC'],
  [{ timezone: { id: 'Asia/Tokyo', offset: 32400 } }, 'Asia/Tokyo'],
  [{ timezone: 'GMT+8', tz: 'Asia/Shanghai' }, 'Asia/Shanghai'],
  ['UTC', 'UTC'],
  ['+08:00', ''],
  ['[object Object]', ''],
];
for (const [input, expected] of values) {
  ok('normalizes ' + JSON.stringify(input), normalizeTimezoneValue(input) === expected);
}

ok(
  'reads nested provider timezone fields',
  timezoneFromLookup({ location: { timezone: { name: 'Asia/Tokyo' } } }) === 'Asia/Tokyo',
);

const merged = mergeNetworkLookups([
  { ip: '203.0.113.10', countryCode: 'US', timezone: '', geoRole: 'usage' },
  { ip: '203.0.113.10', countryCode: 'US', timezone: { id: 'America/New_York' }, geoRole: 'registry' },
]);
ok('keeps a valid timezone when the first source is empty', merged.timezone === 'America/New_York');

const engine = Object.create(BrowserEngine.prototype);
const cachedProfile = {
  id: 'timezone-cache-profile',
  proxy: 'http://127.0.0.1:8080',
  privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'disabled' },
};
engine.networkInfo = new Map([[
  cachedProfile.id,
  { ip: '198.51.100.20', countryCode: 'US', timezone: '' },
]]);
engine.profiles = new Map();
engine.running = new Set();
engine.sanitizeProfile = (profile) => profile;
engine.persist = async () => {};
engine.emit = () => {};
let lookupCount = 0;
engine.checkProxy = async () => {
  lookupCount += 1;
  const network = {
    ip: '198.51.100.20',
    countryCode: 'US',
    timezone: { id: 'America/New_York' },
    checkedAt: new Date().toISOString(),
  };
  engine.networkInfo.set(cachedProfile.id, network);
  return network;
};

(async () => {
  const resolved = await engine.ensureExitNetworkForLocale(cachedProfile);
  ok('rechecks a cached network without timezone', lookupCount === 1 && resolved.timezone === 'America/New_York');
  await engine.ensureExitNetworkForLocale(cachedProfile);
  ok('does not repeat lookup after timezone is filled', lookupCount === 1);
  ok('stores normalized exit timezone', cachedProfile.exitTimezone === 'America/New_York');
  console.log(`\n${passed} assertions passed`);
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
