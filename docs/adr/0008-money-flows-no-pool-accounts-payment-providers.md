# ADR-0008: Money flows — no Udofin pool accounts; lender-owned payment rails

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0007, ADR-0011, ADR-0012, ADR-0023

## Context

Research findings (`docs/research/2026-10-10/rbi-digital-lending.md` §3.3–3.4, `providers-payments.md` §4–5):

- Disbursement must go straight into the borrower's bank account. Exceptions: disbursals required by statute or regulation, money moving between lenders in co-lending, and specific end-use loans paid to the end-beneficiary. Repayment must go straight into the lender's bank account; no LSP pass-through or pool account; no third party may control the flow of funds. Status: confirmed (secondary) in `rbi-digital-lending.md`; likely (secondary, RBI text not reachable) in `providers-payments.md`. `providers-payments.md` also reports a same-day-reflected cash-recovery exception for delinquent loans by lender-authorised agents (likely).
- The lender pays the LSP's fees; the borrower is never charged by the LSP (confirmed (secondary)).
- Stripe has been invite-only in India since May 2024 (confirmed, vendor help page via search snippet; still invite-only in 2026: likely). PayPal ended domestic India payments from 1 Apr 2021 (confirmed, secondary). Neither supports NACH or UPI AutoPay for Indian lenders (interpretation).
- Razorpay, Cashfree, PayU (payment aggregators) and Juspay (orchestration) can run with the lender as merchant; eNACH/UPI AutoPay mandates need the lender as the NACH "corporate" through a sponsor bank; virtual accounts and BBPS biller onboarding can be in the lender's name (likely, not fetched).
- The owner's original plan used Razorpay, Stripe and PayPal "for all products".

## Decision

1. **No Udofin pool, pass-through, escrow or collection account** for borrower money, ever. Udofin never holds or routes loan funds.
2. **Disbursement** is made from the lender's account to the borrower's verified account. Any other beneficiary is allowed only under the exceptions above, set by the lender with a reason. Payout platforms may be used only in a mode that debits the lender's own account, never a pre-funded pool controlled by Udofin (interpretation).
3. **Repayments** settle directly into the lender's account using the **lender's own** merchant, mandate and biller credentials: Razorpay, Cashfree, PayU or Juspay for one-time payments; eNACH / UPI AutoPay mandates with the lender as creditor; virtual accounts or BBPS in the lender's name.
4. **Stripe and PayPal are excluded** for domestic repayments. They may be used only for Udofin's own cross-border B2B billing, if that is ever needed.
5. Udofin's own gateway account is used only to collect Udofin's B2B fees from lenders. LSP fees are invoiced to lenders, never charged to borrowers.
6. Udofin's role is to create payment **instructions** and to **reconcile** using provider events and settlement reports (read-only).
7. Database rules (`supabase/migrations/20261010000500_servicing_payments.sql`):
   - `payments.payment_intents` records each instruction with `settlement_account_ref` (the lender's collection account), provider, INR currency only, and an `idempotency_key` unique per lender;
   - an intent must belong to the borrower's active loan; amount, account and parties are immutable; terminal states are final;
   - only the system may move an intent to `succeeded` or `failed`, after processing a verified provider event; a borrower can only cancel an intent that has not started;
   - `payments.provider_events` is append-only, de-duplicated on `(provider, provider_event_id)`, stores a SHA-256 of the payload (not the raw payload, which may hold personal data) and a `signature_verified` flag.

## Implementation state

- Done: the schema rules above and their tests.
- Not yet built: provider adapters, webhook signature verification, per-lender payment configuration (Phase 4), mandate management, reconciliation jobs.

## Alternatives considered

| Option                                                         | Why rejected                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Udofin as merchant of record, with split settlement to lenders | Money passes through Udofin's account: a pass-through the rules bar (research).   |
| Udofin-controlled escrow or nodal account                      | Third-party control of the flow of funds (research).                              |
| Stripe / PayPal for repayments                                 | Not available or not suitable for domestic INR loan collection (research, above). |
| One Udofin payout account pre-funded by lenders                | Risks being a pass-through (interpretation).                                      |

## Consequences

**Positive**

- Udofin never holds customer money, which keeps it out of the flow of funds.
- Each lender sees settlements in its own account and reports.

**Negative**

- Every lender must onboard as a merchant with a payment aggregator, a sponsor bank for NACH, and possibly BBPS. New merchant onboarding reportedly requires liveness/video-KYC from 1 Jan 2026 (likely).
- Udofin cannot net its fees from collections; it invoices lenders.
- Reconciliation and configuration multiply per lender and per provider.

**Risks and known gaps (baseline)**

- `settlement_account_ref` is free text supplied when the intent is created. It is not yet validated against a lender-configured account table (Phase 4). Until then the guarantee rests on the API.
- The database does not require a matching verified provider event before the system marks an intent `succeeded`; that check is the worker's job.
- `provider_events` is not composite-keyed to the intent's lender (ADR-0005).
- e-mandate amount caps, AFA exemptions and pre-debit notice rules are unverified in research; get them from the provider or sponsor bank, do not hard-code from memory.

## Compliance and security notes

- Supports the reported flow-of-funds and LSP-fee rules (research labels above). Evidence: mandate records naming the lender as creditor, PA settlement reports showing the lender as beneficiary, configuration audit logs.
- Bounce or dishonour charges are the lender's penal charges and must appear in the KFS (likely).
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: borrower starts a repayment on own loan; a replayed request with the same idempotency key cannot create a second payment; `created → succeeded` is rejected; a borrower cannot mark a payment succeeded; the system records success; a succeeded payment cannot become failed; amounts are immutable; a replayed provider webhook is rejected as a duplicate.
- `supabase/tests/002_tenant_isolation.test.sql`: a borrower cannot create a payment against another borrower's loan; payment visibility is per lender and per borrower.
- Planned (research PAY-01): configuration validation that rejects any non-lender settlement account; reconciliation showing no Udofin-held funds.

## Revisit triggers

- Udofin is appointed as a lender's recovery agent with cash collection (same-day deposit rule; ADR-0023).
- Co-lending or end-use (dealer, hospital) disbursements are introduced.
- A cross-border product, or a change in Stripe/PayPal availability in India.
- Primary-text review changes the reported exceptions.
