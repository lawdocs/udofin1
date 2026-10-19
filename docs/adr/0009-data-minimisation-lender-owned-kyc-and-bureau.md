# ADR-0009: Data minimisation — KYC and bureau data belong to the lender

- **Status:** Accepted (baseline, pending owner approval) — the per-lender envelope encryption in item 5 is not yet implemented (Phase 5/6)
- **Date:** 2026-10-10
- **Related:** ADR-0005, ADR-0010, ADR-0014, ADR-0024

## Context

Research findings (`docs/research/2026-10-10/kyc-aadhaar-bureau.md`, `rbi-digital-lending.md` §3.9, `infra-stack.md` §3):

- An LSP/DLA must not store personal data beyond the basic minimum (name, address, contact details) needed for its operations; no biometric data unless a law permits it. Status: confirmed (secondary) (DATA-01, DL-13, DL-14).
- Customer due diligence is the lender's obligation. Online Aadhaar authentication is limited to banks, entities notified under PMLA s.11A, or REs using NPCI e-KYC Setu, under their own credentials; an LSP may not do it in its own name. Status: confirmed (KYC-02).
- Since December 2025, verifying Aadhaar Paperless Offline e-KYC (XML) or Aadhaar Verifiable Credentials requires registration with UIDAI as an OVSE. Status: likely (KYC-05).
- CKYC search/download/upload is limited to CERSAI-registered reporting entities; the 29 Dec 2025 amendment on relying on CKYCR records. Status: likely (KYC-09).
- Credit information may be obtained only by credit institutions and RBI-approved specified users, and a specified user may not pass it to anyone else (CICRA s.17(4)). Status: confirmed (CIC-01). Specified-user eligibility includes at least 3 years of processing for credit institutions. Status: likely (CIC-02). India has no regulatory concept of a "soft pull" (research statement).
- Surepass, Udofin's existing KYC vendor, does not make Udofin a CIC member, CERSAI reporting entity or AUA/KUA (interpretation, `providers-payments.md` §1).
- pgsodium is "pending deprecation" and Supabase advises against new use (confirmed, Supabase docs). Supabase Vault is public alpha (confirmed).
- The owner's original plan included a Udofin "CIBIL soft pull" via Surepass and Aadhaar OTP run by Udofin.

## Decision

1. **Udofin's own database keeps only basic minimal data.** `identity.borrowers` holds no PAN, Aadhaar, date of birth or documents; the phone number stays in Supabase Auth (`auth.users`). Audit metadata, consent evidence, event subjects and logs never contain identity numbers.
2. **KYC, bureau and Account Aggregator data are the lender's.** Aadhaar (OTP, offline XML, DigiLocker), CKYC, PAN verification, bureau pulls and AA data are performed **under each lender's credentials and licences**: the lender is the AUA/KUA or uses its own KYC provider, is the CKYC reporting entity, the bureau member and the AA FIU. Udofin runs the user interface and orchestration and stores results only in **lender-scoped** storage, acting as the lender's processor.
3. **Not allowed:** a Udofin "CIBIL soft pull" in Udofin's name; Aadhaar OTP in Udofin's name; one bureau report shared across lenders; storing biometrics; storing Aadhaar numbers (masked or vaulted only by the lender, as the lender requires).
4. **Per-lender capability gating (planned):** each lender's record states which KYC routes it is licensed for (for example s.11A notified, KUA mode, Setu, OVSE registered). The app offers only routes valid for the selected lender (research KYC-02, KYC-05).
5. **Per-lender envelope encryption (planned, Phase 5/6):** lender-owned sensitive data (KYC artefacts, bureau reports, documents) is encrypted in the application with data keys wrapped by a **separate AWS KMS key per lender in ap-south-1**. Lookups use HMAC blind indexes. Lender exit can be completed by destroying that lender's key (crypto-shredding). **pgsodium is not used**; Supabase Vault is not used for this.
6. Lender-owned files are stored in S3 ap-south-1, not Supabase Storage (ADR-0010).

## Alternatives considered

| Option                                                                                   | Why rejected                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Udofin keeps a central KYC and bureau profile reused across lenders ("marketplace data") | Exceeds basic minimal data; a specified user may not pass bureau data on (research).                                            |
| Udofin's own soft pull through Surepass                                                  | Udofin is not a credit institution or specified user (research); vendor access does not change that.                            |
| Udofin becomes a sub-AUA/sub-KUA                                                         | Needs prior UIDAI approval and a statutory basis Udofin lacks (research AAD-01, likely).                                        |
| pgsodium / Transparent Column Encryption                                                 | Pending deprecation (confirmed).                                                                                                |
| Database or disk encryption only                                                         | Protects against stolen disks, not against a compromised application or operator; no per-lender separation or crypto-shredding. |
| One Udofin-wide data key                                                                 | No cryptographic isolation between lenders; exit cannot be proven by key destruction.                                           |

## Consequences

**Positive**

- A breach of Udofin's core database exposes far less personal data.
- Each lender can be shown its own data boundary, and exit can be evidenced.
- Udofin avoids acting as a KYC or bureau user it is not licensed to be.

**Negative**

- Each lender pulls the bureau separately, so a multi-lender request can create several enquiries and bureau alerts for the borrower (research CIC-04, likely). The UI must warn before each pull.
- Time to offers and integration work grow with the number of lenders and rails.
- Key management adds cost, latency and operational procedures (rotation, dual control).
- Searching encrypted fields is limited to exact matches through blind indexes.

**Risks**

- Until item 5 exists, no lender-owned sensitive data may be stored at all. Any earlier feature that needs it is blocked.
- Developers may log or copy sensitive values. Mitigation: log redaction (`services/api/src/logger.ts`), planned schema lint and DLP scans.

## Compliance and security notes

- Supports the reported LSP minimal-data and no-biometrics rules, and the KYC/bureau licensing limits (labels above). DPDP Act obligations largely commence around 13/14 May 2027, with a possible earlier date under consultation (unverified) (`privacy-security-outsourcing.md`).
- Evidence (planned): data inventory and schema review; DLP scan showing no 12-digit Aadhaar patterns in Udofin tables or logs (KYC-04); database dump showing only ciphertext for tagged columns (INF-13).
- Primary-source verification gate applies (README).

## Verification

- Schema review of `supabase/migrations/20261010000300_identity_consent_audit.sql` (`identity.borrowers` columns) and `supabase/tests/002_tenant_isolation.test.sql` ("lender staff cannot list borrower accounts").
- `services/api/test/logger.test.ts`: PAN, Aadhaar, mobile, name, OTP and account number are redacted from logs.
- Planned: schema lint that fails on flagged column names (INF-07, DATA-01); bureau-payload search finding nothing (CIC-01); KMS key-per-lender test and crypto-shred drill (OUT-4).

## Revisit triggers

- Udofin becomes eligible for, and obtains, specified-user status (not before 3 years of operations; likely).
- A borrower-facing credit-health feature is proposed (separate store, consent, deletion within 6 months per CIC-03, likely) — needs its own ADR.
- DPDP substantive provisions commence, or primary-text review changes the minimal-data definition.
