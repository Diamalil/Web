'use strict';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const lid = row => Number.isSafeInteger(Number(row?.legacy_id)) ? Number(row.legacy_id) : null;
const filterUser = id => `eq.${id}`;
const filterIn = values => `in.(${[...new Set(values)].join(',')})`;
const toUiPricing = value => ({ target_margin: 'margin', fixed_profit: 'fixed' })[value] || value || 'manual';
const toDbPricing = value => ({ margin: 'target_margin', fixed: 'fixed_profit' })[value] || value || 'manual';

function fail(res, error, fallback) {
  console.error('[postgres-api]', error?.code || '', error?.message || error);
  const code = String(error?.code || '');
  if (code === '23505') return res.status(409).json({ error: 'Data dengan nama tersebut sudah ada.' });
  if (code === '23503') return res.status(409).json({ error: 'Data masih terhubung dengan data lain.' });
  if (code === '23514' && /stock|stok|Insufficient/i.test(error?.message || '')) return res.status(409).json({ error: 'Stok tidak mencukupi atau perubahan stok tidak valid.' });
  if (code === 'P0002' || error?.statusCode === 404) return res.status(404).json({ error: 'Data tidak ditemukan.' });
  if (error?.statusCode === 401 || error?.statusCode === 403) return res.status(error.statusCode).json({ error: 'Akses ditolak. Muat ulang sesi dan coba kembali.' });
  if (error?.statusCode === 503) return res.status(503).json({ error: 'Layanan database sementara tidak tersedia.' });
  if (code === '22023' || error?.statusCode === 400) return res.status(400).json({ error: error.message });
  return res.status(500).json({ error: fallback || 'Permintaan tidak dapat diproses.' });
}

async function transactionsFor(pg, uid, accessToken, admin = false, extra = {}) {
  const rows = await pg.list('transactions', {
    select: '*', user_id: filterUser(uid), order: 'entry_date.desc,legacy_id.desc', ...extra
  }, accessToken, admin);
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const lines = await pg.list('transaction_items', {
    select: '*', user_id: filterUser(uid), transaction_id: filterIn(ids), order: 'legacy_id.asc'
  }, accessToken, admin);
  const productIds = lines.map(line => line.product_id).filter(Boolean);
  const products = productIds.length ? await pg.list('products', {
    select: 'id,legacy_id', user_id: filterUser(uid), id: filterIn(productIds)
  }, accessToken, admin) : [];
  const productLegacy = new Map(products.map(row => [row.id, lid(row)]));
  const grouped = new Map();
  for (const line of lines) {
    if (!grouped.has(line.transaction_id)) grouped.set(line.transaction_id, []);
    grouped.get(line.transaction_id).push({
      id: lid(line), product_id: line.product_id ? (productLegacy.get(line.product_id) || null) : null,
      product_name: line.product_name_snapshot, sku: line.sku_snapshot || null,
      quantity: num(line.quantity), unit_sale_price: num(line.sale_price_snapshot),
      unit_cost: num(line.unit_cost_snapshot), line_total: num(line.line_total),
      line_profit: num(line.profit_amount)
    });
  }
  return rows.map(row => ({
    id: lid(row), date: row.entry_date, description: row.description,
    type: row.direction, amount: num(row.amount), source: row.source,
    created_at: row.created_at, updated_at: row.updated_at,
    items: grouped.get(row.id) || []
  }));
}

async function profitsFor(pg, uid, accessToken, admin = false) {
  const [profits, transactions] = await Promise.all([
    pg.list('profits', { select: '*', user_id: filterUser(uid), order: 'entry_date.desc,legacy_id.desc' }, accessToken, admin),
    pg.list('transactions', { select: 'id,legacy_id', user_id: filterUser(uid) }, accessToken, admin)
  ]);
  const ids = new Map(transactions.map(row => [row.id, lid(row)]));
  return profits.map(row => ({
    id: lid(row), date: row.entry_date, description: row.description,
    type: row.direction, amount: num(row.amount), source: row.source,
    source_transaction_id: row.source_transaction_id ? (ids.get(row.source_transaction_id) || null) : null,
    created_at: row.created_at, updated_at: row.updated_at
  }));
}

async function catalogFor(pg, uid, accessToken, admin = false) {
  const [categories, products] = await Promise.all([
    pg.list('categories', { select: '*', user_id: filterUser(uid), order: 'name.asc' }, accessToken, admin),
    pg.list('products', { select: '*', user_id: filterUser(uid), order: 'name.asc' }, accessToken, admin)
  ]);
  const catById = new Map(categories.map(row => [row.id, row]));
  return {
    categories: categories.map(row => ({
      id: lid(row), name: row.name, description: row.description || null,
      created_at: row.created_at, updated_at: row.updated_at
    })),
    products: products.map(row => {
      const cat = catById.get(row.category_id);
      return {
        id: lid(row), category_id: cat ? lid(cat) : null, category_name: cat?.name || '',
        name: row.name, sku: row.sku || null, unit_name: row.unit_name || 'pcs',
        stock: num(row.stock_quantity), reserved_quantity: num(row.reserved_quantity),
        unit_cost: num(row.unit_cost), sale_price: num(row.sale_price), price: num(row.sale_price),
        pricing_method: toUiPricing(row.pricing_method), pricing_value: num(row.pricing_value),
        is_active: Boolean(row.is_active), created_at: row.created_at, updated_at: row.updated_at
      };
    }),
    rawCategories: categories, rawProducts: products
  };
}

function calculatePricing(body) {
  const unitCost = Number(body.unitCost ?? 0);
  const method = String(body.pricingMethod || 'manual');
  const value = Number(body.pricingValue ?? 0);
  let price;
  if (!Number.isSafeInteger(unitCost) || unitCost <= 0 || unitCost > 1e12) throw new Error('HPP/modal per unit harus lebih dari 0 dan berupa angka rupiah bulat.');
  if (!Number.isFinite(value) || value < 0 || value > 1e9 || (method === 'fixed' && !Number.isSafeInteger(value))) throw new Error('Nilai metode harga jual tidak valid.');
  if (method === 'manual') price = Number(body.salePrice ?? body.price);
  else if (method === 'markup') price = unitCost * (1 + value / 100);
  else if (method === 'margin') { if (value >= 100) throw new Error('Target margin harus kurang dari 100%.'); price = unitCost / (1 - value / 100); }
  else if (method === 'fixed') price = unitCost + value;
  else throw new Error('Metode harga jual tidak dikenal.');
  price = Math.round(price);
  if (!Number.isSafeInteger(price) || price <= 0 || price > 1e12) throw new Error('Harga jual harus lebih dari 0 dan masih dalam batas yang didukung.');
  return { unitCost, salePrice: price, pricingMethod: method, pricingValue: value };
}

function registerPostgresBusinessRoutes({ app, pg, requireAuth, requireAdmin, db, recordActivity, validateRecord, validateName, parseId }) {
  const uid = req => req.authUser?.id;
  const jwt = req => req.accessToken;
  const wrap = asyncRoute;

  async function categoryByLegacy(req, id) {
    return pg.one('categories', { select: '*', user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
  }
  async function productByLegacy(req, id) {
    return pg.one('products', { select: '*', user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
  }

  // Dashboard aggregates now read directly from PostgreSQL.
  app.get('/api/dashboard', requireAuth, wrap(async (req, res) => {
    try {
      const [transactions, profits] = await Promise.all([
        transactionsFor(pg, uid(req), jwt(req)), profitsFor(pg, uid(req), jwt(req))
      ]);
      const sum = (rows, type) => rows.filter(row => row.type === type).reduce((total, row) => total + row.amount, 0);
      recordActivity(req, 'dashboard_view', 'dashboard');
      res.json({
        cash: { totalIn: sum(transactions, 'Masuk'), totalOut: sum(transactions, 'Keluar'), balance: sum(transactions, 'Masuk') - sum(transactions, 'Keluar') },
        profit: { totalIn: sum(profits, 'Masuk'), totalOut: sum(profits, 'Keluar'), balance: sum(profits, 'Masuk') - sum(profits, 'Keluar') },
        recent: transactions.slice(0, 5)
      });
    } catch (error) { fail(res, error, 'Ringkasan tidak dapat dimuat.'); }
  }));

  // Transactions.
  app.get('/api/transactions', requireAuth, wrap(async (req, res) => {
    try {
      const items = await transactionsFor(pg, uid(req), jwt(req));
      recordActivity(req, 'transaction_list_view', 'transaction');
      res.json({ items });
    } catch (error) { fail(res, error, 'Transaksi tidak dapat dimuat.'); }
  }));

  async function saveTransaction(req, updateId) {
    const body = req.body || {};
    const sourceItems = Array.isArray(body.items) ? body.items : [];
    const hasItems = sourceItems.length > 0;
    let date, description, direction, amountValue, items = [];
    if (hasItems) {
      if (String(body.type) !== 'Masuk') throw new Error('Produk katalog hanya bisa digunakan untuk transaksi Masuk.');
      if (sourceItems.length > 50) throw new Error('Maksimal 50 baris produk dalam satu transaksi.');
      date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error('Tanggal tidak valid.');
      description = String(body.description || '').trim();
      if (description.length > 200) throw new Error('Keterangan maksimal 200 karakter.');
      direction = 'Masuk';
      items = sourceItems.map(raw => {
        const productLegacyId = parseId(raw.productId);
        const quantity = Number(raw.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error('Produk atau jumlah barang tidak valid.');
        const line = { quantity };
        if (productLegacyId) line.productLegacyId = productLegacyId;
        else {
          line.productName = validateName(raw.productName || raw.product_name, 'Nama snapshot produk');
          line.unitCost = Number(raw.unitCost ?? raw.unit_cost ?? 0);
          line.unitSalePrice = Number(raw.unitSalePrice ?? raw.unit_sale_price ?? 0);
          line.sku = raw.sku || null;
        }
        if (raw.unitSalePrice !== undefined && raw.unitSalePrice !== '') line.unitSalePrice = Number(raw.unitSalePrice);
        return line;
      });
      amountValue = 0; // the database calculates the sale amount from its item snapshots
    } else {
      const normalized = validateRecord(body);
      date = normalized.date; description = normalized.description;
      direction = normalized.type; amountValue = normalized.amount;
    }
    const result = await pg.rpc('save_feeku_transaction', {
      p_legacy_id: updateId || null,
      p_entry_date: date,
      p_description: description || `Penjualan ${items.length} jenis produk`,
      p_direction: direction,
      p_amount: amountValue,
      p_items: items
    }, jwt(req));
    const id = Number(result?.id);
    const rows = await transactionsFor(pg, uid(req), jwt(req), false, { legacy_id: `eq.${id}` });
    if (!rows[0]) throw new Error('Transaksi tersimpan, tetapi tidak dapat dibaca kembali.');
    recordActivity(req, updateId ? 'transaction_update' : 'transaction_create', 'transaction', id, {
      description: rows[0].description, type: rows[0].type, amount: rows[0].amount, productCount: items.length
    });
    return rows[0];
  }

  app.post('/api/transactions', requireAuth, wrap(async (req, res) => {
    try { res.status(201).json({ item: await saveTransaction(req, null) }); }
    catch (error) { fail(res, error, 'Transaksi tidak dapat disimpan.'); }
  }));
  app.put('/api/transactions/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try { res.json({ item: await saveTransaction(req, id) }); }
    catch (error) { fail(res, error, 'Transaksi tidak dapat diperbarui.'); }
  }));
  app.delete('/api/transactions/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const rows = await pg.remove('transactions', { user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
      if (!rows.length) return res.status(404).json({ error: 'Data transaksi tidak ditemukan.' });
      recordActivity(req, 'transaction_delete', 'transaction', id, { description: rows[0].description, amount: rows[0].amount });
      res.json({ ok: true });
    } catch (error) { fail(res, error, 'Transaksi tidak dapat dihapus.'); }
  }));

  // Profit entries, with catalog margins remaining read-only.
  app.get('/api/profits', requireAuth, wrap(async (req, res) => {
    try {
      const items = await profitsFor(pg, uid(req), jwt(req));
      recordActivity(req, 'profit_list_view', 'profit');
      res.json({ items });
    } catch (error) { fail(res, error, 'Keuntungan tidak dapat dimuat.'); }
  }));
  app.post('/api/profits', requireAuth, wrap(async (req, res) => {
    try {
      const value = validateRecord(req.body);
      const rows = await pg.insert('profits', {
        user_id: uid(req), entry_date: value.date, description: value.description,
        direction: value.type, amount: value.amount, source: 'manual', source_transaction_id: null
      }, jwt(req));
      const row = rows[0];
      recordActivity(req, 'profit_create', 'profit', lid(row), value);
      res.status(201).json({ item: {
        id: lid(row), user_id: req.user.id, date: row.entry_date, description: row.description,
        type: row.direction, amount: num(row.amount), source: row.source, source_transaction_id: null
      } });
    } catch (error) { fail(res, error, 'Catatan keuntungan tidak dapat disimpan.'); }
  }));
  app.put('/api/profits/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const value = validateRecord(req.body);
      const rows = await pg.patch('profits', {
        user_id: filterUser(uid(req)), legacy_id: `eq.${id}`, source: 'eq.manual', source_transaction_id: 'is.null'
      }, {
        entry_date: value.date, description: value.description, direction: value.type,
        amount: value.amount, updated_at: new Date().toISOString()
      }, jwt(req));
      if (!rows.length) {
        const old = await pg.one('profits', { select: 'source_transaction_id', user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
        if (old?.source_transaction_id) return res.status(409).json({ error: 'Keuntungan otomatis mengikuti transaksi penjualan. Edit transaksi penjualannya dari Buku Kas.' });
        return res.status(404).json({ error: 'Data keuntungan tidak ditemukan.' });
      }
      recordActivity(req, 'profit_update', 'profit', id, value);
      res.json({ item: { id, user_id: req.user.id, date: rows[0].entry_date, description: rows[0].description, type: rows[0].direction, amount: num(rows[0].amount), source: rows[0].source, source_transaction_id: null } });
    } catch (error) { fail(res, error, 'Catatan keuntungan tidak dapat diperbarui.'); }
  }));
  app.delete('/api/profits/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const rows = await pg.remove('profits', { user_id: filterUser(uid(req)), legacy_id: `eq.${id}`, source: 'eq.manual', source_transaction_id: 'is.null' }, jwt(req));
      if (!rows.length) {
        const old = await pg.one('profits', { select: 'source_transaction_id', user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
        if (old?.source_transaction_id) return res.status(409).json({ error: 'Keuntungan otomatis mengikuti transaksi penjualan. Hapus transaksi penjualannya dari Buku Kas.' });
        return res.status(404).json({ error: 'Data keuntungan tidak ditemukan.' });
      }
      recordActivity(req, 'profit_delete', 'profit', id, { description: rows[0].description, amount: rows[0].amount });
      res.json({ ok: true });
    } catch (error) { fail(res, error, 'Catatan keuntungan tidak dapat dihapus.'); }
  }));

  // Categories.
  app.get('/api/categories', requireAuth, wrap(async (req, res) => {
    try {
      const rows = await pg.list('categories', { select: '*', user_id: filterUser(uid(req)), order: 'name.asc' }, jwt(req));
      recordActivity(req, 'stock_view', 'stock');
      res.json({ items: rows.map(row => ({ id: lid(row), user_id: req.user.id, name: row.name, description: row.description || null, created_at: row.created_at, updated_at: row.updated_at })) });
    } catch (error) { fail(res, error, 'Kategori tidak