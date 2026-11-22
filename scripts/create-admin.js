'use strict';
require('dotenv').config();

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const REVOKE = process.argv[2] === '--revoke';
const email = String(process.argv[REVOKE ? 3 : 2] || '').trim().toLowerCase();
const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');

if (!/^https:\/\/[a-z0-9.-]+$/i.test(SUPABASE_URL)) {
  console.error('SUPABASE_URL wajib diisi dengan URL project Supabase HTTPS.');
  process.exit(1);
}
if (!SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_SECRET_KEY wajib diisi. Jangan gunakan publishable/anon key untuk provisioning admin.');
  process.exit(1);
}
if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
  console.error(REVOKE
    ? 'Pemakaian: npm run revoke-admin -- admin@domain.com'
    : 'Pemakaian: ADMIN_BOOTSTRAP_PASSWORD="password-kuat" npm run create-admin -- admin@domain.com');
  process.exit(1);
}
if (!REVOKE && password.length < 12) {
  console.error('ADMIN_BOOTSTRAP_PASSWORD wajib minimal 12 karakter.');
  process.exit(1);
}

async function request(path, method = 'GET', body) {
  const response = await fetch(\`\${SUPABASE_URL}\${path}\`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: \`Bearer \${SUPABASE_SECRET_KEY}\`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.msg || payload.message || payload.error_description || payload.error || \`HTTP \${response.status}\`;
    throw new Error(String(message));
  }
  return payload;
}

async function findUserByEmail(targetEmail) {
  const perPage = 100;
  for (let page = 1; page <= 100; page += 1) {
    const result = await request(\`/auth/v1/admin/users?page=\${page}&per_page=\${perPage}\`);
    const users = Array.isArray(result.users) ? result.users : [];
    const found = users.find(user => String(user.email || '').toLowerCase() === targetEmail);
    if (found) return found;
    if (users.length < perPage) return null;
  }
  throw new Error('Pencarian akun melewati batas halaman. Periksa daftar pengguna di Supabase Dashboard.');
}

async function main() {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error(\`Akun Supabase Auth dengan email \${email} belum ada. Daftar sebagai pengguna biasa, verifikasi email, lalu jalankan provisioning admin.\`);
  }

  const existingMetadata = user.app_metadata && typeof user.app_metadata === 'object' ? user.app_metadata : {};
  if (REVOKE) {
    await request(\`/auth/v1/admin/users/\${encodeURIComponent(user.id)}\`, 'PUT', {
      app_metadata: { ...existingMetadata, role: 'user' }
    });
    await request('/rest/v1/rpc/revoke_feeku_admin', 'POST', { target_user_id: user.id });
    console.log(\`Role administrator dicabut dari \${email}. Pengguna perlu login ulang untuk memperbarui sesi.\`);
    return;
  }

  if (!(user.email_confirmed_at || user.confirmed_at)) {
    throw new Error('Email akun harus diverifikasi sebelum diberikan role administrator.');
  }

  // Store the protected role first, then mirror it to server-managed JWT metadata.
  await request('/rest/v1/rpc/provision_feeku_admin', 'POST', {
    target_user_id: user.id,
    grantor_user_id: null
  });
  await request(\`/auth/v1/admin/users/\${encodeURIComponent(user.id)}\`, 'PUT', {
    app_metadata: { ...existingMetadata, role: 'admin' }
  });
  console.log(\`Role administrator berhasil diberikan kepada \${email}. Silakan login ulang.\`);
}

main().catch(error => {
  console.error('Provisioning admin gagal:', error.message);
  process.exitCode = 1;
});
