'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const databasePath = path.resolve(process.env.DATABASE_FILE || './data/buku-kas.sqlite');
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const secretKey = String(process.env.SUPABASE_SECRET_KEY || '');

if (!fs.existsSync(databasePath)) {
  console.error('Database SQLite tidak ditemukan: ' + databasePath);
  console.error('Jalankan server FeeKu pada mesin yang menyimpan data bisnis terlebih dahulu.');
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !secretKey) {
  console.error('SUPABASE_URL dan SUPABASE_SECRET_KEY wajib diatur pada environment server.');
  process.exit(1);
}

const db = new Database(databasePath);
db.pragma('busy_timeout = 10000');
db.pragma('foreign_keys = ON');

function hasTable(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function getColumns(name) {
  return hasTable(name) ? new Set(db.pragma('table_info("' + name + '")').map(row => row.name)) : new Set();
}
function readRows(name, userId) {
  if (!hasTable(name)) return [];
  const cols = getColumns(name);
  if (!cols.has('user_id')) return [];
  return db.prepare('SELECT * FROM "' + name + '" WHERE user_id=? ORDER BY id').all(userId);
}
function readActivityRows(userId) {
  if (!hasTable('activity_logs')) return [];
  const cols = getColumns('activity_logs');
  if (!cols.has('actor_user_id')) return [];
  return db.prepare('SELECT * FROM activity_logs WHERE actor_user_id=? ORDER BY id').all(userId);
}
function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function optional(row, key, fallback = null) {
  return row && row[key] !== undefined ? row[key] : fallback;
}
function metadataObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function supabaseRequest(resource, options = {}) {
  const response = await fetch(supabaseUrl + '/rest/v1/' + resource, {
    method: options.method || 'GET',
    headers: {
      apikey: secretKey,
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30000)
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw };
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.msg || payload?.details || ('Supabase request failed with HTTP ' + response.status));
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

function buildPayload(userId) {
  const categories = readRows('categories', userId).map(row => ({
    id: row.id,
    name: row.name,
    description: optional(row, 'description')
  }));
  const categoryIds = new Set(categories.map(row => Number(row.id)));

  const products = readRows('products', userId).map(row => ({
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    sku: optional(row, 'sku'),
    unit_name: optional(row, 'unit_name', 'pcs') || 'pcs',
    stock: numeric(row.stock),
    unit_cost: numeric(optional(row, 'unit_cost', 0)),
    sale_price: numeric(optional(row, 'sale_price', optional(row, 'price', 0))),
    price: numeric(optional(row, 'price', 0)),
    pricing_method: optional(row, 'pricing_method', 'manual') || 'manual',
    pricing_value: numeric(optional(row, 'pricing_value', 0)),
    is_active: optional(row, 'is_active', 1) !== 0
  }));
  for (const product of products) {
    if (!categoryIds.has(Number(product.category_id))) {
      throw new Error('Produk ID ' + product.id + ' tidak mempunyai kategori milik akun yang sama.');
    }
  }

  const itemsByTransaction = new Map();
  const itemRows = readRows('transaction_items', userId);
  for (const row of itemRows) {
    const key = Number(row.transaction_id);
    if (!itemsByTransaction.has(key)) itemsByTransaction.set(key, []);
    itemsByTransaction.get(key).push({
      product_id: row.product_id == null ? null : Number(row.product_id),
      product_name: row.product_name || 'Produk terhapus',
      sku: optional(row, 'sku'),
      quantity: numeric(row.quantity),
      unit_cost: numeric(row.unit_cost),
      unit_sale_price: numeric(row.unit_sale_price)
    });
  }

  const transactions = readRows('transactions', userId).map(row => ({
    id: row.id,
    date: row.date,
    description: row.description,
    type: row.type,
    amount: numeric(row.amount),
    items: itemsByTransaction.get(Number(row.id)) || []
  }));

  const profitColumns = getColumns('profits');
  const profits = readRows('profits', userId).map(row => ({
    id: row.id,
    date: row.date,
    description: row.description,
    type: row.type,
    amount: numeric(row.amount),
    source: profitColumns.has('source') ? row.source : (row.source_transaction_id == null ? 'manual' : 'transaction_margin'),
    source_transaction_id: profitColumns.has('source_transaction_id') ? row.source_transaction_id : null
  }));

  const logs = readActivityRows(userId).map(row => ({
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id == null ? null : String(row.entity_id),
    metadata: metadataObject(row.metadata),
    created_at: row.created_at,
    actor_user_id: row.actor_user_id
  }));

  const counts = {
    categories: categories.length,
    products: products.length,
    transactions: transactions.length,
    transaction_items: itemRows.length,
    profits: profits.length,
    activity_logs: logs.length
  };
  const countedRows = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (countedRows > 10000) {
    throw new Error('Jumlah data akun melebihi batas 10.000 baris dalam satu import.');
  }
  return {
    payload: { categories, products, transactions, profits, activity_logs: logs },
    counts
  };
}

async function main() {
  const users = db.prepare(`
    SELECT id, name, email, role, email_verified_at, supabase_user_id, business_migrated
    FROM users
    WHERE role='user'
    ORDER BY id
  `).all();

  const plans = users.map(user => {
    const migration = buildPayload(user.id);
    return { user, ...migration };
  });

  console.log(APPLY ? 'MODE: IMPORT / APPLY' : 'MODE: DRY RUN (belum ada perubahan data)');
  console.log('Sumber SQLite: ' + databasePath);
  console.log('Akun pengguna lokal: ' + plans.length);

  const blocked = plans.filter(plan => !plan.user.supabase_user_id || !plan.user.email_verified_at);
  for (const plan of plans) {
    let status = 'SIAP';
    if (plan.user.business_migrated) status = 'SUDAH DITANDAI SELESAI';
    else if (!plan.user.supabase_user_id || !plan.user.email_verified_at) status = 'TERTAHAN: akun belum tertaut dan/atau email belum diverifikasi';
    console.log('\n' + plan.user.email + ' — ' + status);
    console.log(JSON.stringify(plan.counts));
  }

  if (!APPLY) {
    console.log('\nDry run selesai. Tinjau akun dan jumlah data. Untuk mulai import, gunakan `npm run migrate:postgres -- --apply`.');
    return;
  }
  if (blocked.length) {
    console.error('\nImport dibatalkan: ada akun yang belum tertaut ke Supabase Auth atau email lokalnya belum diverifikasi.');
    for (const plan of blocked) {
      console.error('- ' + plan.user.email + ': tautkan akun melalui login Supabase dan verifikasi email terlebih dahulu.');
    }
    process.exitCode = 1;
    return;
  }

  let completed = 0;
  for (const plan of plans) {
    const user = plan.user;
    if (user.business_migrated) {
      console.log('\nLewati ' + user.email + ': sudah ditandai selesai.');
      completed++;
      continue;
    }

    const profile = await supabaseRequest('profiles?id=eq.' + encodeURIComponent(user.supabase_user_id) + '&select=id');
    if (!Array.isArray(profile) || !profile.some(row => row.id === user.supabase_user_id)) {
      throw new Error('Profil Supabase tidak ditemukan untuk akun ' + user.email + '.');
    }

    const result = await supabaseRequest('rpc/import_feeku_legacy_user', {
      method: 'POST',
      body: { p_user_id: user.supabase_user_id, p_data: plan.payload }
    });

    // Update the local gate only after PostgreSQL confirms the atomic import.
    db.prepare("UPDATE users SET business_migrated=1, updated_at=datetime('now') WHERE id=? AND supabase_user_id=?")
      .run(user.id, user.supabase_user_id);

    console.log('\nBerhasil: ' + user.email + ' ' + JSON.stringify(result));
    completed++;
  }

  console.log('\nMigrasi selesai. Akun selesai: ' + completed + '/' + plans.length + '. Data bisnis kini disimpan di PostgreSQL.');
}

main()
  .catch(error => {
    console.error('\nMigrasi gagal: ' + error.message);
    if (error.code) console.error('Kode database: ' + error.code);
    process.exitCode = 1;
  })
  .finally(() => db.close());
