'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { mergeLaunchArgs } = require('./command-line-flags');
const { BrowserEngine } = require('../engine');
const { chromeArgsForFingerprint } = require('./fingerprint');

async function main() {
  assert.deepEqual(mergeLaunchArgs(
    ['--enable-features=A,B', '--disable-features=WebGPU', 'about:blank'],
    ['--enable-features=B,C', '--disable-features=WebGPU,Translate'],
  ), ['--enable-features=A,B,C', '--disable-features=WebGPU,Translate', 'about:blank']);
  const engine = Object.create(BrowserEngine.prototype);
  engine.networkInfo = new Map();
  engine.profiles = new Map();
  engine.emit = () => {};
  engine.resolveStoredProxyProfile = value => value;
  engine.testProxy = async () => { throw new Error('unreachable'); };
  assert.equal(engine.proxyArg('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(engine.proxyArg('http://[::1]:8080/'), 'http://[::1]:8080');
  assert.equal(engine.proxyArg('http://user:password@127.0.0.1:8080/'), null);
  assert.ok(!chromeArgsForFingerprint({}).some(arg => arg.startsWith('--disable-blink-features')));
  const base = { id: 'proxy-test', name: 'Proxy test', networkMode: 'proxy' };
  assert.equal(engine.sanitizeProfile({ ...base, proxy: '' }).networkMode, 'proxy');
  const missing = await engine.prepareProfileProxyForStart({ ...base, proxy: '' });
  assert.equal(missing.networkMode, 'proxy');
  let tests = 0;
  engine.testProxy = async () => { tests += 1; throw new Error('unreachable'); };
  for (const policy of ['block', 'continue', 'direct']) {
    const prepared = await engine.prepareProfileProxyForStart({
      ...base, proxy: 'http://127.0.0.1:9', proxyMeta: { checkOnStart: true, notReadyPolicy: policy, requireReady: true },
    });
    assert.equal(prepared.proxy, 'http://127.0.0.1:9');
    assert.equal(prepared.networkMode, 'proxy');
    assert.equal(prepared.proxyMeta.checkOnStart, false);
    assert.equal(prepared.proxyMeta.requireReady, false);
    assert.equal(prepared.proxyMeta.notReadyPolicy, 'continue');
  }
  assert.equal(tests, 0, 'startup must not test proxy connectivity');
  engine.checkProxy = async () => { throw new Error('unexpected automatic check'); };
  engine.running = new Map();
  assert.equal(await engine.ensureExitNetworkForLocale(missing), null);
  engine.ensureStartPage = async () => ({ registerSession: () => 'http://127.0.0.1/start' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-no-proxy-check-'));
  try {
    assert.equal(await engine.buildStartPageUrl(missing, root, 'Chrome', 0), 'http://127.0.0.1/start');
    const proxied = engine.sanitizeProfile({ ...base, proxy: 'http://127.0.0.1:9' });
    assert.equal(await engine.ensureExitNetworkForLocale(proxied), null);
    assert.equal(await engine.buildStartPageUrl(proxied, root, 'Chrome', 0), 'http://127.0.0.1/start');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const direct = await engine.prepareProfileProxyForStart({ ...base, networkMode: 'direct', proxy: 'Direct' });
  assert.equal(direct.networkMode, 'direct');
  console.log('launch-safety-selftest: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
