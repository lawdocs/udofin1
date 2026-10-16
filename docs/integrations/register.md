# Integration register and adapter ports

Status: working draft, 2026-10-10. Owner: product owner (integration architecture). Scope: every external
system Udofin will call or be called by, who must hold each contract, and the interface each adapter in
`packages/adapters` must implement.

> **Research limitation (applies to every regulatory statement in this document).** During research the
> sandbox could not open rbi.org.in or other primary sources (WebFetch DNS failure; the proxy blocked
> HTTPS), and the shared web-search budget ran out. Findings rest on search snippets, vendor pages and
> secondary sources (law firms, press). Every regulatory reference below (RBI, UIDAI, MeitY, NPCI, TRAI,
> CERSAI, SEBI) must be checked against the primary text before it is relied on for a contract, a policy
> or a launch. **This check is a release gate** (Phase 11, decision D-05). Vendor capabilities are vendor
> claims until the vendor confirms them in writing.

This register does not say that Udofin is compliant with anything. For each integration it records the
control Udofin intends to build, the evidence that control produces, and what remains to verify.

Sources: `docs/research/2026-10-10/providers-payments.md`, `kyc-aadhaar-bureau.md`, `infra-stack.md`,
`ecosystem-sites.md`, `competitors-ux.md`, `grievance-adr-collections.md`; schema in
`supabase/migrations/`; contracts in `packages/contracts/src/`; phases in `docs/product/roadmap.md`;
decisions (D-nn) in `docs/product/open-decisions.md`.

---

## 1. How to read the register

**Contract holder.**

- **RE** means the partner lender (the regulated entity). The RE holds the licence, membership or
  merchant account, and the contract is in its name (or is tri-partite RE–Udofin–vendor). Udofin runs the
  user interface and orchestration as the RE's technology service provider (TSP) and processor, using
  credentials the RE supplies. Results are stored only in the lender's systems or in lender-scoped
  encrypted storage (per-lender keys, Phase 06).
- **Udofin** means Udofin may hold the contract in its own name, because no regulated eligibility is
  needed and the data stays within what an LSP may keep.

**Research status** carries the label from the research note: **confirmed** (primary or vendor source
read), **likely** (consistent secondary sources), **interpretation** (the researcher's reading),
**unverified** (could not be checked). Where a row mixes statuses, each part is labelled.

**Phase** uses the numbering in `docs/product/roadmap.md` (Phases 01–11 and the specialist-products track
S1, S1b, S2…). Some code comments still use older numbers (for example "Phase 9" for Udofin's own books,
which is Phase 10 in the roadmap); the roadmap wins.

**Fixed boundaries that every row follows** (architecture decisions):

1. No Udofin pool, escrow or pass-through account. Repayments settle into the RE's account under the RE's
   own merchant or mandate credentials. Disbursement goes from the RE's account to the borrower's verified
   account (exceptions only as the RBI rules allow: co-lending, statutory, specific end-use beneficiary).
2. KYC, CKYC, bureau and Account Aggregator calls run under each RE's credentials. Udofin does no
   "soft pull" and no Aadhaar authentication in its own name. No biometrics are stored. Aadhaar numbers
   are never stored by Udofin.
3. Udofin is not the loan system of record. The RE's LMS (Finbyx or third-party) owns balances, schedules,
   allocation and accounting; Udofin keeps an immutable read model and reconciles.
4. Stripe and PayPal are excluded for domestic repayments (Stripe invite-only in India since May 2024,
   **confirmed** via Stripe's help page; PayPal domestic India payments ended 1 Apr 2021, **confirmed**
   by secondary sources).

---

## 2. Register

| ID     | Capability                                                                                                                                                  | Candidate providers                                                                                                                                                                                               | Contract holder                                                                                                      | Legal / eligibility gate                                                                                                                                                                                                                                                     | Auth method                                                                                           | Sandbox                                                    | Webhooks & signature                                                                              | Idempotency & reconciliation                                                                                                                                                                                                                                                                                                                                                                                                                    | Data residency notes                                                                                                                                                                                    | Phase                                                                    | Research status                                                                                                                        | Risks / open questions                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INT-01 | Aadhaar-based KYC through the lender's route (online e-KYC via the RE's KUA/sub-KUA or NPCI e-KYC Setu; offline XML / AVC under the RE's OVSE registration) | Surepass (Aadhaar OTP endpoint not confirmed; Surepass's own page says clients need an AUA/KUA licence); Cashfree and PayU (generate/submit OTP pattern in their docs); Digio, Signzy; NPCI e-KYC Setu (RE route) | **RE**                                                                                                               | Aadhaar Act s.4(4); PMLA s.11A notification, or the RE's use of NPCI e-KYC Setu; sub-KUA needs prior UIDAI approval (UIDAI Circular 02/2025); offline XML / AVC verifiers must register as OVSE (Reg 13A, Dec 2025 amendment). An LSP is not a PMLA reporting entity.        | Bearer / API key plus client id, issued per RE                                                        | Yes (vendors)                                              | Some vendors; signing unverified                                                                  | Provider reference id stored per attempt; at most one e-KYC per application per RE; result written to lender-scoped storage                                                                                                                                                                                                                                                                                                                     | Results only in RE-controlled storage in India; Aadhaar number never stored by Udofin; no biometrics                                                                                                    | 06                                                                       | Legal gate: likely (online-auth restriction marked confirmed in KYC research, KYC-02); OVSE rule: likely; vendor endpoints: unverified | Which launch REs are s.11A-notified, KUA/sub-KUA, Setu users or registered OVSEs (D-03, D-13); OTP e-KYC loan cap of ₹60,000 a year and full CDD within one year (likely); Surepass's AUA/KUA chain unknown                                                 |
| INT-02 | DigiLocker (issued documents, Aadhaar XML)                                                                                                                  | Surepass Digiboost web SDK; DigiLocker partner APIs via aggregators                                                                                                                                               | **RE** as DigiLocker Requester (or the RE's KYC vendor); Udofin as TSP                                               | DigiLocker Requester onboarding via API Setu; for lending KYC the RE must verify the digital signature and take a live photo (KYC-07, likely); Aadhaar XML via DigiLocker may need OVSE registration (interpretation)                                                        | Bearer; SDK session token valid 600 s by default                                                      | Yes (`sandbox.surepass.app`)                               | Optional `webhook_url` receives `{client_id, status, type}`; **unsigned**; retries undocumented   | Poll status by `client_id` as source of truth; webhook is a hint; hash and keep the signed XML/PDF in lender-scoped storage                                                                                                                                                                                                                                                                                                                     | Lender-scoped storage only; Surepass hosting location unverified                                                                                                                                        | 06                                                                       | SDK facts: confirmed (vendor GitHub README); legal gate: likely                                                                        | Surepass uses two domains (`.io`, `.app`), confirm current one; NeGD draft "Specialized Ecosystem Enablement Partners" RFE (21 Sep 2026) is a draft only                                                                                                    |
| INT-03 | CKYC (CKYCR search, download, upload)                                                                                                                       | Surepass (search, download, card verification, legal-entity CKYC), Signzy, direct CERSAI                                                                                                                          | **RE** (registered reporting entity)                                                                                 | PML Rules r.9; CERSAI operating guidelines; OTP-based customer consent for downloads (vendor-reported, around Apr 2025); 29 Dec 2025 reliance amendment (RE that last uploaded verifies identity/address; the relying RE keeps all other CDD)                                | Vendor token plus the RE's FI code / digital signature                                                | Partly                                                     | No                                                                                                | Log CKYC identifier, last uploading RE and download time per RE in lender-scoped storage; Udofin may display the KYC identifier only                                                                                                                                                                                                                                                                                                            | Lender-scoped storage only                                                                                                                                                                              | 06                                                                       | Likely; CKYC 2.0 "from 1 Aug 2026": unverified                                                                                         | Using a vendor's or another FI's CERSAI credentials; upload timelines reported inconsistently (10 days vs 3 working days, unverified); CERSAI API public key replaced from 7 Nov 2025 (secondary)                                                           |
| INT-04 | PAN verification                                                                                                                                            | Surepass (listed in its llms.txt), Cashfree, Signzy, Protean (Online PAN Verification)                                                                                                                            | **RE preferred** (see risks)                                                                                         | Protean OPV is for ITD-authorised categories (banks, RBI-registered NBFCs, HFCs and others); no LSP category was seen                                                                                                                                                        | Bearer                                                                                                | Yes                                                        | No (synchronous)                                                                                  | Cache result with a TTL in lender-scoped storage; PAN only masked in any Udofin record                                                                                                                                                                                                                                                                                                                                                          | Lender-scoped storage                                                                                                                                                                                   | 06                                                                       | Surepass PAN: likely; OPV eligibility: interpretation                                                                                  | **Research conflict:** `providers-payments.md` says Udofin may contract PAN checks; `kyc-aadhaar-bureau.md` (PAN-01) says run them through the RE's OPV registration or an RE-contracted vendor. Resolve with counsel (D-13). PAN 2.0 may change endpoints. |
| INT-05 | Bank account verification (penny drop, penny-less, reverse penny drop, UPI VPA check)                                                                       | Surepass, Cashfree Verification Suite, Signzy, RazorpayX, Decentro                                                                                                                                                | RE or Udofin (research allows either); **RE recommended** where the result binds the disbursal and mandate account   | No specific licence gate found; the penny-drop money movement is the vendor's                                                                                                                                                                                                | Bearer / basic                                                                                        | Yes                                                        | Some asynchronous callbacks; signing unverified                                                   | Verification id as provider key; bind the verified account to the loan; re-verify on any change; reverse-penny-drop refunds tracked (Cashfree states refund within 48 hours)                                                                                                                                                                                                                                                                    | Account numbers only in lender-scoped storage, encrypted                                                                                                                                                | 07                                                                       | Vendor docs: confirmed (vendor docs via search)                                                                                        | Name-match false positives (fuzzy score plus manual review band); beneficiary-name lookup for NEFT/RTGS unverified                                                                                                                                          |
| INT-06 | Credit bureaus (CIBIL, Experian, Equifax, CRIF)                                                                                                             | Surepass multi-bureau and per-bureau APIs (its CIBIL page says it "does not provide credit reports", implying the client's own membership); direct bureau APIs; bureaus are reported live on ULI (lender side)    | **RE** (credit institution / CIC member)                                                                             | CICRA 2005 s.17(4); CIC Regulations 2006 reg 9; CIC Directions 2025. A specified user may not pass reports on; Udofin cannot realistically qualify (₹2 crore net worth, 3 years' processing experience and other criteria)                                                   | Member credentials via vendor                                                                         | Vendor sandbox                                             | No                                                                                                | One enquiry per (application, bureau); enquiry id logged; duplicate enquiries blocked to avoid enquiry inflation across REs                                                                                                                                                                                                                                                                                                                     | Report goes to the RE's LOS, or to lender-scoped encrypted storage where Udofin acts as the RE's processor (Phase 06); never into Udofin's core schemas; no other lender, module or product can read it | 06                                                                       | CIC-01: confirmed in research table (primary not fetched); eligibility criteria: likely                                                | Each underwriting RE creates its own enquiry; "soft pull" is not a regulatory concept in India (interpretation); bureau consent wording per RE                                                                                                              |
| INT-07 | Account Aggregator                                                                                                                                          | AAs (Finvu, OneMoney, Anumati, CAMS Finserv and others)                                                                                                                                                           | **RE as FIU**; Udofin as TSP                                                                                         | FIU must be regulated by a financial-sector regulator (NBFC-AA Master Direction 2016); consent names each RE that sees data                                                                                                                                                  | ReBIT spec, JWS, keys                                                                                 | Sahamati sandbox (unverified)                              | Consent and FI notifications                                                                      | Consent handle per RE; purge on data-life expiry                                                                                                                                                                                                                                                                                                                                                                                                | Decrypted data only in the RE's environment, or in lender-scoped storage as the RE's processor under contract                                                                                           | 06 (optional for MVP)                                                    | Likely; Sahamati as SRO from 5 Jun 2026: likely (secondary)                                                                            | Multi-lender consent scoping; an LSP acting as FIU                                                                                                                                                                                                          |
| INT-08 | RBIH Unified Lending Interface (ULI)                                                                                                                        | RBIH                                                                                                                                                                                                              | **RE**                                                                                                               | Onboarding is for REs; no source showed LSPs connecting directly (interpretation)                                                                                                                                                                                            | RBIH-issued                                                                                           | Unverified                                                 | Unverified                                                                                        | Not applicable to Udofin                                                                                                                                                                                                                                                                                                                                                                                                                        | Not applicable                                                                                                                                                                                          | No Udofin adapter; RE-side (possibly via Finbyx as the RE's TSP)         | Providers note: unverified; scale figures: confirmed (secondary)                                                                       | Whether RBIH allows an LSP or Finbyx as a technology partner; design the application model so RE-side ULI pulls can replace uploads                                                                                                                         |
| INT-09 | eSign                                                                                                                                                       | ASPs: Leegality, Digio, SignDesk, Signzy, Surepass; ESPs: eMudhra, Protean and others on the CCA list                                                                                                             | RE or Udofin as ASP customer; **evidence owned by the RE**                                                           | IT Act 2000 s.3A and Second Schedule (eSign only via CCA-empanelled ESP); First Schedule exclusions (immovable-property conveyance, POA, trusts, wills, negotiable instruments other than cheques)                                                                           | API key / OAuth                                                                                       | Yes                                                        | Completion, failure, expiry callbacks (vendor claims); signing per vendor, unverified             | One signing request per document version; keep document hash before and after, ESP transaction id, signer certificate, audit trail; verify the PDF signature server-side                                                                                                                                                                                                                                                                        | Signed documents in S3 ap-south-1 under the lender's key; not Supabase Storage (CDN caching risk)                                                                                                       | 07                                                                       | Likely; current CCA ESP list unverified                                                                                                | Mortgage/LAP documents need physical or registration workflows; which ESP sits behind the ASP; ESP outage fallback                                                                                                                                          |
| INT-10 | eStamp / NeSL Digital Document Execution (DDE)                                                                                                              | SHCIL (via aggregators), NeSL DDE, Leegality, Digio, SignDesk; no Surepass eStamp API found                                                                                                                       | **RE** (party and stakeholder in enforceability)                                                                     | State stamp acts / Indian Stamp Act 1899; NeSL only in states that authorised it                                                                                                                                                                                             | Aggregator API                                                                                        | Limited                                                    | Yes (aggregators)                                                                                 | Certificate number linked to loan id; reconcile stamp-duty spend with the RE                                                                                                                                                                                                                                                                                                                                                                    | Certificates and duty ledger in lender scope                                                                                                                                                            | 07                                                                       | Likely; NeSL state coverage: unverified                                                                                                | Wrong state or article; pre-bought stamp paper; fallback for uncovered states; RE approves the stamping matrix (state x product x article)                                                                                                                  |
| INT-11 | Payment gateway for one-time repayment, part-prepayment, foreclosure, overdue links                                                                         | Razorpay, Cashfree, PayU, Juspay (orchestration). **Excluded:** Stripe, PayPal                                                                                                                                    | **RE** as merchant of record (Udofin via partner/sub-merchant access or RE-delegated keys)                           | RBI payment-aggregator authorisation (check RBI's list); DL flow-of-funds rule (no LSP pass-through or pool); no split settlement to Udofin; new-merchant video KYC from 1 Jan 2026 (per Stripe help pages, likely)                                                          | API key plus secret per RE                                                                            | Yes                                                        | Yes; HMAC per provider (verify each provider's scheme)                                            | `payments.payment_intents.idempotency_key` unique per lender; `(provider, provider_order_ref)` unique; `payments.provider_events` de-duplicated on `(provider, provider_event_id)`; settlement reconciled by UTR against the RE's settlement report and bank statement, then against the LMS posting                                                                                                                                            | Payment intents in Supabase Mumbai; raw webhook payloads not stored (hash only)                                                                                                                         | 08 (schema exists in `20261010000500_servicing_payments.sql`)            | Likely (provider docs not fetched); Stripe/PayPal exclusion: confirmed                                                                 | Udofin becoming merchant of record; whether the 2023 FAQ pure-PA allowance survives the 2025 Directions (open); who bears PA fees                                                                                                                           |
| INT-12 | eNACH / API e-Mandate / UPI AutoPay                                                                                                                         | Razorpay, Cashfree, Digio, PayU, Worldline/Paynimo, Decentro                                                                                                                                                      | **RE** (NACH utility via sponsor bank; settlement to RE)                                                             | NPCI NACH procedures; RBI e-mandate framework (pre-debit notice at least 24 h; additional authentication above ₹15,000 for EMIs): **unverified**                                                                                                                             | API keys per RE                                                                                       | Yes                                                        | Mandate status and debit status callbacks; signing per provider                                   | UMRN linked to loan; one presentation per instalment id; daily reconciliation of NPCI return codes and sponsor-bank MIS                                                                                                                                                                                                                                                                                                                         | Mandate records in lender scope                                                                                                                                                                         | 08 (pulled into 07 if a lender requires the mandate before disbursement) | Likely; amount caps, AFA thresholds, retry windows: unverified                                                                         | Mandate in Udofin's name; over-presentation; borrower revocation through their bank; one mandate per loan per RE when a borrower has loans from several REs; bounce charges are penal charges disclosed in the KFS                                          |
| INT-13 | Disbursement / payouts                                                                                                                                      | RE's own corporate banking APIs; RazorpayX or Cashfree Payouts only in a mode that debits the RE's own current account                                                                                            | **RE**                                                                                                               | DL rule: disbursal to the borrower's account, with stated exceptions (likely, secondary)                                                                                                                                                                                     | Bank certificates / API keys                                                                          | Bank UAT                                                   | Yes                                                                                               | **Udofin does not move money.** It sends the disbursement instruction to the RE's system (LMS `createLoan` or the RE's disbursement API) naming only the verified account, and records the LMS-reported evidence (date, amount, bank reference all-or-nothing in `servicing.loan_accounts`). If an RE ever asks Udofin to orchestrate payouts from the RE's own account: idempotency key = loan id; status enquiry before any retry; UTR stored | Evidence in Supabase Mumbai                                                                                                                                                                             | 07                                                                       | Likely; IMPS/RTGS limits: unverified; payout-provider mode: interpretation                                                             | Pre-funded payout account controlled by Udofin would be a pass-through; wrong beneficiary; end-use beneficiary only with a lender exception flag and reason                                                                                                 |
| INT-14 | BBPS biller / virtual accounts / static VPAs                                                                                                                | Bank VANs, Razorpay Smart Collect, Cashfree Auto Collect, BBPS BBPOUs                                                                                                                                             | **RE**                                                                                                               | RE onboarding as BBPS "Loan Repayment" biller; accounts in the RE's name                                                                                                                                                                                                     | API keys                                                                                              | Yes                                                        | Yes                                                                                               | One virtual account per loan gives automatic matching; partial payments allocated by the RE's LMS under its appropriation policy                                                                                                                                                                                                                                                                                                                | Lender scope                                                                                                                                                                                            | 08 or later                                                              | Likely                                                                                                                                 | Partial-payment allocation; borrower confusion between several REs' accounts                                                                                                                                                                                |
| INT-15 | Shares pledge (NSDL / CDSL) for loan against securities                                                                                                     | NSDL, CDSL via the RE's depository participant                                                                                                                                                                    | **RE** (pledgee demat account)                                                                                       | SEBI (Depositories and Participants) Regulations 2018; only the lender can be pledgee; SEBI "margin pledge" is a different regime                                                                                                                                            | Depository / DP credentials                                                                           | Unverified                                                 | Unverified                                                                                        | Pledge sequence number linked to loan; daily price feed and LTV monitoring are the RE's                                                                                                                                                                                                                                                                                                                                                         | Lender scope                                                                                                                                                                                            | S1b (LAS on shares)                                                      | Likely                                                                                                                                 | Which REs are onboarded as pledgee; invocation process; LTV rules belong to the RE's credit policy                                                                                                                                                          |
| INT-16 | Mutual fund lien (CAMS, KFintech, MF Central)                                                                                                               | CAMS, KFintech, MF Central                                                                                                                                                                                        | **RE** (lien holder)                                                                                                 | RTA lien process in favour of the lender; demat MF units use the depository pledge route                                                                                                                                                                                     | RTA credentials                                                                                       | Unverified                                                 | Unverified                                                                                        | Lien reference linked to folio and loan; auto-prompt lien release at closure (a competitor's documented gap)                                                                                                                                                                                                                                                                                                                                    | Lender scope                                                                                                                                                                                            | S1 (LAMF, MVP; D-09)                                                     | Likely; OTP to folio-registered mobile and about 10-minute lien marking: confirmed (competitor vendor page)                            | RTA onboarding of each RE; partial lien release                                                                                                                                                                                                             |
| INT-17 | LMS: Finbyx (group product)                                                                                                                                 | Finbyx                                                                                                                                                                                                            | **RE** (Finbyx is the RE's processor under the RE's outsourcing contract)                                            | RBI outsourcing of IT services expectations (likely); data stored in India                                                                                                                                                                                                   | mTLS plus OAuth2 client credentials or API key (proposed; see `docs/api/integration-contracts.md` §4) | Must provide one (requirement)                             | Signed CloudEvents callbacks (`in.finbyx.*`)                                                      | Connector contract: idempotent create calls; callbacks de-duplicated on `(source, id)`; nightly changes-feed sweep; read model compared with LMS                                                                                                                                                                                                                                                                                                | **Finbyx's Supabase project is in ap-northeast-1 (Tokyo)** (confirmed via Management API); must be recreated in ap-south-1 before any real data (D-04); if it ever held real data, treat as an incident | 06 (decision intake), 08 (servicing sync); blocked until D-04            | Tokyo project: confirmed; public footprint: confirmed absent (search)                                                                  | Finbyx must expose the same API to any LSP, with no Udofin-only back channel; information barriers because Finbyx may hold competitors' loan books (D-26)                                                                                                   |
| INT-18 | LMS: third-party (lender's own LMS)                                                                                                                         | Each RE's LMS vendor                                                                                                                                                                                              | **RE**                                                                                                               | As INT-17                                                                                                                                                                                                                                                                    | As agreed per RE (mTLS / OAuth2 / signed requests)                                                    | Per RE                                                     | Per RE; must meet the connector contract or be wrapped by an adapter                              | Same connector contract; adapter maps native formats; nightly sweep                                                                                                                                                                                                                                                                                                                                                                             | RE's responsibility; Udofin checks region in due diligence                                                                                                                                              | 06 / 08, per RE                                                          | Interpretation (no vendor researched)                                                                                                  | `EVENT_TYPE_PATTERN` admits only four product prefixes, so a third-party LMS cannot emit `in.<product>.*` events in its own name (see integration contracts §4.3)                                                                                           |
| INT-19 | Accounting export: Tally Prime                                                                                                                              | TallyPrime (XML, reportedly JSON in recent releases, over HTTP to a running instance, default port 9000; TDL; ODBC)                                                                                               | Book owner: **Udofin** for its own books; each RE for its own                                                        | None specific                                                                                                                                                                                                                                                                | None (local instance)                                                                                 | Local                                                      | No                                                                                                | Voucher `GUID` / `REMOTEID` built from Udofin's journal id; daily summarised vouchers; connector reports results back                                                                                                                                                                                                                                                                                                                           | On-premise connector at the book owner; export files contain no borrower PII                                                                                                                            | 10                                                                       | Likely; JSON support: unverified                                                                                                       | No hosted multi-tenant API; connector security; never mix RE and Udofin entries                                                                                                                                                                             |
| INT-20 | Accounting export: SAP                                                                                                                                      | SAP S/4HANA Journal Entry posting (SOAP in S/4HANA Cloud; BAPI or IDoc on-premise); OData read-back                                                                                                               | Book owner                                                                                                           | None specific                                                                                                                                                                                                                                                                | OAuth / basic / certificate                                                                           | Customer QA systems                                        | No                                                                                                | External reference / document header text as idempotency key; reconcile by posting date and company code                                                                                                                                                                                                                                                                                                                                        | Customer-hosted                                                                                                                                                                                         | 10                                                                       | Likely                                                                                                                                 | S/4 edition differences; GL mapping per entity                                                                                                                                                                                                              |
| INT-21 | SMS (DLT) for service messages                                                                                                                              | MSG91, Gupshup, Kaleyra, Route Mobile, Karix, Twilio (India traffic still needs DLT registration)                                                                                                                 | **Udofin** as Principal Entity for its own messages; loan-servicing SMS should name the RE (RE headers or templates) | TRAI TCCCPR 2018 and later directions: registered headers and templates; URL/APK/call-back whitelisting; PE-TM chain traceability; Feb 2025 amendment (all **unverified**)                                                                                                   | API key                                                                                               | Limited                                                    | Delivery reports; signing per provider                                                            | Template id per message; notification id as provider key; DLR reconciliation                                                                                                                                                                                                                                                                                                                                                                    | Indian providers; hosting unverified per provider                                                                                                                                                       | 08 (reminders)                                                           | Likely; TRAI details: unverified                                                                                                       | Template mismatch blocks delivery; RE-branded templates need RE registration; reminder content must follow recovery-conduct rules                                                                                                                           |
| INT-22 | Supabase Auth Send SMS hook (login OTP)                                                                                                                     | Supabase Auth hook calling a DLT SMS provider (Supabase docs name MSG91 for India)                                                                                                                                | **Udofin** (D-02: legal entity as DLT principal entity)                                                              | DLT registration of header and OTP template (unverified details)                                                                                                                                                                                                             | Supabase signs hook calls with Standard Webhooks (`v1,whsec_…` secret); provider API key outbound     | Local / staging project                                    | Hook is itself an inbound webhook; verify signature                                               | De-duplicate on the webhook id so a retried hook does not send a second SMS; provider message id logged without phone or OTP                                                                                                                                                                                                                                                                                                                    | Hook must run in India: Edge Functions run nearest the caller unless pinned, so pin to ap-south-1 or implement in the API in Mumbai                                                                     | 05                                                                       | Confirmed (Supabase docs source)                                                                                                       | 5-second total budget including retries; Supabase retries at most three times, only on 429/503 with `retry-after`; provider timeout under 3 s; queue a fallback provider asynchronously; append the Android app hash for SMS Retriever                      |
| INT-23 | WhatsApp                                                                                                                                                    | Meta Cloud API, Gupshup, Kaleyra, Twilio                                                                                                                                                                          | **Udofin** (WhatsApp Business account); RE named in content                                                          | Prior opt-in naming the business; Meta-approved templates by category (marketing, utility, authentication); separate marketing consent                                                                                                                                       | Bearer (system user)                                                                                  | Test numbers                                               | Yes; signature scheme unverified                                                                  | Message id plus template version                                                                                                                                                                                                                                                                                                                                                                                                                | Unverified (Meta and BSP hosting not researched)                                                                                                                                                        | Not scheduled (optional; D-14)                                           | Likely                                                                                                                                 | Proof of opt-in; utility vs marketing category; recovery-conduct rules for reminders                                                                                                                                                                        |
| INT-24 | Email                                                                                                                                                       | **Not researched.** Supabase Auth offers a Send Email hook (confirmed) for authentication email                                                                                                                   | **Udofin**                                                                                                           | Marketing consent for promotional email (DPDP, likely)                                                                                                                                                                                                                       | Not researched                                                                                        | Not researched                                             | Not researched                                                                                    | Notification id as provider key; bounce handling                                                                                                                                                                                                                                                                                                                                                                                                | Choose an option that processes in India, or keep email content free of loan data                                                                                                                       | 03 (staff sign-in email), 08 (service email)                             | Unverified (no provider evaluated)                                                                                                     | Provider selection pending; residency of message content                                                                                                                                                                                                    |
| INT-25 | Push (Expo push service to FCM / APNs)                                                                                                                      | Expo push service; direct FCM / APNs possible with native tokens                                                                                                                                                  | **Udofin**                                                                                                           | Separate consent for marketing push; Android 13+ runtime notification permission                                                                                                                                                                                             | Expo access token ("enhanced push security"); FCM v1 and APNs credentials                             | Development builds only (Expo Go has no push since SDK 53) | No webhooks; push receipts polled about 15 minutes after send, deleted after 24 h                 | Ticket id per message; receipt check; disable token on `DeviceNotRegistered`; up to 100 messages per request and 600 per second per project                                                                                                                                                                                                                                                                                                     | **Payloads are processed outside India.** Payload carries only a generic title and an opaque deep-link id, never loan data or PII                                                                       | 05 (tokens), 08 (reminders)                                              | Confirmed (Expo docs source); residency conclusion: interpretation                                                                     | A CI test must fail on any push payload with amounts, names or identifiers                                                                                                                                                                                  |
| INT-26 | LawDocsComply (group GRC product)                                                                                                                           | LawDocsComply                                                                                                                                                                                                     | Each legal entity is its own LDC tenant (Udofin, each RE, Finbyx, Equator)                                           | No borrower PII crosses this boundary (design rule)                                                                                                                                                                                                                          | OAuth2 client credentials or mTLS plus API key (proposed)                                             | Must provide one                                           | Signed CloudEvents both ways (`in.udofin.compliance_evidence.*`, `in.lawdocscomply.obligation.*`) | Evidence events de-duplicated on `(source, id)`; pull API for re-sync                                                                                                                                                                                                                                                                                                                                                                           | LDC hosting region not reviewed; must be India                                                                                                                                                          | 10 (D-26)                                                                | Product modules: confirmed (site snippets); contract: recommendation                                                                   | If REs use LDC for oversight of Udofin, the group sees that oversight: tenant isolation, per-tenant keys, no Udofin staff access, affiliation disclosure                                                                                                    |
| INT-27 | Equator (group ADR / ODR)                                                                                                                                   | Equator; the group's public ODR platform appears to be Equa / Equa.Law (`equa.law`), **not** `equator.in` (indexed as an unrelated facility-management company)                                                   | Equator is an independent data fiduciary; the borrower initiates                                                     | RB-IOS 2026 (in force 1 Jul 2026): complaint not maintainable if pending/decided before an arbitrator or other forum; 90-day filing window; RE has 30 days first (confirmed via RBI FAQ / RE-published features extracts). Mediation Act 2023 and A&C Act 1996 s.12 (likely) | Borrower-held one-time consent token; server-to-server mTLS plus API key (proposed)                   | Must provide one                                           | Status callbacks only with borrower consent (`in.equator.case.status_changed.v1`)                 | Referral id; token single-use                                                                                                                                                                                                                                                                                                                                                                                                                   | Equator hosting region not reviewed; must be India                                                                                                                                                      | 09 (D-17)                                                                | Domain finding: confirmed (search index); legal status: unverified                                                                     | Domain, brand and trademark must be confirmed before any link ships; mediation-only, opt-in, post-dispute; affiliation disclosed; unaffiliated alternative offered; no pre-dispute clauses in retail loan documents                                         |
| INT-28 | AI inference (assistive only)                                                                                                                               | Amazon Bedrock "India geo" cross-Region inference (Claude and OpenAI models processed in Mumbai and Hyderabad)                                                                                                    | **Udofin**                                                                                                           | RBI FREE-AI report (Aug 2025, recommendations): disclose AI, offer a human, no credit decisions (likely, non-binding); India data storage                                                                                                                                    | AWS IAM (ap-south-1)                                                                                  | Not applicable                                             | Not applicable                                                                                    | Inference id per call; transcripts kept as records                                                                                                                                                                                                                                                                                                                                                                                              | India-hosted inference only; PII redaction before prompts; no raw KYC or bureau data                                                                                                                    | 09 (D-18)                                                                | Bedrock India inference: confirmed (AWS announcements); FREE-AI: likely                                                                | Mis-selling or wrong figures; complaint intent must open a ticket immediately; provider choice is open (D-18)                                                                                                                                               |
| —      | Stripe, PayPal                                                                                                                                              | —                                                                                                                                                                                                                 | —                                                                                                                    | Not suitable for domestic INR loan collections                                                                                                                                                                                                                               | —                                                                                                     | —                                                          | —                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                       | Excluded                                                                 | Confirmed (see §1)                                                                                                                     | May be used only for Udofin's own cross-border B2B billing if ever needed                                                                                                                                                                                   |

### 2.1 Controls that apply across rows

| Control                                                                                                                                                                                                                                                                                                                                                                           | Rows          | Evidence produced                                                                                            | Still to verify                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Lender capability registry**: per-RE flags such as `s11a_notified`, `kua_mode`, `setu_enabled`, `ovse_registered`, `digilocker_requester`, `cersai_registered`, `opv_registered`, `bureau_memberships[]`, `aa_fiu_id`, `pa_merchant`, `nach_utility`. A KYC or bureau option is shown only if the flag is set and the supporting document is on file (research KYC-02, AAD-01). | 01–07, 11–16  | Registry history with the uploaded approval documents and the staff member who verified them (maker-checker) | Each launch RE's actual registrations (D-03)               |
| **Vendor-chain register**: for each vendor endpoint, whose licence or membership it runs under (AUA/KUA, OVSE, CERSAI code, bureau membership), hosting region, sub-processors, webhook signing. Ask Surepass in writing per endpoint.                                                                                                                                            | 01–06, 09–12  | Signed vendor confirmations                                                                                  | Surepass's chain; certificates it claims (OVSE, ISO 27001) |
| **No restricted data in Udofin's core schemas**: KYC artefacts, Aadhaar XML, CKYC records, bureau reports and AA data live only in the lender's systems or lender-scoped encrypted storage (Phase 06). A schema review (and later an automated check) fails on core-schema columns that hold such data.                                                                           | 01–07         | Schema review records; data inventory                                                                        | Automated check not yet built                              |
| **Consent before every rail**: each call carries a `consent.records` id for the right purpose and lender; the consent ledger is append-only and the notice wording is hashed (`20261010000300_identity_consent_audit.sql`).                                                                                                                                                       | 01–07, 09, 27 | Consent ledger entries with notice SHA-256                                                                   | Purpose keys per rail not yet defined                      |
| **Money only in the RE's accounts**: the per-RE payment configuration validator rejects any settlement or mandate creditor that is not the RE (PAY-01, PAY-07).                                                                                                                                                                                                                   | 11–14         | Configuration audit log; PA settlement reports naming the RE                                                 | Validator not yet built (Phases 04, 08)                    |

---

### 2.2 Phase 08a: what exists in the repository for these rows (16 October 2026)

Status words: **mock** = a labelled test double, refused in staging and production by three layers (configuration, `assertProviderAllowed` / `assertLocalOrTestOnly`, `udofin.allow_mock_providers` in the database); **placeholder** = a port whose every call answers `not_configured`; **manual / file** = a controlled human or file route with no external system; **not built**. Nothing in this table is a contract, a credential or an approved provider. No row can be switched on for a lender until its database and outside conditions in `docs/operations/phase-08a-activation-gates.md` are met.

| Row              | In the repository                                                                                                                                                                                                                | Mock / placeholder / manual                                                                                                                                    | Not built                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| INT-11           | `PaymentProviderPort` (create order, authenticated order lookup, settlement report); webhook verifier interface; provider register; callback receiver `POST /v1/hooks/provider/:endpointToken` in the separate receiver process. | Labelled mock provider and the labelled mock webhook scheme (`mock-standard-webhooks-v1`), local and test only; unconfigured placeholder for `sandbox`/`live`. | Any real provider adapter, its webhook scheme, its settlement report format, refunds and chargebacks.                        |
| INT-12           | `MandateProviderPort` (hand-off, status lookup, cancel, debit status list); mandate state machine; pre-debit notice.                                                                                                             | Labelled mock mandate provider (local and test only); unconfigured placeholder.                                                                                | Any real mandate rail, return-code classes (nothing seeded), debit presentment (Udofin presents no debit).                   |
| INT-14           | —                                                                                                                                                                                                                                | —                                                                                                                                                              | Virtual accounts and BBPS are not built.                                                                                     |
| INT-17           | A Finbyx or generic REST connection can be recorded only as `blocked_unverified` because no specification exists.                                                                                                                | —                                                                                                                                                              | The connector.                                                                                                               |
| INT-18           | `LmsPort`; the file import in the format `udofin-lms-import-v1` (CSV and JSON, all-or-nothing, value-free row errors); manual entry; lender-issued documents.                                                                    | **Manual / file** for both launch lenders (their LMS is not confirmed, D-64); labelled mock LMS in local and test.                                             | A live LMS connector.                                                                                                        |
| INT-21           | SMS rows exist as inert placeholders in the reminder tables; no function can send one.                                                                                                                                           | Placeholder only. No mock SMS can run in staging or production.                                                                                                | Any SMS provider, DLT principal entity, header or template (D-72).                                                           |
| INT-25           | `NotificationChannelPort<'push'>`; reminders carry an opaque id and a fixed title key.                                                                                                                                           | Labelled mock in local and test; elsewhere the placeholder answers `not_configured` and only the in-app copy is sent.                                          | A push provider; delivery reports (nothing produces them).                                                                   |
| Account registry | Keyed-HMAC account fingerprint, versioned fingerprint keys, ownership registry, merchant registry; `KeyManagerPort`.                                                                                                             | A labelled local key manager (local and test only).                                                                                                            | A managed key store (D-47); a borrower bank-account verification (INT-05), so a changed account cannot cancel a mandate yet. |
| Hand-off links   | AES-256-GCM vault: sealed by the worker, opened by the API for the owning borrower (ADR 0035).                                                                                                                                   | Keys from `HANDOFF_ENCRYPTION_KEYS` (a secrets manager in production); without keys no link is kept and the borrower is told so.                               | The secrets-manager wiring in production.                                                                                    |

## 3. Adapter ports

Ports are TypeScript interfaces in `packages/adapters` (currently a scaffold). Each provider gets an
adapter that implements one port. Domain modules call ports, never provider SDKs. The pseudocode below is
the contract; names may change in implementation, behaviour may not.

### 3.1 Shared types

```ts
// Pseudocode. Money is packages/domain Money (paise, bigint); on the wire it is MoneyMinor.
type ProviderMode = 'mock' | 'sandbox' | 'production';

interface AdapterDescriptor {
  port: string; // e.g. 'kyc', 'payment_collection'
  provider: string; // lowercase, ^[a-z0-9_]+$ (same rule as payments.provider_events.provider)
  mode: ProviderMode;
  credentialOwner: 'lender' | 'udofin';
}

interface CallContext {
  lenderOrgId: Uuid | null; // tenant whose credentials and storage are used; null only for Udofin-owned contracts
  correlationId: Uuid; // copied into events (correlationid), audit.events.correlation_id and logs
  operationKey: string; // idempotency key sent to the provider; derived from Udofin ids, never from personal data
  deadline: Date; // absolute; the adapter returns (or aborts) before it
  consentRecordId?: Uuid; // consent.records id authorising the call, where a consent gate applies
}

interface Evidence {
  // returned with every result, success or failure
  provider: string;
  providerMode: ProviderMode;
  providerRef: string | null; // provider transaction / request id
  credentialRef: string; // identifier of the secret used, never the secret
  requestedAt: Timestamp;
  respondedAt: Timestamp | null;
  responseSha256: string | null; // hash of the raw response; Udofin does not keep raw provider bodies
  vaultRef?: VaultRef; // pointer to artefacts in lender-scoped encrypted storage
  signatureVerified?: boolean; // for outcomes that arrived by webhook
}

type Result<T> =
  | { ok: true; value: T; evidence: Evidence }
  | { ok: false; error: AdapterError; evidence: Evidence };

type AdapterError =
  | { code: 'invalid_request'; retry: 'never'; providerCode?: string }
  | { code: 'gate_not_met'; retry: 'never'; gate: string } // e.g. lender has no OVSE registration
  | { code: 'consent_missing'; retry: 'never' }
  | { code: 'credentials_invalid'; retry: 'never' } // alert; open the circuit for this lender+provider
  | { code: 'rejected'; retry: 'never'; providerCode: string } // business outcome, e.g. account closed
  | { code: 'rate_limited'; retry: 'backoff'; retryAfterMs?: number }
  | { code: 'unavailable'; retry: 'backoff' }
  | { code: 'circuit_open'; retry: 'backoff' }
  | { code: 'timeout'; retry: 'status_check_first' }
  | { code: 'outcome_unknown'; retry: 'status_check_first' };

interface WebhookVerifier {
  // every port that receives callbacks implements this
  verify(
    rawBody: Uint8Array,
    headers: Headers,
    lenderOrgId: Uuid | null,
  ): Result<NormalisedProviderEvent>;
}
interface NormalisedProviderEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  providerStatus?: string;
  amountMinor?: bigint;
  subjectRef: string; // e.g. provider order ref
  payloadSha256: string;
  signatureVerified: boolean; // maps to payments.provider_events
}
```

Rules shared by all ports:

- Errors never carry provider response bodies or personal data. `providerCode` is the provider's code,
  not its message.
- `retry: 'status_check_first'` means the caller must query the outcome before any new attempt. It
  applies to every money-moving or enquiry-creating call.
- An unsigned or unverifiable callback is a **hint**: the adapter must confirm by polling the provider's
  status API before the outcome is recorded.
- Ports return references to lender-scoped artefacts (`VaultRef`), not the artefacts. Only lender-scoped
  storage holds KYC, bureau, AA or signed-document content.

### 3.2 Labelling rule: mock, sandbox, production

| Rule                            | Detail                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every adapter declares its mode | `AdapterDescriptor.mode` is fixed at construction from configuration, never from a request.                                                                                                                                                                                      |
| Allowed modes per environment   | `APP_ENV=local` or `test`: `mock` (default) or `sandbox`. `staging`: `sandbox` only, with synthetic data. `production`: `production` only. The API refuses to start on any other combination, in the same way `services/api/src/config.ts` already refuses unsafe configuration. |
| Every result is labelled        | `Evidence.providerMode` is stored with every verification result, payment event and signed document. A record produced in `mock` or `sandbox` mode can never satisfy a production gate (planned database check: production records reject non-production evidence).              |
| Credentials follow the mode     | Production credentials exist only in the production secrets store; staging cannot read them. A sandbox credential presented in production fails start-up validation.                                                                                                             |
| Visible labelling               | Non-production builds of the app and portals show a persistent "SANDBOX" or "TEST" banner. Documents generated in non-production carry a watermark.                                                                                                                              |
| Mocks are deterministic         | Mock adapters live in `packages/adapters` next to the port, return fixed scenarios selectable by synthetic input (for example a test account number that always fails name match), and never call the network.                                                                   |

### 3.3 KYC orchestration port (INT-01, INT-02, INT-03; V-CIP deep link)

```ts
interface KycPort {
  // Runs under the lender's credentials. Udofin hosts the screen; the lender decides KYC completion.
  startSession(
    ctx: CallContext,
    input: {
      applicationId: Uuid;
      method:
        | 'ckyc'
        | 'digilocker'
        | 'aadhaar_offline_lender_ovse'
        | 'aadhaar_otp_lender_kua'
        | 'vcip_lender';
      returnUrl: string; // app deep link; no personal data in the URL
    },
  ): Promise<Result<{ sessionId: string; redirectUrl?: string; expiresAt: Timestamp }>>;

  getSessionStatus(
    ctx: CallContext,
    sessionId: string,
  ): Promise<
    Result<{ status: 'pending' | 'completed' | 'failed' | 'expired'; failureCode?: string }>
  >;

  collectResult(
    ctx: CallContext,
    sessionId: string,
  ): Promise<Result<{ vaultRef: VaultRef; summary: KycSummary }>>; // artefacts go to lender-scoped storage
}

interface KycSummary {
  // the only KYC data outside lender-scoped storage
  method: string;
  completedAt: Timestamp;
  nameMatchBand?: 'match' | 'review' | 'mismatch';
  ckycIdentifierMasked?: string; // display only
  documentTypes: string[]; // e.g. ['aadhaar_xml', 'pan'] — types, never numbers
}
```

| Aspect      | Contract                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gates       | `startSession` returns `gate_not_met` unless the lender capability registry allows the method. Aadhaar is never mandatory; non-Aadhaar options are always offered (KYC-04, likely). |
| Timeouts    | `startSession` 8 s; `getSessionStatus` 5 s, polled until `expiresAt` (Surepass DigiLocker tokens default to 600 s); background sweep for abandoned sessions.                        |
| Retries     | `startSession`: one retry with the same `operationKey`. `collectResult`: up to 3 with backoff (read-only).                                                                          |
| Idempotency | `operationKey` = `kyc:{applicationId}:{method}:{attemptNo}`.                                                                                                                        |
| Evidence    | Provider reference, response hash, lender credential reference, vault reference, consent record id. The KYC decision itself is recorded by the lender's user or system (KYC-01).    |

### 3.4 PAN verification port (INT-04)

```ts
interface PanVerificationPort {
  verify(
    ctx: CallContext,
    input: { applicationId: Uuid; panVaultRef: VaultRef; nameAsEntered?: string },
  ): Promise<
    Result<{
      status: 'valid' | 'invalid' | 'not_found';
      nameMatchBand?: 'match' | 'review' | 'mismatch';
      panMasked: string;
    }>
  >;
}
```

Timeout 5 s; up to 2 retries (read-only); idempotency key `pan:{applicationId}`; evidence as §3.1. The full
PAN is read from lender-scoped storage inside the adapter and is never logged (`pan` is in the API
logger's redaction list).

### 3.5 Bank account verification port (INT-05)

```ts
interface BankAccountVerificationPort {
  verify(
    ctx: CallContext,
    input: {
      verificationId: Uuid;
      method: 'penny_drop' | 'penny_less' | 'vpa_check';
      accountVaultRef: VaultRef; // account number + IFSC held in lender-scoped storage
      expectedNameRef: VaultRef; // KYC name, for matching
    },
  ): Promise<
    Result<{
      status: 'verified' | 'failed' | 'pending';
      nameMatchBand: 'match' | 'review' | 'mismatch';
      accountMasked: string;
    }>
  >;

  startReversePennyDrop(
    ctx: CallContext,
    input: { verificationId: Uuid },
  ): Promise<Result<{ upiIntentUrl: string; expiresAt: Timestamp }>>; // borrower pays ₹1 from own account
  getStatus(
    ctx: CallContext,
    verificationId: Uuid,
  ): Promise<Result<{ status: string; refundStatus?: string }>>;
}
```

Penny drop moves money (₹1), so `timeout` is `status_check_first`. Idempotency key `bav:{verificationId}`.
The verified account is bound to the loan for both disbursal and mandate; any change starts a new
verification.

### 3.6 Credit bureau port (INT-06)

```ts
interface CreditBureauPort {
  // Triggers the LENDER's enquiry under its membership. The report goes to the lender's LOS, or to
  // lender-scoped storage where Udofin acts as the lender's processor. Udofin's modules never read it.
  requestEnquiry(
    ctx: CallContext,
    input: {
      applicationId: Uuid;
      bureau: 'cibil' | 'experian' | 'equifax' | 'crif';
      purposeCode: string;
    },
  ): Promise<Result<{ enquiryRef: string; status: 'submitted' | 'completed' | 'failed' }>>;
  getEnquiryStatus(
    ctx: CallContext,
    enquiryRef: string,
  ): Promise<Result<{ status: 'submitted' | 'completed' | 'failed'; reportVaultRef?: VaultRef }>>;
}
```

No score, report or tradeline field exists in any return type, by design (CIC-01): the lender's decision
comes back as the lender's outcome, not as bureau data. A second enquiry for the same
`(applicationId, bureau)` is refused (`invalid_request`). Timeout 30 s, background only; never retried
without `getEnquiryStatus`, because a duplicate enquiry appears on the borrower's report.

### 3.7 Account Aggregator port (INT-07)

```ts
interface AccountAggregatorPort {
  createConsentRequest(
    ctx: CallContext,
    input: {
      applicationId: Uuid;
      fiuId: string /* the RE's */;
      purposeCode: string;
      fiTypes: string[];
      dataLifeDays: number;
      frequency: string;
    },
  ): Promise<Result<{ consentHandle: string; redirectUrl: string }>>;
  getConsentStatus(ctx: CallContext, consentHandle: string): Promise<Result<{ status: string }>>;
  requestDataFetch(
    ctx: CallContext,
    consentHandle: string,
  ): Promise<Result<{ vaultRef: VaultRef }>>; // decrypted in RE scope
  revokeConsent(ctx: CallContext, consentHandle: string): Promise<Result<void>>;
}
```

Consent requests without the RE's FIU id are refused (AA-01). Data is purged when the data life expires.

### 3.8 eSign port (INT-09)

```ts
interface ESignPort {
  createSigningRequest(
    ctx: CallContext,
    input: {
      documentId: Uuid;
      documentVersion: number;
      documentSha256: string;
      documentVaultRef: VaultRef;
      documentType: string; // checked against the RE-approved document matrix (no eSign for excluded types)
      signers: { role: 'borrower' | 'co_borrower' | 'lender'; signerRef: Uuid }[];
      expiresAt: Timestamp;
    },
  ): Promise<Result<{ requestId: string; signingUrl: string }>>;
  getStatus(
    ctx: CallContext,
    requestId: string,
  ): Promise<Result<{ status: 'pending' | 'signed' | 'failed' | 'expired' | 'cancelled' }>>;
  collectEvidence(
    ctx: CallContext,
    requestId: string,
  ): Promise<
    Result<{
      signedDocumentVaultRef: VaultRef;
      signedSha256: string;
      espTransactionId: string;
      signerCertificateFingerprint: string;
      auditTrailVaultRef: VaultRef;
      signatureValidated: boolean;
    }>
  >;
  cancel(ctx: CallContext, requestId: string): Promise<Result<void>>;
}
```

Idempotency key `esign:{documentId}:{documentVersion}`. `signatureValidated` is computed by Udofin's
server-side validation of the PDF signature and certificate chain, not copied from the vendor. An
application moves `agreement_pending → agreement_executed` only as `system` after verified evidence exists
(`lending.application_transitions`). eSign cannot start before the KFS is acknowledged (roadmap Phase 07).

### 3.9 eStamp port (INT-10)

```ts
interface EStampPort {
  procure(
    ctx: CallContext,
    input: {
      documentId: Uuid;
      state: string;
      article: string;
      duty: Money;
      firstPartyOrgId: Uuid /* the RE */;
      secondPartyRef: Uuid;
    },
  ): Promise<Result<{ certificateNumber: string; certificateVaultRef: VaultRef }>>;
  verify(ctx: CallContext, certificateNumber: string): Promise<Result<{ valid: boolean }>>;
}
```

Stamp duty is money spent, so `timeout` is `status_check_first`. Idempotency key
`estamp:{documentId}:{state}`. The stamping matrix (state x product x article) is RE-approved configuration.

### 3.10 Payment collection port (INT-11, INT-14)

```ts
interface PaymentCollectionPort {
  createOrder(
    ctx: CallContext,
    input: {
      paymentIntentId: Uuid; // also the provider receipt / order reference
      amount: Money;
      purpose: 'installment' | 'overdue' | 'part_prepayment' | 'foreclosure' | 'charges';
      settlementAccountRef: string; // the RE's collection account; validator rejects anything else
      expiresAt: Timestamp;
    },
  ): Promise<
    Result<{ providerOrderRef: string; checkout: { upiIntentUrl?: string; hostedUrl?: string } }>
  >;
  getPaymentStatus(
    ctx: CallContext,
    providerOrderRef: string,
  ): Promise<
    Result<{
      status: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired';
      providerPaymentRef?: string;
      amount?: Money;
      paidAt?: Timestamp;
    }>
  >;
  listSettlements(
    ctx: CallContext,
    input: { settlementDate: string },
  ): Promise<Result<SettlementLine[]>>;
  createVirtualAccount?(
    ctx: CallContext,
    input: { loanAccountId: Uuid },
  ): Promise<Result<{ virtualAccountRef: string; displayMasked: string }>>;
  webhooks: WebhookVerifier;
}
interface SettlementLine {
  providerPaymentRef: string;
  amount: Money;
  fees: Money;
  utr: string;
  settledAt: Timestamp;
}
```

Maps directly onto `payments.payment_intents` (`provider_order_ref`, `idempotency_key`, status rules) and
`payments.provider_events` (`signature_verified`, `payload_sha256`). Only the system, processing a verified
provider event or a status poll, moves an intent `pending → succeeded/failed` (enforced by
`private.protect_payment_intent`). Timeout 8 s for `createOrder`; on timeout call `getPaymentStatus`
before creating anything new.

### 3.11 Mandate port (INT-12)

```ts
interface MandatePort {
  createMandate(
    ctx: CallContext,
    input: {
      mandateId: Uuid;
      loanAccountId: Uuid;
      rail: 'enach' | 'upi_autopay';
      maxAmount: Money;
      frequency: 'as_presented' | 'monthly';
      startDate: string;
      endDate: string;
      verifiedAccountRef: VaultRef;
      creditorUtilityRef: string /* the RE's */;
    },
  ): Promise<Result<{ providerMandateRef: string; authUrl: string }>>;
  getMandate(
    ctx: CallContext,
    providerMandateRef: string,
  ): Promise<
    Result<{
      status: 'pending_auth' | 'active' | 'rejected' | 'paused' | 'cancelled' | 'expired';
      umrn?: string;
    }>
  >;
  presentDebit(
    ctx: CallContext,
    input: { mandateId: Uuid; installmentRef: string; amount: Money; dueDate: string },
  ): Promise<Result<{ presentationRef: string }>>;
  getPresentation(
    ctx: CallContext,
    presentationRef: string,
  ): Promise<Result<{ status: 'scheduled' | 'succeeded' | 'returned'; returnReasonCode?: string }>>;
  cancelMandate(ctx: CallContext, providerMandateRef: string): Promise<Result<void>>;
  webhooks: WebhookVerifier;
}
```

One presentation per instalment (`operationKey` = `debit:{mandateId}:{installmentRef}`); never re-present
without `getPresentation`. Return reason codes are taken from the provider's current table, not
hard-coded. Pre-debit notification and authentication thresholds are configuration pending verification
(PAY-06, unverified). Mandates are cancelled or allowed to expire at loan closure.

### 3.12 Payout port (INT-13; not used unless a lender asks)

```ts
interface PayoutPort {
  // only if an RE asks Udofin to orchestrate payouts FROM THE RE'S OWN ACCOUNT
  createPayout(
    ctx: CallContext,
    input: { loanAccountId: Uuid; amount: Money; beneficiaryVerifiedRef: VaultRef },
  ): Promise<Result<{ providerPayoutRef: string; status: 'queued' | 'processing' }>>;
  getPayout(
    ctx: CallContext,
    providerPayoutRef: string,
  ): Promise<Result<{ status: 'processing' | 'succeeded' | 'failed' | 'reversed'; utr?: string }>>;
}
```

`operationKey` = `payout:{loanAccountId}` (one disbursal per loan). Never retried on timeout without
`getPayout`. Disbursement evidence in `servicing.loan_accounts` still comes from the LMS.

### 3.13 Collateral lien port (INT-15, INT-16)

```ts
interface CollateralLienPort {
  requestLien(
    ctx: CallContext,
    input: {
      lienRequestId: Uuid;
      kind: 'mf_rta' | 'demat_pledge';
      holdings: { holdingRef: string; units: string }[];
      pledgeeRef: string /* the RE's demat / lien-holder id */;
    },
  ): Promise<Result<{ providerRequestRef: string; otpRequired: boolean }>>;
  confirm(
    ctx: CallContext,
    providerRequestRef: string,
    otp: string,
  ): Promise<Result<{ status: string }>>;
  getLien(
    ctx: CallContext,
    providerRequestRef: string,
  ): Promise<Result<{ status: 'pending' | 'marked' | 'failed' | 'released'; lienRef?: string }>>;
  requestRelease(ctx: CallContext, lienRef: string): Promise<Result<{ status: string }>>;
}
```

Pledgee or lien holder must be the RE (LAS-01); otherwise `gate_not_met`. The OTP is passed through and
never stored or logged. Invocation on default is the RE's process and is out of scope for the port.

### 3.14 LMS connector port (INT-17, INT-18)

Defined in `docs/api/integration-contracts.md` §4, because Finbyx and third-party LMS vendors must
implement the server side. The Udofin adapter calls it with the same `CallContext` and returns the same
`Result` and `Evidence` types.

### 3.15 Accounting export port (INT-19, INT-20; Phase 10)

```ts
interface AccountingExportPort {
  exportBatch(
    ctx: CallContext /* lenderOrgId null: Udofin's own books */,
    input: {
      batchId: Uuid;
      legalEntityOrgId: Uuid;
      period: { from: string; to: string };
      vouchers: {
        journalId: Uuid;
        date: string;
        lines: { ledgerCode: string; debit: Money; credit: Money }[];
        narration: string;
      }[];
    },
  ): Promise<Result<{ accepted: Uuid[]; rejected: { journalId: Uuid; reason: string }[] }>>;
  getPostingStatus(ctx: CallContext, batchId: Uuid): Promise<Result<{ status: string }>>;
}
```

Tally adapter writes voucher XML with `REMOTEID` = `journalId`; SAP adapter uses the external reference.
A batch may contain one legal entity only (ACC-01). Narrations contain no borrower PII.

### 3.16 Messaging ports (INT-21 to INT-25)

```ts
interface MessagePort {
  send(
    ctx: CallContext,
    msg: {
      notificationId: Uuid; // provider idempotency key
      channel: 'sms' | 'whatsapp' | 'email' | 'push';
      category: 'otp' | 'service' | 'collection_reminder' | 'marketing';
      templateKey: string;
      templateVersion: number; // registry maps to DLT template id / WhatsApp template
      senderEntity: 'udofin' | { lenderOrgId: Uuid };
      recipientRef: RecipientRef; // resolved inside the adapter; never logged
      variables: Record<string, string>;
    },
  ): Promise<Result<{ providerMessageRef: string }>>;
  getDeliveryStatus(
    ctx: CallContext,
    providerMessageRef: string,
  ): Promise<Result<{ status: string }>>;
}
```

Rules enforced before `send`: template registered for the channel and sender (MSG-01); marketing only with
a current `marketing` consent (UX-11); WhatsApp only with recorded opt-in (MSG-03); push payload limited
to a generic title and an opaque id (PSH-01); `collection_reminder` (overdue contact) only within the
permitted contact window and only if Udofin is the RE's appointed recovery agent (D-11). Timeouts: SMS
3 s, others 10 s; retries with the same `notificationId` only where the provider de-duplicates on it,
otherwise status check first.

**Auth Send SMS hook contract (INT-22).** An HTTP endpoint in Mumbai (API or pinned Edge Function) that:
verifies the Standard Webhooks signature; de-duplicates on the webhook id; calls the DLT provider with a
3 s timeout; returns HTTP 200 with an empty body on success; on provider failure queues a fallback
provider job and returns an error so the user can retry; never logs phone or OTP.

### 3.17 AI inference port (INT-28)

```ts
interface AiInferencePort {
  complete(
    ctx: CallContext,
    input: {
      useCase: 'faq_answer' | 'complaint_intent' | 'staff_draft';
      promptTemplateVersion: string;
      redactedInput: string; // PII removed before this call
      retrievalScope: 'approved_faq' | 'lender_kfs' | 'none';
    },
  ): Promise<Result<{ output: string; modelId: string; region: string; inferenceRef: string }>>;
}
```

The adapter refuses any model endpoint outside the India-hosted allowlist. Timeout 15 s, one retry.
Outputs never reject, settle, threaten or decide credit; complaint intent opens a grievance ticket.

### 3.18 Ecosystem ports

`ComplianceEvidencePort` (LawDocsComply) and `DisputeReferralPort` (Equator) are defined in
`docs/api/integration-contracts.md` §5 and §6.

---

## 4. Credential management

| Topic                          | Rule                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where secrets live             | Per-lender and Udofin provider credentials live in a secrets manager in India: AWS Secrets Manager with KMS in ap-south-1 once production moves to AWS (recommended in `infra-stack.md`; D-06). Railway sealed variables are acceptable only for non-production with synthetic data. Secrets are never in the database, in git, in committed `.env` files, in logs, or in the mobile app. |
| Naming                         | One secret per (environment, lender, provider, purpose), for example `udofin/{env}/lender/{lenderOrgId}/{provider}/{purpose}`; Udofin-owned contracts use `udofin/{env}/platform/{provider}/{purpose}`.                                                                                                                                                                                   |
| What the database holds        | A **credential reference** row per secret (planned, Phase 04): lender, provider, purpose, mode, secret identifier, owner on the RE side, issued date, expiry, last rotated, rotation interval, status. Never the secret value.                                                                                                                                                            |
| Who can read                   | Only the runtime role of the component that calls the provider (API or worker), by IAM policy scoped to the secret path. Staff cannot read production secrets; changes go through a controlled process, not a console.                                                                                                                                                                    |
| Onboarding a lender credential | The RE's administrator submits it through a secure channel that writes directly to the secrets manager (never email or chat). A second person verifies scope and mode (maker-checker, as for product approval). Each change writes an audit event with the secret identifier, not its value.                                                                                              |
| Rotation                       | Rotate on the provider's or RE's schedule, or at least yearly; immediately on departure of staff with access, suspected exposure or RE request. Use overlapping validity (old and new both valid) so rotation needs no downtime. Webhook signing secrets support two active secrets at a time.                                                                                            |
| Caching                        | In-memory only, short TTL, refreshed on `credentials_invalid`. Never written to disk.                                                                                                                                                                                                                                                                                                     |
| Failure handling               | `credentials_invalid` opens the circuit for that (lender, provider) only, alerts the integration owner and the RE contact, and shows the borrower a neutral "this lender's service is unavailable" message.                                                                                                                                                                               |
| Logging                        | Secret values never logged; the API logger already redacts `secret`, `token`, `password` and credential headers (`services/api/src/logger.ts`) as a safety net.                                                                                                                                                                                                                           |
| Residency                      | Secrets are not borrower data, but RE auditors will ask where they are held; keep them in ap-south-1.                                                                                                                                                                                                                                                                                     |

---

## 5. Timeouts, retries and circuit breaking

| Mechanism         | Rule                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadlines         | Every call has an absolute `deadline`. Interactive (borrower waiting) calls have a total budget of 8–10 s including retries; background jobs (pg-boss) 30 s per attempt. Values are initial settings, tuned from measurements.                                                                                                     |
| Operation classes | **Read** (status, verification lookups): safe to retry. **Idempotent command** (provider de-duplicates on our key): retry with the same `operationKey`. **Non-idempotent or money/enquiry-creating command** (payouts, debit presentations, bureau enquiries, penny drop, stamp purchase): no automatic retry; query status first. |
| Retry policy      | Exponential backoff with full jitter (base 500 ms, cap 30 s), at most 3 attempts interactive, at most 8 in background; honour the provider's `Retry-After`. After the last attempt the job goes to a dead-letter queue with an operations alert.                                                                                   |
| Circuit breaker   | One breaker per (provider, lender, operation). Opens after 5 consecutive failures or a 50% failure rate over at least 20 calls in 60 s; half-open after 30 s with one probe. `credentials_invalid` opens it immediately. An open circuit returns `circuit_open` without calling the provider.                                      |
| Bulkheads         | Concurrency limit per provider and per lender so one slow provider cannot exhaust the API's connection pool (`pg.Pool` max 10 today in `services/api/src/server.ts`). Provider calls are not made while holding a database transaction open.                                                                                       |
| Long flows        | Calls that take longer than an interactive budget (bureau, eSign completion, mandate registration) run as jobs from the transactional outbox. The borrower sees a pending state and is notified.                                                                                                                                   |

---

## 6. Reconciliation for money-moving providers

**Principle: never trust a successful API response alone.** A provider "success" is one signal. A payment
is treated as complete only when independent records agree.

| Level                 | Meaning                                                                                           | Source                                                        | Recorded in                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1. Provider-confirmed | Provider reports success through a **verified** webhook or a status poll                          | `payments.provider_events` (`signature_verified`), status API | `payments.payment_intents.status = succeeded` (system only)       |
| 2. Settled            | Amount appears in the provider's settlement report and in the RE's bank statement, matched by UTR | `PaymentCollectionPort.listSettlements`, RE statement feed    | Reconciliation item (planned, see `docs/data/entity-model.md` §8) |
| 3. Posted             | The RE's LMS has allocated the receipt to the loan                                                | `in.finbyx.repayment.posted.v1` or the connector callback     | Servicing read model; next schedule snapshot                      |

Rules:

1. Amounts must match exactly, in paise. There is no tolerance band.
2. The daily job (T+1 after settlement) classifies every item as matched, missing at provider, missing in
   bank statement, missing in LMS, amount mismatch, or duplicate. Each exception becomes a reconciliation
   item with an owner (Udofin operations or the RE) and an ageing clock.
3. Borrower-facing status distinguishes "payment received by your lender's payment provider" (level 1)
   from "credited to your loan" (level 3). Udofin does not show a loan as paid on level 1 alone.
4. Mandates: every presentation is reconciled against NPCI return codes and the sponsor-bank MIS daily.
   A bounce charge shown to the borrower is the RE's charge from the KFS, not Udofin's.
5. Disbursement: Udofin does not move money. It accepts disbursement evidence only from the LMS (date,
   amount and bank reference all present, enforced by `servicing.loan_accounts`), and an application can
   become `disbursed` only after that evidence exists (`private.require_disbursement_evidence`). The
   borrower's own bank credit is the final check; a borrower report of non-receipt opens an exception.
6. Stamp duty and verification charges are reconciled with the RE's invoices.
7. Udofin's own fees (LSP fees paid by the RE) are reconciled in Udofin's own books (Phase 10), never
   netted from borrower payments.
8. Reconciliation results and exceptions are evidence: they are exportable per RE and summarised to
   LawDocsComply without borrower PII.

---

## 7. Open questions (integration-specific)

1. Each launch RE's registrations: s.11A notification, KUA/sub-KUA, e-KYC Setu, OVSE, DigiLocker
   Requester id, CERSAI, Protean OPV, bureau memberships, AA FIU id, PA merchant account, NACH utility
   (D-03, D-13).
2. Surepass, per endpoint and in writing: whose licence or membership, data hosting region and retention,
   sub-processors, webhook signing, current API domain.
3. PAN verification contract holder (research conflict in INT-04).
4. Whether the 2023 DL FAQ allowance for pure payment aggregators survives the 2025 Directions.
5. NPCI rules: current AutoPay retry and time-window rules, e-mandate caps per sponsor bank, pre-debit
   notification and authentication thresholds.
6. eSign: which ESP sits behind the chosen ASP; fallback ESP; who owns the evidence store.
7. eStamp: NeSL vs SHCIL coverage for each RE's footprint, and the fallback for uncovered states.
8. Email provider and WhatsApp provider selection with India residency.
9. Finbyx migration out of Tokyo and the status of any data it held (D-04).
10. Equator's domain, brand, legal form and independence model (D-17).
11. Which partners require Indian source IP addresses or mTLS.
