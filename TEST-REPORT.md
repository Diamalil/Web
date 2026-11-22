# Laporan Pengujian FeeKu PostgreSQL Cutover

Pembaruan: 22 November 2026

## 1. Source code

Syntax check JavaScript dan JSON pada branch `fix/single-login-google-oauth`:

- `server.js` — lulus.
- `public/app.js` — lulus.
- `scripts/create-admin.js` — lulus.
- `scripts/import-legacy-sqlite.js` — lulus.
- `scripts/migrate-sqlite-to-postgres.js` — lulus.
- `scripts/backup-database.js` — lulus.
- `package.json` — JSON valid.

## 2. Arsitektur API

Endpoint bisnis website memakai Supabase PostgREST/PostgreSQL. SQLite hanya dipakai sebagai session store dan sumber baca saat migrasi satu kali dari instalasi lama.

## 3. Uji database dan RLS

Jalur transaksi katalog diuji dengan role `authenticated`. Penjualan satu unit dari stok dua unit menghasilkan stok satu, omzet 20, dan margin otomatis 10. Insert keuntungan manual milik akun sendiri juga lulus.

Semua pengujian memakai transaksi SQL dengan `ROLLBACK`, sehingga tidak meninggalkan data uji. Setelah pengujian, tabel bisnis tetap kosong. Kebijakan RLS ganda telah dibersihkan.

## 4. Login tunggal dan OAuth

**Status implementasi UI: DIPERBAIKI.**

- Hanya ada satu halaman/form login pengguna.
- Tidak ada tautan, tombol, atau halaman login administrator yang terpisah.
- Semua akun masuk melalui form email/password atau Google ketika Google OAuth aktif.
- Setelah autentikasi, backend menentukan role dari `app_metadata.role`. Akun biasa diarahkan ke dashboard; akun admin diarahkan ke `/admin`.
- Role administrator hanya diberikan/dicabut melalui script terminal `npm run create-admin` dan `npm run revoke-admin`.
- Rute lama `/admin/login` diarahkan ke halaman login tunggal.
- Tombol Google hanya ditampilkan saat `ENABLE_GOOGLE_OAUTH=true`, konfigurasi Supabase URL/key tersedia, dan Supabase JS client berhasil dibuat.
- Backend menerima `SUPABASE_PUBLISHABLE_KEY`; nama lama `SUPABASE_ANON_KEY` dan `SUPABASE_PUBLIC_KEY` juga didukung agar konfigurasi lama tidak diam-diam mematikan Auth.

Google OAuth sebelumnya telah berhasil diuji pada project. Browser end-to-end setelah perubahan UI ini tetap perlu diuji pada server yang menjalankan branch terbaru.

## 5. SQLite → PostgreSQL data import

**Status: SCRIPT SIAP, IMPORT DATA NYATA BELUM DIJALANKAN.**

File database SQLite lama dari server pemilik project tidak tersedia pada sesi ini. Jalankan `npm run migrate:postgres` terhadap file database asli sebelum menganggap data bisnis sudah berpindah. Jangan hapus SQLite asli sampai saldo, stok, transaksi, rincian item, dan margin diverifikasi.

## 6. Advisor dan batas pengujian

- Health Advisor tidak melaporkan temuan.
- Security Advisor masih melaporkan SECURITY DEFINER pada `restore_feeku_user_backup` dan Leaked Password Protection nonaktif.
- Administrator belum diprovisikan pada akun mana pun.
- Pengujian HTTP/browser penuh serta cutover staging belum dilaksanakan.

