'use strict';

/**
 * OpenBrowser cloud backup / restore.
 * Providers: local file path, WebDAV, GitHub repo Contents API.
 * Payload includes profiles (cookies/password/2FA/proxy/fingerprint/prefs),
 * groups, proxy library snapshot, and optional per-profile browser data files.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const readline = require('readline');
const { assertProfileId, assertSafeProfileChild } = require('./isolation');

const BACKUP_VERSION = 1;
const REMOTE_NAME = 'openbrowser-backup.obpack';
const LOCAL_INDEX_NAME = 'openbrowser-backup-index.json';
// Keep the serialized and packaged limits aligned. Browser data is embedded as
// Base64 in the JSON payload, so the serialized backup can be larger than the
// raw browser-data budget even when the latter is respected.
const MAX_BACKUP_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 256 * 1024 * 1024;
const MAX_BROWSER_DATA_BYTES = 80 * 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_REMOTE_ERROR_BYTES = 64 * 1024;
const SAFE_GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_GITHUB_BRANCH = /^[A-Za-z0-9._\/-]{1,255}$/;

function nowIso() {
  return new Date().toISOString();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function encryptPayload(plainBuf, passphrase) {
  if (!passphrase) return { encrypted: false, data: plainBuf };
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    data: Buffer.concat([
      Buffer.from('OBE1'),
      salt,
      iv,
      tag,
      enc,
    ]),
  };
}

function decryptPayload(buf, passphrase) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString() === 'OBE1') {
    if (!passphrase) throw new Error('备份已加密，请填写恢复密码');
    const salt = buf.subarray(4, 20);
    const iv = buf.subarray(20, 32);
    const tag = buf.subarray(32, 48);
    const enc = buf.subarray(48);
    const key = crypto.scryptSync(String(passphrase), salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
  return buf;
}

async function collectProfileDataFiles(profileRoot, profile, limits = {}) {
  const advanced = profile.advanced || {};
  const files = {};
  if (!profileRoot || !fs.existsSync(profileRoot)) return files;
  // Only pack browser data when this environment opts into cloud backup
  if (!advanced.cloudBackup) return files;
  const defaultDir = path.join(profileRoot, 'Default');
  const candidates = [];
  // Cookies always included when cloud backup is on (close-time Cookie sync)
  if (advanced.syncCookiesOnClose !== false || advanced.saveCookies !== false) {
    candidates.push(['Network/Cookies', path.join(defaultDir, 'Network', 'Cookies')]);
    candidates.push(['Network/Cookies-journal', path.join(defaultDir, 'Network', 'Cookies-journal')]);
  }
  if (advanced.syncLocalStorage) {
    candidates.push(['Local Storage', path.join(defaultDir, 'Local Storage')]);
  }
  if (advanced.syncIndexedDB) {
    candidates.push(['IndexedDB', path.join(defaultDir, 'IndexedDB')]);
  }
  if (advanced.syncPasswords) {
    candidates.push(['Login Data', path.join(defaultDir, 'Login Data')]);
    candidates.push(['Login Data-journal', path.join(defaultDir, 'Login Data-journal')]);
  }
  if (advanced.syncExtensionData) {
    candidates.push(['Local Extension Settings', path.join(defaultDir, 'Local Extension Settings')]);
    candidates.push(['Extension State', path.join(defaultDir, 'Extension State')]);
  }
  const maxFile = limits.maxFileBytes ?? 25 * 1024 * 1024;
  const maxTotal = limits.maxTotalBytes ?? 80 * 1024 * 1024;
  let total = 0;

  async function walk(rel, abs) {
    let st;
    try { st = await fsp.lstat(abs); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      if (st.size > maxFile) throw new Error(`浏览器数据文件超过备份单文件大小限制：${rel}`);
      if (total + st.size > maxTotal) throw new Error(`浏览器数据总大小超过备份限制，无法完整备份：${rel}`);
      const buf = await fsp.readFile(abs);
      if (buf.length > maxFile || total + buf.length > maxTotal) {
        throw new Error(`浏览器数据在备份期间增长并超过大小限制：${rel}`);
      }
      files[rel.replace(/\\/g, '/')] = buf.toString('base64');
      total += buf.length;
      return;
    }
    if (!st.isDirectory()) return;
    const entries = await fsp.readdir(abs).catch(() => []);
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      await walk(path.join(rel, name), path.join(abs, name));
    }
  }

  for (const [rel, abs] of candidates) {
    await walk(rel, abs);
  }
  return files;
}

async function restoreProfileDataFiles(profileRoot, files, { unlimitedSize = false } = {}) {
  if (!files || typeof files !== 'object') return 0;
  const base = path.resolve(profileRoot, 'Default');
  const entries = Object.entries(files);
  if (!unlimitedSize && entries.length > 2000) throw new Error('备份文件数量超过安全限制');
  let count = 0;
  let totalBytes = 0;
  for (const [rel, b64] of entries) {
    if (!rel || (typeof b64 !== 'string' && !Array.isArray(b64))) continue;
    if (Array.isArray(b64) && (!unlimitedSize || b64.some((chunk) => typeof chunk !== 'string' && !Buffer.isBuffer(chunk)))) throw new Error('备份文件格式无效');
    // Reject absolute / drive-relative paths before any normalization that strips leading slashes
    const raw = String(rel).replace(/\0/g, '');
    if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) continue;
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) continue;
    const safe = raw.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!safe || safe.includes('..') || safe.includes('\0')) continue;
    // Block path segments that escape after resolve (Windows separators / alternate roots)
    const abs = path.resolve(base, safe);
    if (abs !== base && !abs.startsWith(base + path.sep)) continue;
    // Extra Windows case-insensitive guard
    const absKey = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const baseKey = process.platform === 'win32' ? base.toLowerCase() : base;
    if (absKey !== baseKey && !absKey.startsWith(baseKey + path.sep)) continue;
    const chunks = Array.isArray(b64) ? b64 : [b64];
    const size = chunks.reduce((sum, chunk) => sum + (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, 'base64')), 0);
    if (!unlimitedSize && size > 25 * 1024 * 1024) throw new Error('备份单文件超过安全限制');
    totalBytes += size;
    if (!unlimitedSize && totalBytes > 80 * 1024 * 1024) throw new Error('备份文件总大小超过安全限制');
    await assertSafeProfileChild(profileRoot, abs);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await assertSafeProfileChild(profileRoot, abs);
    const handle = await fsp.open(abs, 'w', 0o600);
    try {
      for (const chunk of chunks) await handle.writeFile(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'base64'));
    } finally { await handle.close(); }
    count += 1;
  }
  return count;
}

function profileStamp(profile) {
  const p = profile || {};
  const candidates = [p.updatedAt, p.syncedAt, p.exitCheckedAt, p.createdAt];
  for (const c of candidates) {
    const t = Date.parse(String(c || ''));
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function stripDataFiles(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const copy = { ...profile };
  delete copy._dataFiles;
  return copy;
}

/**
 * Merge remote backup into local state.
 * mode:
 *  - merge (default): keep local-only; add remote-only; same id → newer wins (timestamp), else remote config fields win
 *  - local-wins: only add missing ids from remote
 *  - remote-wins / overwrite: remote list becomes truth (still reported as merge stats)
 */
function mergeProfiles(localList = [], remoteList = [], mode = 'merge') {
  const local = Array.isArray(localList) ? localList.map(stripDataFiles) : [];
  const remote = Array.isArray(remoteList) ? remoteList.map(stripDataFiles) : [];
  const stats = { added: 0, updated: 0, kept: 0, skipped: 0, conflicts: 0 };

  if (mode === 'overwrite' || mode === 'remote-wins') {
    stats.added = remote.filter((r) => !local.some((l) => l.id === r.id)).length;
    stats.updated = remote.filter((r) => local.some((l) => l.id === r.id)).length;
    stats.kept = 0;
    return {
      profiles: remote.map((p) => ({ ...p, syncedAt: nowIso() })),
      stats: { ...stats, mode },
    };
  }

  const byId = new Map();
  for (const item of local) {
    if (item?.id) byId.set(item.id, { ...item, _source: 'local' });
  }

  for (const remoteItem of remote) {
    if (!remoteItem?.id) continue;
    const localItem = byId.get(remoteItem.id);
    if (!localItem) {
      byId.set(remoteItem.id, { ...remoteItem, syncedAt: nowIso(), _source: 'remote' });
      stats.added += 1;
      continue;
    }
    if (mode === 'local-wins') {
      stats.skipped += 1;
      continue;
    }
    // merge / newer-wins
    const localTs = profileStamp(localItem);
    const remoteTs = profileStamp(remoteItem);
    stats.conflicts += 1;
    let winner;
    if (remoteTs && localTs && remoteTs !== localTs) {
      winner = remoteTs >= localTs ? remoteItem : localItem;
    } else if (remoteTs && !localTs) {
      winner = remoteItem;
    } else if (!remoteTs && localTs) {
      winner = localItem;
    } else {
      // no timestamps: prefer remote cloud-relevant fields, keep local identity/runtime
      winner = {
        ...localItem,
        ...remoteItem,
        id: localItem.id,
        number: localItem.number || remoteItem.number,
        name: localItem.name || remoteItem.name,
        // cookies/platform/proxy from remote if present
        cookies: remoteItem.cookies != null && remoteItem.cookies !== '' ? remoteItem.cookies : localItem.cookies,
        platform: remoteItem.platform || localItem.platform,
        proxy: remoteItem.proxy != null ? remoteItem.proxy : localItem.proxy,
        proxyMeta: { ...(localItem.proxyMeta || {}), ...(remoteItem.proxyMeta || {}) },
        privacy: { ...(localItem.privacy || {}), ...(remoteItem.privacy || {}) },
        advanced: { ...(localItem.advanced || {}), ...(remoteItem.advanced || {}) },
      };
    }
    const fromRemote = winner === remoteItem || winner.cookies === remoteItem.cookies;
    byId.set(remoteItem.id, {
      ...stripDataFiles(winner),
      syncedAt: nowIso(),
      updatedAt: winner.updatedAt || nowIso(),
      _mergedFrom: fromRemote ? 'remote' : 'local',
    });
    stats.updated += 1;
  }

  for (const item of byId.values()) {
    if (item._source === 'local' && !remote.some((r) => r.id === item.id)) stats.kept += 1;
    delete item._source;
    delete item._mergedFrom;
  }

  return {
    profiles: [...byId.values()],
    stats: { ...stats, mode: mode || 'merge' },
  };
}

function mergeGroups(localGroups = [], remoteGroups = [], mode = 'merge') {
  if (mode === 'overwrite' || mode === 'remote-wins') return Array.isArray(remoteGroups) ? remoteGroups : [];
  const map = new Map();
  for (const g of localGroups || []) if (g?.id) map.set(g.id, g);
  for (const g of remoteGroups || []) {
    if (!g?.id) continue;
    if (mode === 'local-wins' && map.has(g.id)) continue;
    map.set(g.id, { ...(map.get(g.id) || {}), ...g });
  }
  return [...map.values()];
}

function mergeProxies(localProxies = [], remoteProxies = [], mode = 'merge') {
  if (mode === 'overwrite' || mode === 'remote-wins') return Array.isArray(remoteProxies) ? remoteProxies : [];
  const map = new Map();
  const keyOf = (p) => p.id || `${p.protocol || ''}:${p.host || ''}:${p.port || ''}`;
  for (const p of localProxies || []) map.set(keyOf(p), p);
  for (const p of remoteProxies || []) {
    const k = keyOf(p);
    if (mode === 'local-wins' && map.has(k)) continue;
    map.set(k, { ...(map.get(k) || {}), ...p });
  }
  return [...map.values()];
}

function profileRemoteName(id) {
  const safe = assertProfileId(id);
  return `profiles/openbrowser-profile-${safe}.obpack`;
}

function isLocalProvider(provider) {
  return String(provider || 'local').toLowerCase() === 'local';
}

function safeRemotePath(value, fallback = '') {
  const raw = String(value || fallback).trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('远程备份路径无效');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.length > 160)) {
    throw new Error('远程备份路径包含不安全片段');
  }
  return parts.join('/');
}

function safeLocalTarget(root, remoteName) {
  const base = path.resolve(String(root || ''));
  const rel = safeRemotePath(remoteName, REMOTE_NAME);
  const target = path.resolve(base, ...rel.split('/'));
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(target) === normalize(base) || !normalize(target).startsWith(normalize(base) + path.sep)) {
    throw new Error('本地备份路径越过所选目录');
  }
  return { base, rel, target };
}

async function assertSafeLocalTarget(base, target) {
  try {
    if ((await fsp.lstat(base)).isSymbolicLink()) throw new Error('本地备份根目录不能是符号链接或 junction');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error('本地备份路径包含符号链接或 junction');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function withRemoteName(config, provider, remoteName) {
  const c = { ...(config || {}) };
  const name = remoteName || REMOTE_NAME;
  if (String(provider) === 'github') {
    const base = safeRemotePath(c.path, `openbrowser/${REMOTE_NAME}`);
    const safeName = safeRemotePath(name, REMOTE_NAME);
    if (name === REMOTE_NAME) {
      c.path = base;
    } else {
      const dir = base.includes('/') ? base.replace(/\/[^/]+$/, '') : 'openbrowser';
      c.path = `${dir}/${safeName}`;
    }
  }
  return c;
}

function validatedGitHubConfig(config, remoteName) {
  const cfg = withRemoteName(config, 'github', remoteName);
  const owner = String(cfg.owner || '').trim();
  const repo = String(cfg.repo || '').trim();
  const token = String(cfg.token || '').trim();
  const branch = String(cfg.branch || 'main').trim() || 'main';
  const filePath = safeRemotePath(cfg.path, `openbrowser/${remoteName}`);
  if (!SAFE_GITHUB_NAME.test(owner) || !SAFE_GITHUB_NAME.test(repo) || !token) throw new Error('GitHub owner / repo / token 无效');
  if (!SAFE_GITHUB_BRANCH.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error('GitHub branch 无效');
  }
  if (token.length > 1024) throw new Error('GitHub token 长度无效');
  return { owner, repo, token, branch, filePath };
}

async function buildBackupPackage({
  profiles = [],
  groups = [],
  proxies = [],
  settings = {},
  profileDataRoot,
  includeBrowserData = true,
  passphrase = '',
  profileIds = null,
  unlimitedSize = false,
}) {
  let list = Array.isArray(profiles) ? profiles : [];
  if (Array.isArray(profileIds) && profileIds.length) {
    const allow = new Set(profileIds.map(String));
    list = list.filter((p) => allow.has(String(p.id)));
  }
  // default: only environments that explicitly enable cloudBackup (per-profile opt-in)
  if (!Array.isArray(profileIds)) {
    list = list.filter((p) => Boolean(p?.advanced?.cloudBackup));
  }
  const packedProfiles = [];
  let browserDataBytes = 0;
  let estimatedJsonBytes = 0;
  for (const profile of list) {
    assertProfileId(profile?.id);
    const item = { ...profile, updatedAt: profile.updatedAt || nowIso() };
    if (includeBrowserData && profileDataRoot && profile?.id) {
      const root = path.join(profileDataRoot, profile.id);
      const browserDataLimit = unlimitedSize ? Infinity : MAX_BROWSER_DATA_BYTES;
      item._dataFiles = await collectProfileDataFiles(root, profile, {
        maxFileBytes: unlimitedSize ? Infinity : undefined,
        maxTotalBytes: Number.isFinite(browserDataLimit)
          ? Math.max(0, browserDataLimit - browserDataBytes)
          : Infinity,
      });
      for (const encoded of Object.values(item._dataFiles)) {
        browserDataBytes += Math.floor(String(encoded).length * 3 / 4);
      }
    }
    estimatedJsonBytes += Buffer.byteLength(JSON.stringify(item));
    if (!unlimitedSize && estimatedJsonBytes > MAX_BACKUP_JSON_BYTES) {
      throw new Error('备份配置内容超过 256 MB 安全限制');
    }
    packedProfiles.push(item);
  }
  const body = {
    version: BACKUP_VERSION,
    soft: 'OpenBrowser',
    createdAt: nowIso(),
    profiles: packedProfiles,
    groups,
    proxies,
    settings,
  };
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  if (!unlimitedSize && json.length > MAX_BACKUP_JSON_BYTES) {
    throw new Error('备份内容超过 256 MB 安全限制');
  }
  const gz = zlib.gzipSync(json, { level: 9 });
  const { encrypted, data } = encryptPayload(gz, passphrase);
  return {
    buffer: data,
    meta: {
      version: BACKUP_VERSION,
      encrypted,
      createdAt: body.createdAt,
      profileCount: packedProfiles.length,
      profileIds: packedProfiles.map((p) => p.id),
      bytes: data.length,
      sha256: sha256(data),
    },
  };
}

async function parseBackupPackage(buffer, passphrase = '', { unlimitedSize = false } = {}) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const magic = raw.subarray(0, 4).toString();
  if (['OBP2', 'OBE2', 'OBP3', 'OBE3'].includes(magic)) {
    if (!unlimitedSize) throw new Error('该本地备份格式仅支持从本地恢复');
    const encrypted = magic === 'OBE2' || magic === 'OBE3';
    if (raw.length < (encrypted ? 48 : 4)) throw new Error('备份格式无效');
    const parser = magic.endsWith('3') ? parseLocalV3 : parseLocalV2;
    return parser(Readable.from([raw.subarray(encrypted ? 32 : 4, encrypted ? -16 : undefined)]), raw.subarray(0, encrypted ? 32 : 4), encrypted ? raw.subarray(-16) : null, passphrase);
  }
  if (!unlimitedSize && raw.length > MAX_BACKUP_PACKAGE_BYTES) {
    throw new Error('备份包超过 256 MB 安全限制');
  }
  const decrypted = decryptPayload(raw, passphrase);
  if (!unlimitedSize && decrypted.length > MAX_BACKUP_PACKAGE_BYTES) {
    throw new Error('备份包解密后超过安全限制');
  }
  let jsonBuf;
  try {
    jsonBuf = unlimitedSize
      ? zlib.gunzipSync(decrypted)
      : zlib.gunzipSync(decrypted, { maxOutputLength: MAX_BACKUP_JSON_BYTES });
  } catch (_) {
    jsonBuf = decrypted;
  }
  if (!unlimitedSize && jsonBuf.length > MAX_BACKUP_JSON_BYTES) {
    throw new Error('备份内容超过 256 MB 安全限制');
  }
  const body = JSON.parse(jsonBuf.toString('utf8'));
  if (!body || !Array.isArray(body.profiles)) throw new Error('备份格式无效');
  return body;
}

function request(urlString, options = {}, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const u = new URL(urlString);
    const lib = u.protocol === 'http:' ? http : https;
    const maxBytes = Number(options.maxBytes) || MAX_REMOTE_RESPONSE_BYTES;
    if (body && body.length > MAX_REMOTE_RESPONSE_BYTES * 2) return reject(new Error('上传内容超过安全限制'));
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 60000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('error', (error) => finish(reject, error));
      res.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          const error = new Error('远程响应超过安全限制');
          finish(reject, error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        const buf = Buffer.concat(chunks);
        finish(resolve, { status: res.statusCode || 0, headers: res.headers, body: buf });
      });
    });
    req.on('error', (error) => finish(reject, error));
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function ensureWebDavDir(baseUrl, user, pass, relativeDir) {
  const parts = relativeDir.split('/').filter(Boolean);
  let cur = baseUrl.replace(/\/?$/, '/');
  for (const part of parts) {
    cur += encodeURIComponent(part) + '/';
    const res = await request(cur, {
      method: 'MKCOL',
      headers: { Authorization: basicAuth(user, pass) },
    });
    if (![201, 204, 405, 301, 302, 409].includes(res.status)) {
      // 409/405 often mean exists
      if (res.status >= 400 && res.status !== 405 && res.status !== 409) {
        throw new Error(`WebDAV MKCOL 失败 (${res.status})`);
      }
    }
  }
}

function webDavTarget(config, remoteName = REMOTE_NAME) {
  let parsed;
  try { parsed = new URL(String(config.url || '')); } catch (_) { throw new Error('请填写有效的 WebDAV 地址'); }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('WebDAV 必须使用 HTTPS；仅本机回环地址允许 HTTP');
  }
  if (parsed.username || parsed.password) throw new Error('WebDAV 凭据必须使用独立账号字段');
  if (parsed.search) throw new Error('WebDAV 地址不能包含查询参数');
  parsed.hash = '';
  const base = parsed.toString().replace(/\/?$/, '/');
  const dir = safeRemotePath(config.dir, 'OpenBrowser');
  const name = safeRemotePath(remoteName, REMOTE_NAME);
  const rel = [dir, name].filter(Boolean).join('/');
  const encoded = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return { base, dir, name, rel, target: base + encoded };
}

async function uploadWebDav(config, buffer, remoteName = REMOTE_NAME) {
  const user = String(config.username || '');
  const pass = String(config.password || '');
  const { base, rel, target } = webDavTarget(config, remoteName);
  if (!base || base === '/') throw new Error('请填写 WebDAV 地址');
  const parent = rel.includes('/') ? rel.replace(/\/[^/]+$/, '') : '';
  if (parent) await ensureWebDavDir(base, user, pass, parent);
  const res = await request(target, {
    method: 'PUT',
    headers: {
      Authorization: basicAuth(user, pass),
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.length,
    },
  }, buffer);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WebDAV 上传失败 (${res.status})`);
  }
  return { provider: 'webdav', url: target, bytes: buffer.length, remoteName };
}

async function downloadWebDav(config, remoteName = REMOTE_NAME) {
  const user = String(config.username || '');
  const pass = String(config.password || '');
  const { target } = webDavTarget(config, remoteName);
  const res = await request(target, {
    method: 'GET',
    headers: { Authorization: basicAuth(user, pass) },
  });
  if (res.status !== 200) {
    throw new Error(`WebDAV 下载失败 (${res.status})`);
  }
  return res.body;
}

async function uploadGitHub(config, buffer, remoteName = REMOTE_NAME) {
  const { owner, repo, token, branch, filePath } = validatedGitHubConfig(config, remoteName);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  let sha;
  const getRes = await request(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenBrowser-CloudSync',
    },
    maxBytes: MAX_REMOTE_ERROR_BYTES,
  });
  if (getRes.status === 200) {
    try { sha = JSON.parse(getRes.body.toString('utf8')).sha; } catch (_) {}
  }
  const payload = JSON.stringify({
    message: `OpenBrowser backup ${nowIso()} · ${remoteName}`,
    content: buffer.toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  const putRes = await request(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenBrowser-CloudSync',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    maxBytes: MAX_REMOTE_ERROR_BYTES,
  }, Buffer.from(payload));
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`GitHub 上传失败 (${putRes.status})`);
  }
  return { provider: 'github', owner, repo, path: filePath, bytes: buffer.length, remoteName };
}

async function downloadGitHub(config, remoteName = REMOTE_NAME) {
  const { owner, repo, token, branch, filePath } = validatedGitHubConfig(config, remoteName);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await request(apiBase, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenBrowser-CloudSync',
    },
    maxBytes: MAX_REMOTE_RESPONSE_BYTES,
  });
  if (res.status !== 200) throw new Error(`GitHub 下载失败 (${res.status})`);
  const json = JSON.parse(res.body.toString('utf8'));
  if (!json.content) throw new Error('GitHub 文件内容为空');
  const decoded = Buffer.from(String(json.content).replace(/\n/g, ''), 'base64');
  if (decoded.length > MAX_BACKUP_PACKAGE_BYTES) throw new Error('GitHub 备份超过安全限制');
  return decoded;
}

/** Google Drive via "application data" style: user provides WebDAV-compatible endpoint or API key is not enough.
 *  We support "gdrive" as alias that expects a WebDAV bridge URL (Alist / rclone serve).
 */
async function uploadGoogleCloud(config, buffer, remoteName = REMOTE_NAME) {
  // Prefer WebDAV bridge fields; fall back to generic webdav keys.
  return uploadWebDav({
    url: config.url || config.webdavUrl,
    username: config.username || config.user || '',
    password: config.password || config.token || '',
    dir: config.dir || 'OpenBrowser',
  }, buffer, remoteName);
}

async function downloadGoogleCloud(config, remoteName = REMOTE_NAME) {
  return downloadWebDav({
    url: config.url || config.webdavUrl,
    username: config.username || config.user || '',
    password: config.password || config.token || '',
    dir: config.dir || 'OpenBrowser',
  }, remoteName);
}

async function uploadLocal(config, buffer, remoteName = REMOTE_NAME) {
  const dir = String(config.dir || '').trim();
  if (!dir) throw new Error('请选择本地备份目录');
  const { base, rel, target: file } = safeLocalTarget(dir, remoteName);
  await assertSafeLocalTarget(base, file);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await assertSafeLocalTarget(base, file);
  await fsp.writeFile(file, buffer, { mode: 0o600 });
  return { provider: 'local', path: file, bytes: buffer.length, remoteName: rel };
}

async function downloadLocal(config, remoteName = REMOTE_NAME) {
  const dir = String(config.dir || '').trim();
  if (!dir) throw new Error('请选择本地备份目录');
  const { base, target: file } = safeLocalTarget(dir, remoteName);
  await assertSafeLocalTarget(base, file);
  return fsp.readFile(file);
}

function localDataCandidates(profile) {
  const advanced = profile.advanced || {};
  if (!advanced.cloudBackup) return [];
  const paths = [];
  if (advanced.syncCookiesOnClose !== false || advanced.saveCookies !== false) paths.push('Network/Cookies', 'Network/Cookies-journal');
  if (advanced.syncLocalStorage) paths.push('Local Storage');
  if (advanced.syncIndexedDB) paths.push('IndexedDB');
  if (advanced.syncPasswords) paths.push('Login Data', 'Login Data-journal');
  if (advanced.syncExtensionData) paths.push('Local Extension Settings', 'Extension State');
  return paths;
}

async function* localDataFiles(profile, options) {
  if (!options.includeBrowserData || !options.profileDataRoot) return;
  const root = path.join(options.profileDataRoot, profile.id, 'Default');
  async function* walk(relPath) {
    const abs = path.join(root, relPath);
    let stat;
    try { stat = await fsp.lstat(abs); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of (await fsp.readdir(abs)).sort()) yield* walk(path.join(relPath, name));
    } else if (stat.isFile()) yield { abs, name: relPath.replace(/\\/g, '/') };
  }
  for (const candidate of localDataCandidates(profile)) yield* walk(candidate);
}

async function localInputFingerprint(profile, options) {
  const hash = options.passphrase ? crypto.createHmac('sha256', String(options.passphrase)) : crypto.createHash('sha256');
  const add = (value) => { const data = Buffer.from(value); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(data.length)); hash.update(length); hash.update(data); };
  add(JSON.stringify({ profile: profile ? stripDataFiles(profile) : null, groups: options.groups || [], proxies: options.proxies || [], settings: options.settings || {}, includeBrowserData: Boolean(options.includeBrowserData), format: 3 }));
  if (profile) for await (const file of localDataFiles(profile, options)) {
    add(file.name);
    const fileHash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file.abs)) fileHash.update(chunk);
    add(fileHash.digest());
  }
  return hash.digest('hex');
}

async function localFileHash(target) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

// Local v3 stores bounded binary frames in a compressed stream, avoiding the
// Base64 expansion of browser data while retaining streaming writes.
async function localBackup(config, options, remoteName = REMOTE_NAME) {
  const dir = String(config.dir || '').trim();
  if (!dir) throw new Error('请选择本地备份目录');
  const { base, rel, target } = safeLocalTarget(dir, remoteName);
  await assertSafeLocalTarget(base, target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await assertSafeLocalTarget(base, target);
  let profiles = Array.isArray(options.profiles) ? options.profiles : [];
  if (Array.isArray(options.profileIds) && options.profileIds.length) {
    const ids = new Set(options.profileIds.map(String));
    profiles = profiles.filter((p) => ids.has(String(p.id)));
  } else if (!Array.isArray(options.profileIds)) profiles = profiles.filter((p) => p?.advanced?.cloudBackup);
  profiles = profiles.map((p) => { assertProfileId(p?.id); return { ...stripDataFiles(p), updatedAt: p.updatedAt || nowIso() }; });
  const createdAt = nowIso();
  const tmp = path.join(path.dirname(target), `.openbrowser-${crypto.randomBytes(16).toString('hex')}.tmp`);
  const passphrase = options.passphrase || '';
  const salt = passphrase ? crypto.randomBytes(16) : null;
  const iv = passphrase ? crypto.randomBytes(12) : null;
  const cipher = passphrase ? crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(String(passphrase), salt, 32), iv) : null;
  const header = cipher ? Buffer.concat([Buffer.from('OBE3'), salt, iv]) : Buffer.from('OBP3');
  function frame(type, payload = Buffer.alloc(0)) {
    const prefix = Buffer.allocUnsafe(5);
    prefix.write(type, 0, 1, 'ascii');
    prefix.writeUInt32BE(payload.length, 1);
    return [prefix, payload];
  }
  async function* records() {
    yield* frame('H', Buffer.from(JSON.stringify({ version: 3, soft: 'OpenBrowser', createdAt, profiles, groups: options.groups || [], proxies: options.proxies || [], settings: options.settings || {} })));
    if (!options.includeBrowserData || !options.profileDataRoot) {
      yield* frame('E');
      return;
    }
    for (const profile of profiles) {
      for await (const file of localDataFiles(profile, options)) {
        yield* frame('F', Buffer.from(JSON.stringify({ id: profile.id, name: file.name })));
        for await (const chunk of fs.createReadStream(file.abs, { highWaterMark: 256 * 1024 })) yield* frame('D', chunk);
      }
    }
    yield* frame('E');
  }
  try {
    await fsp.writeFile(tmp, header, { flag: 'wx', mode: 0o600 });
    const stages = [Readable.from(records()), zlib.createGzip({ level: 9 })];
    if (cipher) stages.push(cipher);
    stages.push(fs.createWriteStream(tmp, { flags: 'a' }));
    await pipeline(...stages);
    if (cipher) await fsp.appendFile(tmp, cipher.getAuthTag());
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(tmp)) hash.update(chunk);
    const bytes = (await fsp.stat(tmp)).size;
    await assertSafeLocalTarget(base, target);
    await fsp.rename(tmp, target);
    return { meta: { version: 3, encrypted: Boolean(cipher), createdAt, profileCount: profiles.length, profileIds: profiles.map((p) => p.id), bytes, sha256: hash.digest('hex') }, result: { provider: 'local', path: target, bytes, remoteName: rel } };
  } finally { await fsp.rm(tmp, { force: true }); }
}

const localBackupLocks = new Map();

async function withLocalBackupLock(config, operation) {
  if (!String(config.dir || '').trim()) throw new Error('请选择本地备份目录');
  const key = path.resolve(config.dir);
  const previous = localBackupLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  localBackupLocks.set(key, current);
  try { return await current; }
  finally { if (localBackupLocks.get(key) === current) localBackupLocks.delete(key); }
}

async function removeEmptyDir(dir) {
  try { await fsp.rmdir(dir); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

// Only remove names generated by OpenBrowser; the chosen directory may also
// contain user files. Never traverse links or remove an indexed package.
async function cleanupLocalBackups(base, entries, { full = false, legacyProfileIds = [] } = {}) {
  const retained = new Set(entries.map((entry) => entry.name));
  const backups = path.join(base, 'backups');
  await assertSafeLocalTarget(base, backups);
  let snapshots;
  try { snapshots = await fsp.readdir(backups, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; snapshots = []; }
  for (const snapshot of snapshots) {
    if (!snapshot.isDirectory() || !/^\d+-[a-f0-9]{16}$/.test(snapshot.name)) continue;
    const snapshotDir = path.join(backups, snapshot.name);
    for (const relativeDir of ['', 'profiles']) {
      const dir = path.join(snapshotDir, relativeDir);
      await assertSafeLocalTarget(base, dir);
      let files;
      try { files = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
      for (const file of files) {
        const generated = relativeDir
          ? /^openbrowser-profile-[A-Za-z0-9_-]+\.obpack$/.test(file.name)
          : file.name === 'openbrowser-settings.obpack';
        if (!file.isFile() || !generated) continue;
        const name = ['backups', snapshot.name, relativeDir, file.name].filter(Boolean).join('/');
        if (!retained.has(name)) await fsp.unlink(path.join(dir, file.name));
      }
      if (relativeDir) await removeEmptyDir(dir);
    }
    await removeEmptyDir(snapshotDir);
  }
  await removeEmptyDir(backups);
  for (const id of legacyProfileIds) {
    const legacy = safeLocalTarget(base, profileRemoteName(id));
    try {
      await assertSafeLocalTarget(base, legacy.target);
      if ((await fsp.lstat(legacy.target)).isFile()) await fsp.unlink(legacy.target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const legacyProfiles = path.join(base, 'profiles');
  await assertSafeLocalTarget(base, legacyProfiles);
  await removeEmptyDir(legacyProfiles);
  if (full) {
    for (const file of await fsp.readdir(base, { withFileTypes: true })) {
      if (!file.isFile() || !(file.name === REMOTE_NAME || /^openbrowser-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.obpack$/.test(file.name))) continue;
      if (!retained.has(file.name)) await fsp.unlink(path.join(base, file.name));
    }
  }
}

async function publishLocalIndex(base, target, entries) {
  const tmp = path.join(base, `.openbrowser-index-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, files: entries.map((entry) => entry.name), entries }), { flag: 'wx', mode: 0o600 });
    await assertSafeLocalTarget(base, target);
    await fsp.rename(tmp, target);
  } finally { await fsp.rm(tmp, { force: true }); }
}

// Publish the index only after every independent package has been written.
async function localBackupSet(config, options) {
  return withLocalBackupLock(config, () => localBackupSetUnlocked(config, options));
}

async function localBackupSetUnlocked(config, options) {
  if (!String(config.dir || '').trim()) throw new Error('请选择本地备份目录');
  let profiles = Array.isArray(options.profiles) ? options.profiles : [];
  if (Array.isArray(options.profileIds) && options.profileIds.length) {
    const ids = new Set(options.profileIds.map(String));
    profiles = profiles.filter((p) => ids.has(String(p.id)));
  } else if (!Array.isArray(options.profileIds)) profiles = profiles.filter((p) => p?.advanced?.cloudBackup);
  const { base, target } = safeLocalTarget(config.dir, LOCAL_INDEX_NAME);
  await assertSafeLocalTarget(base, target);
  let previous = null;
  try { previous = JSON.parse(await fsp.readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const snapshot = `backups/${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const entries = [];
  const changedFiles = [];
  const items = profiles.length ? profiles : [null];
  if (new Set(profiles.map((p) => assertProfileId(p?.id))).size !== profiles.length) throw new Error('环境 ID 重复');
  for (const profile of items) {
    const id = profile?.id || null;
    const fingerprint = await localInputFingerprint(profile, options);
    const old = previous?.version === 1 && Array.isArray(previous.entries)
      ? previous.entries.find((entry) => entry.id === id && entry.fingerprint === fingerprint && previous.files?.includes(entry.name)) : null;
    let reused = false;
    if (old && typeof old.name === 'string' && /^[a-f0-9]{64}$/.test(old.sha256 || '')) {
      const file = safeLocalTarget(base, old.name);
      await assertSafeLocalTarget(file.base, file.target);
      try {
        const stat = await fsp.stat(file.target);
        if (stat.isFile() && await localFileHash(file.target) === old.sha256) {
          entries.push({ id, name: old.name, fingerprint, sha256: old.sha256, bytes: stat.size });
          reused = true;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!reused) {
      const name = profile ? `${snapshot}/${profileRemoteName(id)}` : `${snapshot}/openbrowser-settings.obpack`;
      const pack = await localBackup(config, { ...options, profiles: profile ? [profile] : [], profileIds: profile ? [id] : [] }, name);
      entries.push({ id, name, fingerprint, sha256: pack.meta.sha256, bytes: pack.meta.bytes });
      changedFiles.push(name);
    }
  }
  for (let i = 0; i < items.length; i++) {
    if (await localInputFingerprint(items[i], options) !== entries[i].fingerprint) throw new Error('备份期间环境数据发生变化，请关闭环境后重试');
  }
  const names = entries.map((entry) => entry.name);
  await publishLocalIndex(base, target, entries);
  try { await cleanupLocalBackups(base, entries, { full: true, legacyProfileIds: profiles.map((p) => p.id) }); }
  catch (error) { throw new Error(`备份已保存，但清理旧备份失败：${error.message}`); }
  return {
    meta: { version: 3, encrypted: Boolean(options.passphrase), createdAt: nowIso(), profileCount: profiles.length, profileIds: profiles.map((p) => p.id), bytes: entries.reduce((sum, p) => sum + p.bytes, 0), changedCount: changedFiles.length, reusedCount: entries.length - changedFiles.length },
    result: { provider: 'local', path: base, files: names, changedFiles, remoteName: LOCAL_INDEX_NAME },
  };
}

// A close-time push replaces just that environment in an existing set. The
// other packages stay referenced until a later full backup replaces them.
async function localBackupProfile(config, options, id) {
  assertProfileId(id);
  return withLocalBackupLock(config, async () => {
    const { base, target } = safeLocalTarget(config.dir, LOCAL_INDEX_NAME);
    await assertSafeLocalTarget(base, target);
    let index;
    try { index = JSON.parse(await fsp.readFile(target, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') {
        // A new directory can start with an indexed set even if the first
        // operation is a close-time push. Preserve older standalone backups
        // until the user performs a full backup.
        const legacy = safeLocalTarget(base, REMOTE_NAME);
        const legacyProfiles = path.join(base, 'profiles');
        await assertSafeLocalTarget(base, legacy.target);
        await assertSafeLocalTarget(base, legacyProfiles);
        let hasLegacy = false;
        try { await fsp.lstat(legacy.target); hasLegacy = true; }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        try { hasLegacy ||= (await fsp.readdir(legacyProfiles)).some((name) => /^openbrowser-profile-[A-Za-z0-9_-]+\.obpack$/.test(name)); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (hasLegacy) return localBackup(config, options, profileRemoteName(id));
        return localBackupSetUnlocked(config, { ...options, profileIds: [id] });
      }
      throw error;
    }
    if (index?.version !== 1 || !Array.isArray(index.files) || !index.files.length || !Array.isArray(index.entries)
      || index.entries.length !== index.files.length || new Set(index.files).size !== index.files.length
      || index.entries.some((entry, i) => entry.name !== index.files[i] || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))) {
      throw new Error('本地备份索引无效，请先重新执行全量备份');
    }
    const profile = (options.profiles || []).find((item) => item.id === id);
    if (!profile) throw new Error('环境不存在：' + id);
    // Verify existing references and the password before publishing a mixed set.
    for (const entry of index.entries) {
      const file = safeLocalTarget(base, entry.name);
      await assertSafeLocalTarget(base, file.target);
      if (await localFileHash(file.target) !== entry.sha256) throw new Error(`备份文件校验失败：${entry.name}`);
      const handle = await fsp.open(file.target, 'r');
      try {
        const magic = Buffer.alloc(4);
        await handle.read(magic, 0, 4, 0);
        const encrypted = ['OBE1', 'OBE2', 'OBE3'].includes(magic.toString());
        if (encrypted !== Boolean(options.passphrase)) throw new Error('备份密码已更改，请先重新执行全量备份');
      } finally { await handle.close(); }
    }
    const shared = await downloadLocalBackup(config, index.files[0], options.passphrase || '');
    const packOptions = { ...options, profiles: [profile], profileIds: [id], groups: shared.groups || [], proxies: shared.proxies || [], settings: shared.settings || {} };
    const fingerprint = await localInputFingerprint(profile, packOptions);
    const name = `backups/${Date.now()}-${crypto.randomBytes(8).toString('hex')}/${profileRemoteName(id)}`;
    const pack = await localBackup(config, packOptions, name);
    if (await localInputFingerprint(profile, packOptions) !== fingerprint) throw new Error('备份期间环境数据发生变化，请关闭环境后重试');
    const entry = { id, name, fingerprint, sha256: pack.meta.sha256, bytes: pack.meta.bytes };
    const entries = index.entries.filter((item) => item.id !== id && item.id !== null);
    const position = index.entries.findIndex((item) => item.id === id);
    entries.splice(position < 0 ? entries.length : Math.min(position, entries.length), 0, entry);
    await publishLocalIndex(base, target, entries);
    try { await cleanupLocalBackups(base, entries, { legacyProfileIds: [id] }); }
    catch (error) { throw new Error(`备份已保存，但清理旧备份失败：${error.message}`); }
    return pack;
  });
}

async function newestLocalProfileName(config, index, id) {
  const entry = Array.isArray(index?.entries) ? index.entries.find((item) => item.id === id && index.files.includes(item.name)) : null;
  const legacyName = profileRemoteName(id);
  if (!entry) return null;
  const indexed = safeLocalTarget(config.dir, entry.name);
  const legacy = safeLocalTarget(config.dir, legacyName);
  await assertSafeLocalTarget(indexed.base, indexed.target);
  await assertSafeLocalTarget(legacy.base, legacy.target);
  try {
    const [indexedStat, legacyStat] = await Promise.all([fsp.stat(indexed.target), fsp.stat(legacy.target)]);
    return legacyStat.isFile() && legacyStat.mtimeMs > indexedStat.mtimeMs ? legacyName : entry.name;
  } catch (error) { if (error.code === 'ENOENT') return entry.name; throw error; }
}

async function downloadLocalProfile(config, id, passphrase) {
  assertProfileId(id);
  return withLocalBackupLock(config, async () => {
    const { base, target } = safeLocalTarget(config.dir, LOCAL_INDEX_NAME);
    await assertSafeLocalTarget(base, target);
    let index;
    try { index = JSON.parse(await fsp.readFile(target, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (index && (index.version !== 1 || !Array.isArray(index.files))) throw new Error('本地备份索引无效');
    const name = (index && await newestLocalProfileName(config, index, id)) || profileRemoteName(id);
    return downloadLocalBackup(config, name, passphrase);
  });
}

async function downloadLocalBackupSet(config, passphrase) {
  return withLocalBackupLock(config, () => downloadLocalBackupSetUnlocked(config, passphrase));
}

async function downloadLocalBackupSetUnlocked(config, passphrase) {
  const { base, target } = safeLocalTarget(config.dir, LOCAL_INDEX_NAME);
  await assertSafeLocalTarget(base, target);
  let index;
  try { index = JSON.parse(await fsp.readFile(target, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return downloadLocalBackup(config, REMOTE_NAME, passphrase);
    throw error;
  }
  if (index?.version !== 1 || !Array.isArray(index.files) || !index.files.length || new Set(index.files).size !== index.files.length) throw new Error('本地备份索引无效');
  let combined;
  const ids = new Set();
  for (const name of index.files) {
    if (typeof name !== 'string') throw new Error('本地备份索引无效');
    let body;
    try { body = await downloadLocalBackup(config, name, passphrase); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`备份文件缺失：${name}。请将索引引用的文件按原目录结构复制完整`);
      throw error;
    }
    if (!combined) combined = { ...body, profiles: [] };
    for (const profile of body.profiles) {
      if (ids.has(profile.id)) throw new Error('本地备份包含重复环境');
      ids.add(profile.id);
      combined.profiles.push(profile);
    }
  }
  // Older releases wrote close-time pushes to a separate per-profile file.
  // Prefer it only when it is newer than the corresponding indexed package.
  for (let i = 0; i < combined.profiles.length; i++) {
    const profile = combined.profiles[i];
    const name = await newestLocalProfileName(config, index, profile.id);
    if (name === profileRemoteName(profile.id)) {
      const latest = await downloadLocalBackup(config, name, passphrase);
      const replacement = latest.profiles.find((item) => item.id === profile.id);
      if (!replacement) throw new Error(`环境备份内容无效：${name}`);
      combined.profiles[i] = replacement;
    }
  }
  return combined;
}

async function parseLocalV2(stream, header, tag, passphrase) {
  const encrypted = header.subarray(0, 4).toString() === 'OBE2';
  const stages = [stream];
  if (encrypted) {
    if (!passphrase) throw new Error('备份已加密，请填写恢复密码');
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(String(passphrase), header.subarray(4, 20), 32), header.subarray(20, 32));
    decipher.setAuthTag(tag);
    stages.push(decipher);
  }
  const gunzip = zlib.createGunzip();
  stages.push(gunzip);
  const done = pipeline(...stages);
  // Observe errors immediately even while readline is consuming the stream.
  done.catch(() => {});
  let body, current, ended = false;
  try {
    for await (const line of readline.createInterface({ input: gunzip, crlfDelay: Infinity })) {
      const record = JSON.parse(line);
      if (ended) throw new Error('备份格式无效');
      if (record.type === 'header' && !body && Array.isArray(record.body?.profiles)) {
        body = record.body;
        for (const profile of body.profiles) { assertProfileId(profile?.id); delete profile._dataFiles; }
      } else if (record.type === 'file' && body) {
        const profile = body.profiles.find((p) => p.id === record.id);
        if (!profile || typeof record.name !== 'string') throw new Error('备份文件格式无效');
        profile._dataFiles ||= Object.create(null);
        if (Object.hasOwn(profile._dataFiles, record.name)) throw new Error('备份文件重复');
        current = profile._dataFiles[record.name] = [];
      } else if (record.type === 'chunk' && current && typeof record.data === 'string' && record.data.length <= 350000) current.push(record.data);
      else if (record.type === 'end' && body) ended = true;
      else throw new Error('备份格式无效');
    }
    await done;
  } catch (error) { stream.destroy(); gunzip.destroy(); await done.catch(() => {}); throw error; }
  if (!body || !ended) throw new Error('备份格式无效');
  return body;
}

async function parseLocalV3(stream, header, tag, passphrase) {
  const encrypted = header.subarray(0, 4).toString() === 'OBE3';
  const stages = [stream];
  if (encrypted) {
    if (!passphrase) throw new Error('备份已加密，请填写恢复密码');
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(String(passphrase), header.subarray(4, 20), 32), header.subarray(20, 32));
    decipher.setAuthTag(tag);
    stages.push(decipher);
  }
  const gunzip = zlib.createGunzip();
  stages.push(gunzip);
  const done = pipeline(...stages);
  done.catch(() => {});
  const iterator = gunzip[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function readExact(size) {
    const pieces = [];
    let remaining = size;
    while (remaining) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('备份格式无效');
        pending = next.value;
      }
      const length = Math.min(remaining, pending.length);
      pieces.push(pending.subarray(0, length));
      pending = pending.subarray(length);
      remaining -= length;
    }
    return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size);
  }
  let body, current, ended = false;
  try {
    while (!ended) {
      const prefix = await readExact(5);
      const type = String.fromCharCode(prefix[0]);
      const size = prefix.readUInt32BE(1);
      if ((type === 'D' && size > 256 * 1024) || (type === 'F' && size > 64 * 1024) || (type === 'H' && size > 64 * 1024 * 1024) || !['H', 'F', 'D', 'E'].includes(type) || (type === 'E' && size !== 0)) throw new Error('备份格式无效');
      const data = await readExact(size);
      if (type === 'H' && !body) {
        body = JSON.parse(data.toString('utf8'));
        if (!Array.isArray(body?.profiles)) throw new Error('备份格式无效');
        for (const profile of body.profiles) { assertProfileId(profile?.id); delete profile._dataFiles; }
      } else if (type === 'F' && body) {
        const record = JSON.parse(data.toString('utf8'));
        const profile = body.profiles.find((p) => p.id === record.id);
        if (!profile || typeof record.name !== 'string') throw new Error('备份文件格式无效');
        profile._dataFiles ||= Object.create(null);
        if (Object.hasOwn(profile._dataFiles, record.name)) throw new Error('备份文件重复');
        current = profile._dataFiles[record.name] = [];
      } else if (type === 'D' && current) current.push(data);
      else if (type === 'E' && body) ended = true;
      else throw new Error('备份格式无效');
    }
    if (pending.length || !(await iterator.next()).done) throw new Error('备份格式无效');
    await done;
  } catch (error) { stream.destroy(); gunzip.destroy(); await done.catch(() => {}); throw error; }
  return body;
}

async function downloadLocalBackup(config, remoteName, passphrase) {
  const dir = String(config.dir || '').trim();
  if (!dir) throw new Error('请选择本地备份目录');
  const { base, target } = safeLocalTarget(dir, remoteName);
  await assertSafeLocalTarget(base, target);
  const handle = await fsp.open(target, 'r');
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(size, 32));
    await handle.read(prefix, 0, prefix.length, 0);
    const magic = prefix.subarray(0, 4).toString();
    if (!['OBP2', 'OBE2', 'OBP3', 'OBE3'].includes(magic)) return parseBackupPackage(await handle.readFile(), passphrase, { unlimitedSize: true });
    const encrypted = magic === 'OBE2' || magic === 'OBE3';
    if (size < (encrypted ? 48 : 4)) throw new Error('备份格式无效');
    const tag = encrypted ? Buffer.alloc(16) : null;
    if (tag) await handle.read(tag, 0, 16, size - 16);
    const stream = handle.createReadStream({ start: encrypted ? 32 : 4, end: size - (encrypted ? 17 : 1), autoClose: false });
    return await (magic.endsWith('3') ? parseLocalV3 : parseLocalV2)(stream, prefix, tag, passphrase);
  } finally { await handle.close(); }
}

/** WebDAV-bridge providers: Alist / OpenList / rclone serve for consumer clouds */
const WEBDAV_BRIDGE_PROVIDERS = new Set([
  'gdrive', 'google', 'gcs',
  'onedrive', 'microsoft', 'mscloud',
  'quark', 'kuake',
  'baidu', 'baiduyun', 'pan',
]);

function isWebDavBridgeProvider(provider) {
  return WEBDAV_BRIDGE_PROVIDERS.has(String(provider || '').toLowerCase());
}

async function upload(provider, config, buffer, remoteName = REMOTE_NAME) {
  const key = String(provider || 'local').toLowerCase();
  switch (key) {
    case 'webdav': return uploadWebDav(config, buffer, remoteName);
    case 'github': return uploadGitHub(config, buffer, remoteName);
    case 'local':
      return uploadLocal(config, buffer, remoteName);
    default:
      if (isWebDavBridgeProvider(key)) return uploadGoogleCloud(config, buffer, remoteName);
      return uploadLocal(config, buffer, remoteName);
  }
}

async function download(provider, config, remoteName = REMOTE_NAME) {
  const key = String(provider || 'local').toLowerCase();
  switch (key) {
    case 'webdav': return downloadWebDav(config, remoteName);
    case 'github': return downloadGitHub(config, remoteName);
    case 'local':
      return downloadLocal(config, remoteName);
    default:
      if (isWebDavBridgeProvider(key)) return downloadGoogleCloud(config, remoteName);
      return downloadLocal(config, remoteName);
  }
}

function emptyWebDavBridge() {
  return { url: '', username: '', password: '', dir: 'OpenBrowser' };
}

function defaultCloudConfig() {
  return {
    enabled: false,
    autoSyncOnQuit: true,
    includeBrowserData: true,
    provider: 'local',
    passphrase: '',
    restoreMode: 'merge',
    lastSyncAt: '',
    lastError: '',
    local: { dir: '' },
    webdav: emptyWebDavBridge(),
    github: { owner: '', repo: '', token: '', branch: 'main', path: 'openbrowser/openbrowser-backup.obpack' },
    gdrive: emptyWebDavBridge(),
    onedrive: emptyWebDavBridge(),
    quark: emptyWebDavBridge(),
    baidu: emptyWebDavBridge(),
  };
}

/** One-click presets shown in 本地设置 → 云同步 */
function cloudPresets() {
  return {
    onedrive: {
      id: 'onedrive',
      label: '微软云 OneDrive',
      provider: 'onedrive',
      dir: 'OpenBrowser',
      urlPlaceholder: 'https://你的域名/dav/onedrive',
      hint: '推荐用 Alist / OpenList 挂载 OneDrive，再填 WebDAV 地址。示例：https://alist.example.com/dav/onedrive 。用户名为 Alist 账号，密码为 Alist 密码或令牌。',
    },
    quark: {
      id: 'quark',
      label: '夸克云',
      provider: 'quark',
      dir: 'OpenBrowser',
      urlPlaceholder: 'https://你的域名/dav/quark',
      hint: '夸克无官方 WebDAV，请用 Alist / OpenList 挂载夸克网盘后填入桥接地址。Cookie 登录配置在 Alist 后台完成，此处只填 WebDAV 账号。',
    },
    baidu: {
      id: 'baidu',
      label: '百度云',
      provider: 'baidu',
      dir: 'OpenBrowser',
      urlPlaceholder: 'https://你的域名/dav/baidu',
      hint: '百度网盘请用 Alist / OpenList 挂载后使用 WebDAV。示例路径：/dav/baidu 或 /dav/百度网盘 。远程目录建议填 OpenBrowser。',
    },
  };
}

module.exports = {
  BACKUP_VERSION,
  REMOTE_NAME,
  defaultCloudConfig,
  cloudPresets,
  isLocalProvider,
  isWebDavBridgeProvider,
  WEBDAV_BRIDGE_PROVIDERS,
  buildBackupPackage,
  parseBackupPackage,
  restoreProfileDataFiles,
  mergeProfiles,
  mergeGroups,
  mergeProxies,
  profileRemoteName,
  profileStamp,
  withRemoteName,
  upload,
  download,
  localBackup,
  localBackupSet,
  localBackupProfile,
  downloadLocalProfile,
  downloadLocalBackupSet,
  downloadLocalBackup,
  encryptPayload,
  decryptPayload,
  safeRemotePath,
  safeLocalTarget,
  webDavTarget,
  validatedGitHubConfig,
};
