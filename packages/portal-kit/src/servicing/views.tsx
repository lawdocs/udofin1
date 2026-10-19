import {
  LS_COLLATERAL_TYPES,
  LS_DOCUMENT_KINDS,
  LS_LOAN_STATUSES,
  LS_REQUEST_STATUSES,
  type LsLoanDetail,
  type LsLoanRow,
  type LsQuote,
} from '@udofin/contracts';
import { AreaField, OpForm, SelectField, TextField } from '../onboarding/forms.js';
import {
  AsReported,
  CheckField,
  EmptyList,
  FileField,
  LoadFailure,
  Paging,
  Section,
  ServicingNav,
  ServicingNotice,
  type Loaded,
  type ServicingContext,
} from './common.js';
import { lenderNameOf, listHref, mayIn, withoutCursor, type ListQuery } from './data.js';
import {
  dateOrDash,
  formatCount,
  formatDate,
  formatIst,
  formatRupees,
  istOrDash,
  NOT_REPORTED,
  rupeesOrNotReported,
} from './format.js';
import { AnomalyList, ConflictList } from './sync-views.js';
import {
  type LsAnomalyPage,
  type LsBalanceReport,
  type LsClosure,
  type LsClosurePage,
  type LsConflictPage,
  type LsDocumentList,
  type LsDocumentRequest,
  type LsDocumentRequestPage,
  type LsLoanPage,
  type LsQuotePage,
} from './types.js';
import {
  collateralWords,
  closureKindWords,
  documentKindWords,
  documentSourceWords,
  loanStatusWords,
  quoteSourceWords,
  releaseStatusWords,
  reportFlagWords,
  requestStatusWords,
  sourceSystemWords,
} from './wording.js';

export { ConflictsPage, AnomaliesPage, SyncPage, ImportDetailPage } from './sync-views.js';

// ---------------------------------------------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------------------------------------------
function SyncNotes({ loan }: { loan: LsLoanRow }) {
  const s = loan.sync;
  const minutes = `${formatCount(s.stalenessThresholdMinutes)} minutes`;
  return (
    <ul>
      <li>
        {s.newestReportedAsOf === null
          ? 'No report received yet'
          : s.stale
            ? `Stale: the newest report is older than the threshold of ${minutes}`
            : `The newest report is within the threshold of ${minutes}`}
      </li>
      {s.hasOpenConflict ? <li>A conflict is waiting</li> : null}
      {s.newestHasWarning ? <li>A warning was flagged on the newest report</li> : null}
    </ul>
  );
}

export function LoansPage({
  page,
  query,
  ctx,
}: {
  page: Loaded<LsLoanPage>;
  query: ListQuery;
  ctx: ServicingContext;
}) {
  const several = ctx.grants.length > 1;
  return (
    <div>
      <h1>Loans</h1>
      <ServicingNav current="/loans" />
      <p>
        Loans as your lender system reported them, with your figures and your times. Udofin
        calculates no balance, charge or days past due, and the lender decides everything about the
        loan.
      </p>
      <form method="get" action="/loans" className="inline">
        <SelectField
          name="status"
          label="Status as last reported"
          blank="All statuses"
          options={LS_LOAN_STATUSES.map((s) => ({ value: s, label: loanStatusWords(s) }))}
          defaultValue={query.status ?? ''}
        />
        {several ? (
          <SelectField
            name="lenderId"
            label="Lender"
            blank="All my lenders"
            options={ctx.grants.map((g) => ({ value: g.lenderId, label: g.name }))}
            defaultValue={query.lenderId ?? ''}
          />
        ) : null}
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      {!page.ok ? (
        <LoadFailure what="the loans" status={page.status} />
      ) : page.data.items.length === 0 ? (
        <EmptyList
          title="No loans"
          detail="A loan appears here after your system reports it, for example through an imported file."
        />
      ) : (
        <>
          <table>
            <caption>Loans, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Your loan reference</th>
                {several ? <th scope="col">Lender</th> : null}
                <th scope="col">Status as last reported</th>
                <th scope="col">Sanctioned</th>
                <th scope="col">Disbursed</th>
                <th scope="col">Newest report</th>
                <th scope="col">Sync</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((loan) => (
                <tr key={loan.id}>
                  <th scope="row">
                    <a href={`/loans/${loan.id}`}>{loan.lmsLoanRef}</a>
                  </th>
                  {several ? <td>{lenderNameOf(ctx.grants, loan.lenderId)}</td> : null}
                  <td>{loanStatusWords(loan.status)}</td>
                  <td>{formatRupees(loan.sanctionedAmountMinor)}</td>
                  <td>{rupeesOrNotReported(loan.disbursedAmountMinor)}</td>
                  <td>
                    {loan.sync.newestReportedAsOf
                      ? `As reported ${formatIst(loan.sync.newestReportedAsOf)}`
                      : NOT_REPORTED}
                  </td>
                  <td>
                    <SyncNotes loan={loan} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Paging
            nextHref={
              page.data.nextCursor
                ? listHref('/loans', { ...query, cursor: page.data.nextCursor })
                : null
            }
            firstHref={listHref('/loans', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="loans"
          />
        </>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}

function ReportedFigures({ report }: { report: LsBalanceReport }) {
  return (
    <table>
      <caption>Figures exactly as reported</caption>
      <thead>
        <tr>
          <th scope="col">Figure</th>
          <th scope="col">As reported</th>
        </tr>
      </thead>
      <tbody>
        <Figure label="Status" value={loanStatusWords(report.status)} />
        <Figure
          label="Outstanding principal"
          value={rupeesOrNotReported(report.outstandingPrincipalMinor)}
        />
        <Figure
          label="Overdue principal"
          value={rupeesOrNotReported(report.overduePrincipalMinor)}
        />
        <Figure label="Overdue interest" value={rupeesOrNotReported(report.overdueInterestMinor)} />
        <Figure label="Penal charges" value={rupeesOrNotReported(report.penalChargesMinor)} />
        <Figure label="Other charges" value={rupeesOrNotReported(report.otherChargesMinor)} />
        <Figure label="Total overdue" value={rupeesOrNotReported(report.totalOverdueMinor)} />
        <Figure
          label="Next due date"
          value={report.nextDueOn ? formatDate(report.nextDueOn) : NOT_REPORTED}
        />
        <Figure label="Next due amount" value={rupeesOrNotReported(report.nextDueMinor)} />
        <Figure
          label="Days past due"
          value={report.daysPastDue === null ? NOT_REPORTED : formatCount(report.daysPastDue)}
        />
      </tbody>
    </table>
  );
}

export function LoanDetailPage({
  detail,
  conflicts,
  anomalies,
  documents,
  quotes,
  requests,
  ctx,
  done,
  error,
}: {
  detail: Loaded<LsLoanDetail>;
  conflicts: Loaded<LsConflictPage>;
  anomalies: Loaded<LsAnomalyPage>;
  documents: Loaded<LsDocumentList>;
  quotes: Loaded<LsQuotePage>;
  /** The open requests of this loan only. */
  requests: Loaded<LsDocumentRequestPage>;
  ctx: ServicingContext;
  done?: boolean;
  error?: string | undefined;
}) {
  if (!detail.ok)
    return (
      <div>
        <h1>Loan</h1>
        <ServicingNav current="/loans" />
        <LoadFailure what="this loan" status={detail.status} />
      </div>
    );
  const { loan, report, schedule, receipts } = detail.data;
  const lender = lenderNameOf(ctx.grants, loan.lenderId);
  const ended = loan.status === 'closed' || loan.status === 'foreclosed';
  return (
    <div>
      <h1>Loan {loan.lmsLoanRef}</h1>
      <ServicingNav current="/loans" />
      <ServicingNotice done={done === true} error={error} />
      <dl className="facts">
        <div>
          <dt>Lender</dt>
          <dd>{lender}</dd>
        </div>
        <div>
          <dt>Status as last reported</dt>
          <dd>{loanStatusWords(loan.status)}</dd>
        </div>
        <div>
          <dt>Sanctioned amount</dt>
          <dd>{formatRupees(loan.sanctionedAmountMinor)}</dd>
        </div>
        <div>
          <dt>Disbursed amount</dt>
          <dd>{rupeesOrNotReported(loan.disbursedAmountMinor)}</dd>
        </div>
        <div>
          <dt>Disbursed on</dt>
          <dd>{loan.disbursedAt ? formatIst(loan.disbursedAt) : NOT_REPORTED}</dd>
        </div>
      </dl>

      {loan.sync.stale ? (
        <section className="state" role="status">
          <h2>These figures may be out of date</h2>
          <p>
            {loan.sync.newestReportedAsOf === null
              ? 'No report has been received for this loan yet.'
              : `The newest report is older than the threshold of ${formatCount(loan.sync.stalenessThresholdMinutes)} minutes.`}{' '}
            What is shown is what your system last reported.
          </p>
        </section>
      ) : null}
      {loan.sync.newestHasWarning || detail.data.anomalies.warning > 0 ? (
        <p role="note">
          A warning was flagged next to what your system reported. It is shown below and nothing was
          corrected.
        </p>
      ) : null}

      <Section title="Newest report">
        {!report ? (
          <p>No report has been received for this loan yet.</p>
        ) : (
          <>
            <AsReported lender={lender} at={report.reportedAsOf} receivedAt={report.receivedAt} />
            <p className="muted">
              Source: {sourceSystemWords(report.sourceSystem)}. Version{' '}
              {formatCount(report.version)}.
            </p>
            <ReportedFigures report={report} />
            {report.flags.map((flag) => (
              <p key={flag} role="note" className="form-error">
                {reportFlagWords(flag)}
              </p>
            ))}
          </>
        )}
      </Section>

      <Section title="Repayment schedule as reported">
        {!schedule ? (
          <p>No schedule has been received for this loan yet.</p>
        ) : (
          <>
            <p className="muted">
              Version {formatCount(schedule.version)}, received {formatIst(schedule.receivedAt)}
              {schedule.reportedAsOf ? `, as reported ${formatIst(schedule.reportedAsOf)}` : ''}.
            </p>
            <table>
              <caption>Instalments exactly as reported</caption>
              <thead>
                <tr>
                  <th scope="col">No.</th>
                  <th scope="col">Due date</th>
                  <th scope="col">Principal</th>
                  <th scope="col">Interest</th>
                  <th scope="col">Fees</th>
                  <th scope="col">Instalment</th>
                </tr>
              </thead>
              <tbody>
                {schedule.installments.map((i) => (
                  <tr key={i.seq}>
                    <th scope="row">{formatCount(i.seq)}</th>
                    <td>{formatDate(i.dueDate)}</td>
                    <td>{formatRupees(i.principalMinor)}</td>
                    <td>{formatRupees(i.interestMinor)}</td>
                    <td>{formatRupees(i.feesMinor)}</td>
                    <td>{formatRupees(i.totalMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="Recent receipts as reported">
        {receipts.length === 0 ? (
          <p>No receipt has been reported for this loan yet.</p>
        ) : (
          <>
            <p className="muted">
              The twenty newest receipts your system posted. This is not a statement of account.
            </p>
            <table>
              <caption>Receipts and reversals as reported</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Your reference</th>
                  <th scope="col">Reverses</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Value date</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Bank reference</th>
                  <th scope="col">As reported</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>{r.kind === 'reversal' ? 'Reversal' : 'Receipt'}</td>
                    <th scope="row">{r.lmsReceiptRef}</th>
                    <td>{r.reversesReceiptRef ?? '—'}</td>
                    <td>{formatRupees(r.amountMinor)}</td>
                    <td>{formatDate(r.valueDate)}</td>
                    <td>{r.paymentMode ?? '—'}</td>
                    <td>{r.bankReference ?? '—'}</td>
                    <td>{formatIst(r.reportedAsOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="Conflicts and flags for this loan">
        {!conflicts.ok ? (
          <LoadFailure what="the conflicts" status={conflicts.status} />
        ) : conflicts.data.items.length === 0 ? (
          <p>No conflict has been recorded for this loan.</p>
        ) : (
          <ConflictList conflicts={conflicts.data.items} ctx={ctx} />
        )}
        {!anomalies.ok ? (
          <LoadFailure what="the flags" status={anomalies.status} />
        ) : anomalies.data.items.length === 0 ? (
          <p>No flag has been raised for this loan.</p>
        ) : (
          <AnomalyList anomalies={anomalies.data.items} />
        )}
      </Section>

      <DocumentsSection loan={loan} documents={documents} requests={requests} ctx={ctx} />
      <QuotesSection
        loan={loan}
        quotes={quotes}
        documents={documents}
        requests={requests}
        ctx={ctx}
      />

      <Section title="Closure and security release">
        {ended ? (
          <>
            <p>
              This loan was reported {loanStatusWords(loan.status).toLowerCase()}. Udofin holds no
              collateral: your organisation releases any security and confirms it.{' '}
              <a href="/loans/closures">See the closure records and security-release tasks</a>.
            </p>
            {mayIn(ctx.grants, loan.lenderId, 'documentIssue') ? (
              <OpForm
                op="servicing.closure.open"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ loanId: loan.id }}
                submit="Record the security your organisation holds"
              >
                <fieldset>
                  <legend>Security held on this loan (choose one to five)</legend>
                  {LS_COLLATERAL_TYPES.map((t) => (
                    <CheckField
                      key={t}
                      name="collateralTypes"
                      value={t}
                      label={collateralWords(t)}
                    />
                  ))}
                </fieldset>
              </OpForm>
            ) : (
              <p className="muted">Your role cannot record security.</p>
            )}
          </>
        ) : (
          <p>Closure records appear once your system reports this loan closed or foreclosed.</p>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Lender-issued documents
// ---------------------------------------------------------------------------------------------------------------
export const documentHref = (loanId: string, documentId: string) =>
  `/loans/${loanId}/documents/${documentId}/file`;

function DocumentsSection({
  loan,
  documents,
  requests,
  ctx,
}: {
  loan: LsLoanRow;
  documents: Loaded<LsDocumentList>;
  requests: Loaded<LsDocumentRequestPage>;
  ctx: ServicingContext;
}) {
  const issue = mayIn(ctx.grants, loan.lenderId, 'documentIssue');
  const docs = documents.ok ? documents.data.items : [];
  const open = requests.ok ? requests.data.items.filter((r) => r.status === 'requested') : [];
  return (
    <section className="card" id="documents" aria-labelledby="documents-title">
      <h2 id="documents-title">Documents your organisation issued</h2>
      <p>
        Udofin does not write, sign or issue statements, no-dues certificates or letters. Register
        the signed PDF your organisation issued. Registering a file does not make it valid. Opening
        a file is recorded against your account, and the file is compared with the fingerprint
        (SHA-256) recorded when it was registered.
      </p>
      {!documents.ok ? (
        <LoadFailure what="the documents" status={documents.status} />
      ) : docs.length === 0 ? (
        <p>No document has been registered for this loan.</p>
      ) : (
        <table>
          <caption>Registered documents, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Your reference</th>
              <th scope="col">Issued</th>
              <th scope="col">Period</th>
              <th scope="col">Size</th>
              <th scope="col">Fingerprint (SHA-256)</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.documentId}>
                <td>
                  {documentKindWords(d.kind)}
                  <br />
                  <small>{documentSourceWords(d.source)}</small>
                  {d.supersededById ? (
                    <>
                      <br />
                      <small>Replaced by a newer document</small>
                    </>
                  ) : null}
                </td>
                <th scope="row">{d.lenderReference}</th>
                <td>{formatIst(d.issuedAt)}</td>
                <td>
                  {d.periodFrom || d.periodTo
                    ? `${dateOrDash(d.periodFrom)} to ${dateOrDash(d.periodTo)}`
                    : '—'}
                </td>
                <td>{formatCount(d.sizeBytes)} bytes</td>
                <td title={d.sha256}>{d.sha256.slice(0, 16)}…</td>
                <td>
                  <a href={documentHref(loan.id, d.documentId)} target="_blank" rel="noopener">
                    Open the PDF
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {issue ? (
        <details>
          <summary>Register a document</summary>
          <OpForm
            op="servicing.document.register"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ loanId: loan.id }}
            submit="Register the document"
          >
            <SelectField
              name="kind"
              label="What it is"
              required
              options={LS_DOCUMENT_KINDS.map((k) => ({ value: k, label: documentKindWords(k) }))}
              defaultValue="statement"
            />
            <FileField
              name="file"
              label="The signed PDF"
              accept="application/pdf"
              hint="PDF only, at most 8 MiB. A PDF that contains scripts or attachments is refused."
            />
            <TextField
              name="lenderReference"
              label="Your reference for this document"
              required
              hint="Letters, digits and . _ / - only, up to 100 characters."
            />
            <TextField
              name="issuedAt"
              label="Issued at (India time)"
              type="datetime-local"
              required
            />
            <TextField name="periodFrom" label="Period from (optional)" type="date" />
            <TextField name="periodTo" label="Period to (optional)" type="date" />
            <SelectField
              name="supersedesDocumentId"
              label="Replaces an earlier document (optional)"
              blank="Does not replace one"
              options={docs
                .filter((d) => d.supersededById === null)
                .map((d) => ({
                  value: d.documentId,
                  label: `${documentKindWords(d.kind)}, your reference ${d.lenderReference}`,
                }))}
            />
            <SelectField
              name="requestId"
              label="Answers a borrower's request (optional)"
              blank="Not answering a request"
              options={open
                .filter((r) => r.kind !== 'foreclosure_quote')
                .map((r) => ({
                  value: r.id,
                  label: `${documentKindWords(r.kind)}, requested ${formatIst(r.requestedAt)}`,
                }))}
            />
          </OpForm>
        </details>
      ) : (
        <p className="muted">Your role cannot register documents.</p>
      )}
      <RequestsForLoan requests={requests} ctx={ctx} />
    </section>
  );
}

function RequestsForLoan({
  requests,
  ctx,
}: {
  requests: Loaded<LsDocumentRequestPage>;
  ctx: ServicingContext;
}) {
  if (!requests.ok) return <LoadFailure what="the document requests" status={requests.status} />;
  if (requests.data.items.length === 0) return <p>No open request for a document on this loan.</p>;
  return (
    <div>
      <h3>Open requests for this loan</h3>
      <RequestCards requests={requests.data.items} ctx={ctx} loanLink={false} />
    </div>
  );
}

export function RequestCards({
  requests,
  ctx,
  loanLink,
}: {
  requests: readonly LsDocumentRequest[];
  ctx: ServicingContext;
  /** On the queue page each card links to its loan; on the loan page it links to the forms below. */
  loanLink: boolean;
}) {
  return (
    <div>
      {requests.map((r) => {
        const loanHref = `/loans/${r.loanAccountId}`;
        const fulfilBy = r.kind === 'foreclosure_quote' ? '#quotes' : '#documents';
        return (
          <article key={r.id} className="card">
            <h4>{documentKindWords(r.kind)}</h4>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>{requestStatusWords(r.status)}</dd>
              </div>
              <div>
                <dt>Requested</dt>
                <dd>{formatIst(r.requestedAt)}</dd>
              </div>
              {r.periodFrom || r.periodTo ? (
                <div>
                  <dt>Period asked for</dt>
                  <dd>
                    {dateOrDash(r.periodFrom)} to {dateOrDash(r.periodTo)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Udofin’s default target (not a regulatory deadline)</dt>
                <dd>{r.dueBy ? formatIst(r.dueBy) : 'None set'}</dd>
              </div>
              {r.decidedAt ? (
                <div>
                  <dt>Decided</dt>
                  <dd>{formatIst(r.decidedAt)}</dd>
                </div>
              ) : null}
              {r.lenderNote ? (
                <div>
                  <dt>Your note to the borrower</dt>
                  <dd>{r.lenderNote}</dd>
                </div>
              ) : null}
            </dl>
            <p>
              {r.status === 'requested' ? (
                <a href={loanLink ? `${loanHref}${fulfilBy}` : fulfilBy}>
                  {loanLink
                    ? 'Open the loan to answer this request'
                    : r.kind === 'foreclosure_quote'
                      ? 'Record the quotation below'
                      : 'Register the document above'}
                </a>
              ) : loanLink ? (
                <a href={loanHref}>Open the loan</a>
              ) : null}
              {r.fulfilledDocumentId ? (
                <>
                  {loanLink || r.status === 'requested' ? ' · ' : ''}
                  <a
                    href={documentHref(r.loanAccountId, r.fulfilledDocumentId)}
                    target="_blank"
                    rel="noopener"
                  >
                    Open the document that answered it
                  </a>
                </>
              ) : null}
            </p>
            {r.status === 'requested' && mayIn(ctx.grants, r.lenderId, 'documentIssue') ? (
              <OpForm
                op="servicing.request.decline"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: r.id }}
                submit="Decline this request"
                secondary
              >
                <AreaField
                  name="note"
                  label="Why (10 to 500 characters; the borrower can read this; no personal details)"
                  required
                />
              </OpForm>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function DocumentRequestsPage({
  page,
  query,
  ctx,
  done,
  error,
}: {
  page: Loaded<LsDocumentRequestPage>;
  query: ListQuery;
  ctx: ServicingContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const shown = query.status ?? 'requested';
  return (
    <div>
      <h1>Document requests</h1>
      <ServicingNav current="/loans/requests" />
      <p>
        Borrowers can ask for a statement, a foreclosure quotation, a no-dues certificate or a
        closure letter. Your organisation answers by registering its own document or recording its
        quotation on the loan, or declines with a reason the borrower can read. The borrower is not
        named here.
      </p>
      <ServicingNotice done={done === true} error={error} />
      <form method="get" action="/loans/requests" className="inline">
        <SelectField
          name="status"
          label="Status"
          options={[
            { value: 'all', label: 'All' },
            ...LS_REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusWords(s) })),
          ]}
          defaultValue={shown}
        />
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      {!page.ok ? (
        <LoadFailure what="the requests" status={page.status} />
      ) : page.data.items.length === 0 ? (
        <EmptyList title="No requests" detail="Nothing matches this filter." />
      ) : (
        <>
          <RequestCards requests={page.data.items} ctx={ctx} loanLink />
          <Paging
            nextHref={
              page.data.nextCursor
                ? listHref('/loans/requests', {
                    ...query,
                    status: shown,
                    cursor: page.data.nextCursor,
                  })
                : null
            }
            firstHref={listHref('/loans/requests', { ...withoutCursor(query), status: shown })}
            hasCursor={query.cursor !== undefined}
            noun="requests"
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Foreclosure quotations
// ---------------------------------------------------------------------------------------------------------------
function QuoteCard({ q, loanId }: { q: LsQuote; loanId: string }) {
  return (
    <article className="card">
      <h4>Quotation {q.lenderQuoteRef}</h4>
      <p className="muted">
        As quoted by your organisation as of {formatIst(q.asOf)}. Valid until{' '}
        {formatIst(q.validUntil)}. {quoteSourceWords(q.source)}; recorded {formatIst(q.reportedAt)}.
      </p>
      <table>
        <caption>Figures exactly as quoted</caption>
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">As quoted</th>
          </tr>
        </thead>
        <tbody>
          <Figure label="Principal" value={formatRupees(q.principalMinor)} />
          <Figure label="Interest" value={formatRupees(q.interestMinor)} />
          <Figure label="Charges" value={formatRupees(q.chargesMinor)} />
          <Figure label="Prepayment charge" value={formatRupees(q.prepaymentChargeMinor)} />
          <Figure label="Total" value={formatRupees(q.totalMinor)} />
        </tbody>
      </table>
      {q.totalMismatch ? (
        <p role="alert" className="form-error">
          Flagged: the parts do not add up to the total your organisation stated. The quotation is
          shown exactly as recorded and has not been corrected. It must not be paid. Record a new
          quotation instead.
        </p>
      ) : null}
      {q.letterDocumentId ? (
        <p>
          <a href={documentHref(loanId, q.letterDocumentId)} target="_blank" rel="noopener">
            Open the quotation letter
          </a>
        </p>
      ) : null}
    </article>
  );
}

function QuotesSection({
  loan,
  quotes,
  documents,
  requests,
  ctx,
}: {
  loan: LsLoanRow;
  quotes: Loaded<LsQuotePage>;
  documents: Loaded<LsDocumentList>;
  requests: Loaded<LsDocumentRequestPage>;
  ctx: ServicingContext;
}) {
  const issue = mayIn(ctx.grants, loan.lenderId, 'documentIssue');
  const letters = documents.ok
    ? documents.data.items.filter((d) => d.kind === 'foreclosure_quote')
    : [];
  const open = requests.ok
    ? requests.data.items.filter((r) => r.status === 'requested' && r.kind === 'foreclosure_quote')
    : [];
  return (
    <section className="card" id="quotes" aria-labelledby="quotes-title">
      <h2 id="quotes-title">Foreclosure quotations</h2>
      <p>
        Record the quotation your organisation issued, with its parts and its total exactly as you
        state them. Udofin never works out or adjusts a quotation. If the parts do not add up to the
        total, the quotation is kept and flagged, not corrected.
      </p>
      {!quotes.ok ? (
        <LoadFailure what="the quotations" status={quotes.status} />
      ) : quotes.data.items.length === 0 ? (
        <p>No quotation has been recorded for this loan.</p>
      ) : (
        quotes.data.items.map((q) => <QuoteCard key={q.id} q={q} loanId={loan.id} />)
      )}
      {issue ? (
        <details>
          <summary>Record a quotation</summary>
          <OpForm
            op="servicing.quote.record"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ loanId: loan.id }}
            submit="Record the quotation"
          >
            <TextField
              name="lenderQuoteRef"
              label="Your reference for this quotation"
              required
              hint="Letters, digits and . _ / - only, up to 100 characters."
            />
            <TextField
              name="asOf"
              label="As of (India time, not in the future)"
              type="datetime-local"
              required
            />
            <TextField
              name="validUntil"
              label="Valid until (India time)"
              type="datetime-local"
              required
            />
            {(
              [
                ['principal', 'Principal'],
                ['interest', 'Interest'],
                ['charges', 'Charges'],
                ['prepaymentCharge', 'Prepayment charge'],
                ['total', 'Total as you state it'],
              ] as const
            ).map(([name, label]) => (
              <TextField
                key={name}
                name={name}
                label={`${label} (rupees)`}
                required
                hint="Digits with up to two decimals, for example 12500.50."
              />
            ))}
            <SelectField
              name="requestId"
              label="Answers a borrower's request (optional)"
              blank="Not answering a request"
              options={open.map((r) => ({
                value: r.id,
                label: `Requested ${formatIst(r.requestedAt)}`,
              }))}
            />
            <SelectField
              name="letterDocumentId"
              label="Quotation letter you registered (optional)"
              blank="No letter"
              options={letters.map((d) => ({
                value: d.documentId,
                label: `Your reference ${d.lenderReference}`,
              }))}
            />
          </OpForm>
        </details>
      ) : (
        <p className="muted">Your role cannot record quotations.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Closures and security release
// ---------------------------------------------------------------------------------------------------------------
function ClosureCard({ closure, ctx }: { closure: LsClosure; ctx: ServicingContext }) {
  const issue = mayIn(ctx.grants, closure.lenderId, 'documentIssue');
  return (
    <article className="card">
      <h3>
        {closureKindWords(closure.closureKind)} loan, {lenderNameOf(ctx.grants, closure.lenderId)}
      </h3>
      <dl className="facts">
        <div>
          <dt>Recorded by Udofin</dt>
          <dd>
            {formatIst(closure.closedAt)} (when your report was recorded, not your closure date)
          </dd>
        </div>
        <div>
          <dt>No-dues certificate</dt>
          <dd>
            {closure.nocDocumentId && closure.nocIssuedAt ? (
              <>
                Issued {formatIst(closure.nocIssuedAt)}{' '}
                <a
                  href={documentHref(closure.loanAccountId, closure.nocDocumentId)}
                  target="_blank"
                  rel="noopener"
                >
                  Open the PDF
                </a>
              </>
            ) : (
              'Not registered yet'
            )}
          </dd>
        </div>
        <div>
          <dt>Udofin’s default target for it (not a regulatory deadline)</dt>
          <dd>{istOrDash(closure.nocDueBy)}</dd>
        </div>
      </dl>
      <p>
        <a href={`/loans/${closure.loanAccountId}`}>Open the loan</a>
      </p>
      {closure.tasks.length === 0 ? (
        <p>No security has been recorded for this loan.</p>
      ) : (
        closure.tasks.map((t) => (
          <section
            key={t.id}
            className="card"
            aria-label={`Release of ${collateralWords(t.collateralType)}`}
          >
            <h4>{collateralWords(t.collateralType)}</h4>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>{releaseStatusWords(t.status)}</dd>
              </div>
              <div>
                <dt>Udofin’s default target (not a regulatory deadline)</dt>
                <dd>{istOrDash(t.dueBy)}</dd>
              </div>
              {t.delayReason ? (
                <div>
                  <dt>Reason for delay, as you wrote it</dt>
                  <dd>{t.delayReason}</dd>
                </div>
              ) : null}
              {t.lenderConfirmationRef && t.confirmedAt ? (
                <div>
                  <dt>Confirmed by your organisation</dt>
                  <dd>
                    {formatIst(t.confirmedAt)}, your reference {t.lenderConfirmationRef}
                  </dd>
                </div>
              ) : null}
            </dl>
            {t.status === 'open' && issue ? (
              <>
                <OpForm
                  op="servicing.closure.confirm"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ taskId: t.id }}
                  submit="Confirm the release"
                >
                  <p>
                    Confirm only once your organisation has released this security. Udofin holds no
                    collateral and never confirms a release.
                  </p>
                  <TextField
                    name="confirmationRef"
                    label="Your confirmation reference"
                    required
                    hint="Letters, digits and . _ / - only, 3 to 100 characters."
                  />
                </OpForm>
                <OpForm
                  op="servicing.closure.delay"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ taskId: t.id }}
                  submit="Record the reason for the delay"
                  secondary
                >
                  <AreaField
                    name="reason"
                    label="Why it is late (10 to 500 characters; the borrower can read this; no personal details)"
                    required
                  />
                </OpForm>
              </>
            ) : null}
            {t.status === 'open' && !issue ? (
              <p className="muted">Your role cannot confirm a release.</p>
            ) : null}
          </section>
        ))
      )}
    </article>
  );
}

export function ClosuresPage({
  page,
  query,
  ctx,
  done,
  error,
}: {
  page: Loaded<LsClosurePage>;
  query: ListQuery;
  ctx: ServicingContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <div>
      <h1>Closures and security release</h1>
      <ServicingNav current="/loans/closures" />
      <p>
        These loans were reported closed or foreclosed. Your organisation issues the no-dues
        certificate and releases any security; Udofin holds no collateral and never confirms a
        release.
      </p>
      <ServicingNotice done={done === true} error={error} />
      {!page.ok ? (
        <LoadFailure what="the closures" status={page.status} />
      ) : page.data.items.length === 0 ? (
        <EmptyList
          title="No closures"
          detail="A record appears when your system reports a loan closed or foreclosed."
        />
      ) : (
        <>
          {page.data.items.map((c) => (
            <ClosureCard key={c.id} closure={c} ctx={ctx} />
          ))}
          <Paging
            nextHref={
              page.data.nextCursor
                ? listHref('/loans/closures', { ...query, cursor: page.data.nextCursor })
                : null
            }
            firstHref={listHref('/loans/closures', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="closures"
          />
        </>
      )}
    </div>
  );
}
