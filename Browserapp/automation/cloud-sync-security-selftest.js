'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const cloud = require('./cloud-sync');

async function main() {
  assert.throws(() => cloud.safeRemotePath('../outside.obpack'));
  assert.throws(() => cloud.safeRemotePath('/tmp/outside.obpack'));
  assert.throws(() => cloud.safeRemotePath('C:\\outside.obpack'));
  assert.strictEqual(cloud.safeRemotePath('profiles/env-1.obpack'), 'profiles/env-1.obpack');
  console.log('  PASS  remote backup path traversal rejected');

  assert.throws(() => cloud.webDavTarget({ url: 'http://example.com/dav', dir: 'OpenBrowser' }));
  assert.throws(() => cloud.webDavTarget({ url: 'https://example.com/dav', dir: '../outside' }));
  assert.ok(cloud.webDavTarget({ url: 'http://127.0.0.1:9000/dav', dir: 'OpenBrowser' }).target.startsWith('http://127.0.0.1:9000/'));
  console.log('  PASS  WebDAV requires HTTPS except loopback');

  assert.throws(() => cloud.validatedGitHubConfig({ owner: '../x', repo: 'repo', token: 't' }, cloud.REMOTE_NAME));
  assert.throws(() => cloud.validatedGitHubConfig({ owner: 'owner', repo: 'repo', token: 't', branch: '../main' }, cloud.REMOTE_NAME));
  console.log('  PASS  GitHub repository and branch validation');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-'));
  try {
    assert.throws(() => cloud.safeLocalTarget(root, '../../outside.obpack'));
    if (process.platform !== 'win32') {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-outside-'));
      const link = path.join(root, 'profiles');
      await fs.symlink(outside, link);
      await assert.rejects(() => cloud.upload('local', { dir: root }, Buffer.from('x'), 'profiles/env.obpack'));
      await fs.rm(outside, { recursive: true, force: true });
    }
    console.log('  PASS  local backup symlink escape rejected');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-data-'));
  try {
    const dir = path.join(dataRoot, 'env-1', 'Default', 'Network');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'Cookies');
    const profile = { id: 'env-1', advanced: { cloudBackup: true } };
    await fs.writeFile(file, 'cookies');
    const backup = await cloud.buildBackupPackage({ profiles: [profile], profileDataRoot: dataRoot });
    const body = await cloud.parseBackupPackage(backup.buffer);
    assert.strictEqual(Buffer.from(body.profiles[0]._dataFiles['Network/Cookies'], 'base64').toString(), 'cookies');
    const handle = await fs.open(file, 'w');
    try { await handle.truncate(25 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(
      () => cloud.buildBackupPackage({ profiles: [profile], profileDataRoot: dataRoot }),
      /浏览器数据文件超过备份单文件大小限制/,
    );
    console.log('  PASS  browser data is included or backup fails explicitly');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }

  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-large-'));
  try {
    const dataDir = path.join(localRoot, 'data', 'env-1', 'Default', 'Local Storage');
    await fs.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, 'large.log');
    const handle = await fs.open(file, 'w');
    try { await handle.truncate(81 * 1024 * 1024); } finally { await handle.close(); }
    const config = { dir: path.join(localRoot, 'backups') };
    const profile = { id: 'env-1', advanced: { cloudBackup: true, syncLocalStorage: true } };
    const backup = await cloud.localBackup(config, { profiles: [profile], profileDataRoot: path.join(localRoot, 'data'), includeBrowserData: true, passphrase: 'secret' });
    assert.strictEqual(backup.meta.profileCount, 1);
    await assert.rejects(() => cloud.downloadLocalBackup(config, cloud.REMOTE_NAME, 'wrong'));
    const body = await cloud.downloadLocalBackup(config, cloud.REMOTE_NAME, 'secret');
    const restoreRoot = path.join(localRoot, 'restored');
    await cloud.restoreProfileDataFiles(restoreRoot, body.profiles[0]._dataFiles, { unlimitedSize: true });
    assert.strictEqual((await fs.stat(path.join(restoreRoot, 'Default', 'Local Storage', 'large.log'))).size, 81 * 1024 * 1024);
    const plain = await cloud.localBackup(config, { profiles: [profile], includeBrowserData: false });
    assert.strictEqual((await cloud.downloadLocalBackup(config, cloud.REMOTE_NAME, '')).profiles.length, 1);
    assert.strictEqual((await cloud.parseBackupPackage(await fs.readFile(plain.result.path), '', { unlimitedSize: true })).profiles.length, 1);
    const legacy = await cloud.buildBackupPackage({ profiles: [profile], includeBrowserData: false });
    await fs.writeFile(plain.result.path, legacy.buffer);
    assert.strictEqual((await cloud.downloadLocalBackup(config, cloud.REMOTE_NAME, '')).profiles.length, 1);
    console.log('  PASS  encrypted local backup and restore over 80 MB');
  } finally {
    await fs.rm(localRoot, { recursive: true, force: true });
  }

  const splitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-split-'));
  try {
    const config = { dir: splitRoot };
    const profiles = ['one', 'two'].map((id) => ({ id, advanced: { cloudBackup: true } }));
    const options = { profiles, groups: [{ id: 'group' }], passphrase: 'secret' };
    const backup = await cloud.localBackupSet(config, options);
    assert.strictEqual(backup.result.files.length, 2);
    for (const [i, name] of backup.result.files.entries()) {
      const body = await cloud.downloadLocalBackup(config, name, 'secret');
      assert.deepStrictEqual(body.profiles.map((p) => p.id), [profiles[i].id]);
    }
    assert.deepStrictEqual((await cloud.downloadLocalBackupSet(config, 'secret')).profiles.map((p) => p.id), ['one', 'two']);
    await assert.rejects(() => cloud.downloadLocalBackupSet(config, 'wrong'));
    await cloud.localBackupSet(config, { ...options, profiles: [profiles[1]] });
    assert.deepStrictEqual((await cloud.downloadLocalBackupSet(config, 'secret')).profiles.map((p) => p.id), ['two']);
    await fs.rm(path.join(splitRoot, 'openbrowser-backup-index.json'));
    await cloud.localBackup(config, options);
    assert.strictEqual((await cloud.downloadLocalBackupSet(config, 'secret')).profiles.length, 2);
    console.log('  PASS  per-environment backup, latest snapshot, and legacy restore');
  } finally {
    await fs.rm(splitRoot, { recursive: true, force: true });
  }

  const binaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-binary-'));
  try {
    const data = crypto.randomBytes(1024 * 1024);
    const profile = { id: 'binary', advanced: { cloudBackup: true, syncLocalStorage: true } };
    const dataDir = path.join(binaryRoot, 'data', 'binary', 'Default', 'Local Storage');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'data.bin'), data);
    const config = { dir: path.join(binaryRoot, 'backups') };
    const backup = await cloud.localBackup(config, { profiles: [profile], profileDataRoot: path.join(binaryRoot, 'data'), includeBrowserData: true }, 'profiles/binary.obpack');
    const restored = await cloud.downloadLocalBackup(config, backup.result.remoteName, '');
    assert.deepStrictEqual(Buffer.concat(restored.profiles[0]._dataFiles['Local Storage/data.bin']), data);
    const records = [
      { type: 'header', body: { version: 2, profiles: [profile] } },
      { type: 'file', id: 'binary', name: 'Local Storage/data.bin' },
      ...Array.from({ length: 4 }, (_, i) => ({ type: 'chunk', data: data.subarray(i * 256 * 1024, (i + 1) * 256 * 1024).toString('base64') })),
      { type: 'end' },
    ].map((record) => JSON.stringify(record) + '\n').join('');
    const v2 = Buffer.concat([Buffer.from('OBP2'), zlib.gzipSync(records, { level: 9 })]);
    await fs.writeFile(path.join(config.dir, 'legacy-v2.obpack'), v2);
    const old = await cloud.downloadLocalBackup(config, 'legacy-v2.obpack', '');
    assert.deepStrictEqual(Buffer.concat(old.profiles[0]._dataFiles['Local Storage/data.bin'].map((chunk) => Buffer.from(chunk, 'base64'))), data);
    assert.ok(backup.meta.bytes < v2.length, `binary package ${backup.meta.bytes} should be smaller than v2 ${v2.length}`);
    console.log(`  PASS  binary backup round-trip and v2 compatibility (${backup.meta.bytes} vs ${v2.length} bytes)`);
  } finally {
    await fs.rm(binaryRoot, { recursive: true, force: true });
  }

  const incrementalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-incremental-'));
  try {
    const source = { dir: path.join(incrementalRoot, 'source') };
    const destination = { dir: path.join(incrementalRoot, 'destination') };
    const dataRoot = path.join(incrementalRoot, 'data');
    const profiles = ['a', 'b'].map((id) => ({ id, advanced: { cloudBackup: true, syncLocalStorage: true } }));
    for (const profile of profiles) {
      const dir = path.join(dataRoot, profile.id, 'Default', 'Local Storage');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'data'), profile.id);
    }
    const options = { profiles, profileDataRoot: dataRoot, includeBrowserData: true, passphrase: 'secret' };
    const first = await cloud.localBackupSet(source, options);
    assert.strictEqual(first.meta.changedCount, 2);
    await fs.cp(source.dir, destination.dir, { recursive: true });
    const unchanged = await cloud.localBackupSet(source, options);
    assert.strictEqual(unchanged.meta.changedCount, 0);
    assert.deepStrictEqual(unchanged.result.files, first.result.files);
    await fs.writeFile(path.join(dataRoot, 'a', 'Default', 'Local Storage', 'data'), 'changed');
    const changed = await cloud.localBackupSet(source, options);
    assert.strictEqual(changed.meta.changedCount, 1);
    assert.strictEqual(changed.meta.reusedCount, 1);
    assert.strictEqual(changed.result.files[1], first.result.files[1]);
    for (const name of changed.result.changedFiles) {
      await fs.mkdir(path.dirname(path.join(destination.dir, name)), { recursive: true });
      await fs.copyFile(path.join(source.dir, name), path.join(destination.dir, name));
    }
    await fs.copyFile(path.join(source.dir, 'openbrowser-backup-index.json'), path.join(destination.dir, 'openbrowser-backup-index.json'));
    const restored = await cloud.downloadLocalBackupSet(destination, 'secret');
    assert.strictEqual(Buffer.concat(restored.profiles[0]._dataFiles['Local Storage/data']).toString(), 'changed');
    assert.strictEqual(Buffer.concat(restored.profiles[1]._dataFiles['Local Storage/data']).toString(), 'b');
    const newPassword = await cloud.localBackupSet(source, { ...options, passphrase: 'new secret' });
    assert.strictEqual(newPassword.meta.changedCount, 2);
    await fs.rm(path.join(source.dir, newPassword.result.files[0]));
    await assert.rejects(() => cloud.downloadLocalBackupSet(source, 'new secret'), /备份文件缺失/);
    const repaired = await cloud.localBackupSet(source, { ...options, passphrase: 'new secret' });
    assert.strictEqual(repaired.meta.changedCount, 1);
    console.log('  PASS  incremental reuse, transfer, restore, password change and missing-file repair');
  } finally {
    await fs.rm(incrementalRoot, { recursive: true, force: true });
  }

  const retentionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-retention-'));
  try {
    const config = { dir: retentionRoot };
    const profiles = ['a', 'b'].map((id) => ({ id, name: id, advanced: { cloudBackup: true } }));
    const options = { profiles, groups: [{ id: 'group' }], proxies: [{ id: 'proxy' }], passphrase: 'secret' };
    const first = await cloud.localBackupSet(config, options);
    const unrelated = path.join(retentionRoot, 'backups', '123-0123456789abcdef', 'notes.txt');
    await fs.mkdir(path.dirname(unrelated), { recursive: true });
    await fs.writeFile(unrelated, 'keep');
    const legacyTimestamp = path.join(retentionRoot, 'openbrowser-backup-2026-10-30T01-02-03-123Z.obpack');
    await fs.writeFile(legacyTimestamp, 'old duplicate');
    await fs.writeFile(path.join(retentionRoot, 'my-notes.obpack'), 'keep');
    const next = await cloud.localBackupSet(config, { ...options, profiles: [{ ...profiles[0], name: 'new' }, profiles[1]] });
    await assert.rejects(() => fs.stat(path.join(retentionRoot, first.result.files[0])), { code: 'ENOENT' });
    assert.strictEqual(next.result.files[1], first.result.files[1]);
    await assert.rejects(() => fs.stat(legacyTimestamp), { code: 'ENOENT' });
    assert.strictEqual(await fs.readFile(unrelated, 'utf8'), 'keep');
    assert.strictEqual(await fs.readFile(path.join(retentionRoot, 'my-notes.obpack'), 'utf8'), 'keep');

    const indexPath = path.join(retentionRoot, 'openbrowser-backup-index.json');
    const indexBeforeFailure = await fs.readFile(indexPath, 'utf8');
    await assert.rejects(() => cloud.localBackupProfile(config, { profiles: [profiles[0]], passphrase: '' }, 'a'), /密码已更改/);
    await assert.rejects(() => cloud.localBackupProfile(config, { profiles: [profiles[0]], passphrase: 'wrong' }, 'a'));
    assert.strictEqual(await fs.readFile(indexPath, 'utf8'), indexBeforeFailure);
    assert.strictEqual((await cloud.downloadLocalBackupSet(config, 'secret')).profiles[0].name, 'new');

    const pushed = { ...profiles[0], name: 'closed' };
    await cloud.localBackupProfile(config, { profiles: [pushed], groups: [], proxies: [], passphrase: 'secret' }, 'a');
    await assert.rejects(() => fs.stat(path.join(retentionRoot, next.result.files[0])), { code: 'ENOENT' });
    const restored = await cloud.downloadLocalBackupSet(config, 'secret');
    assert.deepStrictEqual(restored.profiles.map((p) => p.name), ['closed', 'b']);
    assert.deepStrictEqual(restored.groups, options.groups);
    assert.deepStrictEqual(restored.proxies, options.proxies);
    assert.strictEqual((await cloud.downloadLocalProfile(config, 'a', 'secret')).profiles[0].name, 'closed');
    await Promise.all([
      cloud.localBackupProfile(config, { profiles: [{ ...profiles[0], name: 'concurrent-a' }], passphrase: 'secret' }, 'a'),
      cloud.localBackupProfile(config, { profiles: [{ ...profiles[1], name: 'concurrent-b' }], passphrase: 'secret' }, 'b'),
    ]);
    assert.deepStrictEqual((await cloud.downloadLocalBackupSet(config, 'secret')).profiles.map((p) => p.name), ['concurrent-a', 'concurrent-b']);

    // A pre-upgrade close-time backup may be newer than the indexed package.
    await cloud.localBackup(config, { profiles: [{ ...profiles[0], name: 'legacy-newer' }], profileIds: ['a'], passphrase: 'secret' }, cloud.profileRemoteName('a'));
    const legacyPath = path.join(retentionRoot, cloud.profileRemoteName('a'));
    const future = new Date(Date.now() + 5000);
    await fs.utimes(legacyPath, future, future);
    assert.strictEqual((await cloud.downloadLocalBackupSet(config, 'secret')).profiles[0].name, 'legacy-newer');
    assert.strictEqual((await cloud.downloadLocalProfile(config, 'a', 'secret')).profiles[0].name, 'legacy-newer');
    await cloud.localBackupSet(config, options);
    await assert.rejects(() => fs.stat(legacyPath), { code: 'ENOENT' });
    const fresh = { dir: path.join(retentionRoot, 'fresh') };
    await cloud.localBackupProfile(fresh, { profiles: [profiles[0]], passphrase: 'secret' }, 'a');
    await cloud.localBackupProfile(fresh, { profiles: [profiles[1]], passphrase: 'secret' }, 'b');
    assert.deepStrictEqual((await cloud.downloadLocalBackupSet(fresh, 'secret')).profiles.map((p) => p.id), ['a', 'b']);
    console.log('  PASS  latest-only cleanup, close-time updates, legacy migration and concurrent backups');
  } finally {
    await fs.rm(retentionRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
