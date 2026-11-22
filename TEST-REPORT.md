# Laporan Pengujian FeeKu PostgreSQL Cutover

Pembaruan: 22 November 2026

## 1. Source code

Syntax check JavaScript dan JSON pada branch `feat/postgres-business-store`:

- `server.js` — lulus.
- `public/app.js` — lulus.
- `scripts/create-admin.js` — lulus.
- `scripts/import-legacy-sqlite.js` — lulus.
- `scripts/migrate-sqlite-to-postgres.js` — lulus.
- `scripts/backup-database.js` — lulus.
- `package.json` — JSON valid.

## 2. Arsitektur API

Endpoint bisnis website sudah dialihkan pada branch ini dari database bisnis SQLite ke Supabase PostgREST/PostgreSQL:

- Dashboard, Buku Kas, keuntungan, katalog kategori/produk, stok, laporan, backup/restore, serta endpoint baca lintas akun administrator memakai PostgreSQL.
- Mutasi transaksi memakai RPC PostgreSQL agar perubahan header, rincian item, stok, dan margin berlangsung atomik.
- Request pengguna menggunakan Bearer access token Supabase dan RLS. Operasi lintas akun administrator dan audit log tepercaya memakai Secret Key hanya di server.
- SQLite tetap dipakai untuk session store dan dibaca sebagai sumber oleh script migrasi satu kali; bukan lagi penyimpanan transaksi aktif.

## 3. Migration Supabase

Tujuh migration tercatat pada project FeeKu:

- `20261121154555_initial_feeku_core_schema`
- `20261121154714_refine_feeku_constraints_and_indexes`
- `20261122000904_add_feeku_auth_profile_and_admin_provisioning`
- `20261122012819_migrate_feeku_business_data_to_postgres`
- `20261122012910_fix_feeku_category_import_conflict_target`
- `20261122015733_migrate_business_data_and_postgres_api_permissions`
- `20261122020611_feeku_rls_policy_cleanup`

File migration yang sudah diterapkan disertakan pada branch supaya riwayat schema dapat ditelusuri dari repository.

## 4. Uji database dan RLS

**Status: LULUS untuk jalur transaksi uji.**

Pada koneksi SQL dengan role `authenticated` dan JWT subject akun uji:

1. Buat kategori uji dan produk dengan stok 2, HPP 10, harga jual 20.
2. Jalankan `public.save_feeku_transaction` untuk penjualan 1 unit.
3. Pastikan stok menjadi 1, total transaksi 20, dan margin otomatis 10.
4. Pastikan insert keuntungan manual milik akun sendiri tetap diizinkan.

Semua assertion berhasil. Seluruh operasi uji berada di dalam transaksi SQL yang diakhiri dengan `ROLLBACK`; tidak ada data uji tertinggal. Pemeriksaan sesudahnya menunjukkan 0 kategori, produk, transaksi, rincian item, keuntungan, activity log, dan import run pada PostgreSQL.

Kebijakan RLS ganda sudah dibersihkan. Pengguna tidak dapat mengakses schema `private` secara langsung atau menjalankan RPC provisioning admin. Catatan margin otomatis ditulis oleh trigger database, bukan oleh client.

## 5. SQLite → PostgreSQL data import

**Status: SCRIPT SIAP, IMPORT DATA NYATA BELUM DIJALANKAN.**

`scripts/migrate-sqlite-to-postgres.js` sudah ditambahkan. Script membuat snapshot SQLite konsisten, memetakan akun lokal ke Supabase Auth melalui UUID atau email yang cocok dan terverifikasi, melakukan preflight semua akun yang dipilih, lalu memanggil RPC import yang idempotent per akun.

Import aktual belum dapat dijalankan pada lingkungan pemeriksaan ini karena file database bisnis SQLite lama dari server pemilik project tidak disertakan. Jangan menyimpulkan data bisnis sudah berpindah hanya karena schema dan endpoint sudah disiapkan. Ikuti instruksi pada README dan jalankan script terhadap file SQLite asli sebelum memakai server PostgreSQL baru untuk operasional.

Batas import saat ini 10.000 baris per akun menurut penghitung migrator. SQLite asli dan snapshot harus disimpan sampai saldo, stok, transaksi, rincian penjualan, dan keuntungan hasil import diverifikasi.

## 6. Login administrator

Halaman `/admin/login` pada branch ini sudah memiliki tampilan khusus: brand FeeKu, label area administrator, form email/password, tombol masuk ke panel, tautan kembali ke login pengguna, dan keterangan verifikasi role serta allowlist jaringan. Jalur login admin menolak akun pengguna biasa; akun administrator juga harus masuk melalui halaman admin.

Source code sudah lulus syntax check. Pemeriksaan visual browser dan HTTP end-to-end tetap harus dilakukan pada server pemilik project.

## 7. Advisor dan batas pengujian

- Health Advisor: tidak ada temuan.
- Performance Advisor: notifikasi multiple permissive policies sudah hilang setelah pembersihan RLS. Peringatan unused index masih ada karena database bisnis masih kosong/nyaris tidak digunakan.
- Security Advisor: notifikasi RLS tanpa policy pada tabel internal `private` memang disengaja; ada peringatan bahwa `public.restore_feeku_user_backup` merupakan SECURITY DEFINER yang dapat dipanggil oleh pengguna terautentikasi. Fungsi tersebut memperoleh target pengguna dari `auth.uid()` dan memanggil prosedur internal dengan UUID itu, bukan menerima target UUID dari browser; temuan ini tetap harus ditinjau sebelum production. Leaked Password Protection masih nonaktif pada konfigurasi Auth.
- Login Google sebelumnya telah diuji berhasil. Uji browser untuk CRUD semua endpoint pada branch PostgreSQL ini belum dijalankan.
- Belum ada role admin yang diberikan kepada akun mana pun.

Cutover belum boleh dianggap selesai sampai data SQLite asli berhasil diimpor, hasilnya diverifikasi, dan aplikasi PostgreSQL baru lulus pengujian staging.
