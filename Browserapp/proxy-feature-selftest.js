'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  extractProxyFromApi,
  extractProxyStrings,
  invokeProxyRefresh,
  classifyProxyError,
  parseProxy,
} = require('./proxy-forwarder');
const { ProxyStore } = require('./automation/proxy-store');

function makeEngineStub() {
  // Lightweight stub around real methods by requiring engine and monkeypatching heavy deps is hard.
  // Instead re-implement prepare flow checks via public helpers + a minimal harness of BrowserEngine methods.
  const { BrowserEngine } = require('./engine');
  const engine = Object.create(BrowserEngine.prototype);
  engine.profiles = new Map();
  engine.networkInfo = new Map();
  engine.running = new Map();
  engine.starting = new Map();
  engine.stopping = new Map();
  engine.extensions = new Map();
  engine.assignments = new Map();
  engine.listeners = new Set();
  engine.persist = async () => {};
  engine.emit = () => {};
  // bind methods that use this
  engine.sanitizeProfile = BrowserEngine.prototype.sanitizeProfile.bind(engine);
  engine.resolveProfileProxyConfig = BrowserEngine.prototype.resolveProfileProxyConfig.bind(engine);
  engine.fingerprintPatchFromNetwork = BrowserEngine.prototype.fingerprintPatchFromNetwork.bind(engine);
  engine.applyNetworkToProfile = BrowserEngine.prototype.applyNetworkToProfile.bind(engine);
  engine.testProxy = BrowserEngine.prototype.testProxy.bind(engine);
  engine.checkProxy = BrowserEngine.prototype.checkProxy.bind(engine);
  engine.prepareProfileProxyForStart = BrowserEngine.prototype.prepareProfileProxyForStart.bind(engine);
  engine.refreshProfileProxy = BrowserEngine.prototype.refreshProfileProxy.bind(engine);
  engine.applyResolvedLocale = BrowserEngine.prototype.applyResolvedLocale.bind(engine);
  engine.restoreStoredProxyCredentials = BrowserEngine.prototype.restoreStoredProxyCredentials.bind(engine);
  return engine;
}

async function main() {
  // --- extract / refresh local HTTP ---
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/extract-text')) {
      res.end('socks5://dynuser:dynpass@10.20.30.40:1080');
      return;
    }
    if (req.url.startsWith('/extract-json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { host: '10.20.30.50', port: 9090, username: 'j', password: 'k', protocol: 'http' } }));
      return;
    }
    if (req.url.startsWith('/refresh')) {
      res.end('rotated');
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const t1 = await extractProxyFromApi(`${base}/extract-text`);
  assert.strictEqual(t1.host, '10.20.30.40');
  assert.strictEqual(t1.port, 1080);
  assert.strictEqual(t1.username, 'dynuser');
  const t2 = await extractProxyFromApi(`${base}/extract-json`);
  assert.strictEqual(t2.host, '10.20.30.50');
  assert.strictEqual(t2.port, 9090);
  assert.strictEqual(t2.protocol, 'http');
  const refreshed = await invokeProxyRefresh(`${base}/refresh`);
  assert.strictEqual(refreshed.ok, true);
  assert.ok(extractProxyStrings('a\nsocks5://1.1.1.1:1\nb').some((s) => s.includes('1.1.1.1')));

  // --- sanitize keeps new fields ---
  const engine = makeEngineStub();
  const sanitized = engine.sanitizeProfile({
    id: 'prof_proxy_feature_1',
    name: 'proxy-feature',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1080',
    proxyMeta: {
      ipChannel: 'ifconfig.me',
      checkOnStart: true,
      refreshOnStart: true,
      apiExtractUrl: `${base}/extract-text`,
      refreshUrl: `${base}/refresh`,
      backupProxies: ['socks5://127.0.0.1:1081', 'http://127.0.0.1:8080'],
      fillFingerprint: false,
    },
    privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
  });
  assert.strictEqual(sanitized.proxyMeta.ipChannel, 'ifconfig-me');
  assert.strictEqual(sanitized.proxyMeta.refreshOnStart, true);
  assert.strictEqual(sanitized.proxyMeta.fillFingerprint, false);
  assert.deepStrictEqual(sanitized.proxyMeta.backupProxies, ['socks5://127.0.0.1:1081', 'http://127.0.0.1:8080']);
  assert.ok(sanitized.proxyMeta.apiExtractUrl.includes('/extract-text'));

  // --- prepare without check flags must not throw for static proxy ---
  const quiet = await engine.prepareProfileProxyForStart({
    id: 'prof_proxy_feature_2',
    name: 'quiet',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1080',
    proxyMeta: { checkOnStart: false, refreshOnStart: false },
    privacy: {},
  });
  assert.strictEqual(quiet.proxy.includes('127.0.0.1:1080'), true);

  // --- prepare direct without extract must stay direct ---
  const direct = await engine.prepareProfileProxyForStart({
    id: 'prof_proxy_feature_3',
    name: 'direct',
    networkMode: 'direct',
    proxy: 'Direct',
    proxyMeta: {},
    privacy: {},
  });
  assert.ok(/direct/i.test(direct.proxy) || direct.networkMode === 'direct');

  // Dynamic extraction still configures the proxy, without checking or failing over.
  const engine2 = makeEngineStub();
  let tests = 0;
  engine2.testProxy = async () => { tests += 1; throw new Error('unexpected startup test'); };
  const extracted = await engine2.prepareProfileProxyForStart({
    id: 'prof_proxy_feature_4', name: 'dynamic', networkMode: 'proxy',
    proxy: 'socks5://old:old@1.1.1.1:1',
    proxyMeta: { checkOnStart: true, apiExtractUrl: `${base}/extract-text`, backupProxies: ['socks5://127.0.0.1:1081'] },
  });
  assert.ok(extracted.proxy.includes('10.20.30.40'));
  assert.strictEqual(tests, 0);
  const events = [];
  engine2.emit = (event) => events.push(event);
  for (const proxy of ['', 'socks5://127.0.0.1:1080']) {
    const prepared = await engine2.prepareProfileProxyForStart({
      id: 'failure', name: 'failure', networkMode: 'proxy', proxy,
      proxyMeta: { refreshOnStart: true, refreshUrl: `${base}/missing`, apiExtractUrl: `${base}/missing-extract` },
    });
    assert.strictEqual(prepared.proxy, proxy);
  }
  assert.ok(events.some((event) => event.code === 'extract-error'));
  assert.ok(events.some((event) => event.message.includes('刷新代理失败')));
  assert.strictEqual(tests, 0);
  const net = { ip: '198.51.100.2', countryCode: 'US', timezone: 'America/New_York', latitude: 40.7, longitude: -74 };
  // sanitize must NOT copy refreshUrl into apiExtractUrl
  const noBleed = engine.sanitizeProfile({
    id: 'prof_proxy_feature_5',
    name: 'no-bleed',
    networkMode: 'proxy',
    proxy: 'socks5://1.1.1.1:1',
    proxyMeta: { refreshUrl: 'http://example.test/refresh', apiExtractUrl: '' },
    privacy: {},
  });
  assert.strictEqual(noBleed.proxyMeta.apiExtractUrl, '');
  assert.strictEqual(noBleed.proxyMeta.refreshUrl, 'http://example.test/refresh');

  // refresh surfaces extract error when extract fails but static proxy remains
  const engine3 = makeEngineStub();
  engine3.checkProxy = async (profile) => ({
    ip: '203.0.113.9',
    countryCode: 'JP',
    timezone: 'Asia/Tokyo',
    latitude: 35,
    longitude: 139,
    latencyMs: 20,
    networkType: 'broadband',
    checkedAt: new Date().toISOString(),
    protocol: 'socks5',
    endpoint: '1.1.1.1:1',
    proxySource: 'primary',
    proxyRaw: profile.proxy,
    appliedFingerprint: engine3.fingerprintPatchFromNetwork({
      ip: '203.0.113.9', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35, longitude: 139,
    }, profile),
    profile,
  });
  const refreshWithWarn = await engine3.refreshProfileProxy({
    id: 'prof_proxy_feature_6',
    name: 'refresh-warn',
    networkMode: 'proxy',
    proxy: 'socks5://1.1.1.1:1',
    proxyMeta: {
      refreshUrl: `${base}/refresh`,
      apiExtractUrl: `${base}/missing-extract`,
    },
    privacy: {},
  });
  assert.ok(refreshWithWarn.extractError, 'extract failure should surface');
  assert.ok(refreshWithWarn.network?.ip === '203.0.113.9');

  // fingerprint patch
  const patch = engine2.fingerprintPatchFromNetwork(net, extracted);
  assert.strictEqual(patch.language, 'en-US');
  assert.strictEqual(patch.privacy.timezone, 'America/New_York');

  // --- proxy store mark fields ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxf-'));
  const store = new ProxyStore(path.join(dir, 'p.json'));
  await store.load();
  const item = await store.create({ raw: 'socks5://127.0.0.1:9', name: 'x', ipChannel: 'ifconfig.me' });
  assert.strictEqual(store.get(item.id).ipChannel, 'ifconfig-me');
  await store.markCheck(item.id, { ip: '8.8.8.8', countryCode: 'US', latencyMs: 12, networkType: 'broadband' });
  assert.strictEqual(store.get(item.id).lastLatencyMs, 12);
  assert.strictEqual(store.get(item.id).lastCheckOk, true);
  await store.markCheckError(item.id, { errorClass: 'auth', latencyMs: 9 });
  assert.strictEqual(store.get(item.id).lastCheckOk, false);
  assert.strictEqual(store.get(item.id).lastErrorClass, 'auth');
  fs.rmSync(dir, { recursive: true, force: true });

  // UI localStorage redacts proxy auth. Start must restore credentials from engine state
  // when host:port still match, otherwise Chrome launches without the local auth bridge.
  const credEngine = makeEngineStub();
  const stored = credEngine.sanitizeProfile({
    id: 'prof_proxy_auth_restore',
    name: 'auth-restore',
    networkMode: 'proxy',
    proxy: 'http://user:secret@14.224.225.102:19125',
  });
  credEngine.profiles.set(stored.id, stored);
  const redacted = credEngine.sanitizeProfile({
    id: stored.id,
    name: stored.name,
    networkMode: 'proxy',
    proxy: 'http://14.224.225.102:19125/',
  });
  const restored = credEngine.restoreStoredProxyCredentials(redacted);
  assert.ok(restored.proxy.includes('user:secret@'), 'redacted UI proxy must restore stored credentials, got ' + restored.proxy);
  assert.strictEqual(restored.networkMode, 'proxy');
  const otherHost = credEngine.restoreStoredProxyCredentials(credEngine.sanitizeProfile({
    id: stored.id,
    name: stored.name,
    networkMode: 'proxy',
    proxy: 'http://10.0.0.1:8080',
  }));
  assert.ok(!otherHost.proxy.includes('user:secret@'), 'must not copy credentials onto a different host:port');

  let libraryRaw = 'socks5://library-user:library-pass@library.test:1080';
  credEngine.proxyStore = {
    get(id) {
      return id === 'library-proxy' ? {
        id,
        raw: libraryRaw,
        ipChannel: 'ip-api',
        refreshUrl: 'https://refresh.invalid/',
      } : null;
    },
  };
  const linked = credEngine.resolveStoredProxyProfile(credEngine.sanitizeProfile({
    id: 'prof_proxy_library',
    name: 'library-linked',
    networkMode: 'proxy',
    proxy: 'socks5://library.test:1080',
    proxy_id: 'library-proxy',
  }));
  assert.strictEqual(linked.proxyId, 'library-proxy');
  assert.strictEqual(linked.proxyMeta.proxyId, 'library-proxy');
  assert.ok(linked.proxy.includes('library-user:library-pass@'), 'linked start must hydrate latest full credentials');

  credEngine.profiles.set(linked.id, linked);
  libraryRaw = 'socks5://rotated-user:rotated-pass@rotated-library.test:2080';
  await credEngine.syncProfiles([{ ...linked }]);
  const rotatedLinked = credEngine.profiles.get(linked.id);
  assert.strictEqual(rotatedLinked.proxyId, 'library-proxy');
  assert.ok(rotatedLinked.proxy.includes('rotated-user:rotated-pass@rotated-library.test:2080'), 'linked sync/start must use current ProxyStore raw');

  await credEngine.syncProfiles([{
    ...rotatedLinked,
    proxy: 'http://manual-user:manual-pass@manual-edit.test:8080',
  }]);
  const manuallyUnlinked = credEngine.profiles.get(linked.id);
  assert.strictEqual(manuallyUnlinked.proxyId, null, 'manual proxy edit must clear top-level library association');
  assert.strictEqual(manuallyUnlinked.proxyMeta.proxyId, null, 'manual proxy edit must clear proxyMeta library association');
  assert.ok(manuallyUnlinked.proxy.includes('manual-user:manual-pass@manual-edit.test:8080'));

  const directUnlinked = credEngine.sanitizeProfile({
    ...rotatedLinked,
    networkMode: 'direct',
    proxy: 'Direct',
    proxyId: null,
    proxy_id: 'stale-snake-id',
    proxyMeta: { ...linked.proxyMeta, proxyId: 'stale-meta-id', proxy_id: 'stale-meta-snake-id' },
  });
  assert.strictEqual(directUnlinked.proxyId, null);
  assert.strictEqual(directUnlinked.proxyMeta.proxyId, null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(directUnlinked, 'proxy_id'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(directUnlinked.proxyMeta, 'proxy_id'), false);

  const deletedLibraryFallback = credEngine.resolveStoredProxyProfile(credEngine.sanitizeProfile({
    id: 'prof_deleted_library',
    name: 'deleted-library',
    networkMode: 'proxy',
    proxy: 'http://manual-user:manual-pass@manual.test:8080',
    proxyLibraryId: 'deleted-proxy',
  }));
  assert.strictEqual(deletedLibraryFallback.proxyId, null);
  assert.strictEqual(deletedLibraryFallback.proxyMeta.proxyId, null);
  assert.ok(deletedLibraryFallback.proxy.includes('manual-user:manual-pass@'));

  // --- renderer wiring integrity ---
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  for (const id of [
    'editor-api-extract-url',
    'editor-backup-proxies',
    'editor-proxy-refresh-start',
    'editor-proxy-fill-fingerprint',
    'editor-proxy-require-ready',
    'editor-proxy-not-ready-policy',
    'editor-proxy-tls-profile',
    'editor-proxy-tls-chrome-major',
    'editor-test-proxy',
    'editor-apply-proxy-fp',
    'editor-refresh-proxy',
    'proxy-check-all',
  ]) {
    assert.ok(html.includes(`id="${id}"`), 'missing html id ' + id);
  }
  assert.ok(html.includes('value="ifconfig-me"'), 'ifconfig.me must be selectable as an IP query channel');
  assert.ok(renderer.includes("requireReady: false"), 'editor must disable startup blocking');
  assert.ok(renderer.includes("notReadyPolicy: 'continue'"), 'editor must continue startup');
  assert.ok(renderer.includes("tlsProfile: $('#editor-proxy-tls-profile')"), 'editor draft must collect tlsProfile');
  assert.ok(renderer.includes("apiExtractUrl: String(proxyMeta.apiExtractUrl || '')"), 'normalize must not bleed refreshUrl into apiExtractUrl');
  assert.strictEqual((renderer.match(/\$\('#editor-test-proxy'\)\?\.addEventListener\('click', testEditorProxy\);/g) || []).length, 1, 'test proxy listener should be single');
  assert.strictEqual((renderer.match(/\$\('#editor-apply-proxy-fp'\)\?\.addEventListener\('click', applyEditorProxyFingerprint\);/g) || []).length, 1);
  assert.strictEqual((renderer.match(/\$\('#editor-refresh-proxy'\)\?\.addEventListener\('click', refreshEditorProxy\);/g) || []).length, 1);
  // table headers vs cells: latency + type
  assert.ok(html.includes('<th>延迟</th>') && html.includes('<th>类型</th>'));
  assert.ok(renderer.includes("element('td', '', latency)") && renderer.includes("element('td', '', netType)"));
  assert.ok(preload.includes("profiles:refresh-proxy"));
  assert.ok(preload.includes("profiles:apply-proxy-fingerprint"));
  assert.ok(preload.includes("proxy:check-many"));
  assert.ok(main.includes("registerTrustedIpc('profiles:refresh-proxy'"));
  assert.ok(main.includes("registerTrustedIpc('profiles:apply-proxy-fingerprint'"));
  assert.ok(main.includes("registerTrustedIpc('proxy:check-many'"));
  assert.ok(renderer.includes('批量检测失败'), 'batch check should surface errors');
  assert.ok(renderer.includes('result.extractError'), 'refresh UI should surface extract warnings');
  assert.ok(renderer.includes('exitLatencyMs'), 'profile check should keep latency');
  assert.strictEqual(classifyProxyError(new Error('username or password')), 'auth');
  assert.ok(parseProxy('socks5://a:b@1.2.3.4:1080'));

  // forced proxy option must bypass resolveProfileProxyConfig
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  assert.ok(engineSrc.includes('options.proxy || options.forcedProxy'), 'testProxy must accept forced proxy option');
  assert.ok(!engineSrc.slice(engineSrc.indexOf('async prepareProfileProxyForStart'), engineSrc.indexOf('async readExtension', engineSrc.indexOf('async prepareProfileProxyForStart'))).includes('this.testProxy('), 'startup must not test proxies');
  assert.ok(engineSrc.includes('extractError: extractError ? String(extractError.message || extractError) : null'), 'refresh must surface extract errors');
  assert.ok(!engineSrc.includes("apiExtractUrl: String(proxyMetaValue.apiExtractUrl || proxyMetaValue.refreshUrl || '')"), 'sanitize must not bleed refreshUrl into apiExtractUrl');

  const engine4 = makeEngineStub();
  let resolveCalled = 0;
  engine4.resolveProfileProxyConfig = async function () {
    resolveCalled += 1;
    throw new Error('resolve should not run for forced proxy');
  };
  // Exercise forced branch without network: invalid forced proxy should fail parse before resolve.
  let forcedParseError = null;
  try {
    await engine4.testProxy({
      id: 'prof_proxy_feature_7',
      name: 'forced',
      networkMode: 'proxy',
      proxy: 'socks5://primary:pw@1.1.1.1:1',
      privacy: {},
      proxyMeta: {},
    }, { proxy: 'not-a-proxy', proxySource: 'backup', allowExtract: false });
  } catch (error) {
    forcedParseError = error;
  }
  assert.ok(forcedParseError, 'invalid forced proxy should throw');
  assert.strictEqual(resolveCalled, 0, 'forced proxy must skip resolve even on parse failure');

  server.close();
  console.log('PROXY_FEATURE_SELFTEST_OK extract=1 failover=1 sanitize=1 wiring=1 store=1 refresh=1 forced=1');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
