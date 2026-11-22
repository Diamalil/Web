'use strict';
require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const connectSQLite3 = require('connect-sqlite3');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createPostgrestClient } = require('./lib/postgrest');
const { registerPostgresBusinessRoutes } = require('./lib/business-routes');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '');
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || '');
const pg = createPostgrestClient({ supabaseUrl: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY, secretKey: SUPABASE_SECRET_KEY });
const SUPABASE_ORIGIN = (() => {
  try {
    const parsed = new URL(SUPABASE_URL);
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch { return ''; }
})();
const supabaseReady = Boolean(SUPABASE_ORIGIN && SUPABASE_PUBLISHABLE_KEY);
const googleReady = supabaseReady && process.env.ENABLE_GOOGLE_OAUTH === 'true';
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
  supabase_user_id TEXT UNIQUE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  is_active INTEGER NOT NULL DEFAULT 1,
  email_verified_at TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  business_migrated INTEGER NOT NULL DEFAULT 1 CHECK(business_migrated IN (0,1)),
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
ensureColumn('users', 'supabase_user_id', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_user_id ON users(supabase_user_id) WHERE supabase_user_id IS NOT NULL');
ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 1');
// Existing local users are blocked from business endpoints until the one-time PostgreSQL import completes.
ensureColumn('users', 'business_migrated', 'INTEGER NOT NULL DEFAULT 0');
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
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", ...(SUPABASE_ORIGIN ? [SUPABASE_ORIGIN] : [])],
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
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan. Coba lagi beberapa menit.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak percobaan login gagal dari jaringan ini. Coba lagi 15 menit.' } });
const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan pemulihan akun. Coba lagi nanti.' } });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

app.use('/api', writeLimiter, (req, res, next) => {
  const csrfManagedHere = req.path === '/auth/logout';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !csrfManagedHere) return requireCsrf(req, res, next);
  next();
});

function safeUser(row) {
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role, isActive: Boolean(row.is_active), emailVerified: Boolean(row.email_verified_at), businessMigrated: Boolean(row.business_migrated), createdAt: row.created_at } : null;
}
function currentUser(req) {
  return req.user || null;
}
function syncLocalUser(authUser) {
  const email = String(authUser.email || '').trim().toLowerCase();
  if (!authUser.id || !/^\S+@\S+\.\S+$/.test(email)) {
    const error = new Error('Profil Supabase tidak memiliki email yang valid.');
    error.statusCode = 403;
    throw error;
  }
  const verifiedAt = authUser.email_confirmed_at || authUser.confirmed_at || null;
  if (!verifiedAt) {
    const error = new Error('Email belum diverifikasi. Periksa email untuk menyelesaikan aktivasi akun.');
    error.statusCode = 403;
    throw error;
  }
  const metadata = authUser.user_metadata || {};
  const name = String(metadata.display_name || metadata.full_name || email.split('@')[0]).trim().slice(0, 100) || 'Pengguna';
  // Only server-managed app_metadata is trusted for authorization.
  const role = authUser.app_metadata?.role === 'admin' ? 'admin' : 'user';
  let local = db.prepare('SELECT * FROM users WHERE supabase_user_id=?').get(authUser.id);
  if (local) {
    const conflict = db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, local.id);
    if (conflict) {
      const error = new Error('Email ini sudah terhubung ke akun lokal lain. Hubungi administrator untuk penautan akun.');
      error.statusCode = 409;
      throw error;
    }
    db.prepare("UPDATE users SET name=?,email=?,role=?,email_verified_at=COALESCE(email_verified_at,?),updated_at=datetime('now') WHERE id=?")
      .run(name, email, role, verifiedAt, local.id);
  } else {
    // Link verified legacy data only when the email is verified in both systems.
    const legacy = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (legacy) {
      if (!legacy.email_verified_at) {
        const error = new Error('Email sudah digunakan akun lokal yang belum terverifikasi. Hubungi administrator untuk migrasi akun.');
        error.statusCode = 409;
        throw error;
      }
      db.prepare("UPDATE users SET supabase_user_id=?,name=?,role=?,email_verified_at=COALESCE(email_verified_at,?),updated_at=datetime('now') WHERE id=?")
        .run(authUser.id, name, role, verifiedAt, legacy.id);
    } else {
      db.prepare("INSERT INTO users (name,email,supabase_user_id,role,email_verified_at,business_migrated) VALUES (?,?,?,?,?,1)")
        .run(name, email, authUser.id, role, verifiedAt);
    }
  }
  return db.prepare('SELECT * FROM users WHERE supabase_user_id=?').get(authUser.id);
}
async function getSupabaseAuthUser(accessToken) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 401 || response.status === 403) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.msg || payload.message || 'Supabase Auth request failed.');
  return payload;
}
function recordActivity(req, action, entityType, entityId = null, metadata = {}, actorOverride = null) {
  const userId = req.authUser?.id;
  const accessToken = req.accessToken;
  if (!userId || !accessToken) return;
  const actor = actorOverride || currentUser(req);
  const payload = {
    user_id: userId,
    actor_user_id: userId,
    action: String(action || 'unknown').slice(0, 100),
    entity_type: String(entityType || 'unknown').slice(0, 80),
    entity_id: entityId == null ? null : String(entityId),
    metadata: {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      actor_email: actor?.email || null,
      local_actor_id: actor?.id || null,
      ip_address: req.ip || null
    }
  };
  pg.insert('activity_logs', payload, accessToken).catch(error => {
    console.error('[postgres-activity]', error?.code || '', error?.message || error);
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
function requireIdentity(req, res, next) {
  if (req.user) return next();
  if (!supabaseReady) return res.status(503).json({ error: 'Supabase Auth belum dikonfigurasi pada server.' });
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
  if (!match) return res.status(401).json({ error: 'Silakan login kembali.' });
  req.accessToken = match[1];
  getSupabaseAuthUser(match[1]).then(authUser => {
    if (!authUser?.id) return res.status(401).json({ error: 'Sesi login tidak valid atau sudah kedaluwarsa.' });
    let user;
    try { user = syncLocalUser(authUser); }
    catch (error) { return res.status(error.statusCode || 409).json({ error: error.message }); }
    if (!user || !user.is_active) return res.status(403).json({ error: 'Akun dinonaktifkan. Hubungi administrator.' });
    req.authUser = authUser;
    req.user = user;
    return next();
  }).catch(error => {
    console.error('[supabase-auth] User verification failed:', error.message);
    return res.status(503).json({ error: 'Layanan autentikasi sementara tidak tersedia.' });
  });
}
function requireAuth(req, res, next) {
  requireIdentity(req, res, () => {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Endpoint ini khusus akun pengguna.' });
    if (!req.user.business_migrated) return res.status(409).json({ error: 'Data bisnis akun lama belum dipindahkan ke PostgreSQL. Selesaikan proses migrasi data terlebih dahulu.' });
    return next();
  });
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
  requireIdentity(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses khusus admin.' });
    if (!adminNetworkAllowed(req.ip)) return res.status(403).json({ error: 'Panel admin hanya tersedia dari jaringan lokal atau IP internet yang diizinkan.' });
    return next();
  });
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

// ---------- AUTH ----------
app.get('/api/auth/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.csrfToken, googleEnabled: googleReady });
});
app.get('/api/auth/config', (req, res) => {
  if (!supabaseReady) return res.status(503).json({ error: 'SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY wajib diatur di server.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ supabaseUrl: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY, googleEnabled: googleReady });
});
app.get('/api/auth/me', (req, res) => {
  if (!/^Bearer\s+\S+$/i.test(String(req.get('authorization') || ''))) {
    return res.json({ user: null, googleEnabled: googleReady });
  }
  requireIdentity(req, res, () => {
    if (req.user.role === 'admin' && !adminNetworkAllowed(req.ip)) {
      return res.status(403).json({ error: 'Jaringan tidak diizinkan untuk panel admin.' });
    }
    return res.json({ user: safeUser(req.user), googleEnabled: googleReady });
  });
});
app.post('/api/auth/logout', authLimiter, requireCsrf, requireIdentity, (req, res) => {
  recordActivity(req, 'logout', 'account', req.user.id);
  res.json({ ok: true });
});

// ---------- POSTGRESQL BUSINESS DATA ----------
registerPostgresBusinessRoutes({
  app,
  pg,
  requireAuth,
  requireAdmin,
  db,
  recordActivity,
  validateRecord,
  validateName,
  parseId
});

// Frontend shell. /admin/login is an entirely separate credential entry point.
app.get(['/','/admin','/admin/login','/forgot-password','/verify-email','/reset-password','/auth/callback','/auth/reset-password'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
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
  console.log(`Supabase Auth: ${supabaseReady ? 'terkonfigurasi' : 'belum dikonfigurasi'}`);
  console.log(`Google sign-in: ${googleReady ? 'ditampilkan' : 'disembunyikan'}`);
});
