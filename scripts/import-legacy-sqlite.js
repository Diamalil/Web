require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const email = String(process.argv[2] || '').trim().toLowerCase();
const sourcePath = path.resolve(process.argv[3] || '');
if (!/^\S+@\S+\.\S+$/.test(email) || !process.argv[3] || !fs.existsSync(sourcePath)) {
  console.error('Pemakaian: node scripts/import-legacy-sqlite.js pengguna@email.com "C:\\path\\buku_kas.db"');
  process.exit(1);
}
if (String(process.env.LEGACY_IMPORT_CONFIRM || '') !== 'YES') {
  console.error('Untuk menghindari import tanpa sengaja, jalankan ulang dengan LEGACY_IMPORT_CONFIRM=YES.');
  process.exit(1);
}
const dbFile = path.resolve(process.env.DATABASE_FILE || './data/buku-kas.sqlite');
if (!fs.existsSync(dbFile)) {
  console.error('Database website belum ada. Jalankan server sekali untuk membuat skema database.');
  process.exit(1);
}
const target = new Database(dbFile);
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  const user = target.prepare("SELECT id,role FROM users WHERE email=? COLLATE NOCASE").get(email);
  if (!user || user.role !== 'user') throw new Error('Akun target tidak ditemukan atau bukan akun pengguna biasa.');
  const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  const readAll = table => tables.has(table) ? source.prepare(`SELECT * FROM ${table}`).all() : [];
  const transaksi = readAll('transaksi');
  const keuntungan = readAll('keuntungan');
  const kategori = readAll('kategori');
  const barang = readAll('barang');
  const imported = target.transaction(() => {
    const categoryMap = new Map();
    const insertCategory = target.prepare('INSERT INTO categories(user_id,name) VALUES(?,?)');
    const findCategory = target.prepare('SELECT id FROM categories WHERE user_id=? AND name=? COLLATE NOCASE');
    for (const c of kategori) {
      const name = String(c.nama || '').trim();
      if (!name) continue;
      let existing = findCategory.get(user.id, name);
      if (!existing) {
        const result = insertCategory.run(user.id, name);
        existing = { id: Number(result.lastInsertRowid) };
      }
      categoryMap.set(Number(c.id), existing.id);
    }
    const insertProduct = target.prepare('INSERT INTO products(user_id,category_id,name,stock,price) VALUES(?,?,?,?,?)');
    let productCount = 0;
    for (const p of barang) {
      const categoryId = categoryMap.get(Number(p.kategori_id));
      if (!categoryId) continue;
      insertProduct.run(user.id, categoryId, String(p.nama || 'Barang impor').trim().slice(0,100), Math.max(0, Math.trunc(Number(p.stok) || 0)), Math.max(0, Number(p.harga) || 0));
      productCount++;
    }
    const insertLedger = (table, rows) => {
      const stmt = target.prepare(`INSERT INTO ${table}(user_id,date,description,type,amount) VALUES(?,?,?,?,?)`);
      let count = 0;
      for (const row of rows) {
        const date = String(row.tanggal || '');
        const type = String(row.jenis || '');
        const description = String(row.keterangan || '').trim();
        const amount = Number(row.nominal);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['Masuk','Keluar'].includes(type) || !description || !Number.isFinite(amount) || amount <= 0) continue;
        stmt.run(user.id, date, description.slice(0,200), type, amount);
        count++;
      }
      return count;
    };
    return {
      transactions: insertLedger('transactions', transaksi),
      profits: insertLedger('profits', keuntungan),
      categories: categoryMap.size,
      products: productCount
    };
  });
  console.log(`Import selesai untuk ${email}:`);
  console.log(`  Transaksi: ${imported.transactions}`);
  console.log(`  Keuntungan: ${imported.profits}`);
  console.log(`  Kategori: ${imported.categories}`);
  console.log(`  Barang: ${imported.products}`);
  console.log('Import menambahkan data dan tidak menghapus data yang sudah ada. Jalankan sekali saja untuk menghindari duplikasi.');
} catch (err) {
  console.error(`Import gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  source.close();
  target.close();
}
