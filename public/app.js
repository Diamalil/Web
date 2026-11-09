'use strict';

const appRoot = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');
const money = value => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
const fmtDate = value => {
  if (!value) return '-';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
};
const todayISO = () => new Date().toLocaleDateString('sv-SE');
const firstDay = () => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
const lastDay = () => new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toLocaleDateString('sv-SE');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => String(name || 'U').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();

const state = {
  csrf: '', user: null, page: 'dashboard', isAdmin: false, googleEnabled: false,
  report: null, reportFrom: firstDay(), reportTo: lastDay(), stockCategories: [], stockProducts: [],
  userSearch: '', adminDetail: null, adminLogs: [], adminLogsDone: false
};

async function getCsrf() {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const payload = await response.json();
  state.csrf = payload.csrfToken || '';
  state.googleEnabled = Boolean(payload.googleEnabled);
}
async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(url, {
    ...options, method, headers, credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : { error: await response.text() };
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      showAuth(location.pathname.startsWith('/admin'));
    }
    throw new Error(payload.error || `Permintaan gagal (${response.status}).`);
  }
  if (payload.csrfToken) state.csrf = payload.csrfToken;
  return payload;
}
function toast(message, type = 'success') {
  toastRoot.innerHTML = `<div class="toast ${type === 'error' ? 'error' : ''}">${escapeHtml(message)}</div>`;
  window.setTimeout(() => { toastRoot.innerHTML = ''; }, 3600);
}
function icon(name) {
  const icons = {
    dashboard: '▦', cash: '▤', profit: '↗', stock: '▣', report: '▥', settings: '⚙',
    user: '●', plus: '+', down: '↓', up: '↑', calendar: '▦', backup: '⇧', pdf: '▧',
    users: '♙', activity: '◷', logout: '⇥', eye: '◉', shield: '◆'
  };
  return icons[name] || '•';
}
function navItem(page, label, iconName) {
  return `<button class="nav-link ${state.page === page ? 'active' : ''}" data-page="${page}"><span class="nav-icon">${icon(iconName)}</span><span>${label}</span></button>`;
}
function pageLayout(content) {
  const admin = state.isAdmin;
  const nav = admin
    ? [['overview', 'Ringkasan', 'dashboard'], ['users', 'Pengguna', 'users'], ['activity', 'Aktivitas', 'activity']]
    : [['dashboard', 'Dashboard', 'dashboard'], ['transactions', 'Buku Kas', 'cash'], ['profits', 'Keuntungan', 'profit'], ['stock', 'Stok', 'stock'], ['reports', 'Laporan', 'report'], ['settings', 'Pengaturan', 'settings']];
  const navHtml = nav.map(([p, label, i]) => navItem(p, label, i)).join('');
  const roleText = admin ? 'Administrator' : 'Pengguna';
  return `
    <div class="app-shell ${admin ? 'admin-shell' : ''}">
      <header class="topbar">
        <a class="brand" href="${admin ? '/admin' : '/'}" aria-label="Buku Kas">
          <span class="brand-mark">▤</span><span class="brand-copy"><span class="brand-title">Buku Kas</span><span class="brand-caption">Pencatatan keuangan lebih rapi</span></span>
        </a>
        <div class="topbar-right">
          ${admin ? '<span class="pill admin-badge">ADMIN CONSOLE</span>' : ''}
          <div class="user-chip"><span class="avatar">${escapeHtml(initials(state.user?.name))}</span><span><span class="user-chip-name">${escapeHtml(state.user?.name || '')}</span><span class="user-chip-role">${roleText}</span></span></div>
          <button class="button button-secondary button-small" data-action="logout"><span>${icon('logout')}</span><span class="logout-label">Keluar</span></button>
        </div>
      </header>
      <div class="app-layout">
        <aside class="sidebar">
          <div class="nav-label">${admin ? 'Administrasi' : 'Menu utama'}</div>
          <nav class="nav-list">${navHtml}</nav>
          <div class="sidebar-note"><strong>${admin ? 'Akses terbatas' : 'Data tersimpan aman'}</strong>${admin ? 'Panel ini hanya dapat dibuka dari jaringan lokal atau alamat IP internet yang diizinkan.' : 'Data akun disimpan pada database server dan hanya dapat dibaca oleh akun ini serta administrator yang berwenang.'}</div>
        </aside>
        <main class="main-content" id="main-content">${content}</main>
      </div>
      <nav class="mobile-nav">${navHtml}</nav>
    </div>`;
}

function authMarkup(adminMode = false, register = false, mode = 'login', notice = '') {
  const title = adminMode ? 'Login Administrator' : mode === 'forgot' ? 'Pulihkan akun' : (register ? 'Buat akun Buku Kas' : 'Selamat datang kembali');
  const subtitle = adminMode
    ? 'Masuk melalui jaringan yang diizinkan. Akun admin tidak menggunakan login Google.'
    : mode === 'forgot' ? 'Masukkan email akun terverifikasi untuk menerima tautan reset password.'
    : (register ? 'Buat akun untuk mulai mencatat keuangan dan stok barang.' : 'Masuk untuk melihat ringkasan keuangan dan mengelola catatan Anda.');
  const fields = `${register ? '<div class=\"field\"><label for=\"auth-name\">Nama</label><input id=\"auth-name\" name=\"name\" autocomplete=\"name\" placeholder=\"Nama Anda\" required maxlength=\"100\"></div>' : ''}
    <div class=\"field\"><label for=\"auth-email\">Email</label><input id=\"auth-email\" name=\"email\" type=\"email\" autocomplete=\"username\" placeholder=\"nama@email.com\" required></div>
    ${mode === 'forgot' ? '' : `<div class=\"field\"><label for=\"auth-password\">Password</label><input id=\"auth-password\" name=\"password\" type=\"password\" autocomplete=\"${register ? 'new-password' : 'current-password'}\" placeholder=\"${register ? 'Minimal 12 karakter' : 'Masukkan password'}\" required minlength=\"${register ? 12 : 1}\"></div>`}`;
  return `<div class=\"auth-page\">
    <section class=\"auth-art\">
      <div class=\"auth-brand\"><span class=\"brand-mark\">▤</span><span>Buku Kas</span></div>
      <div class=\"auth-art-content\"><h1>Keuangan tercatat.<br>Usaha lebih terarah.</h1><p>Semua transaksi, keuntungan, stok, dan laporan tersusun di satu tempat. Tetap sederhana seperti aplikasi aslinya, kini dapat diakses dari berbagai perangkat.</p>
        <div class=\"auth-feature-list\"><div class=\"auth-feature\"><span class=\"auth-check\">✓</span>Catat uang masuk dan keluar</div><div class=\"auth-feature\"><span class=\"auth-check\">✓</span>Pantau keuntungan dan stok barang</div><div class=\"auth-feature\"><span class=\"auth-check\">✓</span>Unduh backup dan laporan PDF</div></div>
      </div>
      <div class=\"auth-art-footer\">Buku Kas · Versi Website</div>
    </section>
    <section class=\"auth-panel\"><div class=\"auth-form-wrap\">
      ${adminMode ? '<div class=\"admin-login-label\">◆ AREA ADMIN</div>' : ''}
      <div class=\"auth-heading\"><h2>${title}</h2><p>${subtitle}</p></div>
      ${notice ? `<div class=\"notice\" role=\"status\">${escapeHtml(notice)}</div>` : ''}
      <form class=\"auth-form\" id=\"auth-form\" data-admin=\"${adminMode}\" data-register=\"${register}\" data-mode=\"${mode}\">
        ${fields}
        <div id=\"auth-error\" class=\"muted\" style=\"font-size:11px;min-height:16px\" role=\"alert\"></div>
        <button class=\"button button-primary\" type=\"submit\">${adminMode ? 'Masuk ke Panel Admin' : mode === 'forgot' ? 'Kirim tautan reset' : (register ? 'Buat Akun' : 'Masuk')}</button>
      </form>
      ${!adminMode && !register && mode === 'login' && state.googleEnabled ? `<div class=\"auth-divider\">atau masuk dengan</div><a class=\"google-button\" href=\"/auth/google\"><span class=\"google-g\">G</span> Lanjutkan dengan Google</a>` : ''}
      <div class=\"auth-switch\">${adminMode ? `Bukan administrator? <a class=\"text-link\" href=\"/\">Login pengguna</a>` : mode === 'forgot' ? `<button class=\"text-link\" data-action=\"show-login\">Kembali ke login</button>` : register ? `Sudah punya akun? <button class=\"text-link\" data-action=\"show-login\">Masuk</button>` : `Belum punya akun? <button class=\"text-link\" data-action=\"show-register\">Daftar</button>`}</div>
      ${!adminMode && !register && mode === 'login' ? '<div class=\"auth-switch\" style=\"margin-top:12px\"><button class=\"text-link\" data-action=\"show-forgot\">Lupa password?</button></div>' : ''}
      ${!adminMode ? '<div class=\"auth-switch\" style=\"margin-top:12px\"><a class=\"text-link\" href=\"/admin/login\">Login administrator</a></div>' : ''}
      ${adminMode ? '<p class=\"muted\" style=\"font-size:10px;line-height:1.6;margin-top:22px\">Login admin dibatasi berdasarkan alamat jaringan server. Akses dari IP publik memerlukan allowlist di konfigurasi server.</p>' : ''}
    </div></section>
  </div>`;
}
function tokenPageMarkup(kind) {
  const verify = kind === 'verify';
  const title = verify ? 'Verifikasi email' : 'Buat password baru';
  const description = verify ? 'Klik tombol di bawah untuk mengonfirmasi alamat email akun Buku Kas.' : 'Gunakan password baru minimal 12 karakter.';
  const token = new URLSearchParams(location.search).get('token') || '';
  return `<div class=\"auth-page\"><section class=\"auth-art\"><div class=\"auth-brand\"><span class=\"brand-mark\">▤</span><span>Buku Kas</span></div><div class=\"auth-art-content\"><h1>Keuangan tercatat.<br>Usaha lebih terarah.</h1><p>Keamanan akun membantu menjaga catatan keuangan tetap berada di tangan pemiliknya.</p></div><div class=\"auth-art-footer\">Buku Kas · Versi Website</div></section><section class=\"auth-panel\"><div class=\"auth-form-wrap\"><div class=\"auth-heading\"><h2>${title}</h2><p>${description}</p></div><form class=\"auth-form\" id=\"token-form\" data-kind=\"${kind}\"><input type=\"hidden\" name=\"token\" value=\"${escapeHtml(token)}\">${verify ? '' : '<div class=\"field\"><label for=\"new-password\">Password baru</label><input id=\"new-password\" name=\"password\" type=\"password\" minlength=\"12\" maxlength=\"100\" autocomplete=\"new-password\" required></div><div class=\"field\"><label for=\"confirm-password\">Ulangi password baru</label><input id=\"confirm-password\" name=\"confirmPassword\" type=\"password\" minlength=\"12\" maxlength=\"100\" autocomplete=\"new-password\" required></div>'}<div id=\"auth-error\" class=\"muted\" style=\"font-size:11px;min-height:16px\" role=\"alert\"></div><button class=\"button button-primary\" type=\"submit\">${verify ? 'Verifikasi email' : 'Simpan password baru'}</button></form><div class=\"auth-switch\"><a class=\"text-link\" href=\"/\">Kembali ke login</a></div></div></section></div>`;
}
async function showAuth(adminMode = false, register = false, mode = (register ? 'register' : 'login'), notice = '') {
  state.user = null; state.isAdmin = false;
  appRoot.innerHTML = authMarkup(adminMode, register, mode, notice);
  if (new URLSearchParams(location.search).has('google')) {
    const value = new URLSearchParams(location.search).get('google');
    const box = document.getElementById('auth-error');
    if (box) box.textContent = value === 'failed' ? 'Login Google gagal. Pastikan akun dan konfigurasi OAuth benar.' : 'Login Google belum dikonfigurasi oleh pengelola server.';
  }
}
function setPage(page) {
  state.page = page;
  const url = state.isAdmin ? '/admin' : '/';
  history.replaceState({}, '', url);
  renderPage();
}
async function renderPage() {
  if (!state.user) return;
  let content = '';
  try {
    if (state.isAdmin) {
      if (state.page === 'users') content = await renderAdminUsers();
      else if (state.page === 'activity') content = await renderAdminActivity();
      else content = await renderAdminOverview();
    } else {
      if (state.page === 'transactions') content = await renderTransactions();
      else if (state.page === 'profits') content = await renderProfits();
      else if (state.page === 'stock') content = await renderStock();
      else if (state.page === 'reports') content = await renderReports();
      else if (state.page === 'settings') content = await renderSettings();
      else content = await renderDashboard();
    }
    appRoot.innerHTML = pageLayout(content);
  } catch (err) { toast(err.message, 'error'); }
}
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}
function statCard(label, value, color = 'green', symbol = '↓') {
  return `<div class="stats-card"><div class="stat-icon ${color}">${symbol}</div><div><div class="stat-label">${label}</div><div class="stat-value">${money(value)}</div></div></div>`;
}
function balanceCard(label, value, teal = false) {
  return `<section class="balance-card ${teal ? 'teal' : ''}"><div class="balance-label">${label}</div><div class="balance-value">${money(value)}</div><div class="balance-date">${new Intl.DateTimeFormat('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric' }).format(new Date())}</div></section>`;
}
function emptyState(title, caption, symbol = '▤') {
  return `<div class="empty-state"><div class="empty-icon">${symbol}</div><div class="empty-title">${title}</div><div class="empty-caption">${caption}</div></div>`;
}
function transactionRows(items, withActions = false, type = 'transaction') {
  if (!items.length) return emptyState('Belum ada transaksi', 'Tambahkan catatan pertama untuk mulai.', '▤');
  return `<div class="transaction-list">${items.map(item => {
    const incoming = item.type === 'Masuk';
    const itemSummary = item.items?.length ? item.items.map(line => `${escapeHtml(line.product_name)} × ${line.quantity} @ ${money(line.unit_sale_price)}`).join(' · ') : '';
    return `<div class="transaction-row"><div class="transaction-icon ${incoming ? 'in' : 'out'}">${incoming ? '↓' : '↑'}</div><div class="transaction-main"><div class="transaction-name">${escapeHtml(item.description)}</div><div class="transaction-date">${fmtDate(item.date)} · ${item.type}</div>${itemSummary ? `<div class="muted" style="font-size:10px;margin-top:3px">${itemSummary}</div>` : ''}</div><div class="transaction-amount ${incoming ? 'in' : 'out'}">${incoming ? '+' : '-'}${money(item.amount)}</div>${withActions ? `<button class="button button-secondary button-small" data-action="edit-ledger" data-type="${type}" data-id="${item.id}">Edit</button>` : ''}</div>`;
  }).join('')}</div>`;
}
async function renderDashboard() {
  const data = await api('/api/dashboard');
  const c = data.cash, p = data.profit;
  return `${heading('Dashboard', 'Ringkasan kondisi keuangan Anda hari ini.', `<button class="button button-primary" data-action="add-ledger" data-type="transaction">＋ Tambah Transaksi</button>`)}
    ${balanceCard('Saldo Saat Ini', c.balance)}
    <div class="grid stats-grid" style="margin-top:16px">${statCard('Total Masuk', c.totalIn, 'green', '↓')}${statCard('Total Keluar', c.totalOut, 'red', '↑')}</div>
    <div class="dashboard-grid"><section class="section-card"><div class="section-head"><div><h2 class="section-title">Transaksi Terbaru</h2><div class="section-caption">Lima catatan terakhir</div></div><button class="button button-secondary button-small" data-page="transactions">Lihat Semua</button></div>${transactionRows(data.recent)}</section>
      <section class="section-card"><div class="section-head"><div><h2 class="section-title">Ringkasan Keuntungan</h2><div class="section-caption">Margin penjualan otomatis dan catatan keuntungan lainnya</div></div><button class="button button-secondary button-small" data-page="profits">Buka</button></div><div class="stats-card" style="padding:14px;margin-bottom:10px"><div class="stat-icon teal">↗</div><div><div class="stat-label">Saldo Keuntungan</div><div class="stat-value">${money(p.balance)}</div></div></div><div class="info-row"><span class="muted">Total Masuk</span><strong style="color:var(--success)">${money(p.totalIn)}</strong></div><div class="info-row"><span class="muted">Total Keluar</span><strong style="color:var(--danger)">${money(p.totalOut)}</strong></div><button class="button button-secondary" style="width:100%;margin-top:13px" data-page="stock">Lihat Stok Barang</button></section></div>`;
}
async function renderTransactions() {
  const { items } = await api('/api/transactions');
  const totals = items.reduce((r, x) => { r[x.type === 'Masuk' ? 'in' : 'out'] += x.amount; return r; }, { in:0, out:0 });
  return `${heading('Buku Kas', 'Kelola seluruh transaksi uang masuk dan uang keluar.', `<button class="button button-primary" data-action="add-ledger" data-type="transaction">＋ Tambah Transaksi</button>`)}
    <div class="grid stats-grid" style="margin-bottom:16px">${statCard('Total Masuk',totals.in,'green','↓')}${statCard('Total Keluar',totals.out,'red','↑')}</div>
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Semua Transaksi</h2><div class="section-caption">${items.length} catatan tersimpan</div></div></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${items.map(x => `<tr><td>${fmtDate(x.date)}</td><td><strong>${escapeHtml(x.description)}</strong>${x.items?.length ? `<div class="muted" style="font-size:10px;margin-top:3px">${x.items.map(i=>`${escapeHtml(i.product_name)} × ${i.quantity} @ ${money(i.unit_sale_price)}`).join(' · ')}</div>` : ''}</td><td><span class="pill ${x.type === 'Masuk' ? 'in' : 'out'}">${x.type}</span></td><td style="font-weight:800;color:${x.type === 'Masuk' ? 'var(--success)' : 'var(--danger)'}">${x.type === 'Masuk' ? '+' : '-'}${money(x.amount)}</td><td><div class="table-actions"><button class="button button-secondary button-small" data-action="edit-ledger" data-type="transaction" data-id="${x.id}">Edit</button><button class="button button-danger button-small" data-action="delete-ledger" data-type="transaction" data-id="${x.id}">Hapus</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Belum ada transaksi','Tekan tombol Tambah Transaksi untuk mencatat uang masuk atau keluar.')}</section>`;
}
async function renderProfits() {
  const { items } = await api('/api/profits');
  const totals = items.reduce((r,x) => { r[x.type === 'Masuk' ? 'in' : 'out'] += x.amount; return r; }, { in:0,out:0 });
  return `${heading('Keuntungan', 'Pantau margin penjualan otomatis dan pemasukan/pengeluaran lain.', `<button class="button button-primary" data-action="add-ledger" data-type="profit">＋ Tambah</button>`)}
    ${balanceCard('Saldo Keuntungan',totals.in - totals.out,true)}
    <div class="grid stats-grid" style="margin-top:16px">${statCard('Total Masuk',totals.in,'green','↓')}${statCard('Total Keluar',totals.out,'red','↑')}</div>
    <section class="section-card" style="margin-top:17px"><div class="section-head"><div><h2 class="section-title">Transaksi Keuntungan</h2><div class="section-caption">${items.length} catatan tersimpan</div></div></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${items.map(x => `<tr><td>${fmtDate(x.date)}</td><td><strong>${escapeHtml(x.description)}</strong>${x.source_transaction_id ? '<div class="muted" style="font-size:10px;margin-top:3px">Dihitung otomatis dari transaksi penjualan</div>' : ''}</td><td><span class="pill ${x.type === 'Masuk' ? 'in' : 'out'}">${x.type}</span></td><td style="font-weight:800;color:${x.type === 'Masuk' ? 'var(--success)' : 'var(--danger)'}">${x.type === 'Masuk' ? '+' : '-'}${money(x.amount)}</td><td>${x.source_transaction_id ? '<span class="pill active">Otomatis</span>' : `<div class="table-actions"><button class="button button-secondary button-small" data-action="edit-ledger" data-type="profit" data-id="${x.id}">Edit</button><button class="button button-danger button-small" data-action="delete-ledger" data-type="profit" data-id="${x.id}">Hapus</button></div>`}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Belum ada data keuntungan','Margin penjualan akan tercatat otomatis saat transaksi produk dibuat.')}</section>`;
}
async function renderStock() {
  const [cats, products] = await Promise.all([api('/api/categories'), api('/api/products')]);
  state.stockCategories = cats.items; state.stockProducts = products.items;
  const totalStock = products.items.reduce((sum, p) => sum + p.stock, 0);
  const stockValue = products.items.reduce((sum,p)=>sum+(p.stock*Number(p.unit_cost||0)),0);
  return `${heading('Stok Barang', 'Kelola HPP/modal per unit, metode harga jual, dan jumlah stok.', `<button class="button button-secondary" data-action="add-category">＋ Kategori</button><button class="button button-primary" data-action="add-product">＋ Barang</button>`)}
    <div class="grid stats-grid" style="margin-bottom:16px"><div class="stats-card"><div class="stat-icon blue">▣</div><div><div class="stat-label">Kategori</div><div class="stat-value">${cats.items.length}</div></div></div><div class="stats-card"><div class="stat-icon teal">▤</div><div><div class="stat-label">Total Unit Stok</div><div class="stat-value">${totalStock.toLocaleString('id-ID')}</div></div></div><div class="stats-card"><div class="stat-icon green">Rp</div><div><div class="stat-label">Nilai Modal Stok</div><div class="stat-value">${money(stockValue)}</div></div></div></div>
    <div class="notice" style="margin-bottom:16px">HPP adalah total modal per unit. Harga jual dihitung sesuai metode yang dipilih. Selisih harga jual dan HPP akan masuk otomatis ke halaman Keuntungan saat produk dijual.</div>
    ${cats.items.length ? cats.items.map(c => { const list = products.items.filter(p => p.category_id === c.id); return `<section class="stock-category"><div class="stock-category-head"><div><div class="stock-category-name">${escapeHtml(c.name)}</div><div class="stock-category-count">${list.length} barang</div></div><div class="table-actions"><button class="button button-secondary button-small" data-action="edit-category" data-id="${c.id}">Ubah</button><button class="button button-danger button-small" data-action="delete-category" data-id="${c.id}">Hapus</button><button class="button button-quiet button-small" data-action="add-product" data-category="${c.id}">＋ Barang</button></div></div>${list.length ? list.map(p => `<div class="stock-product"><div class="stock-product-info"><div class="stock-product-name">${escapeHtml(p.name)}</div><div class="stock-product-price">HPP ${money(p.unit_cost)} · Jual ${money(p.sale_price)} · Margin/unit ${money(Number(p.sale_price)-Number(p.unit_cost))} · Metode ${p.pricing_method === 'markup' ? 'Markup' : p.pricing_method === 'margin' ? 'Target margin' : p.pricing_method === 'fixed' ? 'Laba tetap' : 'Manual'}</div></div><div class="stock-count">Stok ${p.stock}</div><div class="stock-actions"><button class="icon-button" title="Kurangi stok" data-action="stock-delta" data-id="${p.id}" data-delta="-1">−</button><button class="icon-button" title="Tambah stok" data-action="stock-delta" data-id="${p.id}" data-delta="1">＋</button></div><button class="button button-secondary button-small" data-action="edit-product" data-id="${p.id}">Edit</button></div>`).join('') : `<div class="empty-state" style="padding:20px">Belum ada barang dalam kategori ini.</div>`}</section>`; }).join('') : `<section class="section-card">${emptyState('Belum ada kategori','Buat kategori terlebih dahulu sebelum menambahkan barang.','▣')}</section>`}`;
}
async function renderReports() {
  const data = await api(`/api/reports?from=${encodeURIComponent(state.reportFrom)}&to=${encodeURIComponent(state.reportTo)}`);
  state.report = data;
  return `${heading('Laporan', 'Rekap transaksi berdasarkan rentang tanggal yang dipilih.', `<button class="button button-secondary" data-action="export-csv">↓ Export CSV</button><button class="button button-primary" data-action="print-report">▧ Simpan PDF</button>`)}
    <form class="filter-row" id="report-filter"><div class="field"><label for="report-from">Dari</label><input type="date" id="report-from" name="from" value="${state.reportFrom}" required></div><div class="field"><label for="report-to">Sampai</label><input type="date" id="report-to" name="to" value="${state.reportTo}" required></div><button class="button button-primary" type="submit">Terapkan Filter</button></form>
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Rekap Periode</h2><div class="section-caption">${fmtDate(data.from)} – ${fmtDate(data.to)}</div></div></div><div class="info-row"><span class="muted">Total Masuk</span><strong style="color:var(--success)">${money(data.totalIn)}</strong></div><div class="info-row"><span class="muted">Total Keluar</span><strong style="color:var(--danger)">${money(data.totalOut)}</strong></div><div class="info-row"><strong>Saldo Periode</strong><strong style="font-size:16px;color:${data.balance >= 0 ? 'var(--success)' : 'var(--danger)'}">${money(data.balance)}</strong></div></section>
    <section class="section-card" style="margin-top:17px"><div class="section-head"><div><h2 class="section-title">Detail Transaksi (${data.items.length})</h2><div class="section-caption">Daftar catatan dalam periode tersebut</div></div></div>${data.items.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${data.items.map(x => `<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}${x.items?.length ? `<div class="muted" style="font-size:10px;margin-top:3px">${x.items.map(i=>`${escapeHtml(i.product_name)} × ${i.quantity} @ ${money(i.unit_sale_price)}`).join(' · ')}</div>` : ''}</td><td><span class="pill ${x.type === 'Masuk' ? 'in' : 'out'}">${x.type}</span></td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Tidak ada transaksi','Tidak ada data pada periode ini.','⌕')}</section>`;
}
async function renderSettings() {
  return `${heading('Pengaturan', 'Backup data dan ekspor laporan ke perangkat Anda.')}
    <div class="setting-grid"><section class="setting-card"><div class="setting-icon">⇧</div><h3>Backup Data</h3><p>Unduh transaksi beserta rincian produk penjualan, snapshot HPP/harga jual, keuntungan otomatis, kategori, dan stok.</p><button class="button button-primary" data-action="backup">Backup Sekarang</button></section>
    <section class="setting-card"><div class="setting-icon">↻</div><h3>Restore Backup</h3><p>Ganti data akun ini dari file backup Buku Kas. Data saat ini akan ditimpa.</p><label class="button button-secondary" for="restore-file">Pilih File Backup</label><input id="restore-file" type="file" accept="application/json,.json" hidden></section>
    <section class="setting-card"><div class="setting-icon" style="background:#fff0ee;color:#c74747">▧</div><h3>Export PDF</h3><p>Buat laporan Buku Kas atau Keuntungan, lalu simpan melalui dialog cetak browser.</p><div class="field"><label>Dari</label><input type="date" id="settings-from" value="${state.reportFrom}"></div><div class="field" style="margin-top:10px"><label>Sampai</label><input type="date" id="settings-to" value="${state.reportTo}"></div><div class="table-actions" style="margin-top:13px"><button class="button button-secondary button-small" data-action="settings-print" data-type="transaction">Buku Kas</button><button class="button button-secondary button-small" data-action="settings-print" data-type="profit">Keuntungan</button></div></section>
    <section class="setting-card"><div class="setting-icon">ⓘ</div><h3>Informasi</h3><div class="info-row"><span class="muted">Versi Website</span><strong>1.2.0</strong></div><div class="info-row"><span class="muted">Database</span><strong>SQLite Server</strong></div><div class="info-row"><span class="muted">Login</span><strong>Email + Password</strong></div></section></div>
    <div class="notice" style="margin-top:16px">Backup hanya berisi data milik akun Anda. Data yang tersimpan di server tetap dapat dilihat administrator sistem untuk keperluan pengelolaan dan audit sesuai hak akses.</div>`;
}

function showModal(title, body, wide = false) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-head"><h2 class="modal-title">${title}</h2><button class="close-button" data-action="close-modal" aria-label="Tutup">×</button></div><div class="modal-body">${body}</div></section></div>`;
}
function hideModal() { modalRoot.innerHTML = ''; }
function saleLineMarkup(item = {}) {
  if (item.product_id === null && item.product_name) return `<div class="sale-line" data-sale-line data-orphan="true"><div class="muted" style="font-size:12px;margin-bottom:8px">${escapeHtml(item.product_name)} · produk sudah tidak ada di katalog. Hapus baris ini atau pilih produk pengganti.</div><button type="button" class="button button-danger button-small" data-action="remove-sale-line">Hapus baris</button></div>`;
  const chosenId = Number(item.product_id || item.productId || state.stockProducts[0]?.id || 0);
  const product = state.stockProducts.find(p => p.id === chosenId) || state.stockProducts[0];
  const productId = product?.id || chosenId;
  const unitSalePrice = item.unit_sale_price ?? item.unitSalePrice ?? product?.sale_price ?? product?.price ?? '';
  const unitCost = item.unit_cost ?? product?.unit_cost ?? 0;
  return `<div class="sale-line" data-sale-line><div class="sale-line-grid"><div class="field sale-product-field"><label>Produk katalog</label><select name="productId" data-sale-product required>${state.stockProducts.map(p=>`<option value="${p.id}" ${p.id===productId?'selected':''}>${escapeHtml(p.name)} · stok ${p.stock}</option>`).join('')}</select></div><div class="field"><label>Jumlah</label><input name="quantity" type="number" min="1" step="1" value="${item.quantity || 1}" data-sale-quantity required></div><div class="field"><label>Harga jual/unit</label><input name="unitSalePrice" type="number" min="1" step="1" value="${unitSalePrice}" data-sale-price required></div><div class="field sale-line-hpp"><label>HPP/unit</label><div class="sale-cost" data-sale-cost>${money(unitCost)}</div></div><button type="button" class="button button-danger button-small sale-remove" data-action="remove-sale-line">Hapus</button></div></div>`;
}
function updateSaleComposer(form) {
  if (!form || form.id !== 'ledger-form') return;
  const type = form.querySelector('[name=type]')?.value || 'Masuk';
  const modeSelect = form.querySelector('[name=entryMode]');
  const mode = modeSelect?.value || 'manual';
  const useCatalog = type === 'Masuk' && mode === 'products';
  const modeWrap = form.querySelector('[data-entry-mode-wrap]');
  const saleWrap = form.querySelector('[data-sale-wrap]');
  const manualWrap = form.querySelector('[data-manual-amount-wrap]');
  if (modeWrap) modeWrap.style.display = type === 'Masuk' ? '' : 'none';
  if (saleWrap) saleWrap.style.display = useCatalog ? '' : 'none';
  if (manualWrap) manualWrap.style.display = useCatalog ? 'none' : '';
  const amountInput = form.querySelector('[name=amount]'); if (amountInput) amountInput.required = !useCatalog;
  const productsById = new Map(state.stockProducts.map(p=>[String(p.id),p]));
  let total = 0, totalCost = 0, missingCost = false;
  form.querySelectorAll('[data-sale-line]').forEach(row=>{
    if (row.dataset.orphan === 'true') return;
    const product = productsById.get(row.querySelector('[name=productId]')?.value);
    const quantity = Math.max(0, Number(row.querySelector('[name=quantity]')?.value || 0));
    const price = Math.max(0, Number(row.querySelector('[name=unitSalePrice]')?.value || 0));
    const cost = Number(product?.unit_cost || 0);
    if (cost <= 0) missingCost = true;
    const costNode = row.querySelector('[data-sale-cost]'); if (costNode) costNode.textContent = cost > 0 ? money(cost) : 'HPP belum diatur';
    total += quantity * price; totalCost += quantity * cost;
  });
  const totalNode = form.querySelector('[data-sale-total]'); if(totalNode) totalNode.textContent=money(total);
  const costNode = form.querySelector('[data-sale-total-cost]'); if(costNode) costNode.textContent=money(totalCost);
  const profitNode = form.querySelector('[data-sale-total-profit]'); if(profitNode) profitNode.textContent=missingCost ? 'Lengkapi HPP produk' : money(total-totalCost);
}
function refreshProductPricingForm(form) {
  if (!form || form.id !== 'product-form') return;
  const method = form.querySelector('[name=pricingMethod]')?.value || 'manual';
  const manualWrap = form.querySelector('[data-manual-sale-wrap]');
  const valueWrap = form.querySelector('[data-pricing-value-wrap]');
  if (valueWrap) valueWrap.style.display = method === 'manual' ? 'none' : '';
  const valueInput = form.querySelector('[name=pricingValue]');
  const valueLabel = form.querySelector('[data-pricing-value-label]');
  if (manualWrap) manualWrap.style.display = method === 'manual' ? '' : 'none';
  if (valueInput) { valueInput.required = method !== 'manual'; valueInput.disabled = method === 'manual'; }
  const manualPriceInput = form.querySelector('[name=salePrice]'); if (manualPriceInput) { manualPriceInput.required = method === 'manual'; manualPriceInput.disabled = method !== 'manual'; }
  if (valueLabel) valueLabel.textContent = method === 'markup' ? 'Markup (%)' : method === 'margin' ? 'Target margin (%)' : method === 'fixed' ? 'Laba tetap per unit (Rp)' : 'Nilai metode';
  if (valueInput) {
    valueInput.step = method === 'fixed' ? '1' : '0.01';
    valueInput.placeholder = method === 'fixed' ? 'Contoh: 2200' : 'Contoh: 20';
  }
  const cost = Math.max(0, Number(form.querySelector('[name=unitCost]')?.value || 0));
  const value = Math.max(0, Number(valueInput?.value || 0));
  let sale = Number(form.querySelector('[name=salePrice]')?.value || 0);
  if (method === 'markup') sale = cost * (1 + value/100);
  else if (method === 'margin') sale = value < 100 ? cost/(1-value/100) : 0;
  else if (method === 'fixed') sale = cost + value;
  const preview = form.querySelector('[data-sale-price-preview]');
  if(preview) preview.textContent=money(Math.round(sale));
  const profit = form.querySelector('[data-unit-profit-preview]');
  if(profit) profit.textContent=money(Math.round(sale)-cost);
}
function ledgerForm(type, item = null) {
  const isTransaction = type === 'transaction';
  const isSale = isTransaction && Boolean(item?.items?.length);
  const startMode = isSale ? 'products' : (item ? 'manual' : (isTransaction && state.stockProducts.length ? 'products' : 'manual'));
  const lines = isSale ? item.items.map(saleLineMarkup).join('') : (isTransaction && !item && startMode === 'products' ? saleLineMarkup() : '');
  return `<form id="ledger-form" data-type="${type}" data-id="${item?.id || ''}">
    <div class="field"><label>Tanggal</label><input name="date" type="date" value="${escapeHtml(item?.date || todayISO())}" required></div>
    <div class="field" style="margin-top:15px"><label>Jenis Transaksi</label><div class="segmented"><button type="button" class="${(item?.type || 'Masuk') === 'Masuk' ? 'selected' : ''}" data-action="set-ledger-type" data-value="Masuk">↓ Masuk</button><button type="button" class="${item?.type === 'Keluar' ? 'selected' : ''}" data-action="set-ledger-type" data-value="Keluar">↑ Keluar</button></div><input type="hidden" name="type" value="${item?.type || 'Masuk'}"></div>
    ${isTransaction ? `<div class="field" style="margin-top:15px" data-entry-mode-wrap><label>Sumber uang masuk</label><select name="entryMode"><option value="products" ${startMode==='products'?'selected':''}>Penjualan produk dari katalog</option><option value="manual" ${startMode==='manual'?'selected':''}>Pemasukan lain / manual</option></select></div>` : ''}
    <div class="field" style="margin-top:15px"><label>Keterangan</label><input name="description" maxlength="200" value="${escapeHtml(item?.description || '')}" placeholder="${isTransaction?'Contoh: Penjualan produk':'Contoh: Biaya operasional'}"></div>
    ${isTransaction ? `<section class="sale-composer" data-sale-wrap style="margin-top:15px"><div class="sale-composer-head"><div><strong>Barang terjual</strong><div class="muted" style="font-size:11px">Pilih produk katalog. Stok akan berkurang otomatis setelah disimpan.</div></div><button type="button" class="button button-secondary button-small" data-action="add-sale-line">＋ Tambah produk</button></div><div data-sale-lines>${lines || (state.stockProducts.length ? '' : '<div class="notice">Belum ada produk di katalog. Tambahkan produk dan atur HPP serta harga jual terlebih dahulu.</div>')}</div><div class="sale-summary"><div><span>Total HPP</span><strong data-sale-total-cost>Rp0</strong></div><div><span>Total penjualan</span><strong data-sale-total>Rp0</strong></div><div><span>Estimasi keuntungan</span><strong data-sale-total-profit>Rp0</strong></div></div></section>` : ''}
    <div class="field" style="margin-top:15px" data-manual-amount-wrap><label>Nominal</label><input name="amount" type="number" min="1" step="1" value="${item?.amount ?? ''}" placeholder="Contoh: 500000" ${isTransaction && item?.type === 'Masuk' && startMode === 'products' ? '' : 'required'}></div>
    <div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button class="button button-primary" type="submit">${item ? 'Simpan Perubahan' : 'Simpan'}</button></div>
  </form>`;
}
async function openLedger(type, id = null) {
  if (type === 'transaction' && !state.stockProducts.length) {
    try { const products = await api('/api/products'); state.stockProducts = products.items; } catch {}
  }
  let item = null;
  if (id) {
    const { items } = await api(type === 'profit' ? '/api/profits' : '/api/transactions');
    item = items.find(x => x.id === Number(id));
    if (!item) return toast('Data tidak ditemukan.', 'error');
  }
  showModal(`${id ? 'Edit' : 'Tambah'} ${type === 'profit' ? 'Keuntungan' : 'Transaksi'}`, ledgerForm(type, item), true);
  updateSaleComposer(document.getElementById('ledger-form'));
}
function categoryForm(category = null) {
  return `<form id="category-form" data-id="${category?.id || ''}"><div class="field"><label>Nama Kategori</label><input name="name" value="${escapeHtml(category?.name || '')}" maxlength="100" placeholder="Contoh: Makanan" required></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button class="button button-primary">Simpan</button></div></form>`;
}
function productForm(product = null, categoryId = null) {
  if (!state.stockCategories.length) return `<div class="notice">Buat kategori terlebih dahulu sebelum menambahkan barang.</div>`;
  const selected = product?.category_id || categoryId || state.stockCategories[0].id;
  const method = product?.pricing_method || 'manual';
  return `<form id="product-form" data-id="${product?.id || ''}"><div class="field"><label>Kategori</label><select name="categoryId" required>${state.stockCategories.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
    <div class="field" style="margin-top:15px"><label>Nama Produk</label><input name="name" value="${escapeHtml(product?.name || '')}" maxlength="100" placeholder="Nama produk" required></div>
    <div class="field" style="margin-top:15px"><label>Total HPP / modal per unit (Rp)</label><input name="unitCost" type="number" min="1" step="1" value="${product?.unit_cost ?? ''}" placeholder="Contoh: 9800" required><small class="muted">Masukkan total modal untuk menghasilkan 1 pcs, termasuk bahan, kemasan, dan biaya langsung lain.</small></div>
    <div class="field" style="margin-top:15px"><label>Metode penentuan harga jual</label><select name="pricingMethod"><option value="manual" ${method==='manual'?'selected':''}>Harga jual manual</option><option value="markup" ${method==='markup'?'selected':''}>Markup dari HPP (%)</option><option value="margin" ${method==='margin'?'selected':''}>Target margin dari harga jual (%)</option><option value="fixed" ${method==='fixed'?'selected':''}>Tambahkan laba tetap per unit (Rp)</option></select><small class="muted">Markup menghitung persentase dari HPP. Target margin menghitung persentase laba dari harga jual akhir.</small></div>
    <div class="field" style="margin-top:15px" data-pricing-value-wrap><label data-pricing-value-label>${method==='markup'?'Markup (%)':method==='margin'?'Target margin (%)':method==='fixed'?'Laba tetap per unit (Rp)':'Nilai metode'}</label><input name="pricingValue" type="number" min="0" step="0.01" value="${product?.pricing_value ?? ''}" placeholder="Contoh: 20"></div>
    <div class="field" style="margin-top:15px" data-manual-sale-wrap><label>Harga jual per unit (Rp)</label><input name="salePrice" type="number" min="1" step="1" value="${product?.sale_price ?? product?.price ?? ''}" placeholder="Contoh: 12000" ${method==='manual'?'required':''}></div>
    <div class="product-pricing-preview"><div><span>Harga jual hasil perhitungan</span><strong data-sale-price-preview>${money(product?.sale_price ?? product?.price ?? 0)}</strong></div><div><span>Estimasi laba kotor / unit</span><strong data-unit-profit-preview>${money(Number(product?.sale_price ?? product?.price ?? 0)-Number(product?.unit_cost||0))}</strong></div></div>
    <p class="muted" style="font-size:11px;margin-top:12px">Stok dimulai dari 0 dan dapat ditambah melalui tombol + pada daftar produk. Saat produk dijual, stok berkurang sesuai jumlah yang tercatat.</p><div class="modal-actions">${product ? `<button type="button" class="button button-danger" data-action="delete-product" data-id="${product.id}">Hapus</button>` : ''}<button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button class="button button-primary">Simpan</button></div></form>`;
}

async function renderAdminOverview() {
  const data = await api('/api/admin/overview');
  const recent = data.recentActivity;
  return `${heading('Ringkasan Admin', 'Pantau akun dan aktivitas seluruh pengguna Buku Kas.')}
    <div class="grid stats-grid">${`<div class="stats-card"><div class="stat-icon blue">♙</div><div><div class="stat-label">Total Pengguna</div><div class="stat-value">${data.users.total || 0}</div></div></div>`}<div class="stats-card"><div class="stat-icon green">✓</div><div><div class="stat-label">Pengguna Aktif</div><div class="stat-value">${data.users.active || 0}</div></div></div><div class="stats-card"><div class="stat-icon teal">▤</div><div><div class="stat-label">Jumlah Transaksi</div><div class="stat-value">${data.cash.transactionCount || 0}</div></div></div><div class="stats-card"><div class="stat-icon blue">↗</div><div><div class="stat-label">Volume Nominal Transaksi</div><div class="stat-value">${money(data.cash.transactionVolume)}</div></div></div></div>
    <section class="section-card" style="margin-top:17px"><div class="section-head"><div><h2 class="section-title">Aktivitas Terbaru</h2><div class="section-caption">Log terbaru dari seluruh akun pengguna dan administrator</div></div><button class="button button-secondary button-small" data-page="activity">Lihat Semua</button></div>${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Pengguna</th><th>Aktivitas</th><th>Objek</th><th>Alamat IP</th></tr></thead><tbody>${recent.map(l => `<tr><td>${escapeHtml(l.created_at)}</td><td><strong>${escapeHtml(l.user_name || l.actor_email || 'Tidak diketahui')}</strong></td><td>${escapeHtml(l.action)}</td><td>${escapeHtml(l.entity_type)} ${escapeHtml(l.entity_id || '')}</td><td>${escapeHtml(l.ip_address || '-')}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Belum ada aktivitas','Aktivitas akun akan tampil setelah pengguna mulai memakai aplikasi.','◷')}</section>
    <div class="notice" style="margin-top:16px">Administrator dapat melihat aktivitas dan data setiap akun, mengaktifkan atau menonaktifkan akun pengguna, serta membuka rincian transaksi. Password pengguna tidak pernah ditampilkan.</div>`;
}
async function renderAdminUsers() {
  const { items } = await api(`/api/admin/users?search=${encodeURIComponent(state.userSearch)}`);
  return `${heading('Pengguna', 'Kelola status akun dan tinjau data pengguna yang terdaftar.')}
    <form class="filter-row" id="user-search-form"><div class="field" style="min-width:min(100%,280px);flex:1"><label>Cari nama atau email</label><input name="search" value="${escapeHtml(state.userSearch)}" placeholder="Cari pengguna..."></div><button class="button button-primary">Cari</button><button class="button button-secondary" type="button" data-action="clear-user-search">Reset</button></form>
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Daftar Pengguna</h2><div class="section-caption">Menampilkan ${items.length} akun (maksimal 250 hasil)</div></div></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Pengguna</th><th>Terdaftar</th><th>Verifikasi Email</th><th>Transaksi</th><th>Aktivitas</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${items.map(u => `<tr><td><strong>${escapeHtml(u.name)}</strong><div class="muted" style="font-size:10px;margin-top:3px">${escapeHtml(u.email)}</div></td><td>${fmtDate(u.created_at)}</td><td><span class="pill ${u.email_verified_at ? 'active' : 'inactive'}">${u.email_verified_at ? 'Terverifikasi' : 'Belum'}</span></td><td>${u.transaction_count}</td><td>${u.activity_count}</td><td><span class="pill ${u.is_active ? 'active' : 'inactive'}">${u.is_active ? 'Aktif' : 'Nonaktif'}</span></td><td><div class="table-actions"><button class="button button-secondary button-small" data-action="view-user" data-id="${u.id}">Lihat Data</button><button class="button ${u.is_active ? 'button-danger' : 'button-primary'} button-small" data-action="toggle-user" data-id="${u.id}" data-active="${u.is_active ? '1' : '0'}">${u.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Pengguna tidak ditemukan','Coba gunakan kata kunci pencarian lain.','♙')}</section>`;
}
async function renderAdminActivity() {
  if (!state.adminLogs.length && !state.adminLogsDone) {
    const first = await api('/api/admin/logs?limit=200&offset=0');
    state.adminLogs = first.items;
    state.adminLogsDone = first.items.length < 200;
  }
  const items = state.adminLogs;
  return `${heading('Log Aktivitas', 'Riwayat tindakan pengguna dan admin yang tercatat di server.')}
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Seluruh Aktivitas</h2><div class="section-caption">${items.length} catatan telah dimuat</div></div><button class="button button-secondary button-small" data-action="refresh-logs">Muat Ulang</button></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Pengguna</th><th>Aktivitas</th><th>Detail</th><th>IP</th></tr></thead><tbody>${items.map(l => { let meta='';try{meta=JSON.stringify(JSON.parse(l.metadata||'{}'));}catch{} return `<tr><td>${escapeHtml(l.created_at)}</td><td><strong>${escapeHtml(l.user_name || l.actor_email || 'Tidak diketahui')}</strong></td><td><span class="pill ${l.action.includes('delete') || l.action.includes('failed') ? 'out' : 'in'}">${escapeHtml(l.action)}</span></td><td style="max-width:280px;overflow-wrap:anywhere">${escapeHtml(l.entity_type)} ${escapeHtml(l.entity_id || '')}<div class="muted" style="font-size:10px">${escapeHtml(meta)}</div></td><td>${escapeHtml(l.ip_address || '-')}</td></tr>`; }).join('')}</tbody></table></div>` : emptyState('Belum ada log aktivitas','Log akan muncul saat ada tindakan pada akun.','◷')}${!state.adminLogsDone ? '<div style="padding-top:16px;text-align:center"><button class="button button-secondary" data-action="load-more-logs">Muat Aktivitas Lebih Lama</button></div>' : '<p class="muted" style="font-size:10px;text-align:center;margin-top:14px">Semua log aktivitas telah dimuat.</p>'}</section>`;
}
async function openUserDetails(id) {
  const d = await api(`/api/admin/users/${id}/data`);
  state.adminDetail = d;
  const cashIn = d.transactions.filter(x => x.type === 'Masuk').reduce((s,x)=>s+x.amount,0);
  const cashOut = d.transactions.filter(x => x.type === 'Keluar').reduce((s,x)=>s+x.amount,0);
  const productStock = d.products.reduce((s,x)=>s+x.stock,0);
  showModal(`Data Pengguna · ${escapeHtml(d.user.name)}`, `<div><div class="muted" style="font-size:11px">${escapeHtml(d.user.email)} · Terdaftar ${fmtDate(d.user.created_at)}</div><div class="user-detail-grid"><div class="user-detail-stat"><span>Transaksi</span><strong>${d.transactions.length}</strong></div><div class="user-detail-stat"><span>Saldo Buku Kas</span><strong>${money(cashIn-cashOut)}</strong></div><div class="user-detail-stat"><span>Barang</span><strong>${d.products.length}</strong></div><div class="user-detail-stat"><span>Total Stok</span><strong>${productStock}</strong></div></div>
    <h3 class="section-title">Transaksi Buku Kas</h3>${d.transactions.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan / Produk</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${d.transactions.slice(0,30).map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}${x.items?.length ? `<div class="muted" style="font-size:10px;margin-top:3px">${x.items.map(i=>`${escapeHtml(i.product_name)} × ${i.quantity} · HPP ${money(i.unit_cost)} · Jual ${money(i.unit_sale_price)}`).join('<br>')}</div>` : ''}</td><td>${escapeHtml(x.type)}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:11px">Belum ada transaksi.</p>'}
    <h3 class="section-title" style="margin-top:18px">Keuntungan</h3>${d.profits.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${d.profits.slice(0,30).map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}${x.source_transaction_id ? '<div class="muted" style="font-size:10px">Otomatis dari penjualan</div>' : ''}</td><td>${x.type}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:11px">Belum ada catatan keuntungan.</p>'}
    <h3 class="section-title" style="margin-top:18px">Stok Barang</h3>${d.products.length ? `<div class="table-wrap"><table><thead><tr><th>Kategori</th><th>Barang</th><th>Stok</th><th>HPP</th><th>Harga Jual</th></tr></thead><tbody>${d.products.map(x=>`<tr><td>${escapeHtml(x.category_name)}</td><td>${escapeHtml(x.name)}</td><td>${x.stock}</td><td>${money(x.unit_cost)}</td><td>${money(x.sale_price || x.price)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:11px">Belum ada barang.</p>'}
    <h3 class="section-title" style="margin-top:18px">Aktivitas Terakhir</h3>${d.activity.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Aktivitas</th><th>IP</th></tr></thead><tbody>${d.activity.slice(0,20).map(x=>`<tr><td>${escapeHtml(x.created_at)}</td><td>${escapeHtml(x.action)}</td><td>${escapeHtml(x.ip_address || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:11px">Belum ada aktivitas.</p>'}</div>`, true);
}

async function logout() {
  try { await api('/api/auth/logout', { method:'POST', body:{} }); } catch (_) {}
  state.user = null; state.isAdmin = false; state.page = 'dashboard'; state.csrf = '';
  history.replaceState({}, '', '/');
  await getCsrf(); showAuth(false);
}
async function downloadBackup() {
  const res = await fetch('/api/settings/backup', { credentials:'same-origin' });
  if (!res.ok) { const p=await res.json().catch(()=>({})); throw new Error(p.error || 'Backup gagal.'); }
  const blob = await res.blob(); const url = URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`buku-kas-backup-${todayISO()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Backup berhasil diunduh.');
}
function downloadCsv() {
  const rows = [['Tanggal','Keterangan','Jenis','Nominal','Rincian Produk'], ...(state.report?.items || []).map(x => [x.date,x.description,x.type,x.amount,(x.items||[]).map(i=>`${i.product_name} x ${i.quantity} @ ${i.unit_sale_price}`).join(' | ')])];
  const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF',csv], {type:'text/csv;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`laporan-buku-kas-${state.reportFrom}-${state.reportTo}.csv`; a.click(); URL.revokeObjectURL(url);
}
async function printReport(type) {
  const from = document.getElementById('settings-from')?.value || state.reportFrom;
  const to = document.getElementById('settings-to')?.value || state.reportTo;
  if (!from || !to || from > to) return toast('Rentang tanggal tidak valid.', 'error');
  let items;
  let title;
  if (type === 'profit') { const d=await api('/api/profits'); items=d.items.filter(x=>x.date>=from&&x.date<=to); title='Laporan Keuntungan'; }
  else { const d=await api(`/api/reports?from=${from}&to=${to}`); items=d.items; title='Laporan Buku Kas'; }
  const totalIn=items.filter(x=>x.type==='Masuk').reduce((s,x)=>s+x.amount,0);
  const totalOut=items.filter(x=>x.type==='Keluar').reduce((s,x)=>s+x.amount,0);
  hideModal();
  const main = document.getElementById('main-content');
  const original = main.innerHTML;
  main.innerHTML = `<section class="section-card"><h1 style="font-size:22px;margin:0 0 5px">${title}</h1><p style="font-size:12px;color:#68756c">Periode ${fmtDate(from)} – ${fmtDate(to)}</p><div class="info-row"><span>Total Masuk</span><strong>${money(totalIn)}</strong></div><div class="info-row"><span>Total Keluar</span><strong>${money(totalOut)}</strong></div><div class="info-row"><strong>Saldo</strong><strong>${money(totalIn-totalOut)}</strong></div><h3 style="font-size:14px;margin-top:20px">Detail Transaksi (${items.length})</h3><div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${items.map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}${x.items?.length ? `<div class=\"muted\" style=\"font-size:10px\">${x.items.map(i=>`${escapeHtml(i.product_name)} × ${i.quantity} @ ${money(i.unit_sale_price)}`).join(' · ')}</div>` : ''}</td><td>${x.type}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div></section>`;
  window.print();
  main.innerHTML = original;
}

// ---------- Delegated interactions ----------
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action],[data-page]');
  if (!button) return;
  if (button.dataset.page) { setPage(button.dataset.page); return; }
  const action = button.dataset.action;
  try {
    if (action === 'show-register') return showAuth(false, true);
    if (action === 'show-login') { history.replaceState({}, '', '/'); return showAuth(false, false, 'login'); }
    if (action === 'show-forgot') { history.replaceState({}, '', '/forgot-password'); return showAuth(false, false, 'forgot'); }
    if (action === 'logout') return logout();
    if (action === 'close-modal') { if ((button.classList.contains('modal-backdrop') && event.target === button) || button.classList.contains('close-button')) hideModal(); return; }
    if (action === 'add-ledger') return openLedger(button.dataset.type);
    if (action === 'edit-ledger') return openLedger(button.dataset.type, button.dataset.id);
    if (action === 'delete-ledger') {
      const type = button.dataset.type, id = button.dataset.id;
      if (!confirm('Hapus catatan ini secara permanen?')) return;
      await api(`${type === 'profit' ? '/api/profits' : '/api/transactions'}/${id}`, { method:'DELETE' }); toast('Catatan berhasil dihapus.'); return renderPage();
    }
    if (action === 'set-ledger-type') {
      const form = document.getElementById('ledger-form'); if (!form) return;
      form.querySelector('[name=type]').value = button.dataset.value;
      form.querySelectorAll('[data-action=set-ledger-type]').forEach(x=>x.classList.toggle('selected',x===button));
      updateSaleComposer(form); return;
    }
    if (action === 'add-sale-line') {
      const holder = document.querySelector('[data-sale-lines]');
      if (!state.stockProducts.length) return toast('Tambahkan produk ke katalog stok barang terlebih dahulu.','error');
      holder.insertAdjacentHTML('beforeend', saleLineMarkup()); updateSaleComposer(document.getElementById('ledger-form')); return;
    }
    if (action === 'remove-sale-line') {
      const row = button.closest('[data-sale-line]'); if (row) row.remove(); updateSaleComposer(document.getElementById('ledger-form')); return;
    }
    if (action === 'add-category') return showModal('Tambah Kategori', categoryForm());
    if (action === 'edit-category') {
      const c=state.stockCategories.find(x=>x.id===Number(button.dataset.id)); if(c) return showModal('Ubah Kategori',categoryForm(c));
    }
    if (action === 'delete-category') {
      const id=button.dataset.id; const c=state.stockCategories.find(x=>x.id===Number(id));
      if (!confirm(`Hapus kategori "${c?.name || ''}" beserta semua barang di dalamnya?`)) return;
      const result=await api(`/api/categories/${id}`,{method:'DELETE'}); toast(`Kategori dihapus. ${result.deletedProducts} barang ikut terhapus.`); return renderPage();
    }
    if (action === 'add-product') { showModal('Tambah Produk',productForm(null,Number(button.dataset.category)||null)); refreshProductPricingForm(document.getElementById('product-form')); return; }
    if (action === 'edit-product') { const p=state.stockProducts.find(x=>x.id===Number(button.dataset.id)); if(p) { showModal('Edit Produk',productForm(p)); refreshProductPricingForm(document.getElementById('product-form')); return; } }
    if (action === 'delete-product') {
      const id=button.dataset.id; if(!confirm('Hapus barang ini?')) return;
      await api(`/api/products/${id}`,{method:'DELETE'}); hideModal(); toast('Barang dihapus.'); return renderPage();
    }
    if (action === 'stock-delta') { await api(`/api/products/${button.dataset.id}/stock`,{method:'POST',body:{delta:Number(button.dataset.delta)}}); return renderPage(); }
    if (action === 'export-csv') return downloadCsv();
    if (action === 'print-report') return window.print();
    if (action === 'backup') return downloadBackup();
    if (action === 'settings-print') return printReport(button.dataset.type);
    if (action === 'print-modal') { hideModal(); window.print(); return; }
    if (action === 'clear-user-search') { state.userSearch=''; return renderPage(); }
    if (action === 'refresh-logs') { state.adminLogs=[]; state.adminLogsDone=false; return renderPage(); }
    if (action === 'load-more-logs') {
      const result=await api(`/api/admin/logs?limit=200&offset=${state.adminLogs.length}`);
      state.adminLogs=state.adminLogs.concat(result.items);
      state.adminLogsDone=result.items.length<200;
      return renderPage();
    }
    if (action === 'view-user') return openUserDetails(button.dataset.id);
    if (action === 'toggle-user') {
      const active = button.dataset.active === '1';
      if (!confirm(`${active ? 'Nonaktifkan' : 'Aktifkan'} akun ini?`)) return;
      await api(`/api/admin/users/${button.dataset.id}`,{method:'PATCH',body:{isActive:!active}});
      toast(`Akun berhasil ${active ? 'dinonaktifkan' : 'diaktifkan'}.`); return renderPage();
    }
  } catch (err) { toast(err.message,'error'); }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  try {
    if (form.id === 'auth-form') {
      event.preventDefault();
      const fd=new FormData(form); const admin=form.dataset.admin==='true'; const register=form.dataset.register==='true'; const mode=form.dataset.mode || (register?'register':'login');
      const body={email:fd.get('email')};
      if (mode !== 'forgot') body.password=fd.get('password');
      if(register) body.name=fd.get('name');
      const endpoint=admin?'/api/auth/admin/login':mode==='forgot'?'/api/auth/forgot-password':register?'/api/auth/register':'/api/auth/login';
      const submit=form.querySelector('button[type=submit]'); submit.disabled=true; submit.textContent='Memproses…';
      const error=document.getElementById('auth-error'); if(error) error.textContent='';
      try {
        const result=await api(endpoint,{method:'POST',body});
        if (mode === 'forgot') { history.replaceState({}, '', '/'); return showAuth(false, false, 'login', result.message); }
        if (register) { history.replaceState({}, '', '/'); return showAuth(false, false, 'login', result.message); }
        state.user=result.user; state.isAdmin=result.user.role==='admin'; state.page=state.isAdmin?'overview':'dashboard';
        history.replaceState({},'',state.isAdmin?'/admin':'/'); await renderPage();
      } catch(err) { if(error) error.textContent=err.message; submit.disabled=false; submit.textContent=admin?'Masuk ke Panel Admin':mode==='forgot'?'Kirim tautan reset':register?'Buat Akun':'Masuk'; }
      return;
    }
    if (form.id === 'token-form') {
      event.preventDefault();
      const fd=new FormData(form); const kind=form.dataset.kind; const error=document.getElementById('auth-error');
      const submit=form.querySelector('button[type=submit]'); submit.disabled=true; submit.textContent='Memproses…';
      try {
        let result;
        if (kind === 'verify') result=await api('/api/auth/verify-email',{method:'POST',body:{token:fd.get('token')}});
        else {
          const password=String(fd.get('password')||'');
          if(password!==String(fd.get('confirmPassword')||'')) throw new Error('Konfirmasi password tidak sama.');
          result=await api('/api/auth/reset-password',{method:'POST',body:{token:fd.get('token'),password}});
        }
        history.replaceState({}, '', '/'); return showAuth(false, false, 'login', result.message);
      } catch(err) { if(error) error.textContent=err.message; submit.disabled=false; submit.textContent=kind==='verify'?'Verifikasi email':'Simpan password baru'; }
      return;
    }
    if (form.id === 'ledger-form') {
      event.preventDefault(); const fd=new FormData(form); const type=form.dataset.type; const id=form.dataset.id;
      const transactionType=fd.get('type');
      const body={date:fd.get('date'),description:fd.get('description'),type:transactionType};
      const useProducts=type==='transaction' && transactionType==='Masuk' && fd.get('entryMode')==='products';
      if (useProducts) {
        const items=Array.from(form.querySelectorAll('[data-sale-line]')).filter(row=>row.dataset.orphan!=='true').map(row=>({productId:Number(row.querySelector('[name=productId]').value),quantity:Number(row.querySelector('[name=quantity]').value),unitSalePrice:Number(row.querySelector('[name=unitSalePrice]').value)}));
        if(!items.length) throw new Error('Tambahkan setidaknya satu produk untuk transaksi penjualan.');
        body.items=items;
      } else body.amount=Number(fd.get('amount'));
      await api(`${type==='profit'?'/api/profits':'/api/transactions'}${id?`/${id}`:''}`,{method:id?'PUT':'POST',body});
      hideModal(); toast(id?'Catatan berhasil diperbarui.':'Catatan berhasil ditambahkan.'); return renderPage();
    }
    if (form.id === 'category-form') {
      event.preventDefault(); const fd=new FormData(form); const id=form.dataset.id;
      await api(`/api/categories${id?`/${id}`:''}`,{method:id?'PUT':'POST',body:{name:fd.get('name')}});
      hideModal(); toast('Kategori berhasil disimpan.'); return renderPage();
    }
    if (form.id === 'product-form') {
      event.preventDefault(); const fd=new FormData(form); const id=form.dataset.id;
      await api(`/api/products${id?`/${id}`:''}`,{method:id?'PUT':'POST',body:{categoryId:Number(fd.get('categoryId')),name:fd.get('name'),unitCost:Number(fd.get('unitCost')),pricingMethod:fd.get('pricingMethod'),pricingValue:Number(fd.get('pricingValue')||0),salePrice:Number(fd.get('salePrice')||0)}});
      hideModal(); toast('Produk dan pengaturan harga berhasil disimpan.'); return renderPage();
    }
    if (form.id === 'report-filter') {
      event.preventDefault(); const fd=new FormData(form); state.reportFrom=fd.get('from'); state.reportTo=fd.get('to'); if(state.reportFrom>state.reportTo) return toast('Tanggal awal tidak boleh melewati tanggal akhir.','error'); return renderPage();
    }
    if (form.id === 'user-search-form') {
      event.preventDefault(); const fd=new FormData(form); state.userSearch=fd.get('search'); return renderPage();
    }
  } catch (err) { toast(err.message,'error'); }
});

document.addEventListener('input', event => {
  const form=event.target.closest('#ledger-form');
  if(form && (event.target.matches('[name=quantity]') || event.target.matches('[name=unitSalePrice]'))) updateSaleComposer(form);
  const productFormElement=event.target.closest('#product-form');
  if(productFormElement) refreshProductPricingForm(productFormElement);
});
document.addEventListener('change', event => {
  const ledger=event.target.closest('#ledger-form');
  if(ledger) {
    if(event.target.matches('[data-sale-product]')) {
      const row=event.target.closest('[data-sale-line]');
      const product=state.stockProducts.find(p=>p.id===Number(event.target.value));
      const price=row?.querySelector('[name=unitSalePrice]');
      if(price && product) price.value=product.sale_price ?? product.price;
    }
    updateSaleComposer(ledger);
  }
  const pricingForm=event.target.closest('#product-form');
  if(pricingForm) refreshProductPricingForm(pricingForm);
});

document.addEventListener('change', async event => {
  if (event.target.id === 'restore-file') {
    const file=event.target.files?.[0]; if(!file) return;
    if(!confirm('Restore akan mengganti semua data akun ini. Lanjutkan?')) { event.target.value=''; return; }
    try {
      const backup=JSON.parse(await file.text());
      await api('/api/settings/restore',{method:'POST',body:{backup}});
      toast('Restore berhasil.'); state.page='dashboard'; await renderPage();
    } catch(err) { toast(err.message,'error'); }
    event.target.value='';
  }
});

async function init() {
  const adminPath = location.pathname.startsWith('/admin');
  try {
    await getCsrf();
    if (location.pathname === '/verify-email') { appRoot.innerHTML = tokenPageMarkup('verify'); return; }
    if (location.pathname === '/reset-password') { appRoot.innerHTML = tokenPageMarkup('reset'); return; }
    if (location.pathname === '/forgot-password') return showAuth(false, false, 'forgot');
    const result = await api('/api/auth/me');
    if (!result.user) return showAuth(adminPath, false);
    if (result.user.role === 'admin') {
      if (!adminNetworkAllowedInClient()) return showAuth(true, false);
      state.user=result.user; state.isAdmin=true; state.page='overview';
      if (!adminPath) history.replaceState({},'', '/admin');
    } else {
      if (adminPath) return showAuth(true, false);
      state.user=result.user; state.isAdmin=false; state.page='dashboard';
    }
    state.googleEnabled=Boolean(result.googleEnabled);
    await renderPage();
  } catch (err) { showAuth(adminPath,false); }
}
function adminNetworkAllowedInClient() { return true; } // Otorisasi jaringan sesungguhnya selalu diperiksa ulang oleh server.
window.addEventListener('popstate', () => { if (state.user) { state.page=state.isAdmin?'overview':'dashboard'; renderPage(); } else showAuth(location.pathname.startsWith('/admin')); });
init();
