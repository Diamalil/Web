# Deploy FeeKu ke Vercel (prototype)

Status: kode dan database session sudah disiapkan; deployment Vercel masih memerlukan akses akun/project Vercel dan pengisian environment variables.

## Dukungan runtime

FeeKu memakai Express dan dapat dideteksi Vercel langsung dari `server.js`. Aplikasi diekspor sebagai Express app untuk runtime Vercel; pada mesin lokal, `npm start` tetap menjalankan HTTP server biasa. Aset browser ada di `public/` dan disajikan Vercel melalui CDN. Konfigurasi function memasukkan file HTML yang masih dibutuhkan route Express seperti `/admin`, serta menempatkan function di region Singapore agar dekat dengan Supabase ap-southeast-1.

## Environment variables

Buat variabel berikut di Vercel Project Settings → Environment Variables. Set sebagai Production terlebih dahulu. Jangan memasukkan secret ke GitHub, file frontend, atau percakapan.

| Variable | Nilai |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_STORE` | `supabase` |
| `SESSION_SECRET` | Secret acak minimal 32 karakter, idealnya 48 byte atau lebih |
| `SUPABASE_URL` | URL project FeeKu: `https://dvtnxezautjkeshsbdyk.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key dari Supabase API Keys |
| `SUPABASE_SECRET_KEY` | Secret key server-only dari Supabase API Keys |
| `ENABLE_GOOGLE_OAUTH` | `false` sampai Google OAuth dan callback domain diverifikasi |
| `ADMIN_ALLOWED_CIDRS` | IP publik admin dengan suffix CIDR yang sempit, misalnya `203.0.113.10/32` sebagai format contoh saja |

Vercel menetapkan `VERCEL=1` pada runtime dan menyajikan isi `public/` sebagai aset statis. `server.js` menjadi backend Express entrypoint. Jika `SESSION_STORE` tidak diisi, aplikasi otomatis memilih store Supabase saat berjalan di Vercel. Nilai eksplisit `supabase` tetap disarankan agar konfigurasi mudah diaudit. Store ini menggunakan Supabase REST dengan `SUPABASE_SECRET_KEY`, bukan filesystem serverless.

Jangan isi `ADMIN_ALLOWED_CIDRS` dengan `0.0.0.0/0` atau `::/0`. Bila allowlist kosong, aturan bawaan hanya mengizinkan loopback dan jaringan privat, sehingga panel admin tidak dapat diakses dari IP internet biasa. Dapatkan IP publik dari jaringan admin dan masukkan hanya IP/rentang yang memang diperlukan.

## Hubungkan GitHub

1. Buka Vercel dan import repository `Diamalil/Web`.
2. Pilih root directory repository dan production branch `main`.
3. Biarkan Vercel mendeteksi Express dari dependency `express` dan entrypoint root `server.js`. Jangan membuat folder `api/`, rewrite, build command, atau output directory kustom. Bila dashboard meminta preset, gunakan deteksi otomatis/Express yang tersedia.
4. Pilih Node.js 26.x. `package.json` sudah mengizinkan Node.js 26.
5. Isi environment variables Production di atas, lalu deploy.
6. Setiap perubahan environment variable memerlukan deployment ulang.

Untuk sementara, jangan aktifkan Preview environment yang memakai secret dan database produksi yang sama. Gunakan project Supabase staging terpisah sebelum mengaktifkan preview deployment untuk pull request.

## Verifikasi setelah deployment

Ganti `<deployment-domain>` dengan domain yang diberikan Vercel:

- `https://<deployment-domain>/` harus menampilkan halaman FeeKu.
- `https://<deployment-domain>/app.js` dan `/styles.css` harus mengembalikan aset statis.
- `https://<deployment-domain>/healthz` harus mengembalikan JSON dengan `ok: true`, `authConfigured: true`, `adminOperationsConfigured: true`, dan `sessionStore: "supabase"`.
- `https://<deployment-domain>/api/auth/csrf` harus mengembalikan token CSRF dan mengirim cookie `feeku.sid` dengan atribut Secure, HttpOnly, dan SameSite=Lax.
- Uji login menggunakan akun pengujian, refresh halaman, buat satu record uji yang aman, lalu logout. Jangan gunakan data bisnis penting sebagai bahan uji.
- Uji login/redirect OAuth hanya setelah URL deployment ditambahkan ke Supabase Auth URL Configuration dan provider Google diaktifkan.

## Batasan sebelum production

- Project Supabase saat ini menggunakan Free plan. SMTP khusus dan Leaked Password Protection belum selesai; jangan membuka registrasi publik sebagai layanan produksi.
- Supabase Auth Site URL dan Redirect URLs harus disesuaikan dengan domain Vercel yang benar. Jangan menambahkan wildcard redirect luas.
- Panel admin tetap terkunci sampai IP admin yang tepat dimasukkan ke allowlist.
- Rate limiter Express saat ini masih in-memory per instance. Untuk deployment multi-instance bertraffic, pindahkan rate limit ke backend bersama.
- `/healthz` memeriksa konfigurasi runtime, bukan menjalankan query database. Tambahkan monitoring eksternal dan probe konektivitas sebelum production.
- Vercel Function filesystem bersifat read-only; penyimpanan session Vercel sudah diarahkan ke Supabase dan tidak memakai SQLite lokal.
- Deployment Vercel belum bisa dibuat dari sesi ini karena akun/project Vercel belum terhubung ke alat kerja. Setelah repository di-import dan environment variables diisi, gunakan URL deployment untuk verifikasi akhir di atas.
