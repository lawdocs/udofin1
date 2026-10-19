import { LP_DEBIT_STATUSES, LP_MANDATE_REQUIREMENTS, LP_MANDATE_STATUSES } from '@udofin/contracts';
import { OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyState } from '../states.js';
import { lpIsUuid, type LpResult } from './data.js';
import { lpCount, lpDate, lpDateTimeIst, lpRupees, lpRupeesPlain } from './format.js';
import {
  DEBIT_STATUS_WORDS,
  MANDATE_CANCEL_REASON_WORDS,
  MANDATE_EVENT_SOURCE_WORDS,
  MANDATE_MODE_WORDS,
  MANDATE_RAIL_WORDS,
  MANDATE_REQUIREMENT_WORDS,
  MANDATE_STATUS_WORDS,
  NOTICE_DELIVERY_WORDS,
  NOTICE_STATUS_WORDS,
  RETURN_CLASS_WORDS,
  lpWord,
} from './labels.js';
import {
  ConfirmField,
  Facts,
  Loadable,
  MANDATES_LINKS,
  Pager,
  LpLender,
  LpNotice,
  SectionNav,
  WhatItChanges,
  type LpViewContext,
} from './parts.js';
import {
  type MandateDebit,
  type MandateDebitPage,
  type MandateDetail,
  type MandatePage,
  type MandatePolicyList,
} from './types.js';

const options = (values: readonly string[], words: (value: string) => string) =>
  values.map((value) => ({ value, label: words(value) }));

// ---------------------------------------------------------------------------------------------------------------
// Debits (used in the mandate detail and on the debits page)
// ---------------------------------------------------------------------------------------------------------------
type Notice = MandateDetail['notices'][number];

/** The return code is the provider’s own, shown as given; the class is the platform’s mapping, or "not classified yet". */
function returnWords(debit: MandateDebit): string {
  if (debit.status !== 'returned' && debit.returnCode === null) return '—';
  const code = debit.returnCode ? `Provider code ${debit.returnCode}` : 'No provider code given';
  const kind = debit.returnClass
    ? lpWord(RETURN_CLASS_WORDS, debit.returnClass)
    : 'not classified yet';
  return `${code}; class: ${kind}`;
}

export function LpDebitsTable({
  debits,
  notices,
}: {
  debits: readonly MandateDebit[];
  /** Pre-debit notices to show beside their debit (the mandate detail has them; the debits page does not). */
  notices?: readonly Notice[] | undefined;
}) {
  return (
    <table>
      <caption className="sr-only">Debits of mandates, newest scheduled date first</caption>
      <thead>
        <tr>
          <th scope="col">Scheduled for</th>
          <th scope="col">Instalment no.</th>
          <th scope="col">Amount</th>
          <th scope="col">Status</th>
          <th scope="col">Where it came from</th>
          <th scope="col">Provider debit reference</th>
          <th scope="col">Return</th>
          {notices ? <th scope="col">Pre-debit notice</th> : null}
        </tr>
      </thead>
      <tbody>
        {debits.map((debit) => {
          const notice = notices?.find((n) => n.debitId === debit.id);
          return (
            <tr key={debit.id}>
              <td>{lpDate(debit.scheduledOn)}</td>
              <td>{debit.installmentSeq === null ? '—' : lpCount(debit.installmentSeq)}</td>
              <td>
                {lpRupees(debit.amountMinor)}
                {debit.exceedsMandateMax ? ' (above the mandate maximum)' : ''}
              </td>
              <td>{lpWord(DEBIT_STATUS_WORDS, debit.status)}</td>
              <td>
                {debit.planned
                  ? 'Planned from your reported schedule'
                  : 'Reported by the provider, not planned'}
              </td>
              <td>{debit.providerDebitRef ?? '—'}</td>
              <td>{returnWords(debit)}</td>
              {notices ? (
                <td>
                  {notice ? (
                    <>
                      {lpWord(NOTICE_STATUS_WORDS, notice.status)}
                      {`; due ${lpDateTimeIst(notice.noticeDueAt)}`}
                      {notice.sentAt ? `; sent ${lpDateTimeIst(notice.sentAt)}` : ''}
                      {notice.deliveryState
                        ? `; ${lpWord(NOTICE_DELIVERY_WORDS, notice.deliveryState)}`
                        : ''}
                    </>
                  ) : (
                    'None recorded'
                  )}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mandates list
// ---------------------------------------------------------------------------------------------------------------
export function LpMandatesListView({
  page,
  filters,
  keep,
}: {
  page: LpResult<MandatePage> | undefined;
  filters: { status?: string | undefined; loanAccountId?: string | undefined };
  keep: Readonly<Record<string, string>>;
}) {
  return (
    <section>
      <h1>Mandates</h1>
      <SectionNav links={MANDATES_LINKS} current="/mandates" label="Mandates" />
      <p className="muted">
        Debit mandates for loans of your organisation, with the status the payment provider last
        confirmed. A mandate is “active” here only when the provider said so. The borrower’s account
        appears only as the masked reference the borrower typed.
      </p>
      {lpIsUuid(filters.loanAccountId) ? (
        <p>
          Showing only the mandates of one loan account. <a href="/mandates">Show all mandates</a>
        </p>
      ) : null}
      <form method="get" action="/mandates" className="form">
        {lpIsUuid(filters.loanAccountId) ? (
          <input type="hidden" name="loanAccountId" value={filters.loanAccountId} />
        ) : null}
        <SelectField
          name="status"
          label="Status"
          blank="All statuses"
          defaultValue={filters.status ?? ''}
          options={options(LP_MANDATE_STATUSES, (v) => lpWord(MANDATE_STATUS_WORDS, v))}
        />
        <button type="submit">Apply filter</button>
      </form>
      <Loadable result={page} title="mandates">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title="No mandates to show" detail="No mandate matches this filter yet." />
          ) : (
            <>
              <table>
                <caption className="sr-only">Mandates, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Requested</th>
                    <th scope="col">Rail</th>
                    <th scope="col">Status</th>
                    <th scope="col">Maximum debit</th>
                    <th scope="col">Runs from</th>
                    <th scope="col">Runs to</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((mandate) => (
                    <tr key={mandate.id}>
                      <td>{lpDateTimeIst(mandate.createdAt)}</td>
                      <td>{lpWord(MANDATE_RAIL_WORDS, mandate.rail)}</td>
                      <td>
                        {lpWord(MANDATE_STATUS_WORDS, mandate.status)}
                        {mandate.cancelRequestedAt ? '; cancellation requested' : ''}
                        {mandate.providerMode !== 'production'
                          ? `; ${lpWord(MANDATE_MODE_WORDS, mandate.providerMode)}`
                          : ''}
                      </td>
                      <td>{lpRupees(mandate.maxAmountMinor)}</td>
                      <td>{lpDate(mandate.startDate)}</td>
                      <td>{lpDate(mandate.endDate)}</td>
                      <td>
                        <a href={`/mandates/${mandate.id}`}>Open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager basePath="/mandates" keep={keep} nextCursor={data.nextCursor} />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mandate detail
// ---------------------------------------------------------------------------------------------------------------
export function LpMandateDetailView({ detail }: { detail: LpResult<MandateDetail> | undefined }) {
  return (
    <section>
      <h1>Mandate</h1>
      <SectionNav links={MANDATES_LINKS} current="/mandates" label="Mandates" />
      <Loadable result={detail} title="this mandate">
        {(data) => {
          const mandate = data.mandate;
          const lateNotices = data.notices.filter((n) => n.status === 'late');
          return (
            <>
              <Facts
                rows={[
                  ['Status', lpWord(MANDATE_STATUS_WORDS, mandate.status)],
                  ['Rail', lpWord(MANDATE_RAIL_WORDS, mandate.rail)],
                  [
                    'Provider',
                    `${mandate.provider} (${lpWord(MANDATE_MODE_WORDS, mandate.providerMode)})`,
                  ],
                  ['Provider mandate reference', mandate.providerMandateRef],
                  ['Maximum debit', lpRupees(mandate.maxAmountMinor)],
                  ['Runs from', lpDate(mandate.startDate)],
                  ['Runs to', lpDate(mandate.endDate)],
                  [
                    'Borrower’s account',
                    `${mandate.maskedAccountRef} (masked, as the borrower typed it; Udofin has not verified it)`,
                  ],
                  [
                    'Bank prompt on each debit',
                    mandate.needsAfaEachDebit
                      ? 'The borrower’s bank may ask for authentication on every debit.'
                      : '—',
                  ],
                  [
                    'Last provider-confirmed change',
                    mandate.lastEventAt ? lpDateTimeIst(mandate.lastEventAt) : '—',
                  ],
                  [
                    'Bank hand-off valid until',
                    mandate.handoffExpiresAt ? lpDateTimeIst(mandate.handoffExpiresAt) : '—',
                  ],
                  ['Requested', lpDateTimeIst(mandate.createdAt)],
                  ['Loan account', mandate.loanAccountId],
                ]}
              />
              {mandate.cancelRequestedAt ? (
                <div className="card">
                  <h2>Cancellation requested</h2>
                  <p>
                    A cancellation was requested on {lpDateTimeIst(mandate.cancelRequestedAt)}
                    {mandate.cancelReason
                      ? ` (${lpWord(MANDATE_CANCEL_REASON_WORDS, mandate.cancelReason)})`
                      : ''}
                    .{' '}
                    {mandate.cancelSentAt
                      ? `It was sent to the provider on ${lpDateTimeIst(mandate.cancelSentAt)}.`
                      : 'It has not been sent to the provider yet.'}{' '}
                    This is a request: the status above changes only when the provider confirms.
                  </p>
                </div>
              ) : null}
              {lateNotices.length > 0 ? (
                <p role="alert" className="form-error">
                  <strong>Late pre-debit notice:</strong> {lpCount(lateNotices.length)} notice(s) of
                  this mandate were planned too close to their debit, or could not go out in time.
                  They are marked LATE below.
                </p>
              ) : null}
              <h2>Debits and pre-debit notices</h2>
              <p className="muted">
                The newest {lpCount(data.debits.length)} debits are shown (at most 60). A planned
                debit is what Udofin expects from your reported schedule; a debit the provider
                reported that matches no plan is marked as such. A returned debit shows the
                provider’s own code. The complete list is on the{' '}
                <a href={`/mandates/debits?mandateId=${mandate.id}`}>debits page</a>.
              </p>
              {data.debits.length === 0 ? (
                <p>No debit has been planned or reported for this mandate yet.</p>
              ) : (
                <LpDebitsTable debits={data.debits} notices={data.notices} />
              )}
              <h2>Status history</h2>
              <p className="muted">
                Every change of status with where it came from. The newest 100 are shown.
              </p>
              {data.events.length === 0 ? (
                <p>No change has been recorded yet.</p>
              ) : (
                <table>
                  <caption className="sr-only">Status history, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Observed</th>
                      <th scope="col">From</th>
                      <th scope="col">To</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((event) => (
                      <tr key={event.id}>
                        <td>{lpDateTimeIst(event.observedAt)}</td>
                        <td>
                          {event.fromStatus ? lpWord(MANDATE_STATUS_WORDS, event.fromStatus) : '—'}
                        </td>
                        <td>{lpWord(MANDATE_STATUS_WORDS, event.toStatus)}</td>
                        <td>{lpWord(MANDATE_EVENT_SOURCE_WORDS, event.source)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          );
        }}
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Debits page
// ---------------------------------------------------------------------------------------------------------------
export function LpMandateDebitsView({
  page,
  filters,
  keep,
}: {
  page: LpResult<MandateDebitPage> | undefined;
  filters: {
    status?: string | undefined;
    planned?: string | undefined;
    mandateId?: string | undefined;
  };
  keep: Readonly<Record<string, string>>;
}) {
  const onlyMandate = lpIsUuid(filters.mandateId) ? filters.mandateId : undefined;
  return (
    <section>
      <h1>Mandate debits</h1>
      <SectionNav links={MANDATES_LINKS} current="/mandates/debits" label="Mandates" />
      <p className="muted">
        Debits of your mandates, newest scheduled date first. Udofin does not present debits: your
        organisation or its sponsor bank does, and this list shows what was planned from your
        schedule and what the provider reported. A returned debit creates no charge of Udofin’s.
      </p>
      {onlyMandate ? (
        <p>
          Showing only the debits of one mandate. <a href={`/mandates/${onlyMandate}`}>Open it</a> ·{' '}
          <a href="/mandates/debits">Show all debits</a>
        </p>
      ) : null}
      <p>
        <a
          href={`/mandates/debits?${new URLSearchParams({ ...(onlyMandate ? { mandateId: onlyMandate } : {}), status: 'returned' }).toString()}`}
        >
          Show returned debits only
        </a>
      </p>
      <form method="get" action="/mandates/debits" className="form">
        {onlyMandate ? <input type="hidden" name="mandateId" value={onlyMandate} /> : null}
        <SelectField
          name="status"
          label="Status"
          blank="All statuses"
          defaultValue={filters.status ?? ''}
          options={options(LP_DEBIT_STATUSES, (v) => lpWord(DEBIT_STATUS_WORDS, v))}
        />
        <SelectField
          name="planned"
          label="Where it came from"
          blank="Both"
          defaultValue={filters.planned ?? ''}
          options={[
            { value: 'true', label: 'Planned from your schedule' },
            { value: 'false', label: 'Reported by the provider, not planned' },
          ]}
        />
        <button type="submit">Apply filters</button>
      </form>
      <Loadable result={page} title="the debits">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title="No debits to show" detail="No debit matches these filters yet." />
          ) : (
            <>
              <LpDebitsTable debits={data.items} />
              <Pager basePath="/mandates/debits" keep={keep} nextCursor={data.nextCursor} />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mandate policy
// ---------------------------------------------------------------------------------------------------------------
export function LpMandatePolicyView({
  policy,
  ctx,
  done,
  error,
}: {
  policy: LpResult<MandatePolicyList> | undefined;
  ctx: LpViewContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <section>
      <h1>Mandate policy</h1>
      <SectionNav links={MANDATES_LINKS} current="/mandates/policy" label="Mandates" />
      <LpNotice done={done} error={error} />
      <LpLender ctx={ctx} path="/mandates/policy" />
      <Loadable result={policy} title="the mandate policy">
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
                    ['Mandate', lpWord(MANDATE_REQUIREMENT_WORDS, current.requirement)],
                    [
                      'Ceiling you set for a mandate’s maximum debit',
                      current.maxAmountCapMinor === null
                        ? 'None set by you (the provider’s own limit still applies)'
                        : lpRupees(current.maxAmountCapMinor),
                    ],
                    [
                      'Pre-debit notice due',
                      `${lpCount(current.preDebitLeadHours)} hours before the debit`,
                    ],
                    ['Last changed', lpDateTimeIst(current.updatedAt)],
                  ]}
                />
              ) : (
                <p>No mandate policy has been set for this lender yet.</p>
              )}
              {ctx.caps.configure && ctx.lenderId ? (
                <>
                  <WhatItChanges>
                    <p>
                      This sets whether a mandate is asked for, the highest maximum debit a mandate
                      may carry, and how many hours before each debit the borrower’s pre-debit
                      notice is due. It applies to mandates requested after you save it and never
                      edits an existing mandate. “Asked for before the first due date” is
                      informational: no loan operation is blocked by it. The server checks every
                      value and refuses what it does not accept.
                    </p>
                  </WhatItChanges>
                  <OpForm
                    op="payments.mandate_policy.set"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId: ctx.lenderId }}
                    submit="Save mandate policy"
                  >
                    <SelectField
                      name="requirement"
                      label="Mandate"
                      blank="Choose"
                      required
                      defaultValue={current?.requirement ?? ''}
                      options={options(LP_MANDATE_REQUIREMENTS, (v) =>
                        lpWord(MANDATE_REQUIREMENT_WORDS, v),
                      )}
                    />
                    <TextField
                      name="maxAmountCap"
                      label="Ceiling for a mandate’s maximum debit (rupees, optional)"
                      defaultValue={lpRupeesPlain(current?.maxAmountCapMinor)}
                      hint="Leave empty to set no ceiling of your own. Digits and up to two decimals."
                    />
                    <TextField
                      name="preDebitLeadHours"
                      type="number"
                      required
                      label="Hours before each debit that the pre-debit notice is due"
                      defaultValue={current ? String(current.preDebitLeadHours) : ''}
                    />
                    <ConfirmField label="I confirm that I want to change the mandate policy of my organisation." />
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
