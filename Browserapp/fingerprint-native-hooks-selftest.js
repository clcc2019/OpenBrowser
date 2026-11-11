'use strict';

// Anti-detection: the spoofing hooks must not look spoofed.
//
// Detectors do not just read navigator.platform — they read the accessor behind it:
//   Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform').get.toString()
// Real Chrome answers with native-code source and a "get platform" name. An arrow function
// installed by a patcher answers with its own source, which both flags the browser as
// instrumented and can leak internal variable names.
//
// This runs the REAL injection script (buildInjectionScript) inside a VM with a minimal DOM
// and asserts the installed accessors are indistinguishable from native ones.

const vm = require('vm');
const assert = require('assert');
const { buildFingerprint, hostConsistentProfile, buildInjectionScript, buildWorkerInjectionScript } = require('./automation/fingerprint');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

const NATIVE = /^function get [A-Za-z_$][\w$]*\(\) \{\s*\[native code\]\s*\}$/;

/** Minimal DOM surface: enough for the injection script to install its hooks. */
function makeDomContext(metrics = {}) {
  function Navigator() {}
  function Screen() {}
  for (const [key, value] of Object.entries({ width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 })) {
    Object.defineProperty(Screen.prototype, key, { configurable: true, get: () => value });
  }
  const navigator = Object.create(Navigator.prototype);
  const screen = Object.create(Screen.prototype);
  const win = {
    Navigator, Screen, navigator, screen,
    devicePixelRatio: 1, screenX: 0, screenY: 0,
    document: { createElement: () => ({ getContext: () => null }), getOwnPropertyNames: [] },
    location: { href: 'https://example.com/', hostname: 'example.com' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    Intl, Date, Math, JSON, Object, Function, Array, String, Number, Boolean,
    Promise, WeakMap, Map, Set, Symbol, Reflect, Proxy, Error, TypeError, RangeError,
    DOMException: function DOMException(m) { this.message = m; },
augment: null,
  };
  // Real Chrome exposes the viewport metrics as accessors rather than data
  // properties, so the stub must do the same for the raw-getter capture to run.
  for (const [key, value] of Object.entries({
    innerWidth: metrics.innerWidth ?? 1280,
    innerHeight: metrics.innerHeight ?? 800,
    outerWidth: metrics.outerWidth ?? 1280,
    outerHeight: metrics.outerHeight ?? 800,
  })) {
    Object.defineProperty(win, key, { configurable: true, get: () => value });
  }
  win.window = win;
  win.globalThis = win;
  win.self = win;
  win.top = win;
  return win;
}

const fp = buildFingerprint({
  id: 'hooks-test',
  privacy: { canvas: 'noise', webgl: 'noise', audio: 'noise' },
  advanced: {},
});

// --- page injection: navigator + screen accessors ---
{
  const ctx = vm.createContext(makeDomContext());
  let ran = true;
  try {
    vm.runInContext(buildInjectionScript(fp), ctx, { timeout: 10000 });
  } catch (error) {
    ran = false;
    console.log('     (injection threw in the stub DOM: ' + error.message + ')');
  }
  ok('page injection script executes', ran);

  const probe = (target, key) => vm.runInContext(
    `(() => { const d = Object.getOwnPropertyDescriptor(${target}, ${JSON.stringify(key)});
      return d && typeof d.get === 'function' ? { src: Function.prototype.toString.call(d.get), name: d.get.name } : null; })()`,
    ctx,
  );

  for (const key of ['platform', 'vendor', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver']) {
    const got = probe('Navigator.prototype', key);
    if (!got) { console.log(`     (no accessor installed for navigator.${key}; skipped)`); continue; }
    ok(`navigator.${key} getter stringifies as native`, NATIVE.test(got.src));
    ok(`navigator.${key} getter is named "get ${key}"`, got.name === 'get ' + key);
  }
  ok('navigator has no own webdriver property', !vm.runInContext("Object.prototype.hasOwnProperty.call(navigator, 'webdriver')", ctx));
  ok('inherited webdriver remains false', vm.runInContext('navigator.webdriver === false', ctx));

  for (const key of ['width', 'height', 'colorDepth']) {
    const got = probe('Screen.prototype', key);
    if (!got) { console.log(`     (no accessor installed for screen.${key}; skipped)`); continue; }
    ok(`screen.${key} getter stringifies as native`, NATIVE.test(got.src));
  }

  // The descriptor a detector reads through the navigator Proxy must be disguised too.
  const viaProxy = probe('navigator', 'platform');
  if (viaProxy) {
    ok('navigator proxy descriptor getter stringifies as native', NATIVE.test(viaProxy.src));
    ok('navigator proxy descriptor leaks no internals', !/navPatch|CFG/.test(viaProxy.src));
  }
}

// --- host consistency must keep native screen metrics untouched ---
{
  const hostFp = buildFingerprint(hostConsistentProfile({ id: 'host-hooks', privacy: { matchHostOs: true } }));
  const ctx = vm.createContext(makeDomContext());
  vm.runInContext(buildInjectionScript(hostFp), ctx, { timeout: 10000 });
  const screen = vm.runInContext('({ width: screen.width, colorDepth: screen.colorDepth })', ctx);
  ok('native-host mode keeps the real screen dimensions', screen.width === 1920 && screen.colorDepth === 24);
}

// --- window geometry: outer metrics must describe the launched 740×600 window ---
{
  // Kernels may pin outerWidth/outerHeight to the fingerprint screen size. Inside a
  // compact environment that must not leak a 1920×1080 outer window; the injected
  // launch geometry keeps outer metrics consistent with --window-size.
  const ctx = vm.createContext(makeDomContext({ innerWidth: 740, innerHeight: 520, outerWidth: 1920, outerHeight: 1080 }));
  let ran = true;
  try { vm.runInContext(buildInjectionScript(fp), ctx, { timeout: 10000 }); }
  catch (error) { ran = false; console.log('     (injection threw in the window stub: ' + error.message + ')'); }
  ok('page injection executes with compact window metrics', ran);

  const size = vm.runInContext('({ innerWidth, innerHeight, outerWidth, outerHeight })', ctx);
  ok('outerWidth reports the 740px launch window, not the fingerprint screen', size.outerWidth === 740);
  ok('outerHeight reports the 600px launch window, not the fingerprint screen', size.outerHeight === 600);
  ok('outer window contains the live viewport', size.outerWidth >= size.innerWidth && size.outerHeight >= size.innerHeight);

  // A window the user resized must keep reporting its real outer size.
  const resizedCtx = vm.createContext(makeDomContext({ innerWidth: 1300, innerHeight: 813, outerWidth: 1320, outerHeight: 900 }));
  vm.runInContext(buildInjectionScript(fp), resizedCtx, { timeout: 10000 });
  const resized = vm.runInContext('({ innerWidth, innerHeight, outerWidth, outerHeight })', resizedCtx);
  ok('outer metrics track a resized window', resized.outerWidth === 1320 && resized.outerHeight === 900);
}

// --- worker injection: WorkerNavigator accessors ---
{
  const ctx = vm.createContext((() => {
    function WorkerNavigator() {}
    const navigator = Object.create(WorkerNavigator.prototype);
    const scope = {
      WorkerNavigator, navigator,
      Object, Function, Array, String, Number, Boolean, Math, JSON, Date, Intl,
      Promise, WeakMap, Map, Set, Symbol, Reflect, Proxy, Error, TypeError,
      addEventListener() {}, removeEventListener() {},
    };
    scope.self = scope; scope.globalThis = scope;
    return scope;
  })());
  let ran = true;
  try { vm.runInContext(buildWorkerInjectionScript(fp), ctx, { timeout: 10000 }); }
  catch (error) { ran = false; console.log('     (worker injection threw: ' + error.message + ')'); }
  ok('worker injection script executes', ran);

  const got = vm.runInContext(
    `(() => { const d = Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'platform');
      return d && typeof d.get === 'function' ? { src: Function.prototype.toString.call(d.get), name: d.get.name } : null; })()`,
    ctx,
  );
  if (got) {
    ok('worker navigator.platform getter stringifies as native', NATIVE.test(got.src));
    ok('worker navigator.platform getter is named "get platform"', got.name === 'get platform');
  } else {
    console.log('     (worker accessor not installed in stub scope; skipped)');
  }
}

console.log(`\nfingerprint-native-hooks-selftest: ${passed} checks passed.`);
