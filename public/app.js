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

function authMarkup(adminMode = false, register = false) {
  const title = adminMode ? 'Login Administrator' : (register ? 'Buat akun Buku Kas' : 'Selamat datang kembali');
  const subtitle = adminMode
    ? 'Masuk melalui jaringan yang diizinkan. Akun admin tidak menggunakan login Google.'
    : (register ? 'Buat akun untuk mulai mencatat keuangan dan stok barang.' : 'Masuk untuk melihat ringkasan keuangan dan mengelola catatan Anda.');
  return `<div class="auth-page">
    <section class="auth-art">
      <div class="auth-brand"><span class="brand-mark">▤</span><span>Buku Kas</span></div>
      <div class="auth-art-content"><h1>Keuangan tercatat.<br>Usaha lebih terarah.</h1><p>Semua transaksi, keuntungan, stok, dan laporan tersusun di satu tempat. Tetap sederhana seperti aplikasi aslinya, kini dapat diakses dari berbagai perangkat.</p>
        <div class="auth-feature-list"><div class="auth-feature"><span class="auth-check">✓</span>Catat uang masuk dan keluar</div><div class="auth-feature"><span class="auth-check">✓</span>Pantau keuntungan dan stok barang</div><div class="auth-feature"><span class="auth-check">✓</span>Unduh backup dan laporan PDF</div></div>
      </div>
      <div class="auth-art-footer">Buku Kas · Versi Website</div>
    </section>
    <section class="auth-panel"><div class="auth-form-wrap">
      ${adminMode ? '<div class="admin-login-label">◆ AREA ADMIN</div>' : ''}
      <div class="auth-heading"><h2>${title}</h2><p>${subtitle}</p></div>
      <form class="auth-form" id="auth-form" data-admin="${adminMode}" data-register="${register}">
        ${register ? '<div class="field"><label for="auth-name">Nama</label><input id="auth-name" name="name" autocomplete="name" placeholder="Nama Anda" required maxlength="100"></div>' : ''}
        <div class="field"><label for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="username" placeholder="nama@email.com" required></div>
        <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="${register ? 'Minimal 10 karakter' : 'Masukkan password'}" required minlength="${register ? 10 : 1}"></div>
        <div id="auth-error" class="muted" style="font-size:11px;min-height:16px" role="alert"></div>
        <button class="button button-primary" type="submit">${adminMode ? 'Masuk ke Panel Admin' : (register ? 'Buat Akun' : 'Masuk')}</button>
      </form>
      ${!adminMode && !register && state.googleEnabled ? `<div class="auth-divider">atau masuk dengan</div><a class="google-button" href="/auth/google"><span class="google-g">G</span> Lanjutkan dengan Google</a>` : ''}
      <div class="auth-switch">${adminMode ? `Bukan administrator? <a class="text-link" href="/">Login pengguna</a>` : register ? `Sudah punya akun? <button class="text-link" data-action="show-login">Masuk</button>` : `Belum punya akun? <button class="text-link" data-action="show-register">Daftar</button>`}</div>
      ${!adminMode ? '<div class="auth-switch" style="margin-top:12px"><a class="text-link" href="/admin/login">Login administrator</a></div>' : ''}
      ${adminMode ? '<p class="muted" style="font-size:10px;line-height:1.6;margin-top:22px">Login admin dibatasi berdasarkan alamat jaringan server. Akses dari IP publik memerlukan allowlist di konfigurasi server.</p>' : ''}
    </div></section>
  </div>`;
}

async function showAuth(adminMode = false, register = false) {
  state.user = null; state.isAdmin = false;
  appRoot.innerHTML = authMarkup(adminMode, register);
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
    return `<div class="transaction-row"><div class="transaction-icon ${incoming ? 'in' : 'out'}">${incoming ? '↓' : '↑'}</div><div class="transaction-main"><div class="transaction-name">${escapeHtml(item.description)}</div><div class="transaction-date">${fmtDate(item.date)} · ${item.type}</div></div><div class="transaction-amount ${incoming ? 'in' : 'out'}">${incoming ? '+' : '-'}${money(item.amount)}</div>${withActions ? `<button class="button button-secondary button-small" data-action="edit-ledger" data-type="${type}" data-id="${item.id}">Edit</button>` : ''}</div>`;
  }).join('')}</div>`;
}
async function renderDashboard() {
  const data = await api('/api/dashboard');
  const c = data.cash, p = data.profit;
  return `${heading('Dashboard', 'Ringkasan kondisi keuangan Anda hari ini.', `<button class="button button-primary" data-action="add-ledger" data-type="transaction">＋ Tambah Transaksi</button>`)}
    ${balanceCard('Saldo Saat Ini', c.balance)}
    <div class="grid stats-grid" style="margin-top:16px">${statCard('Total Masuk', c.totalIn, 'green', '↓')}${statCard('Total Keluar', c.totalOut, 'red', '↑')}</div>
    <div class="dashboard-grid"><section class="section-card"><div class="section-head"><div><h2 class="section-title">Transaksi Terbaru</h2><div class="section-caption">Lima catatan terakhir</div></div><button class="button button-secondary button-small" data-page="transactions">Lihat Semua</button></div>${transactionRows(data.recent)}</section>
      <section class="section-card"><div class="section-head"><div><h2 class="section-title">Ringkasan Keuntungan</h2><div class="section-caption">Catatan pemasukan dan biaya usaha</div></div><button class="button button-secondary button-small" data-page="profits">Buka</button></div><div class="stats-card" style="padding:14px;margin-bottom:10px"><div class="stat-icon teal">↗</div><div><div class="stat-label">Saldo Keuntungan</div><div class="stat-value">${money(p.balance)}</div></div></div><div class="info-row"><span class="muted">Total Masuk</span><strong style="color:var(--success)">${money(p.totalIn)}</strong></div><div class="info-row"><span class="muted">Total Keluar</span><strong style="color:var(--danger)">${money(p.totalOut)}</strong></div><button class="button button-secondary" style="width:100%;margin-top:13px" data-page="stock">Lihat Stok Barang</button></section></div>`;
}
async function renderTransactions() {
  const { items } = await api('/api/transactions');
  const totals = items.reduce((r, x) => { r[x.type === 'Masuk' ? 'in' : 'out'] += x.amount; return r; }, { in:0, out:0 });
  return `${heading('Buku Kas', 'Kelola seluruh transaksi uang masuk dan uang keluar.', `<button class="button button-primary" data-action="add-ledger" data-type="transaction">＋ Tambah Transaksi</button>`)}
    <div class="grid stats-grid" style="margin-bottom:16px">${statCard('Total Masuk',totals.in,'green','↓')}${statCard('Total Keluar',totals.out,'red','↑')}</div>
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Semua Transaksi</h2><div class="section-caption">${items.length} catatan tersimpan</div></div></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${items.map(x => `<tr><td>${fmtDate(x.date)}</td><td><strong>${escapeHtml(x.description)}</strong></td><td><span class="pill ${x.type === 'Masuk' ? 'in' : 'out'}">${x.type}</span></td><td style="font-weight:800;color:${x.type === 'Masuk' ? 'var(--success)' : 'var(--danger)'}">${x.type === 'Masuk' ? '+' : '-'}${money(x.amount)}</td><td><div class="table-actions"><button class="button button-secondary button-small" data-action="edit-ledger" data-type="transaction" data-id="${x.id}">Edit</button><button class="button button-danger button-small" data-action="delete-ledger" data-type="transaction" data-id="${x.id}">Hapus</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Belum ada transaksi','Tekan tombol Tambah Transaksi untuk mencatat uang masuk atau keluar.')}</section>`;
}
async function renderProfits() {
  const { items } = await api('/api/profits');
  const totals = items.reduce((r,x) => { r[x.type === 'Masuk' ? 'in' : 'out'] += x.amount; return r; }, { in:0,out:0 });
  return `${heading('Keuntungan', 'Pantau pemasukan dan pengeluaran khusus kegiatan usaha.', `<button class="button button-primary" data-action="add-ledger" data-type="profit">＋ Tambah</button>`)}
    ${balanceCard('Saldo Keuntungan',totals.in - totals.out,true)}
    <div class="grid stats-grid" style="margin-top:16px">${statCard('Total Masuk',totals.in,'green','↓')}${statCard('Total Keluar',totals.out,'red','↑')}</div>
    <section class="section-card" style="margin-top:17px"><div class="section-head"><div><h2 class="section-title">Transaksi Keuntungan</h2><div class="section-caption">${items.length} catatan tersimpan</div></div></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${items.map(x => `<tr><td>${fmtDate(x.date)}</td><td><strong>${escapeHtml(x.description)}</strong></td><td><span class="pill ${x.type === 'Masuk' ? 'in' : 'out'}">${x.type}</span></td><td style="font-weight:800;color:${x.type === 'Masuk' ? 'var(--success)' : 'var(--danger)'}">${x.type === 'Masuk' ? '+' : '-'}${money(x.amount)}</td><td><div class="table-actions"><button class="button button-secondary button-small" data-action="edit-ledger" data-type="profit" data-id="${x.id}">Edit</button><button class="button button-danger button-small" data-action="delete-ledger" data-type="profit" data-id="${x.id}">Hapus</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Belum ada data keuntungan','Tambahkan data keuntungan usaha untuk mulai.')}</section>`;
}
async function renderStock() {
  const [cats, products] = await Promise.all([api('/api/categories'), api('/api/products')]);
  state.stockCategories = cats.items; state.stockProducts = products.items;
  const totalStock = products.items.reduce((sum, p) => sum + p.stock, 0);
  return `${heading('Stok Barang', 'Kelola kategori, harga barang, dan jumlah stok.', `<button class="button button-secondary" data-action="add-category">＋ Kategori</button><button class="button button-primary" data-action="add-product">＋ Barang</button>`)}
    <div class="grid stats-grid" style="margin-bottom:16px"><div class="stats-card"><div class="stat-icon blue">▣</div><div><div class="stat-label">Kategori</div><div class="stat-value">${cats.items.length}</div></div></div><div class="stats-card"><div class="stat-icon teal">▤</div><div><div class="stat-label">Total Unit Stok</div><div class="stat-value">${totalStock.toLocaleString('id-ID')}</div></div></div></div>
    ${cats.items.length ? cats.items.map(c => { const list = products.items.filter(p => p.category_id === c.id); return `<section class="stock-category"><div class="stock-category-head"><div><div class="stock-category-name">${escapeHtml(c.name)}</div><div class="stock-category-count">${list.length} barang</div></div><div class="table-actions"><button class="button button-secondary button-small" data-action="edit-category" data-id="${c.id}">Ubah</button><button class="button button-danger button-small" data-action="delete-category" data-id="${c.id}">Hapus</button><button class="button button-quiet button-small" data-action="add-product" data-category="${c.id}">＋ Barang</button></div></div>${list.length ? list.map(p => `<div class="stock-product"><div class="stock-product-info"><div class="stock-product-name">${escapeHtml(p.name)}</div><div class="stock-product-price">${money(p.price)}</div></div><div class="stock-count">Stok ${p.stock}</div><div class="stock-actions"><button class="icon-button" title="Kurangi stok" data-action="stock-delta" data-id="${p.id}" data-delta="-1">−</button><button class="icon-button" title="Tambah stok" data-action="stock-delta" data-id="${p.id}" data-delta="1">＋</button></div><button class="button button-secondary button-small" data-action="edit-product" data-id="${p.id}">Edit</button></div>`).join('') : `<div class="empty-state" style="padding:20px">Belum ada barang dalam kategori ini.</div>`}</section>`; }).join('') : `<section class="section-card">${emptyState('Belum ada kategori','Buat kategori terlebih dahulu sebelum menambahkan barang.','▣')}</section>`}`;
}
async function renderReports() {
  const data = await api(`/api/reports?from=${encodeURIComponent(state.reportFrom)}&to=${encodeURIComponent(state.reportTo)}`);
  state.report = data;
  return `${heading('Laporan', 'Rekap transaksi berdasarkan rentang tanggal yang dipilih.', `<button class="button button-secondary" data-action="export-csv">↓ Export CSV</button><button class="button button-primary" data-action="print-report">▧ Simpan PDF</button>`)}
    <form class="filter-row" id="report-filter"><div class="field"><label for="report-from">Dari</label><input type="date" id="report-from" name="from" value="${state.reportFrom}" required></div><div class="field"><label for="report-to">Sampai</label><input type="date" id="report-to" name="to" value="${state.reportTo}" required></div><button class="button button-primary" type="submit">Terapkan Filter</button></form>
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Rekap Periode</h2><div class="section-caption">${fmtDate(data.from)} – ${fmtDate(data.to)}</div></div></div><div class="info-row"><span class="muted">Total Masuk</span><strong style="color:var(--success)">${money(data.totalIn)}</strong></div><div class="info-row"><span class="muted">Total Keluar</span><strong style="color:var(--danger)">${money(data.totalOut)}</strong></div><div class="info-row"><strong>Saldo Periode</strong><strong style="font-size:16px;color:${data.balance >= 0 ? 'var(--success)' : 'var(--danger)'}">${money(data.balance)}</strong></div></section>
    <section class="section-card" style="margin-top:17px"><div class="section-head"><div><h2 class="section-title">Detail Transaksi (${data.items.length})</h2><div class="section-caption">Daftar catatan dalam periode tersebut</div></div></div>${data.items.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${data.items.map(x => `<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}</td><td><span class="pill ${x.type === 'Masuk' ? 'in' : 'out'}">${x.type}</span></td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Tidak ada transaksi','Tidak ada data pada periode ini.','⌕')}</section>`;
}
async function renderSettings() {
  return `${heading('Pengaturan', 'Backup data dan ekspor laporan ke perangkat Anda.')}
    <div class="setting-grid"><section class="setting-card"><div class="setting-icon">⇧</div><h3>Backup Data</h3><p>Unduh salinan transaksi, keuntungan, kategori, dan stok dalam format JSON.</p><button class="button button-primary" data-action="backup">Backup Sekarang</button></section>
    <section class="setting-card"><div class="setting-icon">↻</div><h3>Restore Backup</h3><p>Ganti data akun ini dari file backup Buku Kas. Data saat ini akan ditimpa.</p><label class="button button-secondary" for="restore-file">Pilih File Backup</label><input id="restore-file" type="file" accept="application/json,.json" hidden></section>
    <section class="setting-card"><div class="setting-icon" style="background:#fff0ee;color:#c74747">▧</div><h3>Export PDF</h3><p>Buat laporan Buku Kas atau Keuntungan, lalu simpan melalui dialog cetak browser.</p><div class="field"><label>Dari</label><input type="date" id="settings-from" value="${state.reportFrom}"></div><div class="field" style="margin-top:10px"><label>Sampai</label><input type="date" id="settings-to" value="${state.reportTo}"></div><div class="table-actions" style="margin-top:13px"><button class="button button-secondary button-small" data-action="settings-print" data-type="transaction">Buku Kas</button><button class="button button-secondary button-small" data-action="settings-print" data-type="profit">Keuntungan</button></div></section>
    <section class="setting-card"><div class="setting-icon">ⓘ</div><h3>Informasi</h3><div class="info-row"><span class="muted">Versi Website</span><strong>1.0.0</strong></div><div class="info-row"><span class="muted">Database</span><strong>SQLite Server</strong></div><div class="info-row"><span class="muted">Login</span><strong>Email / Google</strong></div></section></div>
    <div class="notice" style="margin-top:16px">Backup hanya berisi data milik akun Anda. Data yang tersimpan di server tetap dapat dilihat administrator sistem untuk keperluan pengelolaan dan audit sesuai hak akses.</div>`;
}

function showModal(title, body, wide = false) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-head"><h2 class="modal-title">${title}</h2><button class="close-button" data-action="close-modal" aria-label="Tutup">×</button></div><div class="modal-body">${body}</div></section></div>`;
}
function hideModal() { modalRoot.innerHTML = ''; }
function ledgerForm(type, item = null) {
  const profit = type === 'profit';
  return `<form id="ledger-form" data-type="${type}" data-id="${item?.id || ''}">
    <div class="field"><label>Tanggal</label><input name="date" type="date" value="${escapeHtml(item?.date || todayISO())}" required></div>
    <div class="field" style="margin-top:15px"><label>Jenis Transaksi</label><div class="segmented"><button type="button" class="${(item?.type || 'Masuk') === 'Masuk' ? 'selected' : ''}" data-action="set-ledger-type" data-value="Masuk">↓ Masuk</button><button type="button" class="${item?.type === 'Keluar' ? 'selected' : ''}" data-action="set-ledger-type" data-value="Keluar">↑ Keluar</button></div><input type="hidden" name="type" value="${item?.type || 'Masuk'}"></div>
    <div class="field" style="margin-top:15px"><label>Keterangan</label><input name="description" maxlength="200" value="${escapeHtml(item?.description || '')}" placeholder="Contoh: Penjualan hari ini" required></div>
    <div class="field" style="margin-top:15px"><label>Nominal</label><input name="amount" type="number" min="1" step="1" value="${item?.amount ?? ''}" placeholder="Contoh: 500000" required></div>
    <div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button class="button button-primary" type="submit">${item ? 'Simpan Perubahan' : 'Simpan'}</button></div>
  </form>`;
}
async function openLedger(type, id = null) {
  let item = null;
  if (id) {
    const { items } = await api(type === 'profit' ? '/api/profits' : '/api/transactions');
    item = items.find(x => x.id === Number(id));
    if (!item) return toast('Data tidak ditemukan.', 'error');
  }
  showModal(`${id ? 'Edit' : 'Tambah'} ${type === 'profit' ? 'Keuntungan' : 'Transaksi'}`, ledgerForm(type, item));
}
function categoryForm(category = null) {
  return `<form id="category-form" data-id="${category?.id || ''}"><div class="field"><label>Nama Kategori</label><input name="name" value="${escapeHtml(category?.name || '')}" maxlength="100" placeholder="Contoh: Makanan" required></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button class="button button-primary">Simpan</button></div></form>`;
}
function productForm(product = null, categoryId = null) {
  if (!state.stockCategories.length) return `<div class="notice">Buat kategori terlebih dahulu sebelum menambahkan barang.</div>`;
  const selected = product?.category_id || categoryId || state.stockCategories[0].id;
  return `<form id="product-form" data-id="${product?.id || ''}"><div class="field"><label>Kategori</label><select name="categoryId" required>${state.stockCategories.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div><div class="field" style="margin-top:15px"><label>Nama Barang</label><input name="name" value="${escapeHtml(product?.name || '')}" maxlength="100" placeholder="Nama barang" required></div><div class="field" style="margin-top:15px"><label>Harga</label><input name="price" type="number" min="0" step="1" value="${product?.price ?? ''}" placeholder="Contoh: 15000" required></div><p class="muted" style="font-size:10px">Stok dimulai dari 0 dan diubah melalui tombol + / − pada daftar barang.</p><div class="modal-actions">${product ? `<button type="button" class="button button-danger" data-action="delete-product" data-id="${product.id}">Hapus</button>` : ''}<button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button class="button button-primary">Simpan</button></div></form>`;
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
    <section class="section-card"><div class="section-head"><div><h2 class="section-title">Daftar Pengguna</h2><div class="section-caption">Menampilkan ${items.length} akun (maksimal 250 hasil)</div></div></div>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Pengguna</th><th>Terdaftar</th><th>Transaksi</th><th>Aktivitas</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${items.map(u => `<tr><td><strong>${escapeHtml(u.name)}</strong><div class="muted" style="font-size:10px;margin-top:3px">${escapeHtml(u.email)}</div></td><td>${fmtDate(u.created_at)}</td><td>${u.transaction_count}</td><td>${u.activity_count}</td><td><span class="pill ${u.is_active ? 'active' : 'inactive'}">${u.is_active ? 'Aktif' : 'Nonaktif'}</span></td><td><div class="table-actions"><button class="button button-secondary button-small" data-action="view-user" data-id="${u.id}">Lihat Data</button><button class="button ${u.is_active ? 'button-danger' : 'button-primary'} button-small" data-action="toggle-user" data-id="${u.id}" data-active="${u.is_active ? '1' : '0'}">${u.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Pengguna tidak ditemukan','Coba gunakan kata kunci pencarian lain.','♙')}</section>`;
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
    <h3 class="section-title">Transaksi Buku Kas</h3>${d.transactions.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${d.transactions.slice(0,30).map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}</td><td>${escapeHtml(x.type)}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:11px">Belum ada transaksi.</p>'}
    <h3 class="section-title" style="margin-top:18px">Keuntungan</h3><p class="muted" style="font-size:11px">${d.profits.length} catatan keuntungan</p>
    <h3 class="section-title" style="margin-top:18px">Stok Barang</h3>${d.products.length ? `<div class="table-wrap"><table><thead><tr><th>Kategori</th><th>Barang</th><th>Stok</th><th>Harga</th></tr></thead><tbody>${d.products.map(x=>`<tr><td>${escapeHtml(x.category_name)}</td><td>${escapeHtml(x.name)}</td><td>${x.stock}</td><td>${money(x.price)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:11px">Belum ada barang.</p>'}
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
  const rows = [['Tanggal','Keterangan','Jenis','Nominal'], ...(state.report?.items || []).map(x => [x.date,x.description,x.type,x.amount])];
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
  main.innerHTML = `<section class="section-card"><h1 style="font-size:22px;margin:0 0 5px">${title}</h1><p style="font-size:12px;color:#68756c">Periode ${fmtDate(from)} – ${fmtDate(to)}</p><div class="info-row"><span>Total Masuk</span><strong>${money(totalIn)}</strong></div><div class="info-row"><span>Total Keluar</span><strong>${money(totalOut)}</strong></div><div class="info-row"><strong>Saldo</strong><strong>${money(totalIn-totalOut)}</strong></div><h3 style="font-size:14px;margin-top:20px">Detail Transaksi (${items.length})</h3><div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${items.map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.description)}</td><td>${x.type}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div></section>`;
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
    if (action === 'show-login') return showAuth(false, false);
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
      form.querySelectorAll('[data-action=set-ledger-type]').forEach(x=>x.classList.toggle('selected',x===button)); return;
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
    if (action === 'add-product') return showModal('Tambah Barang',productForm(null,Number(button.dataset.category)||null));
    if (action === 'edit-product') { const p=state.stockProducts.find(x=>x.id===Number(button.dataset.id)); if(p) return showModal('Edit Barang',productForm(p)); }
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
      const fd=new FormData(form); const admin=form.dataset.admin==='true'; const register=form.dataset.register==='true';
      const body={email:fd.get('email'),password:fd.get('password')};
      if(register) body.name=fd.get('name');
      const endpoint=admin?'/api/auth/admin/login':register?'/api/auth/register':'/api/auth/login';
      const submit=form.querySelector('button[type=submit]'); submit.disabled=true; submit.textContent='Memproses…';
      const error=document.getElementById('auth-error'); if(error) error.textContent='';
      try {
        const result=await api(endpoint,{method:'POST',body}); state.user=result.user; state.isAdmin=result.user.role==='admin'; state.page=state.isAdmin?'overview':'dashboard';
        history.replaceState({},'',state.isAdmin?'/admin':'/'); await renderPage();
      } catch(err) { if(error) error.textContent=err.message; submit.disabled=false; submit.textContent=admin?'Masuk ke Panel Admin':register?'Buat Akun':'Masuk'; }
      return;
    }
    if (form.id === 'ledger-form') {
      event.preventDefault(); const fd=new FormData(form); const type=form.dataset.type; const id=form.dataset.id;
      const body={date:fd.get('date'),description:fd.get('description'),type:fd.get('type'),amount:Number(fd.get('amount'))};
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
      await api(`/api/products${id?`/${id}`:''}`,{method:id?'PUT':'POST',body:{categoryId:Number(fd.get('categoryId')),name:fd.get('name'),price:Number(fd.get('price'))}});
      hideModal(); toast('Barang berhasil disimpan.'); return renderPage();
    }
    if (form.id === 'report-filter') {
      event.preventDefault(); const fd=new FormData(form); state.reportFrom=fd.get('from'); state.reportTo=fd.get('to'); if(state.reportFrom>state.reportTo) return toast('Tanggal awal tidak boleh melewati tanggal akhir.','error'); return renderPage();
    }
    if (form.id === 'user-search-form') {
      event.preventDefault(); const fd=new FormData(form); state.userSearch=fd.get('search'); return renderPage();
    }
  } catch (err) { toast(err.message,'error'); }
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
