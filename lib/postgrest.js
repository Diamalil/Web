'use strict';

function createPostgrestClient({ supabaseUrl, publishableKey, secretKey }) {
  const baseUrl = String(supabaseUrl || '').replace(/\/$/, '') + '/rest/v1/';

  function headers({ accessToken, serviceRole = false, prefer, range } = {}) {
    if (!baseUrl.startsWith('https://')) throw new Error('SUPABASE_URL tidak valid.');
    const apiKey = serviceRole ? secretKey : publishableKey;
    if (!apiKey) throw new Error(serviceRole
      ? 'SUPABASE_SECRET_KEY wajib diatur pada server untuk operasi administrator/migrasi.'
      : 'SUPABASE_PUBLISHABLE_KEY belum dikonfigurasi.');
    if (!serviceRole && !accessToken) throw new Error('Sesi Supabase tidak tersedia. Silakan login kembali.');
    const result = { apikey: apiKey, Accept: 'application/json' };
    // sb_secret_* keys are API keys, not JWTs. Send them on apikey only.
    // User-scoped requests carry the authenticated user's JWT to enforce RLS.
    if (!serviceRole) result.Authorization = 'Bearer ' + accessToken;
    if (prefer) result.Prefer = prefer;
    if (range) result.Range = range;
    return result;
  }

  async function request(resource, options = {}) {
    const {
      method = 'GET', query = {}, body, accessToken, serviceRole = false,
      prefer, range, signal
    } = options;
    const url = new URL(resource, baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const requestHeaders = headers({ accessToken, serviceRole, prefer, range });
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal || AbortSignal.timeout(15000)
      });
    } catch (error) {
      const wrapped = new Error('Tidak dapat terhubung ke Supabase PostgreSQL.');
      wrapped.cause = error;
      wrapped.statusCode = 503;
      throw wrapped;
    }
    const raw = await response.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = { message: raw }; }
    }
    if (!response.ok) {
      const message = payload?.message || payload?.msg || payload?.details || payload?.hint || 'Permintaan PostgreSQL gagal.';
      const error = new Error(String(message));
      error.statusCode = response.status;
      error.code = payload?.code;
      error.details = payload?.details;
      throw error;
    }
    return payload;
  }

  async function list(table, query = {}, accessToken, serviceRole = false, pageSize = 1000) {
    const rows = [];
    const explicitLimit = query.limit !== undefined && query.limit !== null;
    let offset = Number(query.offset || 0);
    const maxRows = explicitLimit ? Number(query.limit) : 100000;
    while (rows.length < maxRows) {
      const size = explicitLimit ? Math.max(1, Math.min(pageSize, maxRows - rows.length)) : pageSize;
      const page = await request(table, {
        query: { ...query, offset, limit: size },
        accessToken, serviceRole,
        range: offset + '-' + (offset + size - 1)
      });
      if (!Array.isArray(page)) throw new Error('Respons PostgreSQL untuk ' + table + ' bukan array.');
      rows.push(...page);
      if (page.length < size || explicitLimit) break;
      offset += size;
    }
    return rows;
  }

  async function one(table, query = {}, accessToken, serviceRole = false) {
    const rows = await list(table, { ...query, limit: 1 }, accessToken, serviceRole, 1);
    return rows[0] || null;
  }

  async function insert(table, record, accessToken, serviceRole = false) {
    const rows = await request(table, {
      method: 'POST',
      query: { select: '*' },
      body: record,
      accessToken,
      serviceRole,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function patch(table, query, changes, accessToken, serviceRole = false) {
    const rows = await request(table, {
      method: 'PATCH',
      query: { ...query, select: '*' },
      body: changes,
      accessToken,
      serviceRole,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function remove(table, query, accessToken, serviceRole = false) {
    const rows = await request(table, {
      method: 'DELETE',
      query: { ...query, select: '*' },
      accessToken,
      serviceRole,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function rpc(name, args, accessToken, serviceRole = false) {
    return request('rpc/' + name, {
      method: 'POST',
      body: args,
      accessToken,
      serviceRole
    });
  }

  return { request, list, one, insert, patch, remove, rpc };
}

module.exports = { createPostgrestClient };
