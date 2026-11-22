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
    } catch (error) { fail(res, error, 'Kategori tidak dapat dimuat.'); }
  }));
  app.post('/api/categories', requireAuth, wrap(async (req, res) => {
    try {
      const name = validateName(req.body.name, 'Nama kategori');
      const rows = await pg.insert('categories', { user_id: uid(req), name }, jwt(req));
      recordActivity(req, 'category_create', 'category', lid(rows[0]), { name });
      res.status(201).json({ item: { id: lid(rows[0]), user_id: req.user.id, name } });
    } catch (error) { fail(res, error, 'Kategori tidak dapat dibuat.'); }
  }));
  app.put('/api/categories/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const name = validateName(req.body.name, 'Nama kategori');
      const rows = await pg.patch('categories', { user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, { name, updated_at: new Date().toISOString() }, jwt(req));
      if (!rows.length) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
      recordActivity(req, 'category_update', 'category', id, { name });
      res.json({ item: { id, user_id: req.user.id, name } });
    } catch (error) { fail(res, error, 'Kategori tidak dapat diperbarui.'); }
  }));
  app.delete('/api/categories/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const category = await categoryByLegacy(req, id);
      if (!category) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
      const products = await pg.list('products', { select: 'id', user_id: filterUser(uid(req)), category_id: `eq.${category.id}` }, jwt(req));
      const deleted = await pg.remove('categories', { user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
      if (!deleted.length) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
      recordActivity(req, 'category_delete', 'category', id, { name: category.name, deletedProducts: products.length });
      res.json({ ok: true, deletedProducts: products.length });
    } catch (error) { fail(res, error, 'Kategori tidak dapat dihapus.'); }
  }));

  // Products and stock.
  app.get('/api/products', requireAuth, wrap(async (req, res) => {
    try {
      const catalog = await catalogFor(pg, uid(req), jwt(req));
      recordActivity(req, 'product_list_view', 'product');
      res.json({ items: catalog.products.map(row => ({ ...row, user_id: req.user.id })) });
    } catch (error) { fail(res, error, 'Produk tidak dapat dimuat.'); }
  }));
  app.post('/api/products', requireAuth, wrap(async (req, res) => {
    try {
      const categoryId = parseId(req.body.categoryId);
      const name = validateName(req.body.name, 'Nama barang');
      const pricing = calculatePricing(req.body);
      if (!categoryId) return res.status(400).json({ error: 'Kategori tidak valid.' });
      const category = await categoryByLegacy(req, categoryId);
      if (!category) return res.status(400).json({ error: 'Kategori tidak valid.' });
      const rows = await pg.insert('products', {
        user_id: uid(req), category_id: category.id, name,
        sku: req.body.sku ? String(req.body.sku).slice(0,80) : null,
        unit_name: String(req.body.unitName || 'pcs').slice(0,24),
        stock_quantity: 0, reserved_quantity: 0, unit_cost: pricing.unitCost,
        sale_price: pricing.salePrice, pricing_method: toDbPricing(pricing.pricingMethod),
        pricing_value: pricing.pricingValue, is_active: true
      }, jwt(req));
      const row = rows[0];
      recordActivity(req, 'product_create', 'product', lid(row), { name, ...pricing, categoryId });
      res.status(201).json({ item: {
        id: lid(row), user_id: req.user.id, category_id: categoryId, category_name: category.name,
        name, sku: row.sku, unit_name: row.unit_name, stock: 0, price: pricing.salePrice,
        sale_price: pricing.salePrice, unit_cost: pricing.unitCost,
        pricing_method: pricing.pricingMethod, pricing_value: pricing.pricingValue, is_active: true
      } });
    } catch (error) { fail(res, error, 'Produk tidak dapat dibuat.'); }
  }));
  app.put('/api/products/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const categoryId = parseId(req.body.categoryId);
    if (!id || !categoryId) return res.status(400).json({ error: 'ID atau kategori tidak valid.' });
    try {
      const name = validateName(req.body.name, 'Nama barang');
      const pricing = calculatePricing(req.body);
      const [category, existing] = await Promise.all([categoryByLegacy(req, categoryId), productByLegacy(req, id)]);
      if (!category) return res.status(400).json({ error: 'Kategori tidak valid.' });
      if (!existing) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
      const rows = await pg.patch('products', { user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, {
        category_id: category.id, name,
        sku: req.body.sku ? String(req.body.sku).slice(0,80) : null,
        unit_name: String(req.body.unitName || existing.unit_name || 'pcs').slice(0,24),
        unit_cost: pricing.unitCost, sale_price: pricing.salePrice,
        pricing_method: toDbPricing(pricing.pricingMethod), pricing_value: pricing.pricingValue,
        updated_at: new Date().toISOString()
      }, jwt(req));
      const row = rows[0];
      if (!row) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
      recordActivity(req, 'product_update', 'product', id, { name, ...pricing, categoryId });
      res.json({ item: {
        id, user_id: req.user.id, category_id: categoryId, category_name: category.name,
        name: row.name, sku: row.sku, unit_name: row.unit_name, stock: num(row.stock_quantity),
        price: num(row.sale_price), sale_price: num(row.sale_price), unit_cost: num(row.unit_cost),
        pricing_method: toUiPricing(row.pricing_method), pricing_value: num(row.pricing_value), is_active: Boolean(row.is_active)
      } });
    } catch (error) { fail(res, error, 'Produk tidak dapat diperbarui.'); }
  }));
  app.delete('/api/products/:id', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const old = await productByLegacy(req, id);
      if (!old) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
      const deleted = await pg.remove('products', { user_id: filterUser(uid(req)), legacy_id: `eq.${id}` }, jwt(req));
      if (!deleted.length) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
      recordActivity(req, 'product_delete', 'product', id, { name: old.name });
      res.json({ ok: true });
    } catch (error) { fail(res, error, 'Produk tidak dapat dihapus.'); }
  }));
  app.post('/api/products/:id/stock', requireAuth, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const delta = Number(req.body.delta);
    if (!id || ![-1, 1].includes(delta)) return res.status(400).json({ error: 'Perubahan stok tidak valid.' });
    try {
      const result = await pg.rpc('adjust_feeku_stock', { p_product_legacy_id: id, p_delta: delta }, jwt(req));
      const row = Array.isArray(result) ? result[0] : result;
      if (!row) return res.status(404).json({ error: 'Barang tidak ditemukan.' });
      recordActivity(req, delta > 0 ? 'stock_increase' : 'stock_decrease', 'product', id, { name: row.name, stock: num(row.stock) });
      res.json({ item: { id, name: row.name, stock: num(row.stock) } });
    } catch (error) { fail(res, error, 'Perubahan stok tidak dapat disimpan.'); }
  }));


  // Reports, backup and restore.
  app.get('/api/reports', requireAuth, wrap(async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : '2000-01-01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : '2100-12-31';
    if (from > to) return res.status(400).json({ error: 'Tanggal awal tidak boleh melewati tanggal akhir.' });
    try {
      const items = await transactionsFor(pg, uid(req), jwt(req), false, { and: `(entry_date.gte.${from},entry_date.lte.${to})` });
      const totalIn = items.filter(row => row.type === 'Masuk').reduce((sum, row) => sum + row.amount, 0);
      const totalOut = items.filter(row => row.type === 'Keluar').reduce((sum, row) => sum + row.amount, 0);
      recordActivity(req, 'report_view', 'report', null, { from, to, count: items.length });
      res.json({ items, totalIn, totalOut, balance: totalIn - totalOut, from, to });
    } catch (error) { fail(res, error, 'Laporan tidak dapat dimuat.'); }
  }));
  app.get('/api/settings/backup', requireAuth, wrap(async (req, res) => {
    try {
      const [transactions, profits, catalog] = await Promise.all([
        transactionsFor(pg, uid(req), jwt(req)), profitsFor(pg, uid(req), jwt(req)), catalogFor(pg, uid(req), jwt(req))
      ]);
      const backup = {
        format: 'buku-kas-backup-v2', exportedAt: new Date().toISOString(),
        transactions: transactions.map(row => ({ id: row.id, date: row.date, description: row.description, type: row.type, amount: row.amount, items: row.items })),
        profits: profits.map(row => ({ id: row.id, date: row.date, description: row.description, type: row.type, amount: row.amount, source_transaction_id: row.source_transaction_id })),
        categories: catalog.categories.map(row => ({ id: row.id, name: row.name })),
        products: catalog.products.map(row => ({
          id: row.id, category: row.category_name, name: row.name, stock: row.stock,
          price: row.price, unit_cost: row.unit_cost, sale_price: row.sale_price,
          pricing_method: row.pricing_method, pricing_value: row.pricing_value
        }))
      };
      recordActivity(req, 'backup_export', 'backup', null, { transactionCount: backup.transactions.length, productCount: backup.products.length });
      res.setHeader('Content-Disposition', `attachment; filename="feeku-backup-${new Date().toISOString().slice(0,10)}.json"`);
      res.json(backup);
    } catch (error) { fail(res, error, 'Backup tidak dapat dibuat.'); }
  }));
  app.post('/api/settings/restore', requireAuth, wrap(async (req, res) => {
    const input = req.body?.backup;
    if (!input || !['buku-kas-backup-v1','buku-kas-backup-v2'].includes(input.format) ||
        !Array.isArray(input.transactions) || !Array.isArray(input.profits) ||
        !Array.isArray(input.categories) || !Array.isArray(input.products)) {
      return res.status(400).json({ error: 'Format file backup tidak dikenali.' });
    }
    const count = input.transactions.length + input.profits.length + input.categories.length + input.products.length;
    if (count > 10000) return res.status(400).json({ error: 'Backup terlalu besar.' });
    try {
      const imported = await pg.rpc('restore_feeku_user_backup', { p_data: input }, jwt(req));
      recordActivity(req, 'backup_restore', 'backup', null, { format: input.format, transactions: input.transactions.length, products: input.products.length });
      res.json({ ok: true, imported });
    } catch (error) { fail(res, error, 'Restore gagal. Data lama dipertahankan jika proses database dibatalkan.'); }
  }));

  // Admin data still uses SQLite only for local account status/cache. All business records are PostgreSQL.
  const localName = uuid => uuid ? (db.prepare('SELECT name FROM users WHERE supabase_user_id=?').get(uuid)?.name || null) : null;
  const activityView = row => ({
    id: lid(row), user_id: row.user_id, actor_user_id: row.actor_user_id,
    user_name: localName(row.actor_user_id || row.user_id), action: row.action,
    entity_type: row.entity_type, entity_id: row.entity_id, metadata: row.metadata || {},
    created_at: row.created_at
  });

  app.get('/api/admin/overview', requireAdmin, wrap(async (req, res) => {
    try {
      const [users, transactions, profits, logs] = await Promise.all([
        Promise.resolve(db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END),0) AS active FROM users WHERE role='user'").get()),
        pg.list('transactions', { select: 'amount' }, null, true),
        pg.list('profits', { select: 'amount' }, null, true),
        pg.list('activity_logs', { select: '*', order: 'created_at.desc', limit: 12 }, null, true)
      ]);
      recordActivity(req, 'admin_overview_view', 'admin');
      res.json({
        users,
        cash: { transactionCount: transactions.length, transactionVolume: transactions.reduce((s, r) => s + num(r.amount), 0) },
        profit: { profitCount: profits.length, profitVolume: profits.reduce((s, r) => s + num(r.amount), 0) },
        recentActivity: logs.map(activityView)
      });
    } catch (error) { fail(res, error, 'Ringkasan admin tidak dapat dimuat.'); }
  }));
  app.get('/api/admin/users', requireAdmin, wrap(async (req, res) => {
    try {
      const search = String(req.query.search || '').trim().slice(0,100);
      const users = search
        ? db.prepare("SELECT id,name,email,role,is_active,email_verified_at,created_at,supabase_user_id FROM users WHERE role='user' AND (name LIKE ? OR email LIKE ?) ORDER BY created_at DESC LIMIT 250").all(`%${search}%`,`%${search}%`)
        : db.prepare("SELECT id,name,email,role,is_active,email_verified_at,created_at,supabase_user_id FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 250").all();
      const uuids = users.map(row => row.supabase_user_id).filter(Boolean);
      let tx = [], activity = [];
      if (uuids.length) {
        const filter = filterIn(uuids);
        [tx, activity] = await Promise.all([
          pg.list('transactions', { select: 'user_id', user_id: filter }, null, true),
          pg.list('activity_logs', { select: 'actor_user_id', actor_user_id: filter }, null, true)
        ]);
      }
      const txCount = new Map(), activityCount = new Map();
      for (const row of tx) txCount.set(row.user_id, (txCount.get(row.user_id) || 0) + 1);
      for (const row of activity) if (row.actor_user_id) activityCount.set(row.actor_user_id, (activityCount.get(row.actor_user_id) || 0) + 1);
      const items = users.map(row => ({
        id: row.id, name: row.name, email: row.email, role: row.role, is_active: row.is_active,
        email_verified_at: row.email_verified_at, created_at: row.created_at,
        transaction_count: txCount.get(row.supabase_user_id) || 0,
        activity_count: activityCount.get(row.supabase_user_id) || 0
      }));
      recordActivity(req, 'admin_users_list_view', 'admin', null, { resultCount: items.length });
      res.json({ items });
    } catch (error) { fail(res, error, 'Daftar pengguna tidak dapat dimuat.'); }
  }));
  app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const target = db.prepare("SELECT * FROM users WHERE id=? AND role='user'").get(id);
      if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
      const name = req.body.name === undefined ? target.name : validateName(req.body.name);
      if (req.body.isActive !== undefined && typeof req.body.isActive !== 'boolean') return res.status(400).json({ error: 'Status akun harus berupa boolean.' });
      const active = req.body.isActive === undefined ? target.is_active : (req.body.isActive ? 1 : 0);
      db.prepare("UPDATE users SET name=?,is_active=?,session_version=session_version+CASE WHEN ?=0 THEN 1 ELSE 0 END,updated_at=datetime('now') WHERE id=? AND role='user'").run(name, active, active, id);
      recordActivity(req, 'admin_user_update', 'user', id, { name, isActive: Boolean(active), targetEmail: target.email });
      res.json({ item: { id, name, email: target.email, role: target.role, isActive: Boolean(active), emailVerified: Boolean(target.email_verified_at), createdAt: target.created_at } });
    } catch (error) { fail(res, error, 'Status pengguna tidak dapat diperbarui.'); }
  });
  app.get('/api/admin/users/:id/data', requireAdmin, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    try {
      const user = db.prepare("SELECT id,name,email,role,is_active,email_verified_at,created_at,supabase_user_id FROM users WHERE id=? AND role='user'").get(id);
      if (!user) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
      if (!user.supabase_user_id) return res.json({ user, transactions: [], profits: [], products: [], categories: [], activity: [] });
      const [transactions, profits, catalog, logs] = await Promise.all([
        transactionsFor(pg, user.supabase_user_id, null, true),
        profitsFor(pg, user.supabase_user_id, null, true),
        catalogFor(pg, user.supabase_user_id, null, true),
        pg.list('activity_logs', { select: '*', user_id: filterUser(user.supabase_user_id), order: 'created_at.desc', limit: 100 }, null, true)
      ]);
      recordActivity(req, 'admin_view_user_data', 'user', id, { targetEmail: user.email });
      res.json({
        user: { id: user.id, name: user.name, email: user.email, role: user.role, is_active: user.is_active, email_verified_at: user.email_verified_at, created_at: user.created_at },
        transactions: transactions.map(row => ({ ...row, user_id: id })),
        profits: profits.map(row => ({ ...row, user_id: id })),
        products: catalog.products.map(row => ({ ...row, user_id: id })),
        categories: catalog.categories.map(row => ({ ...row, user_id: id })),
        activity: logs.map(activityView)
      });
    } catch (error) { fail(res, error, 'Data pengguna tidak dapat dimuat.'); }
  }));
  app.get('/api/admin/logs', requireAdmin, wrap(async (req, res) => {
    const userId = parseId(req.query.userId);
    const action = String(req.query.action || '').trim().replace(/[%*]/g, '').slice(0,80);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    try {
      const query = { select: '*', order: 'created_at.desc', limit: String(limit), offset: String(offset) };
      if (userId) {
        const target = db.prepare('SELECT supabase_user_id FROM users WHERE id=?').get(userId);
        if (!target?.supabase_user_id) return res.json({ items: [] });
        query.actor_user_id = `eq.${target.supabase_user_id}`;
      }
      if (action) query.action = `ilike.*${action}*`;
      const rows = await pg.list('activity_logs', query, null, true, limit);
      recordActivity(req, 'admin_activity_log_view', 'admin', null, { resultCount: rows.length, limit, offset });
      res.json({ items: rows.map(activityView) });
    } catch (error) { fail(res, error, 'Log aktivitas tidak dapat dimuat.'); }
  }));
}

module.exports = { registerPostgresBusinessRoutes };
