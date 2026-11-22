# Laporan Pengujian FeeKu Website

Pembaruan: 22 November 2026

## 1. Pemeriksaan statis source code

Pemeriksaan parser/format berkas sebelumnya lulus untuk:

- `server.js`
- `public/app.js`
- `scripts/create-admin.js`
- `scripts/import-legacy-sqlite.js`
- `scripts/backup-database.js`
- `package.json` (JSON valid)

Pemeriksaan source memastikan:

- Registrasi memakai `supabase.auth.signUp()`.
- Login email/password memakai `supabase.auth.signInWithPassword()`.
- Google sign-in memakai `supabase.auth.signInWithOAuth({ provider: 'google' })`.
- Pemulihan password memakai `resetPasswordForEmail()` dan `updateUser()`.
- Request API menyertakan Bearer access token Supabase.
- Express memvalidasi access token melalui Supabase Auth sebelum menjalankan endpoint data.
- Server hanya membaca role admin dari `app_metadata.role`, bukan `user_metadata`.
- Script provisioning admin mewajibkan Supabase Secret Key dan menyediakan perintah grant/revoke.
- Passport Google dan endpoint autentikasi lokal lama sudah dihapus dari jalur autentikasi aktif.

## 2. Pemeriksaan schema dan keamanan Supabase

Project FeeKu berstatus `ACTIVE_HEALTHY`. Tiga migration tercatat dan diterapkan:

- `20261121154555_initial_feeku_core_schema`
- `20261121154714_refine_feeku_constraints_and_indexes`
- `20261122000904_add_feeku_auth_profile_and_admin_provisioning`

Hasil audit database 22 November 2026:

- `auth.users`: 1 akun.
- `public.profiles`: 1 profil dengan UUID yang cocok dengan akun Auth.
- Akun tersebut sudah terverifikasi dan menggunakan provider Google.
- `private.user_roles`: 0 baris; belum ada administrator yang diprovisikan.
- Trigger `on_auth_user_created` tersedia untuk membuat profil setelah akun Auth dibuat.
- Tabel bisnis pada schema `public` memiliki RLS dan kebijakan akses berbasis `auth.uid()`.
- Schema `private` tidak dapat digunakan oleh role `authenticated`; role tersebut juga tidak dapat membaca atau menulis `private.user_roles`.
- RPC provisioning admin ditolak untuk `anon` dan `authenticated`, serta hanya dapat dieksekusi oleh `service_role`.

Security Advisor masih menampilkan satu peringatan konfigurasi: **Leaked Password Protection Disabled**. Aktifkan perlindungan ini pada pengaturan Auth sebelum production. Tiga notifikasi RLS tanpa policy pada tabel internal schema `private` memang disengaja karena tabel tersebut tidak boleh diakses langsung dari client. Notifikasi unused index bersifat informasional pada database yang masih hampir kosong. Health Advisor tidak melaporkan temuan.

## 3. Uji Google OAuth

**Status: LULUS untuk login Google.**

Pemilik project telah mencoba login Google melalui aplikasi dan mengonfirmasi prosesnya berhasil setelah Client ID/Client Secret Google diperbaiki di Supabase Dashboard.

Log Supabase Auth dan audit database menguatkan hasil tersebut: event login dengan provider Google tercatat, satu akun Auth terverifikasi ditemukan, dan trigger membuat satu profil dengan UUID yang sama. Tidak ada Google Client Secret yang disimpan di repository.

## 4. Uji email/password, verifikasi email, dan reset password

**Status: BELUM DIUJI.**

Custom SMTP masih dinonaktifkan karena project belum memiliki domain pengirim yang terverifikasi. Supabase built-in email service dapat dipakai untuk pengujian terbatas, tetapi hanya mengirim ke alamat yang menjadi anggota organisasi/project dan memiliki batas pengiriman rendah. Layanan bawaan tersebut bukan konfigurasi email untuk aplikasi publik/production.

Untuk pengujian terbatas, gunakan alamat email pengujian yang memang terdaftar sebagai anggota organisasi Supabase. Untuk menerima pendaftaran dan reset password dari pengguna publik, siapkan domain pengirim dan custom SMTP terlebih dahulu. Jangan menganggap registrasi email/password siap production sebelum alur verifikasi dan reset benar-benar diuji.

## 5. Provisioning dan otorisasi administrator

**Status: IMPLEMENTASI TERSEDIA, UJI PEMBERIAN ROLE BELUM DIJALANKAN.**

Script `npm run create-admin -- alamat-email` dan `npm run revoke-admin -- alamat-email` tersedia. Script memerlukan `SUPABASE_SECRET_KEY` pada environment server dan hanya memprovisikan akun Auth yang sudah ada serta terverifikasi.

Belum ada akun yang diberi role admin. Ini disengaja sampai pemilik project menentukan akun administrator yang berwenang. Jangan menaruh Secret Key di frontend atau repository.

## 6. Pengujian end-to-end yang masih diperlukan

- Uji registrasi email/password, email verification, login, reset password, dan logout setelah email pengujian diizinkan atau custom SMTP tersedia.
- Uji provisioning dan pencabutan role admin pada akun yang memang ditunjuk.
- Pastikan akun pengguna biasa ditolak dari halaman dan seluruh endpoint admin.
- Jalankan pengujian API dan alur bisnis pada server lokal/staging milik pemilik project sebelum deployment.

Google OAuth sudah diuji berhasil. Kelulusan Google OAuth tidak otomatis membuktikan seluruh alur email/password, admin, atau API bisnis telah lulus.

## 7. Batas arsitektur penyimpanan data

Supabase Auth sekarang menjadi sumber identitas. Namun endpoint transaksi, keuntungan, stok, laporan, dan ringkasan admin website masih menggunakan database SQLite di server. Tabel PostgreSQL FeeKu sudah disiapkan, tetapi data operasional SQLite belum dimigrasikan ke PostgreSQL dan endpoint bisnis belum dialihkan ke schema tersebut.
