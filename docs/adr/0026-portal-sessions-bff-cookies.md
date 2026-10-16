# ADR-0026: Portal sessions through a backend-for-frontend with HttpOnly cookies

- **Status:** Accepted (13 October 2026, with the Phase 03 implementation). The vendor-API details it relies on are unverified against a live Supabase project (see Verification).
- **Date:** 2026-10-13
- **Related:** ADR-0005, ADR-0017 (portal CSP), ADR-0025; `docs/auth/README.md`

## Context

Two staff portals (operations and partner-lender) sign people in with Supabase Auth (email, password, TOTP). They must resist token theft, CSRF and account abuse, keep the strict CSP (`connect-src 'self'`), and never hold privileged keys. The roadmap named email + second factor and role-aware navigation, nothing about where tokens live.

## Decision

1. **The browser only ever talks to its own portal origin.** Each portal exposes `/auth/sign-in`, `/auth/mfa/enrol`, `/auth/mfa/verify`, `/auth/sign-out`; the portal's server calls Supabase Auth and the Udofin API.
2. **Tokens live only in HttpOnly, SameSite=Strict, `__Host-`-prefixed, Secure session cookies** set by those endpoints. Page scripts, local storage and the page source never contain a token.
3. **A small typed client calls the Supabase Auth REST API** with the publishable key. No Supabase SDK in the portals. Privileged keys (`sb_secret_…`, `service_role`) are refused at start-up.
4. **`proxy.ts` refreshes** tokens near expiry (one place, because refresh tokens rotate) and clears the session when the refresh token is rejected. It decides nothing about access.
5. **The API is the only authority.** Pages render after the API says who the user is (`GET /v1/me`); an account of the wrong kind for the portal is signed out; navigation is cosmetic.
6. **Abuse controls** in the BFF: same-origin + JSON-only on POST, limits per address / address+account / account, one generic credential error, upstream errors reduced to stable codes.

## Alternatives considered

| Option                                       | Why rejected                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supabase JS in the browser, token in storage | Any XSS reads the token; needs `connect-src` to the Supabase origin; widens the CSP.                                                                                                                               |
| `@supabase/ssr` cookie helpers               | A reasonable alternative; not chosen because the project's cookie/refresh behaviour could not be verified here and a 150-line owned module is easier to test and review. Revisit if Supabase changes the REST API. |
| API-hosted sessions (API sets the cookie)    | Couples sign-in to the API deployment and CORS-with-credentials; the API stays token-in-header for all clients.                                                                                                    |
| Long-lived sessions                          | Session cookies plus Supabase time-box (24 h) and inactivity (8 h) fit regulated staff access better.                                                                                                              |

## Consequences

**Positive** — tokens are unreadable by scripts; the CSP stays strict; one tested implementation serves both portals.
**Negative** — each portal runs a few server endpoints; rate limiters in the portals are per process (documented); we own the REST client and must track Supabase changes.
**Risks** — the auth server's endpoint behaviour is assumed from knowledge, not verified; mitigated by tests with fakes and the verification list in the Phase 03 spec.

## Verification

`packages/auth-client/test` (59 tests), `packages/portal-kit/test` (10), `tests/e2e` (10 real-browser tests: cookie flags, no token in storage or source, refresh, revoked refresh, sign-out, wrong portal, CSRF).

## Revisit triggers

Moving to several portal instances (shared rate-limit store); adopting SSO; a Supabase change to the Auth REST API; a lender requiring device-bound sessions.
