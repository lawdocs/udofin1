# Phase 04 specification: lender onboarding, configuration and the lender transaction panel

**Status:** draft for owner approval (13 October 2026). Nothing in this phase is implemented. Questions that need your decision are in section 11, each with a recommendation.
**Branch (when approved):** `phase-04/lender-onboarding`, one pull request, small commits.
**Depends on:** Phase 02 (change control), Phase 03 (sign-in, idempotency, outbox). Needs from you: a staging Supabase project in Mumbai (you are creating it), the first lenders' details, and the regulatory texts listed in section 10.
**Owner instructions applied (13 Oct 2026):** onboard **multiple** NBFCs, banks and other lenders; take care of **Ind AS** where it applies to banks and NBFCs; the lender gets a **panel to see the transactions done**; first lenders are MGM Financiers Private Limited and Megapode Vyapar Private Limited (details to follow); hosting is AWS Mumbai.

## 1. Objective in plain English

Today the platform can sign a staff member in and approve administrative changes, but it knows nothing about a lender beyond a name and a registration number. Phase 04 makes a lender a **complete, reviewable, switch-on-able customer**:

1. **Onboard any number of lenders** (NBFCs first; banks and other regulated lenders designed in, activated only when their rules are on file). Udofin staff run the onboarding; nothing goes live until a checklist is complete and a compliance sign-off exists.
2. Capture, **versioned and approved by two people**, everything the law and the contract need us to show borrowers: who the lender is and how it is regulated, whom borrowers complain to, which digital lending apps (DLAs) it has reported to the RBI, what it lends and on what terms, the consent wording, and which provider accounts (held in the lender's own name) its borrowers pay and sign through.
3. Record the lender's **accounting basis (Ind AS or Indian GAAP)** and make the data the lender's accountants need available, without Udofin ever computing the lender's provisions or books.
4. Give the lender a **transactions panel** in its portal: a read-only, exportable, tenant-isolated view of what has happened on its loans through Udofin, built now on the data model that exists and filling with real data as Phases 05–08 land.

No borrower screen, no live call to any provider, no credit decision and no money movement is built.

## 2. What exists and what this phase adds

| Exists (Phases 01–03)                                                                                                           | Added here                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy.organizations` (name, kind, registration number, CIN, status), memberships, roles, two-person change requests          | Lender profile (type, layer, accounting basis, disclosures), contacts, DLA registry, contract record, provider-account references, readiness |
| `lending.loan_products` and `loan_product_versions` with maker-checker, tenure floor, immutable approved versions               | The lender-portal screens and API on top of them; fee taxonomy and eligibility-rule schema inside `config`; Ind AS fields on the version     |
| `consent.notices` (versioned, hashed, immutable once published)                                                                 | Per-lender wording workflow through change requests                                                                                          |
| `tenancy.lender_settlement_accounts` (masked reference only)                                                                    | Verification workflow and the "repayment account of record" link                                                                             |
| `servicing.loan_accounts`, `payments.payment_intents`, `payments.provider_events`, `lending.application_events`, `audit.events` | A read-only **lender transactions panel** and exports over these, with synthetic-data tests until real data exists                           |
| Operations portal: change-request list and decisions                                                                            | Operations onboarding workflow: create lender, review checklist, compliance sign-off, activate                                               |

## 3. Multi-lender and multi-type design

One platform, many lenders, **no per-lender code**. Differences between lenders are **data**:

- **Lender type** (`nbfc`, `bank_commercial`, `bank_small_finance`, `bank_cooperative`, `hfc`, `other`) selects a **regulatory profile**: the set of RBI instruments that bind that type, the disclosures required, and the checklist. A profile is reference data with its own status, using our honest labels.
- Today only the **NBFC profile is backed by primary text** (the ten RBI documents on file). The **bank profiles are `unverified`**: the Directions that bind commercial, small-finance and co-operative banks (digital lending, income recognition, capital adequacy, outsourcing) are different instruments that are not on file, and the NBFC texts do not apply to banks. The system therefore lets a bank be **configured** but **will not let it be activated** until the compliance owner records a sign-off against a profile whose status is `confirmed (primary text)` (section 10 lists what to supply). This is a control, not a limitation of the model.
- **NBFC layer** (Base, Middle, Upper, Top) is recorded because it switches rules that matter to Udofin's data: Chapter IV of the outsourcing Directions and Chapter V of the cybersecurity Directions bind Middle layer and above; provisioning and capital rules differ by layer; the layer thresholds themselves are in the Scale Based Regulation directions, which are not on file.
- Everything lender-specific that borrowers see (names, grievance contacts, consent wording, product terms, colours within contrast limits) comes from versioned records; there is no hard-coded lender.

## 4. Ind AS and accounting basis

**Principle.** Udofin is not the lender's accountant. The lender's loan management system and general ledger are the books (ADR 0007). Udofin must (a) record **which accounting basis the lender declares**, (b) **never present figures that depend on it as if Udofin had computed them**, and (c) deliver the **facts and fields** the lender's finance team needs to apply it.

**What the primary texts on file say (confirmed, paragraph numbers in `docs/regulatory/primary/09` and `10`).**

- An **Ind AS NBFC** holds impairment allowances as Ind AS requires **and in parallel** keeps asset classification and provisioning under the IRACP Directions, which act as a **prudential floor**; any shortfall of the Ind AS allowance below the floor is appropriated to an Impairment Reserve (IRACP paras 34–36).
- For portfolios with a DLG, an NBFC **may** consider the DLG in expected credit loss (ECL) across all stages, but only as Ind AS allows (the guarantee must be integral to the contractual terms of the loan), must make Ind AS 1 disclosures, and must **recompute ECL at every invocation** because the cover reduces (paras 36A–36C).
- For capital, 12-month ECL counts as a Tier 2 general provision and lifetime ECL is deducted from risk-weighted assets (Capital Adequacy para 16(6)). A private DLG is not recognised as credit risk mitigation for retail loans.

**What is not on file and is stated here as `unverified`** (to be confirmed by the lender's auditor or counsel, which is why the system records a _declaration_ and its evidence and never decides it):

- Which NBFCs must apply Ind AS (understood as net-worth based phases under the Companies (Indian Accounting Standards) Rules; listed NBFCs and larger unlisted NBFCs, with smaller unlisted NBFCs on Indian GAAP).
- Banks: understood **not** to apply Ind AS to their statutory accounts at present, preparing under Indian GAAP with RBI provisioning norms; RBI's move of banks to an expected-credit-loss provisioning framework is understood to have been proposed in draft. Treat both as unverified until the bank texts are supplied.
- The ECL stage thresholds usually used (Stage 2 at 30 days past due, Stage 3 at 90) are defaults the lender sets in its own policy.

**What Phase 04 builds for it.**

1. **Accounting profile** per lender (effective-dated, two-person approved, history kept): `accounting_framework` (`ind_as` / `indian_gaap` / `bank_gaap_irac`), `effective_from`, `financial_year_end` (default 31 March), `ecl_applies`, `stage2_dpd` / `stage3_dpd` (lender policy, default 30/90), `evidence_ref` (e.g. auditor confirmation or board note, stored as a hash of the document held by the lender). Udofin stores the declaration, not the lender's financials.
2. **Fee taxonomy in product versions.** Every fee in `config` has a type (`processing`, `origination_cost_reimbursed`, `lsp_service_fee_paid_by_lender`, `insurance`, `foreclosure`, `penal_charge`, `gst`) and a flag whether the lender treats it as part of the effective interest rate. The lender's accountants need this split to apply amortised-cost accounting; the KFS needs it for the all-inclusive APR. One source, two uses.
3. **DLG term flag.** Each product version records whether a DLG applies and, if so, a reference to the loan-agreement clause that makes it part of the contractual terms (`dlg_in_loan_contract_ref`). This is a **contract fact the lender relies on**; the system records it and shows it in the accounting export, and does not assert the accounting conclusion.
4. **Accounting data pack** (export in the transactions panel, section 6): per loan, the contract terms version, sanctioned and disbursed amounts (integer paise), fee components by type with GST separated, schedule reference, and (as Phases 07–08 supply them) days-past-due history and DLG invocation facts (amount, remaining cover, date) so the lender's ECL engine can consume them.
5. **Guard rails.** Screens and exports label any derived figure "reported by the lender's system" or "calculated by Udofin from X"; Udofin computes no provision, no stage and no EIR.
6. **Udofin's own books** (its Ind AS 115 revenue from LSP fees, DLG accounting) are Udofin's concern in Phase 10 and are not mixed into lender data.

## 5. Onboarding workflow

```
Udofin ops: create lender (change request, two people)            -> status: onboarding
Lender admin invited (change request) + MFA enrolled
Lender admin / Udofin ops fill sections (each section change = a change request, drafter != approver):
  A Profile & regulatory   B Contacts   C DLA registry   D Contract record
  E Accounting profile     F Settlement account   G Provider accounts   H Consent wording   I Products
Readiness check (database function, no manual override) ------> every item green?
Compliance owner sign-off against the lender's regulatory profile (recorded, named, dated)
Activation (change request, two people; the apply step re-runs the readiness check)  -> status: active
Offers for this lender become visible to borrowers only while: status active AND readiness complete AND >=1 approved product version
```

**Readiness items (all required, each tested):** registration number and regulator; lender type with a **confirmed** regulatory profile; layer (NBFC); accounting profile; grievance redressal officer, principal nodal officer and complaint address; CCO/compliance contact; at least one verified DLA record (package or URL, CIMS reference and date, public-listing evidence) **or** an explicit "no lender-owned DLA; Udofin app only" record with the lender's CIMS entry for the Udofin DLA; signed-contract record with outsourcing-clause checklist (audit, RBI access, India data, sub-contractor consent, exit, incident notice); verified settlement account of record; provider-account references for each capability the lender's products use; published consent notice set; at least one approved product version; the lender's website listing of Udofin as LSP (para 9(4)); compliance sign-off.

Suspending or offboarding a lender uses the existing change-request types and immediately hides its offers; its history stays readable to it and to Udofin auditors.

## 6. The lender transactions panel

**Purpose.** "The lender can see the transactions done": a lender's finance, operations and audit staff can see, reconcile and export what happened on **their** loans through Udofin, and trace each line to evidence.

**Honest scope.** There are no transactions yet: money only moves from Phase 08 (payments) and Phase 07 (disbursement evidence). Phase 04 builds the panel, API, permissions, exports and isolation tests against the tables that already exist, proven with **synthetic fixtures**, so later phases only add rows. The panel never shows invented data.

**Views (lender portal, read-only):**

| View                        | Rows come from                                                                                            | Shows (examples)                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transactions**            | `servicing.loan_accounts` (disbursement evidence), `payments.payment_intents`, `payments.provider_events` | Date, type (disbursement, instalment, prepayment, foreclosure, charge), direction, amount (₹ from integer paise), status, UTR / provider reference, loan reference (the lender's own LMS reference), Udofin reference, reconciliation state |
| **Applications and offers** | `lending.applications`, `lending.offers`, `lending.application_events`                                    | Stage, offer terms version, offer valid-until, accepted/declined/expired, who acted (system, borrower, lender staff by role)                                                                                                                |
| **Consent and disclosures** | `consent.records`, `consent.notices`                                                                      | Which notice version (hash) a borrower reference accepted or withdrew, when                                                                                                                                                                 |
| **Activity log**            | `audit.events` scoped to the lender                                                                       | Configuration changes, approvals, who and when (staff names are not borrower data)                                                                                                                                                          |
| **Accounting data pack**    | the above plus product-version fee taxonomy                                                               | Section 4, item 4                                                                                                                                                                                                                           |

**Rules.**

- **Tenant isolation twice:** API permission checks and row-level security on every source; a lender sees only its `lender_org_id`. A platform operator sees a lender's panel only through the existing audited, read-only platform permissions.
- **Data minimisation:** the panel shows references, not identity. Udofin holds no borrower name, address or PAN (CLAUDE.md rule 3); the lender links a reference to the person in its own LMS. A masked mobile number would require reading Supabase Auth data and is **not** included (question Q6).
- **Money:** integer paise in storage and API, formatted with the existing Money type; never floating point.
- **Evidence:** each transaction row links to its source record(s); provider rows show the verified-callback state, never a bare provider "success".
- **Export:** CSV, filtered, capped at 10,000 rows per request, every export recorded in the audit trail (who, filter, row count, hash of the file). Larger exports wait for document storage (Phase 07). Exports are idempotent (a retry returns the same file reference) and use the Phase 03 pattern.
- **Permissions (new):** `transactions.read`, `transactions.export`, `activity.read` (lender and platform-grantable for read-only support), with `transactions.export` not granted to the default viewer role.
- **Performance:** keyset pagination (Phase 03 cursor), indexes on `(lender_org_id, occurred_at desc, id)`; the unified list is a **security-invoker view** so row-level security of each source table applies.

## 7. Data model (all new tables: `lender_org_id`, RLS enabled and forced, explicit grants, pgTAP including cross-tenant negatives; writes only through change requests or the system role)

| Table                                                             | Purpose                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy.regulatory_profiles`                                     | Reference data: lender type, instruments that bind it (register ids), required disclosures, **status** (`confirmed_primary` / `likely` / `unverified`), `activatable` flag. Platform-managed by migration.                                         |
| `tenancy.lender_profile_versions`                                 | Append-only, effective-dated: type, NBFC layer, regulator, website, RB-IOS and Internal Ombudsman applicability, board-policy references. Current = latest approved.                                                                               |
| `tenancy.lender_accounting_profiles`                              | Append-only, effective-dated accounting declaration (section 4).                                                                                                                                                                                   |
| `tenancy.lender_contacts`                                         | Role (`grievance_officer`, `principal_nodal_officer`, `nodal_officer`, `cco`, `dlg_contact`), name, designation, business email/phone, complaint address; effective-dated. Business contacts that RBI requires to be published, not borrower data. |
| `tenancy.lender_dla_records`                                      | Per DLA: name, store identifier or URL, owner (`lender` / `udofin`), CIMS reference and date, public-listing URL, evidence hash, verified by/at.                                                                                                   |
| `tenancy.lender_contracts`                                        | Contract reference, signed date, document hash (the document stays with the lender / counsel), outsourcing-clause checklist, counsel reviewer.                                                                                                     |
| `tenancy.lender_provider_accounts`                                | Capability (payment, mandate, kyc, bureau, aa, esign), provider code, mode (`sandbox` / `production`), **secret reference** (a name in AWS Secrets Manager), verified state. Never the secret. Reading a reference is audited.                     |
| `tenancy.lender_branding`                                         | Primary / on-primary / accent colours; API rejects combinations below WCAG contrast; database holds format checks.                                                                                                                                 |
| `tenancy.lender_activation_signoffs`                              | Compliance owner's named, dated sign-off against a regulatory-profile version; immutable.                                                                                                                                                          |
| `lending.loan_product_versions`                                   | Existing; `config` schema version 2 adds fee taxonomy, eligibility rules (lender-owned, versioned), DLG term reference, document checklist.                                                                                                        |
| view `reporting.lender_transactions`, `reporting.lender_activity` | Security-invoker unified read models for the panel (no data of their own).                                                                                                                                                                         |
| function `tenancy.lender_readiness(org)`                          | Returns the list of missing items; used by the activation apply step and by the offer-visibility rule.                                                                                                                                             |

**Change requests added** (each two-person, MFA, audited, idempotent): `lender_profile.update`, `lender_contact.set`, `lender_dla.record`, `lender_dla.verify`, `lender_contract.record`, `lender_accounting.declare`, `provider_account.set`, `lender_branding.set`, `lender_activation.signoff`. The existing `organization.create`, `organization.activate`, `membership.*`, `role.*`, `consent_notice.publish` are reused; `organization.activate` gains the readiness check. Product versions keep their own maker-checker (drafter ≠ approver in the database).

**Permissions added:** lender side `lender.profile.manage`, `lender.contacts.manage`, `lender.dla.manage`, `lender.provider_accounts.manage`, `transactions.read`, `transactions.export`, `activity.read`; platform side `lender.onboarding.review`, `lender.activation.signoff` (held by the compliance owner only, never by the same login that drafts), `regulatory_profile.read`. The authorisation-matrix test is updated and fails on any unreviewed change.

## 8. Screens (no client holds a secret; all calls go to the API)

- **Operations portal:** lender list and onboarding board (checklist per lender, who has submitted what), create-lender request, readiness report, compliance sign-off, activation, suspension; read-only lender configuration history.
- **Lender portal:** Overview (readiness checklist and recent activity), Organisation profile, Contacts, DLA records, Accounting profile, Provider accounts (references and verified state only), Consent wording, Products (list, draft, submit, approve with maker-checker), Team, **Transactions** (list, filters, detail, export), **Activity log**, Branding.
- Accessibility (labelled fields, keyboard, announced errors) and the existing strict CSP carry over; every state-changing form sends an `Idempotency-Key`.

## 9. Acceptance criteria (each is a test)

1. **Readiness gates offers:** for each readiness item, a lender missing only that item is not offer-visible and cannot be activated (one test per item); a complete lender is visible only while `active`.
2. **Bank profiles cannot be activated** while their regulatory profile is not `confirmed_primary`; an NBFC with a confirmed profile can.
3. **Two-person control** on every new change type: requester ≠ approver, both hold the permission, MFA required, applied atomically with its audit event; direct writes to the new tables by application roles are refused.
4. **Versioning:** profile, accounting and contact changes append a new effective-dated version; history is unchangeable; the "as at date" read returns the right version.
5. **Product versions:** below-floor tenure, disabled category and drafter-approves-own-version are refused (existing triggers, now also through the API); approved versions are immutable; fee taxonomy and DLG reference are validated against config schema v2.
6. **Consent wording:** published text cannot change; a change is a new version with a new hash; publishing needs two people.
7. **Secrets:** no provider secret appears in any table, API response, log or event (automated scan and test); reading a secret reference is audited; the portals hold no secret.
8. **Branding:** a colour pair that fails contrast is rejected by the API.
9. **Transactions panel isolation:** lender A cannot read lender B's rows through the panel, the unified views, exports or the activity log (negative tests per view); a lender auditor can read but not export; a platform operator reads only through audited read-only permission.
10. **Panel correctness:** synthetic fixtures covering disbursement, instalment, failed and duplicate provider events reconcile to the expected rows; amounts are exact in paise and formatted correctly; pagination is stable; exports are capped, idempotent and audited, and contain no personal data fields.
11. **Accounting guard rails:** the accounting profile is effective-dated and approved by two people; the data pack contains the fee split and DLG reference; no screen or export contains a provision, stage or EIR computed by Udofin (asserted by a schema test on the export columns).
12. **Browser tests** for the main lender and operations flows (fake auth and API as in Phase 03, plus a staging run when the staging project exists).
13. `pnpm lint`, `pnpm typecheck`, `pnpm test`, the database suite, the API integration suite, the browser suite and the secret scan are green; the authorisation matrix, OpenAPI document and docs are updated in the same PR.

## 10. Regulatory inputs and honest gaps

On file and used: Credit Facilities Chapter III (LSP duties, KFS, DLA reporting, para 9(4) website listing, para 12 grievance officers), outsourcing (mandatory contract clauses), cybersecurity (layer applicability), IRACP and Capital Adequacy (Ind AS floor and DLG), KYC and RB-IOS (applicability flags).

**Needed before bank lenders can be activated (please supply):** the RBI directions that bind **commercial banks** (digital lending / credit facilities, income recognition, asset classification and provisioning, outsourcing of financial services, cyber resilience), and for **small finance banks, co-operative banks and HFCs** whichever instruments apply to them (including the National Housing Bank/RBI housing finance rules for HFCs). Also: the Scale Based Regulation directions (layer thresholds), the RBC Second Amendment (15 Jun 2026) and the recovery-agent amendment (6 Aug 2026), and the credit-reporting first amendment.

**Needed from counsel/auditors, not from the system:** which Ind AS phase each lender falls in; the loan-agreement wording that makes a DLG part of the contractual terms; the lender-contract clauses mapped to the outsourcing paragraphs.

## 11. Questions for you (each with my recommendation)

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                               | Why it matters                                                                                              | Recommendation                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Banks:** build the bank profiles now but block activation until the bank directions are on file?                                                                                                                                                                                                                                                                                                     | Banks are governed by different RBI instruments; offering a bank's loans on NBFC rules would be wrong.      | **Yes.** Model and configure banks now; activate only after you supply the bank texts and the compliance owner signs off. Launch with the two NBFCs.                                        |
| Q2  | **Ind AS:** is a lender-declared accounting profile with evidence (not Udofin-computed) the right boundary?                                                                                                                                                                                                                                                                                            | Computing ECL/EIR would make Udofin an accounting system and a liability.                                   | **Yes.** Declaration plus the data pack; the lender's LMS and auditors do the accounting. Ask MGM and Megapode for their auditor-confirmed basis.                                           |
| Q3  | **Onboarding model:** Udofin-run (staff enter and review, lender approves/maker-checker) for now, lender self-service later?                                                                                                                                                                                                                                                                           | Roadmap excludes self-service; regulatory risk is highest at onboarding.                                    | **Udofin-run, lender-confirmed.** Lender admins can edit their own sections through the same two-person requests; Udofin ops review before activation.                                      |
| Q4  | **Compliance owner:** who holds `lender.activation.signoff`, and is it a different person from whoever drafts configuration?                                                                                                                                                                                                                                                                           | The sign-off is the legal control that a lender is ready.                                                   | Your appointed compliance owner, never the drafter. Please give a name and corporate email for the staging set-up (not needed for code).                                                    |
| Q5  | **Transactions export:** CSV only, capped at 10,000 rows, until document storage exists (Phase 07)?                                                                                                                                                                                                                                                                                                    | Larger or signed exports need S3 Mumbai and retention rules.                                                | **Yes.** Add scheduled statement files and larger exports in Phase 07/08.                                                                                                                   |
| Q6  | **Borrower identity in the panel:** references only, or also a masked mobile number?                                                                                                                                                                                                                                                                                                                   | Udofin stores no names; a mobile number lives in Supabase Auth and would widen what the lender panel reads. | **References only** in Phase 04; the lender's LMS links a reference to the person. Revisit with lenders if reconciliation needs it, with a consent basis.                                   |
| Q7  | **Provider secrets:** set by an authorised Udofin engineer directly in AWS Secrets Manager (Mumbai) with only the reference stored — no web form that accepts secrets?                                                                                                                                                                                                                                 | Any form that accepts a secret becomes a target.                                                            | **Yes.** Runbook-driven, two-person for production, reference-only in the database. Needs the AWS account (decision D-06) before real values exist; sandbox references can be recorded now. |
| Q8  | **Fees Udofin charges the lender:** record the fee type (`lsp_service_fee_paid_by_lender`) in the taxonomy now, and leave invoicing/statements to Phase 10?                                                                                                                                                                                                                                            | Lenders need the type for their EIR treatment; invoicing is Udofin finance.                                 | **Yes.** Taxonomy now; Udofin fee statements in Phase 10.                                                                                                                                   |
| Q9  | **First two lenders:** please send for each — legal name and CIN, RBI registration number, NBFC layer, auditor-confirmed Ind AS status, grievance officer and nodal officer, DLA details (do they report any app on CIMS?), settlement account (bank and last 4 digits only), and which products they will offer. Do either of them intend to take the 5% DLG and the recovery-agent role from Udofin? | Each readiness item needs real inputs; DLG and recovery change the contract and the KFS wording.            | I will prepare an input sheet (`docs/operations/lender-onboarding-checklist.md`) in the PR. Nothing is invented; missing items show red.                                                    |

## 12. Proposed commits

1. `feat(db): regulatory profiles, lender profile and accounting versions, contacts, DLA, contract, branding, sign-offs`
2. `feat(db): provider-account references and readiness function; offer-visibility rule`
3. `feat(db): change types for lender configuration; activation requires readiness and sign-off`
4. `feat(db): transactions and activity views; permissions; matrix update`
5. `feat(api): lender configuration endpoints (OpenAPI, idempotent), product version workflow, consent workflow`
6. `feat(api): transactions panel endpoints and audited CSV export`
7. `feat(ops-portal): onboarding board, readiness, sign-off, activation`
8. `feat(lender-portal): profile, contacts, DLA, accounting, products, consent, transactions, activity`
9. `test: isolation, readiness, bank gate, export and secret-scan tests; browser flows`
10. `docs: ADRs (lender configuration model, accounting boundary), controls matrix rows, onboarding checklist, runbooks`

Each commit runs the full checks first; the PR carries the acceptance checklist with results. Estimated size: larger than Phase 03; I would deliver it as two reviewable pull requests (database and API first, then screens) unless you prefer one.

## 13. Risks

| Risk                                                               | Handling                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A lender goes live with incomplete or wrong regulatory disclosures | Readiness function + compliance sign-off + two-person activation; counsel (D-05) checks the disclosure text |
| Banks onboarded under NBFC rules                                   | Regulatory-profile gate (Q1)                                                                                |
| Udofin appears to provide accounting or credit conclusions         | Declaration-only model, labelled figures, schema test on export columns                                     |
| Tenant data crosses lenders through a view or export               | Security-invoker views, per-view negative tests, matrix test, export audit                                  |
| Secret handling mistakes                                           | References only, scan test, no secret-accepting UI                                                          |
| Scope too large for one PR                                         | Two-PR delivery; the panel ships with synthetic fixtures only and shows empty states until real data exists |
