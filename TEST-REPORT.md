# Laporan Pengujian Buku Kas Website 1.2.0

Tanggal: 9 November 2026

## Pemeriksaan statis

- `npm run check` — lulus untuk `server.js`, `public/app.js`, `scripts/create-admin.js`, `scripts/import-legacy-sqlite.js`, dan `scripts/backup-database.js`.
- Paket produksi tidak menyertakan `.env`, `node_modules`, database pengguna, maupun database session.
- UI transaksi menampilkan rincian produk, kuantitas, dan harga jual/unit pada daftar transaksi, Dashboard, dan laporan.

## Pengujian rumus harga

Pengujian langsung pada fungsi `calculateProductPricing()` yang digunakan server:

| Metode | Input | Harga jual hasil | Status |
|---|---|---:|---|
| Manual | HPP Rp9.800; harga Rp12.000 | Rp12.000 | Lulus |
| Markup | HPP Rp9.800; markup 20% | Rp11.760 | Lulus |
| Target margin | HPP Rp9.800; margin 20% | Rp12.250 | Lulus |
| Laba tetap | HPP Rp9.800; laba Rp2.200 | Rp12.000 | Lulus |
| Batas margin | Target margin 100% | Ditolak | Lulus |

## Pengujian database SQLite sintetis

Pengujian menggunakan database sementara yang diturunkan dari skema migrasi aktual. Database pengguna dalam ZIP sumber tidak digunakan.

1. Migrasi skema lama — lulus; tabel lama tetap ada.
2. Backfill harga jual — lulus; nilai lama `products.price` disalin ke `sale_price`.
3. Penjualan 2 pcs × Rp12.000 dengan HPP Rp9.800 — lulus; omzet Rp24.000 dan margin Rp4.400.
4. Pengurangan stok dari 10 menjadi 8 — lulus.
5. Penjualan tercatat sekali sebagai omzet Buku Kas; margin tersimpan terpisah pada `profits` — lulus.
6. Trigger kepemilikan — lulus; user B tidak dapat menautkan barang milik user A ke transaksi user B.
7. Penghapusan transaksi setelah stok dipulihkan — lulus; stok kembali ke 10 dan keuntungan otomatis terkait hilang melalui foreign key.
8. `PRAGMA foreign_key_check` — lulus tanpa pelanggaran.

## Perilaku transaksi yang diimplementasikan

- Transaksi Masuk dapat berupa penjualan dari katalog atau pemasukan manual.
- Penjualan katalog menyimpan snapshot nama produk, kuantitas, harga jual, dan HPP.
- Stok berkurang saat transaksi penjualan disimpan.
- Keuntungan otomatis dihitung sebagai omzet dikurangi total HPP dan dicatat pada halaman Keuntungan; jika negatif, dicatat sebagai pengeluaran keuntungan.
- Omzet penuh masuk ke Dashboard/Buku Kas. Margin tidak ditambahkan lagi ke saldo kas.
- Edit transaksi mengembalikan stok lama lalu menerapkan rincian baru dalam satu transaksi database.
- Hapus transaksi mengembalikan stok dan menghapus catatan keuntungan otomatis terkait.
- Backup akun v2 membawa snapshot item dan konfigurasi harga; restore masih mendukung backup v1.

## Belum dapat dinyatakan lulus

HTTP/browser end-to-end belum dijalankan di lingkungan pemeriksaan ini karena dependency runtime tidak terpasang di container. Maka boot Express, interaksi UI aktual, pengiriman email, transaksi via HTTP, dan backup/restore route harus dikonfirmasi pada komputer pemilik proyek.

Perintah pemeriksaan pada komputer pemilik proyek:

```powershell
npm run check
npm start
```

Uji penerimaan yang disarankan tercantum di README bagian 12. Gunakan akun pengujian atau database salinan sebelum mencoba perubahan transaksi pada data utama.
