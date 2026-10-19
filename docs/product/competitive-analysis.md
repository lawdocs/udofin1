# Competitive analysis (summary)

Date: 2026-10-10. Summary of `docs/research/2026-10-10/competitors-ux.md`; read that note for the
full profiles, sources and evidence tags. Section numbers below (§) refer to it.

> **Research limitation.** About 25 web searches were completed before the shared search budget ran
> out, and no page could be opened in full (WebFetch failed for every domain, including rbi.org.in
> and groww.in). Claims rest on search extracts of primary pages and on secondary sources. Evidence
> tags from the research: **(v)** verified this session via a search extract; **(bk)** background
> knowledge, not re-verified (**unverified**). Regulatory points carry the status labels
> confirmed / likely / interpretation / unverified and must be checked against primary text before
> use (D-05 in [`open-decisions.md`](open-decisions.md)).

## 1. Market shape

Three archetypes now dominate the Indian digital-lending front end (§ executive summary, §3):

| Archetype                                     | Examples                                                                                    | Relevance to Udofin                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payments and wealth super-apps acting as LSPs | PhonePe, Google Pay, CRED, Groww, Paytm                                                     | Huge distribution; several are buying or building NBFCs (Amazon closed axio in Sept 2025 (v); Groww lends through Groww Creditserv (v)). A pure LSP must win on neutral comparison and journey quality (interpretation). |
| Pure marketplaces / LSPs                      | Paisabazaar, BankBazaar, Volt Money (LAMF), Rupeek (gold)                                   | Closest model to Udofin. Volt shows an LSP can sit inside another LSP (embedded in PhonePe (v)).                                                                                                                         |
| NBFC-owned lending apps                       | Money View, KreditBee, Fibe, Kissht, Freo, mPokket, Bajaj Finserv, Tata Capital, Poonawalla | Set borrower expectations for speed; the main source of complaint patterns (collections, fees).                                                                                                                          |

Regulation now shapes the UX directly: the multi-lender display rule (effective 1 Nov 2025;
confirmed, secondary), RBI's public list of DLAs (live since 1 Jul 2025; confirmed via RBI press
release extract), and Google Play's requirement that Indian personal-loan apps appear on that list
(confirmed via Google Help Center extract) (§1).

## 2. Feature matrix highlights

Condensed from §4. "Lender display" means how offers and lenders are shown.

| Player                                     | Model           | Lender display                                      | Repayment UX        | Trust and disclosure                                                             | Notable point                                                                                 | Evidence     |
| ------------------------------------------ | --------------- | --------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| Paisabazaar                                | Marketplace LSP | Ranked list from 30+ lenders, "pre-approved" labels | Lender channels     | Lender names on offers                                                           | Free credit report as the hook; disbursal cash-back promotions may count as steering          | (v) partial  |
| PhonePe                                    | Super-app LSP   | Lender-branded offers; Volt embedded                | UPI-native          | Lender list on press/help pages                                                  | Secured-first platform launched 30 May 2024 (MF, gold, property, vehicles, education)         | (v)          |
| Google Pay                                 | Super-app LSP   | One or few lender cards                             | UPI AutoPay (bk)    | Lender list on India page                                                        | Pre-approved, lender-branded offers                                                           | (v) partners |
| CRED                                       | LSP + DLA       | APR range on listing (9.5%–45%)                     | In-app / UPI        | Explicit statement that DTPL is the LSP and the app is the DLA, with lender list | LAMF (Cash+) from Feb 2025                                                                    | (v)          |
| Groww                                      | DLA + own NBFC  | APR 13%–48% on listing                              | In-app              | Lenders named on listing                                                         | LAMF live 6 Oct 2025                                                                          | (v)          |
| Volt Money                                 | LAMF LSP        | Lender shown                                        | Repay to lender     | Lender named                                                                     | Lien via CAMS/KFintech by OTP, about 10 minutes; lien not auto-released after repayment       | (v)          |
| Money View                                 | NBFC + LSP      | Own and partner offers                              | eNACH / UPI (bk)    | —                                                                                | 4.76 stars from about 4.11M Play ratings (third-party tracker); collection-conduct complaints | (v)          |
| KreditBee / Fibe / Kissht / Freo / mPokket | NBFC apps       | Single lender                                       | eNACH / UPI AutoPay | Lender name, grievance officer in app (bk)                                       | Recovery and fee complaints (low-quality sources)                                             | (bk)         |

## 3. Onboarding interaction counts

An interaction is a deliberate tap, field entry or OTP entry (§6).

| Stage                                                                                                                                                                           | Interactions                  | Notes                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Mobile number                                                                                                                                                                   | 1–2                           | Android Phone Number Hint, not phone permissions                 |
| OTP                                                                                                                                                                             | 0–1                           | SMS Retriever / User Consent API autofill (bk)                   |
| Consents (terms, privacy, check by named lenders; separate optional marketing)                                                                                                  | 1–2                           | Not pre-ticked, not bundled                                      |
| PAN; name and date of birth auto-filled and confirmed                                                                                                                           | 2                             |                                                                  |
| Product, amount, purpose (or MF portfolio fetch for LAMF)                                                                                                                       | 1–2                           | LAMF adds about 2 for portfolio fetch and RTA OTP                |
| Employment type and income (skip for LAMF)                                                                                                                                      | 1–2                           |                                                                  |
| **To an offer screen**                                                                                                                                                          | **about 7–9 (floor about 6)** |                                                                  |
| After selecting an offer: select and open KFS 2, accept KFS 1, lender KYC 3–4, selfie liveness 1–2, bank account 1–3, mandate 2–3, eSign 2–3, lien or pledge OTP 1–2 (LAMF/LAS) | see left                      | Cannot be removed by regulation; mostly the lender's obligations |
| **Download to disbursal**                                                                                                                                                       | **about 20–28**               |                                                                  |

Udofin's target ([`roadmap.md`](roadmap.md) Phase 05): **3–4 interactions to start** an application (mobile number, OTP
autofill, consents, basic need) and about 7–9 to see offers. Running Aadhaar OTP, DigiLocker and
CKYC before offers would add about 8 interactions and conflicts with the lender owning KYC
(interpretation; §6, challenge 1). KYC therefore runs under the selected lender after the offer.

## 4. UX patterns to copy

From §7:

1. **Legal-role banner** (CRED style): "[Udofin legal name] is a Lending Service Provider. Loans
   are given by [lender list]." On the splash screen, store listing and every offer.
2. **Lender-branded offer cards** with legal name, "Regulated by RBI" and a link to the lender's
   entry on RBI's DLA list.
3. **Eligibility before KYC** (Money View, Paisabazaar).
4. **KYC method choice** (Money View's "KYC selection step"): DigiLocker, Aadhaar OTP, CKYC under the
   lender's arrangements, with video KYC as fallback.
5. **LAMF portfolio fetch and OTP lien**, plus **automatic lien-release prompt on closure** (fixes
   Volt's documented gap).
6. **Neutral comparison table**: disclosed default sort (research suggests lowest APR, then lowest
   monthly repayment), user-selectable sorts, a row naming lenders that did not offer, a KFS link per
   offer, no "recommended" badges.
7. **Repayment hub**: UPI AutoPay default, eNACH fallback, pay-now link into the lender's account,
   statement, foreclosure quote, NOC download.
8. **Trust page** reachable from every screen: Udofin's grievance officer, each lender's nodal
   officer, escalation to the RBI Ombudsman after 30 days, recovery-agent list, DLA-list links.
9. **Reminder cadence** limited to service messages (T-3, T-1, due day); marketing only by separate
   opt-in.
10. **AI assistant** labelled as AI, answering only from the KFS, statements and FAQs, with one-tap
    human handover and a "raise a complaint" button that creates a ticket.

## 5. Dark patterns to avoid

From §8, plus the regulatory overlay in §1:

- Steering: "Best for you" or commission-driven ranking; hiding lenders that did not offer.
- Bait and switch: "Pre-approved ₹5 lakh!" banners resolving to smaller or costlier offers.
- Drip pricing: monthly rate or headline interest without APR; fees appearing only at the KFS.
- Basket sneaking: pre-selected insurance or memberships.
- False urgency: countdown timers, expiring cash-back.
- Forced action: requiring contacts, location, SMS or storage access, or marketing consent, to
  proceed.
- Confirm-shaming and nagging notifications.
- "Won't affect your score" when a hard enquiry is made.
- Automatic limit increases or auto-renewal without explicit consent.
- Lien left in place after repayment.
- Collection harassment (the most consistent complaint theme in Money View's 2025–26 reviews (v,
  anecdotal)).
- Unreachable support.

From 1 Jan 2027, the RBC Second Amendment Directions add an explicit ban on dark patterns and
require user testing and audit of interfaces (confirmed, secondary;
`docs/research/2026-10-10/rbi-digital-lending.md` §2.3).

## 6. Lessons from failures and enforcement

- **ZestMoney (shut Dec 2023):** depended on regulatory grey zones; do not build on pass-through
  funds, unregulated credit lines or DLG workarounds (confirmed, secondary; §2).
- **Illegal loan apps:** MeitY blocked 87 illegal lending apps (Dec 2025; confirmed, secondary).
  The abuses were contact scraping, harassment and hidden fees; visible trust signals are a
  competitive asset.
- **Lender-level actions** (bk, unverified): RBI action against Bajaj Finance's eCOM and Insta EMI
  Card lending over KFS (Nov 2023), and against four NBFCs over pricing (Oct 2024). Lessons: log KFS
  delivery as evidence; treat APR outliers on the comparison screen as a regulatory risk for the
  lender.
- **Store control:** Google took action on about 3,500 loan apps in India in 2022 (confirmed,
  secondary). Store policy controls distribution as much as RBI.

## 7. Recommended MVP features

The research recommended a secured-first MVP (LAMF/LAS plus personal loans from 2–4 lenders) on
Android plus responsive web (§9). The owner's MVP decision is **personal loans from 2–4 lenders on
Android first, with LAMF as the first secured product; iOS after Android; borrower servicing web
later** ([`roadmap.md`](roadmap.md) §1). MVP features drawn from the research:

| Area              | Feature                                                                                                                                       | Roadmap phase  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Onboarding        | Phone Number Hint, SMS Retriever OTP, unbundled consents, resumable journey                                                                   | 05             |
| Offers            | Multi-lender view with mandatory fields, KFS link per offer, lenders that did not offer, neutral disclosed sort, display log                  | 06             |
| KYC and data      | Lender-run KYC (DigiLocker / CKYC / Aadhaar under the lender's arrangements), AA under the lender's FIU, bureau under the lender's membership | 06             |
| Documents         | KFS viewer and acknowledgement, eSign under the lender's arrangement, eStamp per lender matrix                                                | 07             |
| Repayment         | UPI AutoPay / eNACH in the lender's name, pay-now links into the lender's account, statement, NOC                                             | 08             |
| LAMF              | Portfolio fetch, OTP lien in the lender's favour, lien release on closure                                                                     | S1 (04, 06–08) |
| Trust and support | Trust page, complaint ticketing with clock, AI assistant limited to FAQ/KFS/status with human handover                                        | 05, 09         |
| Evidence          | Audit log of offers shown, sort rule, KFS delivered, consents                                                                                 | 06–07          |

**Not in the MVP** (from §9 "Do not launch" and the challenges): payday loans repayable within 60
days; SMS-based "books of accounts"; PayPal or Stripe for domestic loan repayments; Equator as an
escalation step.

## 8. Open questions carried from the research

- Current paragraph numbering of the multi-lender rule after the 28 Nov 2025 consolidation.
- Whether partner lenders can run parallel bureau soft inquiries without a hard-inquiry footprint,
  and the consent wording bureaus require.
- Apple's 36% APR rule as applied in India (D-19).
- Whether CKYC 2.0 (reported from 1 Aug 2026; unverified) lets a lender treat an OTP-consented CKYC
  fetch as complete KYC.
- Default sort for the comparison view (D-16).
- Collections as a revenue line or left to lenders (D-11).
