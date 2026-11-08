'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildFingerprint } = require('./automation/fingerprint');

const source = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const helper = source.slice(source.indexOf('function editorFingerprintForDraft('), source.indexOf('function editorDraft('));
const start = source.indexOf("document.getElementById('editor-os')?.addEventListener('change'");
const end = source.indexOf('\n});', start) + 4;
assert(start >= 0 && end > start, 'OS change handler must exist');
const fields = { '#editor-user-agent': 'Windows UA', '#editor-ua-chrome-major': '156' };
let onChange;
const context = vm.createContext({
  editorUaEdited: false, editorUaResetPlatform: false, editorUaChromeMajorTouched: true, editorGeneratedUaMetadata: null,
  DEFAULT_CHROME_MAJOR: 157,
  kernelChromeMajor: 156,
  editorSet: (key, value) => { fields[key] = value; },
  document: { getElementById: () => ({ addEventListener: (_type, fn) => { onChange = fn; } }) },
  markEditorDirty() {}, refreshUaMetaPreview: async () => {}, renderEditorSummary() {},
});
vm.runInContext(helper + '\n' + source.slice(start, end), context);
const winUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const current = { id: 'ua-editor', os: 'Windows', userAgent: winUA, privacy: { fingerprint: { userAgent: winUA, os: 'windows', clientHints: { platform: 'Windows' }, canvas: 'noise' } } };
context.current = current;
assert.strictEqual(vm.runInContext('editorFingerprintForDraft(current).userAgent', context), winUA, 'unchanged custom UA is retained');
onChange();
assert.strictEqual(fields['#editor-user-agent'], '');
assert.strictEqual(context.editorUaEdited, true);
assert.strictEqual(context.editorUaResetPlatform, true);
const fp = vm.runInContext('editorFingerprintForDraft(current)', context);
assert.strictEqual(fp.userAgent, undefined);
assert.strictEqual(fp.os, undefined);
assert.strictEqual(fp.clientHints, undefined);
assert.strictEqual(fp.canvas, 'noise');
for (const [os, token] of [['macOS', 'Macintosh'], ['Linux', 'Linux'], ['Windows', 'Windows NT']]) {
  const result = buildFingerprint({ ...current, os, userAgent: '', privacy: { fingerprint: fp } });
  assert(result.userAgent.includes(token), `${os} should produce a matching UA`);
}
console.log('UA platform switch checks passed');
