# Open decisions for the owner

Date: 2026-10-10. Each decision has a number (D-01 to D-28) used in
[`roadmap.md`](roadmap.md) and [`module-status.md`](module-status.md). "Deadline" names the first
phase that cannot start (or cannot finish) without the decision. Priority: **P1** = needed before
the next phase can start; **P2** = needed before a later phase; **P3** = can wait.

> **Research limitation.** Regulatory statements below come from the research notes in
> `docs/research/2026-10-10/`. During research the sandbox could not open rbi.org.in or other
> primary sources (WebFetch DNS failure; proxy blocked HTTPS) and the shared web-search budget ran
> out, so findings rest on search snippets and secondary sources. Every regulatory paragraph
> reference must be verified against the primary RBI / UIDAI / MeitY / NPCI text before it is
> relied on in a contract, policy or launch (see D-05). Status labels: confirmed / likely /
> interpretation / unverified.

## Decisions recorded on 13 October 2026

The owner decided D-01 (baseline approved for now, may change after the app is built), D-02 (legal entity **Infrabyx Consultancy OPC Private Limited**), D-05 (a compliance owner is appointed; ten RBI texts supplied and filed under `docs/regulatory/sources/`), D-06 and D-07 (production on AWS, any India-based server acceptable to save cost with data localisation; a paid Supabase plan for network restrictions), D-10 (Udofin provides a 5% DLG) and D-11 (Udofin acts as recovery agent; other agencies may also be used), and approved the Phase 02 specification. The owner's position is that an OPC can act as DLG provider and recovery agent; counsel is still asked to confirm this together with the statutory-auditor declaration and the capital behind the cover (ADR-0023). The sections for these decisions below are kept for the record.

Also on 13 October 2026: the first lenders to onboard are **MGM Financiers Private Limited** and **Megapode Vyapar Private Limited**, both RBI-regulated NBFCs (D-03, partly). Their registration numbers, layer (Base, Middle, Upper), Ind AS status and what each provides (products, whether Udofin gives DLG, whether Udofin collects) are still to be collected during onboarding; nothing is assumed. Lender staff who approve changes inside a lender are named by each lender; Udofin separately needs **two named platform administrators**. The prototype Supabase project `Udofin-app` is left untouched; fresh staging and production projects will be created in Mumbai (Phase 02 spec Q1, agreed).

## Summary

| No.  | Decision                                                                                      | Priority                 | Deadline (blocks)                                       | Status                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-01 | Approve the Phase 01 baseline and architecture decisions                                      | P1                       | Phase 02                                                | Decided 13 Oct 2026: approved for now                                                           |
| D-02 | Legal entity that runs Udofin                                                                 | P1                       | Phase 03 (accounts), Phase 04 (contracts)               | Decided 13 Oct 2026: Infrabyx Consultancy OPC Private Limited (CIN to be supplied)              |
| D-03 | Launch lenders (2–4) and what each provides                                                   | P1                       | Phase 04                                                | Open                                                                                            |
| D-04 | Finbyx Supabase project: move from Tokyo to Mumbai                                            | P1 (urgent if real data) | Phase 06 (Finbyx integration); now, if real data exists | Open                                                                                            |
| D-05 | Counsel / compliance owner for primary-source verification                                    | P1                       | Phase 04 (contracts); release gate in Phase 11          | Decided 13 Oct 2026: compliance owner appointed; 10 RBI texts on file                           |
| D-06 | Production hosting: AWS account in ap-south-1; role of Railway                                | P1                       | Phase 03                                                | Decided 13 Oct 2026: AWS preferred; any India-based host acceptable (static outbound IP needed) |
| D-07 | Supabase plan (Team vs Pro), PITR, written residency confirmation                             | P1                       | Phase 02                                                | Decided 13 Oct 2026: paid plan (Pro recommended)                                                |
| D-08 | App name, store identifiers and developer accounts                                            | P1                       | Phase 03 (store-linked builds), Phase 05 (OTP template) | Open                                                                                            |
| D-09 | First secured product and its structure (LAMF term loan vs credit line; vehicle alternative)  | P1                       | Phase 04                                                | Open                                                                                            |
| D-10 | Will Udofin provide a default loss guarantee (DLG)?                                           | P1                       | Phase 04 (contract terms), Phase 08 (ledger)            | Decided 13 Oct 2026: yes, 5% DLG                                                                |
| D-11 | Will Udofin act as recovery agent for any lender?                                             | P2                       | Phase 04 (KFS naming), Phase 08                         | Decided 13 Oct 2026: yes, plus other agencies allowed                                           |
| D-12 | Appoint Udofin's grievance officer, privacy contact, CERT-In point of contact, incident owner | P2                       | Phase 04 (disclosures), Phase 05 (trust page)           | Open                                                                                            |
| D-13 | KYC / bureau / AA vendor contract structure under lender credentials                          | P2                       | Phase 06                                                | Open                                                                                            |
| D-14 | Marketing consent and notification strategy                                                   | P2                       | Phase 05                                                | Open                                                                                            |
| D-15 | Languages at launch                                                                           | P2                       | Phase 05 (UI), Phase 07 (KFS and documents)             | Open                                                                                            |
| D-16 | Default order of offers and who owns the matching logic                                       | P2                       | Phase 06                                                | Open                                                                                            |
| D-17 | Equator: domain, brand and independence model                                                 | P2                       | Phase 09                                                | Open                                                                                            |
| D-18 | AI provider and hosting                                                                       | P2                       | Phase 09                                                | Open                                                                                            |
| D-19 | iOS: handling of Apple's 36% APR rule                                                         | P2                       | Phase 06 (filter), iOS release                          | Open                                                                                            |
| D-20 | Borrower web experience                                                                       | P3                       | After Phase 11                                          | Open                                                                                            |
| D-21 | Field-agent app                                                                               | P3                       | Only if a lender needs it                               | Open                                                                                            |
| D-22 | Personal "books of accounts" feature                                                          | P3                       | Before Phase 10 planning                                | Open                                                                                            |
| D-23 | Confirm payday loans are not supported                                                        | P2                       | Phase 04                                                | Open                                                                                            |
| D-24 | Device-integrity enforcement policy                                                           | P2                       | Phase 05                                                | Open                                                                                            |
| D-25 | Record-retention schedule (with lenders)                                                      | P2                       | Phase 07                                                | Open                                                                                            |
| D-26 | Ecosystem boundaries and conflict disclosures (Finbyx, LawDocsComply, staff SSO)              | P2                       | Phase 10; disclosures before Phase 04 contracts         | Open                                                                                            |
| D-27 | Membership of the fintech self-regulatory organisation (FACE)                                 | P3                       | Before Phase 11                                         | Open                                                                                            |
| D-28 | Disaster-recovery posture for a regional outage                                               | P2                       | Phase 11 (DR drill targets)                             | Open                                                                                            |

---

## D-01 Approve the Phase 01 baseline and architecture decisions

- **Question.** Do you accept the Phase 01 baseline (schema, API skeleton, app shells, research)
  and its architecture decisions: modular monolith; Supabase Postgres in Mumbai as the operational
  store; RLS applied to the API as a second layer; lenders own credit decisions and the loan
  record; no Udofin pool or pass-through account; Udofin keeps minimal borrower data; production
  compute in AWS Mumbai before the first real borrower; outbox + pg-boss for background jobs?
- **Why it matters.** Every later phase builds on these. Changing them later means rework and, for
  money flows and data residency, possible regulatory exposure.
- **Options.** (a) Approve as documented. (b) Approve with named changes. (c) Ask for a walkthrough
  first.
- **Recommendation.** (a) or (b). The decisions follow the research and are tested where they
  touch the database.
- **Deadline.** Before Phase 02 starts.

## D-02 Legal entity that runs Udofin

- **Question.** Which company operates Udofin, signs lender contracts, holds the store developer
  accounts, registers SMS headers and templates (DLT), and appears in the app as the LSP?
- **Why it matters.** Lenders contract with and audit this entity. A DLG provider must be
  incorporated under the Companies Act, 2013 (confirmed, secondary sources;
  `docs/research/2026-10-10/rbi-digital-lending.md` §3.15). Apple expects financial apps to be
  submitted by the legal entity providing the service (Guideline 5.1.1(ix), confirmed); Google
  expects the developer account name to match the business named in the Personal Loan App
  Declaration (likely; `docs/research/2026-10-10/app-store-mobile.md` §1.2, §3).
- **Options.** (a) An existing group company. (b) A new company dedicated to Udofin. (c) A company
  that also runs Finbyx, LawDocsComply or Equator.
- **Recommendation.** (b), or (a) if it runs no other group product. Avoid (c): a lender auditing
  Udofin should not find the same entity running its LMS or compliance tool or the dispute forum.
- **Deadline.** Phase 03 (developer and cloud accounts in the entity's name); Phase 04 (contracts).

## D-03 Launch lenders and what each provides

- **Question.** Which 2–4 lenders launch with Udofin, and has each agreed to: report the Udofin
  app (and any web front end) on RBI's CIMS portal; list Udofin on its website; provide KYC,
  bureau, Account Aggregator, eSign/eStamp, disbursement, mandate and payment-gateway arrangements
  in its own name; expose its LOS/LMS (Finbyx or other) to Udofin; and sign a written contract with
  the clauses its outsourcing directions require (roles, audit and RBI inspection rights, data
  protection, incident notification, exit)?
- **Why it matters.** Google Play admits new Indian personal-loan apps only if they appear on RBI's
  public DLA list, which lenders populate through CIMS (confirmed via Google Help Center extract;
  `app-store-mobile.md` §1.2). Udofin cannot list itself. Every regulated rail must run in the
  lender's name (`providers-payments.md`). Lender type also matters: coverage of the RBI
  Integrated Ombudsman Scheme 2026 depends on the lender's type and size. One research note reports,
  from an RBI FAQ snippet, a ₹100 crore asset threshold for NBFCs with a customer interface and
  that housing finance companies are excluded (`rbi-digital-lending.md` §2.3); another marks both
  points unverified (`grievance-adr-collections.md` §1). Counsel must confirm per lender.
- **Options.** (a) NBFCs only. (b) NBFCs plus one bank (needed later for credit-line products,
  which the Aug 2026 draft would restrict for most NBFCs — draft, likely). (c) Start with one
  lender.
- **Recommendation.** (a) with 2–3 NBFCs that already have digital KYC, bureau and mandate
  arrangements, and at least one already onboarded as lien holder with the mutual-fund RTAs (for
  LAMF). Make CIMS reporting a condition precedent in each contract. One lender alone cannot
  produce a meaningful multi-lender comparison.
- **Deadline.** Phase 04.

## D-04 Finbyx Supabase project: move from Tokyo to Mumbai

- **Question.** Will you recreate the Finbyx Supabase project in ap-south-1 (Mumbai), migrate it
  and delete the Tokyo project; and does the Tokyo project hold any real lender or borrower data?
- **Why it matters.** Research confirmed (Supabase Management API, 2026-10-10) that project
  `finbyx` runs in ap-northeast-1 (Tokyo). Borrower data must be stored only on servers in India
  (likely; `infra-stack.md` §2, §4). A project's region cannot be changed in place (confirmed).
  Udofin plans to integrate with Finbyx as a lender LMS.
- **Options.** (a) Recreate in Mumbai now. (b) Recreate before the first Finbyx integration.
  (c) Keep Tokyo for test data only.
- **Recommendation.** (a). If real data was ever stored in Tokyo, record it as a compliance
  incident with an inventory of what was held, and take counsel's advice on notifications.
- **Deadline.** Immediately if real data exists; otherwise before Phase 06 (decision intake from
  Finbyx) and Phase 08 (LMS sync).

## D-05 Counsel / compliance owner for primary-source verification

- **Question.** Who will verify every regulatory reference in our documents, disclosures and
  contracts against the primary texts, and own the regulatory register?
- **Why it matters.** None of the research could open rbi.org.in or other primary sources. The
  current paragraph numbering of the consolidated 28 Nov 2025 Credit Facilities Directions,
  RB-IOS 2026 clauses, recovery-agent amendments and DLG text are unverified
  (`rbi-digital-lending.md` §6). Lenders will rely on Udofin's disclosures.
- **Options.** (a) External regulatory counsel. (b) In-house compliance lead plus external review.
  (c) Lender's counsel only.
- **Recommendation.** (b): name an internal owner now and engage external counsel for a
  primary-source review before lender contracts are signed. Do not rely on (c); lenders review for
  their own risk, not Udofin's.
- **Deadline.** Phase 04 (contract drafting). Release gate for Phase 11.

## D-06 Production hosting: AWS account in ap-south-1; role of Railway

- **Question.** Who owns and pays for an AWS account in ap-south-1 (Mumbai) for production compute,
  S3 + KMS documents and logs; and do you accept Railway for dev/staging with synthetic data only?
- **Why it matters.** Railway has no India region (four regions: US West, US East, EU West,
  Southeast Asia) and no bring-your-own-cloud option (confirmed; `infra-stack.md` §1). It retains
  logs and traces outside India. AWS App Runner is closed to new customers from 30 Apr 2026
  (confirmed), so the target is ECS on Fargate. Moving after lenders have audited a different setup
  forces a second audit.
- **Options.** (a) AWS for production from Phase 03; Railway for dev/staging. (b) AWS for all
  environments. (c) Railway in production as a short bridge (stateless, no personal data in logs,
  lender's written acceptance).
- **Recommendation.** (a). (b) is cleaner but costs more early. Avoid (c).
- **Deadline.** Phase 03.

## D-07 Supabase plan, point-in-time recovery and residency confirmation

- **Question.** Which Supabase plan for production (Team or Pro), how many days of point-in-time
  recovery (PITR), separate projects per environment, and will you obtain Supabase's written
  confirmation of where backups, platform logs and support tooling store data?
- **Why it matters.** Per Supabase docs (confirmed; `infra-stack.md` §3): the SOC 2 Type 2 report
  is available on Team and Enterprise; the MFA-verification and password-verification auth hooks
  need Team or Enterprise; SAML SSO, PITR, log drains and read replicas are available from Pro;
  PITR costs about $100 / $200 / $400 per month for 7 / 14 / 28 days and gives a worst-case RPO of
  about 2 minutes. The backup bucket region and platform-log location are not documented
  (unverified). Lenders' due diligence will ask for both.
- **Options.** (a) Team in production with 14-day PITR; Free or Pro for dev/staging. (b) Pro in
  production with 14-day PITR. (c) Enterprise.
- **Recommendation.** (a). Check current plan pricing before committing; research did not record
  plan prices. Ask Supabase in writing about backup and log residency and whether the Smart CDN
  can be disabled.
- **Deadline.** Phase 02 (MFA hook); Phase 03 (projects per environment).

## D-08 App name, store identifiers and developer accounts

- **Question.** What is the app's public name, and what are the final Android package name and iOS
  bundle identifier? The code uses the placeholder `com.udofin.app` (non-production builds append
  the environment, for example `com.udofin.app.staging`; `apps/mobile/app.config.ts`).
- **Why it matters.** Store identifiers are permanent once published. Each lender's CIMS report
  names the app, so a later change means every lender must re-report. The OTP SMS template
  registered on DLT carries an app-identifying hash for Android's SMS Retriever, and Play Integrity
  is linked to the published app (`app-store-mobile.md` §1.6, §4, §5).
- **Options.** (a) Keep `com.udofin.app` and the name "Udofin". (b) Choose new identifiers now.
- **Recommendation.** Decide now, after a trademark check of the name, and create Google Play and
  Apple organisation developer accounts under the legal entity from D-02.
- **Deadline.** Phase 03 (first store-linked build); Phase 05 (DLT OTP template).

## D-09 First secured product and its structure

- **Question.** Is loan against mutual funds (LAMF) the first secured product, and is it a term
  loan or a credit line? Alternative: vehicle loans first.
- **Why it matters.** LAMF fits an LSP well: lien marking is digital through the RTAs (CAMS,
  KFintech, MF Central) by OTP, and competitors launched it in 2025 (confirmed for Groww and CRED;
  `competitors-ux.md` §3, §5). Only the lender can be lien holder or pledgee (likely;
  `providers-payments.md` §10). Competitor LAMF products are often credit lines, but an Aug 2026
  RBI draft would limit most NBFCs to term loans (draft; likely) and DLG cannot cover revolving
  credit (confirmed, secondary). In the database, `loan_against_securities` is still
  `feasibility_review`; enabling it needs a reviewed migration.
- **Options.** (a) LAMF as a term loan with NBFC lenders. (b) LAMF as a credit line with a bank
  lender. (c) Vehicle loans first.
- **Recommendation.** (a), with mutual funds held in statement form first and demat units/shares
  later (S1b). Build automatic lien-release prompts on closure (a gap research found at one
  competitor).
- **Deadline.** Phase 04 (product configuration); gate S1 in [`roadmap.md`](roadmap.md) §5.

## D-10 Will Udofin provide a default loss guarantee (DLG)?

- **Question.** Will Udofin give DLG to partner lenders, to which lenders, and with how much
  capital?
- **Why it matters.** DLG must not exceed 5% of the amount disbursed out of the earmarked portfolio;
  it may be held only as cash with the lender, a fixed deposit with lien, or a bank guarantee; it is
  invoked within 120 days overdue; invoked amounts are not reinstated; the provider must publish on
  its website the number of portfolios and amounts covered; it cannot cover revolving credit
  (confirmed, secondary sources; `rbi-digital-lending.md` §3.15). DLG gives **no right or duty to
  collect**. NBFCs using ECL may count DLG only where it is integral to the loan contract (13 Feb
  2026 amendment; confirmed, secondary). Research suggests legal advice on whether large guarantee
  exposure affects Udofin's own regulatory characterisation.
- **Options.** (a) No DLG at launch. (b) DLG for one or two lenders with a capped total.
  (c) DLG for all lenders.
- **Recommendation.** (b) only after counsel's advice and a capital model across lenders; otherwise
  (a). The DLG ledger (Phase 08) and Udofin's books (Phase 10) are built only if (b) or (c).
- **Deadline.** Phase 04 (contract terms); Phase 08 (ledger).

## D-11 Will Udofin act as recovery agent for any lender?

- **Question.** Will Udofin collect overdue amounts on a lender's behalf?
- **Why it matters.** An LSP may collect only if the lender appoints it as recovery agent under its
  outsourcing framework; the KFS must name it; the borrower must be told before contact; calls only
  08:00–19:00; harmonised recovery rules dated 6 Aug 2026 take effect 1 Jan 2027 (certification,
  call recording, advance notice — confirmed via secondary sources, details need the text;
  `rbi-digital-lending.md` §2.3, §3.14). Collection harassment is the most consistent complaint
  theme in the category (`competitors-ux.md` §3). If Udofin also gives DLG, it has a direct
  incentive to collect hard.
- **Options.** (a) No; lenders use their own agencies. (b) Digital reminders and self-service
  payment only, which do not need a recovery-agent appointment if they stay service messages
  (interpretation; counsel to confirm). (c) Full recovery-agent role.
- **Recommendation.** (b) at launch. Consider (c) later only under a separate contract, with call
  recording, complaint-rate triggers and a lender kill switch.
- **Deadline.** Phase 04 (KFS naming); Phase 08.

## D-12 Udofin's officers

- **Question.** Who is Udofin's nodal grievance redressal officer, privacy / data-protection
  contact, CERT-In point of contact, and security incident owner?
- **Why it matters.** Both the lender and the LSP must name a grievance officer, displayed on the
  website, in the app and in the KFS (likely; `grievance-adr-collections.md` §3). CERT-In requires
  a registered point of contact and incident reports within 6 hours (likely;
  `privacy-security-outsourcing.md` §6).
- **Options.** Named individuals now, or interim holders with a date for permanent appointments.
- **Recommendation.** Name individuals now; the grievance officer by board resolution. Publish
  only role-based contact details (email, phone), not personal ones.
- **Deadline.** Phase 04 (disclosures and KFS template); Phase 05 (trust page); Phase 11.

## D-13 KYC / bureau / AA vendor contract structure

- **Question.** How will Udofin's existing Surepass contract (and any other verification vendor) be
  restructured so that bureau pulls, CKYC, Aadhaar-based KYC and Account Aggregator consent run
  under each lender's credentials?
- **Why it matters.** Only credit-bureau members may draw reports; CKYC access is for reporting
  entities; Aadhaar e-KYC needs the lender's KUA/sub-KUA, e-KYC Setu or OVSE registration (OVSE
  registration needed since Dec 2025 for offline XML/AVC verification); an unregulated LSP cannot
  be an AA FIU (likely to confirmed in parts; `kyc-aadhaar-bureau.md`, `providers-payments.md` §1,
  §8). Surepass's own licences per endpoint are unverified.
- **Options.** (a) Tri-party agreements (lender–Udofin–vendor) using the lender's credentials.
  (b) Each lender contracts the vendor directly; Udofin integrates as technology provider.
  (c) Keep Udofin's contract for all checks.
- **Recommendation.** (a) or (b), lender's choice. Keep Udofin's own contract only for checks that
  need no membership (PAN verification, bank-account verification, OCR). Do not use (c). Ask
  Surepass in writing whose membership, CERSAI code and AUA/KUA each endpoint uses.
- **Deadline.** Phase 06.

## D-14 Marketing consent and notification strategy

- **Question.** Will Udofin send marketing at all at launch, on which channels (push, SMS,
  WhatsApp, email), and with what consent design?
- **Why it matters.** From 1 Jan 2027, explicit consent is required separately for each product,
  with no bundling or dark patterns, and interfaces must be user-tested and audited (RBC Second
  Amendment Directions of 15 Jun 2026; confirmed, secondary; `rbi-digital-lending.md` §2.3).
  Apple requires explicit opt-in for marketing push and no sensitive data in push (confirmed).
  SMS must use DLT-registered templates (unverified details). Push payloads leave India.
- **Options.** (a) Service messages only at launch. (b) Marketing on one channel with separate
  per-product opt-in. (c) Marketing on all channels.
- **Recommendation.** (a) at launch, with the consent ledger already able to hold per-product,
  per-channel marketing consent; add (b) later. Never market to accounts in collections without
  lender approval.
- **Deadline.** Phase 05.

## D-15 Languages at launch

- **Question.** Which languages for the app, KFS and loan documents at launch?
- **Why it matters.** RBI requires the KFS and loan documents in a language the borrower
  understands (likely; `app-store-mobile.md` §8). Each language multiplies legal review of consent
  text, KFS templates and store listings.
- **Options.** (a) English only. (b) English and Hindi. (c) English, Hindi and one or two regional
  languages chosen by launch geography.
- **Recommendation.** (b), with lenders confirming they can issue KFS and agreements in Hindi;
  build the app so further languages need only translated, reviewed text.
- **Deadline.** Phase 05 (UI copy); Phase 07 (KFS and document templates).

## D-16 Default order of offers and matching logic

- **Question.** What is the default order on the comparison screen (lowest APR, lowest total cost,
  or lowest monthly repayment), and who approves changes to matching rules?
- **Why it matters.** The multi-lender rule requires a neutral, documented, consistent method and
  prohibits steering (confirmed, secondary; `rbi-digital-lending.md` §3.6). Research lists the
  default order as an open policy question (`competitors-ux.md`, open question 7).
- **Options.** (a) Lowest APR, then lowest monthly repayment. (b) Lowest total cost. (c) No
  default; borrower must choose.
- **Recommendation.** (a), disclosed on screen, with user-selectable alternatives; rule changes
  versioned and approved by you and notified to lenders.
- **Deadline.** Phase 06.

## D-17 Equator: domain, brand and independence model

- **Question.** What is Equator's real domain and brand, and how will its independence from Udofin
  be assured if borrowers are ever referred to it?
- **Why it matters.** Research found equator.in indexed as an unrelated facility-management company
  (Equator Property Managers Pvt Ltd); the group's ADR site appears to be Equa.Law (equa.law)
  (confirmed: search index; ownership unverified; `ecosystem-sites.md` §4). An Equator arbitration
  would make an RB-IOS complaint non-maintainable, and a mediation after the lender's final reply
  could use up the 90-day Ombudsman window (`grievance-adr-collections.md` §1, §4). Group
  affiliation raises independence issues (likely). No public evidence was found that Equa/Equator
  is a recognised mediation service provider.
- **Options.** (a) No Equator referral at launch. (b) Optional, post-dispute, mediation-only
  referral with disclosures, separate consent and an unaffiliated alternative. (c) Equator as the
  default escalation step.
- **Recommendation.** (a) at launch, moving to (b) once the domain is verified (WHOIS, DNS, TLS),
  trademark clearance is done and counsel approves the referral wording. Never (c). Keep
  resolution finance and award-enforcement finance away from Equator matters involving
  Udofin-sourced loans.
- **Deadline.** Phase 09.

## D-18 AI provider and hosting

- **Question.** Which AI model provider and hosting will the borrower assistant and staff tools
  use?
- **Why it matters.** Borrower data must stay in India (likely). Amazon Bedrock offers India
  geo cross-Region inference for Claude and OpenAI models processed within Mumbai and Hyderabad
  (confirmed, AWS announcements; `infra-stack.md` §11). Apple requires disclosure and permission
  before sharing personal data with third-party AI (confirmed).
- **Options.** (a) Bedrock India geo inference. (b) A non-India API with personal data stripped
  before every call. (c) No AI at launch.
- **Recommendation.** (a), within the AWS account from D-06; assistant limited to approved FAQ,
  KFS and status; launch only after Phase 09 guardrail tests pass.
- **Deadline.** Phase 09.

## D-19 iOS: Apple's 36% APR rule

- **Question.** On iOS, will Udofin hide any offer above 36% APR, or seek Apple's clarification
  first?
- **Why it matters.** Apple Guideline 3.2.2(ix), fetched in research (last updated 8 Jun 2026),
  says loan apps may not charge a maximum APR above 36% including costs and fees and may not
  require full repayment in 60 days or less (confirmed; `app-store-mobile.md` §3). Yet CRED's and
  Groww's Indian App Store listings show APRs up to 45% and 48% (`competitors-ux.md` §1.4), so the
  rule may not be applied in India in practice (interpretation).
- **Options.** (a) Filter offers above 36% APR on iOS. (b) Ask Apple before the iOS build. (c) Show
  all offers on iOS.
- **Recommendation.** (a) and (b) together: build the platform filter in Phase 06 and ask Apple
  before iOS submission. Not (c).
- **Deadline.** Phase 06 (filter); iOS release after Android.

## D-20 Borrower web experience

- **Question.** Will there be a borrower web channel, and when?
- **Why it matters.** A borrower web portal is also a DLA that each lender must report (likely). It
  is useful for servicing, disclosures and iOS users but is not a route around store rules
  (`app-store-mobile.md` §9).
- **Options.** (a) Public information website only at launch. (b) Servicing web after the mobile
  MVP. (c) Full web origination at launch.
- **Recommendation.** (a) at launch (lenders, grievance contacts, privacy policy), then (b).
- **Deadline.** After Phase 11; (a) before Phase 11.

## D-21 Field-agent app

- **Question.** Build a field-agent app for assisted onboarding or collections?
- **Why it matters.** It adds a second device channel with its own permissions, conduct rules and
  audit needs.
- **Options.** (a) Defer. (b) Build when a lender needs assisted onboarding.
- **Recommendation.** (a); revisit only on a signed lender requirement.
- **Deadline.** None now.

## D-22 Personal "books of accounts" feature

- **Question.** Keep the personal expense / books-of-accounts idea?
- **Why it matters.** It would need transaction data. Reading SMS or files is barred for loan
  apps, an LSP may store only minimal data, and AA data needs a regulated FIU (likely;
  `rbi-digital-lending.md`, challenge 7). Reusing loan data for it breaks purpose limitation.
- **Options.** (a) Drop. (b) Later, as a separate opt-in product with its own consent, using AA
  through a regulated FIU, stored separately and never used for lending without separate consent.
- **Recommendation.** (a) for the MVP; the loan hub shows Udofin-facilitated loans only. Revisit
  (b) after launch.
- **Deadline.** Before Phase 10 planning.

## D-23 Confirm payday loans are not supported

- **Question.** Confirm that payday / very short-tenor loans are dropped.
- **Why it matters.** Google Play prohibits apps promoting personal loans requiring full repayment
  in 60 days or less; Apple has the same rule plus the 36% APR rule (confirmed). Offering it risks
  removal of the whole app. An Aug 2026 draft proposes an APR cap on loans up to ₹50,000 (draft;
  cap level unverified). The database already marks `payday` as `not_supported` and enforces a
  61-day minimum floor in every category.
- **Options.** (a) Drop. (b) Small-ticket loans above 60 days with transparent APR.
- **Recommendation.** (a); if a small-ticket product is needed, (b) under the personal-loan
  category with its 91-day floor.
- **Deadline.** Phase 04 (product catalogue communicated to lenders).

## D-24 Device-integrity enforcement policy

- **Question.** How strictly should Play Integrity / App Attest verdicts block users?
- **Why it matters.** Strict enforcement reduces fraud but can exclude borrowers with older or
  uncertified devices; Google advises tiered enforcement and not relying on it alone (confirmed;
  `app-store-mobile.md` §5).
- **Options.** (a) Block only on failed basic integrity. (b) Tiered: allow with limits, step-up
  OTP or assisted channel. (c) Block anything below strong integrity.
- **Recommendation.** (b), with server-side verification bound to high-risk actions (offer
  acceptance, eSign start, bank-account change, mandate creation).
- **Deadline.** Phase 05.

## D-25 Record-retention schedule

- **Question.** How long are each record type kept, by whom, and how are deletion requests handled
  when law requires retention?
- **Why it matters.** The LSP may store only minimal data; lenders keep KYC and loan records;
  CERT-In requires 180 days of logs in India (likely); DPDP Rules add log retention of at least
  one year from 2027 (likely); research recommends 1 year hot plus 2 years archive for security
  logs (`privacy-security-outsourcing.md`).
- **Options.** (a) Adopt research recommendations, then agree per-lender overrides. (b) Wait for
  each lender's schedule.
- **Recommendation.** (a), reviewed by counsel (D-05), recorded in `docs/data/ownership.md`.
- **Deadline.** Phase 07 (document lifecycle); Phase 09 (complaint evidence).

## D-26 Ecosystem boundaries and conflict disclosures

- **Question.** Do you accept separate databases, deployments and consents for Udofin, Finbyx,
  LawDocsComply and Equator, staff SSO with segregation of duties, no group-wide borrower view, and
  disclosure of group affiliation to lenders that use Finbyx or LawDocsComply?
- **Why it matters.** Lenders using LawDocsComply or Finbyx would have their oversight of Udofin,
  or competitors' loan data, on group platforms; a group "single customer view" breaches purpose
  limitation (interpretation and likely; `ecosystem-sites.md` §6.3).
- **Options.** (a) Accept as described. (b) Allow limited shared services (for example shared
  staff identity provider) with written controls.
- **Recommendation.** (a); (b) only for staff identity, with role-conflict rules.
- **Deadline.** Disclosures before Phase 04 contracts; integration in Phase 10.

## D-27 Membership of the fintech SRO (FACE)

- **Question.** Should Udofin join FACE, the fintech self-regulatory organisation?
- **Why it matters.** Lenders increasingly use FACE codes (for example its 29 Aug 2025 debt-recovery
  guidelines) in LSP due diligence (`rbi-digital-lending.md` §3.14 and open questions).
- **Options.** (a) Join before launch. (b) Decide after launch.
- **Recommendation.** Ask launch lenders whether they expect it; decide before Phase 11.
- **Deadline.** Before Phase 11.

## D-28 Disaster-recovery posture for a regional outage

- **Question.** What recovery targets do you accept, and how should Udofin recover if the whole
  Mumbai region is unavailable?
- **Why it matters.** Supabase lists only ap-south-1 for India, so in-country DR to a second Indian
  region is not available on Supabase itself (likely; `infra-stack.md` §3). AWS offers its main
  services in both Mumbai and Hyderabad (confirmed). Proposed targets are in
  [`../operations/deployment.md`](../operations/deployment.md) §8.
- **Options.** (a) Single region with PITR, documented manual recovery and a longer regional RTO.
  (b) Later move the database to Aurora with a cross-region replica in Hyderabad. (c) Accept
  offshore DR (not recommended: residency).
- **Recommendation.** (a) at launch, with (b) reviewed once volumes justify it.
- **Deadline.** Phase 11 (DR drill targets).
