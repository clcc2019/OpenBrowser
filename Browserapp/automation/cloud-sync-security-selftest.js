'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
