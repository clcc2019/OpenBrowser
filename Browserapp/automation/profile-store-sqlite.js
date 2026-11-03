'use strict';

const fs = require('fs');
const path = require('path');
const credentialCrypto = require('./credential-crypto');

// Store profiles independently while committing every engine snapshot in one
// transaction. Every payload is encrypted before SQLite sees it, including WAL.
class ProfileStoreSqlite {
  constructor(file) { this.file = file; this.db = null; }

  open() {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    try {
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS engine_state (id INTEGER PRIMARY KEY CHECK(id=1), data BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS profiles (position INTEGER PRIMARY KEY, data BLOB NOT NULL);`);
    } catch (error) { this.close(); throw error; }
    return this;
  }

  read() {
    const row = this.db.prepare('SELECT data FROM engine_state WHERE id=1').get();
    if (!row) return null;
    const decode = value => JSON.parse(credentialCrypto.decrypt(Buffer.from(value)));
    const state = decode(row.data);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('SQLite 状态格式无效');
    state.profiles = this.db.prepare('SELECT data FROM profiles ORDER BY position').all().map(row => decode(row.data));
    return state;
  }

  write(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(state.profiles)) throw new Error('SQLite 状态格式无效');
    const { profiles, ...metadata } = state;
    // Encryption can fail if the OS credential service is locked: prepare all
    // data before touching the committed snapshot.
    const encrypted = credentialCrypto.encrypt(JSON.stringify(metadata));
    const rows = profiles.map(profile => credentialCrypto.encrypt(JSON.stringify(profile)));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO engine_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(encrypted);
      this.db.exec('DELETE FROM profiles');
      const insert = this.db.prepare('INSERT INTO profiles (position, data) VALUES (?, ?)');
      rows.forEach((data, index) => insert.run(index, data));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}

module.exports = { ProfileStoreSqlite };
