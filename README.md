# Buku Kas Website

Versi website dari aplikasi Flutter Buku Kas pada repo `Diamalil/Aplikasi`. Implementasi ini menyediakan frontend responsif, backend Express, database SQLite server, login pengguna melalui email/password, verifikasi email, pemulihan akun, serta panel administrator terpisah. Google OAuth dinonaktifkan secara default dan hanya dapat diaktifkan secara eksplisit.

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

- **Pengguna:** daftar dan login melalui email/password; email wajib diverifikasi; reset password menggunakan tautan email. Google OAuth ditahan/nonaktif secara default.
- **Panel admin:** halaman login terpisah di `/admin/login`; admin dibuat melalui perintah server, tidak ada pendaftaran admin publik, dan tidak ada login admin Google.
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
  └── public/index.html + styles.css + app.js
        │  session cookie + CSRF token
        ▼
Node.js / Express (server.js)
  ├── autentikasi email/password
  ├── Google OAuth 2.0 (opsional, perlu konfigurasi)
  ├── role guard: user / admin
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

## 5. Membuat akun admin

Admin pertama dibuat secara eksplisit dari terminal server. Tidak ada kredensial admin bawaan di source code.

Linux/macOS:

```bash
ADMIN_BOOTSTRAP_PASSWORD='password-kuat-minimal-12-karakter' npm run create-admin -- admin@domain.com
```

Windows PowerShell:

```powershell
$env:ADMIN_BOOTSTRAP_PASSWORD = 'password-kuat-minimal-12-karakter'
npm run create-admin -- admin@domain.com
Remove-Item Env:ADMIN_BOOTSTRAP_PASSWORD
```

Gunakan password unik dan jangan menyimpannya di repo. Script akan membuat akun admin baru atau mengubah akun dengan email tersebut menjadi admin. Jalankan sekali untuk bootstrap awal.

## 6. Kebijakan jaringan login admin

Panel admin memiliki dua lapisan proteksi:

1. Kredensial admin diperiksa di endpoint khusus `/api/auth/admin/login`.
2. IP klien diperiksa pada saat login **dan setiap request endpoint admin**.

Jika `ADMIN_ALLOWED_CIDRS` kosong, default yang diizinkan hanya loopback, private LAN IPv4 (`10/8`, `172.16/12`, `192.168/16`), serta IPv6 ULA/link-local. Ini mendukung akses lokal. Untuk akses melalui internet, tambahkan IP publik statis admin atau CIDR VPN tepercaya, misalnya:

```env
ADMIN_ALLOWED_CIDRS=127.0.0.1/8,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,203.0.113.25/32
```

`203.0.113.25` hanya contoh dokumentasi. Ganti dengan IP publik nyata yang digunakan admin. Jangan memasukkan `0.0.0.0/0` atau `::/0` jika ingin admin benar-benar dibatasi. Jika IP internet berubah, allowlist perlu diperbarui atau gunakan VPN dengan IP keluar tetap.

Untuk akses melalui reverse proxy, set `TRUST_PROXY=1` hanya bila tepat satu proxy tepercaya berada di depan aplikasi. Jangan mempercayai header IP dari proxy yang tidak Anda kendalikan. Gunakan HTTPS di server publik.

## 7. Login Google/Gmail

Google login belum aktif sampai OAuth Client ID dan Client Secret dibuat di Google Cloud Console. Konfigurasikan OAuth consent screen, lalu buat OAuth 2.0 Client ID bertipe Web Application.

Tambahkan URL callback berikut sebagai **Authorized redirect URI**:

```text
https://DOMAIN-ANDA/auth/google/callback
```

Untuk lokal:

```text
http://localhost:3000/auth/google/callback
```

Isi `.env`:

```env
APP_BASE_URL=https://DOMAIN-ANDA
GOOGLE_CLIENT_ID=isi-client-id
GOOGLE_CLIENT_SECRET=isi-client-secret
```

Restart server setelah mengubah `.env`. Google login hanya membuat akun role `user`; akun admin tidak dapat masuk lewat Google.

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

- Password pengguna dan admin disimpan sebagai bcrypt hash; password asli tidak disimpan.
- Session memakai cookie `HttpOnly`, `SameSite=Lax`, dan `Secure` di production.
- Mutasi API menggunakan CSRF token, validasi input, serta rate limit.
- Data pengguna diisolasi berdasarkan user ID dari session server.
- Admin melihat data sensitif finansial seluruh pengguna. Akses admin harus diberikan hanya kepada pihak yang berwenang; penggunaan akses tersebut dicatat di activity log.
- Login email/password mendukung verifikasi email dan reset password melalui email. Untuk pengujian lokal, `EMAIL_PROVIDER=console` mencetak tautan ke terminal; untuk production, layanan email seperti Resend wajib dikonfigurasi dan diuji.
- Backup website berupa JSON; backup SQLite dari aplikasi Flutter lama diimpor melalui script migrasi di atas.
- SQLite cocok untuk satu server dan beban kecil/menengah. Untuk trafik besar atau beberapa server aplikasi, migrasikan database ke PostgreSQL dan gunakan session store terdistribusi.
- Google OAuth memerlukan pengaturan eksternal dari pemilik domain/proyek Google; source code saja tidak dapat mengaktifkan credential tersebut.


## 11. Pembaruan keamanan versi 1.1

Versi ini menambahkan alur verifikasi email dan pemulihan password, pembatasan percobaan login, revokasi sesi, audit aktivitas admin, batas kepemilikan kategori-barang di SQLite, serta script backup database penuh.

### Email verification dan reset password

- Pendaftaran user membutuhkan email yang bisa menerima tautan verifikasi.
- Token verifikasi berlaku 30 menit, token reset password berlaku 20 menit, disimpan dalam bentuk SHA-256 hash dan hanya dapat dipakai sekali.
- Password baru dan password saat pendaftaran minimal 12 karakter.
- Reset password menaikkan `session_version`, sehingga sesi lama otomatis tidak berlaku.
- Login akun yang belum diverifikasi akan mengirim tautan verifikasi baru jika layanan email tersedia.
- Respons lupa password tidak membocorkan apakah sebuah email terdaftar.

**Development lokal:** `.env.example` menggunakan `EMAIL_PROVIDER=console`. Tautan verifikasi/reset hanya dicetak ke terminal server untuk uji lokal. Jangan gunakan mode ini untuk production.

**Production:** buat API key Resend, verifikasi domain pengirim, lalu isi `.env`:

```env
NODE_ENV=production
EMAIL_PROVIDER=resend
RESEND_API_KEY=API_KEY_RESMU
EMAIL_FROM=Buku Kas <noreply@domain-terverifikasi-kamu.com>
APP_BASE_URL=https://domain-kamu
```

Source menggunakan API `POST https://api.resend.com/emails` ([dokumentasi resmi Resend](https://resend.com/docs/api-reference/emails/send-email)); API key hanya berada di server. Jangan taruh API key pada `public/app.js` atau commit ke Git.

### Proteksi login dan admin

- Login user/admin dibatasi 5 percobaan gagal per IP dalam 15 menit melalui rate limiter proses Node.js; pembatasan ini akan reset saat proses server restart dan perlu shared store saat aplikasi dijalankan di beberapa instance.
- Sesi membawa versi sesi akun. Reset password dan penonaktifan akun membatalkan sesi lama.
- Role admin, whitelist CIDR, dan pemeriksaan IP dilakukan di backend pada setiap endpoint admin.
- Aksi melihat overview, daftar user, detail user, dan log aktivitas tercatat di activity log.
- `isActive` pada endpoint admin wajib berupa boolean.

### Isolasi data

Query transaksi, keuntungan, kategori, barang, laporan, dan backup user menggunakan `req.user.id` dari session server. Produk juga dilindungi trigger SQLite agar `category_id` harus berasal dari kategori dengan `user_id` yang sama. Jangan pernah mengambil `user_id` otoritatif dari body/query browser.

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

Ketika server versi ini pertama kali dijalankan, kolom `email_verified_at` dan `session_version` ditambahkan otomatis ke database lama tanpa menghapus tabel/data. Akun user lama akan diminta verifikasi saat login berikutnya. Karena itu, untuk mode development lokal, tautan verifikasi dicetak ke terminal; pada production, atur email delivery sebelum upgrade. Sesi lama yang belum memiliki `sessionVersion` akan diminta login ulang satu kali.

Google OAuth dibuat opt-in eksplisit: walaupun `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` terisi, OAuth tetap tidak aktif kecuali `ENABLE_GOOGLE_OAUTH=true`.


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
