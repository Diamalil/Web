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

