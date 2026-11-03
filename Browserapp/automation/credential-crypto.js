'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AES_HEADER = Buffer.from('OBC1');
const SAFE_HEADER = Buffer.from('OBS1');

function safeStorage() {
  try {
    const storage = require('../host-bridge').safeStorage;
    return storage?.isEncryptionAvailable() ? storage : null;
  } catch (_) { return null; }
}

function keyPath() {
  return process.env.OPENBROWSER_CREDENTIAL_KEY_FILE || path.join(os.homedir(), '.openbrowser', 'credential.key');
}

function masterKey(create) {
  const file = keyPath();
  try {
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw new Error('Invalid credential key');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temp, file);
    return key;
  } catch (error) {
    if (error.code === 'EEXIST') return masterKey(false);
    throw error;
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

function isEncrypted(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return data.subarray(0, 4).equals(AES_HEADER) || data.subarray(0, 4).equals(SAFE_HEADER);
}

function encrypt(value) {
  const text = String(value);
  const storage = safeStorage();
  if (storage) return Buffer.concat([SAFE_HEADER, storage.encryptString(text)]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(true), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([AES_HEADER, iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (data.subarray(0, 4).equals(SAFE_HEADER)) {
    const storage = safeStorage();
    if (!storage) throw new Error('系统凭据存储不可用，无法解密数据');
    return storage.decryptString(data.subarray(4));
  }
  if (data.subarray(0, 4).equals(AES_HEADER)) {
    if (data.length < 32) throw new Error('加密数据不完整');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(false), data.subarray(4, 16));
    decipher.setAuthTag(data.subarray(16, 32));
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
  }
  return data.toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted };
