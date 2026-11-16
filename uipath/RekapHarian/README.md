# UiPath - RekapHarian

Dokumen ini adalah rancangan proses UiPath untuk mengambil data Buku Kas dan menyiapkannya untuk disinkronkan ke Google Sheets.

## Informasi koneksi

- Method: \`GET\`
- Endpoint: \`{BASE_URL}/api/robot/v1/export?from={YYYY-MM-DD}&to={YYYY-MM-DD}\`
- Header: \`Authorization: Bearer {ROBOT_TOKEN}\`
- Respons: JSON
- Token dibuat dari website melalui **Pengaturan → Integrasi Robot UiPath**. Simpan sebagai Credential/Asset di UiPath Orchestrator.

Jangan simpan token di dalam XAML, Git, file konfigurasi, atau log.

## Workflow pertama di UiPath Studio

Buat proses bernama \`RekapHarian\` dan gunakan rangkaian activity berikut.

1. **Get Credential / Orchestrator Asset**: ambil base URL dan token dari asset yang disimpan.
2. **Assign**: tentukan tanggal awal dan akhir laporan. Untuk rekap harian, keduanya adalah tanggal yang sama.
3. **HTTP Request**:
   - Method: GET
   - URL: endpoint di atas dengan parameter tanggal
   - Header Authorization: \`Bearer \` + token
   - Accept: \`application/json\`
4. **If**: pastikan response status HTTP adalah 200. Jika 401, token salah/dicabut; jika 400, periksa parameter tanggal.
5. **Deserialize JSON**: ubah response body menjadi JObject.
6. **Build DataTable** untuk masing-masing tab spreadsheet:
   - Ringkasan: satu baris per periode.
   - Transaksi: \`id,date,description,type,amount\`.
   - Keuntungan: \`id,date,description,type,amount,source_transaction_id\`.
   - Stok Barang: \`id,category_name,name,stock,minimum_stock,is_low_stock,unit_cost,sale_price\`.
7. **Google Sheets**: sinkronkan baris berdasarkan kolom ID. Cari ID terlebih dahulu, update baris bila ditemukan, dan append hanya bila belum ada.
8. **Log Message**: catat periode, jumlah transaksi, jumlah catatan keuntungan, jumlah produk, dan hasil sinkronisasi. Jangan log bearer token.

## Aturan sinkronisasi

- Gunakan ID transaksi dan ID keuntungan sebagai kunci unik.
- Transaksi yang diedit harus memperbarui baris lama, bukan membuat baris baru.
- Laporan kosong tetap merupakan hasil valid; jangan menghapus isi spreadsheet hanya karena API mengembalikan array kosong.
- Jangan menulis saldo dari jumlah keuntungan ke tab transaksi. Omzet Buku Kas dan margin keuntungan adalah dua metrik berbeda.
- Produk katalog adalah snapshot stok saat API dipanggil. Sinkronkan berdasarkan product ID dan pertimbangkan penghapusan produk pada proses katalog terpisah.

## Uji endpoint tanpa UiPath

Setelah token dibuat dari halaman Pengaturan, jalankan contoh ini dari PowerShell. Ganti URL, tanggal, dan token dengan nilai milik sendiri. Jangan membagikan token ke siapa pun.

\`\`\`powershell
$baseUrl = "https://domain-kamu"
$token = "TOKEN_ROBOT_DARI_PENGATURAN"
$from = "2026-11-16"
$to = "2026-11-16"

Invoke-RestMethod -Method Get \`
  -Uri "$baseUrl/api/robot/v1/export?from=$from&to=$to" \`
  -Headers @{ Authorization = "Bearer $token" }
\`\`\`

Untuk server lokal, gunakan \`http://localhost:3000\` sebagai base URL.

## Status implementasi

- [x] Endpoint ekspor khusus robot dengan bearer token.
- [x] Token per akun, tersimpan sebagai hash dan dapat dicabut.
- [x] Data transaksi, keuntungan, ringkasan, dan katalog stok.
- [x] Batas minimum stok di produk.
- [ ] Workflow XAML yang terhubung ke instance Google Sheets.
- [ ] Sinkronisasi upsert ke Google Sheets.
- [ ] Penjadwalan unattended melalui Orchestrator.
