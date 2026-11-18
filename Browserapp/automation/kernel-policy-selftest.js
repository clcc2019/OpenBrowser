'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  BrowserKernelManager,
  downloadFile,
  validateArchiveMemberName,
  safeInstalledBinary,
  findOpenBrowserKernelBinary,
  findBundledWayfernKernel,
  findBundledChromeForTesting,
  findBundledChromeStable,
  isOpenBrowser148SupportedHost,
  isMacX64Host,
  isWayfernKernel,
  isIntegratedKernelCdpReady,
  termsAcceptanceArgsForKernel,
  SOURCE_OPENBROWSER,
  SOURCE_WAYFERN,
  SOURCE_CFT,
  SOURCE_CHROME_STABLE,
  SOURCE_CUSTOM,
  SOURCE_FINGERPRINT_CHROMIUM,
  PINNED_FINGERPRINT_CHROMIUM_RELEASE,
} = require('./browser-kernel');
const { BrowserEngine, systemBrowserCandidatesForPlatform } = require('../engine');
const { proxyForUrl, requestUrl } = require('./http-proxy');

const PROXY_ENV_KEYS = [
  'OPENBROWSER_KERNEL_PROXY',
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
];

async function withoutProxyEnvironment(callback) {
  const saved = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  try {
    return await callback();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function responseBody(response) {
  response.setEncoding('utf8');
  let body = '';
  for await (const chunk of response) body += chunk;
  return body;
}

function cftBinary(root) {
  const platform = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64')
    : process.platform === 'win32'
      ? 'chrome-win64'
      : 'chrome-linux64';
  if (process.platform === 'darwin') {
    return path.join(root, 'kernels', 'chrome-for-testing', platform, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  }
  return path.join(root, 'kernels', 'chrome-for-testing', platform, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-kernel-'));
  try {
    const binary = cftBinary(root);
    await fsp.mkdir(path.dirname(binary), { recursive: true });
    await fsp.writeFile(binary, '', 'utf8');
    await fsp.writeFile(path.join(root, 'kernels', 'kernel-meta.json'), JSON.stringify({
      binary: path.join(root, 'old-app-name', 'kernels', 'missing-browser'),
      source: 'chrome-for-testing',
      version: '123.0.0.0',
    }), 'utf8');

    // Manager without resourceRoots: only scans this temp userData.
    const manager = new BrowserKernelManager(root);
    await manager.loadMeta();
    assert.strictEqual(manager.status().kernel.path, binary);
    assert.strictEqual(manager.meta.binary, binary);
    console.log('  PASS  stale kernel metadata repaired to current data root');

    const fingerprintUserData = path.join(root, 'fingerprint-user-data');
    const fingerprintRoot = path.join(fingerprintUserData, 'kernels', 'fingerprint-chromium', 'versions', PINNED_FINGERPRINT_CHROMIUM_RELEASE.version);
    const fingerprintBinary = path.join(fingerprintRoot, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
    await fsp.mkdir(fingerprintRoot, { recursive: true });
    await fsp.writeFile(fingerprintBinary, '', 'utf8');
    await fsp.writeFile(path.join(fingerprintRoot, 'kernel.json'), JSON.stringify({ version: PINNED_FINGERPRINT_CHROMIUM_RELEASE.version, binary: path.basename(fingerprintBinary) }));
    const fingerprintManager = new BrowserKernelManager(fingerprintUserData);
    await fingerprintManager.loadMeta();
    assert.strictEqual(fingerprintManager.status().kernel.path, fingerprintBinary);
    assert.strictEqual(fingerprintManager.meta.binary, fingerprintBinary);
    const fingerprintEngine = new BrowserEngine({ getPath: () => fingerprintUserData });
    assert.strictEqual(fingerprintEngine.chooseBrowser().path, fingerprintBinary);
    console.log('  PASS  discovered Fingerprint Chromium is selectable and repairs metadata');

    const bundledRoot = path.join(root, 'bundled-kernels', 'wayfern');
    const bundledBinary = path.join(bundledRoot, process.platform === 'win32' ? 'wayfern.exe' : 'wayfern');
    await fsp.mkdir(bundledRoot, { recursive: true });
    await fsp.writeFile(bundledBinary, '', 'utf8');
    await fsp.writeFile(path.join(bundledRoot, 'kernel.json'), JSON.stringify({ version: '149.0.0.0' }), 'utf8');
    const bundled = findBundledWayfernKernel([root]);
    assert.strictEqual(path.resolve(bundled.binary), path.resolve(bundledBinary));
    assert.strictEqual(isWayfernKernel({ path: bundledBinary }), true);
    assert.deepStrictEqual(termsAcceptanceArgsForKernel({ path: bundledBinary }), ['--accept-terms-and-conditions']);
    assert.deepStrictEqual(termsAcceptanceArgsForKernel({ path: binary, source: 'chrome-for-testing' }), []);
    console.log('  PASS  bundled Wayfern kernel discovered from packaged resource root');

    const cftResourceRoot = path.join(root, 'cft-resource');
    const packagedCft = cftBinary(cftResourceRoot);
    await fsp.mkdir(path.dirname(packagedCft), { recursive: true });
    await fsp.writeFile(packagedCft, '', 'utf8');
    await fsp.writeFile(path.join(cftResourceRoot, 'kernels', 'chrome-for-testing', 'kernel.json'), JSON.stringify({ version: '123.0.0.0' }), 'utf8');
    const bundledCft = findBundledChromeForTesting([cftResourceRoot]);
    assert.strictEqual(path.resolve(bundledCft.binary), path.resolve(packagedCft));
    const packagedManager = new BrowserKernelManager(path.join(root, 'packaged-user-data'), { resourceRoot: cftResourceRoot });
    await packagedManager.loadMeta();
    assert.strictEqual(packagedManager.status().kernel.source, SOURCE_CFT);
    assert.strictEqual(path.resolve(packagedManager.status().kernel.path), path.resolve(packagedCft));
    console.log('  PASS  bundled Chrome for Testing discovered from packaged resource root');

    const stableOverrideUserData = path.join(root, 'stable-override-user-data');
    const stableOverrideBinary = path.join(stableOverrideUserData, 'kernels', 'chrome-stable', 'opt', 'google', 'chrome', 'chrome');
    await fsp.mkdir(path.dirname(stableOverrideBinary), { recursive: true });
    await fsp.writeFile(stableOverrideBinary, '', 'utf8');
    await fsp.writeFile(path.join(stableOverrideUserData, 'kernels', 'kernel-meta.json'), JSON.stringify({
      binary: stableOverrideBinary,
      source: SOURCE_CHROME_STABLE,
      version: '151.0.0.0',
    }), 'utf8');
    const stableOverrideManager = new BrowserKernelManager(stableOverrideUserData, { resourceRoot: cftResourceRoot });
    await stableOverrideManager.loadMeta();
    assert.strictEqual(stableOverrideManager.status().kernel.source, SOURCE_CHROME_STABLE);
    assert.strictEqual(path.resolve(stableOverrideManager.status().kernel.path), path.resolve(stableOverrideBinary));
    console.log('  PASS  user-downloaded Chrome Stable overrides a legacy bundled CFT kernel');

    const downloadManager = new BrowserKernelManager(path.join(root, 'download-user-data'));
    if ((process.platform === 'linux' || process.platform === 'win32') && process.arch === 'x64') {
      const release = await downloadManager.fetchFingerprintChromiumRelease();
      assert.strictEqual(release.version, PINNED_FINGERPRINT_CHROMIUM_RELEASE.version);
      assert.ok(PINNED_FINGERPRINT_CHROMIUM_RELEASE.assets.some((asset) => asset.digest === release.asset.digest));
    }
    let requestedRelease = null;
    downloadManager.fetchFingerprintChromiumRelease = async () => ({
      version: '148.0.7778.215',
      source: SOURCE_FINGERPRINT_CHROMIUM,
      platform: 'linux-x64',
      asset: { name: 'fingerprint.tar.xz', url: 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/fingerprint.tar.xz', digest: 'sha256:' + 'a'.repeat(64), size: 1 },
    });
    downloadManager.installFingerprintChromium = async (release) => {
      requestedRelease = release;
      return { name: 'Fingerprint Chromium', path: 'downloaded-fingerprint-chromium', version: '148.0.7778.215', source: SOURCE_FINGERPRINT_CHROMIUM, nativeFingerprint: true, independent: true };
    };
    const downloaded = await downloadManager.ensureIntegrated();
    assert.strictEqual(requestedRelease.source, SOURCE_FINGERPRINT_CHROMIUM);
    assert.strictEqual(downloaded.version, '148.0.7778.215');
    console.log('  PASS  missing kernel dispatches to Fingerprint Chromium');

    let forcedFingerprintDownload = false;
    manager.fetchFingerprintChromiumRelease = async () => ({
      version: '148.0.7778.215',
      source: SOURCE_FINGERPRINT_CHROMIUM,
      platform: 'linux-x64',
      asset: { name: 'fingerprint.tar.xz', url: 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/fingerprint.tar.xz', digest: 'sha256:' + 'b'.repeat(64), size: 1 },
    });
    manager.installFingerprintChromium = async () => {
      forcedFingerprintDownload = true;
      return { name: 'Fingerprint Chromium', path: 'fingerprint-chrome', version: '148.0.7778.215', source: SOURCE_FINGERPRINT_CHROMIUM, nativeFingerprint: true, independent: true };
    };
    await manager.ensureIntegrated(true);
    assert.strictEqual(forcedFingerprintDownload, true);
    console.log('  PASS  forced kernel download replaces the legacy Chrome for Testing package');

    assert.throws(() => validateArchiveMemberName('../outside/chrome'));
    assert.throws(() => validateArchiveMemberName('/tmp/chrome'));
    assert.throws(() => validateArchiveMemberName('C:\\Windows\\chrome.exe'));
    assert.throws(() => validateArchiveMemberName('chrome.exe:payload'));
    assert.throws(() => validateArchiveMemberName('NUL.txt'));
    assert.strictEqual(validateArchiveMemberName('chrome dir/chrome'), 'chrome dir/chrome');
    console.log('  PASS  kernel archive path traversal rejected');

    const existingArchive = path.join(root, 'kernels', 'existing-wayfern.zip');
    await fsp.mkdir(path.dirname(existingArchive), { recursive: true });
    await fsp.writeFile(existingArchive, 'stale archive', 'utf8');
    const originalGet = https.get;
    https.get = (_url, _options, callback) => {
      const req = new EventEmitter();
      req.destroy = (error) => { if (error) req.emit('error', error); };
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = { 'content-length': '11' };
        callback(res);
        res.end(Buffer.from('fresh bytes'));
      });
      return req;
    };
    try {
      await withoutProxyEnvironment(() => downloadFile('https://download.wayfern.com/test/wayfern.zip', existingArchive));
    } finally {
      https.get = originalGet;
    }
    assert.strictEqual(await fsp.readFile(existingArchive, 'utf8'), 'fresh bytes');
    console.log('  PASS  kernel download overwrites stale archive files');

    const httpsTarget = new URL('https://download.wayfern.com/kernel.zip');
    assert.strictEqual(proxyForUrl(httpsTarget, { HTTPS_PROXY: 'http://127.0.0.1:7890' }).port, '7890');
    assert.strictEqual(proxyForUrl(httpsTarget, { https_proxy: '127.0.0.1:7891' }).hostname, '127.0.0.1');
    assert.strictEqual(proxyForUrl(httpsTarget, { ALL_PROXY: 'http://127.0.0.1:7892' }).port, '7892');
    assert.strictEqual(proxyForUrl(httpsTarget, {
      OPENBROWSER_KERNEL_PROXY: 'http://127.0.0.1:7893',
      HTTPS_PROXY: 'http://127.0.0.1:7894',
    }).port, '7893');
    assert.strictEqual(proxyForUrl(httpsTarget, {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '.wayfern.com',
    }), null);
    assert.throws(
      () => proxyForUrl(httpsTarget, { HTTPS_PROXY: 'socks5://127.0.0.1:7890' }),
      /must be an HTTP or HTTPS forward proxy/,
    );
    console.log('  PASS  kernel proxy environment precedence and NO_PROXY');

    const proxySeen = [];
    const httpProxy = http.createServer((req, res) => {
      proxySeen.push({ url: req.url, authorization: req.headers['proxy-authorization'] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '16' });
      res.end('{"proxied":true}');
    });
    const httpProxyPort = await listen(httpProxy);
    try {
      const response = await requestUrl('http://download.wayfern.com/proxy-test.json', {
        env: { HTTP_PROXY: `http://kernel:secret@127.0.0.1:${httpProxyPort}` },
        timeout: 2000,
      });
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(await responseBody(response), '{"proxied":true}');
      assert.strictEqual(proxySeen[0].url, 'http://download.wayfern.com/proxy-test.json');
      assert.strictEqual(proxySeen[0].authorization, 'Basic ' + Buffer.from('kernel:secret').toString('base64'));
    } finally {
      await closeServer(httpProxy);
    }
    console.log('  PASS  HTTP download requests use the configured proxy');

    let connectSeen = null;
    const connectProxy = http.createServer();
    connectProxy.on('connect', (req, socket) => {
      connectSeen = { authority: req.url, authorization: req.headers['proxy-authorization'] };
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    const connectProxyPort = await listen(connectProxy);
    try {
      await assert.rejects(
        requestUrl('https://download.wayfern.com/kernel.zip', {
          env: { HTTPS_PROXY: `http://tunnel:pass@127.0.0.1:${connectProxyPort}` },
          timeout: 2000,
        }),
        /Proxy CONNECT failed.*502/,
      );
      assert.strictEqual(connectSeen.authority, 'download.wayfern.com:443');
      assert.strictEqual(connectSeen.authorization, 'Basic ' + Buffer.from('tunnel:pass').toString('base64'));
    } finally {
      await closeServer(connectProxy);
    }
    console.log('  PASS  HTTPS downloads use authenticated CONNECT tunnels');

    if (process.platform !== 'win32') {
      const link = path.join(root, 'kernels', 'chrome-for-testing', 'linked-chrome');
      await fsp.symlink(binary, link);
      assert.strictEqual(safeInstalledBinary(link, path.join(root, 'kernels')), null);
      console.log('  PASS  linked kernel binary rejected');
    }

    const nativeRoot = path.join(root, 'native-fingerprint-user-data');
    const nativeBinary = path.join(nativeRoot, 'custom-fingerprint-chromium');
    await fsp.mkdir(path.join(nativeRoot, 'kernels'), { recursive: true });
    await fsp.writeFile(nativeBinary, '', 'utf8');
    await fsp.writeFile(path.join(nativeRoot, 'kernels', 'kernel-meta.json'), JSON.stringify({
      binary: nativeBinary,
      source: SOURCE_CUSTOM,
      version: '148.0.7778.215',
      nativeFingerprint: true,
    }), 'utf8');
    const nativeManager = new BrowserKernelManager(nativeRoot);
    await nativeManager.loadMeta();
    assert.strictEqual(nativeManager.status().kernel.source, SOURCE_CUSTOM);
    assert.strictEqual(nativeManager.status().kernel.nativeFingerprint, true);
    console.log('  PASS  custom kernel native fingerprint capability survives discovery');

    // Platform gate: openbrowser-148 is macOS x86_64 only
    assert.strictEqual(isOpenBrowser148SupportedHost('darwin', 'x64'), true);
    assert.strictEqual(isOpenBrowser148SupportedHost('darwin', 'x86_64'), true);
    assert.strictEqual(isOpenBrowser148SupportedHost('darwin', 'arm64'), false);
    assert.strictEqual(isOpenBrowser148SupportedHost('win32', 'x64'), false);
    assert.strictEqual(isOpenBrowser148SupportedHost('win32', 'x86_64'), false);
    assert.strictEqual(isOpenBrowser148SupportedHost('linux', 'x64'), false);
    assert.strictEqual(isMacX64Host(), process.platform === 'darwin' && process.arch === 'x64');
    console.log('  PASS  openbrowser-148 supported only on macOS x86_64');

    const windowsCandidates = systemBrowserCandidatesForPlatform('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      PROGRAMW6432: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    });
    assert.ok(windowsCandidates.some((item) => item.name === 'Google Chrome' && item.path === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Google Chrome' && item.path === 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Google Chrome' && item.path === 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Microsoft Edge' && item.path === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Microsoft Edge' && item.path === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Microsoft Edge' && item.path === 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));
    assert.ok(windowsCandidates.every((item) => item.name === 'Google Chrome' || item.name === 'Microsoft Edge'));
    console.log('  PASS  Windows system-browser choices include Chrome and Edge install locations');

    // Source-tree discovery: Browserapp/kernels/macos-x64 (or compat openbrowser/)
    const appRoot = path.join(__dirname, '..');
    const repoKernel = findOpenBrowserKernelBinary(path.join(root, 'kernels'), [appRoot, path.join(appRoot, 'kernels')]);
    if (!isOpenBrowser148SupportedHost()) {
      assert.strictEqual(repoKernel, null);
      console.log('  PASS  non-mac-x64 host never discovers openbrowser-148');
    } else if (repoKernel) {
      assert.ok(fs.existsSync(repoKernel));
      const norm = String(repoKernel);
      assert.ok(
        norm.includes(`${path.sep}kernels${path.sep}macos-x64${path.sep}`)
        || norm.includes(`${path.sep}kernels${path.sep}openbrowser${path.sep}`),
        `unexpected kernel path: ${norm}`
      );
      console.log('  PASS  source-tree OpenBrowser 148 binary discovered');
    } else {
      console.log('  SKIP  source-tree OpenBrowser 148 not present');
    }

    // Stale meta pointing at openbrowser-148 must not win on non-mac-x64 hosts.
    if (!isOpenBrowser148SupportedHost()) {
      const fakeBin = path.join(root, 'kernels', 'openbrowser', 'fake-openbrowser');
      await fsp.mkdir(path.dirname(fakeBin), { recursive: true });
      await fsp.writeFile(fakeBin, '', 'utf8');
      await fsp.writeFile(path.join(root, 'kernels', 'kernel-meta.json'), JSON.stringify({
        binary: fakeBin,
        source: SOURCE_OPENBROWSER,
        version: '148.0.0.0',
      }), 'utf8');
      const mgr = new BrowserKernelManager(root);
      await mgr.loadMeta();
      const st = mgr.status();
      assert.notStrictEqual(st.kernel && st.kernel.source, SOURCE_OPENBROWSER);
      assert.strictEqual(st.kernel.path, binary);
      console.log('  PASS  non-mac-x64 rejects stale openbrowser-148 meta');
    }

    const app = { getPath: (name) => name === 'userData' ? root : '' };
    await fsp.writeFile(path.join(root, 'openbrowser-engine.json'), JSON.stringify({
      kernelPolicyVersion: 1,
      preferIndependentKernel: true,
      allowSystemBrowserFallback: true,
    }), 'utf8');
    const engine = new BrowserEngine(app);
    await engine.init(null);
    assert.strictEqual(engine.allowSystemBrowserFallback, false);
    assert.strictEqual(engine.browserSelection().mode, 'independent');
    const chosen = engine.chooseBrowser();
    // Prefer integrated product kernels over temporary Chrome-for-Testing fixtures.
    if (repoKernel && isOpenBrowser148SupportedHost()) {
      assert.strictEqual(chosen.path, path.resolve(repoKernel));
      assert.strictEqual(chosen.source, SOURCE_OPENBROWSER);
      console.log('  PASS  engine prefers source OpenBrowser 148 on mac x64');
    } else {
      assert.notStrictEqual(chosen.source, SOURCE_OPENBROWSER);
      const appRoot = path.join(__dirname, '..');
      const integrated = findBundledWayfernKernel([appRoot, path.join(appRoot, 'kernels')]);
      const integratedStable = findBundledChromeStable([appRoot, path.join(appRoot, 'kernels')]);
      const integratedCft = findBundledChromeForTesting([appRoot, path.join(appRoot, 'kernels')]);
      if (integrated && integrated.binary && isIntegratedKernelCdpReady({ path: integrated.binary, source: SOURCE_WAYFERN })) {
        assert.strictEqual(path.resolve(chosen.path), path.resolve(integrated.binary));
        assert.strictEqual(chosen.source, SOURCE_WAYFERN);
        console.log('  PASS  engine prefers integrated independent kernel over temporary CfT');
      } else if (integratedStable && integratedStable.binary) {
        assert.strictEqual(path.resolve(chosen.path), path.resolve(integratedStable.binary));
        assert.strictEqual(chosen.source, SOURCE_CHROME_STABLE);
        console.log('  PASS  engine prefers integrated Chrome Stable over temporary CfT');
      } else if (integratedCft && integratedCft.binary) {
        assert.strictEqual(path.resolve(chosen.path), path.resolve(integratedCft.binary));
        assert.strictEqual(chosen.source, SOURCE_CFT);
        console.log('  PASS  engine prefers integrated Chrome for Testing over temporary CfT');
      } else {
        assert.strictEqual(chosen.path, binary);
        console.log('  PASS  legacy fallback policy migrates to independent-only');
      }
    }

    await engine.setKernelPolicy({ allowSystemBrowserFallback: true });
    assert.strictEqual(engine.allowSystemBrowserFallback, true);
    assert.strictEqual(engine.systemBrowserPath, null);
    const resolveInstalled = engine.kernelManager.resolveInstalled;
    engine.kernelManager.resolveInstalled = () => null;
    assert.strictEqual(engine.browserSelection().mode, 'blocked');
    const manualBrowser = path.join(root, 'manual-system-browser');
    await fsp.writeFile(manualBrowser, '', 'utf8');
    engine.systemBrowserCandidates = () => [{ name: 'Test system browser', path: manualBrowser }];
    await engine.setKernelPolicy({ systemBrowserPath: manualBrowser });
    assert.strictEqual(engine.browserSelection().mode, 'system-manual');
    assert.strictEqual(engine.browserSelection().browser.path, manualBrowser);
    engine.kernelManager.resolveInstalled = resolveInstalled;
    const reloaded = new BrowserEngine(app);
    await reloaded.init(null);
    assert.strictEqual(reloaded.allowSystemBrowserFallback, true);
    console.log('  PASS  system-browser fallback requires explicit manual selection');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
