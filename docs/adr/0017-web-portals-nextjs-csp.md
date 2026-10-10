# ADR-0017: Web portals — two Next.js apps with a strict, nonce-based CSP

- **Status:** Accepted (baseline, pending owner approval) — foundation pages only; authentication is planned
- **Date:** 2026-10-10
- **Related:** ADR-0004, ADR-0006, ADR-0010, ADR-0021

## Context

- Two staff audiences need web tools: Udofin operations and platform administration (lender onboarding, exceptions, support, reconciliation, configuration), and partner-lender staff (products, applications, decisions, loans, audit).
- These portals show borrower and lender data. Cross-site scripting or a malicious third-party script would expose it.
- Lender staff and Udofin staff must not share an attack surface or a navigation model that could expose platform functions to lenders.
- Lenders will review security headers and third-party scripts as part of IT due diligence (research: flow-down of lender IT and cyber directions, likely).

## Decision

1. **Two separate Next.js 16.4 applications** (React 19.2.3): `apps/ops-portal` and `apps/lender-portal`, built and deployed separately (`output: 'standalone'`).
2. **Per-request nonce CSP** in `proxy.ts` (identical in both apps):
   `default-src 'self'`; `script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in development only); `style-src 'self' 'nonce-…'`; `img-src 'self' blob: data:`; `font-src 'self'`; `connect-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests`.
3. **Security headers** for every path (`next.config.ts`): HSTS one year with subdomains; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `X-Frame-Options: DENY`; `Cross-Origin-Opener-Policy: same-origin`; `Permissions-Policy` disabling camera, microphone, geolocation, payment, USB and interest-cohort; no `X-Powered-By`.
4. **No inline styles:** design tokens are served as same-origin `/theme.css` (ADR-0021).
5. **Not indexed:** `robots: { index: false, follow: false }` on both portals.
6. **No third-party scripts, fonts or analytics.** Fonts must be self-hosted.
7. **Data access only through the Udofin API** (ADR-0004). Portals never query domain tables.
8. **Authentication and authorisation** will start in `proxy.ts` (Phase 3), backed by the API: staff email with MFA, later SAML SSO (per-lender identity providers for the lender portal is a research suggestion). Every page and action is checked server-side against permissions (ADR-0006).
9. A borrower web experience (servicing and disclosures) is a later, separate app. It counts as a DLA that lenders must report (research: confirmed (secondary)).

## Alternatives considered

| Option                                                     | Why rejected                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| One portal with role-based sections                        | Larger blast radius; platform-only functions shipped to lender users' browsers; harder to reason about audiences. |
| Single-page app served as static files with a separate API | Loses server-side checks before rendering and server-generated nonces; tokens more exposed in the browser.        |
| Hash-based CSP or `'unsafe-inline'`                        | Hashes are brittle with framework-injected scripts; `'unsafe-inline'` defeats the purpose.                        |
| Third-party analytics or session replay                    | Sends staff and borrower data to external, often offshore, services (ADR-0010).                                   |

## Consequences

**Positive**

- Injected or third-party scripts cannot run; the portals cannot be framed.
- Each portal can be deployed, scaled and access-restricted on its own.

**Negative**

- A fresh nonce per request means pages are rendered per request rather than served as cached static HTML; more server work.
- Two apps duplicate some layout and configuration (`proxy.ts` and `next.config.ts` are copies and must be kept in step).
- Any new external origin (API, Supabase Auth, storage) requires a deliberate CSP change.

**Risks and known gaps (baseline)**

- **`connect-src 'self'` conflicts with the example configuration**: `.env.example` defines `NEXT_PUBLIC_API_BASE_URL` (a different origin) and `NEXT_PUBLIC_SUPABASE_URL`. Browser calls to those origins would be blocked. Decide either (a) all browser calls go to same-origin route handlers that call the API server-side, or (b) add the exact API and auth origins to `connect-src`. Option (a) keeps tokens out of browser JavaScript and is preferred, but is not yet decided.
- `/theme.css` is excluded from the proxy matcher and served with `cache-control: public, max-age=300`; once lender branding is served there it must not leak one lender's theme to another through shared caches.
- No automated test checks the portal headers yet.

## Compliance and security notes

- These are security controls expected in lender due diligence, not regulatory requirements in themselves. Evidence: header scan reports per release (planned).
- Ops portal access to lender data must be audited (ADR-0013).

## Verification

- Code review of `apps/ops-portal/proxy.ts`, `apps/lender-portal/proxy.ts` and both `next.config.ts` files.
- Planned: an automated test that requests representative pages and asserts the CSP (nonce present, no `unsafe-inline`, no `unsafe-eval` in production), the security headers and `noindex`; a check that the two `proxy.ts` files stay identical or share one module.

## Revisit triggers

- Authentication is implemented (Phase 3) and the API-call pattern is chosen.
- A need for any third-party script or font.
- The borrower web app is started.
