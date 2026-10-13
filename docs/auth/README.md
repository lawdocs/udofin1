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
2. opens a transaction as the database role `authenticated` with those claims (`withUserContext`), so row-level security applies to the API too;
3. asks the database `private.current_actor()` (borrower / lender / platform / none) and, for staff, requires `aal2` (second factor done);
4. runs the handler. Memberships, roles and permissions are read inside that transaction.

A suspended or revoked member therefore loses access on the **next request**. Note the limit: the API verifies the token's signature and expiry but does not look the session up, so a token that was signed out or copied stays valid until it expires (15 minutes). Refresh tokens are revoked at sign-out. A tenant id or role sent by a client is never trusted.

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

## 4. Mobile app

- Session in the platform keystore through `expo-secure-store` (Android Keystore / iOS Keychain), accessible only while the device is unlocked and never migrated to another device; stored in chunks to stay under the per-value size limit.
- `SessionManager` restores the session at start, refreshes it when it is within 60 seconds of expiry (one refresh at a time), refreshes when the app returns to the foreground, and ends the session as _expired_ when the server rejects the refresh token. A temporary network failure keeps the session.
- A 401 from the API on a token the app believed valid triggers one forced refresh and a retry; if that fails the user is signed out with a plain explanation.
- The phone-number and code screens block screenshots and screen recording; on Android this (`FLAG_SECURE`) also hides the recent-apps preview. **iOS** does not hide the app-switcher snapshot this way (an inactive-state cover is not built yet). The unused `DETECT_SCREEN_CAPTURE` permission that library adds is stripped. The phone number is held in `OtpFlow`, never in a route parameter or URL.
- Only public values are in the bundle (API address, Supabase URL, publishable key). A privileged key makes the app refuse to start (`parseMobileConfig`).

## 5. Configuration

See `apps/ops-portal/.env.example`, `apps/lender-portal/.env.example`, `apps/mobile/.env.example`, `services/api/.env.example`. All portal values are server-only (no `NEXT_PUBLIC_`). Missing or unsafe values stop the server at start-up; messages name the variable and never its value.

## 6. Limitations

See section 6 of the Phase 03 specification. Notably: in-memory portal rate limiters are per process; real SMS needs Phase 05; the GoTrue endpoint details are unverified against a live project; the mobile screens have not been run on a device here.
