'use strict';

const baseUrl = String(process.argv[2] || process.env.FEEKU_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

const checks = [];
const warnings = [];

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    signal: AbortSignal.timeout(8000)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { response, text, json };
}

function pass(name, detail = '') {
  checks.push({ name, ok: true, detail });
}

function fail(name, detail = '') {
  checks.push({ name, ok: false, detail });
}

async function run() {
  console.log('FeeKu local smoke test');
  console.log('Target: ' + baseUrl);
  console.log('');

  let page;
  try {
    page = await request('/');
    if (page.response.status === 200 && /text\/html/i.test(page.response.headers.get('content-type') || '') && page.text.includes('id="app"')) {
      pass('Website shell', 'HTTP 200');
    } else {
      fail('Website shell', 'Expected HTTP 200 with the FeeKu HTML shell; received ' + page.response.status);
    }
  } catch (error) {
    fail('Website shell', error.message);
    printResults();
    process.exitCode = 1;
    return;
  }

  for (const asset of ['/app.js', '/styles.css']) {
    try {
      const result = await request(asset);
      if (result.response.status === 200 && result.text.length > 100) {
        pass('Static asset ' + asset, 'HTTP 200');
      } else {
        fail('Static asset ' + asset, 'HTTP ' + result.response.status);
      }
    } catch (error) {
      fail('Static asset ' + asset, error.message);
    }
  }

  try {
    const result = await request('/healthz');
    if (result.response.ok && result.json && result.json.ok === true && result.json.businessDatabase === 'postgresql') {
      pass('Health check', 'PostgreSQL selected');
      if (!result.json.authConfigured) warnings.push('SUPABASE_URL atau Supabase publishable/anon key belum tersedia pada server.');
      if (!result.json.adminOperationsConfigured) warnings.push('SUPABASE_SECRET_KEY belum tersedia; operasi administratif server dan import belum siap.');
    } else {
      fail('Health check', 'Unexpected response: HTTP ' + result.response.status);
    }
  } catch (error) {
    fail('Health check', error.message);
  }

  try {
    const result = await request('/api/auth/config');
    if (result.response.ok && result.json && result.json.supabaseUrl && result.json.publishableKey) {
      pass('Supabase Auth configuration', 'URL and public key available (values hidden)');
      if (result.json.googleEnabled) pass('Google OAuth flag', 'Enabled');
      else warnings.push('Google OAuth flag is OFF. Set ENABLE_GOOGLE_OAUTH=true after checking the Supabase Google provider.');
    } else {
      fail('Supabase Auth configuration', 'HTTP ' + result.response.status + ': ' + ((result.json && result.json.error) || 'invalid response'));
    }
  } catch (error) {
    fail('Supabase Auth configuration', error.message);
  }

  try {
    const result = await request('/api/auth/csrf');
    if (result.response.ok && result.json && typeof result.json.csrfToken === 'string' && result.json.csrfToken.length >= 32) {
      pass('CSRF bootstrap', 'Token issued');
    } else {
      fail('CSRF bootstrap', 'HTTP ' + result.response.status);
    }
  } catch (error) {
    fail('CSRF bootstrap', error.message);
  }

  try {
    const result = await request('/api/auth/me');
    if (result.response.ok && result.json && result.json.user === null) {
      pass('Unauthenticated identity check', 'No user session returned');
    } else {
      fail('Unauthenticated identity check', 'Expected user=null; HTTP ' + result.response.status);
    }
  } catch (error) {
    fail('Unauthenticated identity check', error.message);
  }

  for (const route of ['/api/dashboard', '/api/admin/overview']) {
    try {
      const result = await request(route);
      if (result.response.status === 401) {
        pass('Protected route ' + route, 'Unauthenticated request rejected');
      } else {
        fail('Protected route ' + route, 'Expected HTTP 401; received HTTP ' + result.response.status);
      }
    } catch (error) {
      fail('Protected route ' + route, error.message);
    }
  }

  try {
    const result = await request('/admin/login', { redirect: 'manual' });
    const location = result.response.headers.get('location') || '';
    if (result.response.status === 308 && location === '/') {
      pass('Legacy admin login redirect', 'Redirects to the single login page');
    } else {
      fail('Legacy admin login redirect', 'Expected HTTP 308 to /; received HTTP ' + result.response.status + ' (' + location + ')');
    }
  } catch (error) {
    fail('Legacy admin login redirect', error.message);
  }

  printResults();
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}

function printResults() {
  for (const check of checks) {
    console.log((check.ok ? 'PASS ' : 'FAIL ') + check.name + (check.detail ? ' — ' + check.detail : ''));
  }
  for (const warning of warnings) console.log('WARN ' + warning);
  console.log('');
  const passed = checks.filter(check => check.ok).length;
  const failed = checks.length - passed;
  console.log('Summary: ' + passed + ' passed, ' + failed + ' failed, ' + warnings.length + ' warning(s).');
}

run().catch(error => {
  console.error('Smoke test failed:', error.message);
  process.exitCode = 1;
});
