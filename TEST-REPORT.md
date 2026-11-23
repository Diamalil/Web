# Laporan Pengujian FeeKu

Pembaruan: 23 November 2026

## 1. Status project

- Repository: `Diamalil/Web`, branch utama `main`.
- PR #3 (endpoint bisnis PostgreSQL), PR #5 (login tunggal/Google OAuth), dan PR #6 (HTTP smoke test) sudah merged.
- Project Supabase `Database FeeKu` berstatus `ACTIVE_HEALTHY`, Postgres 17.12, region `ap-southeast-1`.
- Runtime yang ditargetkan: Node.js 22.9/24/26, dengan Node.js 26 LTS direkomendasikan.
- FeeKu masih prototype. Import database bisnis SQLite lama sengaja dilewati sesuai keputusan pemilik project. Tidak ada data SQLite yang diimpor dalam pekerjaan ini.

## 2. Data prototype PostgreSQL

Jumlah baris aktual diperiksa kembali pada 23 November 2026 setelah pengujian restore yang diakhiri ROLLBACK:

| Tabel | Baris |
|---|---:|
| categories | 1 |
| products | 2 |
| transactions | 1 |
| transaction_items | 2 |
| profits | 1 |
| activity_logs | 99 |

Data tersebut adalah isi PostgreSQL prototype saat pemeriksaan. Asal data tidak disimpulkan dari jumlah ini. Semua baris dipertahankan; tidak ada truncation atau reset.

Tujuh migration sebelumnya telah tercatat. Migration keamanan terbaru yang diterapkan adalah `20261123030000_harden_activity_log_client_permissions`.

## 3. Uji integrasi PostgreSQL dan RLS

**Status: LULUS untuk jalur database yang sudah diuji.**

Pengujian sebelumnya dijalankan menggunakan transaksi SQL yang diakhiri `ROLLBACK`:
- Kategori dan produk dapat dibuat oleh pemilik.
- RPC penjualan katalog membuat transaksi dan rincian item.
- Stok turun sesuai kuantitas yang dijual.
- Omzet dan margin otomatis dihitung.
- Penyesuaian stok +1 dan -1 berhasil.
- Transaksi manual bertipe Keluar berhasil dibuat.
- Keuntungan manual dapat dibuat, diubah, dan dihapus.
- Margin otomatis tidak dapat diubah/dihapus melalui kebijakan client.
- Pengguna kedua tidak dapat membaca atau mengubah data pengguna pertama.
- Insert dengan `user_id` milik akun lain ditolak.

Pengujian tambahan pada review ini:
- `restore_feeku_user_backup` berhasil dipanggil dengan role `authenticated` pada transaksi uji berisi payload kosong.
- Transaksi uji diakhiri `ROLLBACK`; hasil query sesudahnya menunjukkan jumlah data prototype tetap 1 kategori, 2 produk, 1 transaksi, 2 item, 1 keuntungan, dan 99 log.
- Uji invocation kosong tersebut hanya membuktikan permission gate/RPC dapat dijalankan. Ini bukan pengganti pengujian restore penuh menggunakan akun disposable.

## 4. Audit keamanan

### Lulus / diperketat

- RLS aktif pada tabel aplikasi.
- Policy kepemilikan mengikat data pengguna pada `auth.uid()`.
- Role client tidak memiliki akses langsung ke schema `private`.
- RPC transaksi dan stok memakai `SECURITY INVOKER`.
- RPC provisioning admin dan import legacy dibatasi untuk `service_role`.
- Server memvalidasi access token melalui Supabase Auth, memeriksa verifikasi email dan status akun, dan mengambil role dari `app_metadata.role`.
- Express menggunakan Helmet/CSP, menonaktifkan `X-Powered-By`, mengatur Referrer-Policy dan Cache-Control, memakai CSRF token, rate limit, dan cookie session `HttpOnly`/ `SameSite=Lax`/ `Secure` saat production.
- Admin routes membutuhkan role admin dan IP/CIDR allowlist.
- Hak tulis client pada `public.activity_logs` dicabut melalui migration baru. Setelah migration, privilege authenticated: SELECT=true, INSERT=false, UPDATE=false, DELETE=false. Privilege INSERT untuk service_role tetap true.
- Policy `activity_logs_insert_own` dihapus; `activity_logs_select_own` tetap ada.
- Jumlah activity_logs tetap 99 setelah perubahan privilege.

### Temuan yang masih terbuka

1. **Leaked Password Protection nonaktif.** Perlu diaktifkan di Supabase Auth bila tersedia pada plan project. Dokumentasi Supabase menyatakan fitur ini tersedia pada Pro Plan ke atas: https://supabase.com/docs/guides/auth/password-security
2. **Security Advisor memperingatkan `restore_feeku_user_backup(p_data jsonb)` yang SECURITY DEFINER dan dapat dipanggil authenticated.** Wrapper mengecek `auth.uid()`, role authenticated, memakai empty search_path, serta selalu memanggil helper private dengan UID session sendiri. Helper private tidak dapat dieksekusi oleh role client. Ini desain per-user restore yang disengaja, tetapi masih membutuhkan security review dan pengujian adversarial sebelum rilis publik.
3. Empat tabel schema `private` tanpa policy RLS langsung menghasilkan temuan INFO. Akses client langsung tetap tidak diberikan; grants harus diperiksa setiap ada migration baru.
4. Performance Advisor berisi pemberitahuan unused index yang bersifat informasional untuk prototype dengan data sedikit. Jangan menghapus index tanpa pengukuran workload.

Security Advisor setelah migration:
- INFO: 4 private tables dengan RLS tanpa policy langsung.
- WARN: restore SECURITY DEFINER callable by authenticated.
- WARN: leaked password protection disabled.
Health Advisor: tidak ada temuan.

### Audit dependency npm

GitHub Actions run #2, Node.js 26:
- `npm ci` selesai.
- `npm audit` melaporkan 7 vulnerability: 2 low, 4 high, 1 critical.
- Paket transitif yang ditandai: `@tootallnate/once`, `cacache`, `http-proxy-agent`, `make-fetch-happen`, `node-gyp`, `sqlite3`, dan `tar`.
- Semua temuan tersebut tercatat `direct=false` dan `fixAvailable=true` pada laporan audit saat CI berjalan.
- Critical advisory pada `tar` berkaitan dengan path traversal/overwrite saat ekstraksi arsip.
- Belum dilakukan pembaruan lockfile karena jalur dependency perlu ditinjau agar perbaikan tidak merusak native SQLite/session packages. **Temuan high/critical ini wajib diselesaikan sebelum production.** Jangan menggunakan `npm audit fix --force` tanpa review.


## 5. Auth dan Google OAuth

- Konfigurasi login memakai satu halaman.
- Log sebelumnya menunjukkan callback Google dari localhost mencapai Supabase, tetapi akun uji yang dinonaktifkan oleh administrator ditolak dengan `403 User is banned`.
- Status akun itu tidak diubah otomatis dalam pekerjaan ini. Jika akun uji akan dipakai lagi, aktifkan secara sadar dari panel admin.
- Custom SMTP dan domain pengirim belum disiapkan. Supabase default SMTP bukan untuk produksi; dokumentasi menyebut pembatasan penerima, laju kirim, dan tidak ada SLA: https://supabase.com/docs/guides/auth/auth-smtp

## 6. Local HTTP smoke test dan browser E2E

PR #6 menambahkan `npm run test:local`. Test memeriksa HTML shell, JS/CSS, health check, Supabase Auth config, CSRF bootstrap, identitas unauthenticated, proteksi dashboard/admin, dan redirect route admin lama.

- Syntax script smoke test sebelumnya lulus.
- HTTP smoke test belum dijalankan pada server lokal milik pengguna.
- Tidak ada server FeeKu lokal yang dapat diakses dari environment review dan tidak ada URL staging/production yang diberikan.
- Browser E2E belum dijalankan. `npm run test:local` adalah HTTP smoke test, bukan browser automation.
- Matriks browser manual telah disiapkan pada `BROWSER-E2E.md`.
- Workflow CI di PR #7 sukses pada run #2 dengan Node.js 26: `npm ci`, dependency audit report, syntax check, dan HTTP smoke test. Smoke test menunjukkan 10 pass, 0 fail, 2 warning. Dua warning berasal dari CI yang sengaja tidak mengisi SUPABASE_SECRET_KEY dan menonaktifkan Google OAuth.

## 7. Production readiness

**Belum siap untuk production.** Sebagai prototype, pengujian schema/RLS dan pengetatan audit log sudah berjalan, tetapi gate berikut masih terbuka:
- Jalankan local HTTP smoke test dan browser E2E memakai akun pengujian khusus.
- Enable leaked password protection jika didukung project plan.
- Review dan dokumentasikan penerimaan risiko restore SECURITY DEFINER atau rancang ulang batas helper.
- Siapkan custom SMTP, domain pengirim, SPF/DKIM/DMARC, dan uji email.
- Konfigurasi production domain HTTPS, Auth Site URL dan Redirect URLs, serta Google OAuth production callback.
- Set semua secrets di secret manager hosting, bukan repository.
- Pastikan persistent session storage atau gunakan shared durable store bila deployment multi-instance/ephemeral.
- Tinjau rate limiter untuk deployment multi-instance.
- Siapkan backup PostgreSQL dan lakukan simulasi restore terkontrol pada environment staging.
- Jalankan dependency audit dan review ulang Supabase Advisors sebelum launch.

Rincian lengkap ada pada `PRODUCTION-READINESS.md`.