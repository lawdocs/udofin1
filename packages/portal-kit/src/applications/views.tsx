import {
  CHECK_KINDS,
  CHECK_STATUSES,
  LENDER_DECISIONS,
  type LenderApplicationDetail,
  type LenderApplicationRow,
} from '@udofin/contracts';
import { type ReactNode } from 'react';
import { OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { label } from '../onboarding/labels.js';
import { Notice, type ViewContext, formatRupees } from '../onboarding/views.js';
import { EmptyState, ErrorState } from '../states.js';

const stamp = (value: string | null | undefined) =>
  value ? `${value.slice(0, 16).replace('T', ' ')} UTC` : '—';
const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: label(v) }));
const rupees = (paise: number) => formatRupees(String(paise));
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;

type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export function ApplicationsList({
  result,
  nextHref,
  done,
  error,
}: {
  result: Result<{ items: LenderApplicationRow[]; nextCursor: string | null }>;
  nextHref: (cursor: string) => string;
  done?: boolean;
  error?: string | undefined;
}) {
  if (!result.ok)
    return (
      <ErrorState
        title={
          result.status === 403 ? 'You cannot view applications' : 'Could not load applications'
        }
        detail={result.status === 403 ? 'Your role does not include this.' : 'Reload the page.'}
      />
    );
  const { items, nextCursor } = result.data;
  return (
    <section>
      <h1>Applications</h1>
      <p>
        Applications borrowers chose to send to your organisation, with the details they agreed to
        share. Udofin does not assess or decide them.
      </p>
      <Notice done={done} error={error} />
      {items.length === 0 ? (
        <EmptyState title="No applications yet" detail="Applications appear here once routed." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Received</th>
              <th>Amount</th>
              <th>Tenure (days)</th>
              <th>Status</th>
              <th>Respond by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.applicationId}>
                <td>{a.udofinReference ?? '—'}</td>
                <td>{stamp(a.createdAt)}</td>
                <td>{rupees(a.request.amountMinor)}</td>
                <td>{a.request.tenureDays}</td>
                <td>
                  {label(a.status)}
                  {a.consentWithdrawn ? ' · consent withdrawn' : ''}
                  {a.noResponseAt ? ' · response overdue' : ''}
                </td>
                <td>{stamp(a.responseDueAt)}</td>
                <td>
                  <a href={`/applications/${a.applicationId}`}>Open</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nextCursor ? <a href={nextHref(nextCursor)}>Older applications</a> : null}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApplicationDetailView({
  application,
  detail,
  ctx,
  contact,
  done,
  error,
}: {
  application: LenderApplicationRow;
  detail: Result<LenderApplicationDetail>;
  ctx: ViewContext;
  /** Rendered by the app: a control that reveals the phone number on request. */
  contact: ReactNode;
  done?: boolean;
  error?: string | undefined;
}) {
  const id = application.applicationId;
  const canDecide = ctx.caps.applicationDecide === true;
  const closed = application.consentWithdrawn;
  const d = detail.ok ? detail.data : undefined;
  const approved = d?.decisions.some((x) => x.decision === 'approved' && x.applied) ?? false;
  const openOffers = d?.offers.filter((o) => o.status === 'open') ?? [];
  return (
    <section>
      <p>
        <a href="/applications">All applications</a>
      </p>
      <h1>Application {application.udofinReference ?? ''}</h1>
      <Notice done={done} error={error} />
      {closed ? (
        <p role="alert">
          The borrower withdrew consent. Do not use the shared details further; no new offer can be
          shown to the borrower.
        </p>
      ) : null}
      <Facts
        rows={[
          ['Status', label(application.status)],
          ['Delivery', label(application.transmission)],
          ['Product', application.productName],
          ['Category', label(application.request.categoryKey)],
          ['Amount requested', rupees(application.request.amountMinor)],
          ['Tenure (days)', String(application.request.tenureDays)],
          ['Purpose', label(application.request.purposeCode)],
          ['Display name (optional, as the borrower entered it)', application.displayName],
          ['Language', application.language],
          ['Respond by', stamp(application.responseDueAt)],
          ['Your reference', application.lenderApplicationRef],
        ]}
      />
      <h2>Contact</h2>
      <p>The phone number is shown only while consent is in force. Each view is recorded.</p>
      {closed ? <p>Not available: consent withdrawn.</p> : contact}

      {canDecide && !closed ? (
        <>
          <h2>Confirm receipt</h2>
          <OpForm
            op="application.ack"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id }}
            submit="Confirm receipt"
          >
            <TextField name="lenderApplicationRef" label="Your own reference (optional)" />
          </OpForm>
        </>
      ) : null}

      <h2>Checks you performed</h2>
      <p>
        Report status only. Udofin stores no documents, identity numbers, reports or scores. The
        borrower sees your status labelled as reported by you.
      </p>
      {application.checks.length === 0 ? (
        <p>No check status reported yet.</p>
      ) : (
        <ul>
          {application.checks.map((c) => (
            <li key={c.kind}>
              {label(c.kind)}: {label(c.status)} ({stamp(c.reportedAt)})
            </li>
          ))}
        </ul>
      )}
      {canDecide && !closed ? (
        <OpForm
          op="application.check"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id }}
          submit="Report check status"
        >
          <SelectField name="kind" label="Check" options={opts(CHECK_KINDS)} />
          <SelectField name="status" label="Status" options={opts(CHECK_STATUSES)} />
        </OpForm>
      ) : null}

      <h2>Your decision</h2>
      {!detail.ok ? (
        <ErrorState title="Could not load decisions and offers" detail="Reload the page." />
      ) : (
        <>
          {d?.decisions.length === 0 ? <p>No decision recorded yet.</p> : null}
          <ul>
            {d?.decisions.map((x) => (
              <li key={x.recordedAt + x.decision}>
                {label(x.decision)} ({label(x.source)}, {stamp(x.reportedAt)})
                {x.late ? ' — arrived after the response deadline; recorded, not applied' : ''}
                {x.note ? ` — ${x.note}` : ''}
              </li>
            ))}
          </ul>
          {canDecide && !closed ? (
            <OpForm
              op="application.decision"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id }}
              submit="Record decision"
            >
              <SelectField name="decision" label="Status" options={opts(LENDER_DECISIONS)} />
            </OpForm>
          ) : null}

          <h2>Offers</h2>
          <p>
            Enter the offer exactly as your system states it. Udofin does not calculate or correct
            amounts or rates. A key facts statement link on a host registered for your organisation
            is required.
          </p>
          {d?.offers.length === 0 ? <p>No offer yet.</p> : null}
          <ul>
            {d?.offers.map((o) => (
              <li key={o.offerId}>
                {o.lenderOfferRef ?? o.offerId} rev {o.revision} — {label(o.status)}, APR{' '}
                {percent(o.aprBps)}, valid until {stamp(o.validUntil)}
              </li>
            ))}
          </ul>
          {d?.offerIntake
            .filter((i) => i.validation === 'held')
            .map((i) => (
              <p key={i.intakeId} role="alert">
                A submission was held for correction and is not shown to the borrower:{' '}
                {i.issues.map((x) => label(x)).join(', ')}.
              </p>
            ))}
          {canDecide && !closed ? (
            approved ? (
              <OfferForm id={id} ctx={ctx} />
            ) : (
              <p>Record an approved decision before submitting an offer.</p>
            )
          ) : null}
          {canDecide && !closed
            ? openOffers.map((o) =>
                o.lenderOfferRef ? (
                  <OpForm
                    key={o.offerId}
                    op="application.offer_withdraw"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ id, lenderOfferRef: o.lenderOfferRef }}
                    submit={`Withdraw ${o.lenderOfferRef}`}
                    secondary
                    inline
                  />
                ) : null,
              )
            : null}

          <h2>History</h2>
          <ul>
            {d?.events.map((e) => (
              <li key={e.occurredAt + e.event}>
                {stamp(e.occurredAt)} — {label(e.event)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function OfferForm({ id, ctx }: { id: string; ctx: ViewContext }) {
  return (
    <OpForm
      op="application.offer"
      action={ctx.action}
      returnTo={ctx.returnTo}
      hidden={{ id }}
      submit="Submit offer"
    >
      <TextField name="lenderOfferRef" label="Your offer reference" required />
      <TextField name="principalMinor" label="Amount offered (paise)" required />
      <TextField name="tenureDays" label="Tenure (days)" required />
      <SelectField
        name="installmentFrequency"
        label="Instalment frequency"
        options={opts(['monthly', 'fortnightly', 'weekly'])}
      />
      <TextField name="installmentCount" label="Number of instalments" required />
      <TextField name="installmentAmountMinor" label="Instalment amount (paise)" required />
      <TextField name="monthlyRepaymentMinor" label="Monthly repayment (paise)" required />
      <TextField name="annualInterestRateBps" label="Interest rate (bps per year)" required />
      <TextField name="aprBps" label="APR as you state it (bps)" required />
      <TextField name="processingFeeMinor" label="Processing fee (paise; 0 if none)" required />
      <TextField name="totalRepayableMinor" label="Total repayable (paise)" required />
      <TextField
        name="penalChargesSummary"
        label="Penal charges (as in your key facts statement)"
        required
      />
      <TextField
        name="kfsUrl"
        label="Key facts statement link (https, your registered host)"
        required
      />
      <TextField name="issuedAt" label="Issued at (India time)" type="datetime-local" required />
      <TextField
        name="validUntil"
        label="Valid until (India time, at least 7 days from now)"
        type="datetime-local"
        required
      />
    </OpForm>
  );
}
