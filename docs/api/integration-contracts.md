# Integration contracts between Udofin, lender systems and the group's products

Status: working draft, 2026-10-10. Covers: the integration event catalogue, the lender LMS connector
contract (Finbyx and third-party LMSs), the LawDocsComply compliance feed, the Equator referral contract,
versioning rules and delivery guarantees. HTTP conventions (authentication, errors, idempotency, webhook
signing) are in `docs/api/README.md`; provider adapters in `docs/integrations/register.md`.

> **Research limitation.** Regulatory statements here (RB-IOS 2026, DLG, data residency, DPDP) come from
> research that could not open primary sources (rbi.org.in and others unreachable; search budget
> exhausted). They rest on search extracts and secondary sources and must be verified against the primary
> texts before they are relied on. This is a release gate.

---

## 1. Principles

1. **Separate products.** Udofin, Finbyx, LawDocsComply and Equator have separate databases, deployments
   and release cycles. They integrate only through the APIs and signed events in this document, plus staff
   SSO. No shared tables, no cross-product joins, no group-level customer view (purpose limitation).
2. **Data ownership.**

| Data                                                                          | System of record                                                                | Others may hold                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Borrower account (Udofin platform)                                            | Udofin                                                                          | —                                                                         |
| Loan record (sanction, schedule, balances, allocation, DPD, bureau reporting) | The lender, in its LMS (Finbyx acts as the lender's processor)                  | Udofin keeps an immutable read model (`servicing.*`)                      |
| Complaint                                                                     | Lender is authoritative (its GRO case); Udofin keeps a linked front-desk ticket | LawDocsComply gets aggregates only                                        |
| Compliance obligations and evidence                                           | LawDocsComply, one tenant per legal entity                                      | No borrower personal data                                                 |
| Dispute case                                                                  | Equator, as an independent data fiduciary                                       | Udofin and the lender get outcome status only with the borrower's consent |
| DLG exposure                                                                  | Udofin (if it is the DLG provider) and the lender, reconciled                   | —                                                                         |

3. **Minimal payloads.** Events say _that_ something happened and identify it. Consumers that are entitled
   to more fetch it through an authorised API call. Every payload field below has a stated reason.
4. **No restricted data on events.** `restricted` (identity documents, KYC artefacts, bureau data) is never
   carried in an event; at most a reference into the lender's vault.
5. **Finbyx gets no back channel.** Finbyx exposes the same connector contract to any LSP, and returns to
   Udofin only loans that Udofin sourced and for which it holds the borrower's consent.

---

## 2. Event envelope

All integration events use `EventEnvelope` from `packages/contracts/src/events/envelope.ts` (CloudEvents
1.0 structured JSON with Udofin extension attributes).

| Attribute            | Rule                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specversion`        | `"1.0"`                                                                                                                                                                                                        |
| `id`                 | UUID, unique per event. Consumers de-duplicate on (`source`, `id`).                                                                                                                                            |
| `source`             | URI reference of the producing system: `urn:udofin:api`, `urn:udofin:worker`, `urn:finbyx:lms`, `urn:lawdocscomply:api`, `urn:equator:odr`.                                                                    |
| `type`               | Must match `EVENT_TYPE_PATTERN`: `in.<product>.<aggregate>.<fact>.v<major>`, product one of `udofin`, `finbyx`, `lawdocscomply`, `equator`; aggregate and fact lowercase `snake_case`; fact in the past tense. |
| `time`               | RFC 3339 with offset: when the fact happened at the producer.                                                                                                                                                  |
| `subject`            | `<aggregate>/<id>` of the aggregate the event is about. Never a PAN, Aadhaar number, phone number or name.                                                                                                     |
| `datacontenttype`    | `"application/json"`                                                                                                                                                                                           |
| `tenantid`           | The lender organisation id (`tenancy.organizations.id`) the event belongs to. Omitted only for platform-level events (Udofin's own controls, audit anchors) and for Equator events (see §6).                   |
| `correlationid`      | UUID shared by every event caused by one business operation.                                                                                                                                                   |
| `causationid`        | The event or command that directly caused this one, when known.                                                                                                                                                |
| `dataclassification` | `public`, `internal`, `confidential` or `restricted`. Events in this catalogue are `confidential` (linked to a borrower's loan through pseudonymous ids) or `internal` (no borrower link).                     |
| `data`               | Object. Money as `MoneyMinor`; timestamps RFC 3339 with offset; ids as UUID strings; `camelCase` field names.                                                                                                  |

### 2.1 Example (validated against the zod schema)

This envelope passes `parseEventEnvelope` in `packages/contracts` (checked on 2026-10-10 against the
built package); the `disbursedAmount` object also passes `MoneyMinor`. All values are synthetic.

```json
{
  "specversion": "1.0",
  "id": "0199ce41-6f2a-7c3d-8e4f-5a6b7c8d9e01",
  "source": "urn:finbyx:lms",
  "type": "in.finbyx.loan.disbursed.v1",
  "time": "2026-10-10T15:42:07+05:30",
  "subject": "loan/LN-ALPHA-000123",
  "datacontenttype": "application/json",
  "tenantid": "0199ce41-6f2a-7c3d-8e4f-5a6b7c8d9e02",
  "correlationid": "0199ce41-6f2a-7c3d-8e4f-5a6b7c8d9e03",
  "causationid": "0199ce41-6f2a-7c3d-8e4f-5a6b7c8d9e04",
  "dataclassification": "confidential",
  "data": {
    "lmsLoanRef": "LN-ALPHA-000123",
    "applicationId": "0199ce41-6f2a-7c3d-8e4f-5a6b7c8d9e05",
    "disbursedAmount": { "minor": "50000000", "currency": "INR" },
    "disbursedAt": "2026-10-10T15:40:12+05:30",
    "disbursementReference": "SYNTHETICUTR000000001"
  }
}
```

A platform-level event omits `tenantid` (also validated):

```json
{
  "specversion": "1.0",
  "id": "0199ce52-1b7e-7a90-9c3d-2e4f6a8b0c11",
  "source": "urn:udofin:worker",
  "type": "in.udofin.audit_anchor.created.v1",
  "time": "2026-10-11T00:05:00Z",
  "subject": "audit_anchor/0199ce52-1b7e-7a90-9c3d-2e4f6a8b0c12",
  "datacontenttype": "application/json",
  "correlationid": "0199ce52-1b7e-7a90-9c3d-2e4f6a8b0c13",
  "dataclassification": "internal",
  "data": {
    "anchorId": "0199ce52-1b7e-7a90-9c3d-2e4f6a8b0c12",
    "rangeStart": "2026-10-10T00:00:00Z",
    "rangeEnd": "2026-10-11T00:00:00Z",
    "eventCount": 18234,
    "digest": "9f2c4e0b7a1d3c5e8f6a4b2d0c9e7f5a3b1d8c6e4f2a0b9d7c5e3f1a8b6d4c2e"
  }
}
```

Note: the envelope schema types `data` as an open object. The per-type `data` schemas below are to be
added to `packages/contracts` as zod schemas, one per event type and major version.

---

## 3. Event catalogue

Status column: **Phase** in which the event is first needed (proposal; anchors as in
`docs/integrations/register.md` §1). All types below were checked against `EVENT_TYPE_PATTERN`.

### 3.1 Produced by Udofin

| Type                                              | Producer                                             | Consumers                                                                                 | Class.       | `data` fields                                                                                                                                                                                         | Why these fields (and what is left out)                                                                                                                                                                                                                                        | Phase               |
| ------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `in.udofin.application.submitted.v1`              | Udofin API                                           | Lender system (LOS/LMS or lender portal back end); Udofin notifications                   | confidential | `applicationId`, `productVersionId`, `requestedAmount`, `requestedTenureDays`, `submittedAt`                                                                                                          | Lender learns a new application exists and fetches details through the partner API under `application.read`. **No applicant identity.** No `loanRequestId`: it is shared across lenders and would let lenders link a borrower's applications to other lenders.                 | 4                   |
| `in.udofin.application.status_changed.v1`         | Udofin API / worker                                  | Lender system; notifications; reporting                                                   | confidential | `applicationId`, `fromStatus`, `toStatus`, `actor` (`borrower`, `lender`, `system`), `occurredAt`, `reasonCode` (optional)                                                                            | Mirrors `lending.application_events`. Free-text `reason` is left out because it may contain personal data.                                                                                                                                                                     | 4                   |
| `in.udofin.offer.accepted.v1`                     | Udofin API                                           | Lender system (KFS, agreement and booking steps); notifications                           | confidential | `offerId`, `applicationId`, `acceptedAt`                                                                                                                                                              | Terms are frozen once issued (`private.protect_offer`) and known to the lender that issued them, so they are not repeated. Acceptance evidence stays in Udofin.                                                                                                                | 4                   |
| `in.udofin.offer.declined.v1`                     | Udofin API                                           | Lender system                                                                             | confidential | `offerId`, `applicationId`, `declinedAt`                                                                                                                                                              | Lets the lender stop work on the offer.                                                                                                                                                                                                                                        | 4                   |
| `in.udofin.loan_account.disbursement_recorded.v1` | Udofin worker                                        | Udofin notifications, mandate and servicing modules                                       | confidential | `loanAccountId`, `applicationId`, `disbursedAmount`, `disbursedAt`                                                                                                                                    | One internal fact regardless of which LMS reported it (Finbyx or third-party). Bank reference left out: consumers do not need it; it stays in `servicing.loan_accounts`.                                                                                                       | 7                   |
| `in.udofin.payment.received.v1`                   | Udofin worker                                        | Lender LMS connector (payment advice); notifications; reconciliation                      | confidential | `paymentIntentId`, `loanAccountId`, `lmsLoanRef`, `purpose`, `amount`, `provider`, `providerPaymentRef`, `providerConfirmedAt`, `confirmationLevel` (`provider_confirmed`)                            | The LMS needs the amount, loan and provider reference to allocate and to match its bank statement. "Received" means **provider-confirmed only** (level 1 in the register §6), not settled or posted.                                                                           | 7                   |
| `in.udofin.payment.failed.v1`                     | Udofin worker                                        | Notifications; collections (if appointed)                                                 | confidential | `paymentIntentId`, `loanAccountId`, `failureCode`, `occurredAt`                                                                                                                                       | Normalised failure code only; provider messages left out.                                                                                                                                                                                                                      | 7                   |
| `in.udofin.payment.reconciled.v1`                 | Udofin worker                                        | Lender (operations); LawDocsComply only as aggregates via §5                              | confidential | `paymentIntentId`, `result` (`matched`, `exception`), `exceptionCode` (optional), `settlementDate`                                                                                                    | Closes the loop with the lender for each payment Udofin facilitated.                                                                                                                                                                                                           | 7                   |
| `in.udofin.mandate.status_changed.v1`             | Udofin worker                                        | Lender LMS (presentation planning); notifications                                         | confidential | `mandateId`, `loanAccountId`, `lmsLoanRef`, `rail` (`enach`, `upi_autopay`), `status`, `maxAmount`, `effectiveAt`                                                                                     | Lender needs to know a mandate is active, paused or cancelled. UMRN and bank details left out; the lender holds them with its own mandate provider.                                                                                                                            | 7                   |
| `in.udofin.complaint.raised.v1`                   | Udofin API                                           | Lender's grievance system (GRO); Udofin grievance module                                  | confidential | `complaintId`, `category`, `channel`, `receivedAt`, `lenderDueAt`, `applicationId` or `loanAccountId` (optional)                                                                                      | Starts the lender's clock; Udofin's receipt is treated as the lender's receipt. **Complaint text is not in the event**; the lender reads it through the partner API. `lenderDueAt` = `receivedAt` + 30 days unless a longer period applies (RB-IOS 2026, per RBI FAQ extract). | 7 (launch-critical) |
| `in.udofin.complaint.escalated.v1`                | Udofin API / worker                                  | Lender GRO                                                                                | confidential | `complaintId`, `fromLevel`, `toLevel` (`udofin_gro`, `lender_gro`, `lender_nodal_officer`, `lender_internal_ombudsman`), `escalatedAt`, `reasonCode` (`sla_breach`, `borrower_dissatisfied`, `other`) | Escalation inside the lender's own redressal ladder. Escalation to the RBI Ombudsman is the borrower's act, not an event Udofin produces.                                                                                                                                      | 7                   |
| `in.udofin.complaint.closed.v1`                   | Udofin API (when the lender records its final reply) | Notifications; reporting                                                                  | confidential | `complaintId`, `closedAt`, `outcomeCode`, `ombudsmanDeadline`                                                                                                                                         | The final reply must show the borrower the RBI Ombudsman route and the deadline (90 days from the later of the lender's timeline expiry or its last communication, per RB-IOS 2026 FAQ extract).                                                                               | 7                   |
| `in.udofin.consent.withdrawn.v1`                  | Udofin API                                           | Lender system (for lender-specific purposes); Equator (for referral data-sharing consent) | confidential | `consentRecordId`, `purpose`, `noticeVersion`, `withdrawnAt`, `applicationIds` (the receiving lender's own applications only)                                                                         | Lets each recipient stop processing that relied on the consent. `applicationIds` identifies the borrower to the lender without sending identity data.                                                                                                                          | 4                   |
| `in.udofin.compliance_evidence.submitted.v1`      | Udofin worker                                        | LawDocsComply                                                                             | internal     | `evidenceId`, `requestId` (optional), `controlKey`, `legalEntityOrgId`, `periodStart`, `periodEnd`, `metrics` (name → number), `artefactSha256` (optional)                                            | Evidence that a control ran, as counts and hashes only. See §5.                                                                                                                                                                                                                | 8                   |
| `in.udofin.audit_anchor.created.v1`               | Udofin worker                                        | LawDocsComply (independent copy)                                                          | internal     | `anchorId`, `rangeStart`, `rangeEnd`, `eventCount`, `digest`                                                                                                                                          | Mirrors `audit.anchors`. Keeping the digest outside Udofin's database makes deletion or alteration of audit rows detectable even by a database superuser (`private.audit_digest`).                                                                                             | 3                   |

### 3.2 Produced by Finbyx (as the lender's processor)

`tenantid` is the lender. Third-party LMSs deliver the same facts through the connector contract (§4.3).

| Type                                    | Consumers                                                                    | Class.       | `data` fields                                                                                                                                                                                                          | Why these fields                                                                                                                                                                                           | Phase |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `in.finbyx.loan.booked.v1`              | Udofin servicing-sync                                                        | confidential | `lmsLoanRef`, `applicationId`, `sanctionedAmount`, `bookedAt`                                                                                                                                                          | Creates the read-model row in `servicing.loan_accounts` (`lms_loan_ref` unique per lender; one loan per application).                                                                                      | 7     |
| `in.finbyx.loan.disbursed.v1`           | Udofin servicing-sync                                                        | confidential | `lmsLoanRef`, `applicationId`, `disbursedAmount`, `disbursedAt`, `disbursementReference`                                                                                                                               | Exactly the disbursement evidence `servicing.loan_accounts` requires all-or-nothing; only then can the application move to `disbursed` (system actor).                                                     | 7     |
| `in.finbyx.loan.schedule_updated.v1`    | Udofin servicing-sync                                                        | confidential | `lmsLoanRef`, `scheduleVersion`, `effectiveFrom`, `reasonCode` (`initial`, `part_prepayment`, `restructure`, `rate_reset`, `other`), `installmentCount`                                                                | Signals a new version; Udofin fetches the full schedule through `getSchedule` and stores it as an immutable snapshot (`servicing.schedule_snapshots`, unique per loan and version). Keeps the event small. | 7     |
| `in.finbyx.repayment.posted.v1`         | Udofin servicing-sync and reconciliation                                     | confidential | `lmsLoanRef`, `lmsReceiptRef`, `amount`, `valueDate`, `postedAt`, `allocation` (`principal`, `interest`, `charges`), `paymentIntentId` (optional), `channel` (`udofin_payment`, `mandate`, `virtual_account`, `other`) | Level-3 reconciliation (posted by the system of record) and the borrower's view of what the payment paid for.                                                                                              | 7     |
| `in.finbyx.loan.status_changed.v1`      | Udofin servicing-sync                                                        | confidential | `lmsLoanRef`, `status` (`active`, `closed`, `foreclosed`, `written_off`, `cancelled`, as `servicing.loan_status`), `effectiveAt`                                                                                       | Closure triggers mandate cancellation, lien-release prompt and NOC availability.                                                                                                                           | 7     |
| `in.finbyx.loan.delinquency_changed.v1` | Udofin collections (only if Udofin is the lender's appointed recovery agent) | confidential | `lmsLoanRef`, `dpd`, `asOf`                                                                                                                                                                                            | DPD comes from the system of record; Udofin never computes it.                                                                                                                                             | 8     |
| `in.finbyx.dlg.invocation_requested.v1` | Udofin DLG ledger (only if Udofin is the DLG provider)                       | confidential | `invocationId`, `portfolioRef`, `amount`, `loanCount`, `requestedAt`                                                                                                                                                   | Starts DLG reconciliation between the lender and Udofin; loan-level detail through the partner API.                                                                                                        | 7/9   |

### 3.3 Produced by Equator and LawDocsComply

| Type                                                | Producer      | Consumers                                                                       | Class.       | `data` fields                                                                                                                                                  | Why these fields                                                                                                      | Phase      |
| --------------------------------------------------- | ------------- | ------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `in.equator.case.status_changed.v1`                 | Equator       | Udofin grievance module (forwards to the lender only if the borrower consented) | confidential | `referralId` (Udofin's), `caseStatus` (`received`, `mediation_scheduled`, `settled`, `not_settled`, `withdrawn`, `closed`), `changedAt`                        | Sent **only if the borrower opted in to status sharing**. No case content: mediation communications are confidential. | 8 or later |
| `in.lawdocscomply.obligation.evidence_requested.v1` | LawDocsComply | Udofin compliance-evidence job                                                  | internal     | `requestId`, `obligationRef`, `controlKey`, `legalEntityOrgId`, `periodStart`, `periodEnd`, `dueAt`, `evidenceKind` (`metric`, `artefact_hash`, `attestation`) | Tells Udofin which control evidence is due and for which period.                                                      | 8          |
| `in.lawdocscomply.evidence.reviewed.v1`             | LawDocsComply | Udofin compliance owner                                                         | internal     | `requestId`, `evidenceId`, `outcome` (`accepted`, `rejected`, `needs_more`), `reviewedAt`, `reasonCode`                                                        | Closes the evidence loop.                                                                                             | 8          |

---

## 4. Lender LMS connector contract

Udofin is the client; the lender's LMS (Finbyx, or a third-party LMS directly or through an adapter) is the
server. One connector configuration per lender (Phase 4): base URL, credentials reference, mode
(`mock`, `sandbox`, `production`).

### 4.1 Transport and conventions

| Item                   | Rule                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path              | `{lmsBaseUrl}/connector/v1`                                                                                                                                                                                 |
| Authentication         | mTLS with a client certificate per (lender, environment), plus OAuth2 client credentials or an API key, as agreed with the lender. Credentials in the secrets manager (`docs/integrations/register.md` §4). |
| Format                 | As `docs/api/README.md` §5: JSON, `camelCase`, `MoneyMinor`, RFC 3339 timestamps.                                                                                                                           |
| Errors                 | RFC 9457 problem details with a stable `code`.                                                                                                                                                              |
| Idempotency            | `Idempotency-Key` on every POST; same key and body returns the original result; same key with a different body returns 409.                                                                                 |
| Timeouts (Udofin side) | 10 s per call; background calls only (never while a borrower waits on a database transaction).                                                                                                              |
| Residency              | The LMS must store and process the lender's data in India.                                                                                                                                                  |

### 4.2 Operations the LMS must implement

```ts
interface LmsConnector {
  // Optional: only for lenders that underwrite in their LMS/LOS rather than in Udofin's lender portal.
  createApplication(req: {
    applicationId: Uuid;
    productCode: string;
    productVersion: number;
    requestedAmount: MoneyMinor;
    requestedTenureDays: number;
    applicant: ApplicantFields; // field allow-list fixed in the lender's contract
    consentRecordIds: Uuid[];
    kycVaultRefs: string[];
    bureauEnquiryRefs: string[];
  }): { lenderApplicationRef: string }; // idempotent on applicationId

  // Book the loan after offer acceptance and agreement execution. One loan per application.
  createLoan(req: {
    applicationId: Uuid;
    lenderApplicationRef?: string;
    offerId: Uuid;
    acceptedTerms: {
      principal: MoneyMinor;
      tenureDays: number;
      installmentFrequency: 'monthly' | 'fortnightly' | 'weekly';
      installmentCount: number;
      installmentAmount: MoneyMinor;
      annualInterestRateBps: number;
      aprBps: number;
      processingFee: MoneyMinor;
      otherCharges: { code: string; amount: MoneyMinor }[];
    };
    kfsDocument: { documentId: Uuid; sha256: string };
    agreementDocument: { documentId: Uuid; sha256: string };
    disbursementAccountVaultRef: string; // verified account (register INT-05), held in the lender vault
    mandateId?: Uuid;
  }): { lmsLoanRef: string; status: 'booked' }; // idempotent on applicationId

  getLoan(lmsLoanRef: string): {
    lmsLoanRef: string;
    applicationId: Uuid;
    status: LoanStatus;
    sanctionedAmount: MoneyMinor;
    disbursement: { amount: MoneyMinor; at: Timestamp; reference: string } | null; // all three or null
    outstanding: {
      principal: MoneyMinor;
      interest: MoneyMinor;
      charges: MoneyMinor;
      total: MoneyMinor;
    };
    nextDue: { date: string; amount: MoneyMinor } | null;
    scheduleVersion: number;
    updatedAt: Timestamp;
  };

  getSchedule(
    lmsLoanRef: string,
    version?: number,
  ): {
    version: number;
    effectiveFrom: string;
    installments: {
      seq: number;
      dueDate: string;
      principal: MoneyMinor;
      interest: MoneyMinor;
      fees: MoneyMinor;
    }[];
  }; // maps 1:1 to servicing.schedule_snapshots / schedule_installments

  // Udofin tells the LMS about a provider-confirmed payment. The LMS remains authoritative for allocation
  // and answers later with repayment.posted.
  postPaymentAdvice(
    lmsLoanRef: string,
    req: {
      paymentIntentId: Uuid;
      amount: MoneyMinor;
      purpose: string;
      provider: string;
      providerPaymentRef: string;
      providerConfirmedAt: Timestamp;
      settlementAccountRef: string;
    },
  ): { adviceRef: string; status: 'received' }; // idempotent on paymentIntentId

  getForeclosureQuote?(
    lmsLoanRef: string,
    asOf: string,
  ): { amount: MoneyMinor; validUntil: Timestamp };

  // Changes feed for reconciliation sweeps and recovery of missed callbacks.
  listChanges(
    after?: string,
    limit?: number,
  ): {
    data: {
      lmsLoanRef: string;
      kind: 'booked' | 'disbursed' | 'schedule' | 'repayment' | 'status';
      changedAt: Timestamp;
    }[];
    nextCursor: string | null;
  };
}
```

### 4.3 Callbacks the LMS must send

- Delivered to `POST {udofinBase}/v1/partner/lms/events` as signed CloudEvents envelopes (signature scheme
  in `docs/api/README.md` §11.1, with a per-lender secret).
- Facts: loan booked, loan disbursed, schedule updated, repayment posted, loan status changed; later,
  delinquency changed and DLG invocation requested. `data` schemas are those in §3.2.
- Finbyx uses the `in.finbyx.*` types in §3.2.
- **Third-party LMSs: open decision.** `EVENT_TYPE_PATTERN` accepts only the products `udofin`, `finbyx`,
  `lawdocscomply` and `equator`, so a third-party LMS cannot send a valid `type` in its own name. Options:
  (a) add a neutral producer token (for example `lms`) to the pattern, which is a code change in
  `packages/contracts`; or (b) the lender's adapter translates the LMS's native callbacks. Either way,
  Udofin's internal consumers subscribe only to Udofin's own facts (for example
  `in.udofin.loan_account.disbursement_recorded.v1`), so they do not depend on which LMS a lender uses.

### 4.4 Behaviour the LMS must guarantee

1. Disbursement is reported only with date, amount and bank reference together.
2. Schedule versions are immutable and increase by one; a changed schedule is a new version.
3. Callbacks are sent within minutes of the fact and are retried until acknowledged; the changes feed keeps
   at least 30 days of history so missed callbacks can be recovered.
4. Udofin is never sent loans it did not source.
5. A sandbox with synthetic data is available, and the connector passes Udofin's contract test kit
   (mock server and conformance tests, to be added to `packages/adapters`) before go-live.

### 4.5 Reconciliation with the LMS

A nightly job walks `listChanges` and compares each loan's `getLoan` result with the read model
(`servicing.loan_accounts`, latest schedule snapshot, posted repayments). Differences become reconciliation
items; Udofin's read model is updated only from the LMS, never edited by hand.

---

## 5. LawDocsComply compliance and evidence feed

| Item              | Rule                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction         | Udofin sends evidence to **its own** LawDocsComply tenant. A lender's tenant receives Udofin evidence only under that lender's agreement.                                                                                                                                                                                                                                             |
| Transport         | Events (`in.udofin.compliance_evidence.submitted.v1`, `in.udofin.audit_anchor.created.v1`) plus a pull API for re-sync: `GET /v1/partner/compliance/evidence?after=<cursor>`. LawDocsComply's requests arrive as `in.lawdocscomply.obligation.evidence_requested.v1`.                                                                                                                 |
| Authentication    | Partner client for LawDocsComply (mTLS plus API key or OAuth2 client credentials).                                                                                                                                                                                                                                                                                                    |
| Content allowed   | Counts and rates per period (e.g. KFS shown before acceptance, offer displays logged with ranking-rule version, complaints resolved within 30 days, reconciliation exceptions by age), artefact hashes (consent notice SHA-256, policy documents), maker-checker evidence (product version approved by a different user: yes/no), audit anchor digests, attestations by a named role. |
| Content forbidden | Any borrower personal data or record-level identifier, including Udofin's own application or loan ids. Where an auditor needs a sample, LawDocsComply records the request and the auditor inspects the record inside Udofin or the lender's systems under their own access.                                                                                                           |
| Small numbers     | Counts below 5 are reported as `<5` so that small lenders' figures cannot identify a person.                                                                                                                                                                                                                                                                                          |
| Conflict controls | If lenders use LawDocsComply to oversee Udofin: strict tenant isolation, per-tenant keys, no Udofin staff access to lender tenants, and the group affiliation disclosed in the lender's outsourcing due diligence.                                                                                                                                                                    |

---

## 6. Equator referral contract

Equator is offered only as an **optional, borrower-initiated, post-dispute, mediation-first** route, never as
a default or mandatory escalation. Under RB-IOS 2026 (in force 1 Jul 2026, per RBI FAQ and RE-published
extracts) a complaint is not maintainable before the Ombudsman if the same grievance is pending before, or
decided by, an arbitrator or other forum, and the borrower has 90 days to file. Whether private mediation
counts as "other forum" is an open legal question. The group's ADR platform appears publicly as Equa.Law
(`equa.law`), while `equator.in` is indexed as an unrelated company: **no Equator domain may be configured
until the group's control of it is verified.**

### 6.1 Preconditions Udofin enforces

1. A complaint exists, and either the lender's final reply has been received or 30 days have passed.
2. Referral type is mediation only. Arbitration referrals for retail borrowers are blocked (research
   GR-03).
3. The borrower has seen, and acknowledged, a disclosure screen showing: the group affiliation; the RBI
   Ombudsman route with the computed deadline; the possible effect on that route; and an unaffiliated
   alternative.
4. A separate consent for sharing data with Equator is recorded in `consent.records` against a published
   notice for that purpose (the notice text is hashed and immutable).
5. The borrower chooses what to share.

### 6.2 Flow

```text
Borrower (app)            Udofin API                         Equator
     | request referral        |                                 |
     |------------------------>| checks 6.1; records consent     |
     |                         | creates referral + one-time token
     |<-- referral id, link ---|                                 |
     | opens Equator in a separate-origin web view (no JS bridge),|
     | token in the URL fragment (fragments never reach server logs)|
     |---------------------------------------------------------->|
     |                         |<-- POST /v1/partner/equator/referrals/redeem {token}
     |                         |--- referral package ----------->|
     | borrower signs in to Equator with Equator's own account   |
     |                         |<-- in.equator.case.status_changed.v1 (only if borrower opted in)
```

| Element            | Rule                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token              | Opaque, at least 128 random bits, single use, expires after 15 minutes, bound to the referral id, the purpose and Equator's partner client; stored only as a hash. Second redemption fails.                                                                                                                                                             |
| Redemption         | Server to server, Equator's partner client (mTLS plus API key).                                                                                                                                                                                                                                                                                         |
| Referral package   | `referralId`, `createdAt`, `lenderDisplayName`, `loanReference` (the lender's loan reference, if the borrower chose to share it), `complaintSummary` (text the borrower wrote or confirmed), `complaintReceivedAt`, `lenderFinalReplyAt` (if any), `ombudsmanDeadline`, `documents[]` (name, SHA-256, short-lived download URL) chosen by the borrower. |
| Not in the package | Phone, email, address, PAN, Aadhaar, bank details, KYC or bureau data, Udofin's borrower id. The borrower gives Equator contact details directly; there is no shared borrower identifier between products.                                                                                                                                              |
| Status back        | Only with a separate borrower opt-in; status codes only. Udofin forwards status to the lender only if the borrower consented to that too.                                                                                                                                                                                                               |
| Withdrawal         | `in.udofin.consent.withdrawn.v1` tells Equator to stop status sharing. Data already shared is governed by Equator's own notice as an independent fiduciary.                                                                                                                                                                                             |
| Audit              | Every transfer is an audit event carrying the consent record id.                                                                                                                                                                                                                                                                                        |
| Independence       | No pre-dispute ADR clause in retail loan documents; affiliation disclosed; conflict checks on neutrals in Equator; segregation of duties across group staff roles (§8).                                                                                                                                                                                 |

---

## 7. Versioning and compatibility

| Rule                        | Detail                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Major version in the type   | `….v1`. A breaking change to `data` creates `….v2`.                                                                                                                                               |
| Non-breaking within a major | Adding optional fields; adding values to enums documented as open; adding new event types.                                                                                                        |
| Breaking                    | Removing or renaming a field; changing a type, unit or meaning; making a field required; adding a value to a closed enum.                                                                         |
| Parallel publication        | Producers publish both majors until every consumer has migrated (as stated in `envelope.ts`); minimum overlap 90 days between group products, 6 months for lender systems.                        |
| Consumer duties             | Ignore unknown fields; map unknown values of open enums to a safe default; reject (and park) events of an unknown major version instead of guessing.                                              |
| Envelope                    | The envelope attributes are fixed by `EventEnvelope`. A new optional extension attribute is non-breaking; anything else is a contracts-package major change.                                      |
| Schemas                     | One zod schema per event type and major in `packages/contracts`; documentation (AsyncAPI) is generated from them. Consumer contract tests run in each product's CI against the published schemas. |

---

## 8. Staff SSO across products

- One workforce identity provider for group staff is acceptable, but each product keeps its own roles and
  authorisation.
- Segregation of duties is enforced at role-grant time: no person may hold Udofin collections or operations
  roles and Equator case-administration or neutral roles at the same time; LawDocsComply staff get no
  access to lender tenants' oversight of Udofin.
- Borrowers are never silently linked across products. If federation is ever used, each product receives a
  pairwise subject identifier and the borrower explicitly consents to the link.

---

## 9. Delivery guarantees

| Stage              | Guarantee                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Produce            | **Transactional outbox.** The event row is written in the same Postgres transaction as the state change it describes. If the transaction rolls back, no event exists; if it commits, the event will be delivered.                                              |
| Relay              | A worker (pg-boss) reads the outbox and delivers by signed webhook or internal queue, with exponential backoff for up to 24 hours, then a dead-letter queue and an alert.                                                                                      |
| Delivery semantics | **At least once.** Duplicates are possible; exactly-once is not promised.                                                                                                                                                                                      |
| Consume            | **Inbox with de-duplication on (`source`, `id`).** The consumer inserts the event into its inbox (unique constraint) and acknowledges with 2xx; processing and the "processed" mark happen in one transaction. A duplicate insert is acknowledged and ignored. |
| Ordering           | Not guaranteed. Consumers use `time` and aggregate versions (for example `scheduleVersion`) and validate state transitions against the lifecycle (`packages/domain`); on a gap, they fetch the current state through the API.                                  |
| Replay             | Outbox rows are kept for at least 30 days; partners can re-read via the events replay endpoint (`docs/api/README.md` §11.1).                                                                                                                                   |
| Reconciliation     | Event delivery is never the only path: the LMS changes feed (§4.5), provider status polls and settlement reports (register §6) catch anything missed.                                                                                                          |

---

## 10. Open decisions and inconsistencies

1. Third-party LMS event types versus `EVENT_TYPE_PATTERN` (§4.3).
2. Whether private mediation is "other forum" under RB-IOS 2026, which decides whether Equator may be
   offered at all before the Ombudsman deadline passes (legal review).
3. Equator domain, brand and legal form (§6).
4. Whether Udofin will be the lender's recovery agent (needed for `in.finbyx.loan.delinquency_changed.v1`)
   and the DLG provider (needed for `in.finbyx.dlg.invocation_requested.v1`).
5. Authorisation server for OAuth2 client credentials between group products, or API keys plus mTLS only.
