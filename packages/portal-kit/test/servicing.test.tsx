// @vitest-environment jsdom
// The lender servicing screens: every state (empty, error, stale, withheld figures, each batch status), the wording rules,
// the guards that hide a write form from a role that may not use it, and the cross-checks that no screen invents a figure,
// shows a raw server code or posts anything outside the allow-list.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as kit from '../src/index.js';
import { type ServicingContext } from '../src/servicing/common.js';
import { type StageState } from '../src/servicing/data.js';
import { RefusedFile } from '../src/servicing/import-errors.js';
import { SERVICING_OPERATIONS } from '../src/servicing/operations.js';
import { ImportStageForm } from '../src/servicing/stage-form.js';
import {
  AnomaliesPage,
  ConflictsPage,
  ImportDetailPage,
  SyncPage,
} from '../src/servicing/sync-views.js';
import {
  ClosuresPage,
  DocumentRequestsPage,
  LoanDetailPage,
  LoansPage,
} from '../src/servicing/views.js';
import {
  ALL_PERMISSIONS,
  anomaly,
  batch,
  BATCH,
  closure,
  conflict,
  CONFLICT_2,
  contextFor,
  DOC,
  DOC_2,
  docRequest,
  document,
  fail,
  grantsFor,
  LENDER_A,
  LENDER_B,
  loanDetail,
  loanRow,
  LOAN,
  LOAN_2,
  ok,
  page,
  quote,
  REQUEST,
  REQUEST_2,
  report,
  SHA,
  syncItem,
  TASK,
} from './servicing-fixtures.js';

afterEach(cleanup);

const text = (container: HTMLElement) => container.textContent ?? '';
const ops = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="op"]')].map((i) => i.value);
const full = (returnTo = '/loans') => contextFor(ALL_PERMISSIONS, returnTo);
const readOnly = (returnTo = '/loans') => contextFor(['loan.read'], returnTo);

const noDocs = ok({ items: [] });
const noQuotes = page([]);
const noRequests = page([]);
const noConflicts = page([]);
const noAnomalies = page([]);

const detailPage = (
  over: {
    detail?: Parameters<typeof LoanDetailPage>[0]['detail'];
    conflicts?: Parameters<typeof LoanDetailPage>[0]['conflicts'];
    anomalies?: Parameters<typeof LoanDetailPage>[0]['anomalies'];
    documents?: Parameters<typeof LoanDetailPage>[0]['documents'];
    quotes?: Parameters<typeof LoanDetailPage>[0]['quotes'];
    requests?: Parameters<typeof LoanDetailPage>[0]['requests'];
    ctx?: ServicingContext;
    done?: boolean;
    error?: string;
  } = {},
): ReactElement => (
  <LoanDetailPage
    detail={over.detail ?? ok(loanDetail())}
    conflicts={over.conflicts ?? noConflicts}
    anomalies={over.anomalies ?? noAnomalies}
    documents={over.documents ?? noDocs}
    quotes={over.quotes ?? noQuotes}
    requests={over.requests ?? noRequests}
    ctx={over.ctx ?? full(`/loans/${LOAN}`)}
    done={over.done}
    error={over.error}
  />
);

// -------------------------------------------------------------------------------------------------------------------
describe('Loans list', () => {
  const view = (pageResult: Parameters<typeof LoansPage>[0]['page'], query = {}, ctx = full()) =>
    render(<LoansPage page={pageResult} query={query} ctx={ctx} />);

  it('says plainly that there are no loans yet', () => {
    view(page([]));
    expect(screen.getByText('No loans')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a load failure without repeating what the server said', () => {
    const { container } = view(fail(500, 'SQLSTATE 23505 duplicate key value'));
    expect(screen.getByText('Could not load the loans')).toBeTruthy();
    expect(text(container)).not.toMatch(/SQLSTATE|duplicate key|23505/);
  });

  it('says when the role cannot read loans', () => {
    view(fail(403, 'forbidden'));
    expect(screen.getByText('You cannot view the loans')).toBeTruthy();
  });

  it('shows the lender’s own figures with Indian grouping and the time in India', () => {
    view(page([loanRow()]));
    const row = screen.getByRole('row', { name: /LN-SAMPLE-001/ });
    expect(within(row).getByRole('link', { name: 'LN-SAMPLE-001' }).getAttribute('href')).toBe(
      `/loans/${LOAN}`,
    );
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getAllByText('₹1,25,000.00')).toHaveLength(2);
    expect(within(row).getByText('As reported 16 Oct 2026, 15:45 IST')).toBeTruthy();
    expect(
      within(row).getByText('The newest report is within the threshold of 1,440 minutes'),
    ).toBeTruthy();
  });

  it('says a missing disbursement was not reported, never zero', () => {
    view(page([loanRow({ disbursedAmountMinor: null, disbursedAt: null })]));
    const row = screen.getByRole('row', { name: /LN-SAMPLE-001/ });
    expect(within(row).getByText('Not reported')).toBeTruthy();
    expect(within(row).queryByText('₹0.00')).toBeNull();
  });

  it('flags a loan with no report, a stale report, a conflict and a warning in words', () => {
    const sync = (over: object) => ({ ...loanRow().sync, ...over });
    view(
      page([
        loanRow({
          id: LOAN,
          lmsLoanRef: 'NO-REPORT',
          sync: sync({
            newestReportedAsOf: null,
            newestReceivedAt: null,
            newestReportedStatus: null,
            stale: true,
          }),
        }),
        loanRow({
          id: LOAN_2,
          lmsLoanRef: 'OLD-REPORT',
          sync: sync({ stale: true, hasOpenConflict: true, newestHasWarning: true }),
        }),
      ]),
    );
    const none = screen.getByRole('row', { name: /NO-REPORT/ });
    expect(within(none).getByText('No report received yet')).toBeTruthy();
    expect(within(none).getByText('Not reported')).toBeTruthy();
    const old = screen.getByRole('row', { name: /OLD-REPORT/ });
    expect(
      within(old).getByText(
        /Stale: the newest report is older than the threshold of 1,440 minutes/,
      ),
    ).toBeTruthy();
    expect(within(old).getByText('A conflict is waiting')).toBeTruthy();
    expect(within(old).getByText('A warning was flagged on the newest report')).toBeTruthy();
  });

  it('pages with an opaque cursor and offers a way back to the newest', () => {
    const { container } = view(page([loanRow()], 'abc_DEF-123'), {
      status: 'active',
      cursor: 'prev-1',
    });
    const older = screen.getByRole('link', { name: 'Older loans' });
    expect(older.getAttribute('href')).toBe('/loans?status=active&cursor=abc_DEF-123');
    expect(
      screen.getByRole('link', { name: 'Back to the newest loans' }).getAttribute('href'),
    ).toBe('/loans?status=active');
    expect(ops(container)).toEqual([]);
  });

  it('names the lender only when the person belongs to more than one', () => {
    const ctx: ServicingContext = {
      action: vi.fn(),
      returnTo: '/loans',
      grants: [
        ...grantsFor(['loan.read'], LENDER_A, 'Sample Finance Ltd'),
        ...grantsFor(['loan.read'], LENDER_B, 'Other Finance Ltd'),
      ],
    };
    view(page([loanRow({ lenderId: LENDER_B })]), {}, ctx);
    expect(screen.getByRole('columnheader', { name: 'Lender' })).toBeTruthy();
    expect(screen.getByText('Other Finance Ltd', { selector: 'td' })).toBeTruthy();
    expect(screen.getByLabelText('Lender')).toBeTruthy();
  });

  it('filters with a plain GET form that carries no operation', () => {
    const { container } = view(page([loanRow()]));
    const form = container.querySelector('form[method="get"]');
    expect(form?.getAttribute('action')).toBe('/loans');
    expect(screen.getByLabelText('Status as last reported')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Loan detail: figures as the lender reported them', () => {
  it('states whose figures these are and when', () => {
    render(detailPage());
    expect(
      screen.getByText(
        /As reported by Sample Finance Ltd on 16 Oct 2026, 15:45 IST \(received by Udofin on 16 Oct 2026, 15:50 IST\)/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Source: file import\./)).toBeTruthy();
  });

  it('shows every reported figure exactly', () => {
    render(detailPage());
    const table = screen.getByRole('table', { name: 'Figures exactly as reported' });
    const cell = (label: string) =>
      within(table).getByRole('row', { name: new RegExp(`^${label}`) });
    expect(within(cell('Outstanding principal')).getByText('₹1,00,000.50')).toBeTruthy();
    expect(within(cell('Overdue principal')).getByText('₹1,000.00')).toBeTruthy();
    expect(within(cell('Overdue interest')).getByText('₹250.50')).toBeTruthy();
    expect(within(cell('Penal charges')).getByText('₹50.00')).toBeTruthy();
    expect(within(cell('Total overdue')).getByText('₹1,300.50')).toBeTruthy();
    expect(within(cell('Next due date')).getByText('5 Nov 2026')).toBeTruthy();
    expect(within(cell('Next due amount')).getByText('₹12,500.00')).toBeTruthy();
    expect(within(cell('Days past due')).getByText('12')).toBeTruthy();
  });

  it('says a figure the lender did not report was not reported, and never shows zero for it', () => {
    render(
      detailPage({
        detail: ok(
          loanDetail({
            report: report({
              overduePrincipalMinor: null,
              overdueInterestMinor: null,
              penalChargesMinor: null,
              otherChargesMinor: null,
              totalOverdueMinor: null,
              nextDueOn: null,
              nextDueMinor: null,
              daysPastDue: null,
            }),
          }),
        ),
      }),
    );
    const table = screen.getByRole('table', { name: 'Figures exactly as reported' });
    expect(within(table).getAllByText('Not reported')).toHaveLength(8);
    expect(within(table).queryByText('₹0.00')).toBeNull();
    expect(within(table).queryByText('0')).toBeNull();
  });

  it('shows a total that does not match its parts as the lender reported it, flagged, never corrected', () => {
    const { container } = render(
      detailPage({
        detail: ok(
          loanDetail({
            report: report({ totalOverdueMinor: 999_999, flags: ['overdue_total_mismatch'] }),
          }),
        ),
      }),
    );
    expect(screen.getByText('₹9,999.99')).toBeTruthy();
    expect(
      screen.getByText(
        /do not add up to the overdue total reported\. Both are shown exactly as reported; nothing was corrected\./,
      ),
    ).toBeTruthy();
    // The sum of the parts (₹1,300.50) is not worked out anywhere on the screen.
    expect(text(container)).not.toContain('₹1,300.50');
  });

  it('shows a note it has no wording for in general words, not as the code', () => {
    const { container } = render(
      detailPage({
        detail: ok(loanDetail({ report: report({ flags: ['internal_review_flag'] }) })),
      }),
    );
    expect(screen.getByText('A note was recorded with this report.')).toBeTruthy();
    expect(text(container)).not.toContain('internal_review_flag');
  });

  it('says there is no report yet instead of showing empty figures', () => {
    const noReport = loanDetail({
      report: null,
      schedule: null,
      receipts: [],
      loan: loanRow({
        sync: {
          ...loanRow().sync,
          newestReportedAsOf: null,
          newestReceivedAt: null,
          newestReportedStatus: null,
          stale: true,
        },
      }),
    });
    const { container } = render(detailPage({ detail: ok(noReport) }));
    expect(
      screen.getAllByText('No report has been received for this loan yet.').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('No schedule has been received for this loan yet.')).toBeTruthy();
    expect(screen.getByText('No receipt has been reported for this loan yet.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Figures exactly as reported' })).toBeNull();
    expect(text(container)).not.toContain('₹0.00');
  });

  it('shows a plain banner when the figures are stale', () => {
    render(
      detailPage({
        detail: ok(loanDetail({ loan: loanRow({ sync: { ...loanRow().sync, stale: true } }) })),
      }),
    );
    const banner = screen.getByRole('status');
    expect(within(banner).getByText('These figures may be out of date')).toBeTruthy();
    expect(within(banner).getByText(/older than the threshold of 1,440 minutes/)).toBeTruthy();
    expect(
      within(banner).getByText(/What is shown is what your system last reported\./),
    ).toBeTruthy();
  });

  it('shows no stale banner for a report within the threshold', () => {
    render(detailPage());
    expect(screen.queryByText('These figures may be out of date')).toBeNull();
  });

  it('lists the schedule as reported without adding it up', () => {
    const detail = loanDetail();
    const bent = {
      ...detail,
      schedule: detail.schedule && {
        ...detail.schedule,
        installments: detail.schedule.installments.map((i, n) =>
          n === 0 ? { ...i, totalMinor: 1_250_001 } : i,
        ),
      },
    };
    render(detailPage({ detail: ok(bent) }));
    const table = screen.getByRole('table', { name: 'Instalments exactly as reported' });
    const first = within(table).getByRole('row', { name: /5 Sep 2026/ });
    expect(within(first).getByText('₹12,500.01')).toBeTruthy();
    expect(within(first).getByText('₹10,000.00')).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('lists receipts and reversals as reported and says it is not a statement', () => {
    render(detailPage());
    expect(screen.getByText(/This is not a statement of account\./)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Receipts and reversals as reported' });
    const reversal = within(table).getByRole('row', { name: /RC-SAMPLE-2/ });
    expect(within(reversal).getByText('Reversal')).toBeTruthy();
    expect(within(reversal).getByText('RC-SAMPLE-1')).toBeTruthy();
    expect(within(reversal).getByText('₹1.00')).toBeTruthy();
    const receipt = within(table)
      .getByRole('rowheader', { name: 'RC-SAMPLE-1' })
      .closest('tr') as HTMLElement;
    expect(within(receipt).getByText('upi')).toBeTruthy();
    expect(within(receipt).getByText('₹12,500.00')).toBeTruthy();
  });

  it('shows a load failure for the loan, and for each part, without the code', () => {
    const { container, rerender } = render(detailPage({ detail: fail(500, 'boom: stack trace') }));
    expect(screen.getByText('Could not load this loan')).toBeTruthy();
    expect(text(container)).not.toContain('boom');
    rerender(
      detailPage({
        documents: fail(500, 'x_y'),
        quotes: fail(403, 'forbidden'),
        requests: fail(500),
        conflicts: fail(500),
        anomalies: fail(500),
      }),
    );
    expect(screen.getByText('Could not load the documents')).toBeTruthy();
    expect(screen.getByText('You cannot view the quotations')).toBeTruthy();
    expect(screen.getByText('Could not load the document requests')).toBeTruthy();
    expect(screen.getByText('Could not load the conflicts')).toBeTruthy();
    expect(screen.getByText('Could not load the flags')).toBeTruthy();
  });

  it('shows the result of the last action as words', () => {
    const { rerender } = render(detailPage({ done: true }));
    expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/recorded/);
    rerender(detailPage({ error: 'lender_reference_reused' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'That reference was already used with a different file.',
    );
    rerender(detailPage({ error: 'some raw server message: relation "x" does not exist' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'The action could not be completed. Nothing was changed.',
    );
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Loan detail: conflicts and flags', () => {
  it('lists the conflicts and flags of the loan', () => {
    render(
      detailPage({
        conflicts: page([conflict()]),
        anomalies: page([anomaly()]),
      }),
    );
    expect(screen.getByText('Loan report: two reports differ')).toBeTruthy();
    expect(screen.getByText('Warning: The reported status moved backwards.')).toBeTruthy();
    expect(screen.getByText(/Held before: Closed, ₹5,000\.00\./)).toBeTruthy();
    expect(screen.getByText(/Newly reported: Active\./)).toBeTruthy();
    expect(screen.getByText(/Nothing was corrected/)).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Loan detail: documents, quotations and closure', () => {
  it('lists a document with a link that opens the stored file in a new tab', () => {
    render(
      detailPage({
        documents: ok({
          items: [
            document(),
            document({
              documentId: DOC_2,
              lenderReference: 'NOC/1',
              kind: 'noc',
              supersededById: DOC,
              periodFrom: null,
              periodTo: null,
            }),
          ],
        }),
      }),
    );
    const row = screen.getByRole('row', { name: /STMT\/SAMPLE\/001/ });
    const link = within(row).getByRole('link', { name: 'Open the PDF' });
    expect(link.getAttribute('href')).toBe(`/loans/${LOAN}/documents/${DOC}/file`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(within(row).getByText('Statement of account')).toBeTruthy();
    expect(within(row).getByText('1 Oct 2026, 10:00 IST')).toBeTruthy();
    expect(within(row).getByText('1 Apr 2026 to 30 Sep 2026')).toBeTruthy();
    expect(within(row).getByText('1,23,456 bytes')).toBeTruthy();
    expect(
      within(row)
        .getByText(`${SHA.slice(0, 16)}…`)
        .getAttribute('title'),
    ).toBe(SHA);
    const old = screen.getByRole('row', { name: /NOC\/1/ });
    expect(within(old).getByText('Replaced by a newer document')).toBeTruthy();
    expect(within(old).getByText('No-dues certificate (NOC)')).toBeTruthy();
  });

  it('says it does not write, sign or issue lender documents', () => {
    render(detailPage());
    expect(screen.getByText(/Udofin does not write, sign or issue statements/)).toBeTruthy();
    expect(screen.getByText('No document has been registered for this loan.')).toBeTruthy();
  });

  it('offers to register a document with every control labelled, answering only an open non-quotation request', () => {
    const { container } = render(
      detailPage({
        documents: ok({
          items: [
            document(),
            document({ documentId: DOC_2, lenderReference: 'OLD/1', supersededById: DOC }),
          ],
        }),
        requests: page([
          docRequest({ id: REQUEST, kind: 'noc' }),
          docRequest({ id: REQUEST_2, kind: 'foreclosure_quote' }),
        ]),
      }),
    );
    expect(ops(container)).toContain('servicing.document.register');
    const form = container
      .querySelector('input[value="servicing.document.register"]')
      ?.closest('form');
    expect(form?.getAttribute('enctype')).toBe('multipart/form-data');
    const file = within(form as HTMLElement).getByLabelText<HTMLInputElement>('The signed PDF');
    expect(file.type).toBe('file');
    expect(file.accept).toBe('application/pdf');
    expect(file.required).toBe(true);
    for (const label of [
      'What it is',
      'Your reference for this document',
      'Issued at (India time)',
      'Period from (optional)',
      'Period to (optional)',
      'Replaces an earlier document (optional)',
      "Answers a borrower's request (optional)",
    ]) {
      expect(within(form as HTMLElement).getByLabelText(label), label).toBeTruthy();
    }
    const replaces = within(form as HTMLElement).getByLabelText<HTMLSelectElement>(
      'Replaces an earlier document (optional)',
    );
    // Only a document that is not already replaced can be replaced.
    expect([...replaces.options].map((o) => o.value)).toEqual(['', DOC]);
    const answers = within(form as HTMLElement).getByLabelText<HTMLSelectElement>(
      "Answers a borrower's request (optional)",
    );
    expect([...answers.options].map((o) => o.value)).toEqual(['', REQUEST]);
    expect(form?.querySelector('input[name="loanId"]')?.getAttribute('value')).toBe(LOAN);
  });

  it('draws no write form for a role that can only read', () => {
    const { container } = render(
      detailPage({
        ctx: readOnly(`/loans/${LOAN}`),
        conflicts: page([
          conflict(),
          conflict({
            id: CONFLICT_2,
            status: 'acknowledged',
            acknowledgedAt: '2026-10-12T04:00:00.000000+00:00',
          }),
        ]),
        requests: page([docRequest()]),
        quotes: page([quote()]),
        detail: ok(loanDetail({ loan: loanRow({ status: 'closed' }) })),
      }),
    );
    expect(ops(container)).toEqual([]);
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(screen.getByText('Your role cannot register documents.')).toBeTruthy();
    expect(screen.getByText('Your role cannot record quotations.')).toBeTruthy();
    expect(screen.getByText('Your role cannot record security.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws no write form for a lender in which the person holds no such permission', () => {
    // The person may write in lender B only; this loan belongs to lender A.
    const ctx = contextFor(ALL_PERMISSIONS, `/loans/${LOAN}`, LENDER_B);
    const { container } = render(
      detailPage({
        ctx,
        requests: page([docRequest()]),
        conflicts: page([conflict()]),
        detail: ok(loanDetail({ loan: loanRow({ status: 'closed' }) })),
      }),
    );
    expect(ops(container)).toEqual([]);
  });

  it('draws only the forms for the permissions the person holds', () => {
    const closed = ok(loanDetail({ loan: loanRow({ status: 'closed' }) }));
    const open = { conflicts: page([conflict()]), requests: page([docRequest()]), detail: closed };
    const only = (permission: string) =>
      ops(
        render(
          detailPage({ ...open, ctx: contextFor(['loan.read', permission], `/loans/${LOAN}`) }),
        ).container,
      );
    expect(only('servicing.document.issue').sort()).toEqual([
      'servicing.closure.open',
      'servicing.document.register',
      'servicing.quote.record',
      'servicing.request.decline',
    ]);
    cleanup();
    expect(only('servicing.sync.manage')).toEqual(['servicing.conflict.acknowledge']);
    cleanup();
    expect(only('servicing.manual_entry')).toEqual([]);
  });

  it('shows a quotation as the lender stated it, with its validity as a date and time and no timer', () => {
    const { container } = render(detailPage({ quotes: page([quote()]) }));
    expect(screen.getByText('Quotation FQ-SAMPLE-1')).toBeTruthy();
    expect(
      screen.getByText(
        /As quoted by your organisation as of 15 Oct 2026, 10:30 IST\. Valid until 22 Oct 2026, 23:59 IST\./,
      ),
    ).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Figures exactly as quoted' });
    expect(
      within(within(table).getByRole('row', { name: /^Principal/ })).getByText('₹90,000.00'),
    ).toBeTruthy();
    expect(
      within(within(table).getByRole('row', { name: /^Prepayment charge/ })).getByText('₹2,700.00'),
    ).toBeTruthy();
    expect(
      within(within(table).getByRole('row', { name: /^Total/ })).getByText('₹93,950.00'),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(text(container)).not.toMatch(
      /countdown|expires in|time left|remaining|hours left|minutes left/i,
    );
  });

  it('flags a quotation whose parts do not add up, shows the lender’s total unchanged, and says it must not be paid', () => {
    const { container } = render(
      detailPage({ quotes: page([quote({ totalMinor: 100, totalMismatch: true })]) }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(
      /Flagged: the parts do not add up to the total your organisation stated\./,
    );
    expect(alert.textContent).toMatch(/has not been corrected\. It must not be paid\./);
    expect(
      within(screen.getByRole('table', { name: 'Figures exactly as quoted' })).getByText('₹1.00'),
    ).toBeTruthy();
    // The sum of the parts (₹93,950.00) is nowhere on the screen as a total.
    expect(
      within(screen.getByRole('table', { name: 'Figures exactly as quoted' })).queryByText(
        '₹93,950.00',
      ),
    ).toBeNull();
    expect(text(container)).not.toContain('₹93,950.00');
  });

  it('links the letter of a quotation to the stored file', () => {
    render(detailPage({ quotes: page([quote({ letterDocumentId: DOC })]) }));
    expect(
      screen.getByRole('link', { name: 'Open the quotation letter' }).getAttribute('href'),
    ).toBe(`/loans/${LOAN}/documents/${DOC}/file`);
  });

  it('offers to record a quotation with labelled controls and rupee amounts', () => {
    const { container } = render(
      detailPage({
        documents: ok({
          items: [
            document({ documentId: DOC, kind: 'foreclosure_quote', lenderReference: 'FQL/1' }),
            document({ documentId: DOC_2, kind: 'statement' }),
          ],
        }),
        requests: page([
          docRequest({ id: REQUEST, kind: 'noc' }),
          docRequest({ id: REQUEST_2, kind: 'foreclosure_quote' }),
        ]),
      }),
    );
    const form = container
      .querySelector('input[value="servicing.quote.record"]')
      ?.closest('form') as HTMLElement;
    for (const label of [
      'Your reference for this quotation',
      'As of (India time, not in the future)',
      'Valid until (India time)',
      'Principal (rupees)',
      'Interest (rupees)',
      'Charges (rupees)',
      'Prepayment charge (rupees)',
      'Total as you state it (rupees)',
    ]) {
      expect(within(form).getByLabelText(label), label).toBeTruthy();
    }
    const letters = within(form).getByLabelText<HTMLSelectElement>(
      'Quotation letter you registered (optional)',
    );
    expect([...letters.options].map((o) => o.value)).toEqual(['', DOC]);
    const requests = within(form).getByLabelText<HTMLSelectElement>(
      "Answers a borrower's request (optional)",
    );
    expect([...requests.options].map((o) => o.value)).toEqual(['', REQUEST_2]);
    expect(
      within(form).getAllByText('Digits with up to two decimals, for example 12500.50.'),
    ).toHaveLength(5);
  });

  it('offers to record security only for a loan reported closed or foreclosed, with nothing pre-ticked', () => {
    const { container, rerender } = render(detailPage());
    expect(ops(container)).not.toContain('servicing.closure.open');
    expect(
      screen.getByText(
        /Closure records appear once your system reports this loan closed or foreclosed\./,
      ),
    ).toBeTruthy();
    rerender(detailPage({ detail: ok(loanDetail({ loan: loanRow({ status: 'foreclosed' }) })) }));
    expect(ops(container)).toContain('servicing.closure.open');
    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes).toHaveLength(5);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(boxes.every((b) => b.name === 'collateralTypes')).toBe(true);
    expect(screen.getByLabelText('Lien on mutual fund units')).toBeTruthy();
    expect(screen.getByText(/Udofin holds no collateral/)).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Document requests', () => {
  const view = (
    pageResult: Parameters<typeof DocumentRequestsPage>[0]['page'],
    query = { status: 'requested' },
    ctx = full('/loans/requests?status=requested'),
  ) => render(<DocumentRequestsPage page={pageResult} query={query} ctx={ctx} />);

  it('opens on the requests that wait for an answer, without naming the borrower', () => {
    const { container } = view(
      page([
        docRequest(),
        docRequest({
          id: REQUEST_2,
          kind: 'statement',
          periodFrom: '2026-04-01',
          periodTo: '2026-09-30',
        }),
      ]),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Status').value).toBe('requested');
    expect(screen.getByText('No-dues certificate (NOC)')).toBeTruthy();
    expect(screen.getByText('1 Apr 2026 to 30 Sep 2026')).toBeTruthy();
    expect(
      screen.getAllByText('Open: waiting for your organisation', { selector: 'dd' }),
    ).toHaveLength(2);
    expect(
      screen
        .getAllByRole('link', { name: 'Open the loan to answer this request' })[0]
        ?.getAttribute('href'),
    ).toBe(`/loans/${LOAN}#documents`);
    expect(text(container)).toContain('The borrower is not named here.');
  });

  it('labels the default target as Udofin’s, not a regulatory deadline, and says when none is set', () => {
    view(
      page([
        docRequest({ dueBy: null }),
        docRequest({ id: REQUEST_2, dueBy: '2026-10-21T08:00:00.000000+00:00' }),
      ]),
    );
    expect(screen.getAllByText('Udofin’s default target (not a regulatory deadline)')).toHaveLength(
      2,
    );
    expect(screen.getByText('None set')).toBeTruthy();
    expect(screen.getByText('21 Oct 2026, 13:30 IST')).toBeTruthy();
  });

  it('sends a quotation request to the quotation form and declines with a note the borrower can read', () => {
    const { container } = view(page([docRequest({ kind: 'foreclosure_quote' })]));
    expect(
      screen
        .getByRole('link', { name: 'Open the loan to answer this request' })
        .getAttribute('href'),
    ).toBe(`/loans/${LOAN}#quotes`);
    expect(ops(container)).toEqual(['servicing.request.decline']);
    expect(
      screen.getByLabelText(
        /Why \(10 to 500 characters; the borrower can read this; no personal details\)/,
      ),
    ).toBeTruthy();
  });

  it('shows a decided request with the lender’s note and no decline form', () => {
    const { container } = view(
      page([
        docRequest({
          status: 'declined',
          lenderNote: 'The loan is not closed yet',
          decidedAt: '2026-10-15T08:00:00.000000+00:00',
        }),
      ]),
    );
    expect(screen.getByText('Declined', { selector: 'dd' })).toBeTruthy();
    expect(screen.getByText('The loan is not closed yet')).toBeTruthy();
    expect(ops(container)).toEqual([]);
  });

  it('links the document that answered a fulfilled request', () => {
    view(page([docRequest({ status: 'fulfilled', fulfilledDocumentId: DOC })]));
    expect(
      screen.getByRole('link', { name: 'Open the document that answered it' }).getAttribute('href'),
    ).toBe(`/loans/${LOAN}/documents/${DOC}/file`);
  });

  it('shows no decline form to a role without the permission', () => {
    const { container } = view(page([docRequest()]), { status: 'requested' }, readOnly());
    expect(ops(container)).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Decline this request' })).toBeNull();
  });

  it('is empty, failing or forbidden in plain words', () => {
    view(page([]));
    expect(screen.getByText('No requests')).toBeTruthy();
    cleanup();
    view(fail(500, 'raw'));
    expect(screen.getByText('Could not load the requests')).toBeTruthy();
    cleanup();
    view(fail(403, 'forbidden'));
    expect(screen.getByText('You cannot view the requests')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Closures and security release', () => {
  const view = (
    pageResult: Parameters<typeof ClosuresPage>[0]['page'],
    ctx = full('/loans/closures'),
  ) => render(<ClosuresPage page={pageResult} query={{}} ctx={ctx} />);

  it('shows the closure, the no-dues status and each release task as the lender recorded them', () => {
    view(page([closure()]));
    expect(screen.getByText('Closed loan, Sample Finance Ltd')).toBeTruthy();
    expect(
      screen.getByText(
        /10 Oct 2026, 10:30 IST \(when your report was recorded, not your closure date\)/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Not registered yet')).toBeTruthy();
    const open = screen.getByRole('region', { name: 'Release of Lien on mutual fund units' });
    expect(within(open).getByText('Open: not yet confirmed by your organisation')).toBeTruthy();
    expect(within(open).getByText('9 Nov 2026, 10:30 IST')).toBeTruthy();
    const done = screen.getByRole('region', { name: 'Release of Pledge of demat holdings' });
    expect(
      within(done).getByText('Confirmed by your organisation', { selector: 'dd' }),
    ).toBeTruthy();
    expect(
      within(done).getByText(/12 Oct 2026, 10:30 IST, your reference REL\/SAMPLE\/7/),
    ).toBeTruthy();
    expect(within(done).queryByRole('button')).toBeNull();
  });

  it('labels default dates as Udofin’s, not a regulatory deadline, and shows a dash when none is set', () => {
    view(page([closure()]));
    expect(
      screen.getAllByText('Udofin’s default target (not a regulatory deadline)').length,
    ).toBeGreaterThanOrEqual(2);
    // The no-dues certificate and the confirmed task have no default date; the open task has one.
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('9 Nov 2026, 10:30 IST')).toBeTruthy();
  });

  it('links the no-dues certificate once it is registered', () => {
    view(page([closure({ nocDocumentId: DOC, nocIssuedAt: '2026-10-11T05:00:00.000000+00:00' })]));
    expect(screen.getByRole('link', { name: 'Open the PDF' }).getAttribute('href')).toBe(
      `/loans/${LOAN}/documents/${DOC}/file`,
    );
  });

  it('offers to confirm a release or record a delay only for an open task, and says Udofin never confirms', () => {
    const { container } = view(page([closure()]));
    expect(ops(container).sort()).toEqual(['servicing.closure.confirm', 'servicing.closure.delay']);
    expect(
      screen.getAllByText(/Udofin holds no collateral and never confirms a release\./).length,
    ).toBeGreaterThan(0);
    expect(container.querySelector('input[name="taskId"]')?.getAttribute('value')).toBe(TASK);
    expect(screen.getByLabelText('Your confirmation reference')).toBeTruthy();
  });

  it('shows no confirm or delay form to a role without the permission', () => {
    const { container } = view(page([closure()]), readOnly('/loans/closures'));
    expect(ops(container)).toEqual([]);
    expect(screen.getByText('Your role cannot confirm a release.')).toBeTruthy();
  });

  it('says no security has been recorded when there are no tasks', () => {
    view(page([closure({ tasks: [] })]));
    expect(screen.getByText('No security has been recorded for this loan.')).toBeTruthy();
  });

  it('is empty, failing or forbidden in plain words', () => {
    view(page([]));
    expect(screen.getByText('No closures')).toBeTruthy();
    cleanup();
    view(fail(500));
    expect(screen.getByText('Could not load the closures')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Imports and sync', () => {
  const stageAction = vi.fn((_previous: StageState, _form: FormData) =>
    Promise.resolve<StageState>({ status: 'idle' }),
  );
  const view = (
    over: Partial<Parameters<typeof SyncPage>[0]> = {},
    ctx: ServicingContext = full('/imports'),
  ) =>
    render(
      <SyncPage
        status={ok({ items: [syncItem()] })}
        imports={page([batch()])}
        corrections={[]}
        query={{}}
        ctx={ctx}
        stageAction={stageAction}
        {...over}
      />,
    );

  it('shows the connection as recorded and the counts as the API gives them', () => {
    view();
    const card = screen.getByRole('region', { name: 'Sync status for Sample Finance Ltd' });
    expect(within(card).getByText('File import', { selector: 'dd' })).toBeTruthy();
    expect(within(card).getByText('Active', { selector: 'dd' })).toBeTruthy();
    expect(within(card).getByText('1,440 minutes')).toBeTruthy();
    expect(within(card).getByText('16 Oct 2026, 15:00 IST')).toBeTruthy();
    expect(within(card).getByText('Receipts, Repayment schedules')).toBeTruthy();
    expect(within(card).getByText('120')).toBeTruthy();
    expect(within(card).getByText('Loans with no report yet').nextSibling?.textContent).toBe('3');
    expect(
      within(card).getByText('Loans with no report or an old report (stale)').nextSibling
        ?.textContent,
    ).toBe('7');
    expect(within(card).getByText('As reported on 16 Oct 2026, 14:30 IST')).toBeTruthy();
  });

  it('says when there is no connection, so no file can be uploaded yet', () => {
    view({
      status: ok({
        items: [
          syncItem({
            connection: null,
            newestReportedAsOf: null,
            loans: { total: 0, neverReported: 0, stale: 0, withOpenConflict: 0, withWarning: 0 },
          }),
        ],
      }),
    });
    expect(
      screen.getByText(
        /No connection has been set up for this lender, so no file can be uploaded yet\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText('None yet', { selector: 'dd' })).toBeTruthy();
  });

  it('labels a mock connection as for testing only', () => {
    const item = syncItem();
    view({
      status: ok({
        items: [
          {
            ...item,
            connection: item.connection && {
              ...item.connection,
              kind: 'mock',
              providerMode: 'mock',
            },
          },
        ],
      }),
    });
    expect(screen.getByText('Mock connection (for testing only)')).toBeTruthy();
    expect(screen.getByText('Mock mode: for testing only, never for real data')).toBeTruthy();
  });

  it('states that the lender system is the system of record and that files are all or nothing', () => {
    view();
    expect(screen.getByText(/Your lender system is the system of record\./)).toBeTruthy();
    expect(
      screen.getAllByText(/nothing is applied unless every row is valid/i).length,
    ).toBeGreaterThan(0);
  });

  it('pre-fills the connection form with what is recorded and ticks only the declared capabilities', () => {
    const { container } = view();
    const form = container
      .querySelector('input[value="servicing.connection.set"]')
      ?.closest('form') as HTMLElement;
    expect(within(form).getByLabelText<HTMLSelectElement>('How reports reach Udofin').value).toBe(
      'file_import',
    );
    expect(within(form).getByLabelText<HTMLSelectElement>('Connection status').value).toBe(
      'active',
    );
    expect(
      within(form).getByLabelText<HTMLInputElement>(/A report is stale after this many minutes/)
        .value,
    ).toBe('1440');
    const ticked = within(form)
      .getAllByRole<HTMLInputElement>('checkbox')
      .filter((c) => c.checked)
      .map((c) => c.name);
    expect(ticked.sort()).toEqual(['cap_receipts', 'cap_schedule']);
    // A connector with no specification cannot be chosen here.
    const kinds = [
      ...within(form).getByLabelText<HTMLSelectElement>('How reports reach Udofin').options,
    ].map((o) => o.value);
    expect(kinds).toEqual(['file_import', 'manual']);
  });

  it('ticks nothing and starts as a draft when there is no connection yet', () => {
    const { container } = view({ status: ok({ items: [syncItem({ connection: null })] }) });
    const form = container
      .querySelector('input[value="servicing.connection.set"]')
      ?.closest('form') as HTMLElement;
    expect(within(form).getByLabelText<HTMLSelectElement>('Connection status').value).toBe('draft');
    expect(
      within(form)
        .getAllByRole<HTMLInputElement>('checkbox')
        .every((c) => !c.checked),
    ).toBe(true);
  });

  it('hides the connection form from a role that may not manage the sync', () => {
    const { container } = view({}, contextFor(['loan.read', 'servicing.manual_entry'], '/imports'));
    expect(ops(container)).not.toContain('servicing.connection.set');
    expect(screen.getByText('Your role cannot change this connection.')).toBeTruthy();
  });

  it('hides the upload from a role that may not upload, and says so', () => {
    view({}, contextFor(['loan.read', 'servicing.sync.manage'], '/imports'));
    expect(screen.getByText(/your role does not include uploading files/)).toBeTruthy();
    expect(screen.queryByLabelText('File (UTF-8 text)')).toBeNull();
  });

  it('shows the upload to a role that may, with the size cap and what the file may contain', () => {
    view();
    expect(screen.getByLabelText('File (UTF-8 text)')).toBeTruthy();
    expect(screen.getByText(/At most 5 MiB and 10,000 records in one file/)).toBeTruthy();
    expect(
      screen.getByText(/never a name, phone number, PAN, Aadhaar or account number/),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing is applied by uploading\./)).toBeTruthy();
  });

  it('lists the files received with their status in words and a link to each result', () => {
    view({
      imports: page([
        batch(),
        batch({
          id: '0190a000-0000-7000-8000-000000000699',
          status: 'invalid',
          kind: 'receipt',
          rowCount: 1200,
        }),
      ]),
    });
    const table = screen.getByRole('table', { name: 'Files received, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByText('Preview ready: nothing has been applied yet'),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByText('Not importable: nothing was applied'),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('1,200')).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: 'Open the result' })
        .getAttribute('href'),
    ).toBe(`/imports/${BATCH}`);
  });

  it('offers only earlier invalid, discarded or failed files as something to correct, preselecting the one chosen', () => {
    const invalid = batch({ id: '0190a000-0000-7000-8000-000000000611', status: 'invalid' });
    const ok1 = batch({ id: '0190a000-0000-7000-8000-000000000612', status: 'committed' });
    view({
      corrections: [
        invalid,
        ok1,
        batch({ id: '0190a000-0000-7000-8000-000000000613', status: 'previewed' }),
      ],
      correctionOf: invalid.id,
    });
    const select = screen.getByLabelText<HTMLSelectElement>(
      'This file corrects an earlier file (optional)',
    );
    expect([...select.options].map((o) => o.value)).toEqual(['', invalid.id]);
    expect(select.value).toBe(invalid.id);
  });

  it('is failing or empty in plain words', () => {
    view({ status: fail(500, 'raw'), imports: fail(403, 'forbidden') });
    expect(screen.getByText('Could not load the sync status')).toBeTruthy();
    expect(screen.getByText('You cannot view the files received')).toBeTruthy();
    cleanup();
    view({ status: ok({ items: [] }), imports: page([]) });
    expect(screen.getByText('No sync status yet')).toBeTruthy();
    expect(screen.getByText('No files yet')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Import result', () => {
  const rowErrors = [
    { rowNo: 0, outcome: 'error' as const, errorCodes: ['missing_column'], fieldNames: ['status'] },
    {
      rowNo: 3,
      outcome: 'error' as const,
      errorCodes: ['invalid_amount', 'amount_not_positive'],
      fieldNames: ['sanctioned_amount'],
    },
    { rowNo: 12, outcome: 'quarantined' as const, errorCodes: ['unknown_loan'], fieldNames: [] },
  ];
  const detail = (
    status: string,
    over: object = {},
    errors = [] as typeof rowErrors,
    truncated = false,
  ) => ok({ batch: batch({ status, ...over }), errors, errorsTruncated: truncated });
  const view = (
    result: Parameters<typeof ImportDetailPage>[0]['detail'],
    ctx = full(`/imports/${BATCH}`),
    extra: object = {},
  ) => render(<ImportDetailPage detail={result} ctx={ctx} {...extra} />);

  it('shows a preview with its counts, and offers apply and discard as two separate forms', () => {
    const { container } = view(detail('previewed'));
    expect(
      screen.getByRole('heading', { name: 'Preview ready: nothing has been applied yet' }),
    ).toBeTruthy();
    const counts = screen.getByRole('table', { name: 'Records by result' });
    expect(
      within(within(counts).getByRole('row', { name: /^New records/ })).getByText('8'),
    ).toBeTruthy();
    expect(
      within(within(counts).getByRole('row', { name: /^Rows with errors/ })).getByText('0'),
    ).toBeTruthy();
    expect(text(container)).toContain('Nothing is applied unless every row is valid.');
    expect(ops(container).sort()).toEqual(['servicing.import.commit', 'servicing.import.reject']);
    const commit = container
      .querySelector('input[value="servicing.import.commit"]')
      ?.closest('form') as HTMLElement;
    const reject = container
      .querySelector('input[value="servicing.import.reject"]')
      ?.closest('form') as HTMLElement;
    expect(commit).not.toBe(reject);
    expect(within(commit).getByRole('button', { name: 'Apply this file' })).toBeTruthy();
    expect(within(reject).getByRole('button', { name: 'Discard this file' })).toBeTruthy();
    expect(within(commit).queryByRole('button', { name: 'Discard this file' })).toBeNull();
  });

  it('does not tick the review box for the person, and names the batch in both forms', () => {
    const { container } = view(detail('previewed'));
    const box = screen.getByLabelText<HTMLInputElement>(
      'I have reviewed this preview and want to apply it',
    );
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect(box.name).toBe('reviewed');
    for (const form of container.querySelectorAll('form')) {
      expect(form.querySelector('input[name="id"]')?.getAttribute('value')).toBe(BATCH);
    }
  });

  it('asks for a reason to discard a file, in a labelled box', () => {
    view(detail('previewed'));
    expect(
      screen.getByLabelText(
        /Why you are discarding it \(10 to 1,000 characters, no personal details\)/,
      ),
    ).toBeTruthy();
  });

  it('lets a role that only uploads discard but not apply', () => {
    const { container } = view(
      detail('previewed'),
      contextFor(['loan.read', 'servicing.manual_entry'], `/imports/${BATCH}`),
    );
    expect(ops(container)).toEqual(['servicing.import.reject']);
    expect(screen.getByText('Your role cannot apply a file.')).toBeTruthy();
  });

  it('lets a role that only manages the sync apply and discard', () => {
    const { container } = view(
      detail('previewed'),
      contextFor(['loan.read', 'servicing.sync.manage'], `/imports/${BATCH}`),
    );
    expect(ops(container).sort()).toEqual(['servicing.import.commit', 'servicing.import.reject']);
  });

  it('shows neither apply nor discard to a read-only role', () => {
    const { container } = view(detail('previewed'), readOnly(`/imports/${BATCH}`));
    expect(ops(container)).toEqual([]);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Your role cannot apply a file.')).toBeTruthy();
    expect(screen.getByText('Your role cannot discard a file.')).toBeTruthy();
  });

  it('shows neither apply nor discard to a person with no rights in this lender', () => {
    const { container } = view(
      detail('previewed'),
      contextFor(ALL_PERMISSIONS, `/imports/${BATCH}`, LENDER_B),
    );
    expect(ops(container)).toEqual([]);
  });

  it('lists the rows at fault by row number, kind of problem and column, with no values', () => {
    const { container } = view(
      detail(
        'invalid',
        { counts: { ...batch().counts, error: 2, quarantined: 1, new: 0 } },
        rowErrors,
      ),
    );
    const table = screen.getByRole('table', { name: 'Problems found, by row' });
    // A stored batch numbers its problems by record position, and the page says so (the lines of the file are not known then).
    expect(within(table).getByRole('columnheader', { name: 'Record' })).toBeTruthy();
    expect(
      screen.getByText(/count the records of the file in the order they were stored/),
    ).toBeTruthy();
    const whole = within(table).getByRole('row', { name: /Whole file/ });
    expect(within(whole).getByText('A required column is missing.')).toBeTruthy();
    expect(within(whole).getByText('status')).toBeTruthy();
    const row3 = within(table).getByRole('row', { name: /^3 / });
    expect(
      within(row3).getByText('An amount is not plain rupees with at most two decimals.'),
    ).toBeTruthy();
    expect(within(row3).getByText('An amount must be more than zero.')).toBeTruthy();
    expect(within(row3).getByText('sanctioned_amount')).toBeTruthy();
    const held = within(table).getByRole('row', { name: /^12 / });
    expect(within(held).getByText('Held aside')).toBeTruthy();
    expect(within(held).getByText('—')).toBeTruthy();
    // The error classes are words, never the stored code.
    expect(text(container)).not.toMatch(
      /invalid_amount|missing_column|amount_not_positive|unknown_loan/,
    );
  });

  it('offers no apply for a file that is not importable, only a way to upload a corrected one', () => {
    const { container } = view(detail('invalid', {}, rowErrors));
    expect(
      screen.getByRole('heading', { name: 'Not importable: nothing was applied' }),
    ).toBeTruthy();
    expect(ops(container)).toEqual([]);
    expect(screen.getByRole('link', { name: 'Upload a corrected file' }).getAttribute('href')).toBe(
      `/imports?correct=${BATCH}#upload`,
    );
  });

  it('says only the first 1,000 problem rows are listed when the API says the list was cut', () => {
    view(detail('invalid', {}, rowErrors, true));
    expect(screen.getByText(/Only the first 1,000 problem rows are listed\./)).toBeTruthy();
  });

  it.each([
    ['uploaded', 'Received (preview not ready)'],
    ['committed', 'Applied'],
    ['rejected', 'Discarded: nothing was applied'],
    ['failed', 'Applying failed and was rolled back: nothing was applied'],
  ])('says in words that a %s file is: %s', (status, words) => {
    const { container } = view(detail(status));
    expect(screen.getByRole('heading', { name: words })).toBeTruthy();
    // Only a previewed file can be applied or discarded.
    expect(ops(container)).toEqual([]);
  });

  it('shows when an applied file was applied and what applying did, in words', () => {
    view(
      detail('committed', {
        committedAt: '2026-10-16T09:30:00.000000+00:00',
        appliedCounts: { new: 8, changed: 1, ignored_older: 1, mystery: 2 },
      }),
    );
    expect(screen.getByText('16 Oct 2026, 15:00 IST', { selector: 'dd' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'What applying did' });
    expect(
      within(within(table).getByRole('row', { name: /^New records/ })).getByText('8'),
    ).toBeTruthy();
    expect(
      within(within(table).getByRole('row', { name: /^Older than a report/ })).getByText('1'),
    ).toBeTruthy();
    expect(within(table).getByRole('row', { name: /^Another outcome/ })).toBeTruthy();
    expect(text(table)).not.toContain('mystery');
  });

  it('never shows the SQLSTATE class of a failed apply', () => {
    const { container } = view(
      detail('failed', { failedAt: '2026-10-16T09:31:00.000000+00:00', failureClass: '40P01' }),
    );
    expect(text(container)).not.toContain('40P01');
    expect(screen.getByText('Applying failed')).toBeTruthy();
  });

  it('says when the file was already received before', () => {
    view(detail('previewed'), full(`/imports/${BATCH}`), { existing: true });
    expect(screen.getByText(/This exact file was already received earlier/)).toBeTruthy();
  });

  it('shows the file’s fingerprint and size but no file name', () => {
    const { container } = view(detail('previewed'));
    expect(screen.getByText(`${SHA.slice(0, 16)}…`)).toBeTruthy();
    expect(screen.getByText('23,45,678 bytes')).toBeTruthy();
    expect(text(container)).not.toMatch(/\.csv|\.json/);
  });

  it('fails in plain words', () => {
    view(fail(500, 'raw failure text'));
    expect(screen.getByText('Could not load this import')).toBeTruthy();
    cleanup();
    view(fail(403, 'forbidden'));
    expect(screen.getByText('You cannot view this import')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('The upload form', () => {
  const refusal: StageState = {
    status: 'refused',
    fileSha256: SHA,
    byteSize: 400,
    recordCount: 0,
    errors: [
      {
        rowNo: 0,
        outcome: 'error',
        errorCodes: ['unknown_column'],
        fieldNames: ['mystery_column'],
      },
    ],
    errorsTruncated: false,
  };
  const csv = () => new File(['lms_loan_ref\nLN-1\n'], 'whatever.csv', { type: 'text/csv' });
  const lenders = [{ id: LENDER_A, name: 'Sample Finance Ltd' }];
  /** Chooses the file and sends the form. jsdom does not count a file chosen by user-event as the input's value, so its own required-field check is skipped here. */
  const submitFile = async (user: ReturnType<typeof userEvent.setup>) => {
    const input = screen.getByLabelText('File (UTF-8 text)');
    await user.upload(input, csv());
    (input.closest('form') as HTMLFormElement).noValidate = true;
    await user.click(screen.getByRole('button', { name: 'Check the file and show a preview' }));
  };

  it('shows the size cap, labels every control and starts with nothing chosen for the person', () => {
    const { container } = render(
      <ImportStageForm action={vi.fn()} lenders={lenders} corrections={[]} />,
    );
    expect(screen.getByText(/At most 5 MiB and 10,000 records/)).toBeTruthy();
    expect(screen.getByLabelText('What the file contains')).toBeTruthy();
    expect(screen.getByLabelText('File format')).toBeTruthy();
    const file = screen.getByLabelText<HTMLInputElement>('File (UTF-8 text)');
    expect(file.required).toBe(true);
    expect(container.querySelector('input[name="lenderId"]')?.getAttribute('value')).toBe(LENDER_A);
    expect(screen.queryByLabelText('This file corrects an earlier file (optional)')).toBeNull();
  });

  it('asks which lender when the person belongs to several', () => {
    render(
      <ImportStageForm
        action={vi.fn()}
        lenders={[...lenders, { id: LENDER_B, name: 'Other Finance Ltd' }]}
        corrections={[]}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Lender');
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.value)).toEqual(['', LENDER_A, LENDER_B]);
  });

  it('sends the chosen file with a fresh request key each time, and a different key on a second try', async () => {
    const seen: FormData[] = [];
    const action = vi.fn((_previous: StageState, form: FormData) => {
      seen.push(form);
      return Promise.resolve<StageState>({ status: 'error', code: 'import_has_errors' });
    });
    const user = userEvent.setup();
    render(<ImportStageForm action={action} lenders={lenders} corrections={[]} />);
    await submitFile(user);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await screen.findByRole('alert');
    await submitFile(user);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    const keys = seen.map((f) => f.get('key'));
    expect(keys[0]).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(seen[0]?.get('lenderId')).toBe(LENDER_A);
    expect(seen[0]?.get('kind')).toBe('loan');
    expect(seen[0]?.get('fileFormat')).toBe('csv');
  });

  it('shows the problems of a refused file at once, without values, and says nothing was applied', async () => {
    const action = vi.fn(() => Promise.resolve<StageState>(refusal));
    const user = userEvent.setup();
    const { container } = render(
      <ImportStageForm action={action} lenders={lenders} corrections={[]} />,
    );
    await submitFile(user);
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('The file was not accepted and nothing was applied'),
    ).toBeTruthy();
    expect(
      within(alert).getByText('The file has a column the format does not define.'),
    ).toBeTruthy();
    // A column name the format does not define is not echoed back.
    expect(text(container)).not.toContain('mystery_column');
    expect(within(alert).getByText('a column the format does not define')).toBeTruthy();
    expect(within(alert).getByText('Whole file')).toBeTruthy();
    expect(text(alert)).toContain('400 bytes');
  });

  it('shows an error as a sentence and never the text the server sent', async () => {
    const action = vi.fn(() =>
      Promise.resolve<StageState>({ status: 'error', code: 'connection_not_active' }),
    );
    const user = userEvent.setup();
    render(<ImportStageForm action={action} lenders={lenders} corrections={[]} />);
    await submitFile(user);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'There is no active connection that allows this upload. Set the connection up first.',
    );
  });

  it('says the file is being checked while it waits, and cannot be sent twice meanwhile', async () => {
    let finish: (state: StageState) => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<StageState>((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<ImportStageForm action={action} lenders={lenders} corrections={[]} />);
    await submitFile(user);
    const waiting = await screen.findByRole('button', { name: 'Checking the file…' });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    finish({ status: 'idle' });
    await screen.findByRole('button', { name: 'Check the file and show a preview' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('offers the earlier file to correct, preselected when it was chosen on arrival', () => {
    render(
      <ImportStageForm
        action={vi.fn()}
        lenders={lenders}
        corrections={[{ id: BATCH, label: 'Loan reports, 10 records' }]}
        correctionOf={BATCH}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>(
      'This file corrects an earlier file (optional)',
    );
    expect(select.value).toBe(BATCH);
    expect(within(select).getByRole('option', { name: 'No, this is a new file' })).toBeTruthy();
  });

  it('shows a refused file the same way on its own', () => {
    render(<RefusedFile state={{ ...refusal, errorsTruncated: true }} />);
    expect(screen.getByText(/Only the first 1,000 problem rows are listed\./)).toBeTruthy();
    expect(screen.getByText('Correct the file and choose it again.')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Conflicts', () => {
  const view = (
    pageResult: Parameters<typeof ConflictsPage>[0]['page'],
    ctx = full('/imports/conflicts'),
    query = {},
  ) => render(<ConflictsPage page={pageResult} query={query} ctx={ctx} />);
  const acknowledged = conflict({
    status: 'acknowledged',
    acknowledgedAt: '2026-10-12T04:00:00.000000+00:00',
  });

  it('shows an open conflict with both times and only the acknowledge step', () => {
    const { container } = view(page([conflict()]));
    expect(screen.getByText('Loan report: two reports differ')).toBeTruthy();
    expect(
      screen.getByText('The same record was reported twice with different content.'),
    ).toBeTruthy();
    expect(screen.getByText('Open: waiting to be acknowledged', { selector: 'dd' })).toBeTruthy();
    expect(screen.getByText('SRC-SAMPLE-9')).toBeTruthy();
    expect(screen.getAllByText('As reported 10 Oct 2026, 09:30 IST')).toHaveLength(2);
    expect(ops(container)).toEqual(['servicing.conflict.acknowledge']);
    expect(screen.getByRole('link', { name: 'Open the loan' }).getAttribute('href')).toBe(
      `/loans/${LOAN}`,
    );
    expect(text(container)).toContain('changes neither');
  });

  it('offers the resolve step only after acknowledgement, with labelled controls and nothing preselected', () => {
    const { container } = view(page([acknowledged]));
    expect(ops(container)).toEqual(['servicing.conflict.resolve']);
    const version = screen.getByLabelText<HTMLSelectElement>(
      'Which report does your organisation confirm?',
    );
    expect(version.value).toBe('');
    expect(version.required).toBe(true);
    expect([...version.options].map((o) => o.value)).toEqual(['', 'existing', 'incoming']);
    expect(
      screen.getByLabelText(/Why \(10 to 1,000 characters, no personal details\)/),
    ).toBeTruthy();
    for (const slot of [1, 2, 3]) {
      expect(screen.getByLabelText(`Reference ${String(slot)}: kind`)).toBeTruthy();
      expect(screen.getByLabelText(`Reference ${String(slot)}: the reference itself`)).toBeTruthy();
    }
    expect(
      screen.getByText(/Neither report is changed, applied, hidden or deleted\./),
    ).toBeTruthy();
  });

  it('shows a resolved conflict with the version the lender confirmed and its note', () => {
    const { container } = view(
      page([
        conflict({
          status: 'resolved',
          acknowledgedAt: '2026-10-12T04:00:00.000000+00:00',
          resolvedAt: '2026-10-13T04:00:00.000000+00:00',
          confirmedVersion: 'incoming',
          resolutionNote: 'Checked against the lender system screen',
        }),
      ]),
    );
    expect(
      screen.getByText(
        /13 Oct 2026, 09:30 IST: your organisation confirmed the report that arrived later\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Note: Checked against the lender system screen/)).toBeTruthy();
    expect(ops(container)).toEqual([]);
  });

  it('shows no step to a role that may not manage the sync', () => {
    const { container } = view(page([conflict(), acknowledged]), readOnly('/imports/conflicts'));
    expect(ops(container)).toEqual([]);
    expect(screen.getAllByText('Your role cannot acknowledge or resolve conflicts.')).toHaveLength(
      2,
    );
  });

  it('shows no step for a conflict of a lender where the person holds no right', () => {
    const { container } = view(
      page([conflict()]),
      contextFor(ALL_PERMISSIONS, '/imports/conflicts', LENDER_B),
    );
    expect(ops(container)).toEqual([]);
  });

  it('filters by status with a plain form and is empty, failing or forbidden in words', () => {
    view(page([]), full('/imports/conflicts'), { status: 'open' });
    expect(screen.getByText('No conflicts')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Status').value).toBe('open');
    cleanup();
    view(fail(500));
    expect(screen.getByText('Could not load the conflicts')).toBeTruthy();
  });

  it('writes each reason and status it knows in words, and does not print one it does not', () => {
    const { container } = view(
      page([
        conflict({ conflictReason: 'sequence_reused' }),
        {
          ...conflict({ id: CONFLICT_2 }),
          conflictReason: 'brand_new_reason',
          recordType: 'mystery',
        } as never,
      ]),
    );
    expect(screen.getByText('A sequence number was reused for different content.')).toBeTruthy();
    expect(text(container)).not.toMatch(/brand_new_reason|mystery/);
  });
});

describe('Flags', () => {
  it('writes the flag, what was held and what was newly reported, and says nothing was corrected', () => {
    render(<AnomaliesPage page={page([anomaly()])} query={{}} />);
    expect(screen.getByText('Warning: The reported status moved backwards.')).toBeTruthy();
    expect(screen.getByText('Held before: Closed, ₹5,000.00.')).toBeTruthy();
    expect(screen.getByText('Newly reported: Active.')).toBeTruthy();
    expect(
      screen.getByText(
        /Nothing was corrected; the figures are as your system reported them on 12 Oct 2026, 09:30 IST \(from manual import\)\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the loan' }).getAttribute('href')).toBe(
      `/loans/${LOAN}`,
    );
  });

  it('is empty, failing or forbidden in words', () => {
    render(<AnomaliesPage page={page([])} query={{ severity: 'warning' }} />);
    expect(screen.getByText('No flags')).toBeTruthy();
    cleanup();
    render(<AnomaliesPage page={fail(500)} query={{}} />);
    expect(screen.getByText('Could not load the flags')).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('Across every screen', () => {
  const stageAction = vi.fn(() => Promise.resolve<StageState>({ status: 'idle' }));

  /** Every page, drawn for a person who holds every permission and given data for every state. */
  const everyPage = (): ReactElement[] => [
    <LoansPage
      key="l"
      page={page(
        [loanRow(), loanRow({ id: LOAN_2, status: 'closed', disbursedAmountMinor: null })],
        'next_1',
      )}
      query={{}}
      ctx={full()}
    />,
    detailPage({
      detail: ok(
        loanDetail({
          loan: loanRow({ status: 'closed', sync: { ...loanRow().sync, stale: true } }),
          report: report({ flags: ['overdue_total_mismatch'] }),
        }),
      ),
      conflicts: page([
        conflict(),
        conflict({
          id: '0190a000-0000-7000-8000-000000000511',
          status: 'acknowledged',
          acknowledgedAt: '2026-10-12T04:00:00.000000+00:00',
        }),
      ]),
      anomalies: page([anomaly()]),
      documents: ok({
        items: [
          document(),
          document({ documentId: DOC_2, lenderReference: 'OLD/1', supersededById: DOC }),
        ],
      }),
      quotes: page([
        quote(),
        quote({
          id: '0190a000-0000-7000-8000-000000000702',
          lenderQuoteRef: 'FQ-2',
          totalMinor: 7,
          totalMismatch: true,
          letterDocumentId: DOC,
        }),
      ]),
      requests: page([docRequest(), docRequest({ id: REQUEST_2, kind: 'foreclosure_quote' })]),
    }),
    <DocumentRequestsPage
      key="r"
      page={page([
        docRequest(),
        docRequest({ id: REQUEST_2, status: 'fulfilled', fulfilledDocumentId: DOC }),
      ])}
      query={{ status: 'requested' }}
      ctx={full()}
    />,
    <ClosuresPage key="c" page={page([closure()], 'next_2')} query={{}} ctx={full()} />,
    <SyncPage
      key="s"
      status={ok({ items: [syncItem(), syncItem({ lenderId: LENDER_B, connection: null })] })}
      imports={page([batch(), batch({ status: 'invalid' })], 'next_3')}
      corrections={[batch({ status: 'invalid' })]}
      query={{}}
      ctx={full('/imports')}
      stageAction={stageAction}
    />,
    <ImportDetailPage
      key="p"
      detail={ok({ batch: batch(), errors: [], errorsTruncated: false })}
      ctx={full()}
    />,
    <ImportDetailPage
      key="i"
      detail={ok({
        batch: batch({ status: 'invalid' }),
        errors: [
          {
            rowNo: 4,
            outcome: 'error',
            errorCodes: ['invalid_date'],
            fieldNames: ['next_due_date'],
          },
        ],
        errorsTruncated: false,
      })}
      ctx={full()}
    />,
    <ConflictsPage
      key="k"
      page={page([
        conflict(),
        conflict({ id: '0190a000-0000-7000-8000-000000000512', status: 'acknowledged' }),
      ])}
      query={{}}
      ctx={full()}
    />,
    <AnomaliesPage key="a" page={page([anomaly()])} query={{}} />,
  ];

  it('posts only allow-listed operations: every form on every page names one, and all of them are drawn', () => {
    const seen = new Set<string>();
    for (const element of everyPage()) {
      const { container } = render(element);
      for (const op of ops(container)) {
        expect(Object.hasOwn(SERVICING_OPERATIONS, op), op).toBe(true);
        seen.add(op);
      }
      cleanup();
    }
    // The upload form is drawn by the client component and names the staging operation.
    const { container } = render(
      <ImportStageForm action={vi.fn()} lenders={[{ id: LENDER_A, name: 'x' }]} corrections={[]} />,
    );
    for (const op of ops(container)) seen.add(op);
    expect([...seen].sort()).toEqual(Object.keys(SERVICING_OPERATIONS).sort());
  });

  it('draws no write form at all for a person who can only read', () => {
    const read = readOnly();
    const pages: ReactElement[] = [
      detailPage({
        ctx: read,
        detail: ok(loanDetail({ loan: loanRow({ status: 'closed' }) })),
        conflicts: page([
          conflict(),
          conflict({ id: '0190a000-0000-7000-8000-000000000513', status: 'acknowledged' }),
        ]),
        requests: page([docRequest(), docRequest({ id: REQUEST_2, kind: 'foreclosure_quote' })]),
        quotes: page([quote()]),
        documents: ok({ items: [document()] }),
      }),
      <DocumentRequestsPage
        key="r"
        page={page([docRequest()])}
        query={{ status: 'requested' }}
        ctx={read}
      />,
      <ClosuresPage key="c" page={page([closure()])} query={{}} ctx={read} />,
      <SyncPage
        key="s"
        status={ok({ items: [syncItem()] })}
        imports={page([batch()])}
        corrections={[batch({ status: 'invalid' })]}
        query={{}}
        ctx={read}
        stageAction={stageAction}
      />,
      <ImportDetailPage
        key="p"
        detail={ok({ batch: batch(), errors: [], errorsTruncated: false })}
        ctx={read}
      />,
      <ConflictsPage
        key="k"
        page={page([
          conflict(),
          conflict({ id: '0190a000-0000-7000-8000-000000000514', status: 'acknowledged' }),
        ])}
        query={{}}
        ctx={read}
      />,
    ];
    for (const element of pages) {
      const { container } = render(element);
      expect(ops(container), 'a write form was drawn for a read-only role').toEqual([]);
      // The only forms left are the plain GET filters.
      for (const form of container.querySelectorAll('form'))
        expect(form.getAttribute('method')).toBe('get');
      cleanup();
    }
  });

  it('draws forms whose controls all have a label', () => {
    for (const element of everyPage()) {
      const { container } = render(element);
      const controls = [
        ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          'input, select, textarea',
        ),
      ].filter((c) => !(c instanceof HTMLInputElement && c.type === 'hidden'));
      const unlabelled = controls.filter(
        (c) =>
          (c.labels?.length ?? 0) === 0 &&
          !c.getAttribute('aria-label') &&
          !c.getAttribute('aria-labelledby'),
      );
      expect(unlabelled.map((c) => c.name)).toEqual([]);
      cleanup();
    }
  });

  it('gives every table a caption and every header cell a scope, so a screen reader can read it', () => {
    for (const element of everyPage()) {
      const { container } = render(element);
      for (const table of container.querySelectorAll('table')) {
        expect(table.querySelector('caption'), 'table without a caption').not.toBeNull();
        for (const th of table.querySelectorAll('th'))
          expect(th.getAttribute('scope'), text(th)).toMatch(/^(col|row)$/);
      }
      cleanup();
    }
  });

  it('uses a single top-level heading and the navigation names the current page', () => {
    for (const element of everyPage()) {
      const { container } = render(element);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(
        container.querySelectorAll('nav[aria-label="Servicing pages"] a[aria-current="page"]'),
      ).toHaveLength(1);
      cleanup();
    }
  });

  it('uses calm, factual words: no claim of payment, approval, verification or safety, and no urgency', () => {
    const banned =
      /(?<!not be )\b(paid|approved|approval|verified|successful|successfully|safe|safely|secure|compliant|compliance|certified|guaranteed|urgent|urgently|hurry|immediately|last chance|act now|limited time|countdown|expires in|time left|only \d+ left|offer|bonus|reward)\b/i;
    for (const element of everyPage()) {
      const { container } = render(element);
      expect(text(container).match(banned)?.[0], 'wording').toBeUndefined();
      cleanup();
    }
  });

  it('shows no raw server code, vocabulary value or SQLSTATE for a state it has no wording for', () => {
    const odd = loanDetail({ loan: loanRow() });
    const drifted = {
      ...odd,
      loan: { ...odd.loan, status: 'suspended_by_court' },
      report: odd.report && {
        ...odd.report,
        status: 'suspended_by_court',
        sourceSystem: 'quantum_feed',
      },
    } as never;
    const { container } = render(
      detailPage({
        detail: ok(drifted),
        documents: ok({
          items: [{ ...document(), kind: 'mystery_letter', source: 'carrier_pigeon' } as never],
        }),
        quotes: page([{ ...quote(), source: 'carrier_pigeon' } as never]),
        requests: page([{ ...docRequest(), kind: 'mystery_letter', status: 'in_limbo' } as never]),
        conflicts: page([
          { ...conflict(), conflictReason: 'cosmic_rays', status: 'frozen' } as never,
        ]),
        anomalies: page([{ ...anomaly(), kind: 'cosmic_rays', severity: 'doom' } as never]),
        error: 'SQLSTATE 40P01 deadlock detected',
      }),
    );
    expect(text(container)).not.toMatch(
      /suspended_by_court|quantum_feed|mystery_letter|carrier_pigeon|in_limbo|cosmic_rays|frozen|doom|SQLSTATE|40P01|deadlock/,
    );
  });

  it('shows no long run of digits that could be a phone, account or identity number', () => {
    const strip = (s: string) =>
      s
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')
        .replace(/[0-9a-f]{16,}/g, '');
    for (const element of everyPage()) {
      const { container } = render(element);
      const body = strip(container.innerHTML);
      expect(body.match(/\d{9,}/)?.[0], 'digit run').toBeUndefined();
      cleanup();
    }
  });

  it('carries no identifier of a person in any link or hidden field it draws', () => {
    for (const element of everyPage()) {
      const { container } = render(element);
      for (const a of container.querySelectorAll('a[href]')) {
        expect(a.getAttribute('href')).toMatch(
          /^(#[a-z]+|\/(loans|imports)([/?#][A-Za-z0-9_=&%.#/?-]*)?)$/,
        );
      }
      cleanup();
    }
  });
});

describe('The package exports', () => {
  it('exposes the screens, loaders and guards under Servicing names that cannot collide', () => {
    const names = [
      'ServicingLoansPage',
      'ServicingLoanDetailPage',
      'ServicingRequestsPage',
      'ServicingClosuresPage',
      'ServicingSyncPage',
      'ServicingImportPage',
      'ServicingConflictsPage',
      'ServicingAnomaliesPage',
      'ServicingImportForm',
      'runServicingOperation',
      'safeServicingReturnPath',
      'servicingNoticeUrl',
      'servicingGrants',
      'verifiedServicingDocument',
      'loadServicingLoans',
      'loadServicingDocumentContent',
    ];
    for (const name of names)
      expect(typeof (kit as Record<string, unknown>)[name], name).toBe('function');
  });

  it('adds no generic name to the package index: everything leaving the servicing folder says Servicing', async () => {
    const folder = await import('../src/servicing/index.js');
    for (const name of Object.keys(folder)) expect(name, name).toMatch(/servicing/i);
  });
});
