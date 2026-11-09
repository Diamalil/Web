require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const email = String(process.argv[2] || '').trim().toLowerCase();
const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
if (!/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Pemakaian: ADMIN_BOOTSTRAP_PASSWORD="password-kuat" npm run create-admin -- admin@domain.com');
  process.exit(1);
}
if (password.length < 12) {
  console.error('ADMIN_BOOTSTRAP_PASSWORD wajib minimal 12 karakter.');
  process.exit(1);
}
const dbFile = path.resolve(process.env.DATABASE_FILE || './data/buku-kas.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    is_active INTEGER NOT NULL DEFAULT 1,
    email_verified_at TEXT,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const userColumns = db.pragma('table_info(users)');
if (!userColumns.some(column => column.name === 'email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
if (!userColumns.some(column => column.name === 'session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1');
const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'admin', is_active = 1, email_verified_at = COALESCE(email_verified_at,datetime('now')), session_version=session_version+1, updated_at = datetime('now') WHERE id = ?")
    .run(email.split('@')[0], hash, existing.id);
  console.log(`Akun ${email} sudah ada. Role admin dan password telah diperbarui.`);
} else {
  db.prepare("INSERT INTO users (name,email,password_hash,role,email_verified_at) VALUES (?,?,?,'admin',datetime('now'))")
    .run(email.split('@')[0], email, hash);
  console.log(`Admin ${email} berhasil dibuat.`);
}
db.close();
