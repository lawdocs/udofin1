import {
  LP_EVENT_OBJECT_KINDS,
  LP_PAYMENT_PURPOSES,
  LP_PAYMENT_STATUSES,
  LP_SETTLEMENT_STAGES,
} from '@udofin/contracts';
import { OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyState } from '../states.js';
import { lpIsUuid, type LpResult } from './data.js';
import { lpCount, lpDateTimeIst, lpRupees, lpRupeesPlain } from './format.js';
import {
  ADJUSTMENT_KIND_WORDS,
  BANK_CONFIRMATION_BASIS_WORDS,
  EVENT_OBJECT_KIND_WORDS,
  EVENT_OUTCOME_WORDS,
  EVENT_PROCESSING_CLASS_WORDS,
  EVENT_REASON_WORDS,
  MANDATE_MODE_WORDS,
  PAYMENT_PURPOSE_WORDS,
  PAYMENT_STATUS_WORDS,
  PROVIDER_PAYMENT_STATUS_WORDS,
  RECEIPT_OUTCOME_WORDS,
  STAGE_SOURCE_WORDS,
  STAGE_WORDS,
  lpWord,
} from './labels.js';
import {
  ConfirmField,
  CriticalBanner,
  Facts,
  Loadable,
  PAYMENTS_LINKS,
  Pager,
  LpLender,
  LpNotice,
  SectionNav,
  WhatItChanges,
  type LpViewContext,
} from './parts.js';
import {
  type PaymentDetail,
  type PaymentPage,
  type PaymentPolicyList,
  type ProviderEventPage,
  type WebhookSummary,
} from './types.js';

const options = (values: readonly string[], words: (value: string) => string) =>
  values.map((value) => ({ value, label: words(value) }));

const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
] as const;

type ProviderEventRow = ProviderEventPage['items'][number];

/** The API returns at most this many provider payments and this many adjustments for one payment request. */
const LIST_CAP = 200;

/** The provider's mode in plain words. A test mode is said out loud. */
const modeWords = (mode: string | null) => (mode ? lpWord(MANDATE_MODE_WORDS, mode) : 'Not stated');

// ---------------------------------------------------------------------------------------------------------------
// Payments list
// ---------------------------------------------------------------------------------------------------------------
export function LpPaymentsListView({
  page,
  filters,
  keep,
  done,
  error,
}: {
  page: LpResult<PaymentPage> | undefined;
  filters: {
    status?: string | undefined;
    purpose?: string | undefined;
    loanAccountId?: string | undefined;
  };
  /** The filters to carry to the next page of the list. */
  keep: Readonly<Record<string, string>>;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <section>
      <h1>Payments</h1>
      <SectionNav links={PAYMENTS_LINKS} current="/payments" label="Payments" />
      <LpNotice done={done} error={error} />
      <p className="muted">
        Payments that borrowers asked to make for loans of your organisation, newest first. Amounts
        are the paise recorded, written as rupees. “Received by the payment provider” means the
        provider reported it in a verified event; it does not mean your loan system has posted it.
        Open a payment to see the four stages as separate facts.
      </p>
      {lpIsUuid(filters.loanAccountId) ? (
        <p>
          Showing only the payments of one loan account. <a href="/payments">Show all payments</a>
        </p>
      ) : null}
      <form method="get" action="/payments" className="form">
        {lpIsUuid(filters.loanAccountId) ? (
          <input type="hidden" name="loanAccountId" value={filters.loanAccountId} />
        ) : null}
        <SelectField
          name="status"
          label="Status"
          blank="All statuses"
          defaultValue={filters.status ?? ''}
          options={options(LP_PAYMENT_STATUSES, (v) => lpWord(PAYMENT_STATUS_WORDS, v))}
        />
        <SelectField
          name="purpose"
          label="Purpose"
          blank="All purposes"
          defaultValue={filters.purpose ?? ''}
          options={options(LP_PAYMENT_PURPOSES, (v) => lpWord(PAYMENT_PURPOSE_WORDS, v))}
        />
        <button type="submit">Apply filters</button>
      </form>
      <Loadable result={page} title="payments">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No payments to show"
              detail="No payment request matches these filters yet."
            />
          ) : (
            <>
              <table>
                <caption className="sr-only">Payment requests, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Purpose</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Instalment no.</th>
                    <th scope="col">Link valid until</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td>{lpDateTimeIst(row.createdAt)}</td>
                      <td>{lpWord(PAYMENT_PURPOSE_WORDS, row.purpose)}</td>
                      <td>{lpRupees(row.amountMinor)}</td>
                      <td>{lpWord(PAYMENT_STATUS_WORDS, row.status)}</td>
                      <td>
                        {row.provider} ({modeWords(row.providerMode)})
                      </td>
                      <td>
                        {row.targetInstallmentSeq === null
                          ? '—'
                          : lpCount(row.targetInstallmentSeq)}
                      </td>
                      <td>{row.linkExpiresAt ? lpDateTimeIst(row.linkExpiresAt) : '—'}</td>
                      <td>
                        <a href={`/payments/${row.id}`}>Open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager basePath="/payments" keep={keep} nextCursor={data.nextCursor} />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Provider events (shown in the detail of a payment and on their own page)
// ---------------------------------------------------------------------------------------------------------------
export function LpProviderEventsTable({ items }: { items: readonly ProviderEventRow[] }) {
  return (
    <table>
      <caption className="sr-only">
        Verified provider events and what was done with each. The event body is never shown.
      </caption>
      <thead>
        <tr>
          <th scope="col">Received</th>
          <th scope="col">Provider</th>
          <th scope="col">Event type</th>
          <th scope="col">About</th>
          <th scope="col">Status reported</th>
          <th scope="col">Amount reported</th>
          <th scope="col">What it can do</th>
          <th scope="col">What was done with it</th>
        </tr>
      </thead>
      <tbody>
        {items.map((event) => (
          <tr key={event.id}>
            <td>{lpDateTimeIst(event.receivedAt)}</td>
            <td>{event.provider}</td>
            <td>{event.eventType}</td>
            <td>
              {lpWord(EVENT_OBJECT_KIND_WORDS, event.objectKind)}
              {event.objectRef ? ` ${event.objectRef}` : ''}
            </td>
            <td>
              {event.providerStatus
                ? lpWord(PROVIDER_PAYMENT_STATUS_WORDS, event.providerStatus)
                : '—'}
            </td>
            <td>{lpRupees(event.amountMinor)}</td>
            <td>{lpWord(EVENT_PROCESSING_CLASS_WORDS, event.processingClass)}</td>
            <td>
              {event.processing ? (
                <>
                  {lpWord(EVENT_OUTCOME_WORDS, event.processing.outcome)}
                  {Object.hasOwn(EVENT_REASON_WORDS, event.processing.reasonClass)
                    ? ` (${lpWord(EVENT_REASON_WORDS, event.processing.reasonClass)})`
                    : ''}
                  {event.processing.attempt > 1
                    ? `, attempt ${lpCount(event.processing.attempt)}`
                    : ''}
                  {event.processing.deferredUntil
                    ? `, retry after ${lpDateTimeIst(event.processing.deferredUntil)}`
                    : ''}
                  {`, ${lpDateTimeIst(event.processing.processedAt)}`}
                </>
              ) : (
                'Not processed yet'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Payment detail
// ---------------------------------------------------------------------------------------------------------------
type ProviderPaymentRow = PaymentDetail['providerPayments'][number];

function StageTable({ stage }: { stage: NonNullable<ProviderPaymentRow['stage']> }) {
  const recorded: Record<(typeof LP_SETTLEMENT_STAGES)[number], boolean> = {
    provider_captured: stage.providerCaptured,
    provider_settled: stage.providerSettled,
    bank_confirmed: stage.bankConfirmed,
    lender_posted: stage.lenderPosted,
  };
  return (
    <>
      <table>
        <caption>Four separate facts, each with the source that records it</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Recorded?</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {LP_SETTLEMENT_STAGES.map((name) => (
            <tr key={name}>
              <th scope="row">{STAGE_WORDS[name]}</th>
              <td>{recorded[name] ? 'Recorded' : 'No record yet'}</td>
              <td>
                {STAGE_SOURCE_WORDS[name]}
                {name === 'bank_confirmed' && stage.bankConfirmed && stage.bankConfirmationBasis ? (
                  <>
                    {' '}
                    <strong>
                      {lpWord(BANK_CONFIRMATION_BASIS_WORDS, stage.bankConfirmationBasis)}
                    </strong>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Furthest stage the API records: {STAGE_WORDS[stage.stage]}
        {stage.stage === 'bank_confirmed' && stage.bankConfirmationBasis
          ? ' (resting on a bank credit you reported)'
          : ''}
        . “No record yet” also appears when the lender has not supplied that input (for example no
        bank credits uploaded); the reconciliation report lists the inputs a run could not check.
      </p>
      {stage.settlementDestinationOk === false ? (
        <CriticalBanner title="Settled to an account that is not your verified account">
          <p>
            The provider reported settling this payment somewhere other than your verified
            settlement account. Look for the matching exception in the reconciliation queue.
          </p>
        </CriticalBanner>
      ) : stage.settlementDestinationOk === true ? (
        <p>The destination the provider reported is your verified settlement account.</p>
      ) : (
        <p>
          The provider has not stated a settlement destination for this payment, so it is not
          treated as your verified account.
        </p>
      )}
    </>
  );
}

export function LpPaymentDetailView({
  detail,
  events,
}: {
  detail: LpResult<PaymentDetail> | undefined;
  events: LpResult<ProviderEventPage> | undefined;
}) {
  return (
    <section>
      <h1>Payment</h1>
      <SectionNav links={PAYMENTS_LINKS} current="/payments" label="Payments" />
      <Loadable result={detail} title="this payment">
        {(data) => {
          const payment = data.payment;
          return (
            <>
              <Facts
                rows={[
                  ['Status', lpWord(PAYMENT_STATUS_WORDS, payment.status)],
                  ['Purpose', lpWord(PAYMENT_PURPOSE_WORDS, payment.purpose)],
                  ['Amount asked for', lpRupees(payment.amountMinor)],
                  [
                    'Instalment no.',
                    payment.targetInstallmentSeq === null
                      ? '—'
                      : lpCount(payment.targetInstallmentSeq),
                  ],
                  ['Provider', `${payment.provider} (${modeWords(payment.providerMode)})`],
                  ['Provider order reference', payment.providerOrderRef],
                  [
                    'Link valid until',
                    payment.linkExpiresAt ? lpDateTimeIst(payment.linkExpiresAt) : '—',
                  ],
                  ['Started', lpDateTimeIst(payment.createdAt)],
                  ['Last changed', lpDateTimeIst(payment.updatedAt)],
                  ['Loan account', payment.loanAccountId],
                ]}
              />
              <p>
                <a href={`/payments?loanAccountId=${payment.loanAccountId}`}>
                  All payments for this loan account
                </a>
              </p>
              <h2>What the provider reported</h2>
              <p className="muted">
                These are the provider’s own statuses, taken from verified events. A payment shows
                its stages only when the provider captured it and it is not a second capture.
              </p>
              {data.providerPayments.length === 0 ? (
                <EmptyState
                  title="No provider payment yet"
                  detail="The provider has not reported a payment for this request."
                />
              ) : (
                data.providerPayments.map((pp) => (
                  <section key={pp.id} className="card">
                    <h3>Provider payment {pp.providerPaymentRef}</h3>
                    <Facts
                      rows={[
                        ['Provider status', lpWord(PROVIDER_PAYMENT_STATUS_WORDS, pp.status)],
                        ['Amount reported', lpRupees(pp.amountMinor)],
                        ['Captured', pp.capturedAt ? lpDateTimeIst(pp.capturedAt) : 'Not captured'],
                        ['Provider order', pp.orderRef],
                        [
                          'Second capture',
                          pp.duplicateCapture
                            ? 'Yes: this is a second capture on the same order. See the exception queue.'
                            : 'No',
                        ],
                      ]}
                    />
                    {pp.stage ? (
                      <StageTable stage={pp.stage} />
                    ) : (
                      <p className="muted">
                        No stages are recorded for this provider payment (it is not a successful,
                        first capture).
                      </p>
                    )}
                  </section>
                ))
              )}
              {data.providerPayments.length >= LIST_CAP ? (
                <p className="muted">
                  At most {lpCount(LIST_CAP)} provider payments are shown for one payment request.
                </p>
              ) : null}
              <h2>Refunds, chargebacks and corrections</h2>
              <p className="muted">
                These are separate entries. They never change the payment amount shown above.
              </p>
              {data.adjustments.length === 0 ? (
                <p>None recorded.</p>
              ) : (
                <table>
                  <caption className="sr-only">Adjustments recorded against this payment</caption>
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Provider reference</th>
                      <th scope="col">Happened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.adjustments.map((adjustment) => (
                      <tr key={adjustment.id}>
                        <td>{lpWord(ADJUSTMENT_KIND_WORDS, adjustment.kind)}</td>
                        <td>{lpRupees(adjustment.amountMinor)}</td>
                        <td>{adjustment.objectRef}</td>
                        <td>{lpDateTimeIst(adjustment.occurredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.adjustments.length >= LIST_CAP ? (
                <p className="muted">
                  At most {lpCount(LIST_CAP)} refunds, chargebacks and corrections are shown.
                </p>
              ) : null}
            </>
          );
        }}
      </Loadable>
      <h2>Verified provider events for this payment</h2>
      <Loadable result={events} title="the provider events">
        {(data) =>
          data.items.length === 0 ? (
            <p>No verified provider event is linked to this payment yet.</p>
          ) : (
            <>
              <LpProviderEventsTable items={data.items} />
              {data.nextCursor !== null && detail?.ok ? (
                <p>
                  Only the newest events are shown here.{' '}
                  <a href={`/payments/events?paymentIntentId=${detail.data.payment.id}`}>
                    Show all events of this payment
                  </a>
                </p>
              ) : null}
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Provider events page and the webhook summary
// ---------------------------------------------------------------------------------------------------------------
export function LpProviderEventsView({
  summary,
  events,
  filters,
  keep,
}: {
  summary: LpResult<WebhookSummary> | undefined;
  events: LpResult<ProviderEventPage> | undefined;
  filters: { objectKind?: string | undefined; paymentIntentId?: string | undefined };
  keep: Readonly<Record<string, string>>;
}) {
  return (
    <section>
      <h1>Provider events</h1>
      <SectionNav links={PAYMENTS_LINKS} current="/payments/events" label="Payments" />
      <h2>Deliveries received from the provider</h2>
      <p className="muted">
        Every delivery to the provider callback is counted by outcome. Only a delivery that was
        verified can become an event below; every other outcome changes no payment, mandate or
        settlement. Bodies, signatures and addresses are never stored or shown.
      </p>
      <Loadable result={summary} title="the delivery counts">
        {(data) =>
          data.items.length === 0 ? (
            <p>No delivery has been recorded for your organisation yet.</p>
          ) : (
            <table>
              <caption className="sr-only">Deliveries by outcome</caption>
              <thead>
                <tr>
                  <th scope="col">Outcome</th>
                  <th scope="col">Deliveries</th>
                  <th scope="col">Latest</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.outcome}>
                    <th scope="row">{lpWord(RECEIPT_OUTCOME_WORDS, item.outcome)}</th>
                    <td>{lpCount(item.receipts)}</td>
                    <td>{item.lastReceivedAt ? lpDateTimeIst(item.lastReceivedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loadable>
      <h2>Verified events</h2>
      {lpIsUuid(filters.paymentIntentId) ? (
        <p>
          Showing only the events of one payment.{' '}
          <a href={`/payments/${filters.paymentIntentId}`}>Open the payment</a> ·{' '}
          <a href="/payments/events">Show all events</a>
        </p>
      ) : null}
      <form method="get" action="/payments/events" className="form">
        {lpIsUuid(filters.paymentIntentId) ? (
          <input type="hidden" name="paymentIntentId" value={filters.paymentIntentId} />
        ) : null}
        <SelectField
          name="objectKind"
          label="About"
          blank="Everything"
          defaultValue={filters.objectKind ?? ''}
          options={options(LP_EVENT_OBJECT_KINDS, (v) => lpWord(EVENT_OBJECT_KIND_WORDS, v))}
        />
        <button type="submit">Apply filter</button>
      </form>
      <Loadable result={events} title="the provider events">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No verified events"
              detail="No verified provider event matches yet."
            />
          ) : (
            <>
              <LpProviderEventsTable items={data.items} />
              <Pager basePath="/payments/events" keep={keep} nextCursor={data.nextCursor} />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Payment policy
// ---------------------------------------------------------------------------------------------------------------
export function LpPaymentPolicyView({
  policy,
  ctx,
  done,
  error,
}: {
  policy: LpResult<PaymentPolicyList> | undefined;
  ctx: LpViewContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <section>
      <h1>Payment policy</h1>
      <SectionNav links={PAYMENTS_LINKS} current="/payments/policy" label="Payments" />
      <LpNotice done={done} error={error} />
      <LpLender ctx={ctx} path="/payments/policy" />
      <Loadable result={policy} title="the payment policy">
        {(data) => {
          // Only the row of the lender acted for. Another lender's row is never shown or pre-filled, even when it is the only one.
          const current = ctx.lenderId
            ? data.items.find((p) => p.lenderId === ctx.lenderId)
            : undefined;
          return (
            <>
              <h2>Current policy</h2>
              {current ? (
                <Facts
                  rows={[
                    [
                      'Payments smaller than the instalment or overdue figure',
                      current.allowPartialPayments
                        ? `Accepted, from ${lpRupees(current.minPartialAmountMinor)}`
                        : 'Not accepted',
                    ],
                    [
                      'Part-prepayments',
                      current.allowPartPrepayment
                        ? `Accepted, from ${lpRupees(current.minPartPrepaymentMinor)}`
                        : 'Not accepted',
                    ],
                    ['Payment link valid for', `${lpCount(current.linkValidityMinutes)} minutes`],
                    ['Last changed', lpDateTimeIst(current.updatedAt)],
                  ]}
                />
              ) : (
                <p>
                  No policy has been set for this lender yet. Until it is set, the server’s own
                  rules apply and no figure is shown here.
                </p>
              )}
              {ctx.caps.configure && ctx.lenderId ? (
                <>
                  <WhatItChanges>
                    <p>
                      This sets what borrowers may pay through the app for your loans: whether a
                      payment smaller than the instalment or overdue figure is accepted and from
                      what amount, whether a part-prepayment is accepted and from what amount, and
                      how long a payment link stays valid. It applies to payments that borrowers ask
                      to make after you save it; payment requests already made are not edited. It
                      does not change any loan figure, approve a payment or move money. The server
                      checks every value and refuses what it does not accept.
                    </p>
                  </WhatItChanges>
                  <OpForm
                    op="payments.policy.set"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId: ctx.lenderId }}
                    submit="Save payment policy"
                  >
                    <SelectField
                      name="allowPartialPayments"
                      label="Accept a payment smaller than the instalment or overdue figure?"
                      blank="Choose"
                      required
                      defaultValue={current ? String(current.allowPartialPayments) : ''}
                      options={YES_NO}
                    />
                    <TextField
                      name="minPartialAmount"
                      label="Smallest such payment you accept (rupees)"
                      defaultValue={lpRupeesPlain(current?.minPartialAmountMinor)}
                      hint="Digits and up to two decimals, for example 500 or 500.50. Needed when such payments are accepted."
                    />
                    <SelectField
                      name="allowPartPrepayment"
                      label="Accept part-prepayments?"
                      blank="Choose"
                      required
                      defaultValue={current ? String(current.allowPartPrepayment) : ''}
                      options={YES_NO}
                    />
                    <TextField
                      name="minPartPrepayment"
                      label="Smallest part-prepayment you accept (rupees)"
                      defaultValue={lpRupeesPlain(current?.minPartPrepaymentMinor)}
                      hint="Digits and up to two decimals. Needed when part-prepayments are accepted."
                    />
                    <TextField
                      name="linkValidityMinutes"
                      type="number"
                      required
                      label="How long a payment link stays valid (minutes)"
                      defaultValue={current ? String(current.linkValidityMinutes) : ''}
                    />
                    <ConfirmField label="I confirm that I want to change the payment policy of my organisation." />
                  </OpForm>
                </>
              ) : (
                <p className="muted">
                  You can read the policy, but your role does not include changing it.
                </p>
              )}
            </>
          );
        }}
      </Loadable>
    </section>
  );
}
