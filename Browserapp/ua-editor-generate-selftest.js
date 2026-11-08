'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildFingerprint } = require('./automation/fingerprint');
const root = __dirname;
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const section = html.slice(html.indexOf('id="editor-panel-privacy"'), html.indexOf('id="editor-panel-privacy"') + 4500);
assert(section.includes('id="editor-os"'), 'platform selector must be visible next to UA controls');
assert.strictEqual((html.match(/id="editor-os"/g) || []).length, 1);

let handler;
const start = main.indexOf("registerTrustedIpc('automation:build-ua'");
const end = main.indexOf('\n  });', start) + 6;
assert(start >= 0 && end > start);
vm.runInNewContext(main.slice(start, end), { registerTrustedIpc: (_name, fn) => { handler = fn; }, require, engine: { kernelStatus: () => ({ kernel: { version: '157.0.0.0' } }) } });

const elements = {};
for (const id of ['editor-os', 'editor-user-agent', 'editor-ua-meta', 'editor-ua-chrome-major', 'editor-ua-generate', 'editor-ua-random', 'editor-ua-clear']) {
  elements[id] = { value: '', hidden: true, textContent: '', listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } };
}
elements['editor-ua-chrome-major'].value = '157';
const context = vm.createContext({
  document: { getElementById: id => elements[id] },
  $: selector => elements[selector.slice(1)],
  window: { ops: { buildUa: async payload => handler(null, payload) } },
  editorSet: (selector, value) => { elements[selector.slice(1)].value = value; },
  editorChromeMajor: () => 157,
  DEFAULT_CHROME_MAJOR: 157,
  editorUaChromeMajorTouched: false, editorUaEdited: false, editorUaResetPlatform: false, editorGeneratedUaMetadata: null,
  editorUaPreviewRequest: 0, editingProfileId: 'editor-test', kernelChromeMajor: 157,
  ui: { profiles: [] },
  tx: s => s, toast() {}, markEditorDirty() {}, renderEditorSummary() {},
  setTimeout, clearTimeout,
});
const from = source.indexOf('function editorOsToUaKey(');
const to = source.indexOf('function profileEngine(', from);
assert(from >= 0 && to > from);
const helper = source.slice(source.indexOf('function editorFingerprintForDraft('), source.indexOf('function editorDraft('));
vm.runInContext(helper + source.slice(from, to), context);

(async () => {
  for (const [os, platform, token] of [['macOS', 'macOS', 'Macintosh'], ['Linux', 'Linux', 'Linux'], ['Windows', 'Windows', 'Windows NT']]) {
    for (const button of ['editor-ua-generate', 'editor-ua-random']) {
      elements['editor-os'].value = os;
      await elements[button].listeners.click();
      assert(elements['editor-user-agent'].value.includes(token), `${button} UA for ${os}`);
      assert(elements['editor-ua-meta'].textContent.includes(`platform: ${platform} `), `${button} hints for ${os}`);
      assert.strictEqual(elements['editor-os'].value, os);
      const fingerprint = vm.runInContext('editorFingerprintForDraft({ privacy: {} })', context);
      const generated = buildFingerprint({ id: 'ua-save-check', os, userAgent: elements['editor-user-agent'].value, privacy: { fingerprint } });
      assert.strictEqual(generated.userAgentMetadata.platform, platform);
      assert.strictEqual(generated.userAgentMetadata.architecture, context.editorGeneratedUaMetadata.architecture, `${button} architecture should survive saving`);
      context.ui.profiles = [{ id: 'editor-test', privacy: { fingerprint } }];
      context.editorGeneratedUaMetadata = null;
      context.editorUaEdited = false;
      await vm.runInContext('refreshUaMetaPreview()', context);
      assert(elements['editor-ua-meta'].textContent.includes(`architecture: ${generated.userAgentMetadata.architecture} `), 'reopened preview must use saved architecture');
    }
  }
  let finish;
  context.window.ops.buildUa = () => new Promise(resolve => { finish = resolve; });
  elements['editor-os'].value = 'macOS';
  const pending = elements['editor-ua-random'].listeners.click();
  elements['editor-os'].value = 'Linux';
  elements['editor-os'].listeners.change();
  finish(handler(null, { os: 'macos', random: true, chromeMajor: 157 }));
  await pending;
  assert.strictEqual(elements['editor-os'].value, 'Linux', 'outdated UA result must not restore previous OS');
  assert.strictEqual(elements['editor-user-agent'].value, '', 'outdated UA result must not overwrite current input');
  console.log('UA editor generation checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
