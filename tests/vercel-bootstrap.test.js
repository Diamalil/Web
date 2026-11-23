'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

function createResponse(status, payload = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return payload === null ? '' : JSON.stringify(payload);
    }
  };
}

test('Vercel bootstrap exports Express and persists the CSRF session through Supabase REST', async t => {
  const envKeys = [
    'VERCEL',
    'NODE_ENV',
    'SESSION_STORE',
    'SESSION_SECRET',
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY'
  ];
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'vercel-test-session-secret-with-more-than-32-characters';
  process.env.SUPABASE_URL = 'https://ci-placeholder.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ci_placeholder';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_ci_placeholder';

  const sessions = new Map();
  const originalFetch = global.fetch;
  global.fetch = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    assert.match(url.pathname, /\/rest\/v1\/feeku_server_sessions$/);
    const method = String(options.method || 'GET').toUpperCase();
    const params = url.searchParams;
    const sidFilter = params.get('sid');
    const sid = sidFilter && sidFilter.startsWith('eq.') ? sidFilter.slice(3) : null;

    if (method === 'POST') {
      const row = JSON.parse(options.body);
      sessions.set(row.sid, row);
      return createResponse(201);
    }
    if (method === 'GET') {
      return createResponse(200, sid && sessions.has(sid) ? [sessions.get(sid)] : []);
    }
    if (method === 'PATCH') {
      const row = sid ? sessions.get(sid) : null;
      if (row) Object.assign(row, JSON.parse(options.body));
      return createResponse(204);
    }
    if (method === 'DELETE') {
      if (sid) sessions.delete(sid);
      return createResponse(204);
    }
    return createResponse(405);
  };

  const modulePath = require.resolve('../server');
  delete require.cache[modulePath];
  let server;

  t.after(async () => {
    if (server && server.listening) {
      await new Promise(resolve => server.close(resolve));
    }
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const app = require('../server');
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;

  function request(pathname, cookie) {
    return new Promise((resolve, reject) => {
      const request = http.request(baseUrl + pathname, {
        method: 'GET',
        headers: {
          'x-forwarded-proto': 'https',
          ...(cookie ? { Cookie: cookie } : {})
        }
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = body ? JSON.parse(body) : null; } catch (_) {}
          resolve({ status: response.statusCode, headers: response.headers, json });
        });
      });
      request.on('error', reject);
      request.end();
    });
  }

  const first = await request('/api/auth/csrf');
  assert.equal(first.status, 200);
  assert.equal(typeof first.json.csrfToken, 'string');
  assert.ok(first.json.csrfToken.length >= 32);
  assert.ok(first.headers['set-cookie'], 'Secure session cookie must be set behind the trusted Vercel proxy');

  const cookie = first.headers['set-cookie'][0].split(';')[0];
  const second = await request('/api/auth/csrf', cookie);
  assert.equal(second.status, 200);
  assert.equal(second.json.csrfToken, first.json.csrfToken);
  assert.equal(sessions.size, 1);
});
