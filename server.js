'use strict';
require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const connectSQLite3 = require('connect-sqlite3');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit } = require('express-rate-limit');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = path.resolve('./data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbFile = path.resolve(process.env.DATABASE_FILE || './data/buku-kas.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Semua data finansial disimpan di server dan selalu di-scope dengan user_id.
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
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('Masuk','Keluar')),
  amount REAL NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id,date DESC);
CREATE TABLE IF NOT EXISTS profits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('Masuk','Keluar')),
  amount REAL NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_profits_user_date ON profits(user_id,date DESC);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id,name)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  price REAL NOT NULL CHECK(price >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_user_category ON products(user_id,category_id);
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_logs(actor_user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_purpose ON auth_tokens(user_id,purpose);
CREATE TRIGGER IF NOT EXISTS products_category_owner_insert
BEFORE INSERT ON products
WHEN NOT EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Product category owner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS products_category_owner_update
BEFORE UPDATE OF category_id,user_id ON products
WHEN NOT EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Product category owner mismatch'); END;
`);

// Forward-compatible migrations for existing database files.
function ensureColumn(table, column, definition) {
  const columns = db.pragma(`table_info(${table})`);
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('users', 'email_verified_at', 'TEXT');
ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 1');
// Product pricing: unit_cost is the HPP/modal per unit; sale_price is the configured selling price.
ensureColumn('products', 'unit_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('products', 'sale_price', 'REAL NOT NULL DEFAULT 0');
ensureColumn('products', 'pricing_method', "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn('products', 'pricing_value', 'REAL NOT NULL DEFAULT 0');
ensureColumn('profits', 'source_transaction_id', 'INTEGER REFERENCES transactions(id) ON DELETE CASCADE');
// Preserve the old product price as the sale price for existing records.
 db.exec('UPDATE products SET sale_price=price WHERE sale_price=0 AND price>0');
 db.exec(`
CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_sale_price REAL NOT NULL CHECK(unit_sale_price >= 0),
  unit_cost REAL NOT NULL CHECK(unit_cost >= 0),
  line_total REAL NOT NULL CHECK(line_total >= 0),
  line_profit REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_items_user_transaction ON transaction_items(user_id,transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profits_source_transaction ON profits(source_transaction_id) WHERE source_transaction_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS transaction_items_owner_insert
BEFORE INSERT ON transaction_items
WHEN NOT EXISTS (SELECT 1 FROM transactions WHERE id=NEW.transaction_id AND user_id=NEW.user_id)
  OR (NEW.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products WHERE id=NEW.product_id AND user_id=NEW.user_id))
BEGIN SELECT RAISE(ABORT, 'Transaction item owner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS transaction_items_owner_update
BEFORE UPDATE OF user_id,transaction_id,product_id ON transaction_items
WHEN NOT EXISTS (SELECT 1 FROM transactions WHERE id=NEW.transaction_id AND user_id=NEW.user_id)
  OR (NEW.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products WHERE id=NEW.product_id AND user_id=NEW.user_id))
BEGIN SELECT RAISE(ABORT, 'Transaction item owner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS profits_source_owner_insert
BEFORE INSERT ON profits
WHEN NEW.source_transaction_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM transactions WHERE id=NEW.source_transaction_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Profit source owner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS profits_source_owner_update
BEFORE UPDATE OF source_transaction_id,user_id ON profits
WHEN NEW.source_transaction_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM transactions WHERE id=NEW.source_transaction_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Profit source owner mismatch'); END;
`);

const app = express();
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') {
  // Set TRUST_PROXY=1 hanya bila tepat satu reverse proxy tepercaya berada di depan server.
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use((req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));

const SQLiteStore = connectSQLite3(session);
const sessionFile = path.resolve(process.env.SESSION_DATABASE_FILE || './data/sessions.sqlite');
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
app.use(session({
  store: new SQLiteStore({ db: path.basename(sessionFile), dir: path.dirname(sessionFile), table: 'sessions', concurrentDB: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deployment',
  resave: false,
  saveUninitialized: false,
  name: 'buku_kas.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan. Coba lagi beberapa menit.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak percobaan login gagal dari jaringan ini. Coba lagi 15 menit.' } });
const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan pemulihan akun. Coba lagi nanti.' } });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

app.use('/api', writeLimiter, (req, res, next) => {
  const csrfManagedHere = ['/auth/register', '/auth/login', '/auth/admin/login', '/auth/logout'].includes(req.path);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !csrfManagedHere) return requireCsrf(req, res, next);
  next();
});

function safeUser(row) {
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role, isActive: Boolean(row.is_active), emailVerified: Boolean(row.email_verified_at), createdAt: row.created_at } : null;
}
function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
  if (!user || !user.is_active || Number(req.session.sessionVersion) !== Number(user.session_version)) return null;
  return user;
}
function recordActivity(req, action, entityType, entityId = null, metadata = {}, actorOverride = null) {
  const actor = actorOverride || currentUser(req);
  db.prepare(`INSERT INTO activity_logs (actor_user_id,actor_email,action,entity_type,entity_id,metadata,ip_address)
    VALUES (?,?,?,?,?,?,?)`).run(
    actor?.id ?? null,
    actor?.email ?? actorOverride?.email ?? null,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    JSON.stringify(metadata || {}),
    req.ip || null
  );
}
const emailProvider = String(process.env.EMAIL_PROVIDER || (process.env.NODE_ENV === 'production' ? 'none' : 'console')).toLowerCase();
function emailDeliveryReady() {
  if (emailProvider === 'console') return process.env.NODE_ENV !== 'production';
  return emailProvider === 'resend' && Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}
function escapeEmailHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[char]));
}
async function sendEmail({ to, subject, html, text }) {
  if (emailProvider === 'console' && process.env.NODE_ENV !== 'production') {
    console.log(`\n[EMAIL DEVELOPMENT ONLY]\nTo: ${to}\nSubject: ${subject}\n${text || html}\n`);
    return;
  }
  if (!emailDeliveryReady()) throw new Error('Layanan email belum dikonfigurasi.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'buku-kas-website/1.1'
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text })
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.error(`Email provider returned HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
    throw new Error('Email tidak dapat dikirim.');
  }
}
function createAuthToken(userId, purpose, minutes) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM auth_tokens WHERE user_id=? AND purpose=?').run(userId, purpose);
  db.prepare('INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at_ms) VALUES(?,?,?,?)')
    .run(userId, purpose, tokenHash, Date.now() + minutes * 60 * 1000);
  return token;
}
async function sendVerificationEmail(user) {
  if (!emailDeliveryReady()) throw new Error('Pengiriman email belum dikonfigurasi.');
  const token = createAuthToken(user.id, 'verify_email', 30);
  const link = `${BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: user.email,
      subject: 'Verifikasi email Buku Kas',
      html: `<p>Halo ${escapeEmailHtml(user.name)},</p><p>Konfirmasi alamat email untuk mengaktifkan akun Buku Kas.</p><p><a href=\"${link}\">Verifikasi alamat email</a></p><p>Tautan berlaku 30 menit dan hanya dapat digunakan sekali.</p>`,
      text: `Halo ${user.name}, buka tautan berikut untuk verifikasi email (berlaku 30 menit): ${link}`
    });
  } catch (error) {
    db.prepare('DELETE FROM auth_tokens WHERE user_id=? AND purpose=\'verify_email\'').run(user.id);
    throw error;
  }
}
async function sendPasswordResetEmail(user) {
  if (!emailDeliveryReady()) throw new Error('Pengiriman email belum dikonfigurasi.');
  const token = createAuthToken(user.id, 'reset_password', 20);
  const link = `${BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: user.email,
      subject: 'Atur ulang password Buku Kas',
      html: `<p>Halo ${escapeEmailHtml(user.name)},</p><p>Gunakan tautan berikut untuk membuat password baru.</p><p><a href=\"${link}\">Atur ulang password</a></p><p>Tautan berlaku 20 menit. Abaikan email ini bila kamu tidak meminta reset password.</p>`,
      text: `Atur ulang password Buku Kas (berlaku 20 menit): ${link}`
    });
  } catch (error) {
    db.prepare('DELETE FROM auth_tokens WHERE user_id=? AND purpose=\'reset_password\'').run(user.id);
    throw error;
  }
}
function findValidAuthToken(token, purpose) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return db.prepare('SELECT t.*,u.email,u.name,u.role,u.is_active FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose=? AND t.expires_at_ms>?')
    .get(tokenHash, purpose, Date.now()) || null;
}

function asyncSessionLogin(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.sessionVersion = Number(user.session_version || 1);
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save(saveErr => saveErr ? reject(saveErr) : resolve(req.session.csrfToken));
    });
  });
}
function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const supplied = req.get('x-csrf-token');
  if (!expected || !supplied || Buffer.byteLength(expected) !== Buffer.byteLength(String(supplied)) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(supplied)))) {
    return res.status(403).json({ error: 'Sesi keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.' });
  }
  next();
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user || !user.is_active) return res.status(401).json({ error: 'Silakan login kembali.' });
  if (user.role !== 'user') return res.status(403).json({ error: 'Endpoint ini khusus akun pengguna.' });
  req.user = user;
  next();
}

// Pencocokan CIDR IPv4/IPv6 agar panel admin bisa dibatasi ke LAN dan IP internet tepercaya.
function parseIp(ip) {
  let value = String(ip || '').split('%')[0].toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number);
    if (parts.some(n => n < 0 || n > 255)) return null;
    return { version: 4, value: parts.reduce((acc, part) => (acc << 8n) | BigInt(part), 0n), bits: 32 };
  }
  if (!value.includes(':')) return null;
  let groups;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.concat(right).some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  }
  const hex = groups.join('').padStart(32, '0');
  return { version: 6, value: BigInt(`0x${hex}`), bits: 128 };
}
function cidrMatches(ip, cidr) {
  const [networkText, prefixText] = String(cidr).trim().split('/');
  const address = parseIp(ip);
  const network = parseIp(networkText);
  if (!address || !network || address.version !== network.version) return false;
  const prefix = prefixText === undefined ? address.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) return false;
  const shift = BigInt(address.bits - prefix);
  return (address.value >> shift) === (network.value >> shift);
}
function adminNetworkAllowed(ip) {
  const configured = String(process.env.ADMIN_ALLOWED_CIDRS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = configured.length ? configured : [
    '127.0.0.1/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12',
    '192.168.0.0/16', 'fc00::/7', 'fe80::/10'
  ];
  return allow.some(cidr => cidrMatches(ip, cidr));
}
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user || !user.is_active) return res.status(401).json({ error: 'Silakan login kembali.' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Akses khusus admin.' });
  if (!adminNetworkAllowed(req.ip)) return res.status(403).json({ error: 'Panel admin hanya tersedia dari jaringan lokal atau IP internet yang diizinkan.' });
  req.user = user;
  next();
}
function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false; const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === value; }
function validateRecord(body) {
  const date = String(body.date || '');
  const description = String(body.description || '').trim();
  const type = String(body.type || '');
  const amount = Number(body.amount);
  if (!validDate(date)) throw new Error('Tanggal tidak valid.');
  if (!description || description.length > 200) throw new Error('Keterangan wajib diisi dan maksimal 200 karakter.');
  if (!['Masuk', 'Keluar'].includes(type)) throw new Error('Jenis transaksi tidak valid.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000) throw new Error('Nominal harus lebih dari 0.');
  return { date, description, type, amount };
}
function validateName(value, label = 'Nama') {
  const name = String(value || '').trim();
  if (!name || name.length > 100) throw new Error(`${label} wajib diisi dan maksimal 100 karakter.`);
  return name;
}
function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return id;
}
function dbErrorMessage(err) {
  if (String(err?.message || '').includes('UNIQUE constraint failed')) return 'Data dengan nama tersebut sudah ada.';
  if (String(err?.message || '').includes('FOREIGN KEY constraint failed')) return 'Data masih terhubung dengan data lain.';
  return err?.message || 'Terjadi kesalahan.';
}

// Google OAuth hanya dipasang jika credential sudah dikonfigurasi.
const googleReady = process.env.ENABLE_GOOGLE_OAUTH === 'true' && Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (googleReady) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`
  }, (accessToken, refreshToken, profile, done) => {
    try {
      const email = String(profile.emails?.[0]?.value || '').toLowerCase();
      const verified = profile._json?.email_verified === true;
      if (!email || !verified) return done(null, false, { message: 'Email Google belum terverifikasi.' });
      let user = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(profile.id, email);
      if (user?.role === 'admin') return done(null, false, { message: 'Akun admin tidak dapat masuk melalui Google.' });
      if (user && !user.google_id) {
        db.prepare("UPDATE users SET google_id = ?, email_verified_at=COALESCE(email_verified_at,datetime('now')), updated_at = datetime('now') WHERE id = ?").run(profile.id, user.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }
      if (!user) {
        const name = String(profile.displayName || email.split('@')[0]).slice(0, 100);
        const result = db.prepare("INSERT INTO users (name,email,google_id,role,email_verified_at) VALUES (?,?,?,'user',datetime('now'))").run(name, email, profile.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      }
      if (!user.is_active) return done(null, false, { message: 'Akun dinonaktifkan. Hubungi admin.' });
      return done(null, user);
    } catch (err) { return done(err); }
  }));
}

// ---------- AUTH ----------
app.get('/api/auth/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.csrfToken, googleEnabled: googleReady });
});
app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user || !user.is_active) return res.json({ user: null, googleEnabled: googleReady });
  if (user.role === 'admin' && !adminNetworkAllowed(req.ip)) return res.status(403).json({ error: 'Jaringan tidak diizinkan untuk panel admin.' });
  res.json({ user: safeUser(user), googleEnabled: googleReady });
});
app.post('/api/auth/register', authLimiter, requireCsrf, async (req, res) => {
  try {
    const name = validateName(req.body.name, 'Nama');
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 190) return res.status(400).json({ error: 'Format email tidak valid.' });
    if (password.length < 12 || password.length > 100) return res.status(400).json({ error: 'Password minimal 12 karakter.' });
    if (!emailDeliveryReady()) return res.status(503).json({ error: 'Pendaftaran sementara belum tersedia karena layanan email belum dikonfigurasi oleh pengelola.' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email sudah terdaftar.' });
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'user')").run(name, email, hash);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    try {
      await sendVerificationEmail(user);
    } catch (mailError) {
      console.error('Verification email could not be sent:', mailError.message);
      recordActivity(req, 'register_email_delivery_failed', 'account', user.id, {}, user);
      return res.status(503).json({ error: 'Akun tercatat, tetapi email verifikasi belum terkirim. Coba login kembali setelah layanan email siap untuk meminta tautan baru.' });
    }
    recordActivity(req, 'register_pending_verification', 'account', user.id, {}, user);
    res.status(201).json({ message: 'Akun dibuat. Periksa email untuk verifikasi sebelum login.' });
  } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
});
app.post('/api/auth/login', loginLimiter, requireCsrf, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }
    if (!user.is_active) return res.status(403).json({ error: 'Akun dinonaktifkan. Hubungi admin.' });
    if (user.role !== 'user') return res.status(403).json({ error: 'Gunakan halaman login admin.' });
    if (!user.email_verified_at) {
      let message = 'Email belum terverifikasi. Coba lagi setelah layanan email tersedia.';
      if (emailDeliveryReady()) {
        try { await sendVerificationEmail(user); message = 'Email belum terverifikasi. Tautan verifikasi baru telah dikirim.'; }
        catch (mailError) { console.error('Verification resend failed:', mailError.message); }
      }
      recordActivity(req, 'login_unverified_email', 'account', user.id, {}, user);
      return res.status(403).json({ error: message, code: 'EMAIL_NOT_VERIFIED' });
    }
    const csrfToken = await asyncSessionLogin(req, user);
    recordActivity(req, 'login', 'account', user.id, {}, user);
    res.json({ user: safeUser(user), csrfToken });
  } catch (err) { res.status(500).json({ error: 'Login gagal diproses.' }); }
});
app.post('/api/auth/forgot-password', recoveryLimiter, async (req, res) => {
  const genericMessage = 'Jika email terdaftar dan sudah terverifikasi, tautan pemulihan akan dikirim.';
  const email = String(req.body.email || '').trim().toLowerCase();
  if (/^\S+@\S+\.\S+$/.test(email) && emailDeliveryReady()) {
    const user = db.prepare("SELECT * FROM users WHERE email=? AND role='user' AND is_active=1 AND email_verified_at IS NOT NULL").get(email);
    if (user) {
      try {
        await sendPasswordResetEmail(user);
        recordActivity(req, 'password_reset_requested', 'account', user.id, {}, user);
      } catch (mailError) {
        console.error('Password reset email could not be sent:', mailError.message);
      }
    }
  }
  res.json({ message: genericMessage });
});
app.post('/api/auth/verify-email', recoveryLimiter, (req, res) => {
  const row = findValidAuthToken(req.body.token, 'verify_email');
  if (!row || row.role !== 'user' || !row.is_active) return res.status(400).json({ error: 'Tautan verifikasi tidak valid atau sudah kedaluwarsa. Login kembali untuk meminta tautan baru.' });
  const complete = db.transaction(() => {
    db.prepare("UPDATE users SET email_verified_at=COALESCE(email_verified_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND role='user'").run(row.user_id);
    db.prepare('DELETE FROM auth_tokens WHERE id=?').run(row.id);
  });
  complete();
  recordActivity(req, 'email_verified', 'account', row.user_id, {}, { id: row.user_id, email: row.email });
  res.json({ ok: true, message: 'Email berhasil diverifikasi. Silakan login.' });
});
app.post('/api/auth/reset-password', recoveryLimiter, async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 12 || password.length > 100) return res.status(400).json({ error: 'Password baru minimal 12 karakter.' });
  const row = findValidAuthToken(req.body.token, 'reset_password');
  if (!row || row.role !== 'user' || !row.is_active) return res.status(400).json({ error: 'Tautan reset password tidak valid atau sudah kedaluwarsa.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const update = db.transaction(() => {
      db.prepare("UPDATE users SET password_hash=?,session_version=session_version+1,updated_at=datetime('now') WHERE id=? AND role='user'").run(hash, row.user_id);
      db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(row.user_id);
    });
    update();
    recordActivity(req, 'password_reset_completed', 'account', row.user_id, {}, { id: row.user_id, email: row.email });
    res.json({ ok: true, message: 'Password berhasil diperbarui. Silakan login dengan password baru.' });
  } catch (err) { res.status(500).json({ error: 'Reset password gagal diproses.' }); }
});
app.post('/api/auth/admin/login', loginLimiter, requireCsrf, async (req, res) => {
  try {
    if (!adminNetworkAllowed(req.ip)) return res.status(403).json({ error: 'Jaringan ini tidak diizinkan untuk login admin.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'admin'").get(email);
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      recordActivity(req, 'admin_login_failed', 'account', null, { email }, { email });
      return res.status(401).json({ error: 'Kredensial admin tidak valid.' });
    }
    if (!user.is_active) return res.status(403).json({ error: 'Akun admin dinonaktifkan.' });
    const csrfToken = await asyncSessionLogin(req, user);
    recordActivity(req, 'admin_login', 'account', user.id, {}, user);
    res.json({ user: safeUser(user), csrfToken });
  } catch (err) { res.status(500).json({ error: 'Login admin gagal diproses.' }); }
});
app.post('/api/auth/logout', requireCsrf, (req, res) => {
  const user = currentUser(req);
  if (user) recordActivity(req, 'logout', 'account', user.id, {}, user);
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Gagal mengakhiri sesi.' });
    res.clearCookie('buku_kas.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

if (googleReady) {
  app.get('/auth/google', (req, res, next) => passport.authenticate('google', { scope: ['profile', 'email'], state: true })(req, res, next));
  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?google=failed', session: false }), async (req, res, next) => {
    try {
      await asyncSessionLogin(req, req.user);
      recordActivity(req, 'login_google', 'account', req.user.id, {}, req.user);
      res.redirect('/');
    } catch (err) { next(err); }
  });
} else {
  app.get('/auth/google', (req, res) => res.status(503).send('Login Google belum dikonfigurasi. Isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di file .env.'));
  app.get('/auth/google/callback', (req, res) => res.redirect('/?google=not-configured'));
}

// ---------- USER DATA: DASHBOARD ----------
app.get('/api/dashboard', requireAuth, (req, res) => {
  const id = req.user.id;
  const cash = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN type='Masuk' THEN amount ELSE 0 END),0) AS totalIn,
    COALESCE(SUM(CASE WHEN type='Keluar' THEN amount ELSE 0 END),0) AS totalOut
    FROM transactions WHERE user_id=?`).get(id);
  const profit = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN type='Masuk' THEN amount ELSE 0 END),0) AS totalIn,
    COALESCE(SUM(CASE WHEN type='Keluar' THEN amount ELSE 0 END),0) AS totalOut
    FROM profits WHERE user_id=?`).get(id);
  const recentRows = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC,id DESC LIMIT 5').all(id);
  const recent = recentRows.map(row => ({ ...row, items: transactionLines(row.id, id) }));
  recordActivity(req, 'dashboard_view', 'dashboard');
  res.json({ cash: { ...cash, balance: cash.totalIn - cash.totalOut }, profit: { ...profit, balance: profit.totalIn - profit.totalOut }, recent });
});

function registerLedgerRoutes(route, table, label) {
  app.get(route, requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY date DESC,id DESC`).all(req.user.id);
    const items = table === 'transactions' ? rows.map(row => ({ ...row, items: transactionLines(row.id, req.user.id) })) : rows;
    recordActivity(req, `${label}_list_view`, label);
    res.json({ items });
  });
  app.post(route, requireAuth, (req, res) => {
    try {
      if (table === 'transactions') {
        const saved = saveTransaction(req);
        recordActivity(req, 'transaction_create', 'transaction', saved.transactionId, { description: saved.description, type: saved.type, amount: saved.amount, productCount: saved.items.length });
        return res.status(201).json({ item: { ...db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(saved.transactionId, req.user.id), items: transactionLines(saved.transactionId, req.user.id) } });
      }
      const item = validateRecord(req.body);
      const result = db.prepare(`INSERT INTO ${table} (user_id,date,description,type,amount) VALUES (?,?,?,?,?)`)
        .run(req.user.id, item.date, item.description, item.type, item.amount);
      recordActivity(req, `${label}_create`, label, result.lastInsertRowid, { description: item.description, type: item.type, amount: item.amount });
      res.status(201).json({ item: db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(result.lastInsertRowid, req.user.id) });
    } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
  });
  app.put(`${route}/:id`, requireAuth, (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
      if (table === 'transactions') {
        const saved = saveTransaction(req, id);
        recordActivity(req, 'transaction_update', 'transaction', id, { description: saved.description, type: saved.type, amount: saved.amount, productCount: saved.items.length });
        return res.json({ item: { ...db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(id, req.user.id), items: transactionLines(id, req.user.id) } });
      }
      const existing = db.prepare('SELECT * FROM profits WHERE id=? AND user_id=?').get(id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Data tidak ditemukan.' });
      if (existing.source_transaction_id) return res.status(409).json({ error: 'Keuntungan otomatis mengikuti transaksi penjualan. Edit transaksi penjualannya dari Buku Kas.' });
      const item = validateRecord(req.body);
      const result = db.prepare(`UPDATE ${table} SET date=?,description=?,type=?,amount=?,updated_at=datetime('now') WHERE id=? AND user_id=?`)
        .run(item.date, item.description, item.type, item.amount, id, req.user.id);
      if (!result.changes) return res.status(404).json({ error: 'Data tidak ditemukan.' });
      recordActivity(req, `${label}_update`, label, id, { description: item.description, type: item.type, amount: item.amount });
      res.json({ item: db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id, req.user.id) });
    } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
  });
  app.delete(`${route}/:id`, requireAuth, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    const old = db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id, req.user.id);
    if (!old) return res.status(404).json({ error: 'Data tidak ditemukan.' });
    if (table === 'profits' && old.source_transaction_id) return res.status(409).json({ error: 'Keuntungan otomatis mengikuti transaksi penjualan. Hapus transaksi penjualannya dari Buku Kas.' });
    if (table === 'transactions') {
      const remove = db.transaction(() => {
        restoreTransactionStock(id, req.user.id);
        db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(id, req.user.id);
      });
      remove();
    } else {
      db.prepare(`DELETE FROM ${table} WHERE id=? AND user_id=?`).run(id, req.user.id);
    }
    recordActivity(req, `${label}_delete`, label, id, { description: old.description, amount: old.amount });
    res.json({ ok: true });
  });
}
registerLedgerRoutes('/api/transactions', 'transactions', 'transaction');
registerLedgerRoutes('/api/profits', 'profits', 'profit');

// ---------- STOCK ----------
app.get('/api/categories', requireAuth, (req, res) => {
  recordActivity(req, 'stock_view', 'stock');
  res.json({ items: db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY name COLLATE NOCASE').all(req.user.id) });
});
app.post('/api/categories', requireAuth, (req, res) => {
  try {
    const name = validateName(req.body.name, 'Nama kategori');
    const result = db.prepare('INSERT INTO categories(user_id,name) VALUES(?,?)').run(req.user.id, name);
    recordActivity(req, 'category_create', 'category', result.lastInsertRowid, { name });
    res.status(201).json({ item: { id: result.lastInsertRowid, name } });
  } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
});
app.put('/api/categories/:id', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id); const name = validateName(req.body.name, 'Nama kategori');
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    const result = db.prepare('UPDATE categories SET name=? WHERE id=? AND user_id=?').run(name, id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
    recordActivity(req, 'category_update', 'category', id, { name });
    res.json({ item: { id, name } });
  } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
});
app.delete('/api/categories/:id', requireAuth, (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
  const row = db.prepare('SELECT name FROM categories WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
  const count = db.prepare('SELECT COUNT(*) AS count FROM products WHERE category_id=? AND user_id=?').get(id, req.user.id).count;
  db.prepare('DELETE FROM categories WHERE id=? AND user_id=?').run(id, req.user.id);
  recordActivity(req, 'category_delete', 'category', id, { name: row.name, deletedProducts: count });
  res.json({ ok: true, deletedProducts: count });
});
function calculateProductPricing(body) {
  const unitCost = Number(body.unitCost ?? 0);
  const pricingMethod = String(body.pricingMethod || 'manual');
  const pricingValue = Number(body.pricingValue ?? 0);
  let salePrice;
  if (!Number.isSafeInteger(unitCost) || unitCost <= 0 || unitCost > 1_000_000_000_000) throw new Error('HPP/modal per unit harus lebih dari 0 dan berupa angka rupiah bulat.');
  if (!Number.isFinite(pricingValue) || pricingValue < 0 || pricingValue > 1_000_000_000 || (pricingMethod === 'fixed' && !Number.isSafeInteger(pricingValue))) throw new Error('Nilai metode harga jual tidak valid.');
  if (pricingMethod === 'manual') {
    salePrice = Number(body.salePrice ?? body.price);
  } else if (pricingMethod === 'markup') {
    salePrice = unitCost * (1 + pricingValue / 100);
  } else if (pricingMethod === 'margin') {
    if (pricingValue >= 100) throw new Error('Target margin harus kurang dari 100%.');
    salePrice = unitCost / (1 - pricingValue / 100);
  } else if (pricingMethod === 'fixed') {
    salePrice = unitCost + pricingValue;
  } else {
    throw new Error('Metode harga jual tidak dikenal.');
  }
  salePrice = Math.round(salePrice);
  if (!Number.isSafeInteger(salePrice) || salePrice <= 0 || salePrice > 1_000_000_000_000) throw new Error('Harga jual harus lebih dari 0 dan masih dalam batas yang didukung.');
  return { unitCost, salePrice, pricingMethod, pricingValue };
}
function transactionLines(transactionId, userId) {
  return db.prepare(`SELECT id,product_id,product_name,quantity,unit_sale_price,unit_cost,line_total,line_profit
    FROM transaction_items WHERE transaction_id=? AND user_id=? ORDER BY id`).all(transactionId, userId);
}
function restoreTransactionStock(transactionId, userId) {
  const lines = transactionLines(transactionId, userId);
  const restore = db.prepare('UPDATE products SET stock=stock+?,updated_at=datetime(\'now\') WHERE id=? AND user_id=?');
  for (const line of lines) {
    if (line.product_id) restore.run(line.quantity, line.product_id, userId);
  }
  db.prepare('DELETE FROM transaction_items WHERE transaction_id=? AND user_id=?').run(transactionId, userId);
  db.prepare('DELETE FROM profits WHERE source_transaction_id=? AND user_id=?').run(transactionId, userId);
}
function saveTransaction(req, id = null) {
  const body = req.body || {};
  const hasItems = Array.isArray(body.items) && body.items.length > 0;
  if (hasItems && String(body.type) !== 'Masuk') throw new Error('Produk katalog hanya bisa digunakan untuk transaksi Masuk.');
  if (Array.isArray(body.items) && body.items.length > 50) throw new Error('Maksimal 50 baris produk dalam satu transaksi.');
  let manual = null;
  if (!hasItems) manual = validateRecord(body);
  else {
    if (!validDate(body.date)) throw new Error('Tanggal tidak valid.');
    if (body.description && String(body.description).trim().length > 200) throw new Error('Keterangan maksimal 200 karakter.');
  }
  const userId = req.user.id;
  const save = db.transaction(() => {
    let old = null;
    if (id) {
      old = db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(id, userId);
      if (!old) throw new Error('Data transaksi tidak ditemukan.');
      restoreTransactionStock(id, userId);
    }
    let description, type, amount, date;
    let normalizedLines = [];
    if (hasItems) {
      date = String(body.date);
      const aggregate = new Map();
      for (const raw of body.items) {
        const productId = parseId(raw.productId);
        const quantity = Number(raw.quantity);
        if (!productId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new Error('Produk atau jumlah barang tidak valid.');
        const product = db.prepare(`SELECT id,name,stock,unit_cost,sale_price,price FROM products WHERE id=? AND user_id=?`).get(productId, userId);
        if (!product) throw new Error('Salah satu produk tidak ditemukan pada katalog Anda.');
        if (product.unit_cost <= 0) throw new Error(`Isi HPP/modal per unit untuk produk "${product.name}" sebelum dijual.`);
        const unitSalePrice = raw.unitSalePrice === undefined || raw.unitSalePrice === '' ? Number(product.sale_price || product.price) : Number(raw.unitSalePrice);
        if (!Number.isSafeInteger(unitSalePrice) || unitSalePrice <= 0 || unitSalePrice > 1_000_000_000_000) throw new Error(`Harga jual produk "${product.name}" tidak valid.`);
        const lineTotal = unitSalePrice * quantity;
        const lineProfit = (unitSalePrice - Number(product.unit_cost)) * quantity;
        if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(lineProfit)) throw new Error(`Nilai transaksi produk \"${product.name}\" melebihi batas yang didukung.`);
        aggregate.set(productId, (aggregate.get(productId) || 0) + quantity);
        normalizedLines.push({ productId, productName: product.name, quantity, unitSalePrice, unitCost: Number(product.unit_cost), lineTotal, lineProfit });
      }
      for (const [productId, quantity] of aggregate) {
        const product = db.prepare('SELECT name,stock FROM products WHERE id=? AND user_id=?').get(productId, userId);
        if (!product || product.stock < quantity) throw new Error(`Stok produk "${product?.name || ''}" tidak mencukupi. Stok tersedia: ${product?.stock ?? 0}.`);
      }
      amount = normalizedLines.reduce((sum, line) => sum + line.lineTotal, 0);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) throw new Error('Total penjualan tidak valid.');
      type = 'Masuk';
      description = String(body.description || '').trim() || `Penjualan ${normalizedLines.length} jenis produk`;
    } else {
      ({ date, description, type, amount } = manual);
    }
    let transactionId = id;
    if (id) {
      db.prepare(`UPDATE transactions SET date=?,description=?,type=?,amount=?,updated_at=datetime('now') WHERE id=? AND user_id=?`)
        .run(date, description, type, amount, id, userId);
    } else {
      transactionId = Number(db.prepare('INSERT INTO transactions(user_id,date,description,type,amount) VALUES(?,?,?,?,?)')
        .run(userId, date, description, type, amount).lastInsertRowid);
    }
    if (hasItems) {
      const insertLine = db.prepare(`INSERT INTO transaction_items(user_id,transaction_id,product_id,product_name,quantity,unit_sale_price,unit_cost,line_total,line_profit)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      const decrement = db.prepare(`UPDATE products SET stock=stock-?,updated_at=datetime('now') WHERE id=? AND user_id=? AND stock>=?`);
      const aggregate = new Map();
      for (const line of normalizedLines) {
        insertLine.run(userId, transactionId, line.productId, line.productName, line.quantity, line.unitSalePrice, line.unitCost, line.lineTotal, line.lineProfit);
        aggregate.set(line.productId, (aggregate.get(line.productId) || 0) + line.quantity);
      }
      for (const [productId, quantity] of aggregate) {
        const result = decrement.run(quantity, productId, userId, quantity);
        if (!result.changes) throw new Error('Stok berubah saat transaksi diproses. Muat ulang dan coba kembali.');
      }
      const netProfit = normalizedLines.reduce((sum, line) => sum + line.lineProfit, 0);
      if (netProfit !== 0) {
        db.prepare(`INSERT INTO profits(user_id,date,description,type,amount,source_transaction_id)
          VALUES(?,?,?,?,?,?)`).run(userId, date, `Margin penjualan: ${description}`, netProfit > 0 ? 'Masuk' : 'Keluar', Math.abs(netProfit), transactionId);
      }
    }
    return { transactionId, description, type, amount, items: normalizedLines };
  });
  return save();
}
app.get('/api/products', requireAuth, (req, res) => {
  recordActivity(req, 'product_list_view', 'product');
  const items = db.prepare(`SELECT p.*,c.name AS category_name FROM products p
    JOIN categories c ON c.id=p.category_id AND c.user_id=p.user_id
    WHERE p.user_id=? ORDER BY c.name COLLATE NOCASE,p.name COLLATE NOCASE`).all(req.user.id);
  res.json({ items });
});
app.post('/api/products', requireAuth, (req, res) => {
  try {
    const categoryId = parseId(req.body.categoryId); const name = validateName(req.body.name, 'Nama barang');
    const pricing = calculateProductPricing(req.body);
    if (!categoryId || !db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(categoryId, req.user.id)) return res.status(400).json({ error: 'Kategori tidak valid.' });
    const result = db.prepare(`INSERT INTO products(user_id,category_id,name,price,unit_cost,sale_price,pricing_method,pricing_value)
      VALUES(?,?,?,?,?,?,?,?)`).run(req.user.id, categoryId, name, pricing.salePrice, pricing.unitCost, pricing.salePrice, pricing.pricingMethod, pricing.pricingValue);
    recordActivity(req, 'product_create', 'product', result.lastInsertRowid, { name, ...pricing, categoryId });
    res.status(201).json({ item: db.prepare('SELECT p.*,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.user_id=?').get(result.lastInsertRowid, req.user.id) });
  } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
});
app.put('/api/products/:id', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id); const categoryId = parseId(req.body.categoryId); const name = validateName(req.body.name, 'Nama barang');
    const pricing = calculateProductPricing(req.body);
    if (!id || !categoryId || !db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(categoryId, req.user.id)) return res.status(400).json({ error: 'ID atau kategori tidak valid.' });
    const result = db.prepare(`UPDATE products SET category_id=?,name=?,price=?,unit_cost=?,sale_price=?,pricing_method=?,pricing_value=?,updated_at=datetime('now')
      WHERE id=? AND user_id=?`).run(categoryId, name, pricing.salePrice, pricing.unitCost, pricing.salePrice, pricing.pricingMethod, pricing.pricingValue, id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
    recordActivity(req, 'product_update', 'product', id, { name, ...pricing, categoryId });
    res.json({ item: db.prepare('SELECT p.*,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.user_id=?').get(id, req.user.id) });
  } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
});
app.delete('/api/products/:id', requireAuth, (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
  const old = db.prepare('SELECT name FROM products WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!old) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
  db.prepare('DELETE FROM products WHERE id=? AND user_id=?').run(id, req.user.id);
  recordActivity(req, 'product_delete', 'product', id, old);
  res.json({ ok: true });
});
app.post('/api/products/:id/stock', requireAuth, (req, res) => {
  const id = parseId(req.params.id); const delta = Number(req.body.delta);
  if (!id || ![-1, 1].includes(delta)) return res.status(400).json({ error: 'Perubahan stok tidak valid.' });
  const result = db.prepare('UPDATE products SET stock=stock+?,updated_at=datetime(\'now\') WHERE id=? AND user_id=? AND stock+?>=0').run(delta, id, req.user.id, delta);
  if (!result.changes) return res.status(409).json({ error: 'Barang tidak ditemukan atau stok tidak boleh kurang dari nol.' });
  const item = db.prepare('SELECT id,name,stock FROM products WHERE id=? AND user_id=?').get(id, req.user.id);
  recordActivity(req, delta > 0 ? 'stock_increase' : 'stock_decrease', 'product', id, { name: item.name, stock: item.stock });
  res.json({ item });
});

// ---------- REPORTS / BACKUP ----------
app.get('/api/reports', requireAuth, (req, res) => {
  const from = validDate(req.query.from) ? req.query.from : '2000-01-01';
  const to = validDate(req.query.to) ? req.query.to : '2100-12-31';
  if (from > to) return res.status(400).json({ error: 'Tanggal awal tidak boleh melewati tanggal akhir.' });
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date DESC,id DESC').all(req.user.id, from, to);
  const items = rows.map(row => ({ ...row, items: transactionLines(row.id, req.user.id) }));
  recordActivity(req, 'report_view', 'report', null, { from, to, count: items.length });
  const totalIn = items.filter(x => x.type === 'Masuk').reduce((s, x) => s + x.amount, 0);
  const totalOut = items.filter(x => x.type === 'Keluar').reduce((s, x) => s + x.amount, 0);
  res.json({ items, totalIn, totalOut, balance: totalIn - totalOut, from, to });
});
app.get('/api/settings/backup', requireAuth, (req, res) => {
  const id = req.user.id;
  const transactions = db.prepare('SELECT id,date,description,type,amount FROM transactions WHERE user_id=? ORDER BY date,id').all(id)
    .map(row => ({ ...row, items: transactionLines(row.id, id) }));
  const backup = {
    format: 'buku-kas-backup-v2', exportedAt: new Date().toISOString(),
    transactions,
    profits: db.prepare('SELECT id,date,description,type,amount,source_transaction_id FROM profits WHERE user_id=? ORDER BY date,id').all(id),
    categories: db.prepare('SELECT id,name FROM categories WHERE user_id=? ORDER BY name').all(id),
    products: db.prepare(`SELECT p.id,c.name AS category,p.name,p.stock,p.price,p.unit_cost,p.sale_price,p.pricing_method,p.pricing_value FROM products p JOIN categories c ON c.id=p.category_id WHERE p.user_id=? ORDER BY c.name,p.name`).all(id)
  };
  recordActivity(req, 'backup_export', 'backup', null, { transactionCount: backup.transactions.length, productCount: backup.products.length });
  res.setHeader('Content-Disposition', `attachment; filename="buku-kas-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});
app.post('/api/settings/restore', requireAuth, (req, res) => {
  const input = req.body.backup;
  const formatOk = input && ['buku-kas-backup-v1', 'buku-kas-backup-v2'].includes(input.format);
  if (!formatOk || !Array.isArray(input.transactions) || !Array.isArray(input.profits) || !Array.isArray(input.categories) || !Array.isArray(input.products)) {
    return res.status(400).json({ error: 'Format file backup tidak dikenali.' });
  }
  if (input.transactions.length + input.profits.length + input.categories.length + input.products.length > 10000) return res.status(400).json({ error: 'Backup terlalu besar.' });
  const id = req.user.id;
  const restoreTx = db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM profits WHERE user_id=?').run(id);
    db.prepare('DELETE FROM products WHERE user_id=?').run(id);
    db.prepare('DELETE FROM categories WHERE user_id=?').run(id);
    const catIds = new Map();
    const categoryOldToNew = new Map();
    for (const c of input.categories) {
      const name = validateName(c.name, 'Nama kategori');
      const r = db.prepare('INSERT INTO categories(user_id,name) VALUES(?,?)').run(id, name);
      catIds.set(name, Number(r.lastInsertRowid));
      if (c.id != null) categoryOldToNew.set(Number(c.id), Number(r.lastInsertRowid));
    }
    const productOldToNew = new Map();
    for (const p of input.products) {
      const categoryId = catIds.get(String(p.category));
      const name = validateName(p.name, 'Nama barang'); const stock = Number(p.stock);
      const unitCost = Number(p.unit_cost ?? 0);
      const salePrice = Number(p.sale_price ?? p.price);
      const pricingMethod = ['manual','markup','margin','fixed'].includes(p.pricing_method) ? p.pricing_method : 'manual';
      const pricingValue = Number(p.pricing_value ?? 0);
      if (!categoryId || !Number.isSafeInteger(stock) || stock < 0 || !Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(salePrice) || salePrice < 0 || !Number.isFinite(pricingValue) || pricingValue < 0) throw new Error('Data barang pada backup tidak valid.');
      const result = db.prepare(`INSERT INTO products(user_id,category_id,name,stock,price,unit_cost,sale_price,pricing_method,pricing_value)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, categoryId, name, stock, salePrice, unitCost, salePrice, pricingMethod, pricingValue);
      if (p.id != null) productOldToNew.set(Number(p.id), Number(result.lastInsertRowid));
    }
    const transactionOldToNew = new Map();
    for (const row of input.transactions) {
      const v = validateRecord(row);
      const result = db.prepare('INSERT INTO transactions(user_id,date,description,type,amount) VALUES(?,?,?,?,?)').run(id,v.date,v.description,v.type,v.amount);
      const newTransactionId = Number(result.lastInsertRowid);
      if (row.id != null) transactionOldToNew.set(Number(row.id), newTransactionId);
      if (input.format === 'buku-kas-backup-v2' && Array.isArray(row.items)) {
        for (const line of row.items) {
          const productId = line.product_id == null ? null : (productOldToNew.get(Number(line.product_id)) || null);
          const quantity = Number(line.quantity); const unitSalePrice = Number(line.unit_sale_price);
          const unitCost = Number(line.unit_cost); const lineTotal = Number(line.line_total); const lineProfit = Number(line.line_profit);
          if (!Number.isSafeInteger(quantity) || quantity < 1 || ![unitSalePrice,unitCost,lineTotal,lineProfit].every(Number.isFinite) || unitSalePrice < 0 || unitCost < 0 || lineTotal < 0) throw new Error('Rincian barang transaksi pada backup tidak valid.');
          db.prepare(`INSERT INTO transaction_items(user_id,transaction_id,product_id,product_name,quantity,unit_sale_price,unit_cost,line_total,line_profit)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(id,newTransactionId,productId,validateName(line.product_name,'Nama produk'),quantity,unitSalePrice,unitCost,lineTotal,lineProfit);
        }
      }
    }
    for (const row of input.profits) {
      const v = validateRecord(row);
      const sourceTransactionId = row.source_transaction_id == null ? null : (transactionOldToNew.get(Number(row.source_transaction_id)) || null);
      db.prepare('INSERT INTO profits(user_id,date,description,type,amount,source_transaction_id) VALUES(?,?,?,?,?,?)')
        .run(id,v.date,v.description,v.type,v.amount,sourceTransactionId);
    }
  });
  try {
    restoreTx();
    recordActivity(req, 'backup_restore', 'backup', null, { transactions: input.transactions.length, profits: input.profits.length, products: input.products.length, format: input.format });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: dbErrorMessage(err) }); }
});

// ---------- ADMIN: CROSS-USER VISIBILITY / CONTROL ----------
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active FROM users WHERE role='user'`).get();
  const cash = db.prepare(`SELECT COUNT(*) AS transactionCount, COALESCE(SUM(amount),0) AS transactionVolume FROM transactions`).get();
  const logs = db.prepare('SELECT l.*,u.name AS user_name FROM activity_logs l LEFT JOIN users u ON u.id=l.actor_user_id ORDER BY l.id DESC LIMIT 12').all();
  const profit = db.prepare(`SELECT COUNT(*) AS profitCount,COALESCE(SUM(amount),0) AS profitVolume FROM profits`).get();
  recordActivity(req, 'admin_overview_view', 'admin');
  res.json({ users, cash, profit, recentActivity: logs });
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const search = String(req.query.search || '').trim();
  const users = search
    ? db.prepare(`SELECT u.id,u.name,u.email,u.role,u.is_active,u.email_verified_at,u.created_at,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id) AS transaction_count,
      (SELECT COUNT(*) FROM activity_logs l WHERE l.actor_user_id=u.id) AS activity_count
      FROM users u WHERE u.role='user' AND (u.name LIKE ? OR u.email LIKE ?) ORDER BY u.created_at DESC LIMIT 250`).all(`%${search}%`,`%${search}%`)
    : db.prepare(`SELECT u.id,u.name,u.email,u.role,u.is_active,u.email_verified_at,u.created_at,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id) AS transaction_count,
      (SELECT COUNT(*) FROM activity_logs l WHERE l.actor_user_id=u.id) AS activity_count
      FROM users u WHERE u.role='user' ORDER BY u.created_at DESC LIMIT 250`).all();
  recordActivity(req, 'admin_users_list_view', 'admin', null, { resultCount: users.length });
  res.json({ items: users });
});
app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
  const target = db.prepare("SELECT * FROM users WHERE id=? AND role='user'").get(id);
  if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
  const name = req.body.name === undefined ? target.name : validateName(req.body.name);
  if (req.body.isActive !== undefined && typeof req.body.isActive !== 'boolean') return res.status(400).json({ error: 'Status akun harus berupa boolean.' });
  const active = req.body.isActive === undefined ? target.is_active : (req.body.isActive ? 1 : 0);
  db.prepare("UPDATE users SET name=?,is_active=?,session_version=session_version+CASE WHEN ?=0 THEN 1 ELSE 0 END,updated_at=datetime('now') WHERE id=? AND role='user'").run(name, active, active, id);
  recordActivity(req, 'admin_user_update', 'user', id, { name, isActive: Boolean(active), targetEmail: target.email });
  res.json({ item: safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});
app.get('/api/admin/users/:id/data', requireAdmin, (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
  const user = db.prepare("SELECT id,name,email,role,is_active,email_verified_at,created_at FROM users WHERE id=? AND role='user'").get(id);
  if (!user) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
  const transactionRows = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC,id DESC').all(id);
  const transactions = transactionRows.map(row => ({ ...row, items: transactionLines(row.id, id) }));
  const profits = db.prepare('SELECT * FROM profits WHERE user_id=? ORDER BY date DESC,id DESC').all(id);
  const products = db.prepare('SELECT p.*,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.user_id=? ORDER BY c.name,p.name').all(id);
  const categories = db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY name').all(id);
  const activity = db.prepare('SELECT * FROM activity_logs WHERE actor_user_id=? ORDER BY id DESC LIMIT 100').all(id);
  recordActivity(req, 'admin_view_user_data', 'user', id, { targetEmail: user.email });
  res.json({ user, transactions, profits, products, categories, activity });
});
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const userId = parseId(req.query.userId);
  const action = String(req.query.action || '').trim();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  let sql = `SELECT l.*,u.name AS user_name FROM activity_logs l LEFT JOIN users u ON u.id=l.actor_user_id WHERE 1=1`;
  const args = [];
  if (userId) { sql += ' AND l.actor_user_id=?'; args.push(userId); }
  if (action) { sql += ' AND l.action LIKE ?'; args.push(`%${action}%`); }
  sql += ' ORDER BY l.id DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
  const items = db.prepare(sql).all(...args);
  recordActivity(req, 'admin_activity_log_view', 'admin', null, { resultCount: items.length, limit, offset });
  res.json({ items });
});

// Frontend shell. /admin/login is an entirely separate credential entry point.
app.get(['/','/admin','/admin/login','/forgot-password','/verify-email','/reset-password'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'buku-kas-website' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}]`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('SESSION_SECRET wajib disetel minimal 32 karakter saat production.');
  process.exit(1);
}
app.listen(PORT, HOST, () => {
  console.log(`Buku Kas Website berjalan di ${HOST}:${PORT}`);
  console.log(`URL konfigurasi OAuth: ${BASE_URL}/auth/google/callback`);
  console.log(`Google OAuth: ${googleReady ? 'aktif' : 'ditunda/nonaktif'}`);
  console.log(`Email delivery: ${emailDeliveryReady() ? emailProvider : 'belum dikonfigurasi'}`);
});
