# FeeKu Website

Website FeeKu memakai Supabase Auth untuk identitas pengguna dan PostgreSQL Supabase untuk seluruh data bisnis. Backend Node.js/Express memvalidasi access token, menerapkan pembatasan akses administrator, dan menjalankan operasi bisnis melalui Supabase PostgREST/RPC. SQLite tidak lagi menjadi database transaksi aktif; SQLite hanya dipakai untuk session store dan sebagai sumber baca saat migrasi dari instalasi lama.

## Fitur

- **Pengguna:** registrasi/login email-password, verifikasi email, reset password, Google sign-in.
- **Dashboard:** saldo, total masuk/keluar, ringkasan keuntungan, lima transaksi terakhir.
- **Buku Kas:** CRUD transaksi manual dan penjualan dari katalog.
- **Keuntungan:** catatan manual dan margin kotor penjualan otomatis.
- **Katalog stok:** kategori, produk, stok, HPP, harga jual manual/markup/target margin/laba tetap.
- **Laporan:** rentang tanggal, ringkasan, CSV, dan cetak/PDF.
- **Backup/restore:** JSON per akun melalui endpoint PostgreSQL.
- **Panel administrator:** ringkasan akun, status pengguna, rincian data bisnis pengguna, serta log aktivitas.
- **Keamanan data:** RLS berbasis `auth.uid()`, foreign key kepemilikan, validasi server, dan audit log.

## Arsitektur saat ini

```text
Browser
  └── Supabase JS SDK (publishable key + Auth session)
        │
        ├── Supabase Auth (login, refresh, Google OAuth)
        │
        └── Bearer access token
                  ▼
          Node.js / Express
            ├── validasi access token melalui Supabase Auth
            ├── guard pengguna dan administrator
            ├── allowlist jaringan untuk endpoint admin
            ├── REST API → Supabase PostgREST
            └── operasi atomik → PostgreSQL RPC
                         ▼
                Supabase PostgreSQL
                  ├── profiles
                  ├── categories / products
                  ├── transactions / transaction_items
                  ├── profits
                  ├── activity_logs
                  └── payment gateway preparation tables

SQLite:
  ├── data/sessions.sqlite (session/CSRF store saat runtime)
  └── data/buku-kas.sqlite (sumber migrasi lama, tidak dibaca server aktif)
```

Semua operasi bisnis pengguna memakai token Supabase milik pengguna dan dibatasi oleh RLS. Server menggunakan `SUPABASE_SECRET_KEY` hanya untuk fungsi server tepercaya seperti log lintas akun, operasi admin, dan migrasi satu kali. Secret key tidak boleh dikirim ke browser atau disimpan di repository.

## Prasyarat dan instalasi

- Node.js 20.11 atau lebih baru.
- Project Supabase FeeKu yang sudah menerapkan migration pada direktori `supabase/migrations`.
- Provider Auth yang diperlukan sudah dikonfigurasi.

```bash
npm install
```

Buat file `.env` dari `.env.example`. Isi `SESSION_SECRET` dengan secret acak minimal 32 karakter dan isi `SUPABASE_SECRET_KEY` pada environment server. Jangan mengirim secret key ke frontend.

Contoh pengembangan lokal:

```env
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
SUPABASE_URL=https://dvtnxezautjkeshsbdyk.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
SESSION_SECRET=ganti-dengan-random-secret-panjang-minimal-32-karakter
SESSION_DATABASE_FILE=./data/sessions.sqlite
ENABLE_GOOGLE_OAUTH=true
```

Jalankan:

```bash
npm start
```

URL lokal:
- Pengguna: `http://localhost:3000/`
- Administrator: login melalui halaman yang sama; server otomatis mengarahkan akun ber-role admin ke `http://localhost:3000/admin`.
- Health check: `http://localhost:3000/healthz`

## Menjalankan dan memeriksa website secara lokal

Gunakan Node.js 20.11 atau lebih baru.

```bash
npm install
```

Pastikan file `.env` di folder utama project memuat setidaknya:

```env
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
SUPABASE_URL=https://dvtnxezautjkeshsbdyk.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=
SESSION_SECRET=ganti-dengan-random-secret-panjang
ENABLE_GOOGLE_OAUTH=true
```

`SUPABASE_SECRET_KEY` wajib diisi pada server jika akan memakai operasi administrator lintas akun, audit log tepercaya, atau migrasi SQLite. Jangan menaruh secret tersebut di frontend atau repository. Untuk akses dari komputer yang sama, `HOST=0.0.0.0` tetap memungkinkan website dibuka melalui `http://localhost:3000`.

Jalankan server di terminal pertama:

```bash
npm start
```

Buka `http://localhost:3000` di browser. Biarkan terminal server tetap berjalan.

Di terminal kedua, dari folder project yang sama, jalankan pemeriksaan HTTP lokal:

```bash
npm run test:local
```

Pemeriksaan ini menguji HTML shell, file JavaScript/CSS, health check PostgreSQL, konfigurasi Auth, CSRF bootstrap, respons identitas tanpa login, penolakan endpoint pengguna/admin tanpa token, dan redirect rute login admin lama ke satu halaman login. Script tidak membuat transaksi atau mengubah data bisnis.

Untuk alamat/port berbeda:

```bash
npm run test:local -- http://127.0.0.1:3000
```

## Migrasi data bisnis dari SQLite ke PostgreSQL

**Jangan langsung jalankan versi server PostgreSQL pada instalasi lama sebelum data SQLite dimigrasikan.** File sumber harus berasal dari server/komputer yang menjalankan website versi SQLite sebelumnya. File SQLite tidak tersedia di repository dan tidak termasuk dalam project Supabase.

### Sebelum migrasi

1. Jadwalkan maintenance singkat dan hentikan proses penulisan data di website lama.
2. Pastikan seluruh akun lokal yang memiliki data bisnis sudah mempunyai akun Supabase Auth dengan email yang sama dan sudah terverifikasi.
3. Jika database lama sudah memiliki `supabase_user_id`, script akan memprioritaskan pencocokan UUID tersebut, lalu memeriksa bahwa email masih sama.
4. Pastikan file `data/buku-kas.sqlite` dari instalasi lama tersedia. Jangan memakai `sessions.sqlite`.
5. Sediakan `SUPABASE_URL` dan `SUPABASE_SECRET_KEY` di environment server. Secret key tidak boleh ditempel ke command line, frontend, atau repository.

Script melakukan preflight untuk seluruh akun yang dipilih. Jika menemukan akun tidak ada, email tidak cocok/duplikat, email belum terverifikasi, UUID tumpang tindih, atau batas jumlah baris terlampaui, seluruh proses dihentikan sebelum data dikirim.

### Jalankan migrasi

Windows PowerShell:

```powershell
$env:FEEKU_POSTGRES_IMPORT_CONFIRM = 'YES'
npm run migrate:postgres -- 'C:\path\ke\data\buku-kas.sqlite'
Remove-Item Env:FEEKU_POSTGRES_IMPORT_CONFIRM
```

Linux/macOS:

```bash
FEEKU_POSTGRES_IMPORT_CONFIRM=YES npm run migrate:postgres -- /path/ke/data/buku-kas.sqlite
```

Untuk memigrasikan satu akun saja:

```powershell
$env:FEEKU_POSTGRES_IMPORT_CONFIRM = 'YES'
npm run migrate:postgres -- 'C:\path\ke\data\buku-kas.sqlite' --user akun@email.com
Remove-Item Env:FEEKU_POSTGRES_IMPORT_CONFIRM
```

Setiap akun diimpor melalui `public.import_feeku_legacy_user`. RPC mencatat status import dan aman dijalankan ulang untuk akun yang sudah berhasil: data akun yang sudah selesai akan dilewati, bukan digandakan. Proses juga membuat snapshot SQLite konsisten ke folder `backups/` (atau `MIGRATION_BACKUP_DIR`) sebelum mulai mengimpor.

Batas saat ini adalah 10.000 baris per akun menurut penghitung script. Bila melewati batas itu, migrasi berhenti dan perlu penyesuaian kapasitas/strategi import terlebih dahulu.

### Data yang dipertahankan dan batasan

- Kategori, produk, stok, HPP, harga jual, konfigurasi metode harga, transaksi, rincian item penjualan, keuntungan manual, dan log aktivitas dikirim per akun.
- Tanggal transaksi dan keuntungan dipertahankan.
- ID SQLite dipetakan menjadi `legacy_id` pada PostgreSQL; UUID baru dipakai sebagai primary key.
- Snapshot nama produk, kuantitas, harga jual, dan HPP tetap disimpan untuk transaksi historis meskipun produk kemudian dihapus.
- Margin penjualan otomatis dihitung kembali dari snapshot item di PostgreSQL agar tidak diimpor sebagai keuntungan manual ganda.
- Timestamp pembuatan/pembaruan beberapa record akan dibuat oleh PostgreSQL saat import, bukan selalu mempertahankan timestamp SQLite lama.
- Kolom IP dari log historis tidak dipindahkan oleh RPC import saat ini. Log baru mencatat IP melalui server.
- Produk lama yang memiliki HPP 0 tetap dapat dilihat, tetapi perlu dilengkapi HPP sebelum digunakan untuk penjualan katalog sesuai validasi bisnis.

### Verifikasi dan rollback

Setelah migrasi selesai:
1. Periksa jumlah kategori, produk, transaksi, rincian item, dan keuntungan untuk setiap akun.
2. Cocokkan total masuk/keluar, saldo, stok, dan margin dengan laporan dari website SQLite lama.
3. Uji tambah/edit/hapus transaksi manual dan penjualan katalog pada akun pengujian.
4. Uji backup JSON dan restore pada akun pengujian.
5. Pastikan pengguna tidak bisa membaca atau mengubah data akun lain.
6. Uji akun biasa ditolak pada seluruh endpoint admin.

Jangan hapus atau menimpa database SQLite dan snapshot backup sebelum verifikasi selesai. Untuk rollback, hentikan aplikasi baru dan deploy kembali versi SQLite lama menggunakan file database SQLite asli. PostgreSQL hasil import tidak dihapus otomatis, sehingga data hasil migrasi tetap tersedia untuk rekonsiliasi.

## Import dari aplikasi Flutter lama

`scripts/import-legacy-sqlite.js` adalah utilitas lama untuk mengimpor backup SQLite dari aplikasi Flutter ke database website SQLite lama. Jika data dari aplikasi Flutter belum pernah masuk ke website SQLite, jalankan utilitas itu pada instalasi/versi lama terlebih dahulu, verifikasi hasilnya, kemudian jalankan `migrate:postgres` di atas. Jangan menjalankan utilitas lama tersebut setelah cutover PostgreSQL; script itu bukan jalur import langsung ke PostgreSQL.

## Administrator

Akun publik selalu dibuat sebagai pengguna biasa. Untuk memberi role administrator:
1. Buat akun melalui halaman registrasi biasa dan verifikasi emailnya.
2. Set `SUPABASE_SECRET_KEY` pada environment server.
3. Jalankan perintah berikut dari terminal server. Tidak ada opsi atau form khusus administrator di halaman login:

```bash
npm run create-admin -- admin@domain.com
```

Untuk mencabut role:

```bash
npm run revoke-admin -- admin@domain.com
```

Setelah perubahan role, administrator perlu logout dan login lagi agar claim `app_metadata.role` pada access token diperbarui. Backend tidak mempercayai `user_metadata` yang dapat diedit pengguna.

Panel admin memiliki allowlist IP melalui `ADMIN_ALLOWED_CIDRS`. Jika kosong, server hanya mengizinkan loopback dan rentang jaringan privat/link-local. Jangan gunakan `0.0.0.0/0` atau `::/0` untuk membuka panel admin ke semua jaringan. Jika server berada di belakang reverse proxy, atur `TRUST_PROXY` hanya untuk jumlah proxy yang benar-benar tepercaya.

## Email dan Google OAuth

- Email/password, konfirmasi email, reset password, serta Google sign-in disediakan oleh Supabase Auth.
- Untuk pengujian email dengan built-in SMTP Supabase, penerima dibatasi pada anggota organisasi/project. Layanan bawaan itu bukan untuk email publik/production.
- Untuk penggunaan publik, siapkan domain pengirim dan custom SMTP terverifikasi sebelum membuka registrasi.
- Simpan Google OAuth Client ID/Secret di Supabase Dashboard, bukan di GitHub. Callback Supabase untuk project ini adalah `https://dvtnxezautjkeshsbdyk.supabase.co/auth/v1/callback`.
- Set `ENABLE_GOOGLE_OAUTH=true` pada environment website setelah provider Google Supabase aktif.

## Backup

- Backup per akun pada menu Pengaturan menggunakan `GET /api/settings/backup` dan menghasilkan JSON.
- Restore per akun memakai `POST /api/settings/restore` dan RPC PostgreSQL `restore_feeku_user_backup`.
- `npm run backup:sqlite-legacy` hanya mencadangkan file SQLite sumber lama untuk keperluan migrasi/rollback. Itu bukan backup PostgreSQL aktif.
- Buat backup PostgreSQL di luar aplikasi secara berkala sesuai strategi operasional Supabase dan simpan di lokasi terpisah/terenkripsi.

## Validasi kode

```bash
npm run check
```

Pemeriksaan tersebut menjalankan syntax check Node.js untuk server, frontend, script provisioning, import Flutter lama, migrator PostgreSQL, dan backup SQLite legacy.
