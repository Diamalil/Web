'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const sourcePath = path.resolve(process.argv[2] || process.env.DATABASE_FILE || './data/buku-kas.sqlite');
const userArg = process.argv.indexOf('--user');
const selectedEmail = userArg >= 0 ? String(process.argv[userArg + 1] || '').trim().toLowerCase() : '';
const backupDir = path.resolve(process.env.MIGRATION_BACKUP_DIR || './backups');

function fail(message) {
  throw new Error(message);
}

function hasColumn(db, table, column) {
  return db.pragma('table_info(' + table + ')').some(item => item.name === column);
}

function readRows(db, table, where = '1=1', params = {}) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!tables.has(table)) return [];
  return db.prepare('SELECT * FROM ' + table + ' WHERE ' + where + ' ORDER BY id').all(params);
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeAuthUser(user) {
  return {
    id: user.id,
    email: String(user.email || '').trim().toLowerCase(),
    emailConfirmedAt: user.email_confirmed_at || user.confirmed_at || null,
    appMetadata: user.app_metadata || {}
  };
}

async function requestSupabase(resource, options = {}) {
  const response = await fetch(SUPABASE_URL + resource, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + SUPABASE_SECRET_KEY,
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30000)
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch (_) { data = { message: raw }; }
  }
  if (!response.ok) {
    const message = data && (data.message || data.details || data.error_description || data.error || data.msg);
    throw new Error('Supabase request ' + resource + ' gagal (' + response.status + '): ' + (message || raw || 'unknown error'));
  }
  return data;
}

async function listAuthUsers() {
  const output = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page += 1) {
    const result = await requestSupabase('/auth/v1/admin/users?page=' + page + '&per_page=' + perPage);
    const batch = Array.isArray(result && result.users) ? result.users : [];
    output.push(...batch.map(normalizeAuthUser));
    if (batch.length < perPage) return output;
  }
  fail('Jumlah akun Supabase Auth melewati batas pemeriksaan 10.000.');
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function importPayload(db, localUserId) {
  const categories = readRows(db, 'categories', 'user_id=@id', { id: localUserId }).map(row => ({
    id: Number(row.id),
    name: String(row.name || '').trim(),
    description: row.description || null
  })).filter(row => row.name);

  const products = readRows(db, 'products', 'user_id=@id', { id: localUserId }).map(row => ({
    id: Number(row.id),
    category_id: Number(row.category_id),
    name: String(row.name || 'Barang impor').trim(),
    sku: row.sku || null,
    unit_name: row.unit_name || 'pcs',
    stock: Math.max(0, Number(row.stock || 0)),
    price: Math.max(0, Number(row.price || row.sale_price || 0)),
    unit_cost: Math.max(0, Number(row.unit_cost || 0)),
    sale_price: Math.max(0, Number(row.sale_price || row.price || 0)),
    pricing_method: row.pricing_method || 'manual',
    pricing_value: Math.max(0, Number(row.pricing_value || 0)),
    is_active: row.is_active == null ? true : Boolean(row.is_active)
  }));

  const allItems = readRows(db, 'transaction_items', 'user_id=@id', { id: localUserId });
  const itemsByTransaction = new Map();
  for (const row of allItems) {
    const key = Number(row.transaction_id);
    const list = itemsByTransaction.get(key) || [];
    list.push({
      id: Number(row.id),
      product_id: row.product_id == null ? null : Number(row.product_id),
      product_name: String(row.product_name || 'Produk'),
      quantity: Math.max(0, Number(row.quantity || 0)),
      unit_sale_price: Math.max(0, Number(row.unit_sale_price || 0)),
      unit_cost: Math.max(0, Number(row.unit_cost || 0)),
      line_total: Math.max(0, Number(row.line_total || 0)),
      line_profit: Number(row.line_profit || 0)
    });
    itemsByTransaction.set(key, list);
  }

  const transactions = readRows(db, 'transactions', 'user_id=@id', { id: localUserId }).map(row => ({
    id: Number(row.id),
    date: row.date,
    entry_date: row.date,
    description: String(row.description || '').trim(),
    type: row.type,
    direction: row.type,
    amount: Number(row.amount || 0),
    items: itemsByTransaction.get(Number(row.id)) || []
  }));

  const profits = readRows(db, 'profits', 'user_id=@id', { id: localUserId }).map(row => ({
    id: Number(row.id),
    date: row.date,
    entry_date: row.date,
    description: String(row.description || '').trim(),
    type: row.type,
    direction: row.type,
    amount: Number(row.amount || 0),
    source_transaction_id: row.source_transaction_id == null ? null : Number(row.source_transaction_id),
    source: row.source || (row.source_transaction_id == null ? 'manual' : 'transaction_margin')
  }));

  const activityLogs = tableExists(db, 'activity_logs')
    ? readRows(db, 'activity_logs', 'actor_user_id=@id', { id: localUserId }).map(row => ({
        actor_user_id: row.actor_user_id,
        action: String(row.action || 'legacy_activity').slice(0, 100),
        entity_type: String(row.entity_type || 'legacy').slice(0, 80),
        entity_id: row.entity_id == null ? null : String(row.entity_id),
        metadata: parseMetadata(row.metadata),
        ip_address: row.ip_address || null,
        created_at: row.created_at || null
      }))
    : [];

  const totalRows = categories.length + products.length + transactions.length +
    allItems.length + profits.filter(row => row.source === 'manual' && row.source_transaction_id == null).length +
    activityLogs.length;

  return {
    categories,
    products,
    transactions,
    profits,
    activity_logs: activityLogs,
    counts: {
      categories: categories.length,
      products: products.length,
      transactions: transactions.length,
      transaction_items: allItems.length,
      manual_profits: profits.filter(row => row.source === 'manual' && row.source_transaction_id == null).length,
      activity_logs: activityLogs.length,
      totalRows
    }
  };
}

async function createConsistentSnapshot(sourceFile) {
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotFile = path.join(backupDir, 'feeku-sqlite-pre-postgres-' + timestamp + '.sqlite');
  const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(snapshotFile);
  } finally {
    source.close();
  }
  try { fs.chmodSync(snapshotFile, 0o600); } catch (_) {}
  return snapshotFile;
}

async function main() {
  if (!SUPABASE_URL || !/^https:\/\//i.test(SUPABASE_URL)) fail('SUPABASE_URL HTTPS wajib diisi.');
  if (!SUPABASE_SECRET_KEY) fail('SUPABASE_SECRET_KEY wajib diisi pada server. Jangan taruh key ini di browser atau repository.');
  if (!fs.existsSync(sourcePath)) fail('File SQLite sumber tidak ditemukan: ' + sourcePath);
  if (selectedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selectedEmail)) fail('Email pada --user tidak valid.');
  if (String(process.env.FEEKU_POSTGRES_IMPORT_CONFIRM || '') !== 'YES') {
    fail('Konfirmasi belum diberikan. Backup aman akan dibuat, tetapi sebelum import set FEEKU_POSTGRES_IMPORT_CONFIRM=YES.');
  }

  console.log('Membuat snapshot SQLite yang konsisten...');
  const snapshotPath = await createConsistentSnapshot(sourcePath);
  console.log('Snapshot sumber tersimpan di: ' + snapshotPath);

  const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    if (!Array.isArray(integrity) || integrity.length !== 1 ||
        String(integrity[0].integrity_check || '').toLowerCase() !== 'ok') {
      fail('Snapshot SQLite gagal pemeriksaan integrity_check. Jangan lanjutkan import sebelum database sumber diperbaiki.');
    }
    if (!tableExists(db, 'users')) fail('Database sumber tidak memiliki tabel users. Pastikan file yang dipilih adalah database website FeeKu lama.');
    const users = readRows(db, 'users');
    if (selectedEmail) {
      const selected = users.filter(user => String(user.email || '').trim().toLowerCase() === selectedEmail);
      if (!selected.length) fail('Akun lokal dengan email tersebut tidak ditemukan dalam SQLite.');
      users.splice(0, users.length, ...selected);
    }
    if (!users.length) fail('Tidak ada akun lokal yang dapat dimigrasikan.');

    console.log('Memeriksa akun Supabase Auth dan email terverifikasi...');
    const authUsers = await listAuthUsers();
    const authById = new Map(authUsers.map(user => [user.id, user]));
    const authByEmail = new Map();
    for (const user of authUsers) {
      const list = authByEmail.get(user.email) || [];
      list.push(user);
      authByEmail.set(user.email, list);
    }

    const jobs = [];
    const unmatched = [];
    const seenAuthIds = new Set();
    for (const localUser of users) {
      const email = String(localUser.email || '').trim().toLowerCase();
      let authUser = null;
      if (localUser.supabase_user_id) {
        authUser = authById.get(String(localUser.supabase_user_id)) || null;
      } else {
        const matches = authByEmail.get(email) || [];
        if (matches.length === 1) authUser = matches[0];
        else if (matches.length > 1) unmatched.push(email + ' (email terduplikasi di Supabase Auth)');
      }
      if (!authUser) {
        unmatched.push(email + ' (akun Auth tidak ditemukan atau UUID tidak cocok)');
        continue;
      }
      if (authUser.email !== email) {
        unmatched.push(email + ' (email SQLite dan Supabase tidak cocok)');
        continue;
      }
      if (!authUser.emailConfirmedAt) {
        unmatched.push(email + ' (email Supabase belum terverifikasi)');
        continue;
      }
      if (seenAuthIds.has(authUser.id)) {
        unmatched.push(email + ' (lebih dari satu akun SQLite menunjuk ke UUID yang sama)');
        continue;
      }
      seenAuthIds.add(authUser.id);
      const payload = importPayload(db, Number(localUser.id));
      if (payload.counts.totalRows > 10000) {
        unmatched.push(email + ' (melewati batas 10.000 baris per akun: ' + payload.counts.totalRows + ')');
        continue;
      }
      jobs.push({
        email,
        userId: authUser.id,
        payload
      });
    }

    if (unmatched.length) {
      console.error('\nMigrasi dibatalkan sebelum ada data yang dikirim. Perbaiki pemetaan akun berikut:');
      unmatched.forEach(item => console.error(' - ' + item));
      fail('Ada akun yang belum dapat dipetakan dengan aman. Tidak ada akun yang diimpor pada proses ini.');
    }

    const total = jobs.reduce((sum, job) => sum + job.payload.counts.totalRows, 0);
    console.log('Pemeriksaan selesai: ' + jobs.length + ' akun, ' + total + ' baris bisnis/aktivitas.');
    console.log('Migrasi menggunakan RPC idempotent per akun. Data SQLite asli tidak akan dihapus.');

    for (const job of jobs) {
      console.log('\nMengimpor ' + job.email + ' (' + job.payload.counts.totalRows + ' baris)...');
      const result = await requestSupabase('/rest/v1/rpc/import_feeku_legacy_user', {
        method: 'POST',
        body: {
          p_user_id: job.userId,
          p_data: {
            categories: job.payload.categories,
            products: job.payload.products,
            transactions: job.payload.transactions,
            profits: job.payload.profits,
            activity_logs: job.payload.activity_logs
          }
        }
      });
      const report = Array.isArray(result) ? result[0] : result;
      if (report && report.already_imported) {
        console.log('  Dilewati: akun ini sudah pernah diimpor sebelumnya.');
      } else {
        console.log('  Selesai: ' + JSON.stringify(report || job.payload.counts));
      }
    }

    console.log('\nMigrasi selesai.');
    console.log('PENTING: SQLite asli dan snapshot tetap disimpan sebagai rollback. Jangan hapus sebelum verifikasi data di FeeKu selesai.');
    console.log('Tanggal transaksi/keuntungan dipertahankan. Timestamp pembuatan beberapa record bisnis dibuat ulang oleh prosedur impor.');
    console.log('Field IP pada log lama dibawa dalam payload, tetapi prosedur PostgreSQL saat ini hanya mengimpor metadata dan waktu log.');
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error('\nMigrasi PostgreSQL gagal: ' + error.message);
  process.exitCode = 1;
});
