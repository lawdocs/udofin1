import { createApiClient } from '@udofin/auth-client';
import {
  SVC_ACTIVITY_KINDS,
  SVC_ACTIVITY_PURPOSES,
  SVC_ACTIVITY_STATES,
  SVC_COLLATERAL_TYPES,
  SVC_DOCUMENT_KINDS,
  SVC_LOAN_STATUSES,
  SVC_REMINDER_KINDS,
  SVC_REQUEST_STATUSES,
} from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import { keyAfter, createServicingClient } from '../src/borrower/servicing';
import { SERVICING_ERROR_CODES, servicingErrorKey } from '../src/borrower/servicing-errors';
import {
  base64ByteLength,
  formatAmount,
  formatDateOnly,
  formatInstantDay,
  formatReportedAt,
  isCalendarDate,
  parseInstant,
} from '../src/borrower/servicing-format';
import {
  activityRowModel,
  activityStateRef,
  appendActivityPage,
  closureModel,
  documentContentProblem,
  documentKindKey,
  documentRowModel,
  figuresModel,
  hasAnyLoan,
  hrefToUrl,
  loanCardModel,
  loanHomeModel,
  loanStatusKey,
  mandateSetupHref,
  nocLine,
  openOutcomeKey,
  openRequestOfKind,
  parseStatementPeriod,
  payHref,
  mandateListHref,
  payQuotationHref,
  paymentStatusHref,
  quoteModel,
  reminderModel,
  requestRowModel,
  scheduleModel,
  securityLine,
  shouldMarkRead,
  unreadReminderCount,
  type TextRef,
} from '../src/borrower/servicing-view';
import { translate, type Language, type MessageKey } from '../src/i18n';
import { en } from '../src/i18n/en';
import { hi } from '../src/i18n/hi';
import {
  DOC_ID,
  LENDER,
  LOAN_ID,
  OTHER_ID,
  PAYMENT_ID,
  REPORTED_AT,
  REPORTED_AT_TEXT,
  REQUEST_ID,
  closure,
  document,
  entry,
  loan,
  overdueLoan,
  quote,
  reminder,
  request,
  task,
  withheldLoan,
} from './servicing-fixtures';

const say = (ref: TextRef, language: Language = 'en') =>
  translate(language, ref.key, ref.vars ?? {});

/** Every message a model would show, in order, by walking it. Plain strings (lender words, formatted figures) are not included. */
function allRefs(value: unknown, out: TextRef[] = []): TextRef[] {
  if (Array.isArray(value)) {
    for (const item of value) allRefs(item, out);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.key === 'string' && record.key in en) {
      out.push(record as unknown as TextRef);
    } else {
      for (const item of Object.values(record)) allRefs(item, out);
    }
  }
  return out;
}
const sayAll = (model: unknown, language: Language = 'en') =>
  allRefs(model).map((ref) => say(ref, language));

describe('money, dates and times', () => {
  it('writes paise as rupees with Indian digit grouping', () => {
    expect(formatAmount(0)).toBe('₹0');
    expect(formatAmount(99)).toBe('₹0.99');
    expect(formatAmount(100)).toBe('₹1');
    expect(formatAmount(4_567_000)).toBe('₹45,670');
    expect(formatAmount(12_345_678)).toBe('₹1,23,456.78');
    expect(formatAmount(100_000_000)).toBe('₹10,00,000');
    expect(formatAmount(123_456_789_012)).toBe('₹1,23,45,67,890.12');
  });

  it('writes the lender report time in India time and says IST, microseconds and all', () => {
    expect(formatReportedAt(REPORTED_AT, 'en')).toBe(REPORTED_AT_TEXT);
    expect(formatReportedAt('2026-10-18T14:30:00+05:30', 'en')).toBe(REPORTED_AT_TEXT);
    expect(formatReportedAt('2026-10-18T09:00:00Z', 'en')).toBe(REPORTED_AT_TEXT);
    expect(formatReportedAt('2026-10-18T09:00:00.9+0000', 'en')).toBe(REPORTED_AT_TEXT);
  });

  it('writes midnight as 00:00, never 24:00, and moves the day with the zone', () => {
    expect(formatReportedAt('2026-10-17T18:30:00+00:00', 'en')).toBe('18 Oct 2026, 00:00 IST');
    expect(formatReportedAt('2026-10-17T18:29:59+00:00', 'en')).toBe('17 Oct 2026, 23:59 IST');
  });

  it('gives nothing, not a made-up time, for a value that is not a timestamp', () => {
    expect(formatReportedAt('', 'en')).toBe('');
    expect(formatReportedAt('2026-10-18', 'en')).toBe('');
    expect(formatReportedAt('garbage', 'en')).toBe('');
    expect(formatReportedAt('2026-13-45T99:00:00Z', 'en')).toBe('');
    expect(parseInstant('2026-10-18T09:00:00.123456+00:00')?.toISOString()).toBe(
      '2026-10-18T09:00:00.123Z',
    );
  });

  it('writes the same time in Hindi with the zone named, from fixed month names', () => {
    expect(formatReportedAt(REPORTED_AT, 'hi')).toBe('18 अक्टूबर 2026, 14:30 IST');
    expect(formatDateOnly('2026-09-30', 'hi')).toBe('30 सितंबर 2026');
  });

  it('writes every month the same way on every device', () => {
    const names = Array.from(
      { length: 12 },
      (_, i) => formatDateOnly(`2026-${String(i + 1).padStart(2, '0')}-01`, 'en').split(' ')[1],
    );
    expect(names).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });

  it('moves the year and month when India time is already the next day', () => {
    expect(formatReportedAt('2026-12-31T20:00:00+00:00', 'en')).toBe('1 Jan 2027, 01:30 IST');
  });

  it('keeps a date-only value on its own calendar day in any zone', () => {
    expect(formatDateOnly('2026-11-05', 'en')).toBe('5 Nov 2026');
    expect(formatDateOnly('2026-01-01', 'en')).toBe('1 Jan 2026');
    expect(formatDateOnly('2026-12-31', 'en')).toBe('31 Dec 2026');
    expect(formatDateOnly('2026-02-30', 'en')).toBe('');
    expect(formatDateOnly('5 Nov 2026', 'en')).toBe('');
  });

  it('writes the India calendar day of an instant', () => {
    expect(formatInstantDay('2026-11-02T04:00:00.000000+00:00', 'en')).toBe('2 Nov 2026');
    expect(formatInstantDay('2026-11-02T20:00:00+00:00', 'en')).toBe('3 Nov 2026');
  });

  it('knows a real calendar date', () => {
    expect(isCalendarDate('2026-10-18')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-04-30')).toBe(true);
    expect(isCalendarDate('2026-04-00')).toBe(false);
    expect(isCalendarDate('0050-01-01')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
  });

  it('counts the bytes of a base64 text without decoding it', () => {
    expect(base64ByteLength('AAAA')).toBe(3);
    expect(base64ByteLength('AAA=')).toBe(2);
    expect(base64ByteLength('AA==')).toBe(1);
    expect(base64ByteLength('')).toBe(-1);
    expect(base64ByteLength('A')).toBe(-1);
    expect(base64ByteLength('AA=A')).toBe(-1);
    expect(base64ByteLength('not base64!')).toBe(-1);
  });
});

describe('the client reaches only the routes of this feature, with the right shape', () => {
  interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }
  function setup(routes: Record<string, unknown>) {
    const calls: Call[] = [];
    const fetchFake = ((url: string, init: RequestInit) => {
      const path = url.replace('https://api.example', '');
      const method = init.method ?? 'GET';
      calls.push({
        method,
        url: path,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const hit = routes[`${method} ${path}`];
      if (hit === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
      return Promise.resolve(
        new Response(JSON.stringify(hit), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const api = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('tok'),
      fetch: fetchFake,
    });
    return { client: createServicingClient(api), calls };
  }
  const requestResult = { request: request() };

  it('reads the loans, one loan, its schedule and its closure', async () => {
    const { client, calls } = setup({
      'GET /v1/loans': { items: [loan()] },
      [`GET /v1/loans/${LOAN_ID}`]: loan(),
      [`GET /v1/loans/${LOAN_ID}/schedule`]: {
        scheduleVersion: null,
        reportedAsOf: null,
        installments: [],
      },
      [`GET /v1/loans/${LOAN_ID}/closure`]: { closure: null },
      [`GET /v1/loans/${LOAN_ID}/documents`]: { items: [document()] },
      [`GET /v1/loans/${LOAN_ID}/document-requests`]: { items: [request()] },
      [`GET /v1/loans/${LOAN_ID}/foreclosure-quotes/latest`]: { quote: null },
      'GET /v1/me/reminders': { items: [reminder()] },
    });
    expect((await client.loans()).ok).toBe(true);
    expect((await client.loan(LOAN_ID)).ok).toBe(true);
    expect((await client.schedule(LOAN_ID)).ok).toBe(true);
    expect((await client.closure(LOAN_ID)).ok).toBe(true);
    expect((await client.documents(LOAN_ID)).ok).toBe(true);
    expect((await client.documentRequests(LOAN_ID)).ok).toBe(true);
    expect((await client.latestQuote(LOAN_ID)).ok).toBe(true);
    expect((await client.reminders()).ok).toBe(true);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true);
    // Only these paths: no payments route, no mandate route, no /v1/me other than the reminder inbox.
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        '/v1/loans',
        `/v1/loans/${LOAN_ID}`,
        `/v1/loans/${LOAN_ID}/schedule`,
        `/v1/loans/${LOAN_ID}/closure`,
        `/v1/loans/${LOAN_ID}/documents`,
        `/v1/loans/${LOAN_ID}/document-requests`,
        `/v1/loans/${LOAN_ID}/foreclosure-quotes/latest`,
        '/v1/me/reminders',
      ].sort(),
    );
  });

  it('pages the activity with the opaque cursor passed back unchanged and encoded', async () => {
    const cursor = 'eyJ0IjoiMjAyNi0xMC0xOCIsImlkIjoieCJ9=';
    const { client, calls } = setup({
      [`GET /v1/loans/${LOAN_ID}/activity?limit=25`]: { items: [entry()], nextCursor: cursor },
      [`GET /v1/loans/${LOAN_ID}/activity?limit=25&cursor=${encodeURIComponent(cursor)}`]: {
        items: [],
        nextCursor: null,
      },
    });
    const first = await client.activity(LOAN_ID);
    expect(first.ok && first.data.nextCursor).toBe(cursor);
    const second = await client.activity(LOAN_ID, cursor);
    expect(second.ok && second.data.nextCursor).toBeNull();
    expect(calls[1]?.url).toContain('%3D');
    expect(calls[1]?.url).not.toContain('=&');
  });

  it('opens a document only through the authenticated content route, by ids', async () => {
    const content = {
      documentId: DOC_ID,
      loanId: LOAN_ID,
      kind: 'statement',
      lenderReference: 'STM-1',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      sha256: '0'.repeat(64),
      source: 'lender_upload',
      contentBase64: 'AAAA',
    };
    const { client, calls } = setup({
      [`GET /v1/loans/${LOAN_ID}/documents/${DOC_ID}/content?purpose=view`]: content,
    });
    const result = await client.documentContent(LOAN_ID, DOC_ID);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toMatch(/https?:|\.pdf|signed|blob/i);
  });

  it('every write carries the Idempotency-Key it was given and goes to one allowed route', async () => {
    const { client, calls } = setup({
      [`POST /v1/loans/${LOAN_ID}/statements`]: requestResult,
      [`POST /v1/loans/${LOAN_ID}/foreclosure-quotes`]: requestResult,
      [`POST /v1/loans/${LOAN_ID}/document-requests/${REQUEST_ID}/cancel`]: requestResult,
      [`POST /v1/me/reminders/${OTHER_ID}/read`]: { reminderId: OTHER_ID, state: 'read' },
    });
    expect((await client.requestStatement(LOAN_ID, null, 'action-one-0000001')).ok).toBe(true);
    expect(
      (
        await client.requestStatement(
          LOAN_ID,
          { periodFrom: '2026-04-01', periodTo: '2026-09-30' },
          'action-two-0000002',
        )
      ).ok,
    ).toBe(true);
    expect((await client.requestForeclosureQuote(LOAN_ID, 'action-three-00003')).ok).toBe(true);
    expect((await client.cancelDocumentRequest(LOAN_ID, REQUEST_ID, 'action-four-000004')).ok).toBe(
      true,
    );
    expect((await client.markReminderRead(OTHER_ID, 'action-five-000005')).ok).toBe(true);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual([
      'action-one-0000001',
      'action-two-0000002',
      'action-three-00003',
      'action-four-000004',
      'action-five-000005',
    ]);
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
    // Both ends of a period or neither; nothing else is sent.
    expect(calls[0]?.body).toEqual({});
    expect(calls[1]?.body).toEqual({ periodFrom: '2026-04-01', periodTo: '2026-09-30' });
  });

  it('turns an answer of the wrong shape into bad_response and a server problem into its code', async () => {
    const { client } = setup({ 'GET /v1/loans': { items: 'nope' } });
    const bad = await client.loans();
    expect(!bad.ok && bad.code).toBe('bad_response');
    const missing = await client.loan(LOAN_ID);
    expect(!missing.ok && missing.code).toBe('http_404');
  });

  it('refuses an answer in which withheld figures still carry an amount', async () => {
    const inconsistent = { ...withheldLoan(), nextDueMinor: 4_567_000 };
    const { client } = setup({ [`GET /v1/loans/${LOAN_ID}`]: inconsistent });
    const result = await client.loan(LOAN_ID);
    expect(!result.ok && result.code).toBe('bad_response');
  });

  it('a user action gets a new key; a lost answer keeps the key so the retry finds the first attempt', () => {
    let n = 0;
    const make = () => `made-${String((n += 1))}`;
    expect(keyAfter({ ok: false, code: 'network_error' }, 'current-action', make)).toBe(
      'current-action',
    );
    expect(keyAfter({ ok: true }, 'current-action', make)).toBe('made-1');
    expect(keyAfter({ ok: false, code: 'open_request_exists' }, 'current-action', make)).toBe(
      'made-2',
    );
    expect(keyAfter({ ok: false, code: 'http_500' }, 'current-action', make)).toBe('made-3');
  });
});

describe('error codes become wording, never raw text', () => {
  it('maps every code this feature can meet to wording that exists in both languages', () => {
    for (const code of SERVICING_ERROR_CODES) {
      const key = servicingErrorKey(code);
      expect(key in en && key in hi, code).toBe(true);
      expect(key, code).not.toBe('error.generic');
    }
  });

  it('keeps the shared codes working and falls back to the generic sentence', () => {
    expect(servicingErrorKey('network_error')).toBe('error.offline');
    expect(servicingErrorKey('signed_out')).toBe('error.signedOut');
    expect(servicingErrorKey('token_expired')).toBe('error.signedOut');
    expect(servicingErrorKey('rate_limited')).toBe('error.rateLimited');
    expect(servicingErrorKey('http_429')).toBe('error.rateLimited');
    expect(servicingErrorKey('bad_response')).toBe('error.badResponse');
    expect(servicingErrorKey('http_500')).toBe('error.generic');
    expect(servicingErrorKey('internal_error')).toBe('error.generic');
    expect(servicingErrorKey('sqlstate_23505 <script>')).toBe('error.generic');
  });

  it('names the failures of the document requests in plain words', () => {
    expect(say({ key: servicingErrorKey('open_request_exists') })).toContain(
      'already have an open',
    );
    expect(say({ key: servicingErrorKey('period_invalid') })).toContain('dates');
    expect(say({ key: servicingErrorKey('request_not_open') })).toContain('no longer open');
    expect(say({ key: servicingErrorKey('feature_disabled') })).toContain('not available');
    expect(say({ key: servicingErrorKey('not_found') })).toContain('could not find');
  });

  it('never repeats the code or any server text in what the borrower reads', () => {
    for (const code of [...SERVICING_ERROR_CODES, 'weird_code_42', 'http_502']) {
      for (const language of ['en', 'hi'] as const) {
        const text = translate(language, servicingErrorKey(code));
        expect(text, code).not.toContain(code);
        expect(text, code).not.toMatch(/_|\{|\}/);
      }
    }
  });
});

describe('the figures of a loan are the lender’s, attributed, and never zero when unknown', () => {
  it('shows the figures with whose they are and when they were reported', () => {
    const model = figuresModel(loan(), 'en');
    expect(model.kind).toBe('shown');
    if (model.kind !== 'shown') return;
    expect(say(model.attribution)).toBe(`As reported by ${LENDER} on ${REPORTED_AT_TEXT}`);
    expect(model.staleNotice).toBeNull();
    expect(model.rows.map((r) => [say(r.label), r.value])).toEqual([
      ['Outstanding principal', '₹1,23,456.78'],
      ['Next due date', '5 Nov 2026'],
      ['Next due amount', '₹45,670'],
    ]);
    expect(model.overdue).toBeNull();
  });

  it('withheld figures show no amount at all and say the lender is checking', () => {
    const model = figuresModel(withheldLoan(), 'en');
    expect(model.kind).toBe('withheld');
    expect(JSON.stringify(model)).not.toMatch(/₹|\d{3}/);
    if (model.kind === 'withheld')
      expect(say(model.notice)).toBe(
        `${LENDER} is checking these figures. No amounts are shown for now. Please check again later, or ask ${LENDER}.`,
      );
  });

  it('shows no amount even if a withheld answer carried one (it is refused by the contract, and not drawn here)', () => {
    const model = figuresModel({ ...loan(), figuresAvailable: false }, 'en');
    expect(model.kind).toBe('withheld');
    expect(JSON.stringify(model)).not.toContain('₹');
  });

  it('does not show figures that cannot say when the lender reported them', () => {
    expect(figuresModel(loan({ reportedAsOf: null }), 'en').kind).toBe('withheld');
    expect(figuresModel(loan({ reportedAsOf: 'garbage' }), 'en').kind).toBe('withheld');
  });

  it('a stale report gets a plain notice with the lender’s time; a withheld one needs none', () => {
    const stale = figuresModel(loan({ stale: true }), 'en');
    expect(stale.kind === 'shown' && stale.staleNotice && say(stale.staleNotice)).toBe(
      `The last report from ${LENDER} is from ${REPORTED_AT_TEXT}. It may be out of date. Please check again later, or ask ${LENDER} for current figures.`,
    );
    const both = figuresModel(withheldLoan({ stale: true }), 'en');
    expect(both.kind).toBe('withheld');
    expect('staleNotice' in both).toBe(false);
  });

  it('a figure the lender did not report is null in the row, never zero or empty', () => {
    const model = figuresModel(
      loan({ nextDueMinor: null, nextDueOn: null, outstandingPrincipalMinor: null }),
      'en',
    );
    expect(model.kind === 'shown' && model.rows.map((r) => r.value)).toEqual([null, null, null]);
  });

  it('a figure the lender reported as zero is shown as zero, because it is the lender’s', () => {
    const model = figuresModel(loan({ outstandingPrincipalMinor: 0 }), 'en');
    expect(model.kind === 'shown' && model.rows[0]?.value).toBe('₹0');
  });

  it('shows the lender’s overdue figures and nothing about charges', () => {
    const model = figuresModel(overdueLoan(), 'en');
    expect(model.kind).toBe('shown');
    if (model.kind !== 'shown' || !model.overdue) throw new Error('expected an overdue block');
    expect(say(model.overdue.title)).toBe(`Overdue, as reported by ${LENDER}`);
    expect(model.overdue.rows.map((r) => [say(r.label), r.value])).toEqual([
      ['Overdue principal', '₹30,000'],
      ['Overdue interest', '₹1,250.50'],
      ['Total overdue, as stated by the lender', '₹47,917.15'],
      ['Days past due, as reported', '12'],
    ]);
    // The penal and other charge figures the lender reported (7,777.77 and 8,888.88) appear nowhere, and no line mentions charges.
    const rendered = JSON.stringify(model) + sayAll(model).join('\n');
    expect(rendered).not.toMatch(/7,777|8,888|penal|charge/i);
  });

  it('the total overdue is the lender’s own figure, not the sum of the parts', () => {
    const model = figuresModel(overdueLoan(), 'en');
    const total = model.kind === 'shown' ? model.overdue?.rows[2]?.value : undefined;
    expect(total).toBe('₹47,917.15');
    expect(total).not.toBe(formatAmount(3_000_000 + 125_050));
  });

  it('draws the overdue block only when the lender reported something overdue', () => {
    const none = (l: ReturnType<typeof loan>) => {
      const m = figuresModel(l, 'en');
      return m.kind === 'shown' ? m.overdue : 'withheld';
    };
    expect(none(loan())).toBeNull();
    expect(
      none(loan({ overduePrincipalMinor: null, totalOverdueMinor: null, daysPastDue: null })),
    ).toBeNull();
    expect(none(loan({ daysPastDue: 3 }))).not.toBeNull();
    expect(none(loan({ overdueInterestMinor: 1 }))).not.toBeNull();
    expect(none(loan({ totalOverdueMinor: 500 }))).not.toBeNull();
  });
});

describe('the loan home and the loan card', () => {
  it('names the lender, the loan reference and the status, and the loan facts', () => {
    const model = loanHomeModel(loan(), 'en');
    expect(model.lender).toBe(LENDER);
    expect(say(model.reference)).toBe('Loan reference: SAMPLE-LN-0001');
    expect(`${say(model.status.label)}: ${say(model.status.value)}`).toBe(
      `Loan status (per ${LENDER}): Active`,
    );
    expect(model.reportedStatus).toBeNull();
    expect(model.facts.map((f) => say(f))).toEqual([
      `Sanctioned amount (per ${LENDER}): ₹5,00,000`,
      `Disbursed amount (per ${LENDER}): ₹5,00,000`,
    ]);
  });

  it('leaves out the disbursed amount when none was reported', () => {
    const model = loanHomeModel(loan({ disbursedAmountMinor: null, disbursedAt: null }), 'en');
    expect(model.facts).toHaveLength(1);
  });

  it('says what the latest report says only when it differs from the status held', () => {
    const differs = loanHomeModel(loan({ loanStatus: 'active', reportedStatus: 'closed' }), 'en');
    expect(differs.reportedStatus && say(differs.reportedStatus.label)).toBe(
      `Latest report from ${LENDER} says`,
    );
    expect(differs.reportedStatus && say(differs.reportedStatus.value)).toBe('Closed');
    expect(loanHomeModel(withheldLoan(), 'en').reportedStatus).toBeNull();
  });

  it('adds a neutral note for a written-off status and says whose status it is', () => {
    const model = loanHomeModel(loan({ loanStatus: 'written_off' }), 'en');
    expect(model.statusNote && say(model.statusNote)).toBe(
      `This is ${LENDER}'s own status for the loan. Ask ${LENDER} what it means for you.`,
    );
    expect(loanHomeModel(loan(), 'en').statusNote).toBeNull();
  });

  it('every status of the contract has wording and an unknown one a neutral line', () => {
    for (const status of SVC_LOAN_STATUSES) {
      expect(loanStatusKey(status), status).not.toBe('loans.status.unknown');
    }
    expect(loanStatusKey('mystery')).toBe('loans.status.unknown');
    expect(say({ key: loanStatusKey('mystery') })).not.toContain('mystery');
  });

  it('the list card shows the next due date and the attribution, or only the withheld notice', () => {
    const shown = loanCardModel(loan(), 'en');
    expect(shown.summary.map((s) => say(s))).toEqual([
      'Next due date: 5 Nov 2026',
      'Next due amount: ₹45,670',
      `As reported by ${LENDER} on ${REPORTED_AT_TEXT}`,
    ]);
    const stale = loanCardModel(loan({ stale: true }), 'en');
    expect(stale.summary.map((s) => say(s)).join(' ')).toContain('may be out of date');
    const withheld = loanCardModel(withheldLoan(), 'en');
    expect(withheld.summary).toHaveLength(1);
    expect(JSON.stringify(withheld.summary)).not.toContain('₹');
    const noDate = loanCardModel(loan({ nextDueOn: null, nextDueMinor: null }), 'en');
    expect(say(noDate.summary[0] ?? { key: 'loans.title' })).toBe(
      `Next due date: not reported by ${LENDER}`,
    );
  });
});

describe('the schedule is the lender’s, with no status invented', () => {
  const installment = {
    seq: 1,
    dueDate: '2026-11-05',
    principalMinor: 3_000_000,
    interestMinor: 125_050,
    feesMinor: 0,
    totalMinor: 3_125_050,
  };
  it('shows each instalment as reported', () => {
    const model = scheduleModel(
      { scheduleVersion: 2, reportedAsOf: REPORTED_AT, installments: [installment] },
      LENDER,
      'en',
    );
    expect(model.kind).toBe('rows');
    if (model.kind !== 'rows') return;
    expect(say(model.attribution ?? { key: 'loans.title' })).toBe(
      `Schedule as reported by ${LENDER} on ${REPORTED_AT_TEXT}`,
    );
    expect(model.rows[0] && say(model.rows[0].title)).toBe('Instalment 1, due 5 Nov 2026');
    expect(model.rows[0]?.lines.map((l) => say(l))).toEqual([
      'Principal: ₹30,000',
      'Interest: ₹1,250.50',
      'Fees: ₹0',
      'Total: ₹31,250.50',
    ]);
    const text = sayAll(model).join('\n');
    expect(text).not.toMatch(/\b(paid|overdue|pending|due soon|missed|upcoming)\b/i);
  });

  it('says there is nothing to show when no schedule was reported or it is withheld', () => {
    const none = scheduleModel(
      { scheduleVersion: null, reportedAsOf: null, installments: [] },
      LENDER,
      'en',
    );
    expect(none.kind).toBe('none');
    expect(none.kind === 'none' && say(none.notice)).toBe(
      `There is no schedule to show. ${LENDER} has not reported one, or it is being checked.`,
    );
    expect(
      scheduleModel({ scheduleVersion: 3, reportedAsOf: null, installments: [] }, LENDER, 'en')
        .kind,
    ).toBe('none');
  });
});

describe('activity: the honest stage words', () => {
  const sentence = (state: string) => say(activityStateRef(state, LENDER));

  it('has wording for every state of the contract and no word for paid or successful', () => {
    for (const state of SVC_ACTIVITY_STATES) {
      const ref = activityStateRef(state, LENDER);
      expect(ref.key, state).not.toBe('loans.state.unknown');
      for (const language of ['en', 'hi'] as const) {
        const text = translate(language, ref.key, ref.vars ?? {});
        expect(text, state).not.toMatch(/\b(paid|successful(ly)?|completed|approved|verified)\b/i);
        expect(text, state).not.toMatch(/सफल|चुका|सत्यापित|अनुमोदित/);
        expect(text, state).not.toMatch(/[{}_]/);
      }
    }
  });

  it('keeps started, received by the provider, posted by the lender and needs attention apart', () => {
    expect(sentence('started')).toBe('Started. Nothing has been confirmed yet.');
    expect(sentence('provider_received')).toBe(
      `Received by the payment provider. This does not yet mean that ${LENDER} has posted it to your loan.`,
    );
    expect(sentence('lender_posted')).toBe(`${LENDER} has posted it to your loan.`);
    expect(sentence('needs_attention')).toBe(`Needs attention: contact ${LENDER}.`);
    expect(sentence('cancelled')).toBe('Cancelled.');
    expect(sentence('failed')).toBe('Failed.');
    expect(sentence('expired')).toBe('Expired.');
  });

  it('only the lender-posted stage says the lender posted a payment attempt', () => {
    for (const state of [
      'started',
      'provider_received',
      'needs_attention',
      'cancelled',
      'failed',
      'expired',
    ]) {
      expect(sentence(state), state).not.toBe(sentence('lender_posted'));
      expect(sentence(state), state).not.toMatch(new RegExp(`^${LENDER} has posted`));
    }
  });

  it('describes receipts and the provider’s adjustments as what they are', () => {
    expect(sentence('posted')).toBe(`Posted to your loan by ${LENDER}.`);
    expect(sentence('reversed')).toBe(`Posted by ${LENDER} and later reversed.`);
    expect(sentence('recorded')).toBe(`Recorded by ${LENDER}.`);
    expect(sentence('refund')).toBe('A refund was reported.');
    expect(sentence('chargeback')).toBe('A chargeback was reported.');
    expect(sentence('reversal')).toBe('A reversal was reported.');
    expect(sentence('correction')).toBe('A correction was reported.');
  });

  it('a stage this version does not know says so and never shows the value', () => {
    const text = sentence('settled_ok');
    expect(text).toContain('not available in this version');
    expect(text).not.toContain('settled_ok');
    expect(activityStateRef('settled_ok', LENDER).key).toBe('loans.state.unknown');
  });

  it('a row shows the date the entry is about, the amount as reported and the stage', () => {
    const row = activityRowModel(entry({ state: 'provider_received' }), LENDER, 'en');
    expect(say(row.title)).toBe('Payment attempt');
    expect(row.purpose && say(row.purpose)).toBe('For an instalment');
    expect(row.date).toBe('17 Oct 2026');
    expect(say(row.amount)).toBe('Amount: ₹45,670');
    expect(say(row.state)).toContain('Received by the payment provider');
  });

  it('an amount the API did not give is "not reported", never zero', () => {
    const row = activityRowModel(entry({ amountMinor: null }), LENDER, 'en');
    expect(say(row.amount)).toBe('Amount: not reported');
  });

  it('only a payment attempt links to the payment status screen, by its id', () => {
    for (const kind of SVC_ACTIVITY_KINDS) {
      const row = activityRowModel(
        entry({ entryKind: kind, purpose: kind === 'payment_attempt' ? 'installment' : null }),
        LENDER,
        'en',
      );
      if (kind === 'payment_attempt') {
        expect(row.detail && hrefToUrl(row.detail)).toBe(
          `/payments/status?paymentId=${PAYMENT_ID}`,
        );
      } else {
        expect(row.detail, kind).toBeNull();
      }
    }
  });

  it('has wording for every kind and every purpose of the contract', () => {
    for (const kind of SVC_ACTIVITY_KINDS) {
      expect(activityRowModel(entry({ entryKind: kind }), LENDER, 'en').title.key).not.toBe(
        'loans.activity.kind.unknown',
      );
    }
    for (const purpose of SVC_ACTIVITY_PURPOSES) {
      expect(activityRowModel(entry({ purpose }), LENDER, 'en').purpose, purpose).not.toBeNull();
    }
    const unknownPurpose = activityRowModel(
      entry({ purpose: 'mystery' as unknown as 'installment' }),
      LENDER,
      'en',
    );
    expect(unknownPurpose.purpose).toBeNull();
  });

  it('adds the next page after the entries shown, keeps the cursor opaque and never repeats an entry', () => {
    const a = entry({ entryId: '0f0f0f0f-0000-4000-8000-0000000000a1' });
    const b = entry({ entryId: '0f0f0f0f-0000-4000-8000-0000000000a2' });
    const c = entry({ entryId: '0f0f0f0f-0000-4000-8000-0000000000a3' });
    const opaque = 'bm90LWEtZGF0ZQ';
    const merged = appendActivityPage([a, b], { items: [b, c], nextCursor: opaque });
    expect(merged.items.map((e) => e.entryId)).toEqual([a.entryId, b.entryId, c.entryId]);
    expect(merged.cursor).toBe(opaque);
    expect(appendActivityPage([a], { items: [], nextCursor: null }).cursor).toBeNull();
  });
});

describe('statements, documents and requests', () => {
  it('describes a lender document without its link or storage details', () => {
    const model = documentRowModel(document(), LENDER, 'en');
    expect(say(model.title)).toBe('Statement of account');
    expect(say(model.reference)).toBe('Reference given by the lender: STM-2026-0001');
    expect(say(model.issued)).toBe(`Issued by ${LENDER} on 10 Oct 2026, 11:30 IST`);
    expect(model.period && say(model.period)).toBe('Period: 1 Apr 2026 to 30 Sep 2026');
    expect(model.notices).toEqual([]);
    expect(JSON.stringify(model)).not.toMatch(/http|storage|sha|blob/i);
  });

  it('labels a test document and a replaced one', () => {
    const mock = documentRowModel(document({ source: 'mock' }), LENDER, 'en');
    expect(mock.notices.map((n) => say(n))).toEqual(['Test document. It is not a real document.']);
    const old = documentRowModel(document({ supersededById: OTHER_ID }), LENDER, 'en');
    expect(old.notices.map((n) => say(n))).toEqual([
      `${LENDER} has replaced this with a newer document.`,
    ]);
    expect(documentRowModel(document({ periodTo: null }), LENDER, 'en').period).toBeNull();
  });

  it('has a name for every kind of document', () => {
    for (const kind of SVC_DOCUMENT_KINDS) {
      expect(documentKindKey(kind), kind).not.toBe('loans.doc.kind.unknown');
    }
    expect(documentKindKey('mystery')).toBe('loans.doc.kind.unknown');
  });

  it('shows an open request as requested, with its target date labelled a platform default', () => {
    const model = requestRowModel(request(), LENDER, 'en');
    expect(say(model.status)).toBe(`Requested. ${LENDER} has not answered yet.`);
    expect(model.requested && say(model.requested)).toBe('Requested on 15 Oct 2026, 10:00 IST');
    expect(model.due && say(model.due)).toBe('Target date: 25 Oct 2026, 17:30 IST');
    expect(model.dueNote && say(model.dueNote)).toBe(
      `This is a platform default. It is not a legal or regulatory deadline, and not a promise by ${LENDER}.`,
    );
    expect(model.canCancel).toBe(true);
  });

  it('never states a regulatory deadline and never shows the rule key or evidence word', () => {
    for (const evidence of ['unverified', 'likely', 'interpretation', null] as const) {
      const model = requestRowModel(request({ dueEvidenceStatus: evidence }), LENDER, 'en');
      expect(model.dueNote, String(evidence)).not.toBeNull();
      const text = JSON.stringify(model) + sayAll(model).join('\n');
      expect(text).not.toMatch(
        /statement\.default|unverified|likely|interpretation|RBI|regulat.*require/i,
      );
    }
    const confirmed = requestRowModel(request({ dueEvidenceStatus: 'confirmed' }), LENDER, 'en');
    expect(confirmed.dueNote).toBeNull();
    expect(sayAll(confirmed).join('\n')).not.toMatch(/RBI|regulation requires|deadline set by/i);
  });

  it('shows a target date only while the request is open', () => {
    for (const status of ['fulfilled', 'declined', 'expired', 'cancelled'] as const) {
      const model = requestRowModel(request({ status }), LENDER, 'en');
      expect(model.due, status).toBeNull();
      expect(model.dueNote, status).toBeNull();
      expect(model.canCancel, status).toBe(false);
    }
  });

  it('shows the lender’s note as the lender’s words, only for a declined request', () => {
    const declined = requestRowModel(
      request({ status: 'declined', lenderNote: 'We cannot issue this for a closed account.' }),
      LENDER,
      'en',
    );
    expect(declined.lenderNote?.text).toBe('We cannot issue this for a closed account.');
    expect(declined.lenderNote && say(declined.lenderNote.label)).toBe(`Note from ${LENDER}`);
    const open = requestRowModel(request({ lenderNote: 'ignored' }), LENDER, 'en');
    expect(open.lenderNote).toBeNull();
  });

  it('offers the answer of a fulfilled request, and nothing before the lender answered', () => {
    const answered = requestRowModel(
      request({ status: 'fulfilled', fulfilledDocumentId: DOC_ID }),
      LENDER,
      'en',
    );
    expect(answered.fulfilledDocumentId).toBe(DOC_ID);
    expect(say(answered.status)).toBe(`${LENDER} has provided this.`);
    expect(requestRowModel(request(), LENDER, 'en').fulfilledDocumentId).toBeNull();
  });

  it('has wording for every request status of the contract', () => {
    for (const status of SVC_REQUEST_STATUSES) {
      const model = requestRowModel(request({ status }), LENDER, 'en');
      expect(say(model.status), status).not.toMatch(/[{}_]/);
    }
  });

  it('finds the open request of a kind', () => {
    const list = [
      request({ requestId: '0f0f0f0f-0000-4000-8000-0000000000b1', status: 'cancelled' }),
      request({ requestId: '0f0f0f0f-0000-4000-8000-0000000000b2', kind: 'foreclosure_quote' }),
    ];
    expect(openRequestOfKind(list, 'foreclosure_quote')?.requestId).toBe(
      '0f0f0f0f-0000-4000-8000-0000000000b2',
    );
    expect(openRequestOfKind(list, 'statement')).toBeNull();
  });

  it('reads the optional statement period: both dates or neither, real days only', () => {
    expect(parseStatementPeriod('', '')).toEqual({ ok: true, period: null });
    expect(parseStatementPeriod('  ', '')).toEqual({ ok: true, period: null });
    expect(parseStatementPeriod('2026-04-01', '')).toEqual({ ok: false, error: 'incomplete' });
    expect(parseStatementPeriod('', '2026-04-01')).toEqual({ ok: false, error: 'incomplete' });
    expect(parseStatementPeriod('2026-02-30', '2026-04-01')).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(parseStatementPeriod('1 April', '2026-04-01')).toEqual({ ok: false, error: 'invalid' });
    expect(parseStatementPeriod(' 2026-04-01 ', '2026-09-30')).toEqual({
      ok: true,
      period: { periodFrom: '2026-04-01', periodTo: '2026-09-30' },
    });
  });

  it('leaves the question whether a period is backwards or in the future to the API', () => {
    expect(parseStatementPeriod('2026-09-30', '2026-04-01').ok).toBe(true);
    expect(servicingErrorKey('period_invalid')).toBe('loans.err.periodInvalid');
  });
});

describe('the foreclosure quotation is the lender’s, with a date and time, and a flagged one cannot be paid', () => {
  it('shows the parts and the total exactly as quoted, with its validity as a date and time', () => {
    const model = quoteModel(quote(), LENDER, 'en');
    expect(say(model.attribution)).toBe(`Quotation from ${LENDER}, reference FQ-0001`);
    expect(say(model.asOf)).toBe('As of 18 Oct 2026, 10:30 IST');
    expect(say(model.validUntil)).toBe('Valid until 25 Oct 2026, 18:00 IST');
    expect(model.parts.map((p) => [say(p.label), p.value])).toEqual([
      ['Principal', '₹4,00,000'],
      ['Interest', '₹1,500'],
      ['Charges', '₹250'],
      ['Prepayment charge', '₹1,000'],
    ]);
    expect([say(model.total.label), model.total.value]).toEqual([
      `Total quoted by ${LENDER}`,
      '₹4,02,750',
    ]);
    expect(model.canPay).toBe(true);
    expect(model.mismatch).toBeNull();
    expect(sayAll(model).join('\n')).not.toMatch(
      /remaining|left|countdown|hurry|expires in|\bin \d+ (days|hours)/i,
    );
  });

  it('a quotation whose parts do not add up is flagged, shown as the lender stated it, and not payable', () => {
    const model = quoteModel(quote({ totalMismatch: true, totalMinor: 41_000_000 }), LENDER, 'en');
    expect(model.canPay).toBe(false);
    expect(model.mismatch && say(model.mismatch)).toBe(
      `The parts of this quotation do not add up to its total. Ask ${LENDER} for a corrected quotation. Payment is not offered for this quotation.`,
    );
    // The total is the lender's figure; the sum of the parts is shown nowhere.
    expect(model.total.value).toBe('₹4,10,000');
    expect(JSON.stringify(model)).not.toContain('4,02,750');
  });

  it('a payable quotation is the only one with a way to pay, which names the foreclosure purpose', () => {
    expect(quoteModel(quote(), LENDER, 'en').canPay).toBe(true);
    expect(hrefToUrl(payQuotationHref(LOAN_ID))).toBe(
      `/payments/pay?loanId=${LOAN_ID}&purpose=foreclosure`,
    );
  });

  it('labels a test quotation and passes on the letter’s document id', () => {
    const model = quoteModel(quote({ source: 'mock', letterDocumentId: DOC_ID }), LENDER, 'en');
    expect(model.notices.map((n) => say(n))).toEqual(['Test document. It is not a real document.']);
    expect(model.letterDocumentId).toBe(DOC_ID);
    expect(quoteModel(quote(), LENDER, 'en').letterDocumentId).toBeNull();
  });
});

describe('where the payment buttons go', () => {
  it('opens the payments screens with exactly the agreed parameters', () => {
    expect(hrefToUrl(payHref(LOAN_ID))).toBe(`/payments/pay?loanId=${LOAN_ID}`);
    expect(hrefToUrl(mandateSetupHref(LOAN_ID))).toBe(`/payments/mandate-setup?loanId=${LOAN_ID}`);
    expect(hrefToUrl(paymentStatusHref(PAYMENT_ID))).toBe(
      `/payments/status?paymentId=${PAYMENT_ID}`,
    );
    expect(payHref(LOAN_ID).pathname).toBe('/payments/pay');
    expect(mandateListHref).toBe('/payments');
    expect(payQuotationHref(LOAN_ID).params).toEqual({ loanId: LOAN_ID, purpose: 'foreclosure' });
  });
});

describe('closure: the lender’s statuses in this app’s own words', () => {
  it('says nothing has been reported while the closure is null', () => {
    const model = closureModel(null, LENDER, 'en');
    expect(model.kind).toBe('none');
    expect(model.kind === 'none' && say(model.notice)).toBe(
      `${LENDER} has not reported this loan as closed.`,
    );
  });

  it('shows a pending no-dues letter as the lender’s to issue, with a target date labelled a platform default', () => {
    const model = closureModel(closure(), LENDER, 'en');
    if (model.kind !== 'closed') throw new Error('expected a closure');
    expect(say(model.headline)).toBe(`${LENDER} has reported this loan as closed.`);
    expect(say(model.noc.line)).toBe(
      `${LENDER} has not yet reported that it issued the no-dues letter (NOC).`,
    );
    expect(model.noc.confirmed).toBe(false);
    expect(model.noc.due && say(model.noc.due)).toBe('Target date: 1 Nov 2026, 17:30 IST');
    expect(model.noc.dueNote).not.toBeNull();
    expect(model.noc.documentId).toBeNull();
  });

  it('says the letter was issued only when the key and the recorded status agree, and offers the file then', () => {
    const issued = closureModel(
      closure({
        nocStatus: 'issued',
        nocPromptKey: 'closure.noc.issued_by_lender',
        nocIssuedAt: '2026-10-20T06:00:00.000000+00:00',
        nocDocumentId: DOC_ID,
      }),
      LENDER,
      'en',
    );
    if (issued.kind !== 'closed') throw new Error('expected a closure');
    expect(say(issued.noc.line)).toBe(
      `${LENDER} has reported that it issued the no-dues letter (NOC).`,
    );
    expect(issued.noc.documentId).toBe(DOC_ID);
    expect(issued.noc.due).toBeNull();
    // A key that says issued while the status says pending is not believed.
    expect(
      nocLine(closure({ nocStatus: 'pending', nocPromptKey: 'closure.noc.issued_by_lender' }))
        .confirmed,
    ).toBe(false);
    expect(
      nocLine(closure({ nocStatus: 'issued', nocPromptKey: 'closure.noc.lender_to_issue' }))
        .confirmed,
    ).toBe(false);
  });

  it('no file is offered for a letter the lender has not issued', () => {
    const model = closureModel(closure({ nocDocumentId: DOC_ID }), LENDER, 'en');
    expect(model.kind === 'closed' && model.noc.documentId).toBeNull();
  });

  it('maps every security-release prompt key to wording, both pending and confirmed', () => {
    for (const type of SVC_COLLATERAL_TYPES) {
      const pending = securityLine(
        task({
          collateralType: type,
          promptKey: `closure.security_release.${type}.lender_to_release`,
        }),
        LENDER,
      );
      expect(pending.line.key, type).not.toBe('loans.closure.unknown');
      expect(pending.confirmed).toBe(false);
      expect(say(pending.line)).toContain(`${LENDER} has not yet confirmed`);
      const confirmed = securityLine(
        task({
          collateralType: type,
          status: 'confirmed_by_lender',
          lenderConfirmed: true,
          promptKey: `closure.security_release.${type}.lender_confirmed`,
        }),
        LENDER,
      );
      expect(confirmed.line.key, type).not.toBe('loans.closure.unknown');
      expect(confirmed.confirmed).toBe(true);
      expect(say(confirmed.line)).toMatch(new RegExp(`^${LENDER} has confirmed that it `));
    }
  });

  it('says "confirmed" only when the key, the status and the lender-confirmed flag all agree', () => {
    const key = 'closure.security_release.mutual_fund_lien.lender_confirmed';
    expect(securityLine(task({ promptKey: key }), LENDER).confirmed).toBe(false);
    expect(
      securityLine(task({ promptKey: key, lenderConfirmed: true, status: 'open' }), LENDER)
        .confirmed,
    ).toBe(false);
    expect(
      securityLine(
        task({ promptKey: key, lenderConfirmed: false, status: 'confirmed_by_lender' }),
        LENDER,
      ).confirmed,
    ).toBe(false);
    expect(
      securityLine(
        task({
          promptKey: 'closure.security_release.mutual_fund_lien.lender_to_release',
          lenderConfirmed: true,
          status: 'confirmed_by_lender',
        }),
        LENDER,
      ).confirmed,
    ).toBe(false);
  });

  it('an unknown or malformed key shows a neutral line and never the key', () => {
    for (const promptKey of [
      'closure.security_release.gold.lender_confirmed',
      'closure.security_release.mutual_fund_lien.something_else',
      'closure.security_release.x',
      'anything at all',
    ]) {
      const result = securityLine(task({ promptKey }), LENDER);
      expect(say(result.line), promptKey).toBe(`Ask ${LENDER} about the status of this item.`);
      expect(result.confirmed).toBe(false);
    }
    const model = closureModel(
      closure({
        nocPromptKey: 'closure.noc.mystery' as unknown as 'closure.noc.lender_to_issue',
        securityReleaseTasks: [
          task({ promptKey: 'closure.security_release.gold.lender_confirmed' }),
        ],
      }),
      LENDER,
      'en',
    );
    const rendered = sayAll(model).join('\n');
    expect(rendered).not.toMatch(/closure\.|security_release|mystery|gold/);
    expect(rendered).toContain(`Ask ${LENDER} about the status of this item.`);
  });

  it('never says that Udofin or this app released or issued anything', () => {
    const model = closureModel(
      closure({
        nocStatus: 'issued',
        nocPromptKey: 'closure.noc.issued_by_lender',
        nocIssuedAt: '2026-10-20T06:00:00.000000+00:00',
        securityReleaseTasks: SVC_COLLATERAL_TYPES.map((type) =>
          task({
            taskId: `0f0f0f0f-0000-4000-8000-0000000001${String(SVC_COLLATERAL_TYPES.indexOf(type)).padStart(2, '0')}`,
            collateralType: type,
            status: 'confirmed_by_lender',
            lenderConfirmed: true,
            promptKey: `closure.security_release.${type}.lender_confirmed`,
            confirmedAt: '2026-10-21T06:00:00.000000+00:00',
          }),
        ),
      }),
      LENDER,
      'en',
    );
    const text = sayAll(model).join('\n');
    expect(text).not.toMatch(/udofin/i);
    expect(text).not.toMatch(/\b(we|this app|the app) (released|issued|confirmed|verified)/i);
    expect(text).toContain('This app does not hold or release any security');
  });

  it('shows the lender’s delay reason as the lender’s words, only while the item is not confirmed', () => {
    const open = closureModel(
      closure({ securityReleaseTasks: [task({ delayReason: 'Awaiting the depository.' })] }),
      LENDER,
      'en',
    );
    expect(open.kind === 'closed' && open.security[0]?.delay?.text).toBe(
      'Awaiting the depository.',
    );
    const done = closureModel(
      closure({
        securityReleaseTasks: [
          task({
            delayReason: 'Awaiting the depository.',
            status: 'confirmed_by_lender',
            lenderConfirmed: true,
            promptKey: 'closure.security_release.mutual_fund_lien.lender_confirmed',
            confirmedAt: '2026-10-21T06:00:00.000000+00:00',
          }),
        ],
      }),
      LENDER,
      'en',
    );
    expect(done.kind === 'closed' && done.security[0]?.delay).toBeNull();
  });

  it('labels a target date as a platform default unless the API marks its basis confirmed, and never claims a regulation', () => {
    const open = closureModel(closure({ securityReleaseTasks: [task()] }), LENDER, 'en');
    if (open.kind !== 'closed') throw new Error('expected a closure');
    // The task's basis is confirmed: the date is shown as a target date, with no claim about a regulation.
    expect(open.security[0]?.dueNote).toBeNull();
    expect(open.security[0]?.due && say(open.security[0].due)).toBe(
      'Target date: 17 Nov 2026, 17:30 IST',
    );
    expect(sayAll(open).join('\n')).not.toMatch(/RBI|regulat.*(requires|period)|30 days/i);
    const unverified = closureModel(
      closure({
        securityReleaseTasks: [
          task({ dueBasis: { ruleKey: 'x', ruleVersion: 1, evidenceStatus: 'unverified' } }),
        ],
      }),
      LENDER,
      'en',
    );
    expect(unverified.kind === 'closed' && unverified.security[0]?.dueNote).not.toBeNull();
  });

  it('says when Udofin recorded the report, not when the lender closed the loan', () => {
    const model = closureModel(closure(), LENDER, 'en');
    expect(model.kind === 'closed' && say(model.recorded)).toBe(
      'Recorded in this app on 18 Oct 2026, 14:30 IST. This is not necessarily the date the lender closed the loan.',
    );
  });
});

describe('messages from lenders', () => {
  it('shows the lender’s words exactly as returned', () => {
    const wording =
      '  Sample Finance Ltd: ₹45,670 was due on 5 Nov 2026.\nLine two — as approved.  ';
    const model = reminderModel(reminder({ message: wording }), 'en');
    expect(model.message).toBe(wording);
  });

  it('shows the lender name, the kind, the dates and an unread marker that goes when read', () => {
    const model = reminderModel(reminder(), 'en');
    expect(say(model.lender)).toBe(`From ${LENDER}`);
    expect(say(model.kind)).toBe('Reminder before the due date');
    expect(say(model.due)).toBe('Due date: 5 Nov 2026');
    expect(say(model.sent)).toBe('Sent on 2 Nov 2026');
    expect(model.unread).toBe(true);
    expect(
      reminderModel(reminder({ readAt: '2026-11-02T05:00:00.000000+00:00' }), 'en').unread,
    ).toBe(false);
    expect(reminderModel(reminder(), 'en', new Set([reminder().reminderId])).unread).toBe(false);
  });

  it('has wording for every kind and a neutral line for an unknown one or a missing lender', () => {
    for (const kind of SVC_REMINDER_KINDS) {
      expect(reminderModel(reminder({ kind }), 'en').kind.key, kind).not.toBe(
        'reminders.kind.unknown',
      );
    }
    const odd = reminderModel(
      reminder({ kind: 'mystery' as unknown as 'pre_due', lenderDisplayName: null }),
      'en',
    );
    expect(say(odd.kind)).toBe('Message from a lender');
    expect(say(odd.lender)).toBe('From a lender');
  });

  it('counts only unread messages', () => {
    const a = reminder({ reminderId: '0f0f0f0f-0000-4000-8000-0000000000c1' });
    const b = reminder({
      reminderId: '0f0f0f0f-0000-4000-8000-0000000000c2',
      readAt: '2026-11-02T05:00:00.000000+00:00',
    });
    const c = reminder({ reminderId: '0f0f0f0f-0000-4000-8000-0000000000c3' });
    expect(unreadReminderCount([a, b, c])).toBe(2);
    expect(unreadReminderCount([a, b, c], new Set([a.reminderId]))).toBe(1);
    expect(unreadReminderCount([])).toBe(0);
  });

  it('asks the API to mark a message read only when it is unread and not already being marked', () => {
    expect(shouldMarkRead({ id: 'a', unread: true }, new Set())).toBe(true);
    expect(shouldMarkRead({ id: 'a', unread: false }, new Set())).toBe(false);
    expect(shouldMarkRead({ id: 'a', unread: true }, new Set(['a']))).toBe(false);
  });
});

describe('the home screen entry and the document check', () => {
  it('"My loans" appears only when there is at least one loan', () => {
    expect(hasAnyLoan({ items: [] })).toBe(false);
    expect(hasAnyLoan({ items: [loan()] })).toBe(true);
  });

  it('opens a file only when it is the one asked for and has the recorded size', () => {
    const content = { documentId: DOC_ID, loanId: LOAN_ID, sizeBytes: 3, contentBase64: 'AAAA' };
    const expected = { loanId: LOAN_ID, documentId: DOC_ID };
    expect(documentContentProblem(content, expected, base64ByteLength)).toBeNull();
    expect(
      documentContentProblem({ ...content, documentId: OTHER_ID }, expected, base64ByteLength),
    ).toBe('wrong_document');
    expect(
      documentContentProblem({ ...content, loanId: OTHER_ID }, expected, base64ByteLength),
    ).toBe('wrong_document');
    expect(documentContentProblem({ ...content, sizeBytes: 4 }, expected, base64ByteLength)).toBe(
      'size_mismatch',
    );
    expect(
      documentContentProblem({ ...content, contentBase64: '%%%%' }, expected, base64ByteLength),
    ).toBe('size_mismatch');
  });

  it('tells the borrower nothing when the viewer opened the file, and the plain reason otherwise', () => {
    expect(openOutcomeKey('opened')).toBeNull();
    expect(openOutcomeKey('no_viewer')).toBe('loans.doc.noViewer');
    expect(openOutcomeKey('failed')).toBe('loans.doc.openFailed');
  });
});

describe('no raw vocabulary value reaches the screen', () => {
  it('writes no snake_case code or contract value in any line of any model', () => {
    const models: unknown[] = [
      loanHomeModel(overdueLoan(), 'en'),
      loanHomeModel(withheldLoan(), 'en'),
      loanHomeModel(loan({ loanStatus: 'written_off', reportedStatus: 'foreclosed' }), 'en'),
      loanCardModel(loan({ stale: true }), 'en'),
      ...SVC_ACTIVITY_STATES.map((state) => activityRowModel(entry({ state }), LENDER, 'en')),
      ...SVC_REQUEST_STATUSES.map((status) => requestRowModel(request({ status }), LENDER, 'en')),
      ...SVC_DOCUMENT_KINDS.map((kind) => documentRowModel(document({ kind }), LENDER, 'en')),
      quoteModel(quote({ totalMismatch: true }), LENDER, 'en'),
      closureModel(closure({ securityReleaseTasks: [task()] }), LENDER, 'en'),
      ...SVC_REMINDER_KINDS.map((kind) => reminderModel(reminder({ kind }), 'en')),
    ];
    for (const model of models) {
      for (const language of ['en', 'hi'] as const) {
        for (const line of sayAll(model, language)) {
          expect(line).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
          expect(line).not.toMatch(/\{|\}/);
        }
      }
    }
  });

  it('has an English and a Hindi sentence for every message the models use', () => {
    const keys = new Set<string>();
    const models: unknown[] = [
      loanHomeModel(overdueLoan(), 'en'),
      loanHomeModel(withheldLoan(), 'en'),
      ...SVC_ACTIVITY_STATES.map((state) => activityRowModel(entry({ state }), LENDER, 'en')),
      ...SVC_REQUEST_STATUSES.map((status) => requestRowModel(request({ status }), LENDER, 'en')),
      closureModel(closure({ securityReleaseTasks: [task()] }), LENDER, 'en'),
    ];
    for (const model of models) for (const ref of allRefs(model)) keys.add(ref.key);
    expect(keys.size).toBeGreaterThan(30);
    for (const key of keys) expect(key in hi, key).toBe(true);
  });
});

describe('wording of the whole feature (English and Hindi, draft)', () => {
  const ownKeys = (Object.keys(en) as MessageKey[]).filter(
    (k) => k.startsWith('loans.') || k.startsWith('reminders.'),
  );

  it('has a good number of keys of its own, all in both languages', () => {
    expect(ownKeys.length).toBeGreaterThan(150);
    for (const key of ownKeys) expect(key in hi, key).toBe(true);
  });

  it('fills every placeholder in both languages', () => {
    for (const key of ownKeys) {
      const vars = Object.fromEntries(
        [...en[key].matchAll(/\{(\w+)\}/g)].map((m) => [m[1] ?? '', 'X']),
      );
      for (const language of ['en', 'hi'] as const) {
        expect(translate(language, key, vars), `${language} ${key}`).not.toMatch(/\{|\}/);
      }
    }
  });

  it('uses no urgency, marketing, approval or compliance wording in English', () => {
    const banned =
      /\b(paid|successful(ly)?|approved|verified|guarantee[ds]?|compliant|compliance|safe|secured?|urgent(ly)?|hurry|last chance|immediately|countdown|expires in|only today|offers?|discounts?|rewards?|congratulations|act now|don't miss|final notice|default(ed|er)?s?)\b/i;
    for (const key of ownKeys) {
      // "platform default" is the honest label for a target date; "default" is the only allowed use of the word.
      const text = en[key].replace(/platform default/g, 'platform setting');
      expect(text, key).not.toMatch(banned);
    }
  });

  it('uses no word for paid, successful, approved or verified in Hindi either', () => {
    for (const key of ownKeys)
      expect(hi[key], key).not.toMatch(/सफल|चुका|सत्यापित|अनुमोदित|गारंटी/);
  });

  it('never has Udofin or the app claim to have released, issued or approved anything', () => {
    for (const key of ownKeys.filter((k) => k.startsWith('loans.closure.'))) {
      expect(en[key], key).not.toMatch(/udofin/i);
      expect(en[key], key).not.toMatch(
        /\b(we|this app|the app) (released|issued|approved|verified)\b/i,
      );
    }
  });

  it('every "confirmed" closure sentence is the lender’s statement', () => {
    for (const key of ownKeys.filter((k) => k.endsWith('.confirmed'))) {
      expect(en[key], key).toMatch(/^\{lender\} has confirmed that it /);
    }
    for (const key of ownKeys.filter((k) => k.endsWith('.pending') && k.includes('.sec.'))) {
      expect(en[key], key).toContain('has not yet confirmed');
    }
  });

  it('says that a received payment is not yet a posted one', () => {
    expect(en['loans.state.provider_received']).toContain('does not yet mean');
    expect(en['loans.state.lender_posted']).toBe('{lender} has posted it to your loan.');
  });
});
