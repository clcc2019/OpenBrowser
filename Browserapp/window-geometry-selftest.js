'use strict';

/**
 * Window geometry selftest.
 *
 * Every launched environment must really be 740×600: the launch flag, the CDP
 * startup enforcement and the page-visible outerWidth/outerHeight all have to
 * agree on one geometry. No browser process required.
 *
 *   node window-geometry-selftest.js
 */

const assert = require('assert');
const { BrowserEngine } = require('./engine');
const cdp = require('./cdp');
const { LAUNCH_WINDOW_SIZE, buildFingerprint, buildInjectionScript, chromeArgsForFingerprint } = require('./automation/fingerprint');

function pass(name) { console.log('  PASS  ' + name); }

async function main() {
  console.log('Window geometry selftest\n');

  assert.deepStrictEqual({ ...LAUNCH_WINDOW_SIZE }, { width: 740, height: 600 }, 'launch geometry is 740×600');
  pass('launch geometry constant');

  const fp = buildFingerprint({ id: 'window-geometry', width: 1600, height: 1000, privacy: {} });
  const args = chromeArgsForFingerprint(fp, { privacy: {} });
  assert.ok(args.includes('--window-size=740,600'), 'launch flag pins every window to 740×600');
  assert.ok(buildInjectionScript(fp).includes('"windowSize":{"width":740,"height":600}'), 'injected config carries the launch geometry');
  pass('launch flag and injected config share one geometry');

  const engine = Object.create(BrowserEngine.prototype);
  const originalWindowForPort = cdp.windowForPort;
  const originalSetWindowBounds = cdp.setWindowBounds;
  const calls = [];
  try {
    cdp.windowForPort = async () => ({ bounds: { left: 120, top: 64, width: 1600, height: 950, windowState: 'normal' } });
    cdp.setWindowBounds = async (port, bounds) => { calls.push({ port, bounds }); return { windowId: 1, bounds }; };
    await engine.applyLaunchWindowBounds(9222);
    assert.deepStrictEqual(calls[0], {
      port: 9222,
      bounds: { left: 120, top: 64, width: 740, height: 600 },
    }, 'restored large bounds are normalized while the window position is preserved');
    pass('startup enforcement normalizes a restored window');

    calls.length = 0;
    cdp.windowForPort = async () => ({ bounds: { left: 120, top: 64, width: 740, height: 600, windowState: 'normal' } });
    await engine.applyLaunchWindowBounds(9222);
    assert.strictEqual(calls.length, 0, 'an already unified normal window is left untouched');
    pass('startup enforcement skips an already unified window');

    cdp.windowForPort = async () => ({ bounds: { left: 0, top: 0, width: 740, height: 600, windowState: 'maximized' } });
    await engine.applyLaunchWindowBounds(9222);
    assert.strictEqual(calls.length, 1, 'a maximized window is restored to the unified geometry');
    pass('startup enforcement exits a maximized state');
  } finally {
    cdp.windowForPort = originalWindowForPort;
    cdp.setWindowBounds = originalSetWindowBounds;
  }

  console.log('\nwindow-geometry-selftest: all checks passed');
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});
