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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'admin', is_active = 1, updated_at = datetime('now') WHERE id = ?")
    .run(email.split('@')[0], hash, existing.id);
  console.log(`Akun ${email} sudah ada. Role admin dan password telah diperbarui.`);
} else {
  db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')")
    .run(email.split('@')[0], email, hash);
  console.log(`Admin ${email} berhasil dibuat.`);
}
db.close();
