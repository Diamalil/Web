# Laporan Pengujian FeeKu

Pembaruan: 23 November 2026

## 1. Status project dan runtime

- Repository utama: `Diamalil/Web`, branch `main`.
- PR #3 (migrasi endpoint bisnis ke PostgreSQL) sudah merged.
- PR #5 (login tunggal dan Google OAuth) sudah merged.
- PR #6 (local HTTP smoke test) sudah merged.
- Project Supabase `Database FeeKu` berstatus `ACTIVE_HEALTHY`.
- Node.js minimum yang didukung: 20.11.
- Server menggunakan `HOST=0.0.0.0`, port default 3000, sehingga dapat dibuka dari komputer yang sama melalui `http://localhost:3000`.

## 2. Database dan migrasi

Tujuh migration aktif pada project Supabase:

- `20261121154555_initial_feeku_core_schema`
- `20261121154714_refine_feeku_constraints_and_indexes`
- `20261122000904_add_feeku_auth_profile_and_admin_provisioning`
- `20261122012819_migrate_feeku_business_data_to_postgres`
- `20261122012910_fix_feeku_category_import_conflict_target`
- `20261122015733_migrate_business_data_and_postgres_api_permissions`
- `20261122020611_feeku_rls_policy_cleanup`

Jumlah akun Auth: 2; profil: 2; role administrator: 1.

**Migrasi data bisnis SQLite ke PostgreSQL belum dijalankan.** Pada pemeriksaan 23 November, tabel kategori, produk, transaksi, rincian transaksi, dan keuntungan masih kosong. Tidak ada file SQLite bisnis sumber (`data/buku-kas.sqlite`) yang tersedia di sesi pemeriksaan. Script `npm run migrate:postgres` sudah tersedia di repository, tetapi import nyata harus dijalankan terhadap file SQLite asli dari komputer/server lama. Jangan mengklaim migrasi data selesai sampai file sumber berhasil diimpor dan jumlah, saldo, stok, transaksi, serta margin direkonsiliasi.

## 3. Uji integrasi PostgreSQL dan RLS

**Status: LULUS untuk jalur database yang diuji.**

Seluruh pengujian dijalankan dalam transaksi SQL yang diakhiri `ROLLBACK`.

- Kategori dan produk dapat dibuat oleh pemilik.
- RPC penjualan katalog membuat transaksi dan rincian item.
- Stok 3 unit berkurang 2 menjadi 1.
- Omzet 300 dan margin otomatis 100 untuk contoh uji.
- Penyesuaian stok +1 dan -1 berhasil.
- Transaksi manual bertipe Keluar berhasil dibuat.
- Keuntungan manual berhasil dibuat, diubah, dan dihapus.
- Baris margin otomatis tidak dapat diubah atau dihapus oleh pengguna melalui kebijakan RLS.
- Pengguna kedua tidak dapat membaca atau mengubah kategori pengguna pertama.
- Insert dengan `user_id` milik orang lain ditolak.

Tidak ada record uji yang ditinggalkan.

## 4. Audit keamanan

### Lulus

- Semua 13 tabel schema `public` mengaktifkan RLS dan mempunyai kebijakan akses yang tercatat.
- Semua 4 tabel schema `private` mengaktifkan RLS dan tidak mempunyai akses langsung dari role `authenticated`.
- Role `anon` dan `authenticated` tidak dapat memakai schema `private` atau membaca `private.user_roles`.
- RPC provisioning administrator dan import legacy hanya bisa dieksekusi oleh `service_role`.
- RPC transaksi dan stok menggunakan `SECURITY INVOKER`, dengan kontrol RLS.
- Tidak ada temuan Health Advisor.

### Temuan dan tindakan lanjutan

1. **Leaked Password Protection nonaktif.** Aktifkan pada Supabase Auth jika tersedia pada paket project.
2. **`restore_feeku_user_backup` adalah SECURITY DEFINER yang dapat dipanggil authenticated.** Definisi fungsi memeriksa `auth.uid()`, mensyaratkan role authenticated, dan menentukan target dari UUID session itu sendiri. Tidak ada argumen target user yang dikirim client. Desain ini membatasi restore ke akun pemanggil, tetapi peringatan Advisor tetap harus ditinjau dan dites sebelum production.
3. **24 unused-index notices** masih muncul. Ini bersifat informasional pada database bisnis yang kosong/belum banyak dipakai; jangan menghapus index sebelum workload nyata tersedia.
4. Empat tabel internal pada schema `private` tidak mempunyai policy RLS langsung. Ini disengaja karena akses langsung tidak diberikan ke role client; operasi yang diperlukan hanya melalui prosedur tepercaya.

## 5. Audit autentikasi dan Google OAuth

- Satu akun admin aktif dan terverifikasi.
- Satu akun pengguna Google terverifikasi saat ini dalam status banned/nonaktif.
- Audit log mencatat perubahan status akun pengguna menjadi nonaktif melalui aksi administrator pada 22 November 2026.
- Log Supabase Auth pada 23 November 2026 sekitar 08:47 WIB menunjukkan callback Google dari `http://localhost:3000` mencapai Supabase tetapi ditolak dengan `403 User is banned`.

Ini bukan kegagalan konfigurasi Google OAuth. Untuk menggunakan kembali akun Google tersebut, administrator perlu mengaktifkan status akun melalui panel admin. Status ban tidak diubah otomatis selama audit.

## 6. Local smoke test

PR #6 menambahkan `npm run test:local` dan sudah merged ke `main`.

Smoke test memeriksa:
- HTML shell website, `app.js`, dan `styles.css`.
- `/healthz` dan konfigurasi PostgreSQL.
- Konfigurasi Supabase Auth serta flag Google OAuth.
- CSRF bootstrap.
- Endpoint identitas tanpa session.
- Penolakan request tanpa login ke endpoint dashboard dan admin.
- Redirect rute lama `/admin/login` ke halaman login tunggal.

Syntax script smoke test lulus. Namun smoke test belum dijalankan terhadap proses server di komputer pengguna karena proses lokal komputer tersebut tidak dapat diakses dari lingkungan pemeriksaan ini. Log autentikasi membuktikan browser lokal sudah mencapai endpoint Supabase, tetapi tidak membuktikan seluruh halaman dan endpoint telah lulus smoke test.

Jalankan secara lokal:
```bash
npm install
npm run check
npm start
```
Pada terminal kedua:
```bash
npm run test:local
```
Buka `http://localhost:3000`.

## 7. Blocker sebelum cutover production

- Sediakan database SQLite bisnis lama dan jalankan `npm run migrate:postgres`.
- Rekonsiliasi data hasil import.
- Jalankan smoke test lokal dan pengujian browser end-to-end.
- Aktifkan kembali akun Google yang memang harus digunakan (jika penonaktifan sebelumnya tidak disengaja).
- Tinjau dua temuan Security Advisor sebelum production.
- Siapkan SMTP/domain terverifikasi untuk registrasi email publik.
- Lakukan pengujian staging sebelum menghapus atau menghentikan SQLite lama.
