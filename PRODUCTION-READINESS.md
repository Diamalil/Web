# FeeKu Production Readiness

Last reviewed: 23 November 2026

## Current disposition

**Not production-ready. Suitable for controlled prototype testing after local checks.**

The legacy SQLite business-data import is intentionally out of scope for this prototype. The live business database is Supabase PostgreSQL. Existing PostgreSQL prototype data must be preserved; do not truncate, reset, or restore an empty backup over it.

Current PostgreSQL prototype row counts observed during this review:

| Table | Rows |
|---|---:|
| categories | 3 |
| products | 4 |
| transactions | 2 |
| transaction_items | 4 |
| profits | 2 |
| activity_logs | 170 |

These counts describe the current project state only. They are not evidence that legacy SQLite data was imported.

## Security review

### Implemented and rechecked

- Row Level Security is enabled on the application tables.
- User data policies are scoped to `auth.uid()`; cross-user isolation tests were previously successful.
- Transaction and stock operations use controlled PostgreSQL RPCs.
- Supabase Auth access tokens are checked by the Express server; verified email and active account status are required.
- Role checks rely on server-controlled `app_metadata.role`.
- Express uses Helmet and a Content Security Policy, disables `X-Powered-By`, sets `Referrer-Policy: no-referrer`, and sends `Cache-Control: no-store`.
- Write APIs are rate limited and require a CSRF token.
- The `feeku.sid` cookie is `HttpOnly`, `SameSite=Lax`, and marked `Secure` in production.
- Admin routes are protected by role checks and an IP/CIDR allowlist.
- Client write permissions on `public.activity_logs` have been revoked. Standard users retain SELECT access to their own audit records; server-side `service_role` writes remain available. Verification confirmed INSERT/UPDATE/DELETE are false for `authenticated`, SELECT is true, and the existing 99 audit rows remain.
- The account restore endpoint now calls a service-role-only RPC after Express has validated the Supabase user session. The target user ID is taken from the verified server-side request identity, never from the submitted backup payload.
- The previous `public.restore_feeku_user_backup(jsonb)` function was removed. The replacement `public.restore_feeku_user_backup(uuid,jsonb)` is `SECURITY DEFINER`, has an empty `search_path`, checks the JWT role is `service_role`, and grants `EXECUTE` only to `service_role`. SQL privilege verification confirmed `anon=false`, `authenticated=false`, and `service_role=true`.

### Open security items

1. **Leaked Password Protection remains disabled due to the current plan.** The Supabase organization is on the Free plan. Supabase documents leaked-password protection as Pro+ and lists it as unavailable on Free. This cannot be enabled on the current plan. See https://supabase.com/docs/guides/auth/password-security and https://supabase.com/pricing. Minimum password length and character requirements can still be strengthened in Auth settings, but those controls do not clear this specific Advisor warning.
2. Four RLS-enabled tables in the `private` schema have no direct client policies. This is intentional because client roles have no direct schema/table access; continue to verify grants whenever migrations change.
3. The HTTP and browser testing described below is not a substitute for a professional penetration test or abuse review.

## Runtime and deployment

- Use Node.js 26 LTS for deployment. Node.js 20 reached end of life on 24 March 2026; Node 22 and 24 are Maintenance LTS, and Node 26 is Active LTS as of this review. See the official release schedule: https://github.com/nodejs/Release/blob/main/README.md
- `package.json` is configured for Node.js 22.9 or newer to exclude the EOL Node 20 line while remaining compatible with the locked native dependencies.
- Set `NODE_ENV=production`.
- Use HTTPS and a verified custom application domain.
- Set `SUPABASE_URL`, the publishable key, `SUPABASE_SECRET_KEY`, and a random `SESSION_SECRET` of at least 32 characters in the hosting provider's secret manager. Never place server secrets in frontend files or Git.
- Configure `TRUST_PROXY` only for the actual trusted reverse-proxy topology. Do not trust arbitrary forwarded headers.
- Set `ADMIN_ALLOWED_CIDRS` to the smallest network ranges required for administration. Do not use `0.0.0.0/0` or `::/0`.
- Confirm the host provides persistent writable storage for `SESSION_DATABASE_FILE`, or replace the SQLite session store with a shared durable store before running multiple instances or ephemeral/serverless instances.
- Review rate limiting for a multi-instance deployment; the default in-process limiter is not a shared rate limit.
- Confirm the hosting platform starts `node server.js` and forwards health checks to `/healthz`. Note that the current `/healthz` handler reports process/configuration flags only; it does not run a live PostgreSQL query. Add external monitoring or a separate readiness probe for actual Supabase/PostgreSQL connectivity before production.

## Dependency audit

**Resolved in PR #8 (merged to `main`).** The 7 findings originated from the obsolete `connect-sqlite3` dependency tree. FeeKu now uses a small local `express-session` store built on the existing `better-sqlite3` dependency. It retains the existing `sessions` table layout, avoiding deletion of stored sessions. The vulnerable nested `sqlite3@5.1.7`/`node-gyp@8.4.1` tree and 111 now-unreachable lockfile package entries were removed. CI run #8 on Node.js 26 completed `npm ci`, the blocking `npm audit --audit-level=low`, 3 session-store tests, syntax checks, and the HTTP smoke test successfully. `npm ci` reported 0 vulnerabilities and `npm audit` reported 0 vulnerabilities. The audit is now a required CI gate rather than informational.

## Supabase Auth and email

- Set the production Site URL to the real HTTPS application domain.
- Add only the required production and staging callback URLs to the redirect allowlist.
- Configure Google OAuth authorized redirect URIs and provider secrets in Supabase Dashboard if Google sign-in is enabled.
- Configure custom SMTP before public registration or recovery emails. Supabase's built-in sender is intended for development and has restrictions on recipients, throughput, and delivery guarantees. See https://supabase.com/docs/guides/auth/auth-smtp
- Configure SPF, DKIM, and DMARC for the sender domain.
- Verify email confirmation, password recovery, and Google OAuth redirects on the real domain.
- Add CAPTCHA/bot protection and adjust Auth rate limits before exposing public registration.

## Test and operations gate

- [ ] Run `npm ci` on the target Node.js runtime.
- [ ] Run `npm run check`.
- [ ] Run `npm start` and `npm run test:local` on the local machine.
- [x] Complete the browser test plan in `BROWSER-E2E.md` using dedicated test accounts (reported complete by the project owner).
- [ ] Validate email and Google OAuth flows on a staging domain.
- [ ] Verify user/admin authorization and IP allowlist behavior in staging.
- [ ] Verify JSON backup and restore using a disposable test account.
- [ ] Configure and test PostgreSQL backups and an actual restore procedure outside the application.
- [ ] Configure monitoring, error alerts, retention, and incident-response ownership.
- [x] Resolve dependency vulnerabilities and make `npm audit` a blocking CI check (PR #8; CI run #8: 0 vulnerabilities).
- [x] Remove authenticated-client execution of the privileged restore RPC; verify grants and re-run Security Advisor (PR #8 and migration `20261123025556`).
- [ ] Upgrade the Supabase organization from Free to Pro+ and enable Leaked Password Protection; it is not available on the current plan.
- [ ] Re-run Supabase Performance and Health Advisors after the next release configuration/schema changes.
- [ ] Re-test backup/restore through the updated server-only service-role path with a disposable account.

## Browser E2E status

The project owner has confirmed that the browser E2E checklist is complete. The GitHub CI job remains separate: it uses placeholder Supabase settings and validates dependency installation/audit, the SQLite session-store adapter, JavaScript syntax, and Express HTTP smoke behavior. It does not exercise live Supabase Auth or the browser UI. Because PR #8 changed the session adapter and backup restore path, perform a focused post-merge regression of login/session continuity and backup/restore with a disposable account before the next public release.
