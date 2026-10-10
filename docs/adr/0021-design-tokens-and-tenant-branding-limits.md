# ADR-0021: Design tokens and limits on lender branding

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0016, ADR-0017, ADR-0022

## Context

- The borrower app (React Native) and the two portals (Next.js) should look and behave consistently and be re-skinnable without code changes.
- Partner lenders will want their brand on offers, journeys and the lender portal.
- Colours carry meaning in a lending app: warnings, overdue amounts, errors and disclosures must stay legible and recognisable. A lender's brand colour must not make a button unreadable or disguise a warning.
- From 1 Jan 2027 the RBC (Second Amendment) Directions ban dark patterns and require user testing and audit of interfaces for lenders and their channels (research: confirmed (secondary), `docs/research/2026-10-10/rbi-digital-lending.md` DL-30). Multi-lender displays must not steer borrowers (ADR-0022).

## Decision

1. **Semantic tokens** in `packages/design-tokens` shared by all apps: colours (`primary`, `onPrimary`, `accent`, `background`, `surface`, `surfaceMuted`, `border`, `text`, `textMuted`, `success`, `warning`, `danger`, `info`, `focusRing`), typography (including Noto Sans and Noto Sans Devanagari in the font stack), spacing, radius and a minimum touch target (WCAG 2.2 target size). Screens use token names, never raw colour values.
2. **Light and dark themes** are defined by the platform.
3. **Lender branding is limited to `primary`, `onPrimary` and `accent`** (plus a display name). Text, surfaces and the status colours `success`, `warning`, `danger`, `info` are locked.
4. **Contrast is enforced, not auto-corrected:** `applyTenantBranding` rejects unknown keys, malformed colours, `onPrimary` on `primary` below 4.5:1 (WCAG AA text) and `primary` on `background` below 3:1 (WCAG AA UI components). A rejected theme is an error to fix, not a silent adjustment.
5. **Web delivery:** tokens become CSS custom properties (`toCssVariables`) served as same-origin `/theme.css`, so the strict CSP needs no inline styles (ADR-0017). Lender-specific themes will be layered on in Phase 4.
6. **Branding never removes disclosures.** Lender names, APR, KFS links, grievance information and Udofin's role as LSP are rendered by platform components that branding cannot hide or restyle beyond the allowed colours.

## Alternatives considered

| Option                                                | Why rejected                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Full white-label theming (any colour, font or layout) | Lenders could make warnings or disclosures illegible or misleading; harder to test accessibility; risk of dark patterns. |
| No lender branding                                    | Lenders expect brand presence; a clear, limited scope is a better compromise.                                            |
| Automatically adjust colours to meet contrast         | Silently changes a lender's brand; better to reject and agree a compliant palette.                                       |
| Separate token sets for mobile and web                | Drift between channels.                                                                                                  |

## Consequences

**Positive**

- Accessibility and legibility of warnings and disclosures are protected for every lender.
- One token change updates all apps.

**Negative**

- Some lenders' brand colours will be rejected and need an adjusted shade.
- Limited branding may be a commercial negotiation point.

**Risks and known gaps (baseline)**

- `accent` is overridable but no contrast rule applies to it yet.
- Each call validates against one base theme; light and dark must be validated separately for a lender.
- `/theme.css` serves the light theme only; portals have no dark mode yet.
- `font-src 'self'` means Inter and Noto fonts must be self-hosted; until they are, the system font fallback is used.

## Compliance and security notes

- Supports accessibility and the reported anti-dark-pattern direction (effective 1 Jan 2027, confirmed (secondary)); it does not by itself satisfy user-testing or audit requirements. Primary-source verification gate applies (README).

## Verification

- `packages/design-tokens/src/theme.test.ts`: contrast matches WCAG reference values; base themes meet contrast; a legible lender colour is applied; a lender cannot restyle locked status colours; unreadable combinations are refused rather than fixed; malformed colours are refused; tokens are exposed as CSS custom properties.
- Planned: contrast rule for `accent`; validation of each lender theme against both light and dark bases; accessibility audit of key screens.

## Revisit triggers

- Lenders request more branding (logos, fonts, layouts).
- Results of accessibility audits or user testing under the RBC Second Amendment.
- Portals add dark mode.
