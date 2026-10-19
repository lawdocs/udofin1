# Reminders and service communications (migration 20261018000914)

Interface notes for the API, worker and screens. Spec: `docs/specs/08-servicing-payments-mandates-collections.md` section 11 and the owner decision of 14 October 2026 (5). Tests: `supabase/tests/020_p08a_reminders.test.sql`.

## What is and is not built

- **In-app and push only.** There is no SMS provider. `sms` is accepted in a policy as an inert placeholder: the planner writes those rows as `suppressed` (`sms_not_configured`), nothing can claim them, and the delivery log refuses any `sms` state except `not_configured`. There is no mock SMS in any environment.
- **Service messages only.** No offers, no cross-sell, no link, no contact detail. Wording is checked by `private.reminder_text_ok` (closed variable set, no promotional vocabulary in English, no run of eight or more digits, no PAN-shaped token, plain characters only). The check is a floor: an approver still reads the wording, and Hindi wording is checked for shape, not meaning.
- **The lender's words, the lender's approval.** Policy, wording and penal-charge text are drafted by `reminder.policy.manage` and approved by a DIFFERENT person with `reminder.template.approve` (aal2, versioned, one approved version per lender, kind and language). One login cannot hold both permissions (segregation trigger, same mechanism as the payment pairs).
- **Nothing is invented.** An overdue message is sent only with the lender's approved penal-charge sentence, verbatim. Without one the message is suppressed (`penal_text_missing`) and the lender gets one open `penal_text_missing` exception in the reconciliation queue. Udofin never computes, adds or adjusts a charge. The sentence is not a regulatory quotation: the lender supplies it and attests that the charge is separate from interest and not compounded.
- **Not built:** quiet-hours configuration beyond the window below, per-borrower preferences or opt-out, templates in languages other than `en` and `hi`, delivery receipts from a real push provider (the worker records them through `record_reminder_attempt`; the push adapter itself is a later stream), marketing of any kind.

## The rules (all data or constraints, none in code paths a client can reach)

| Rule         | Default                                                                                                                                   | Where it can change                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Window       | 08:00 to 19:00 IST (start inclusive, end exclusive). Evidence label: **interpretation** of RBC Directions 2025 para 100 (unverified).     | An approved `servicing.reminder_window.default` rule or the lender policy can only NARROW it. |
| Daily cap    | 2 distinct messages per loan per IST day (the same message on two channels counts once). Evidence label: **unverified** platform default. | An approved `servicing.reminder_max_per_day` rule or the lender policy can only LOWER it.     |
| Quiet period | 48 hours after a verified payment or a lender-posted receipt that was not reversed. Evidence label: **unverified** platform default.      | An approved `servicing.suppress_after_payment_hours` rule can only LENGTHEN it.               |
| Expiry       | A planned message more than 48 hours late is suppressed (`expired`).                                                                      | Code constant.                                                                                |
| Attempts     | Three claims per message; a failed attempt is retried after 15 minutes times the attempt number.                                          | Code constant.                                                                                |

All three platform rules are seeded as **drafts** in `documents.applicability_rules` (never approved by seed). With only drafts, the defaults above apply. An approved rule that is malformed is ignored (the defaults stay); an approved rule never widens a default. Approving a rule is the existing two-person documents flow.

A message outside the window is **deferred** (it stays `planned` and is picked up in the next window), never dropped silently and never sent early. `private.reminder_window_clock()` is the real clock; in a session that allows mock providers (non-production) and has set `udofin.test_clock`, the window check alone reads that instant so the test suite is independent of the time of day. Production must keep `udofin.allow_mock_providers` unset (same guard as the mock providers).

## Functions

People (aal2, SQLSTATE|hint): `servicing.draft_reminder_policy(lender, offsets[], overdue_weekly, channels[], window_from, window_to, max_per_day)`, `approve_reminder_policy(id)`, `retire_reminder_policy(id)`, `draft_reminder_template(lender, kind, language, body)`, `approve_reminder_template(id)`, `retire_reminder_template(id)`, `draft_penal_charge_text(lender, charge_kind, flat_minor, percent_bps, separate_from_interest, not_compounded, reason, sentence_en, sentence_hi)`, `approve_penal_charge_text(id)`, `retire_penal_charge_text(id)`, `place_communication_hold(loan, reason, note)`, `release_communication_hold(hold, note)`, `reminder_summary(lender, since)` (invoker, row level security).

- `22023` hints: `offsets_invalid`, `channels_invalid`, `window_invalid`, `policy_invalid`, `template_invalid`, `wording_invalid`, `penal_text_variable_missing`, `charge_invalid`, `attestation_missing`, `hold_invalid`. `42501` hints: `mfa_required`, `self_approval`. `55000`: `not_a_draft`, `already_retired`, `already_released`. `23505`: `hold_active`. `P0002` is answered both for an unknown id and for an id the caller has no permission over (existence is not disclosed). Free-text notes and wording are never written to the audit log.
- Approving a policy retires the previous version and suppresses the messages still planned under it (`policy_retired`). A hold suppresses the messages planned for the loan (`hold`); a hold never blocks the borrower from paying (no payment function reads it).

System (service role only): `servicing.plan_reminders(horizon, limit)` plans messages for lenders whose `reminders` and `servicing_sync` switches are on and that have an approved policy; `servicing.claim_due_reminders(limit, lease)` freezes and returns up to `limit` rows (ids, channel, kind and the content hash; **not the text**); `servicing.record_reminder_attempt(reminder, state, source, provider_ref, error_class)`; `servicing.suppress_reminders_for_loan(loan, reason)` (for a closure consumer).

- **Plan.** Offsets are days from each installment's due date in the newest schedule (negative before, positive after). Overdue offsets are planned only for the oldest overdue installment, taken from the days past due the lender reported, and only from a consistent, fresh report. After the last overdue offset a weekly tail continues up to 90 days past due. The message is scheduled at the start of the effective window, IST.
- **Claim.** A message is claimed only inside the effective window, for an active loan, with no hold, no recent payment, and a consistent, fresh lender report (the same fail-closed rule as the borrower's loan view; a stale or inconsistent report holds the message back, it does not send an old figure). Pre-due and due-day messages need the report's `next_due_on` to equal the installment's due date (an earlier due date means the installment was paid: `paid`; none: `nothing_due`); overdue messages need a reported overdue total and days past due. The wording, language (Hindi falls back to English, `language_fallback`), figures and the penal sentence are **frozen at claim** with SHA-256 hashes; a retry after a lost lease re-uses the frozen content, and refuses to send under a penal-charge text that has since been retired. A per-loan advisory lock keeps two workers from both taking the second message of the day.
- **Record.** `send/accepted` means the channel took the message (for `in_app`: it is in the inbox). It is **not** delivery. `delivered` exists only from a `delivery_report` (check constraint), a repeated report answers `duplicate`. `send/failed` retries; `send/not_configured` suppresses the message (`channel_not_configured`) and is never reported as sent.

Borrower: `servicing.my_reminders()` (the latest 50 sent messages, one per message across channels, text rebuilt from the frozen references and shown only if it matches the stored hash) and `servicing.mark_reminder_read(reminder)`. Lenders read their own rows through row level security (`loan.read`; the policy and wording tables also for the two reminder permissions). The reminder tables are never readable by a borrower directly.

**Push payloads** carry no amount, no lender name, no loan reference and no wording: a fixed generic line and the reminder id as a deep link. The message is read in the app. (The push adapter is a later stream; the database holds no push token.)

## Activation (private.feature_prerequisites_unmet, extended here)

`reminders`: `servicing_sync_not_enabled`, `reminder_policy_missing`, `reminder_templates_missing` (an approved English wording for each of pre_due, due_day and overdue). An approved penal-charge text is deliberately **not** a prerequisite: without it overdue messages are suppressed and the lender is told. `servicing_sync`: `lms_connection_not_active` (an ACTIVE file-import or manual connection in production mode). `statements_noc`: `servicing_sync_not_enabled`. Every earlier reason is preserved. Mandates add theirs in the mandates migration.

## Missing-texts register (owner decision 6)

Nothing below is claimed as compliant. Each needs the lender's or the regulator's primary text before launch:

1. The lender's penal-charge disclosure sentence and the agreement clause it comes from (per lender).
2. RBC Directions 2025, para 100 and the rest of the recovery-conduct text: whether service reminders, and overdue reminders in particular, fall under the calling-hours rule (`interpretation` today). Whether the TRAI promotional-hours rules apply to these messages is also **unverified**.
3. The cap of two messages a day and the 48-hour quiet period are product defaults with no source.
4. Hindi wording is checked for shape only; a Hindi-reading reviewer must approve each lender's Hindi wording.
5. Push notification content and consent wording for the borrower app.

## Not done here

- The worker handlers (`reminders.plan`, `reminders.claim_and_send`, delivery-report intake), API routes, contracts and the screens (lender portal reminder policy/wording/holds, borrower inbox).
- A real push provider; the delivery log is ready for it.
