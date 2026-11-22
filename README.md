# Buku Kas Website

Versi website dari aplikasi Flutter Buku Kas. Aplikasi memakai Supabase Auth untuk identitas pengguna, email/password, verifikasi email, pemulihan akun, dan Google sign-in. Backend Express memvalidasi access token Supabase dan saat ini masih memakai SQLite untuk data operasional lama (transaksi, keuntungan, stok, dan laporan). Schema PostgreSQL FeeKu disiapkan terpisah untuk migrasi data operasional berikutnya.

## 1. Hasil bedah aplikasi asli

Repo sumber saat ini adalah aplikasi **Flutter/Dart** (`pubspec.yaml`, SDK Dart `^3.12.2`), bukan aplikasi web backend. Struktur source utama:

| Lokasi | Fungsi |
|---|---|
| `lib/main.dart` | `MaterialApp`, tema Material 3 hijau, navigasi enam tab |
| `lib/database/database_helper.dart` | SQLite lokal perangkat, skema database versi 3 |
| `lib/models/transaksi.dart` | Model transaksi uang masuk/keluar |
| `lib/models/barang.dart`, `kategori.dart` | Model item stok dan kategori |
| `lib/pages/dashboard_page.dart` | Saldo saat ini, total masuk/keluar, transaksi terbaru |
| `lib/pages/transaksi_page.dart`, `tambah_transaksi_page.dart`, `edit_transaksi_page.dart` | CRUD Buku Kas |
| `lib/pages/keuntungan_page.dart` | Ringkasan dan CRUD catatan keuntungan |
| `lib/pages/stok_page.dart`, `form_barang_page.dart` | Kategori, barang, harga, tambah/kurang stok |
| `lib/pages/laporan_page.dart` | Filter rentang tanggal dan ringkasan laporan |
| `lib/pages/pengaturan_page.dart` | Backup/restore lokal, ekspor PDF, informasi aplikasi |
| `lib/services/*` | Logika transaksi, stok, keuntungan, backup, dan PDF |
| `assets/images/icon.png` | Ikon aplikasi |
| `web/` | Shell web bawaan Flutter, belum merupakan website server mandiri |

Database aplikasi asli memakai `sqflite` dengan tabel `transaksi`, `keuntungan`, `kategori`, dan `barang`. Data tersimpan di perangkat yang menjalankan aplikasi. `README.md` pada repo sumber masih kosong dan tidak ada autentikasi, akun, API server, atau pencatatan aktivitas terpusat.

## 2. Fitur website

- **Pengguna:** daftar dan login melalui Supabase Auth; email wajib diverifikasi; reset password menggunakan Supabase Auth; Google sign-in tersedia setelah provider Google dikonfigurasi pada Supabase.
- **Panel admin:** halaman login terpisah di `/admin/login`; role diberikan melalui script server dengan Supabase Secret Key dan tidak tersedia pada form registrasi publik.
- **Dashboard:** saldo, total uang masuk/keluar, ringkasan keuntungan, lima transaksi terakhir.
- **Buku Kas:** tambah, edit, hapus, dan daftar transaksi; transaksi Masuk dapat memakai satu atau beberapa produk katalog, jumlah, serta harga jual per unit. Omzet penjualan masuk sebagai nilai transaksi penuh ke Dashboard.
- **Keuntungan:** margin kotor penjualan tercatat otomatis sebagai pemasukan (atau pengeluaran bila transaksi merugi), sementara catatan keuntungan lain tetap dapat ditambahkan/diedit/dihapus manual. Catatan margin otomatis dikelola melalui transaksi asal agar tidak dobel.
- **Katalog stok:** kategori dan produk, stok, HPP/modal per unit, metode harga jual manual/markup/margin/laba tetap, serta pratinjau margin per unit. Penjualan produk dari katalog mengurangi stok otomatis.
- **Laporan:** rentang tanggal, total masuk/keluar, saldo periode, ekspor CSV dan cetak/Simpan sebagai PDF melalui browser.
- **Pengaturan:** backup/restore JSON per akun dan ekspor laporan PDF.
- **Audit admin:** melihat pengguna, status akun, jumlah catatan, data keuangan/stok setiap pengguna, dan log aktivitas. Admin dapat mengaktifkan/menonaktifkan akun; password pengguna tidak bisa dibaca.

Tampilan mempertahankan bahasa, warna hijau Material 3, kartu saldo, ringkasan masuk/keluar, pola daftar transaksi, kategori stok, serta enam menu utama dari aplikasi Flutter. Pada layar lebar menu menjadi sidebar; pada ponsel menjadi navigasi bawah.

## 3. Arsitektur

```text
Browser
  └── Supabase JS SDK (publishable key)
        │  Supabase Auth session / Bearer access token
        ▼
Node.js / Express (server.js)
  ├── validasi token melalui Supabase Auth
  ├── email/password + verifikasi + reset + Google OAuth
  ├── role guard berdasarkan app_metadata.role yang dikelola server
  ├── pembatasan jaringan untuk seluruh endpoint admin
  ├── REST API transaksi / keuntungan / stok / laporan
  └── activity_logs (audit trail)
        ▼
SQLite di server (data/buku-kas.sqlite)
```

Semua tabel data bisnis memiliki `user_id`. Query untuk pengguna selalu dibatasi berdasarkan ID akun dari session server, bukan ID yang dikirim dari browser. Administrator mempunyai endpoint baca lintas pengguna yang berbeda dan endpoint pengelolaan status pengguna.

## 4. Menjalankan lokal

Persyaratan: **Node.js 20.11 atau lebih baru** dan npm.

```bash
cd website
npm install
```

Buat file `.env` dari `.env.example`, lalu isi `SESSION_SECRET` dengan nilai acak panjang minimal 32 karakter. Contoh pengembangan lokal:

```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
SESSION_SECRET=ganti-dengan-random-secret-panjang-minimal-32-karakter
APP_BASE_URL=http://localhost:3000
```

Jalankan server:

```bash
npm start
```

Buka:

- Pengguna: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin/login`
- Health check: `http://localhost:3000/healthz`

## 5. Membuat akun administrator

**Panduan terbaru:** administrator dibuat melalui Supabase Auth, bukan akun lokal SQLite. Buat akun pengguna biasa terlebih dahulu, verifikasi email, lalu jalankan `npm run create-admin -- admin@domain.com` menggunakan `SUPABASE_SECRET_KEY` di environment server. Lihat bagian **Supabase Auth Integration (current)** di bagian bawah dokumen ini untuk detail provisioning dan pencabutan akses.

## 6. Kebijakan jaringan login admin

Panel admin memiliki dua lapisan proteksi:

1. Login admin memakai endpoint Supabase Auth yang sama seperti pengguna biasa; backend hanya menerima akun dengan claim `app_metadata.role=admin`.
2. IP klien diperiksa saat sesi admin diverifikasi **dan pada setiap request endpoint admin**.

Jika `ADMIN_ALLOWED_CIDRS` kosong, default yang diizinkan hanya loopback, private LAN IPv4 (`10/8`, `172.16/12`, `192.168/16`), serta IPv6 ULA/link-local. Ini mendukung akses lokal. Untuk akses melalui internet, tambahkan IP publik statis admin atau CIDR VPN tepercaya, misalnya:

```env
ADMIN_ALLOWED_CIDRS=127.0.0.1/8,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,203.0.113.25/32
```

`203.0.113.25` hanya contoh dokumentasi. Ganti dengan IP publik nyata yang digunakan admin. Jangan memasukkan `0.0.0.0/0` atau `::/0` jika ingin admin benar-benar dibatasi. Jika IP internet berubah, allowlist perlu diperbarui atau gunakan VPN dengan IP keluar tetap.

Untuk akses melalui reverse proxy, set `TRUST_PROXY=1` hanya bila tepat satu proxy tepercaya berada di depan aplikasi. Jangan mempercayai header IP dari proxy yang tidak Anda kendalikan. Gunakan HTTPS di server publik.

## 7. Login Google

Google sign-in sekarang menggunakan Supabase Auth. Jangan gunakan `/auth/google/callback` milik Passport lama. Ikuti langkah pada bagian **Google sign-in activation** di bagian bawah dokumen ini, termasuk callback Supabase `https://dvtnxezautjkeshsbdyk.supabase.co/auth/v1/callback`.


## 8. Deployment internet

Deploy pada VPS atau server Node.js yang memiliki penyimpanan persisten. Contoh konfigurasi production:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_BASE_URL=https://DOMAIN-ANDA
SESSION_SECRET=nilai-random-panjang-minimal-32-karakter
TRUST_PROXY=1
ADMIN_ALLOWED_CIDRS=IP-PUBLIK-ADMIN/32,192.168.0.0/16,10.0.0.0/8
DATABASE_FILE=./data/buku-kas.sqlite
SESSION_DATABASE_FILE=./data/sessions.sqlite
```

Letakkan Nginx/Caddy di depan server untuk TLS/HTTPS dan teruskan request ke port aplikasi. Pastikan folder `data/` mempunyai izin tulis dan berada di disk persisten. Atur firewall agar port aplikasi tidak diekspos langsung ke internet bila memakai reverse proxy. Simpan backup database di lokasi terpisah secara berkala.

## 9. Migrasi data dari aplikasi Flutter lama

Data lama tidak otomatis muncul di website karena file SQLite lama berada di penyimpanan perangkat masing-masing. Website menyertakan script untuk mengimpor file backup `.db` dari fitur Backup aplikasi Flutter:

1. Dari aplikasi lama, buat backup dan salin file `buku_kas_*.db` ke komputer/server.
2. Buat akun pengguna di website dan login sekali agar akun tersedia.
3. Jalankan script dari folder `website`:

Linux/macOS:

```bash
LEGACY_IMPORT_CONFIRM=YES node scripts/import-legacy-sqlite.js pengguna@email.com /path/ke/buku_kas.db
```

Windows PowerShell:

```powershell
$env:LEGACY_IMPORT_CONFIRM = 'YES'
node scripts/import-legacy-sqlite.js pengguna@email.com 'C:\path\buku_kas.db'
Remove-Item Env:LEGACY_IMPORT_CONFIRM
```

Import menambahkan data Buku Kas, keuntungan, kategori, dan barang ke akun tujuan. Script tidak menghapus data akun yang sudah ada. Jalankan hanya sekali untuk menghindari duplikasi.

## 10. Keamanan dan batasan yang perlu diketahui

- Password dikelola dan di-hash oleh Supabase Auth; website tidak menyimpan password pengguna.
- Browser menyimpan sesi Supabase melalui Supabase JS SDK; access token dikirim sebagai Bearer token dan divalidasi server ke Supabase Auth.
- Mutasi API menggunakan CSRF token, validasi input, serta rate limit.
- Role administrator berasal dari `app_metadata.role` yang hanya diubah melalui script server terpercaya; `user_metadata` tidak dipakai untuk otorisasi.
- Data operasional SQLite sementara di-scope menggunakan ID pengguna lokal yang ditautkan ke UUID Supabase Auth.
- Admin melihat data sensitif finansial seluruh pengguna. Akses admin harus diberikan hanya kepada pihak yang berwenang; penggunaan akses tersebut dicatat di activity log.
- Verifikasi email dan reset password dikirim oleh Supabase Auth. Atur SMTP kustom di dashboard Supabase untuk penggunaan production.
- Backup website berupa JSON; backup SQLite dari aplikasi Flutter lama diimpor melalui script migrasi di atas.
- SQLite cocok untuk satu server dan beban kecil/menengah. Untuk trafik besar atau beberapa server aplikasi, migrasikan database ke PostgreSQL dan gunakan session store terdistribusi.
- Google sign-in memerlukan Google OAuth Client ID/Secret yang disimpan pada Supabase Dashboard. Ikuti bagian **Google sign-in activation** di bagian bawah dokumen ini; source code saja tidak dapat membuat kredensial Google.


## 11. Pembaruan keamanan versi 1.1

Catatan historis: versi 1.1 dahulu menangani verifikasi email dan pemulihan password di backend lokal. Alur autentikasi tersebut kini sudah digantikan Supabase Auth. Pembatasan percobaan login, audit aktivitas admin, batas kepemilikan kategori-barang SQLite, serta backup database tetap dipakai.

### Email verification dan reset password

- Registrasi email/password menggunakan Supabase Auth.
- Supabase mengirim tautan verifikasi dan pemulihan berdasarkan konfigurasi URL Redirect.
- Password dikelola oleh Supabase Auth; aplikasi tidak menyimpan hash password pengguna di SQLite.
- Atur SMTP kustom di Supabase Dashboard sebelum production.

### Proteksi login dan admin

- Login user/admin dibatasi 5 percobaan gagal per IP dalam 15 menit melalui rate limiter proses Node.js; pembatasan ini akan reset saat proses server restart dan perlu shared store saat aplikasi dijalankan di beberapa instance.
- Supabase Auth mengelola masa berlaku access token dan refresh token; penonaktifan akun lokal menghentikan akses endpoint setelah status akun diperiksa ulang.
- Role admin, whitelist CIDR, dan pemeriksaan IP dilakukan di backend pada setiap endpoint admin.
- Aksi melihat overview, daftar user, detail user, dan log aktivitas tercatat di activity log.
- `isActive` pada endpoint admin wajib berupa boolean.

### Isolasi data

Query transaksi, keuntungan, kategori, barang, laporan, dan backup user menggunakan `req.user.id` hasil pemetaan identitas Supabase Auth ke pengguna lokal SQLite. Produk juga dilindungi trigger SQLite agar `category_id` harus berasal dari kategori dengan `user_id` yang sama. Jangan pernah mengambil `user_id` otoritatif dari body/query browser.

### Backup penuh database server

Jalankan manual:

```powershell
npm run backup
```

Script membuat snapshot SQLite konsisten, menjalankan `PRAGMA integrity_check`, dan menghapus backup lama sesuai `BACKUP_RETENTION_DAYS`. Backup berisi semua data keuangan seluruh pengguna; simpan di disk privat/terenkripsi dan jangan unggah ke GitHub atau folder publik.

Untuk otomatisasi Windows, buat task di Task Scheduler yang menjalankan setiap hari:

- Program: `npm.cmd`
- Arguments: `run backup`
- Start in: folder proyek `website`

**Restore:** hentikan server terlebih dahulu (`Ctrl+C`), salin file backup yang dipilih ke lokasi kerja database dengan nama `buku-kas.sqlite` (jangan timpa sebelum membuat salinan database sekarang), lalu jalankan server dan periksa `/healthz` serta login. Uji restore pada salinan/staging lebih dahulu, bukan langsung database aktif.

### Catatan migrasi

Catatan transisi: kolom `supabase_user_id` ditambahkan otomatis ke tabel `users` SQLite pada saat server berjalan. Akun lama hanya ditautkan secara otomatis bila alamat emailnya sama dan sudah terverifikasi pada sistem lama serta Supabase Auth. Akun yang tidak memenuhi kondisi tersebut perlu ditinjau manual sebelum data lama dapat dihubungkan.

Google sign-in memakai provider Supabase Auth. Tombol aplikasi tetap disembunyikan selama `ENABLE_GOOGLE_OAUTH=false`; setelah Client ID/Secret disimpan di Supabase Dashboard, set `ENABLE_GOOGLE_OAUTH=true` pada environment server dan restart aplikasi.


## 12. Katalog produk, HPP, harga jual, dan margin (versi 1.2)

### Pengaturan katalog produk

Setiap produk memiliki:

- `unit_cost`: HPP/modal total untuk menghasilkan satu unit/pcs. Masukkan biaya bahan, kemasan, dan biaya langsung lain yang memang dibebankan ke satu unit.
- `sale_price`: harga jual per unit hasil metode yang dipilih.
- `pricing_method` dan `pricing_value`: konfigurasi perhitungan harga jual.
- `stock`: jumlah unit tersedia.

Metode penentuan harga jual:

| Metode | Rumus | Contoh jika HPP Rp9.800 |
|---|---|---:|
| Harga jual manual | Harga diisi langsung oleh pengguna | Rp12.000 bila diisi demikian |
| Markup dari HPP | HPP × (1 + persentase markup) | 20% menghasilkan Rp11.760 |
| Target margin | HPP ÷ (1 − persentase margin) | 20% menghasilkan Rp12.250 |
| Laba tetap | HPP + nominal laba per unit | Tambah Rp2.200 menghasilkan Rp12.000 |

Harga rupiah dibulatkan ke bilangan bulat terdekat. Target margin harus kurang dari 100%. `unit_cost` harus lebih dari nol sebelum produk dapat dijual. Produk lama yang dimigrasikan dari versi sebelumnya mempertahankan harga lama sebagai harga jual, tetapi HPP awalnya Rp0; edit produk lama dan masukkan HPP sebelum dipilih dalam transaksi penjualan.

### Transaksi penjualan dari katalog

Saat membuat transaksi **Masuk**, pilih `Penjualan produk dari katalog`, tambahkan satu atau beberapa produk, kuantitas, serta harga jual per unit (default dari katalog dan dapat disesuaikan untuk transaksi tersebut). Server memvalidasi kepemilikan produk dan kecukupan stok, lalu dalam satu transaksi database:

1. Menghitung omzet = jumlah unit × harga jual per unit.
2. Menyimpan omzet penuh sebagai transaksi `Masuk` di Buku Kas; nilai ini masuk ke total masuk dan saldo Dashboard.
3. Mengurangi stok berdasarkan jumlah terjual.
4. Menyimpan snapshot nama produk, kuantitas, harga jual, dan HPP di `transaction_items`. Perubahan harga katalog berikutnya tidak mengubah transaksi historis.
5. Menghitung margin = omzet − total HPP, kemudian membuat satu catatan keuntungan otomatis yang terhubung ke transaksi asal. Jika margin negatif, catatan dibuat sebagai `Keluar` pada halaman Keuntungan.

Keuntungan otomatis tidak dimasukkan lagi ke saldo kas Dashboard karena omzet sudah tercatat penuh di Buku Kas. Ini mencegah margin dihitung dua kali. Pembelian stok/biaya yang benar-benar dibayar tetap dicatat sebagai transaksi `Keluar` pada saat pembayaran dilakukan; HPP pada transaksi penjualan dipakai sebagai dasar perhitungan margin, bukan pembayaran kas kedua.

Transaksi yang diedit akan mengembalikan stok dari baris sebelumnya, memperbarui rincian, lalu menghitung ulang stok dan margin dalam satu transaksi database. Menghapus transaksi penjualan mengembalikan stok dan menghapus catatan margin otomatis terkait. Catatan margin otomatis bersifat read-only dari halaman Keuntungan; edit/hapus dilakukan pada transaksi penjualan asal.

### Backup/restore dan kompatibilitas database

- Database lama dimigrasikan otomatis saat server mulai: kolom HPP/harga jual/metode ditambahkan tanpa menghapus transaksi atau produk.
- Harga lama di kolom `price` disalin ke `sale_price` bila harga jual baru belum ada. HPP produk lama diisi Rp0 dan harus diperbarui sebelum penjualan katalog.
- Format backup per akun ditingkatkan menjadi `buku-kas-backup-v2`, membawa data konfigurasi harga, transaksi, rincian item, snapshot biaya/harga, dan tautan keuntungan otomatis.
- Restore masih menerima format `buku-kas-backup-v1` agar backup lama tetap dapat dipulihkan.
- `scripts/import-legacy-sqlite.js` mengimpor harga lama sebagai harga jual. HPP harus diisi manual di katalog setelah migrasi karena file lama tidak menyediakan data HPP per unit yang dapat dipastikan.

### Skenario uji penerimaan

1. Buat produk dengan HPP Rp9.800 dan harga jual manual Rp12.000.
2. Tambahkan stok produk minimal 3 unit.
3. Buat transaksi Masuk penjualan 2 unit. Hasil: Buku Kas/Dashboard bertambah Rp24.000, stok turun 2, dan Keuntungan bertambah Rp4.400.
4. Edit transaksi menjadi 1 unit. Hasil: stok dikoreksi menjadi 2 unit lebih banyak daripada keadaan setelah penjualan awal, omzet menjadi Rp12.000, dan margin menjadi Rp2.200.
5. Hapus transaksi. Hasil: stok dikembalikan dan keuntungan otomatis terkait dihapus.
6. Uji produk milik user lain dan stok tidak cukup. Server harus menolak transaksi tanpa mengubah saldo, stok, atau keuntungan.
7. Backup dan restore format v2 pada akun pengujian; rincian penjualan dan tautan margin harus tetap konsisten.


## Supabase Auth Integration (current)

Supabase Auth is the identity provider for the website. The browser uses the pinned `@supabase/supabase-js` browser SDK and the Supabase publishable key. The Express API verifies every Bearer access token against Supabase Auth before accessing the existing SQLite business-data store. The Supabase secret key is used only by the local administrator provisioning script and must never be exposed in frontend code or committed to Git.

Required server settings in `.env`:

```dotenv
SUPABASE_URL=https://dvtnxezautjkeshsbdyk.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
ENABLE_GOOGLE_OAUTH=false
```

Email/password registration, email verification, password recovery, and session refresh use Supabase Auth. Configure the project's Auth URL Configuration with the website Site URL and redirect allow-list entries for `http://localhost:3000/auth/callback`, `http://localhost:3000/auth/reset-password`, and the equivalent HTTPS production URLs. Configure a custom SMTP sender in Supabase before using email verification and recovery in production.

### Google sign-in activation

1. Create a Google OAuth client with application type **Web application** in Google Cloud.
2. Add the website origin (for example `http://localhost:3000`) to Authorized JavaScript origins.
3. Add this Supabase callback to Authorized redirect URIs: `https://dvtnxezautjkeshsbdyk.supabase.co/auth/v1/callback`.
4. Open Supabase Dashboard → Authentication → Sign In / Providers → Google. Enable the provider and save the Google Client ID and Client Secret there. Do not put the Google client secret in the website repository.
5. Add the website callback URL to Supabase Auth URL Configuration's redirect allow-list: `http://localhost:3000/auth/callback` and the HTTPS production URL.
6. Set `ENABLE_GOOGLE_OAUTH=true` in the website server environment and restart/redeploy the server.

### Administrator provisioning

Public registration creates standard users only. To grant administrator access, first create a standard account through the website and verify its email. Then run this command from the server project directory:

```powershell
npm run create-admin -- admin@domain.com
```

To revoke administrator access:

```powershell
npm run revoke-admin -- admin@domain.com
```

The script requires `SUPABASE_SECRET_KEY`, writes the protected `private.user_roles` table using the restricted provisioning RPC, and mirrors `app_metadata.role=admin` for backend authorization. The server never trusts user-editable `user_metadata` for authorization. A promoted or demoted account should sign out and sign in again to refresh its session.

**Data-store note:** authentication now uses Supabase Auth, but existing ledger, inventory, reports, and admin overview endpoints still use the SQLite database and map the Supabase Auth UUID to a local user row. This integration does not yet migrate existing business data to the PostgreSQL FeeKu tables.
