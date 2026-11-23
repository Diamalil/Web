# Laporan Pengujian FeeKu

Pembaruan: 23 November 2026

## 1. Status project

- Repository: Diamalil/Web, branch utama main.
- PR #8 untuk dependency hardening dan restore RPC sudah merged.
- PR #9 menambahkan session store Supabase untuk Vercel; CI run `45104801813` lulus seluruh langkah. PR ini belum digabung ketika laporan ini diperbarui.
- Project Supabase Database FeeKu berstatus ACTIVE_HEALTHY, PostgreSQL 17.12, region ap-southeast-1.
- FeeKu masih prototype. Import database bisnis SQLite lama sengaja dilewati sesuai keputusan pemilik project. Tidak ada data bisnis SQLite lama yang diimpor dalam pekerjaan ini.

## 2. Snapshot data prototype PostgreSQL

Jumlah baris yang diamati pada pemeriksaan terakhir 23 November 2026:

| Tabel | Baris |
|---|---:|
| categories | 3 |
| products | 4 |
| transactions | 2 |
| transaction_items | 4 |
| profits | 2 |
| activity_logs | 170 |

Ini snapshot pada waktu pemeriksaan, bukan jumlah tetap. Angka dapat berubah karena pengujian dan pemakaian aplikasi. Migration keamanan restore hanya mengubah fungsi dan privilege, tidak menghapus atau mengisi tabel bisnis.

## 3. Uji integrasi PostgreSQL dan RLS

**Status: LULUS untuk jalur database yang telah diuji sebelumnya.**

Pengujian integrasi terdahulu memakai transaksi SQL yang diakhiri ROLLBACK:
- Kategori dan produk dapat dibuat oleh pemilik.
- RPC penjualan katalog membuat transaksi dan rincian item.
- Stok turun sesuai kuantitas yang dijual.
- Omzet dan margin otomatis dihitung.
- Penyesuaian stok +1 dan -1 berhasil.
- Transaksi manual bertipe Keluar berhasil dibuat.
- Keuntungan manual dapat dibuat, diubah, dan dihapus.
- Margin otomatis tidak dapat diubah/dihapus melalui kebijakan client.
- Pengguna kedua tidak dapat membaca atau mengubah data pengguna pertama.
- Insert dengan user_id milik akun lain ditolak.

### Restore RPC setelah hardening

- Restore sekarang dipanggil dari endpoint Express menggunakan service_role setelah server memvalidasi sesi Supabase.
- ID target diambil dari req.user.id, bukan dari payload backup.
- Fungsi lama restore_feeku_user_backup(jsonb) sudah dihapus.
- Fungsi baru restore_feeku_user_backup(uuid,jsonb) ada dan memakai SECURITY DEFINER dengan search_path kosong.
- Privilege diverifikasi di database: anon tidak dapat EXECUTE, authenticated tidak dapat EXECUTE, dan service_role dapat EXECUTE.
- Security Advisor tidak lagi menampilkan warning authenticated_security_definer_function_executable.
- Pengujian restore penuh dengan akun disposable tetap perlu dilakukan pada versi aplikasi terbaru. Uji invocation kosong lama bukan pengganti restore penuh.

## 4. Audit keamanan

### Selesai / diperketat

- RLS aktif pada tabel aplikasi.
- Policy kepemilikan mengikat data pengguna pada auth.uid().
- Role client tidak memiliki akses langsung ke schema private.
- RPC transaksi dan stok memakai SECURITY INVOKER.
- RPC provisioning admin dan import legacy dibatasi untuk service_role.
- Server memvalidasi access token melalui Supabase Auth, memeriksa verifikasi email dan status akun, serta mengambil role dari app_metadata.role.
- Express menggunakan Helmet/CSP, CSRF token, rate limit, dan cookie session HttpOnly/SameSite=Lax/Secure saat production.
- Admin routes membutuhkan role admin dan IP/CIDR allowlist.
- Hak tulis client pada public.activity_logs dicabut. authenticated hanya memiliki SELECT, bukan INSERT/UPDATE/DELETE; service_role tetap dapat menulis.
- Restore RPC sekarang hanya dapat dipanggil service_role dari server.

### Temuan Supabase tersisa

1. **Leaked Password Protection masih nonaktif.** Organisasi Supabase saat ini terverifikasi memakai plan Free. Dokumentasi resmi menyatakan fitur ini tersedia pada Pro Plan ke atas dan tidak termasuk Free. Tidak ada perubahan database yang bisa mengaktifkannya pada plan ini. Rujukan: https://supabase.com/docs/guides/auth/password-security dan https://supabase.com/pricing
2. Empat tabel schema private tanpa policy RLS langsung menghasilkan INFO. Ini disengaja karena role client tidak memiliki akses schema/tabel tersebut. Pertahankan pemeriksaan grants pada setiap migration berikutnya.
3. Performance Advisor sebelumnya menampilkan unused-index INFO yang bersifat informasional untuk prototype dengan data sedikit. Jangan menghapus index tanpa pengukuran workload.

Security Advisor setelah migration:
- WARN: hanya auth_leaked_password_protection.
- INFO: 4 private tables dengan RLS tanpa policy langsung.
- Warning SECURITY DEFINER untuk authenticated sudah hilang.
- Health Advisor sebelumnya tidak memiliki temuan.

## 5. Audit dependency npm

**Selesai melalui PR #8, sudah merged ke main.**

- Temuan awal: 7 vulnerability (2 low, 4 high, 1 critical) pada pohon dependency transitif connect-sqlite3.
- connect-sqlite3 dihapus dan diganti adapter session lokal sqlite-session-store.js yang memakai better-sqlite3, dependency yang sudah digunakan FeeKu.
- Bentuk tabel sessions dipertahankan agar baris session yang tersimpan tetap kompatibel.
- Pohon dependency rentan yang berasal dari connect-sqlite3 dan 111 entri package lock yang tidak lagi dibutuhkan dihapus.
- GitHub Actions run #8 pada Node.js 26: npm ci berhasil dan menemukan 0 vulnerabilities; npm audit --audit-level=low juga menemukan 0 vulnerabilities.
- Tiga unit test session store lulus; syntax check dan HTTP smoke test juga lulus.
- npm audit kini menjadi gate wajib CI, bukan laporan informasional.

CI run: https://github.com/Diamalil/Web/actions/runs/45102903196
PR: https://github.com/Diamalil/Web/pull/8

## 6. Auth, browser E2E, dan smoke test

- Pemilik project mengonfirmasi Browser E2E telah selesai.
- CI run #8 setelah perubahan dependency/restore berhasil: locked install, audit blocking, 3 unit test session store, syntax check, dan HTTP smoke test.
- CI menggunakan placeholder Supabase settings. CI tidak menguji Supabase Auth live atau browser UI, sehingga keduanya tidak diklaim lulus dari run ini.
- Karena PR #8 mengubah session store dan jalur restore, lakukan regression singkat login/session continuity serta backup/restore dengan akun disposable pada versi aplikasi terbaru.

## 7. Persiapan deployment Vercel

Migration `20261123031051_feeku_persistent_session_store` sudah diterapkan di Supabase:
- Tabel `public.feeku_server_sessions` dibuat untuk data session Express dan token CSRF.
- RLS aktif; hak akses tabel dicabut untuk `PUBLIC`, `anon`, dan `authenticated`, serta diberikan kepada `service_role`.
- Verifikasi SQL: tabel tersedia, RLS aktif, `service_role` memiliki SELECT/INSERT, sedangkan `anon` dan `authenticated` tidak memiliki SELECT. Jumlah baris awal 0.
- Data bisnis PostgreSQL tidak diubah.
- Penyimpanan lokal SQLite tetap dipakai saat development. Vercel otomatis memakai Supabase session store; server menolak konfigurasi SQLite di Vercel.
- Express app diekspor untuk runtime Vercel, proxy HTTPS dipercaya pada satu hop, dan `vercel.json` menempatkan function di region Singapore.
- CI run #45104801813 pada Node.js 26: 7 session tests lulus, 1 Vercel bootstrap/CSRF persistence test lulus, syntax check lulus, dan HTTP smoke test lulus 10/10 tanpa kegagalan. `npm ci` dan `npm audit --audit-level=low` masing-masing melaporkan 0 vulnerabilities.
- Pengujian Vercel memakai mock PostgREST untuk menguji perilaku session dan bukan pengujian koneksi live ke database atau deployment Vercel.

PR: https://github.com/Diamalil/Web/pull/9
CI: https://github.com/Diamalil/Web/actions/runs/45104801813
Panduan deploy: `VERCEL-DEPLOY.md`

Deployment live belum diverifikasi. Masih perlu import repo ke project Vercel, mengisi secrets server-only di Vercel Environment Variables, mengatur Supabase Auth Site URL/Redirect URLs, menetapkan IP admin yang benar pada `ADMIN_ALLOWED_CIDRS`, lalu menjalankan tes login dan backup/restore di domain hasil deploy.

## 8. Production readiness

**Belum siap untuk production.** Dependency vulnerabilities sudah nol dan privilege restore sudah diperketat. Gate berikut masih terbuka:
- Upgrade organisasi Supabase dari Free ke Pro+ bila ingin mengaktifkan Leaked Password Protection.
- Regression test login/session continuity dan backup/restore pada versi aplikasi terbaru.
- Siapkan custom SMTP, domain pengirim, SPF/DKIM/DMARC, dan uji email.
- Konfigurasi production domain HTTPS, Auth Site URL/Redirect URLs, serta Google OAuth production callback.
- Simpan secrets di secret manager hosting, bukan repository.
- Selesaikan import project dan pengisian Environment Variables Vercel, lalu verifikasi endpoint, login/session, serta backup/restore pada deployment aktual.
- Session storage untuk Vercel sudah disiapkan melalui tabel Supabase dengan RLS/grants terbatas; uji koneksi live masih perlu dilakukan pada deployment.
- Tinjau rate limiter untuk deployment multi-instance.
- Siapkan backup PostgreSQL dan simulasi restore terkontrol pada staging.
- Jalankan Supabase Advisors kembali sebelum launch.

Rincian lengkap ada pada PRODUCTION-READINESS.md dan VERCEL-DEPLOY.md.
