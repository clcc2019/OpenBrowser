'use strict';

const assert = require('assert');
const vm = require('vm');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { buildFingerprint, buildInjectionScript, buildWorkerInjectionScript } = require('./automation/fingerprint');
const { mapFingerprintToInitFields, writeOpenBrowserKernelInit } = require('./automation/kernel-init-sync');

async function probe(mode, worker) {
  const context = vm.createContext({ console, URL, DOMException });
  vm.runInContext(`
    class NavigatorBase {}
    class Screen {}
    const gpu = { async requestAdapter() { return { info: { vendor: 'host-vendor', architecture: 'host-arch', device: 'host-device', description: 'host' }, async requestAdapterInfo() { return this.info; } }; } };
    Object.defineProperty(NavigatorBase.prototype, 'gpu', { configurable: true, get() { return gpu; } });
    globalThis.${worker ? 'WorkerNavigator' : 'Navigator'} = NavigatorBase;
    globalThis.navigator = new NavigatorBase();
    globalThis.Screen = Screen;
    globalThis.screen = new Screen();
    globalThis.window = globalThis; globalThis.self = globalThis; globalThis.top = globalThis;
    globalThis.location = { href: 'https://example.com/', hostname: 'example.com' };
    globalThis.document = { createElement() { return { getContext() { return null; } }; } };
    globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  `, context);
  const fp = buildFingerprint({ id: 'gpu-modes', os: 'macOS', privacy: { webgpu: mode, deviceProfile: 'persona', personaVersion: 5 } });
  vm.runInContext(worker ? buildWorkerInjectionScript(fp) : buildInjectionScript(fp), context);
  const result = await vm.runInContext('(async () => { const adapter = await navigator.gpu.requestAdapter(); return adapter ? { info: adapter.info, legacy: await adapter.requestAdapterInfo() } : null; })()', context);
  if (mode === 'blocked') assert.strictEqual(result, null);
  else if (mode === 'real') assert.strictEqual(result.info.vendor, 'host-vendor');
  else {
    assert.strictEqual(result.info.vendor, fp.webgpu.gpu.vendor);
    assert.strictEqual(result.info.architecture, fp.webgpu.gpu.architecture);
    assert.strictEqual(result.legacy.vendor, fp.webgpu.gpu.vendor);
  }
}

(async () => {
  for (const worker of [false, true]) for (const mode of ['real', 'blocked', 'webgl']) await probe(mode, worker);
  const fp = buildFingerprint({ id: 'native-mapping', privacy: { fingerprint: { memory: 0.5 }, webrtc: 'real' }, exitIp: '192.0.2.1' });
  const fields = mapFingerprintToInitFields(fp, {});
  assert.strictEqual(fields.deviceMemory, 0.5);
  assert.strictEqual(fields.webrtc_fake_ip, '');
  assert.strictEqual(fields.webrtc_local_ip, '');
  const proxy = mapFingerprintToInitFields({ ...fp, webrtc: 'proxy', webrtcAddress: null, webrtcLocalIp: null, dynamicConfig: {}, staticConfig: {} }, {});
  assert.strictEqual(proxy.webrtc_fake_ip, '');
  assert.strictEqual(proxy.webrtc_local_ip, '');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-fingerprint-'));
  try {
    const profile = { id: 'native-mode-test', privacy: {} };
    const spoofed = buildFingerprint({ ...profile, privacy: { webgpu: 'webgl' } });
    const written = await writeOpenBrowserKernelInit(root, { fingerprint: spoofed, profile });
    assert(written.init.webgpu_parameter);
    for (const mode of ['real', 'blocked']) {
      const next = await writeOpenBrowserKernelInit(root, { fingerprint: { ...spoofed, webgpu: { ...spoofed.webgpu, mode } }, profile });
      assert(!Object.hasOwn(next.init, 'webgpu_parameter'), `${mode} must clear stale native GPU spoof`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log('WebGPU and native fingerprint mapping checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
