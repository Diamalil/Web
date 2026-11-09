'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

async function main() {
  const sourcePath = path.resolve(process.env.DATABASE_FILE || './data/buku-kas.sqlite');
  const backupDir = path.resolve(process.env.BACKUP_DIR || './backups');
  const retentionValue = Number(process.env.BACKUP_RETENTION_DAYS || 14);
  const retentionDays = Number.isFinite(retentionValue) ? Math.max(1, Math.floor(retentionValue)) : 14;
  if (!fs.existsSync(sourcePath)) throw new Error(`Database tidak ditemukan: ${sourcePath}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `buku-kas-${stamp}.sqlite`);
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  try { fs.chmodSync(destination, 0o600); } catch (_) { /* Windows ACL is managed separately. */ }
  const verify = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = verify.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Backup gagal pemeriksaan integritas: ${integrity}`);
    const users = verify.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    console.log(`Backup berhasil: ${destination}`);
    console.log(`Pemeriksaan SQLite: ${integrity}; jumlah akun: ${users}`);
  } finally {
    verify.close();
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(backupDir)) {
    if (!/^buku-kas-.*\.sqlite$/.test(name)) continue;
    const file = path.join(backupDir, name);
    if (file === destination) continue;
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (_) { /* Keep files that cannot be inspected. */ }
  }
}

main().catch(error => {
  console.error(`Backup gagal: ${error.message}`);
  process.exitCode = 1;
});
