# Phase 08a review fixes: borrower mobile app (area M)

Branch `p08a/fix-M`, from `8463bb1`. Scope: `apps/mobile` only. These are the findings A37 to A41 of the Phase 08a review. Nothing here
claims regulatory compliance; the Hindi wording is still the builder's draft and has not been reviewed by a native speaker or counsel.

| ID  | What changed                                                                                                                                                                                                                                                                                                                 | Test that covers it                                                                                                                                                                                                      | Status                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| A37 | The setup screen reads `BorrowerMe.integrityLevel`. Below `device` it shows a plain notice (setting up auto-pay is not available in this version of the app) and a one-time payment button instead of the form. `mandate.err.integrity` no longer claims a failed check. English and Hindi.                                  | `test/payments.test.ts`: "mandate setup is offered only where the API can accept it (A37)", the error-words test for `integrity_insufficient`, and the source check on `mandate-setup.tsx`. Parity: `test/i18n.test.ts`. | fixed (dependency recorded below) |
| A38 | `pay.destination` is now a statement about where payments go ("Payments for this loan go to {lender}'s account {account}" / Hindi equivalent), not "Paid to ...". The "never says paid" scan now covers every `pay.*` and `mandate.*` key in both languages, and the destination line is rendered at every stage and status. | `test/payments.test.ts`: "never says paid or successful in any pay.* or mandate.* key, in either language"; "words the destination the same, and never as paid, at every stage and status in both languages".            | fixed                             |
| A39 | `usePolled` runs only while the screen is focused and the app is in the foreground (`createPollGate`, `startPollRun` in `payments-polling.ts`; `useFocusEffect` and the `AppState` listener in `usePayments.ts`). It ends on blur, background and unmount, and starts again with a fresh read.                               | New `test/polling-gate.test.ts` (fake timers; gate, run, and a source check that ties the hook to them).                                                                                                                 | fixed                             |
| A40 | The loan home has a "Your auto-pay mandates" button to `/payments` (`mandateListHref`, English and Hindi). The targets for pay, mandate setup and payment status are unchanged.                                                                                                                                              | `test/servicing-screens.test.ts` ("the loan page links to the list of auto-pay mandates ..."), `test/servicing.test.ts` ("where the payment buttons go").                                                                | fixed                             |
| A41 | `parseRupees` accepts a comma only in Indian (`1,00,000`) or international (`100,000`) grouping and refuses anything else with the existing `invalid` code. Integer arithmetic is unchanged (BigInt).                                                                                                                        | `test/borrower-logic.test.ts`: table test including `5000,50`, `1,00`, `1,00,000`, `100,000`, `1,0,0`, `,100`, `100,`, `1,,000`.                                                                                         | fixed                             |

Each new test was seen to fail with the fix removed and to pass with it restored.

## A37: dependency for the decision register (D-24)

- `payments.request_mandate` refuses unless the borrower's device-integrity level is `device` or `strong`. That level is written only by
  `POST /v1/integrity/verify`, and no production verifier exists (owner decision D-24; `docs/specs/05-borrower-onboarding.md`). The app has
  no attestation library, and no attestation flow was built here, as instructed.
- Consequence, stated plainly: until a verifier exists and the app can obtain an attestation, **no borrower can set up auto-pay from the
  app**. The setup screen now says so. This was already true before this fix; the difference is that the borrower is told before filling a
  form and requesting a one-time code, and is not told that the phone failed a check that was never run.
- The dependency to record: "Borrower auto-pay setup in the app depends on D-24 (device-integrity verifier and the app's attestation
  flow). Until then the app shows 'not available in this version of the app' and offers a one-time payment." When the verifier exists, the
  gate opens by itself for borrowers whose `integrityLevel` is `device` or `strong`; the nonce, platform token and verify steps still have
  to be added to the app (`integrityNonce` and `verifyIntegrity` exist in `src/borrower/client.ts` but no screen calls them).
- Correction for `docs/specs/08a-notes/screens-u2.md` ("How a mandate goes", step 3, and the setup description): the form in step 3 is
  reachable only at integrity level `device` or `strong`, which the app cannot reach today. `mandates.md` and `pending-doc-items.md`
  should carry the same sentence. (This notes file is the only document changed here; the lead decides whether to edit those.)
- The error words for `integrity_insufficient` (API refusal) now read the same plain sentence as the notice. If the API still answers
  that code (for example a stale level), the borrower sees "cannot be set up in this version of the app".

## A38: wording

- Before: "Paid to {lender}'s account {account}" on the Pay screen before anything was chosen and under cancelled, failed and expired
  payments. After: "Payments for this loan go to {lender}'s account {account}". It describes the destination of the loan's payments, not
  the state of this payment, so it is correct at every stage. The Hindi text was a neutral noun phrase; it now carries the same sentence
  as the English one.
- The only remaining use of the word "paid" in any key is "cannot be paid" (two keys about a flagged quotation), which says that paying is
  not possible. The scan sets that phrase aside explicitly.

## A39: behaviour notes

- A run ends on blur, on the app going to the background, and on unmount. The iOS "inactive" state changes nothing. A new run starts when
  the screen is focused in the foreground (first focus included), with a fresh read and the attempt counter at zero.
- The old behaviour restarted a run on every return to the app for every mounted screen, hidden ones included. That path is gone: only the
  gate starts a run, and a hidden screen has no run to restart.
- "Check again" (`refresh`) restarts the run for a visible screen and only marks the screen as waiting for a hidden one.
- The claim in `screens-u2.md` that automatic checking "stops when the screen is left" is now true for leaving a tab, not only for
  unmounting.
- Not covered: the hook itself is not rendered (the mobile test runner is node only, no React Native runtime). The pure logic is tested
  with fake timers and a source check ties the hook to it. A device run (tab away and back, background and foreground) is still advisable.

## A40: correction for `screens-u2.md`

- The line "No Settings entry. As instructed, the mandate list (`/payments`) is reachable only by route; the loans builder links to it."
  was wrong when written: no loans screen linked to `/payments` (`servicing-view.ts` only had the pay, quotation, mandate-setup and
  payment-status links). Correct statement: the mandate list is now linked from the loan home ("Your auto-pay mandates"); there is still
  no Settings entry. The list shows every mandate of the borrower, whatever its status, so a rejected, failed, expired, cancelled or
  revoked mandate can be opened, and a live one can be reached for "Request cancellation" without the setup screen.

## A41: notes

- Accepted: plain digits; Indian grouping (`1,00,000`, `12,34,567`, `12,345`); international grouping (`100,000`, `1,234,567`); an
  optional fraction of one or two digits. Refused as `invalid`: a comma anywhere else (`5000,50`, `1,00`, `1,5`, `1,0,0`, `,100`, `100,`,
  `1,,000`), a first group starting with 0 (`0,100`), a comma in the fraction.
- A decimal comma is therefore refused, never read as a thousands separator. The field hint ("for example 5,000 or 5000.50") is unchanged.
- `new-request.tsx` uses the same parser for the requested loan amount and gets the same stricter behaviour.

## Needs from other areas

None.

## Risks noticed, not changed

- `BorrowerMe` is loaded once when the signed-in layout mounts. The setup screen reads the level from that state; since the form is
  hidden for every level the app can reach today, a stale value has no effect now. When a verifier exists, the screen should refresh `me`
  after a successful attestation.
- No render tests and no device run exist for the screens (see `screens-u1.md` and `screens-u2.md`).
