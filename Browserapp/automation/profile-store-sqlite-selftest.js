'use strict';
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BrowserEngine } = require('../engine');
const cloud = require('./cloud-sync');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-sqlite-'));
  const oldKey = process.env.OPENBROWSER_CREDENTIAL_KEY_FILE;
  process.env.OPENBROWSER_CREDENTIAL_KEY_FILE = path.join(root, 'key');
  const app = { getPath: () => root };
  let first, second;
  try {
    const legacy = { profiles: [{ id: 'legacy', name: 'Legacy', networkMode: 'proxy', proxy: 'http://user:secret@localhost:8080' }], extensions: [], assignments: {}, kernelPolicyVersion: 4 };
    const legacyFile = path.join(root, 'openbrowser-engine.json');
    await fs.writeFile(legacyFile, JSON.stringify(legacy));
    first = new BrowserEngine(app, { stateBackend: 'sqlite' });
    await first.init();
    assert.equal(first.profiles.get('legacy').proxy, legacy.profiles[0].proxy);
    assert.deepEqual(JSON.parse(await fs.readFile(legacyFile, 'utf8')), legacy);
    first.profiles.set('next', first.sanitizeProfile({ id: 'next', name: 'Next' }));
    await first.persist();
    first.sqliteState.close();
    first.sqliteState = null;
    const data = await fs.readFile(path.join(root, 'openbrowser-state-v1.db'));
    assert.ok(!data.includes(Buffer.from('secret')));
    second = new BrowserEngine(app, { stateBackend: 'sqlite' });
    await second.init();
    assert.equal(second.profiles.get('legacy').proxy, legacy.profiles[0].proxy);
    assert.ok(second.profiles.has('next'));
    const backup = await cloud.buildBackupPackage({
      profiles: [...second.profiles.values()], groups: [{ id: 'group-1', name: 'Test' }],
      profileIds: [], includeBrowserData: false, passphrase: 'test-passphrase',
    });
    assert.ok(!backup.buffer.includes(Buffer.from('secret')));
    await assert.rejects(() => cloud.parseBackupPackage(backup.buffer, 'wrong'));
    const body = await cloud.parseBackupPackage(backup.buffer, 'test-passphrase');
    assert.equal(body.profiles.find(p => p.id === 'legacy').proxy, legacy.profiles[0].proxy);
    assert.equal(body.groups[0].name, 'Test');
    const restoreRoot = path.join(root, 'restore');
    await fs.mkdir(restoreRoot);
    const restored = new BrowserEngine({ getPath: () => restoreRoot }, { stateBackend: 'sqlite' });
    await restored.init();
    await restored.syncProfiles(cloud.mergeProfiles([], body.profiles, 'merge').profiles);
    restored.sqliteState.close();
    restored.sqliteState = null;
    const reopened = new BrowserEngine({ getPath: () => restoreRoot }, { stateBackend: 'sqlite' });
    await reopened.init();
    assert.equal(reopened.profiles.get('legacy').proxy, legacy.profiles[0].proxy);
    assert.ok(reopened.profiles.has('next'));
    reopened.sqliteState.close();
    reopened.sqliteState = null;
    const saved = second.sqliteState.read();
    assert.throws(() => second.sqliteState.write({ profiles: 'bad' }));
    assert.deepEqual(second.sqliteState.read(), saved);
    second.sqliteState.close();
    second.sqliteState = null;
    process.env.OPENBROWSER_CREDENTIAL_KEY_FILE = path.join(root, 'missing-key');
    await assert.rejects(new BrowserEngine(app, { stateBackend: 'sqlite' }).init());
    assert.deepEqual(JSON.parse(await fs.readFile(legacyFile, 'utf8')), legacy);
    console.log('profile-store-sqlite-selftest: ok');
  } finally {
    first?.sqliteState?.close(); second?.sqliteState?.close();
    if (oldKey === undefined) delete process.env.OPENBROWSER_CREDENTIAL_KEY_FILE;
    else process.env.OPENBROWSER_CREDENTIAL_KEY_FILE = oldKey;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
