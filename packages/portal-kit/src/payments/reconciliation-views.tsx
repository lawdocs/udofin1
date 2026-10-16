import { LP_BANK_CREDIT_MAX_ROWS } from '@udofin/contracts';
import { OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyState } from '../states.js';
import { type LpResult } from './data.js';
import { lpCount, lpDate, lpDateTimeIst, lpRupees } from './format.js';
import { NOT_RECONCILABLE_WORDS, SETTLEMENT_ACCOUNT_STATUS_WORDS, lpWord } from './labels.js';
import {
  ConfirmField,
  CriticalBanner,
  Facts,
  Loadable,
  Pager,
  LpNotice,
  RECONCILIATION_LINKS,
  SectionNav,
  WhatItChanges,
  type LpViewContext,
} from './parts.js';
import {
  type ReconSettingsList,
  type ReconSummary,
  type RunPage,
  type SettlementAccounts,
  type SettlementBatch,
  type SettlementBatchPage,
  type SettlementItemPage,
} from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------
export function LpReconciliationRunsView({
  page,
  keep,
}: {
  page: LpResult<RunPage> | undefined;
  keep: Readonly<Record<string, string>>;
}) {
  return (
    <section>
      <h1>Reconciliation</h1>
      <SectionNav links={RECONCILIATION_LINKS} current="/reconciliation" label="Reconciliation" />
      <p className="muted">
        Each run compares what the payment provider reported, what the provider settled, the bank
        credits you uploaded and the receipts from your loan system. A run that lacked an input says
        so in its report; it never counts a missing input as reconciled. A count that the report
        does not carry is shown as “Not available”, never as zero.
      </p>
      <Loadable result={page} title="the reconciliation runs">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No reconciliation run yet"
              detail="A run appears here after the daily reconciliation has run for your organisation."
            />
          ) : (
            <>
              <table>
                <caption className="sr-only">Reconciliation runs, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Run date</th>
                    <th scope="col">Run no. that day</th>
                    <th scope="col">Payments considered</th>
                    <th scope="col">Matched to a provider settlement</th>
                    <th scope="col">Matched to a bank credit</th>
                    <th scope="col">Matched to a lender receipt</th>
                    <th scope="col">Made</th>
                    <th scope="col">
                      <span className="sr-only">Report</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((run) => (
                    <tr key={run.id}>
                      <td>{lpDate(run.runDate)}</td>
                      <td>{lpCount(run.runNo)}</td>
                      <td>{lpCount(run.counts.paymentsConsidered)}</td>
                      <td>{lpCount(run.counts.matchedToSettlement)}</td>
                      <td>{lpCount(run.counts.matchedToBank)}</td>
                      <td>{lpCount(run.counts.matchedToReceipt)}</td>
                      <td>{lpDateTimeIst(run.createdAt)}</td>
                      <td>
                        <a href={`/reconciliation/runs/${run.runDate}`}>Open report</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager basePath="/reconciliation" keep={keep} nextCursor={data.nextCursor} />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Report of one run
// ---------------------------------------------------------------------------------------------------------------
function NonLenderLine({ report }: { report: ReconSummary['report'] }) {
  const { items, minor } = report.settledToNonLender;
  const noReport = report.notReconcilable.includes('settlement_reports');
  if (items === null || minor === null) {
    return (
      <p>
        Settled to a non-lender account: <strong>not available</strong> in this report. It is not
        shown as zero.
      </p>
    );
  }
  if (items === 0 && minor === 0) {
    return (
      <>
        <p>
          Settled to a non-lender account: <strong>0 items, {lpRupees(0)}</strong>
        </p>
        <p className="muted">
          {noReport
            ? 'No provider settlement report was available to this run, so this line shows nothing yet. Zero here is not evidence.'
            : 'Zero means none of the settlement reports this run could check names an account other than your verified settlement account. It covers only the inputs this run had.'}
        </p>
      </>
    );
  }
  return (
    <CriticalBanner title="Settled to a non-lender account">
      <p>
        <strong>
          {lpCount(items)} item(s), {lpRupees(minor)}
        </strong>{' '}
        in provider settlements were reported to an account that is not your verified settlement
        account. This is a critical finding. Look at the settlements and the exception queue now.
      </p>
      <p>
        <a href="/reconciliation/settlements">Settlements</a> ·{' '}
        <a href="/reconciliation/exceptions?severity=critical">Critical exceptions</a>
      </p>
    </CriticalBanner>
  );
}

export function LpReconciliationReportView({
  summary,
  date,
}: {
  summary: LpResult<ReconSummary> | undefined;
  date: string;
}) {
  return (
    <section>
      <h1>Reconciliation report for {lpDate(date)}</h1>
      <SectionNav links={RECONCILIATION_LINKS} current="/reconciliation" label="Reconciliation" />
      <Loadable result={summary} title="the report">
        {(data) => {
          const report = data.report;
          return (
            <>
              <p className="muted">
                The newest run of this date is shown (run {lpCount(data.runNo)}). The report is
                deterministic: the same inputs give the same report.
              </p>
              <NonLenderLine report={report} />
              <h2>Inputs this run could not check</h2>
              {report.notReconcilable.length === 0 ? (
                <p>This run had every input it looks for.</p>
              ) : (
                <ul>
                  {report.notReconcilable.map((name) => (
                    <li key={name}>{lpWord(NOT_RECONCILABLE_WORDS, name)}</li>
                  ))}
                </ul>
              )}
              <h2>What matched</h2>
              <Facts
                rows={[
                  ['Payments considered', lpCount(report.paymentsConsidered)],
                  ['Matched to a provider settlement', lpCount(report.matched.settlement)],
                  ['Matched to a bank credit', lpCount(report.matched.bank)],
                  ['Matched to a lender receipt', lpCount(report.matched.receipt)],
                ]}
              />
              <p className="muted">
                Matching is exact: the amount must equal to the paisa. A payment that is not matched
                yet is not necessarily wrong; the waiting times below say how long each source is
                given.
              </p>
              <h2>Waiting times this run used</h2>
              <Facts
                rows={[
                  [
                    'Provider settlement and bank credit',
                    report.settings.settlementLagDays === null
                      ? 'Not available'
                      : `${lpCount(report.settings.settlementLagDays)} days`,
                  ],
                  [
                    'Lender posting the receipt',
                    report.settings.receiptLagHours === null
                      ? 'Not available'
                      : `${lpCount(report.settings.receiptLagHours)} hours`,
                  ],
                ]}
              />
              <p className="muted">
                Waiting times are unverified defaults until your organisation sets them from its
                agreements with the provider and the bank.{' '}
                <a href="/reconciliation/settings">Waiting times</a>
              </p>
              <Facts
                rows={[
                  ['Run made', lpDateTimeIst(data.createdAt)],
                  ['Run date', lpDate(data.runDate)],
                ]}
              />
            </>
          );
        }}
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------------------------------------------
type BatchRow = SettlementBatch;

function DestinationWords({ batch }: { batch: BatchRow }) {
  if (batch.destinationOk === false) {
    return (
      <strong>
        Not your verified settlement account
        {batch.destinationMaskedRef ? ` (${batch.destinationMaskedRef})` : ''}
      </strong>
    );
  }
  if (batch.destinationOk === true) {
    return (
      <>{`Your verified settlement account${batch.destinationMaskedRef ? ` (${batch.destinationMaskedRef})` : ''}`}</>
    );
  }
  return <>Destination not reported</>;
}

export function LpSettlementBatchesView({
  page,
  keep,
}: {
  page: LpResult<SettlementBatchPage> | undefined;
  keep: Readonly<Record<string, string>>;
}) {
  return (
    <section>
      <h1>Provider settlements</h1>
      <SectionNav
        links={RECONCILIATION_LINKS}
        current="/reconciliation/settlements"
        label="Reconciliation"
      />
      <p className="muted">
        Settlement batches exactly as the payment provider reported them. Udofin never recomputes a
        gross, fee, tax or net figure. A batch reported to an account that is not your verified
        settlement account is marked in words.
      </p>
      <Loadable result={page} title="the settlements">
        {(data) => {
          const wrong = data.items.filter((b) => b.destinationOk === false);
          return data.items.length === 0 ? (
            <EmptyState
              title="No settlement reported yet"
              detail="No settlement batch has been reported for your organisation. Without one, reconciliation cannot check provider settlement."
            />
          ) : (
            <>
              {wrong.length > 0 ? (
                <CriticalBanner title="A settlement was reported to another account">
                  <p>
                    {lpCount(wrong.length)} batch(es) on this page were reported to an account that
                    is not your verified settlement account.
                  </p>
                </CriticalBanner>
              ) : null}
              <table>
                <caption className="sr-only">Provider settlement batches, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Report date</th>
                    <th scope="col">Period</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Bank reference (UTR)</th>
                    <th scope="col">Net reported</th>
                    <th scope="col">Items</th>
                    <th scope="col">Destination</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((batch) => (
                    <tr key={batch.id}>
                      <td>{lpDate(batch.reportDate)}</td>
                      <td>
                        {lpDate(batch.periodFrom)} to {lpDate(batch.periodTo)}
                      </td>
                      <td>{batch.provider}</td>
                      <td>{batch.settlementRef}</td>
                      <td>
                        {lpRupees(batch.netMinor)}
                        {batch.partsMismatch ? ' (the provider’s figures do not add up)' : ''}
                      </td>
                      <td>{lpCount(batch.itemCount)}</td>
                      <td>
                        <DestinationWords batch={batch} />
                      </td>
                      <td>
                        <a href={`/reconciliation/settlements/${batch.id}`}>Open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager
                basePath="/reconciliation/settlements"
                keep={keep}
                nextCursor={data.nextCursor}
              />
            </>
          );
        }}
      </Loadable>
    </section>
  );
}

export function LpSettlementBatchView({
  batch,
  items,
  keep,
  id,
}: {
  batch: LpResult<SettlementBatch> | undefined;
  items: LpResult<SettlementItemPage> | undefined;
  keep: Readonly<Record<string, string>>;
  id: string;
}) {
  return (
    <section>
      <h1>Settlement batch</h1>
      <SectionNav
        links={RECONCILIATION_LINKS}
        current="/reconciliation/settlements"
        label="Reconciliation"
      />
      <Loadable result={batch} title="this settlement batch">
        {(data) => (
          <>
            {data.destinationOk === false ? (
              <CriticalBanner title="Reported to an account that is not your verified account">
                <p>
                  The provider reported this settlement to an account other than your verified
                  settlement account. Look at the exception queue.
                </p>
              </CriticalBanner>
            ) : null}
            <Facts
              rows={[
                ['Provider', data.provider],
                ['Provider batch reference', data.batchRef],
                ['Bank reference (UTR)', data.settlementRef],
                ['Period', `${lpDate(data.periodFrom)} to ${lpDate(data.periodTo)}`],
                ['Destination', <DestinationWords key="destination" batch={data} />],
                ['Gross, as reported', lpRupees(data.grossMinor)],
                ['Fee, as reported', lpRupees(data.feeMinor)],
                ['Tax, as reported', lpRupees(data.taxMinor)],
                ['Net, as reported', lpRupees(data.netMinor)],
                ['Items', lpCount(data.itemCount)],
                ['Report date', lpDate(data.reportDate)],
                ['Received', lpDateTimeIst(data.receivedAt)],
              ]}
            />
            {data.partsMismatch ? (
              <p role="alert" className="form-error">
                <strong>The provider’s figures do not add up.</strong> They are shown exactly as the
                provider reported them; nothing was corrected.
              </p>
            ) : null}
          </>
        )}
      </Loadable>
      <h2>Items in this batch</h2>
      <Loadable result={items} title="the settlement items">
        {(data) =>
          data.items.length === 0 ? (
            <p>This batch lists no items.</p>
          ) : (
            <>
              <table>
                <caption className="sr-only">Items of the settlement batch, as reported</caption>
                <thead>
                  <tr>
                    <th scope="col">Provider payment</th>
                    <th scope="col">Provider order</th>
                    <th scope="col">Gross</th>
                    <th scope="col">Fee</th>
                    <th scope="col">Tax</th>
                    <th scope="col">Net</th>
                    <th scope="col">Figures add up?</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.providerPaymentRef}</td>
                      <td>{item.orderRef ?? '—'}</td>
                      <td>{lpRupees(item.grossMinor)}</td>
                      <td>{lpRupees(item.feeMinor)}</td>
                      <td>{lpRupees(item.taxMinor)}</td>
                      <td>{lpRupees(item.netMinor)}</td>
                      <td>{item.partsMismatch ? 'No: as the provider reported' : 'As reported'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager
                basePath={`/reconciliation/settlements/${id}`}
                keep={keep}
                nextCursor={data.nextCursor}
              />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Bank-credit upload
// ---------------------------------------------------------------------------------------------------------------
export function LpBankCreditUploadView({
  accounts,
  ctx,
  done,
  error,
  inserted,
  duplicates,
}: {
  accounts: LpResult<SettlementAccounts> | undefined;
  ctx: LpViewContext;
  done?: boolean;
  error?: string | undefined;
  inserted?: number | undefined;
  duplicates?: number | undefined;
}) {
  return (
    <section>
      <h1>Bank credits</h1>
      <SectionNav
        links={RECONCILIATION_LINKS}
        current="/reconciliation/bank-credits"
        label="Reconciliation"
      />
      <LpNotice done={done} error={error} inserted={inserted} duplicates={duplicates} />
      <WhatItChanges>
        <p>
          Reports the credits that reached your settlement account so that reconciliation can match
          them against the provider’s settlements. It records value date, amount and bank reference
          only and moves no money. The statement is a CSV text file whose first line names exactly
          three columns: <code>valueDate,amountMinor,utr</code>, in any order. Use the date as
          YYYY-MM-DD and the amount in whole paise (150050 means ₹1,500.50). Any other column, for
          example a narration that may carry a name, makes the server refuse the whole file and
          store nothing. A file holds at most {lpCount(LP_BANK_CREDIT_MAX_ROWS)} lines. The portal
          checks the first line before sending; the server checks every line and decides.
        </p>
      </WhatItChanges>
      {ctx.caps.reconcile && ctx.lenderId ? (
        <Loadable result={accounts} title="your settlement accounts">
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState
                title="No settlement account on record"
                detail="Credits can be uploaded only against a settlement account of your organisation. None is on record yet."
              />
            ) : (
              <OpForm
                op="payments.bank_credits.upload"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId: ctx.lenderId ?? '' }}
                submit="Upload the bank credits"
              >
                <SelectField
                  name="accountId"
                  label="Settlement account the credits reached"
                  blank="Choose an account"
                  required
                  options={data.items.map((account) => ({
                    value: account.settlementAccountId,
                    label: `${account.maskedRef} (${lpWord(SETTLEMENT_ACCOUNT_STATUS_WORDS, account.verificationStatus)}${account.usable ? '' : ', not usable now'})`,
                  }))}
                />
                <div className="field">
                  <label htmlFor="bank-credit-file">Statement file (CSV)</label>
                  <input
                    id="bank-credit-file"
                    name="file"
                    type="file"
                    accept=".csv,text/csv,text/plain"
                  />
                </div>
                <div className="field">
                  <label htmlFor="bank-credit-text">Or paste the statement text</label>
                  <textarea id="bank-credit-text" name="csv" rows={6} autoComplete="off" />
                  <small className="muted">
                    Give either a file or pasted text, not both. Do not include names, narrations or
                    account numbers.
                  </small>
                </div>
                <ConfirmField label="I confirm that this statement has only the three columns and that I want to upload it." />
              </OpForm>
            )
          }
        </Loadable>
      ) : (
        <p className="muted">
          You can read this page, but your role does not include uploading bank credits.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting times
// ---------------------------------------------------------------------------------------------------------------
export function LpReconciliationSettingsView({
  settings,
  ctx,
  done,
  error,
}: {
  settings: LpResult<ReconSettingsList> | undefined;
  ctx: LpViewContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <section>
      <h1>Waiting times</h1>
      <SectionNav
        links={RECONCILIATION_LINKS}
        current="/reconciliation/settings"
        label="Reconciliation"
      />
      <LpNotice done={done} error={error} />
      <Loadable result={settings} title="the waiting times">
        {(data) => {
          const current = ctx.lenderId
            ? (data.items.find((s) => s.lenderId === ctx.lenderId) ?? data.items[0])
            : data.items[0];
          return (
            <>
              <p className="muted">
                How long reconciliation waits for each source before it raises an exception.
                Unverified default: until your organisation sets them, the platform’s default
                waiting times apply and they have no source on file. Replace them from your
                agreements with the provider and the bank.
              </p>
              {current ? (
                <Facts
                  rows={[
                    [
                      'Provider settlement and bank credit',
                      `${lpCount(current.settlementLagDays)} days`,
                    ],
                    ['Lender posting the receipt', `${lpCount(current.receiptLagHours)} hours`],
                    ['Last changed', lpDateTimeIst(current.updatedAt)],
                  ]}
                />
              ) : (
                <p>
                  Your organisation has not set its own waiting times: the unverified platform
                  defaults apply. Each report states the waiting times its run used.
                </p>
              )}
              {ctx.caps.configure && ctx.lenderId ? (
                <>
                  <WhatItChanges>
                    <p>
                      This sets how many days reconciliation waits for the provider’s settlement and
                      your bank credit, and how many hours it waits for your loan system to post a
                      receipt, before it raises an exception. It applies to runs made after you save
                      it and changes no payment. The server checks the values and refuses what it
                      does not accept.
                    </p>
                  </WhatItChanges>
                  <OpForm
                    op="payments.recon_settings.set"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId: ctx.lenderId }}
                    submit="Save waiting times"
                  >
                    <TextField
                      name="settlementLagDays"
                      type="number"
                      required
                      label="Days to wait for the provider’s settlement and your bank credit"
                      defaultValue={current ? String(current.settlementLagDays) : ''}
                    />
                    <TextField
                      name="receiptLagHours"
                      type="number"
                      required
                      label="Hours to wait for your loan system to post a receipt"
                      defaultValue={current ? String(current.receiptLagHours) : ''}
                    />
                    <ConfirmField label="I confirm that I want to change the waiting times of my organisation." />
                  </OpForm>
                </>
              ) : (
                <p className="muted">
                  You can read the waiting times, but your role does not include changing them.
                </p>
              )}
            </>
          );
        }}
      </Loadable>
    </section>
  );
}
