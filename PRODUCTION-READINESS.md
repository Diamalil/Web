# FeeKu Production Readiness

Last reviewed: 23 November 2026

## Current disposition

**Not production-ready. Suitable for controlled prototype testing after local checks.**

The legacy SQLite business-data import is intentionally out of scope for this prototype. The live business database is Supabase PostgreSQL. Existing PostgreSQL prototype data must be preserved; do not truncate, reset, or restore an empty backup over it.

Current PostgreSQL prototype row counts observed during this review:

| Table | Rows |
|---|---:|
| categories | 1 |
| products | 2 |
| transactions | 1 |
| transaction_items | 2 |
| profits | 1 |
| activity_logs | 99 |

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
- The restore RPC was invoked under an authenticated test role using an empty payload inside a transaction that was rolled back. It returned successfully and no rows changed.

### Open security items

1. **Leaked Password Protection is disabled.** Enable it in Supabase Auth password security settings if the project's plan supports it. Supabase documentation says this feature is available on Pro Plan and above: https://supabase.com/docs/guides/auth/password-security
2. **Restore RPC remains a Security Advisor warning.** `public.restore_feeku_user_backup(p_data)` is `SECURITY DEFINER` and callable by `authenticated`. The wrapper checks `auth.uid()`, checks the authenticated role, uses an empty search path, and passes the caller's own UID to a private helper. The private helper is not executable by client roles. This is an intentional design for per-user restore, but it must receive a dedicated security review and adversarial tests before public release. Do not change it to `SECURITY INVOKER` without redesigning the private helper boundary.
3. Four RLS-enabled tables in the `private` schema have no direct client policies. This is intentional because client roles have no direct schema/table access; continue to verify grants whenever migrations change.
4. The HTTP and browser testing described below is not a substitute for a professional penetration test or abuse review.

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

The CI dependency audit currently reports 7 transitive npm vulnerabilities: 2 low, 4 high, and 1 critical. The affected packages reported by npm are `@tootallnate/once`, `cacache`, `http-proxy-agent`, `make-fetch-happen`, `node-gyp`, `sqlite3`, and `tar`. The `tar` finding includes critical archive path traversal/file overwrite advisories. The audit report marked fixes as available, but the lockfile has not yet been updated or re-tested. Treat high/critical findings as a hard production blocker. Review the dependency paths and update the lockfile without force-upgrading native dependencies blindly.

CI run #2 completed successfully on Node.js 26: locked install, JavaScript syntax checks, and the HTTP smoke test all passed. npm audit is currently informational/non-blocking in the workflow so the full test job can still execute; that does not imply the dependency tree is clear.

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
- [ ] Complete the browser test plan in `BROWSER-E2E.md` using dedicated test accounts.
- [ ] Validate email and Google OAuth flows on a staging domain.
- [ ] Verify user/admin authorization and IP allowlist behavior in staging.
- [ ] Verify JSON backup and restore using a disposable test account.
- [ ] Configure and test PostgreSQL backups and an actual restore procedure outside the application.
- [ ] Configure monitoring, error alerts, retention, and incident-response ownership.
- [ ] Resolve the 4 high and 1 critical npm audit findings, update `package-lock.json`, then re-run `npm ci`, `npm audit`, and CI. Do not use `npm audit fix --force` without reviewing native dependency compatibility.
- [ ] Re-run Supabase Security, Performance, and Health Advisors after final config and schema changes.
- [ ] Review the remaining restore SECURITY DEFINER warning and either document formal acceptance or redesign it.
- [ ] Enable leaked-password protection where available.

## Browser E2E limitation for this review

No FeeKu server process or known public deployment URL was available to the review environment. A remote browser cannot exercise a developer's private `localhost` process. Therefore no browser-driven login or UI workflow is claimed as passed. The current `npm run test:local` test is an HTTP smoke test, not a browser E2E test. The planned CI job uses placeholder Supabase configuration and validates Express HTTP behavior only; it does not test real Auth, database connectivity, or UI flows. The CI workflow added in this branch runs syntax checks and the HTTP smoke test; the browser checklist must still be run from a local browser or against a staging URL.
