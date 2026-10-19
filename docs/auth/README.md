# Authentication and session architecture

Status: implemented in Phase 03 (13 Oct 2026), not deployed. Decisions: [ADR 0026](../adr/0026-portal-sessions-bff-cookies.md) (portals), [ADR 0005](../adr/0005-tenancy-shared-schema-rls-defense-in-depth.md) (database context), [ADR 0025](../adr/0025-two-person-change-control.md) (administration). Specification: [`../specs/03-application-foundation.md`](../specs/03-application-foundation.md).

## 1. Who signs in how

| Person                         | Method                                                                                              | Where it is handled                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Udofin staff, lender staff     | Email + password, then authenticator-app (TOTP) code. Accounts exist by invitation only (ADR 0025). | Supabase Auth, called by each portal's server (backend-for-frontend)         |
| Borrowers                      | Mobile number + SMS code. No password.                                                              | Supabase Auth, called by the mobile app. SMS delivery needs Phase 05 set-up. |
| Lenders' systems, Finbyx, etc. | Not in this phase (API keys / mTLS are planned).                                                    | —                                                                            |

## 2. The one rule: the database decides who someone is

The access token proves **identity and assurance level only** (`sub`, `aal`). It carries no roles, no tenant, no permissions. On every request the API:

1. verifies the token (`jose`, asymmetric keys from the project's JWKS, issuer, audience, expiry, algorithm allow-list; `alg:none` and shared-secret tokens are refused);
2. applies the per-principal rate limit to the verified user id (`docs/api/README.md` section 9);
3. opens a transaction as the database role `authenticated` with those claims (`withUserContext`), so row-level security applies to the API too;
4. asks the database, in **one query**, `private.session_is_active(session_id)` (does the session behind this token still exist and is it inside its time-box?) and `private.current_actor()` (borrower / lender / platform / none); a dead session is refused with `401 session_revoked`; for staff it also requires `aal2` (second factor done);
5. runs the handler. Memberships, roles and permissions are read inside that transaction.

A suspended or revoked member therefore loses access on the **next request**, and so does a signed-out or revoked session.

### 2.1 Session revocation (audit F-01, implemented 14 October 2026)

- **What is checked.** Every authenticated route (staff, borrower and step-up routes alike; the check lives in `runAsUser`) looks the token's `session_id` up in Supabase Auth's own `auth.sessions` table through a `SECURITY DEFINER` function (`private.session_is_active`, empty `search_path`, executable by `authenticated` only). It asks only about the caller's own session (`auth.uid()`), so it cannot be used to probe someone else's. It is one primary-key lookup, inside the transaction the request already opens, and nothing is cached: a session that ends is refused on the very next request.
- **Residual window.** Only a request that is **already in flight** when the session ends can still complete, because its check happened before the sign-out committed. There is no remaining "valid until the token expires" window. Access tokens still expire on their own (Supabase `jwt_expiry`; the hosted value is unverified), which no longer matters for revocation.
- **Tokens without a `session_id`.** Supabase Auth always issues the claim. When `APP_ENV` is `staging` or `production` a token without it is refused with `401 token_invalid` (it could not be checked). In `local` and `test` it is accepted so the fake verifiers used by tests keep working. This is a deliberate, tested rule (`sessionIdRequired` in `services/api/src/config.ts`, wired in `server.ts`). A `session_id` that is not a UUID is an invalid token in every environment.
- **Failure mode.** If the database is unavailable the request fails (it cannot be authenticated anyway). There is no fail-open path.
- **Not verified here.** The session table's shape and the privileges of the migration role on the hosted Supabase project (`auth.sessions.not_after` and read access for the function owner); the local shim `scripts/db/local-supabase-shim.sql` emulates them. Check once on the hosted project before staging: sign a test user in, call the API, sign out, call again and expect `401 session_revoked`.
- **Clients.** A `401` makes the mobile app try one forced refresh; the refresh token of a revoked session is rejected, so the user is signed out with the normal explanation. The portals' backend-for-frontend treats any `401` from `/v1/me` as signed out.

## 3. Staff portals (ops and lender)

```
Browser ──(same origin only)──► Portal server (Next.js) ──► Supabase Auth (password, TOTP)
                                      │
                                      └──────────────────► Udofin API (Bearer token read from the cookie)
```

- `POST /auth/sign-in` → password check → returns what to do next (`mfa_enrol`, `mfa_verify`, `done`) and sets two cookies.
- `POST /auth/mfa/enrol` (first time) shows a QR code and manual key; `POST /auth/mfa/verify` checks the 6-digit code, upgrades the session to `aal2`, and then asks the API who the user is. A lender account in the operations portal (or the reverse) is refused and the session ended.
- `POST /auth/sign-out` revokes the session at Supabase (it first refreshes an expired access token so the revocation is accepted) and clears the cookies even if Supabase cannot be reached.
- `proxy.ts` refreshes a token that is within 60 seconds of expiry (refresh tokens rotate, so exactly one place refreshes). If the refresh token is rejected the cookies are cleared and the user sees the sign-in page.
- Pages render only after the API has said who the user is. Navigation is built from the permissions the API returns, but every page and API call is authorised again server-side; hiding a link is cosmetic.

Cookie properties: `HttpOnly`, `SameSite=Strict`, `Secure` and `__Host-` prefixed (origin-locked) on https, session lifetime (cleared when the browser closes). The Supabase session time-box (24 h) and inactivity timeout (8 h) are in `supabase/config.toml` and need the Pro plan.

Abuse controls: same-origin and JSON-only checks on every POST; limits per address, per address and account, and a loose account-wide ceiling. The client address is read from `X-Forwarded-For` counting from the **right** by `TRUSTED_PROXY_HOPS` (forged left-hand entries are ignored; production requires at least one trusted proxy, otherwise all visitors would share one bucket); the in-memory limiter is size-bounded; one generic "email or password is not correct" for unknown users and wrong passwords; no raw upstream errors; Supabase's own rate limits behind all of it.

**When the client address cannot be determined** (no trusted proxy configured, or the forwarded header is missing or malformed behind one; audit F-05, changed 14 October 2026): requests no longer share an `unknown` address bucket, which would let one attacker lock every staff member out of sign-in for 15 minutes. Instead there is **no per-address bucket** for such requests; the per-account ceiling (60 per 15 minutes) still applies, plus a short global ceiling for unaddressed sign-ins (120 per minute, recovering within one minute) and, for second-factor attempts, a limit per exact token (the user id in the cookie is not trusted for this, otherwise a forged cookie could lock a real user out) plus a short global ceiling. Trade-off: with no address, guessing against one account is bounded by the account ceiling and Supabase's own limits, not by a tighter per-address-and-account bucket. The portal logs a start-up warning when `TRUSTED_PROXY_HOPS=0` and a one-time warning if a request has no usable address behind a configured proxy, which means the proxy chain is not what the setting says.

**The portal limiter is per process and needs a single instance.** Its counters are in memory, so each portal instance counts alone: with N instances every limit is effectively N times larger, and a client can be retried against another instance. Run exactly one instance of each portal until a shared store is approved (a decision for the owner; Supabase Auth's limits remain the authoritative control). The portal logs this at start-up.

## 4. Mobile app

- Session in the platform keystore through `expo-secure-store` (Android Keystore / iOS Keychain), accessible only while the device is unlocked and never migrated to another device; stored in chunks to stay under the per-value size limit.
- `SessionManager` restores the session at start, refreshes it when it is within 60 seconds of expiry (one refresh at a time), refreshes when the app returns to the foreground, and ends the session as _expired_ when the server rejects the refresh token. A temporary network failure keeps the session.
- A 401 from the API on a token the app believed valid triggers one forced refresh and a retry; if that fails the user is signed out with a plain explanation.
- The phone-number and code screens block screenshots and screen recording; on Android this (`FLAG_SECURE`) also hides the recent-apps preview. **iOS** does not hide the app-switcher snapshot this way (an inactive-state cover is not built yet). The unused `DETECT_SCREEN_CAPTURE` permission that library adds is stripped. The phone number is held in `OtpFlow`, never in a route parameter or URL.
- Only public values are in the bundle (API address, Supabase URL, publishable key). A privileged key makes the app refuse to start (`parseMobileConfig`).

## 5. Configuration

See `apps/ops-portal/.env.example`, `apps/lender-portal/.env.example`, `apps/mobile/.env.example`, `services/api/.env.example`. All portal values are server-only (no `NEXT_PUBLIC_`). Missing or unsafe values stop the server at start-up; messages name the variable and never its value.

## 6. Limitations

See section 6 of the Phase 03 specification. Notably: in-memory portal rate limiters are per process (single portal instance only, section 3); real SMS needs Phase 05; the GoTrue endpoint details are unverified against a live project; the mobile screens have not been run on a device here.
