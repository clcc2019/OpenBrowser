'use strict';
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('./credential-crypto');
const { ProxyStore } = require('./proxy-store');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-credentials-'));
  const old = process.env.OPENBROWSER_CREDENTIAL_KEY_FILE;
  try {
    process.env.OPENBROWSER_CREDENTIAL_KEY_FILE = path.join(root, 'key');
    const file = path.join(root, 'proxies.json');
    await fs.writeFile(file, JSON.stringify({ version: 2, items: [{ id: 'old', raw: 'http://user:secret@localhost:8080' }] }));
    const store = new ProxyStore(file);
    await store.load();
    const encrypted = await fs.readFile(file);
    assert.ok(crypto.isEncrypted(encrypted));
    assert.ok(!encrypted.includes(Buffer.from('secret')));
    assert.equal((await new ProxyStore(file).load()).items[0].password, 'secret');
    if (process.platform !== 'win32') assert.equal((await fs.stat(process.env.OPENBROWSER_CREDENTIAL_KEY_FILE)).mode & 0o777, 0o600);
    process.env.OPENBROWSER_CREDENTIAL_KEY_FILE = path.join(root, 'missing-key');
    await assert.rejects(new ProxyStore(file).load({ recoverCorrupt: true }), { code: 'ERR_CREDENTIAL_DECRYPT' });
    assert.deepEqual(await fs.readFile(file), encrypted);
    console.log('credential-crypto-selftest: ok');
  } finally {
    if (old === undefined) delete process.env.OPENBROWSER_CREDENTIAL_KEY_FILE;
    else process.env.OPENBROWSER_CREDENTIAL_KEY_FILE = old;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
