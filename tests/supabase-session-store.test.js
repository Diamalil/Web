'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const SupabaseSessionStore = require('../supabase-session-store');

function createResponse(status, payload = null, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headerMap.get(String(name).toLowerCase()) || null },
    async text() {
      return payload === null ? '' : JSON.stringify(payload);
    }
  };
}

function createFakeFetch() {
  const rows = new Map();
  const calls = [];

  const fetch = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    assert.equal(url.pathname, '/rest/v1/feeku_server_sessions');
    const method = String(options.method || 'GET').toUpperCase();
    const params = url.searchParams;
    calls.push({ url: url.toString(), method, headers: options.headers || {} });

    const sidFilter = params.get('sid');
    const expireFilter = params.get('expire');
    const sid = sidFilter && sidFilter.startsWith('eq.') ? sidFilter.slice(3) : null;
    const body = options.body ? JSON.parse(options.body) : null;

    if (method === 'POST') {
      rows.set(body.sid, { sid: body.sid, sess: body.sess, expire: body.expire });
      return createResponse(201);
    }

    if (method === 'GET') {
      let selected = [...rows.values()];
      if (sid) selected = selected.filter(row => row.sid === sid);
      if (expireFilter && expireFilter.startsWith('gt.')) {
        const value = new Date(expireFilter.slice(3)).getTime();
        selected = selected.filter(row => new Date(row.expire).getTime() > value);
      }
      if (expireFilter && expireFilter.startsWith('lt.')) {
        const value = new Date(expireFilter.slice(3)).getTime();
        selected = selected.filter(row => new Date(row.expire).getTime() < value);
      }
      const count = selected.length;
      if (options.headers && options.headers.Range === '0-0') selected = selected.slice(0, 1);
      const contentRange = count ? '0-' + (selected.length - 1) + '/' + count : '*/0';
      return createResponse(200, selected, { 'content-range': contentRange });
    }

    if (method === 'PATCH') {
      const row = sid ? rows.get(sid) : null;
      if (row) Object.assign(row, body);
      return createResponse(204);
    }

    if (method === 'DELETE') {
      if (sid) {
        rows.delete(sid);
      } else if (expireFilter && expireFilter.startsWith('lt.')) {
        const cutoff = new Date(expireFilter.slice(3)).getTime();
        for (const [key, row] of rows) {
          if (new Date(row.expire).getTime() < cutoff) rows.delete(key);
        }
      } else if (sidFilter === 'not.is.null') {
        rows.clear();
      }
      return createResponse(204);
    }

    return createResponse(405, { message: 'Unsupported method' });
  };

  return { fetch, rows, calls };
}

function invoke(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => {
      if (error) return reject(error);
      resolve(value);
    });
  });
}

function makeSession(userId, maxAge = 60000) {
  return {
    cookie: {
      originalMaxAge: maxAge,
      expires: new Date(Date.now() + maxAge).toISOString()
    },
    csrfToken: 'csrf-' + userId,
    userId
  };
}

test('persists, retrieves, touches, lists, counts, and destroys sessions', async () => {
  const fake = createFakeFetch();
  const store = new SupabaseSessionStore({
    url: 'https://example.supabase.co///',
    apiKey: 'server-only-test-key',
    fetch: fake.fetch
  });

  const original = makeSession('user-1');
  await invoke(store, 'set', 'session-1', original);
  assert.deepEqual(await invoke(store, 'get', 'session-1'), original);
  assert.equal(await invoke(store, 'length'), 1);
  assert.deepEqual(await invoke(store, 'all'), [original]);

  const touched = makeSession('user-1', 120000);
  await invoke(store, 'touch', 'session-1', touched);
  assert.equal(new Date(fake.rows.get('session-1').expire).getTime() > Date.now() + 60000, true);

  await invoke(store, 'destroy', 'session-1');
  assert.equal(await invoke(store, 'get', 'session-1'), null);
  assert.equal(await invoke(store, 'length'), 0);

  const write = fake.calls.find(call => call.method === 'POST');
  assert.equal(write.headers.apikey, 'server-only-test-key');
  assert.equal(write.headers.Authorization, 'Bearer server-only-test-key');
});

test('rejects expired sessions and removes stale rows', async () => {
  const fake = createFakeFetch();
  const store = new SupabaseSessionStore({
    url: 'https://example.supabase.co',
    apiKey: 'server-only-test-key',
    fetch: fake.fetch
  });

  fake.rows.set('expired-session', {
    sid: 'expired-session',
    sess: makeSession('expired-user'),
    expire: new Date(Date.now() - 10000).toISOString()
  });

  assert.equal(await invoke(store, 'get', 'expired-session'), null);
  assert.equal(fake.rows.has('expired-session'), false);

  await invoke(store, 'set', 'already-expired', {
    cookie: { originalMaxAge: -1000, expires: new Date(Date.now() - 1000).toISOString() }
  });
  assert.equal(fake.rows.has('already-expired'), false);
});

test('does not expose PostgREST response bodies in errors', async () => {
  const store = new SupabaseSessionStore({
    url: 'https://example.supabase.co',
    apiKey: 'server-only-test-key',
    fetch: async () => createResponse(403, { message: 'sensitive database detail' })
  });

  await assert.rejects(
    invoke(store, 'get', 'session-1'),
    error => {
      assert.match(error.message, /403/);
      assert.doesNotMatch(error.message, /sensitive database detail/);
      return true;
    }
  );
});

test('requires HTTPS and a server-side key', () => {
  assert.throws(
    () => new SupabaseSessionStore({ url: 'http://example.supabase.co', apiKey: 'key', fetch: async () => createResponse(200, []) }),
    /HTTPS/
  );
  assert.throws(
    () => new SupabaseSessionStore({ url: 'https://example.supabase.co', fetch: async () => createResponse(200, []) }),
    /secret key/
  );
});
