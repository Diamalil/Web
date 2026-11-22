# Laporan Pengujian FeeKu Website

Pembaruan: 22 November 2026

## Pemeriksaan statis integrasi Supabase Auth

Berkas berikut sudah diperiksa ulang dengan pemeriksaan parser JavaScript:

- `server.js` — lulus.
- `public/app.js` — lulus.
- `scripts/create-admin.js` — lulus.
- `scripts/import-legacy-sqlite.js` — lulus.
- `scripts/backup-database.js` — lulus.
- `package.json` — JSON valid.

Pemeriksaan source memastikan:

- Registrasi memakai `supabase.auth.signUp()`.
- Login memakai `supabase.auth.signInWithPassword()`.
- Google sign-in memakai `supabase.auth.signInWithOAuth({ provider: 'google' })`.
- Pemulihan password memakai `resetPasswordForEmail()` dan `updateUser()`.
- Request API menyertakan Bearer access token Supabase.
- Express memvalidasi access token melalui endpoint Supabase Auth sebelum menjalankan endpoint data.
- Server hanya membaca role admin dari `app_metadata.role`, tidak dari `user_metadata`.
- Script provisioning admin mewajibkan Supabase Secret Key, memakai RPC terbatas, dan mendukung pencabutan role.
- Passport Google dan endpoint login/register lokal lama sudah dihapus dari jalur autentikasi aktif.

## Pemeriksaan schema Supabase

- Migration `20261122000904_add_feeku_auth_profile_and_admin_provisioning` tercatat pada project FeeKu.
- Trigger `on_auth_user_created` terpasang pada `auth.users` dan membuat baris `public.profiles`.
- RPC provisioning admin hanya dapat dieksekusi oleh `service_role`; akses `anon` dan `authenticated` ditolak.
- Tabel `private.user_roles` tidak dapat dibaca/ditulis melalui privilege pengguna `authenticated`.
- Belum ada akun Auth, profil, ataupun role admin yang dibuat selama implementasi.

## Batasan yang belum diuji end-to-end

HTTP/browser end-to-end belum dapat dinyatakan lulus di lingkungan pemeriksaan ini. Belum ada akun email terverifikasi, SMTP project belum diuji, Google OAuth Client ID/Secret belum diberikan atau disimpan di Supabase Dashboard, dan aplikasi belum dijalankan dengan environment lokal/production pemilik proyek.

Pengujian penerimaan yang masih diperlukan:

1. Isi `.env` dengan Supabase URL, Publishable Key, Secret Key (server saja), dan `SESSION_SECRET`.
2. Atur Supabase Auth Site URL dan Redirect URLs untuk localhost serta domain production.
3. Konfigurasikan SMTP Supabase, lalu uji registrasi, verifikasi email, login, reset password, dan logout.
4. Buat Google OAuth Web Client, masukkan Client ID/Secret ke Supabase Auth → Sign In / Providers → Google, lalu aktifkan `ENABLE_GOOGLE_OAUTH=true` pada server.
5. Buat akun pengguna biasa, verifikasi email, lalu uji `npm run create-admin -- admin@domain.com` dan `npm run revoke-admin -- admin@domain.com`.
6. Uji bahwa pengguna biasa ditolak dari halaman dan endpoint admin.
7. Jalankan seluruh alur di staging sebelum deployment production.

**Catatan penyimpanan data:** Supabase Auth kini menjadi sumber identitas, tetapi endpoint transaksi, keuntungan, stok, dan laporan masih membaca SQLite. Integrasi ini belum memigrasikan data operasional SQLite ke tabel PostgreSQL FeeKu.
