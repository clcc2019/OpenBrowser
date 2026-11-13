'use strict';
const assert = require('assert');
const cdp = require('./cdp');
const { BrowserEngine } = require('./engine');
const { applyFingerprintToTab } = require('./automation/fingerprint');

async function runCase(mode) {
  const calls = [];
  let onEvent;
  const connection = {
    command: async (method) => {
      calls.push(method);
      if (method === 'Target.closeTarget') return { success: mode !== 'close-fails' };
      return {};
    },
    close() {},
  };
  cdp.browserSocket = async () => 'ws://test';
  cdp.connect = async (_url, options) => { onEvent = options.onEvent; return connection; };
  const engine = Object.create(BrowserEngine.prototype);
  engine.fingerprintAttachTimeoutMs = 20;
  engine.emit = () => {};
  engine.handleBrowserGone = async () => { calls.push('stop-browser'); };
  engine.applyFingerprintToSession = async () => {
    calls.push('inject');
    if (mode !== 'success') await new Promise(() => {});
  };
  const item = { port: 1, profile: { id: 'test' } };
  await engine.startWorkerFingerprintInjection(item, {});
  calls.length = 0;
  onEvent({ method: 'Target.attachedToTarget', params: {
    sessionId: 'session', waitingForDebugger: true, targetInfo: { type: 'page', targetId: 'target' },
  } }, connection);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(calls, mode === 'success'
    ? ['Target.setAutoAttach', 'inject', 'Runtime.runIfWaitingForDebugger']
    : mode === 'close-fails'
      ? ['Target.setAutoAttach', 'inject', 'Target.closeTarget', 'stop-browser']
      : ['Target.setAutoAttach', 'inject', 'Target.closeTarget']);
}

async function runWorkerFailure(waitingForDebugger, closeSucceeds) {
  const calls = [];
  let onEvent;
  const connection = {
    command: async (method) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') return { exceptionDetails: { text: 'failed' } };
      if (method === 'Target.closeTarget') return { success: closeSucceeds };
      return {};
    },
    close() {},
  };
  cdp.browserSocket = async () => 'ws://test';
  cdp.connect = async (_url, options) => { onEvent = options.onEvent; return connection; };
  const engine = Object.create(BrowserEngine.prototype);
  engine.emit = () => {};
  engine.handleBrowserGone = async () => { calls.push('stop-browser'); };
  await engine.startWorkerFingerprintInjection({ port: 1, profile: { id: 'test' } }, {});
  calls.length = 0;
  onEvent({ method: 'Target.attachedToTarget', params: {
    sessionId: 'worker', waitingForDebugger, targetInfo: { type: 'worker', targetId: 'target', url: 'https://example.test/worker.js' },
  } }, connection);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!calls.includes('Runtime.runIfWaitingForDebugger'));
  if (waitingForDebugger) assert.ok(calls.includes('Target.closeTarget'));
  assert.strictEqual(calls.includes('stop-browser'), !waitingForDebugger || !closeSucceeds);
}

async function main() {
  const originalSocket = cdp.browserSocket;
  const originalConnect = cdp.connect;
  try {
    for (const mode of ['success', 'timeout', 'close-fails']) await runCase(mode);
    await runWorkerFailure(true, true);
    await runWorkerFailure(true, false);
    await runWorkerFailure(false, false);
    await assert.rejects(applyFingerprintToTab(async (method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') throw new Error('registration failed');
      return {};
    }, null, {}, {}, { requireDocumentStart: true }), /Failed to register document-start/);
  } finally {
    cdp.browserSocket = originalSocket;
    cdp.connect = originalConnect;
  }
  console.log('fingerprint-target-selftest: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
