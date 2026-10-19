import {
  type PanelView,
  type Transaction,
  TRANSACTION_COLUMNS,
  type ViewConfig,
} from '@udofin/contracts';
import { type ReactNode } from 'react';
import { OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { label } from '../onboarding/labels.js';
import { Notice, type ViewContext, formatRupees } from '../onboarding/views.js';
import { EmptyState, ErrorState } from '../states.js';
import { type PanelState, stateToParams, stateToViewConfig } from './data.js';

const COLUMN_LABELS: Record<(typeof TRANSACTION_COLUMNS)[number], string> = {
  kind: 'Type',
  occurredAt: 'Date',
  status: 'Status',
  amountMinor: 'Amount (₹)',
  reference: 'Reference',
  productCode: 'Product',
  purpose: 'Purpose',
  lenderOrgId: 'Lender',
  id: 'Record id',
  applicationId: 'Application id',
  loanAccountId: 'Loan account id',
};

type Column = (typeof TRANSACTION_COLUMNS)[number];

function cell(t: Transaction, c: Column, detailBase: string): ReactNode {
  switch (c) {
    case 'kind':
      return <a href={`${detailBase}/${t.kind}/${t.id}`}>{label(t.kind)}</a>;
    case 'occurredAt':
      return t.occurredAt.slice(0, 16).replace('T', ' ');
    case 'status':
      return label(t.status);
    case 'amountMinor':
      return formatRupees(t.amountMinor);
    case 'purpose':
      return label(t.purpose);
    case 'reference':
    case 'productCode':
    case 'lenderOrgId':
    case 'id':
    case 'applicationId':
    case 'loanAccountId':
      return t[c] ?? '—';
  }
}

type Result<T> = { ok: true; data: T } | { ok: false; status: number };

export interface PanelData {
  catalogue: Result<{
    kinds: string[];
    statusesByKind: Record<string, string[]>;
    columns: { key: string; label: string }[];
    groupBy: string[];
    maxExportRows: number;
  }>;
  page: Result<{ items: Transaction[]; nextCursor: string | null }>;
  summary:
    | Result<{ groupBy: string; items: { key: string; count: number; totalAmountMinor: string }[] }>
    | undefined;
  views: Result<{ items: PanelView[] }>;
  products: Result<{ items: { id: string; name: string; code: string }[] }>;
}

export function TransactionsPanel({
  state,
  data,
  ctx,
  base,
  exportBase,
  done,
  error,
}: {
  state: PanelState;
  data: PanelData;
  ctx: ViewContext;
  base: string;
  exportBase: string;
  done?: boolean;
  error?: string | undefined;
}) {
  const allStatuses = data.catalogue.ok
    ? [...new Set(Object.values(data.catalogue.data.statusesByKind).flat())].sort()
    : [];
  const views = data.views.ok ? data.views.data.items : [];
  const products = data.products.ok ? data.products.data.items : [];
  const items = data.page.ok ? data.page.data.items : [];
  const lenderForSave = state.lenderId ?? items[0]?.lenderOrgId;
  const showLender =
    new Set(items.map((i) => i.lenderOrgId)).size > 1 || state.columns.includes('lenderOrgId');
  const cols = state.columns.filter((c) => c !== 'lenderOrgId' || showLender || true);

  return (
    <>
      <h1>Transactions</h1>
      <p className="muted">
        Applications, loan accounts and payments for your lender, read-only. No borrower names,
        phone numbers or bank details appear here. Amounts are shown in rupees from exact paise.
      </p>
      <Notice done={done} error={error} />

      <section className="card" aria-label="Saved views">
        <h2>Saved views</h2>
        {views.length === 0 ? (
          <p className="muted">None yet. Set filters below and save them.</p>
        ) : (
          <ul className="plain">
            {views.map((v) => (
              <li key={v.id}>
                <a
                  href={`${base}?view=${v.id}${v.lenderOrgId ? `&lenderId=${v.lenderOrgId}` : ''}`}
                  aria-current={state.viewId === v.id ? 'true' : undefined}
                >
                  {v.name}
                </a>{' '}
                <span className="muted">
                  {v.shared ? (v.mine ? '(shared by you)' : '(shared)') : ''}
                </span>
                {v.mine ? (
                  <OpForm
                    op="panel.view.archive"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ id: v.id }}
                    submit="Remove"
                    secondary
                    inline
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form method="get" action={base} className="form card" aria-label="Filters">
        <h2>Filters and columns</h2>
        {state.lenderId ? <input type="hidden" name="lenderId" value={state.lenderId} /> : null}
        <fieldset>
          <legend>Types</legend>
          {(data.catalogue.ok ? data.catalogue.data.kinds : []).map((k) => (
            <label key={k}>
              <input
                type="checkbox"
                name="kinds"
                value={k}
                defaultChecked={state.kinds.includes(k as never)}
              />{' '}
              {label(k)}{' '}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Statuses</legend>
          {allStatuses.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                name="statuses"
                value={s}
                defaultChecked={state.statuses.includes(s)}
              />{' '}
              {label(s)}{' '}
            </label>
          ))}
        </fieldset>
        <TextField name="from" label="From date" type="date" defaultValue={state.from} />
        <TextField name="to" label="To date" type="date" defaultValue={state.to} />
        <TextField
          name="minAmountMinor"
          label="Minimum amount (paise)"
          defaultValue={state.minAmountMinor}
        />
        <TextField
          name="maxAmountMinor"
          label="Maximum amount (paise)"
          defaultValue={state.maxAmountMinor}
        />
        <SelectField
          name="productId"
          label="Product"
          blank="All products"
          options={products.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }))}
          defaultValue={state.productId}
        />
        <TextField name="q" label="Reference contains (3+ characters)" defaultValue={state.q} />
        <SelectField
          name="order"
          label="Order"
          options={[
            { value: 'desc', label: 'Newest first' },
            { value: 'asc', label: 'Oldest first' },
          ]}
          defaultValue={state.order}
        />
        <SelectField
          name="groupBy"
          label="Summarise by"
          blank="No summary"
          options={['kind', 'status', 'product', 'day', 'month'].map((g) => ({
            value: g,
            label: label(g),
          }))}
          defaultValue={state.groupBy}
        />
        <SelectField
          name="pageSize"
          label="Rows per page"
          options={['10', '25', '50', '100'].map((n) => ({ value: n, label: n }))}
          defaultValue={String(state.pageSize)}
        />
        <fieldset>
          <legend>Columns</legend>
          {TRANSACTION_COLUMNS.map((c) => (
            <label key={c}>
              <input
                type="checkbox"
                name="columns"
                value={c}
                defaultChecked={state.columns.includes(c)}
              />{' '}
              {COLUMN_LABELS[c]}{' '}
            </label>
          ))}
        </fieldset>
        <button type="submit">Apply</button>
      </form>

      {lenderForSave ? (
        <details className="card">
          <summary>Save these filters as a view</summary>
          <OpForm
            op="panel.view.save"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{
              lenderId: lenderForSave,
              config: JSON.stringify(stateToViewConfig(state) satisfies ViewConfig),
            }}
            submit="Save view"
          >
            <TextField name="name" label="View name" required />
            <label>
              <input type="checkbox" name="shared" /> Share with colleagues who can see applications
            </label>
          </OpForm>
        </details>
      ) : null}

      {data.summary ? (
        <section className="card" aria-label="Summary">
          <h2>Summary by {label(state.groupBy)}</h2>
          {!data.summary.ok ? (
            <ErrorState title="Could not load the summary" />
          ) : (
            <table>
              <caption className="sr-only">Counts and totals</caption>
              <thead>
                <tr>
                  <th scope="col">{label(state.groupBy)}</th>
                  <th scope="col">Count</th>
                  <th scope="col">Total (₹)</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.data.items.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">
                      {state.groupBy === 'kind' || state.groupBy === 'status'
                        ? label(r.key)
                        : r.key}
                    </th>
                    <td>{r.count}</td>
                    <td>{formatRupees(r.totalAmountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {!data.page.ok ? (
        <ErrorState
          title={
            data.page.status === 403
              ? 'You cannot view transactions'
              : 'Could not load transactions'
          }
          detail={
            data.page.status === 403
              ? 'Your role does not include any of the transaction permissions.'
              : 'Reload the page.'
          }
        />
      ) : items.length === 0 ? (
        <EmptyState title="No transactions match" detail="Change the filters to see more." />
      ) : (
        <>
          <table>
            <caption className="sr-only">Transactions</caption>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col">
                    {COLUMN_LABELS[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={`${t.kind}-${t.id}`}>
                  {cols.map((c, i) =>
                    i === 0 ? (
                      <th key={c} scope="row">
                        {cell(t, c, `${base}/detail`)}
                      </th>
                    ) : (
                      <td key={c}>{cell(t, c, `${base}/detail`)}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {data.page.data.nextCursor ? (
              <a href={`${base}?${stateToParams(state, { cursor: data.page.data.nextCursor })}`}>
                Next page
              </a>
            ) : null}{' '}
            <a href={`${exportBase}?${stateToParams(state, {})}`}>
              Download CSV
              {data.catalogue.ok
                ? ` (up to ${String(data.catalogue.data.maxExportRows)} rows)`
                : ''}
            </a>
          </p>
        </>
      )}
    </>
  );
}

/** One record, with its timeline, schedule or provider events. */
export function TransactionDetailView({
  detail,
  base,
}: {
  detail: Result<Record<string, unknown> & { transaction: Transaction }>;
  base: string;
}) {
  if (!detail.ok)
    return (
      <ErrorState title={detail.status === 404 ? 'Not found' : 'Could not load this record'} />
    );
  const d = detail.data;
  const t = d.transaction;
  const events = Array.isArray(d.events)
    ? (d.events as Record<string, string | boolean | null>[])
    : [];
  const schedule = Array.isArray(d.schedule) ? (d.schedule as Record<string, string>[]) : [];
  return (
    <>
      <p>
        <a href={base}>Back to transactions</a>
      </p>
      <h1>{label(t.kind)}</h1>
      <dl className="facts">
        {[
          ['Status', label(t.status)],
          ['Date', t.occurredAt.slice(0, 16).replace('T', ' ')],
          ['Amount (₹)', formatRupees(t.amountMinor)],
          ['Reference', t.reference ?? '—'],
          ['Product', t.productCode ?? '—'],
          ['Purpose', label(t.purpose)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {typeof d.sourceSystem === 'string' ? (
        <dl className="facts">
          <div>
            <dt>Source system</dt>
            <dd>{label(d.sourceSystem)}</dd>
          </div>
          <div>
            <dt>Sanctioned (₹)</dt>
            <dd>{formatRupees(String(d.sanctionedAmountMinor))}</dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{String(d.lastSyncedAt).slice(0, 16)}</dd>
          </div>
        </dl>
      ) : null}
      {events.length > 0 ? (
        <section className="card">
          <h2>Timeline</h2>
          <ul className="plain">
            {events.map((e, i) => (
              <li key={i}>
                {String(e.occurredAt ?? e.receivedAt ?? '').slice(0, 16)} —{' '}
                {label(String(e.toStatus ?? e.eventType ?? ''))}
                {e.actor ? ` by ${label(String(e.actor))}` : ''}
                {e.providerStatus ? ` (${String(e.providerStatus)})` : ''}
                {e.signatureVerified === false ? ' — signature not verified' : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {schedule.length > 0 ? (
        <section className="card">
          <h2>Latest repayment schedule received from the lender</h2>
          <table>
            <caption className="sr-only">Schedule</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Due</th>
                <th scope="col">Principal (₹)</th>
                <th scope="col">Interest (₹)</th>
                <th scope="col">Fees (₹)</th>
                <th scope="col">Total (₹)</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((r) => (
                <tr key={String(r.seq)}>
                  <th scope="row">{r.seq}</th>
                  <td>{r.dueDate}</td>
                  <td>{formatRupees(r.principalMinor ?? '0')}</td>
                  <td>{formatRupees(r.interestMinor ?? '0')}</td>
                  <td>{formatRupees(r.feesMinor ?? '0')}</td>
                  <td>{formatRupees(r.totalMinor ?? '0')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
