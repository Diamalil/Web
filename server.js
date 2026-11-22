'use strict';

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const connectSQLite3 = require('connect-sqlite3');
const helmet = require('helmet');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || '');
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SUPABASE_ORIGIN = (() => {
  try {
    const parsed = new URL(SUPABASE_URL);
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch (_) {
    return '';
  }
})();
const supabaseReady = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
const googleReady = String(process.env.ENABLE_GOOGLE_OAUTH || '').toLowerCase() === 'true';
const serviceReady = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);

const app = express();
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') {
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
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));

const SQLiteStore = connectSQLite3(session);
const sessionFile = path.resolve(process.env.SESSION_DATABASE_FILE || './data/sessions.sqlite');
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
app.use(session({
  store: new SQLiteStore({
    db: path.basename(sessionFile),
    dir: path.dirname(sessionFile),
    table: 'sessions',
    concurrentDB: true
  }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deployment',
  resave: false,
  saveUninitialized: false,
  name: 'feeku.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Coba lagi beberapa menit.' }
});
const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan pemulihan akun. Coba lagi nanti.' }
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || null;
  }
}

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function buildRestPath(resource, params) {
  if (!params || !Object.keys(params).length) return resource;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? resource + '?' + query : resource;
}

async function restFetch(resource, options = {}) {
  if (!SUPABASE_URL) throw new HttpError(503, 'SUPABASE_URL belum dikonfigurasi pada server.');
  const method = options.method || 'GET';
  const service = Boolean(options.service);
  const apiKey = service ? SUPABASE_SECRET_KEY : SUPABASE_PUBLISHABLE_KEY;
  const bearer = service ? SUPABASE_SECRET_KEY : options.token;
  if (!apiKey || !bearer) {
    throw new HttpError(503, service
      ? 'SUPABASE_SECRET_KEY wajib dikonfigurasi untuk operasi server.'
      : 'Sesi Supabase tidak tersedia. Silakan login kembali.');
  }
  const headers = {
    apikey: apiKey,
    Authorization: 'Bearer ' + bearer,
    Accept: 'application/json'
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.prefer) headers.Prefer = options.prefer;
  if (options.count) headers.Prefer = [headers.Prefer, 'count=exact'].filter(Boolean).join(',');
  if (options.range) {
    headers.Range = options.range;
    headers['Range-Unit'] = 'items';
  }

  const response = await fetch(SUPABASE_URL + '/rest/v1/' + resource, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 15000)
  });
  const raw = method === 'HEAD' ? '' : await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch (_) { data = { message: raw }; }
  }
  if (!response.ok) {
    const message = data && (data.message || data.details || data.hint || data.error_description || data.error)
      ? (data.message || data.details || data.hint || data.error_description || data.error)
      : 'Permintaan database gagal (' + response.status + ').';
    throw new HttpError(response.status, String(message), data && data.code);
  }
  return { data, response };
}

async function restRows(resource, params, options = {}) {
  const result = await restFetch(buildRestPath(resource, params), options);
  return Array.isArray(result.data) ? result.data : [];
}

async function restOne(resource, params, options = {}) {
  const rows = await restRows(resource, Object.assign({}, params, { limit: 1 }), options);
  return rows[0] || null;
}

async function authAdminFetch(resource, method = 'GET', body) {
  if (!serviceReady) throw new HttpError(503, 'SUPABASE_SECRET_KEY wajib dikonfigurasi untuk fitur administrator.');
  const response = await fetch(SUPABASE_URL + resource, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + SUPABASE_SECRET_KEY,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch (_) { data = { message: raw }; }
  if (!response.ok) {
    const message = data.msg || data.message || data.error_description || data.error || 'Supabase Auth Admin gagal (' + response.status + ').';
    throw new HttpError(response.status, String(message), data.code);
  }
  return data;
}

async function listAllAuthUsers() {
  const users = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page += 1) {
    const result = await authAdminFetch('/auth/v1/admin/users?page=' + page + '&per_page=' + perPage);
    const batch = Array.isArray(result.users) ? result.users : [];
    users.push(...batch);
    if (batch.length < perPage) return users;
  }
  throw new HttpError(503, 'Jumlah pengguna melebihi batas pembacaan administrator.');
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isAccountActive(authUser) {
  if (!authUser || !authUser.banned_until) return true;
  const until = Date.parse(authUser.banned_until);
  return Number.isFinite(until) && until <= Date.now();
}

function safeUser(user) {
  return user ? {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    emailVerified: Boolean(user.email_verified_at),
    createdAt: user.created_at
  } : null;
}

async function getSupabaseAuthUser(accessToken) {
  const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: 'Bearer ' + accessToken
    },
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 401 || response.status === 403) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.msg || payload.message || 'Supabase Auth request failed.');
  return payload;
}

async function profileForUser(userId, accessToken, service = false) {
  try {
    const rows = await restRows('profiles', {
      select: 'id,display_name',
      id: 'eq.' + userId,
      limit: 1
    }, service ? { service: true } : { token: accessToken });
    return rows[0] || null;
  } catch (err) {
    if (service) throw err;
    return null;
  }
}

function userFromAuth(authUser, profile) {
  const email = String(authUser.email || '').trim().toLowerCase();
  const metadata = authUser.user_metadata || {};
  const role = authUser.app_metadata && authUser.app_metadata.role === 'admin' ? 'admin' : 'user';
  const name = String(
    (profile && profile.display_name) ||
    metadata.display_name ||
    metadata.full_name ||
    email.split('@')[0] ||
    'Pengguna'
  ).trim().slice(0, 100) || 'Pengguna';
  return {
    id: authUser.id,
    name,
    email,
    role,
    is_active: isAccountActive(authUser),
    email_verified_at: authUser.email_confirmed_at || authUser.confirmed_at || null,
    created_at: authUser.created_at || null
  };
}

function parseIp(ip) {
  let value = String(ip || '').split('%')[0].toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number);
    if (parts.some(n => n < 0 || n > 255)) return null;
    return {
      version: 4,
      value: parts.reduce((acc, part) => (acc << 8n) | BigInt(part), 0n),
      bits: 32
    };
  }
  if (!value.includes(':')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.concat(right).some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  let groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  }
  const hex = groups.join('').padStart(32, '0');
  return { version: 6, value: BigInt('0x' + hex), bits: 128 };
}

function cidrMatches(ip, cidr) {
  const parts = String(cidr).trim().split('/');
  const address = parseIp(ip);
  const network = parseIp(parts[0]);
  if (!address || !network || address.version !== network.version) return false;
  const prefix = parts[1] === undefined ? address.bits : Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) return false;
  const shift = BigInt(address.bits - prefix);
  return (address.value >> shift) === (network.value >> shift);
}

function adminNetworkAllowed(ip) {
  const configured = String(process.env.ADMIN_ALLOWED_CIDRS || '').split(',').map(item => item.trim()).filter(Boolean);
  const allow = configured.length ? configured : [
    '127.0.0.1/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12',
    '192.168.0.0/16', 'fc00::/7', 'fe80::/10'
  ];
  return allow.some(cidr => cidrMatches(ip, cidr));
}

function requireCsrf(req, res, next) {
  const expected = req.session && req.session.csrfToken;
  const supplied = req.get('x-csrf-token');
  if (!expected || !supplied ||
      Buffer.byteLength(expected) !== Buffer.byteLength(String(supplied)) ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(supplied)))) {
    return res.status(403).json({ error: 'Sesi keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.' });
  }
  next();
}

function requireIdentity(req, res, next) {
  if (req.user) return next();
  if (!supabaseReady) return res.status(503).json({ error: 'Supabase Auth belum dikonfigurasi pada server.' });
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
  if (!match) return res.status(401).json({ error: 'Silakan login kembali.' });
  const token = match[1];

  getSupabaseAuthUser(token).then(async authUser => {
    if (!authUser || !authUser.id) return res.status(401).json({ error: 'Sesi login tidak valid atau sudah kedaluwarsa.' });
    const verifiedAt = authUser.email_confirmed_at || authUser.confirmed_at || null;
    if (!verifiedAt) return res.status(403).json({ error: 'Email belum diverifikasi.' });
    if (!isAccountActive(authUser)) return res.status(403).json({ error: 'Akun dinonaktifkan. Hubungi administrator.' });
    const profile = await profileForUser(authUser.id, token, false);
    req.authUser = authUser;
    req.accessToken = token;
    req.user = userFromAuth(authUser, profile);
    return next();
  }).catch(error => {
    console.error('[supabase-auth] User verification failed:', error.message);
    if (res.headersSent) return;
    return res.status(503).json({ error: 'Layanan autentikasi sementara tidak tersedia.' });
  });
}

function requireAuth(req, res, next) {
  requireIdentity(req, res, () => {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Endpoint ini khusus akun pengguna.' });
    next();
  });
}

function requireAdmin(req, res, next) {
  requireIdentity(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses khusus administrator.' });
    if (!adminNetworkAllowed(req.ip)) return res.status(403).json({ error: 'Panel admin hanya tersedia dari jaringan yang diizinkan.' });
    next();
  });
}

function recordActivity(req, action, entityType, entityId = null, metadata = {}, ownerUserId = null) {
  if (!serviceReady || !req.user || !validUuid(req.user.id)) return;
  const record = {
    user_id: ownerUserId || req.user.id,
    actor_user_id: req.user.id,
    action: String(action || 'unknown').slice(0, 100),
    entity_type: String(entityType || 'unknown').slice(0, 80),
    entity_id: entityId == null ? null : String(entityId),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    ip_address: req.ip || null
  };
  restFetch('activity_logs', {
    method: 'POST',
    service: true,
    body: record,
    prefer: 'return=minimal'
  }).catch(error => {
    console.error('[activity-log] Write failed:', error.message);
  });
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(String(value) + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateRecord(body) {
  const date = String(body.date || '');
  const description = String(body.description || '').trim();
  const type = String(body.type || '');
  const amount = Number(body.amount);
  if (!validDate(date)) throw new Error('Tanggal tidak valid.');
  if (!description || description.length > 200) throw new Error('Keterangan wajib diisi dan maksimal 200 karakter.');
  if (!['Masuk', 'Keluar'].includes(type)) throw new Error('Jenis transaksi tidak valid.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000000) throw new Error('Nominal harus lebih dari 0.');
  return { date, description, type, amount };
}

function validateName(value, label = 'Nama') {
  const name = String(value || '').trim();
  if (!name || name.length > 100) throw new Error(label + ' wajib diisi dan maksimal 100 karakter.');
  return name;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return id;
}

function dbErrorMessage(err) {
  const message = String(err && err.message || '');
  if (message.includes('23505') || message.toLowerCase().includes('duplicate key') || message.includes('unique constraint')) {
    return 'Data dengan nama atau kode tersebut sudah ada.';
  }
  if (message.includes('23503') || message.toLowerCase().includes('foreign key')) {
    return 'Data masih terhubung dengan data lain.';
  }
  if (message.includes('Insufficient available stock')) return 'Stok produk tidak mencukupi.';
  if (message.includes('Isi HPP/modal')) return message;
  if (message.includes('23514') || message.toLowerCase().includes('check constraint')) return message;
  return message || 'Terjadi kesalahan.';
}

function mapPricingMethod(method) {
  if (method === 'target_margin') return 'margin';
  if (method === 'fixed_profit') return 'fixed';
  return ['manual', 'markup', 'margin', 'fixed'].includes(method) ? method : 'manual';
}

function postgresPricingMethod(method) {
  if (method === 'margin') return 'target_margin';
  if (method === 'fixed') return 'fixed_profit';
  if (method === 'manual' || method === 'markup') return method;
  throw new Error('Metode harga jual tidak dikenal.');
}

function calculateProductPricing(body) {
  const unitCost = Number(body.unitCost ?? 0);
  const pricingMethod = String(body.pricingMethod || 'manual');
  const pricingValue = Number(body.pricingValue ?? 0);
  let salePrice;
  if (!Number.isSafeInteger(unitCost) || unitCost <= 0 || unitCost > 1000000000000) {
    throw new Error('HPP/modal per unit harus lebih dari 0 dan berupa angka rupiah bulat.');
  }
  if (!Number.isFinite(pricingValue) || pricingValue < 0 || pricingValue > 1000000000 ||
      (pricingMethod === 'fixed' && !Number.isSafeInteger(pricingValue))) {
    throw new Error('Nilai metode harga jual tidak valid.');
  }
  if (pricingMethod === 'manual') {
    salePrice = Number(body.salePrice);
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
  if (!Number.isSafeInteger(salePrice) || salePrice <= 0 || salePrice > 1000000000000) {
    throw new Error('Harga jual harus lebih dari 0 dan masih dalam batas yang didukung.');
  }
  return {
    unitCost,
    salePrice,
    pricingMethod,
    pricingValue,
    postgresPricingMethod: postgresPricingMethod(pricingMethod)
  };
}

async function getCategories(token, userId, service = false) {
  const rows = await restRows('categories', {
    select: 'id,legacy_id,user_id,name,description,created_at,updated_at',
    user_id: 'eq.' + userId,
    order: 'name.asc'
  }, service ? { service: true } : { token });
  return rows.map(row => ({
    id: Number(row.legacy_id),
    uuid: row.id,
    user_id: row.user_id,
    name: row.name,
    description: row.description || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

async function getProducts(token, userId, service = false) {
  const [rows, categories] = await Promise.all([
    restRows('products', {
      select: '*',
      user_id: 'eq.' + userId,
      order: 'name.asc'
    }, service ? { service: true } : { token }),
    getCategories(token, userId, service)
  ]);
  const categoryByUuid = new Map(categories.map(category => [category.uuid, category]));
  return rows.map(row => {
    const category = categoryByUuid.get(row.category_id);
    return {
      id: Number(row.legacy_id),
      uuid: row.id,
      user_id: row.user_id,
      category_id: category ? category.id : null,
      category_name: category ? category.name : '',
      name: row.name,
      sku: row.sku || null,
      unit_name: row.unit_name || 'pcs',
      stock: Number(row.stock_quantity || 0),
      reserved_quantity: Number(row.reserved_quantity || 0),
      price: Number(row.sale_price || 0),
      unit_cost: Number(row.unit_cost || 0),
      sale_price: Number(row.sale_price || 0),
      pricing_method: mapPricingMethod(row.pricing_method),
      pricing_value: Number(row.pricing_value || 0),
      is_active: Boolean(row.is_active),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  });
}

async function getTransactionLines(token, userId, transactions, service = false) {
  if (!transactions.length) return new Map();
  const transactionIds = transactions.map(row => row.id);
  const [items, products] = await Promise.all([
    restRows('transaction_items', {
      select: '*',
      user_id: 'eq.' + userId,
      transaction_id: 'in.(' + transactionIds.join(',') + ')',
      order: 'legacy_id.asc'
    }, service ? { service: true } : { token }),
    restRows('products', {
      select: 'id,legacy_id',
      user_id: 'eq.' + userId
    }, service ? { service: true } : { token })
  ]);
  const productLegacyByUuid = new Map(products.map(product => [product.id, Number(product.legacy_id)]));
  const grouped = new Map();
  for (const row of items) {
    const list = grouped.get(row.transaction_id) || [];
    list.push({
      id: Number(row.legacy_id),
      product_id: row.product_id ? (productLegacyByUuid.get(row.product_id) ?? null) : null,
      product_name: row.product_name_snapshot,
      quantity: Number(row.quantity),
      unit_sale_price: Number(row.sale_price_snapshot),
      unit_cost: Number(row.unit_cost_snapshot),
      line_total: Number(row.line_total),
      line_profit: Number(row.profit_amount),
      sku: row.sku_snapshot || null
    });
    grouped.set(row.transaction_id, list);
  }
  return grouped;
}

async function getTransactions(token, userId, service = false) {
  const rows = await restRows('transactions', {
    select: '*',
    user_id: 'eq.' + userId,
    order: 'entry_date.desc,legacy_id.desc'
  }, service ? { service: true } : { token });
  const lines = await getTransactionLines(token, userId, rows, service);
  return rows.map(row => ({
    id: Number(row.legacy_id),
    uuid: row.id,
    user_id: row.user_id,
    date: row.entry_date,
    description: row.description,
    type: row.direction,
    amount: Number(row.amount),
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: lines.get(row.id) || []
  }));
}

async function getProfits(token, userId, service = false) {
  const rows = await restRows('profits', {
    select: '*',
    user_id: 'eq.' + userId,
    order: 'entry_date.desc,legacy_id.desc'
  }, service ? { service: true } : { token });
  return rows.map(row => ({
    id: Number(row.legacy_id),
    uuid: row.id,
    user_id: row.user_id,
    date: row.entry_date,
    description: row.description,
    type: row.direction,
    amount: Number(row.amount),
    source: row.source,
    source_transaction_id: row.source_transaction_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

async function getBusinessSnapshot(userId, token, service = false) {
  const ctx = service ? { service: true } : { token };
  const [categoryRows, productRows, transactionRows, profitRows, logRows] = await Promise.all([
    getCategories(token, userId, service),
    getProducts(token, userId, service),
    restRows('transactions', {
      select: '*',
      user_id: 'eq.' + userId,
      order: 'entry_date.desc,legacy_id.desc'
    }, ctx),
    restRows('profits', {
      select: '*',
      user_id: 'eq.' + userId,
      order: 'entry_date.desc,legacy_id.desc'
    }, ctx),
    restRows('activity_logs', {
      select: '*',
      user_id: 'eq.' + userId,
      order: 'created_at.desc',
      limit: 100
    }, ctx)
  ]);
  const lines = await getTransactionLines(token, userId, transactionRows, service);
  const transactions = transactionRows.map(row => ({
    id: Number(row.legacy_id),
    uuid: row.id,
    user_id: row.user_id,
    date: row.entry_date,
    description: row.description,
    type: row.direction,
    amount: Number(row.amount),
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: lines.get(row.id) || []
  }));
  const transactionLegacyByUuid = new Map(transactionRows.map(row => [row.id, Number(row.legacy_id)]));
  const profits = profitRows.map(row => ({
    id: Number(row.legacy_id),
    uuid: row.id,
    user_id: row.user_id,
    date: row.entry_date,
    description: row.description,
    type: row.direction,
    amount: Number(row.amount),
    source: row.source,
    source_transaction_id: row.source_transaction_id
      ? (transactionLegacyByUuid.get(row.source_transaction_id) || row.source_transaction_id)
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
  const products = productRows.map(row => ({
    id: row.id,
    category_id: row.category_id,
    category: row.category_name,
    name: row.name,
    stock: row.stock,
    price: row.price,
    unit_cost: row.unit_cost,
    sale_price: row.sale_price,
    pricing_method: row.pricing_method,
    pricing_value: row.pricing_value,
    sku: row.sku,
    unit_name: row.unit_name,
    is_active: row.is_active
  }));
  const categories = categoryRows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description
  }));
  const activityLogs = logRows.map(row => ({
    id: Number(row.legacy_id),
    actor_user_id: row.actor_user_id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    metadata: row.metadata || {},
    ip_address: row.ip_address || null,
    created_at: row.created_at
  }));
  return { categories, products, transactions, profits, activityLogs };
}

async function countRows(table, column, value) {
  const params = {
    select: 'id',
    [column]: 'eq.' + value
  };
  const result = await restFetch(buildRestPath(table, params), {
    method: 'HEAD',
    service: true,
    count: true,
    range: '0-0'
  });
  const range = result.response.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

async function fetchAllRows(resource, params = {}, service = true) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 1000000; offset += pageSize) {
    const result = await restFetch(buildRestPath(resource, Object.assign({}, params, {
      limit: pageSize
    })), {
      service,
      token: service ? undefined : params.token,
      range: offset + '-' + (offset + pageSize - 1)
    });
    const batch = Array.isArray(result.data) ? result.data : [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new HttpError(503, 'Data melebihi batas ekspor satu juta baris. Gunakan backup database terjadwal.');
}

async function listAllAuthUsersWithProfiles() {
  const users = await listAllAuthUsers();
  const ids = users.map(user => user.id).filter(validUuid);
  const profiles = ids.length ? await restRows('profiles', {
    select: 'id,display_name',
    id: 'in.(' + ids.join(',') + ')'
  }, { service: true }) : [];
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  return users.map(user => userFromAuth(user, profileById.get(user.id)));
}

function mapLogRows(rows, userMap, profileMap) {
  return rows.map(row => {
    const actor = userMap.get(row.actor_user_id);
    const profile = profileMap.get(row.actor_user_id);
    return Object.assign({}, row, {
      user_name: (profile && profile.display_name) || (actor && actor.name) || 'Tidak diketahui',
      actor_email: actor ? actor.email : null,
      metadata: row.metadata || {}
    });
  });
}

function parseIpAddress(req) {
  return req.ip || null;
}

app.use('/api', writeLimiter, (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return requireCsrf(req, res, next);
  next();
});

// ---------- AUTH ----------
app.get('/api/auth/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.csrfToken, googleEnabled: googleReady });
});

app.get('/api/auth/config', (req, res) => {
  if (!supabaseReady) return res.status(503).json({ error: 'SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY wajib diatur di server.' });
  res.json({
    supabaseUrl: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    googleEnabled: googleReady
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!/^Bearer\s+\S+$/i.test(String(req.get('authorization') || ''))) {
    return res.json({ user: null, googleEnabled: googleReady });
  }
  requireIdentity(req, res, () => {
    if (req.user.role === 'admin' && !adminNetworkAllowed(req.ip)) {
      return res.status(403).json({ error: 'Jaringan tidak diizinkan untuk panel administrator.' });
    }
    return res.json({ user: safeUser(req.user), googleEnabled: googleReady });
  });
});

app.post('/api/auth/logout', authLimiter, requireCsrf, requireIdentity, (req, res) => {
  recordActivity(req, 'logout', 'account', req.user.id);
  res.json({ ok: true });
});

// ---------- USER DATA: DASHBOARD ----------
app.get('/api/dashboard', requireAuth, asyncRoute(async (req, res) => {
  const [transactions, profits] = await Promise.all([
    getTransactions(req.accessToken, req.user.id),
    getProfits(req.accessToken, req.user.id)
  ]);
  const totalIn = transactions.filter(row => row.type === 'Masuk').reduce((sum, row) => sum + row.amount, 0);
  const totalOut = transactions.filter(row => row.type === 'Keluar').reduce((sum, row) => sum + row.amount, 0);
  const profitIn = profits.filter(row => row.type === 'Masuk').reduce((sum, row) => sum + row.amount, 0);
  const profitOut = profits.filter(row => row.type === 'Keluar').reduce((sum, row) => sum + row.amount, 0);
  recordActivity(req, 'dashboard_view', 'dashboard');
  res.json({
    cash: { totalIn, totalOut, balance: totalIn - totalOut },
    profit: { totalIn: profitIn, totalOut: profitOut, balance: profitIn - profitOut },
    recent: transactions.slice(0, 5)
  });
}));

async function saveTransaction(req, legacyId = null) {
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
  const items = hasItems ? body.items.map(raw => {
    const productLegacyId = parseId(raw.productId);
    const quantity = Number(raw.quantity);
    const unitSalePrice = Number(raw.unitSalePrice);
    if (!productLegacyId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) {
      throw new Error('Produk atau jumlah barang tidak valid.');
    }
    if (!Number.isSafeInteger(unitSalePrice) || unitSalePrice <= 0 || unitSalePrice > 1000000000000) {
      throw new Error('Harga jual produk tidak valid.');
    }
    return {
      productLegacyId,
      quantity,
      unitSalePrice
    };
  }) : [];
  const payload = {
    p_legacy_id: legacyId == null ? null : Number(legacyId),
    p_entry_date: hasItems ? String(body.date) : manual.date,
    p_description: String(body.description || '').trim() || (hasItems ? 'Penjualan produk katalog' : manual.description),
    p_direction: hasItems ? 'Masuk' : manual.type,
    p_amount: hasItems ? null : manual.amount,
    p_items: items
  };
  const result = await restFetch('rpc/save_feeku_transaction', {
    method: 'POST',
    token: req.accessToken,
    body: payload
  });
  const resultId = Number(result.data && result.data.id);
  if (!Number.isSafeInteger(resultId) || resultId < 1) throw new Error('Database tidak mengembalikan ID transaksi yang valid.');
  const row = await restOne('transactions', {
    select: '*',
    user_id: 'eq.' + req.user.id,
    legacy_id: 'eq.' + resultId
  }, { token: req.accessToken });
  if (!row) throw new Error('Transaksi tersimpan tetapi tidak dapat dibaca kembali.');
  const lines = await getTransactionLines(req.accessToken, req.user.id, [row]);
  return {
    transactionId: resultId,
    description: row.description,
    type: row.direction,
    amount: Number(row.amount),
    items: lines.get(row.id) || []
  };
}

function registerLedgerRoutes(route, table, label) {
  app.get(route, requireAuth, asyncRoute(async (req, res) => {
    const items = table === 'transactions'
      ? await getTransactions(req.accessToken, req.user.id)
      : await getProfits(req.accessToken, req.user.id);
    recordActivity(req, label + '_list_view', label);
    res.json({ items });
  }));

  app.post(route, requireAuth, asyncRoute(async (req, res) => {
    try {
      if (table === 'transactions') {
        const saved = await saveTransaction(req);
        recordActivity(req, 'transaction_create', 'transaction', saved.transactionId, {
          description: saved.description,
          type: saved.type,
          amount: saved.amount,
          productCount: saved.items.length
        });
        const rows = await getTransactions(req.accessToken, req.user.id);
        return res.status(201).json({ item: rows.find(row => row.id === saved.transactionId) || saved });
      }
      const item = validateRecord(req.body);
      const inserted = await restFetch('profits', {
        method: 'POST',
        token: req.accessToken,
        prefer: 'return=representation',
        body: {
          user_id: req.user.id,
          entry_date: item.date,
          description: item.description,
          direction: item.type,
          amount: item.amount,
          source: 'manual'
        }
      });
      const row = Array.isArray(inserted.data) ? inserted.data[0] : null;
      recordActivity(req, 'profit_create', 'profit', row ? row.legacy_id : null, {
        description: item.description,
        type: item.type,
        amount: item.amount
      });
      return res.status(201).json({
        item: row ? {
          id: Number(row.legacy_id),
          date: row.entry_date,
          description: row.description,
          type: row.direction,
          amount: Number(row.amount),
          source: row.source,
          source_transaction_id: row.source_transaction_id
        } : item
      });
    } catch (err) {
      return res.status(400).json({ error: dbErrorMessage(err) });
    }
  }));

  app.put(route + '/:id', requireAuth, asyncRoute(async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
      if (table === 'transactions') {
        const saved = await saveTransaction(req, id);
        recordActivity(req, 'transaction_update', 'transaction', id, {
          description: saved.description,
          type: saved.type,
          amount: saved.amount,
          productCount: saved.items.length
        });
        const rows = await getTransactions(req.accessToken, req.user.id);
        return res.json({ item: rows.find(row => row.id === id) || saved });
      }
      const existing = await restOne('profits', {
        select: '*',
        user_id: 'eq.' + req.user.id,
        legacy_id: 'eq.' + id
      }, { token: req.accessToken });
      if (!existing) return res.status(404).json({ error: 'Data tidak ditemukan.' });
      if (existing.source_transaction_id || existing.source !== 'manual') {
        return res.status(409).json({ error: 'Keuntungan otomatis mengikuti transaksi penjualan. Edit transaksi penjualannya dari Buku Kas.' });
      }
      const item = validateRecord(req.body);
      const updated = await restFetch(buildRestPath('profits', {
        user_id: 'eq.' + req.user.id,
        legacy_id: 'eq.' + id,
        source: 'eq.manual',
        source_transaction_id: 'is.null'
      }), {
        method: 'PATCH',
        token: req.accessToken,
        prefer: 'return=representation',
        body: {
          entry_date: item.date,
          description: item.description,
          direction: item.type,
          amount: item.amount
        }
      });
      const row = Array.isArray(updated.data) ? updated.data[0] : null;
      recordActivity(req, 'profit_update', 'profit', id, {
        description: item.description,
        type: item.type,
        amount: item.amount
      });
      return res.json({
        item: row ? {
          id: Number(row.legacy_id),
          date: row.entry_date,
          description: row.description,
          type: row.direction,
          amount: Number(row.amount),
          source: row.source,
          source_transaction_id: row.source_transaction_id
        } : item
      });
    } catch (err) {
      return res.status(400).json({ error: dbErrorMessage(err) });
    }
  }));

  app.delete(route + '/:id', requireAuth, asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    const old = await restOne(table, {
      select: '*',
      user_id: 'eq.' + req.user.id,
      legacy_id: 'eq.' + id
    }, { token: req.accessToken });
    if (!old) return res.status(404).json({ error: 'Data tidak ditemukan.' });
    if (table === 'profits' && (old.source_transaction_id || old.source !== 'manual')) {
      return res.status(409).json({ error: 'Keuntungan otomatis mengikuti transaksi penjualan. Hapus transaksi penjualannya dari Buku Kas.' });
    }
    await restFetch(buildRestPath(table, {
      user_id: 'eq.' + req.user.id,
      legacy_id: 'eq.' + id
    }), {
      method: 'DELETE',
      token: req.accessToken,
      prefer: 'return=minimal'
    });
    recordActivity(req, label + '_delete', label, id, {
      description: old.description,
      amount: Number(old.amount)
    });
    res.json({ ok: true });
  }));
}

registerLedgerRoutes('/api/transactions', 'transactions', 'transaction');
registerLedgerRoutes('/api/profits', 'profits', 'profit');

// ---------- STOCK ----------
app.get('/api/categories', requireAuth, asyncRoute(async (req, res) => {
  const items = await getCategories(req.accessToken, req.user.id);
  recordActivity(req, 'stock_view', 'stock');
  res.json({ items });
}));

app.post('/api/categories', requireAuth, asyncRoute(async (req, res) => {
  try {
    const name = validateName(req.body.name, 'Nama kategori');
    const inserted = await restFetch('categories', {
      method: 'POST',
      token: req.accessToken,
      prefer: 'return=representation',
      body: { user_id: req.user.id, name }
    });
    const row = inserted.data[0];
    recordActivity(req, 'category_create', 'category', row.legacy_id, { name });
    res.status(201).json({ item: { id: Number(row.legacy_id), name: row.name } });
  } catch (err) {
    res.status(400).json({ error: dbErrorMessage(err) });
  }
}));

app.put('/api/categories/:id', requireAuth, asyncRoute(async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const name = validateName(req.body.name, 'Nama kategori');
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    const updated = await restFetch(buildRestPath('categories', {
      user_id: 'eq.' + req.user.id,
      legacy_id: 'eq.' + id
    }), {
      method: 'PATCH',
      token: req.accessToken,
      prefer: 'return=representation',
      body: { name }
    });
    if (!updated.data || !updated.data.length) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
    recordActivity(req, 'category_update', 'category', id, { name });
    res.json({ item: { id, name } });
  } catch (err) {
    res.status(400).json({ error: dbErrorMessage(err) });
  }
}));

app.delete('/api/categories/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
  const category = await restOne('categories', {
    select: 'id,name',
    user_id: 'eq.' + req.user.id,
    legacy_id: 'eq.' + id
  }, { token: req.accessToken });
  if (!category) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
  const deletedProducts = await restRows('products', {
    select: 'id',
    user_id: 'eq.' + req.user.id,
    category_id: 'eq.' + category.id
  }, { token: req.accessToken });
  await restFetch(buildRestPath('categories', {
    user_id: 'eq.' + req.user.id,
    legacy_id: 'eq.' + id
  }), {
    method: 'DELETE',
    token: req.accessToken,
    prefer: 'return=minimal'
  });
  recordActivity(req, 'category_delete', 'category', id, {
    name: category.name,
    deletedProducts: deletedProducts.length
  });
  res.json({ ok: true, deletedProducts: deletedProducts.length });
}));

app.get('/api/products', requireAuth, asyncRoute(async (req, res) => {
  const items = await getProducts(req.accessToken, req.user.id);
  recordActivity(req, 'product_list_view', 'product');
  res.json({ items });
}));

app.post('/api/products', requireAuth, asyncRoute(async (req, res) => {
  try {
    const categoryId = parseId(req.body.categoryId);
    const name = validateName(req.body.name, 'Nama barang');
    const pricing = calculateProductPricing(req.body);
    if (!categoryId) return res.status(400).json({ error: 'Kategori tidak valid.' });
    const category = await restOne('categories', {
      select: 'id,legacy_id',
      user_id: 'eq.' + req.user.id,
      legacy_id: 'eq.' + categoryId
    }, { token: req.accessToken });
    if (!category) return res.status(400).json({ error: 'Kategori tidak valid.' });
    const inserted = await restFetch('products', {
      method: 'POST',
      token: req.accessToken,
      prefer: 'return=representation',
      body: {
        user_id: req.user.id,
        category_id: category.id,
        name,
        stock_quantity: 0,
        unit_cost: pricing.unitCost,
        sale_price: pricing.salePrice,
        pricing_method: pricing.postgresPricingMethod,
        pricing_value: pricing.pricingValue
      }
    });
    const row = inserted.data[0];
    recordActivity(req, 'product_create', 'product', row.legacy_id, {
      name,
      unitCost: pricing.unitCost,
      salePrice: pricing.salePrice,
      pricingMethod: pricing.pricingMethod,
      categoryId
    });
    const products = await getProducts(req.accessToken, req.user.id);
    res.status(201).json({ item: products.find(product => product.id === Number(row.legacy_id)) });
  } catch (err) {
    res.status(400).json({ error: dbErrorMessage(err) });
  }
}));

app.put('/api/products/:id', requireAuth, asyncRoute(async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const categoryId = parseId(req.body.categoryId);
    const name = validateName(req.body.name, 'Nama barang');
    const pricing = calculateProductPricing(req.body);
    if (!id || !categoryId) return res.status(400).json({ error: 'ID atau kategori tidak valid.' });
    const category = await restOne('categories', {
      select: 'id,legacy_id',
      user_id: 'eq.' + req.user.id,
      legacy_id: 'eq.' + categoryId
    }, { token: req.accessToken });
    if (!category) return res.status(400).json({ error: 'Kategori tidak valid.' });
    const updated = await restFetch(buildRestPath('products', {
      user_id: 'eq.' + req.user.id,
      legacy_id: 'eq.' + id
    }), {
      method: 'PATCH',
      token: req.accessToken,
      prefer: 'return=representation',
      body: {
        category_id: category.id,
        name,
        unit_cost: pricing.unitCost,
        sale_price: pricing.salePrice,
        pricing_method: pricing.postgresPricingMethod,
        pricing_value: pricing.pricingValue
      }
    });
    if (!updated.data || !updated.data.length) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
    recordActivity(req, 'product_update', 'product', id, {
      name,
      unitCost: pricing.unitCost,
      salePrice: pricing.salePrice,
      pricingMethod: pricing.pricingMethod,
      categoryId
    });
    const products = await getProducts(req.accessToken, req.user.id);
    res.json({ item: products.find(product => product.id === id) });
  } catch (err) {
    res.status(400).json({ error: dbErrorMessage(err) });
  }
}));

app.delete('/api/products/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
  const old = await restOne('products', {
    select: 'id,name',
    user_id: 'eq.' + req.user.id,
    legacy_id: 'eq.' + id
  }, { token: req.accessToken });
  if (!old) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
  await restFetch(buildRestPath('products', {
    user_id: 'eq.' + req.user.id,
    legacy_id: 'eq.' + id
  }), {
    method: 'DELETE',
    token: req.accessToken,
    prefer: 'return=minimal'
  });
  recordActivity(req, 'product_delete', 'product', id, { name: old.name });
  res.json({ ok: true });
}));

app.post('/api/products/:id/stock', requireAuth, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const delta = Number(req.body.delta);
  if (!id || ![-1, 1].includes(delta)) return res.status(400).json({ error: 'Perubahan stok tidak valid.' });
  try {
    const result = await restFetch('rpc/adjust_feeku_stock', {
      method: 'POST',
      token: req.accessToken,
      body: {
        p_product_legacy_id: id,
        p_delta: delta
      }
    });
    const item = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!item) return res.status(409).json({ error: 'Barang tidak ditemukan atau stok tidak boleh kurang dari nol.' });
    recordActivity(req, delta > 0 ? 'stock_increase' : 'stock_decrease', 'product', id, {
      name: item.name,
      stock: Number(item.stock)
    });
    res.json({ item: { id: Number(item.id), name: item.name, stock: Number(item.stock) } });
  } catch (err) {
    res.status(409).json({ error: dbErrorMessage(err) });
  }
}));

// ---------- REPORTS / BACKUP ----------
app.get('/api/reports', requireAuth, asyncRoute(async (req, res) => {
  const from = validDate(req.query.from) ? req.query.from : '2000-01-01';
  const to = validDate(req.query.to) ? req.query.to : '2100-12-31';
  if (from > to) return res.status(400).json({ error: 'Tanggal awal tidak boleh melewati tanggal akhir.' });
  const rows = await getTransactions(req.accessToken, req.user.id);
  const items = rows.filter(row => row.date >= from && row.date <= to);
  const totalIn = items.filter(row => row.type === 'Masuk').reduce((sum, row) => sum + row.amount, 0);
  const totalOut = items.filter(row => row.type === 'Keluar').reduce((sum, row) => sum + row.amount, 0);
  recordActivity(req, 'report_view', 'report', null, { from, to, count: items.length });
  res.json({ items, totalIn, totalOut, balance: totalIn - totalOut, from, to });
}));

app.get('/api/settings/backup', requireAuth, asyncRoute(async (req, res) => {
  const snapshot = await getBusinessSnapshot(req.user.id, req.accessToken, false);
  const backup = {
    format: 'buku-kas-backup-v2',
    exportedAt: new Date().toISOString(),
    transactions: snapshot.transactions,
    profits: snapshot.profits,
    categories: snapshot.categories,
    products: snapshot.products,
    activity_logs: snapshot.activityLogs
  };
  recordActivity(req, 'backup_export', 'backup', null, {
    transactionCount: backup.transactions.length,
    productCount: backup.products.length
  });
  res.setHeader('Content-Disposition', 'attachment; filename="feeku-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(backup);
}));

app.post('/api/settings/restore', requireAuth, asyncRoute(async (req, res) => {
  const input = req.body && req.body.backup;
  const formatOk = input && ['buku-kas-backup-v1', 'buku-kas-backup-v2'].includes(input.format);
  if (!formatOk || !Array.isArray(input.transactions) || !Array.isArray(input.profits) ||
      !Array.isArray(input.categories) || !Array.isArray(input.products)) {
    return res.status(400).json({ error: 'Format file backup tidak dikenali.' });
  }
  const total = input.transactions.length + input.profits.length + input.categories.length + input.products.length;
  if (total > 10000) return res.status(400).json({ error: 'Backup terlalu besar. Batas restore saat ini 10.000 baris per akun.' });
  try {
    const result = await restFetch('rpc/restore_feeku_user_backup', {
      method: 'POST',
      token: req.accessToken,
      body: { p_data: input }
    });
    recordActivity(req, 'backup_restore', 'backup', null, {
      transactions: input.transactions.length,
      profits: input.profits.length,
      products: input.products.length,
      format: input.format
    });
    res.json({ ok: true, counts: result.data });
  } catch (err) {
    res.status(400).json({ error: dbErrorMessage(err) });
  }
}));

// ---------- ADMIN: CROSS-USER VISIBILITY / CONTROL ----------
app.get('/api/admin/overview', requireAdmin, asyncRoute(async (req, res) => {
  const [authUsers, transactionRows, profitRows, logs] = await Promise.all([
    listAllAuthUsers(),
    fetchAllRows('transactions', { select: 'amount' }, true),
    fetchAllRows('profits', { select: 'amount' }, true),
    restRows('activity_logs', { select: '*', order: 'created_at.desc', limit: 12 }, { service: true })
  ]);
  const standardUsers = authUsers.filter(user => !(user.app_metadata && user.app_metadata.role === 'admin'));
  const activeUsers = standardUsers.filter(isAccountActive).length;
  const transactionVolume = transactionRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const profitVolume = profitRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const actorIds = [...new Set(logs.map(row => row.actor_user_id).filter(validUuid))];
  const [profiles, actorUsers] = await Promise.all([
    actorIds.length ? restRows('profiles', {
      select: 'id,display_name',
      id: 'in.(' + actorIds.join(',') + ')'
    }, { service: true }) : [],
    listAllAuthUsers()
  ]);
  const profileMap = new Map(profiles.map(profile => [profile.id, profile]));
  const userMap = new Map(actorUsers.map(user => [user.id, userFromAuth(user, profileMap.get(user.id))]));
  recordActivity(req, 'admin_overview_view', 'admin');
  res.json({
    users: { total: standardUsers.length, active: activeUsers },
    cash: { transactionCount: transactionRows.length, transactionVolume },
    profit: { profitCount: profitRows.length, profitVolume },
    recentActivity: mapLogRows(logs, userMap, profileMap)
  });
}));

app.get('/api/admin/users', requireAdmin, asyncRoute(async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const usersWithProfiles = await listAllAuthUsersWithProfiles();
  const users = usersWithProfiles
    .filter(user => user.role !== 'admin')
    .filter(user => !search || user.name.toLowerCase().includes(search) || user.email.toLowerCase().includes(search))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 250);
  for (let offset = 0; offset < users.length; offset += 10) {
    const batch = users.slice(offset, offset + 10);
    const counts = await Promise.all(batch.map(async user => {
      const [transactionCount, activityCount] = await Promise.all([
        countRows('transactions', 'user_id', user.id),
        countRows('activity_logs', 'actor_user_id', user.id)
      ]);
      return { id: user.id, transaction_count: transactionCount, activity_count: activityCount };
    }));
    const countMap = new Map(counts.map(row => [row.id, row]));
    for (const user of batch) Object.assign(user, countMap.get(user.id));
  }
  recordActivity(req, 'admin_users_list_view', 'admin', null, { resultCount: users.length });
  res.json({
    items: users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
      email_verified_at: user.email_verified_at,
      created_at: user.created_at,
      transaction_count: user.transaction_count || 0,
      activity_count: user.activity_count || 0
    }))
  });
}));

app.patch('/api/admin/users/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  if (!validUuid(id)) return res.status(400).json({ error: 'ID pengguna tidak valid.' });
  if (req.body.isActive !== undefined && typeof req.body.isActive !== 'boolean') {
    return res.status(400).json({ error: 'Status akun harus berupa boolean.' });
  }
  const lookup = await authAdminFetch('/auth/v1/admin/users/' + encodeURIComponent(id));
  const target = lookup.user || lookup;
  if (!target || target.id !== id || (target.app_metadata && target.app_metadata.role === 'admin')) {
    return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
  }
  if (req.body.isActive !== undefined) {
    await authAdminFetch('/auth/v1/admin/users/' + encodeURIComponent(id), 'PUT', {
      ban_duration: req.body.isActive ? 'none' : '876000h'
    });
  }
  if (req.body.name !== undefined) {
    const name = validateName(req.body.name, 'Nama');
    await restFetch(buildRestPath('profiles', { id: 'eq.' + id }), {
      method: 'PATCH',
      service: true,
      prefer: 'return=minimal',
      body: { display_name: name }
    });
  }
  const refreshed = await authAdminFetch('/auth/v1/admin/users/' + encodeURIComponent(id));
  const authUser = refreshed.user || refreshed;
  const profile = await profileForUser(id, null, true);
  const user = userFromAuth(authUser, profile);
  recordActivity(req, 'admin_user_update', 'user', id, {
    isActive: user.is_active,
    name: user.name,
    targetEmail: user.email
  }, id);
  res.json({ item: safeUser(user) });
}));

app.get('/api/admin/users/:id/data', requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  if (!validUuid(id)) return res.status(400).json({ error: 'ID pengguna tidak valid.' });
  const lookup = await authAdminFetch('/auth/v1/admin/users/' + encodeURIComponent(id));
  const target = lookup.user || lookup;
  if (!target || target.id !== id || (target.app_metadata && target.app_metadata.role === 'admin')) {
    return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
  }
  const profile = await profileForUser(id, null, true);
  const user = userFromAuth(target, profile);
  const snapshot = await getBusinessSnapshot(id, null, true);
  recordActivity(req, 'admin_view_user_data', 'user', id, { targetEmail: user.email }, id);
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
      email_verified_at: user.email_verified_at,
      created_at: user.created_at
    },
    transactions: snapshot.transactions,
    profits: snapshot.profits,
    products: snapshot.products.map(product => ({
      id: product.id,
      category_name: product.category,
      name: product.name,
      stock: product.stock,
      unit_cost: product.unit_cost,
      sale_price: product.sale_price,
      price: product.price
    })),
    categories: snapshot.categories,
    activity: snapshot.activityLogs
  });
}));

app.get('/api/admin/logs', requireAdmin, asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const params = {
    select: '*',
    order: 'created_at.desc'
  };
  if (validUuid(req.query.userId)) params.user_id = 'eq.' + req.query.userId;
  const action = String(req.query.action || '').trim();
  if (action) params.action = 'ilike.*' + action.replace(/[%_]/g, '') + '*';
  const result = await restFetch(buildRestPath('activity_logs', params), {
    service: true,
    range: offset + '-' + (offset + limit - 1)
  });
  const items = Array.isArray(result.data) ? result.data : [];
  const actorIds = [...new Set(items.map(row => row.actor_user_id).filter(validUuid))];
  const [profiles, authUsers] = await Promise.all([
    actorIds.length ? restRows('profiles', {
      select: 'id,display_name',
      id: 'in.(' + actorIds.join(',') + ')'
    }, { service: true }) : [],
    listAllAuthUsers()
  ]);
  const profileMap = new Map(profiles.map(profile => [profile.id, profile]));
  const userMap = new Map(authUsers.map(user => [user.id, userFromAuth(user, profileMap.get(user.id))]));
  recordActivity(req, 'admin_activity_log_view', 'admin', null, { resultCount: items.length, limit, offset });
  res.json({ items: mapLogRows(items, userMap, profileMap) });
}));

// Frontend shell.
app.get([
  '/',
  '/admin',
  '/admin/login',
  '/forgot-password',
  '/verify-email',
  '/reset-password',
  '/auth/callback',
  '/auth/reset-password'
], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'feeku-website',
    businessDatabase: 'postgresql',
    authConfigured: supabaseReady,
    adminOperationsConfigured: serviceReady
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use((err, req, res, next) => {
  console.error('[' + new Date().toISOString() + ']', err);
  if (res.headersSent) return next(err);
  const statusCode = Number(err && err.statusCode) || 500;
  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Terjadi kesalahan pada server.' : dbErrorMessage(err)
  });
});

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('SESSION_SECRET wajib disetel minimal 32 karakter saat production.');
  process.exit(1);
}
app.listen(PORT, HOST, () => {
  console.log('FeeKu Website berjalan di ' + HOST + ':' + PORT);
  console.log('Business database: PostgreSQL (Supabase)');
  console.log('Supabase Auth: ' + (supabaseReady ? 'terkonfigurasi' : 'belum dikonfigurasi'));
  console.log('Google sign-in: ' + (googleReady ? 'ditampilkan' : 'disembunyikan'));
  console.log('Server admin operations: ' + (serviceReady ? 'terkonfigurasi' : 'SUPABASE_SECRET_KEY belum diatur'));
});
