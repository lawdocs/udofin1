import { createRequire } from 'node:module';
import type { KfsDataV1, RenderModel, RenderTemplateBody } from '@udofin/contracts';
import PDFDocument from 'pdfkit';

/**
 * Renders the lender's approved content into a PDF. It prints the figures the lender supplied exactly as given
 * (integer paise become rupees and paise by moving the decimal point, basis points become a percentage the same way);
 * it never calculates, rounds or corrects anything. Wording comes from the approved template; Udofin writes no
 * legal text. Latin and Devanagari text use separate Noto fonts (SIL Open Font Licence), chosen per character, so
 * conjuncts are shaped and the rupee sign renders.
 */
export class RenderError extends Error {
  override readonly name = 'RenderError';
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RenderOptions {
  /** Stamped in the file's metadata; passed in so the same input renders the same file. */
  generatedAt: Date;
}

const require = createRequire(import.meta.url);
const FONT_FILES = {
  lat: '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
  latBold: '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff',
  dev: '@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.woff',
  devBold: '@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-700-normal.woff',
} as const;

// ---------------------------------------------------------------------------------------------
// Formatting: presentation only. No arithmetic on the lender's figures beyond moving a decimal point.
// ---------------------------------------------------------------------------------------------
const pad2 = (n: number) => (n < 10 ? `0${String(n)}` : String(n));

/** Indian digit grouping (12,34,567). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

export function formatRupees(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RenderError('amount_invalid');
  const rupees = Math.trunc(minor / 100);
  return `₹ ${groupIndian(String(rupees))}.${pad2(minor % 100)}`;
}

export function formatPercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new RenderError('rate_invalid');
  return `${String(Math.trunc(bps / 100))}.${pad2(bps % 100)} %`;
}

export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RenderError('date_invalid');
  return `${m[3] ?? ''}/${m[2] ?? ''}/${m[1] ?? ''}`;
}

export function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RenderError('date_invalid');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} IST`;
}

// ---------------------------------------------------------------------------------------------
// Labels: the approved template's words. English has built-in value words; another language must supply every one.
// ---------------------------------------------------------------------------------------------
const ENGLISH_VALUE_WORDS: Readonly<Record<string, string>> = {
  v_upfront: '100% upfront',
  v_staged: 'In stages',
  v_epi: 'Equated periodic instalments (EPI)',
  v_non_equated: 'Non-equated instalments',
  v_fixed: 'Fixed',
  v_floating: 'Floating',
  v_hybrid: 'Hybrid',
  v_monthly: 'Monthly',
  v_fortnightly: 'Fortnightly',
  v_weekly: 'Weekly',
  v_days: 'days',
  v_months: 'months',
  v_years: 'years',
  v_one_time: 'One-time',
  v_recurring: 'Recurring',
  v_processing: 'Processing fees',
  v_insurance: 'Insurance charges',
  v_valuation: 'Valuation fees',
  v_other: 'Any other (as specified)',
  v_clause: 'Clause',
  v_ddmmyyyy: 'DD/MM/YYYY',
  v_rounding: 'Note from the lender on rounding',
  v_borrower_ref: 'Borrower reference',
  v_borrower_name: "Borrower (as per the lender's records)",
  v_proposal: 'Proposal number',
  v_lender: 'Lender',
  v_digest: 'KFS content digest (SHA-256)',
  v_summary_box: 'Key Facts Statement (summary box)',
  v_kfs_valid: 'KFS valid until',
  v_phone: 'Phone',
  v_email: 'Email',
  v_blended: 'Blended rate of interest',
  v_orig_re: 'Originating RE and funding proportion',
  v_partner_re: 'Partner RE and funding proportion',
  v_page: 'Page',
  v_of: 'of',
  yes: 'Yes',
  no: 'No',
  na: 'Not applicable',
  none: 'None',
  amount_or_pct: 'Amount or percentage',
  frequency: 'Frequency',
  item: 'Item',
  nbfc_a: 'Payable to the lender (A)',
  third_b: 'Payable to a third party through the lender (B)',
};

type Labels = (key: string) => string;

function makeLabels(body: RenderTemplateBody, language: 'en' | 'hi'): Labels {
  const own = { ...(body.labels ?? {}), ...(body.labels2 ?? {}) };
  return (key) => {
    const v = own[key] ?? (language === 'en' ? ENGLISH_VALUE_WORDS[key] : undefined);
    if (v === undefined) throw new RenderError(`label_missing:${key}`);
    return v;
  };
}

// ---------------------------------------------------------------------------------------------
// Text layout with per-character font choice
// ---------------------------------------------------------------------------------------------
type FontKey = 'lat' | 'dev';
interface Run {
  font: FontKey;
  text: string;
}

const isDevanagari = (cp: number) =>
  (cp >= 0x0900 && cp <= 0x097f) ||
  (cp >= 0x1cd0 && cp <= 0x1cff) ||
  (cp >= 0xa8e0 && cp <= 0xa8ff) ||
  cp === 0x20b9 ||
  cp === 0x25cc;

export function splitRuns(value: string): Run[] {
  const runs: Run[] = [];
  let current: FontKey = 'lat';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    let font: FontKey;
    if (isDevanagari(cp)) font = 'dev';
    else if (cp === 0x200c || cp === 0x200d || ch === ' ' || ch === '\n') font = current;
    else font = 'lat';
    const last = runs.at(-1);
    if (last && last.font === font) last.text += ch;
    else runs.push({ font, text: ch });
    current = font;
  }
  return runs;
}

const MARGIN = 40;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - 56;
const INK = '#111111';
const MUTED = '#555555';
const RULE = '#9a9a9a';
const SHADE = '#eeeeee';

interface Line {
  runs: Run[];
  width: number;
}

class Canvas {
  readonly doc: InstanceType<typeof PDFDocument>;
  y = MARGIN;
  constructor(
    private readonly running: string,
    info: { title: string; author: string; created: Date },
  ) {
    this.doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: info.title,
        Author: info.author,
        Creator: 'Udofin document service',
        Producer: 'Udofin document service',
        CreationDate: info.created,
      },
    });
    this.doc.registerFont('lat', require.resolve(FONT_FILES.lat));
    this.doc.registerFont('latBold', require.resolve(FONT_FILES.latBold));
    this.doc.registerFont('dev', require.resolve(FONT_FILES.dev));
    this.doc.registerFont('devBold', require.resolve(FONT_FILES.devBold));
  }

  private face(font: FontKey, bold: boolean): string {
    return bold ? `${font}Bold` : font;
  }

  private measure(runs: Run[], size: number, bold: boolean): number {
    let w = 0;
    for (const r of runs)
      w += this.doc.font(this.face(r.font, bold)).fontSize(size).widthOfString(r.text);
    return w;
  }

  wrap(value: string, width: number, size: number, bold = false): Line[] {
    const lines: Line[] = [];
    for (const paragraph of value.split('\n')) {
      const words = paragraph.split(' ').filter((w) => w.length > 0);
      if (words.length === 0) {
        lines.push({ runs: [], width: 0 });
        continue;
      }
      let cur: Run[] = [];
      let curW = 0;
      const space = this.measure([{ font: 'lat', text: ' ' }], size, bold);
      const flush = () => {
        lines.push({ runs: cur, width: curW });
        cur = [];
        curW = 0;
      };
      const push = (runs: Run[], w: number, withSpace: boolean) => {
        if (withSpace && cur.length > 0) {
          cur.push({ font: 'lat', text: ' ' });
          curW += space;
        }
        cur.push(...runs);
        curW += w;
      };
      for (const word of words) {
        const runs = splitRuns(word);
        const w = this.measure(runs, size, bold);
        if (w > width) {
          // A single word wider than the column is broken by characters.
          if (cur.length > 0) flush();
          for (const ch of word) {
            const cr = splitRuns(ch);
            const cw = this.measure(cr, size, bold);
            if (curW + cw > width && cur.length > 0) flush();
            push(cr, cw, false);
          }
          continue;
        }
        if (curW > 0 && curW + space + w > width) flush();
        push(runs, w, true);
      }
      if (cur.length > 0) flush();
    }
    return lines;
  }

  lineHeight(size: number): number {
    return size * 1.45;
  }

  private drawLine(
    line: Line,
    x: number,
    y: number,
    size: number,
    bold: boolean,
    color: string,
    align: 'left' | 'right' | 'center',
    width: number,
  ): void {
    let cx = x;
    if (align === 'right') cx = x + width - line.width;
    if (align === 'center') cx = x + (width - line.width) / 2;
    this.doc.fillColor(color);
    for (const r of line.runs) {
      this.doc
        .font(this.face(r.font, bold))
        .fontSize(size)
        .text(r.text, cx, y, { lineBreak: false });
      cx += this.doc.widthOfString(r.text);
    }
  }

  textHeight(value: string, width: number, size: number, bold = false): number {
    return this.wrap(value, width, size, bold).length * this.lineHeight(size);
  }

  newPage(): void {
    this.doc.addPage();
    this.y = MARGIN;
    this.drawRunningHeader();
  }

  private drawRunningHeader(): void {
    this.drawText(this.running, MARGIN, this.y, CONTENT_W, 8, false, MUTED);
    this.y += this.lineHeight(8) + 6;
  }

  start(): void {
    this.drawRunningHeader();
  }

  ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  drawText(
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    bold = false,
    color = INK,
    align: 'left' | 'right' | 'center' = 'left',
  ): number {
    const lines = this.wrap(value, width, size, bold);
    let cy = y;
    for (const l of lines) {
      this.drawLine(l, x, cy, size, bold, color, align, width);
      cy += this.lineHeight(size);
    }
    return cy - y;
  }

  /** A block of text at the current position; moves down and breaks pages between lines. */
  paragraph(value: string, size = 9.5, bold = false, color = INK, gap = 4): void {
    const lines = this.wrap(value, CONTENT_W, size, bold);
    for (const l of lines) {
      this.ensure(this.lineHeight(size));
      this.drawLine(l, MARGIN, this.y, size, bold, color, 'left', CONTENT_W);
      this.y += this.lineHeight(size);
    }
    this.y += gap;
  }

  heading(value: string, size = 12): void {
    this.ensure(this.lineHeight(size) * 2);
    this.y += 4;
    this.paragraph(value, size, true, INK, 4);
  }

  /** A bordered table. `widths` are fractions of the content width. */
  table(
    header: string[] | null,
    rows: string[][],
    widths: number[],
    opts: { size?: number; shadeFirstColumn?: boolean } = {},
  ): void {
    const size = opts.size ?? 8.5;
    const pad = 4;
    const colW = widths.map((w) => w * CONTENT_W);
    const drawRow = (cells: string[], bold: boolean, shade: boolean): void => {
      const heights = cells.map((c, i) =>
        this.textHeight(c, (colW[i] ?? 50) - 2 * pad, size, bold),
      );
      const h = Math.max(...heights, this.lineHeight(size)) + 2 * pad;
      this.ensure(h);
      let x = MARGIN;
      cells.forEach((c, i) => {
        const w = colW[i] ?? 50;
        if (shade || (opts.shadeFirstColumn && i === 0)) this.doc.rect(x, this.y, w, h).fill(SHADE);
        this.doc.lineWidth(0.5).strokeColor(RULE).rect(x, this.y, w, h).stroke();
        this.drawText(c, x + pad, this.y + pad, w - 2 * pad, size, bold);
        x += w;
      });
      this.y += h;
    };
    if (header) drawRow(header, true, true);
    for (const r of rows) {
      if (this.y + this.lineHeight(size) * 3 > BOTTOM) {
        this.newPage();
        if (header) drawRow(header, true, true);
      }
      drawRow(r, false, false);
    }
    this.y += 8;
  }

  box(lines: string[]): void {
    const size = 9;
    const heights = lines.map((l) => this.textHeight(l, CONTENT_W - 16, size));
    const h = heights.reduce((a, b) => a + b, 0) + 12;
    this.ensure(h);
    this.doc.lineWidth(1).strokeColor(INK).rect(MARGIN, this.y, CONTENT_W, h).stroke();
    let cy = this.y + 6;
    for (const l of lines) cy += this.drawText(l, MARGIN + 8, cy, CONTENT_W - 16, size);
    this.y += h + 8;
  }

  /** Writes the page footer on every page, then ends the document and returns its bytes. */
  finish(footer: (page: number, total: number) => string): Promise<Uint8Array> {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      const prev = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      this.drawText(footer(i + 1, range.count), MARGIN, PAGE_H - 36, CONTENT_W, 7.5, false, MUTED);
      this.doc.page.margins.bottom = prev;
    }
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => chunks.push(c));
      this.doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The KFS body (Annex I Part 1, computation sheet, schedule, Part 2)
// ---------------------------------------------------------------------------------------------
function wordFor(L: Labels, prefix: string, key: string): string {
  return L(`${prefix}${key}`);
}

function chargeText(L: Labels, c: KfsDataV1['contingent']['penalDelayed']): string {
  const parts: string[] = [];
  if (c.amountMinor !== undefined) parts.push(formatRupees(c.amountMinor));
  if (c.percentBps !== undefined) parts.push(formatPercent(c.percentBps));
  if (c.text) parts.push(c.text);
  if (parts.length === 0) return L('na');
  return parts.join(' · ');
}

function feeAmount(f: KfsDataV1['fees'][number]): string {
  if (f.amountMinor !== undefined) return formatRupees(f.amountMinor);
  if (f.percentBps !== undefined) return formatPercent(f.percentBps);
  throw new RenderError('fee_invalid');
}

function feeTiming(L: Labels, f: KfsDataV1['fees'][number]): string {
  return f.timing === 'recurring'
    ? `${L('v_recurring')}${f.frequency ? ` (${f.frequency})` : ''}`
    : L('v_one_time');
}

function instalmentCell(L: Labels, d: KfsDataV1): string[] {
  const i = d.instalments;
  return [
    `${wordFor(L, 'v_', i.type)} (${wordFor(L, 'v_', i.frequency)})`,
    String(i.count),
    i.amountMinor !== undefined ? formatRupees(i.amountMinor) : L('na'),
    `${String(i.commencementDaysAfterSanction)} ${L('v_days')}`,
  ];
}

function renderPart1(c: Canvas, L: Labels, d: KfsDataV1, proposalNo: string): void {
  c.heading(L('part1'));
  const rows: string[][] = [
    ['1', L('p1_1'), proposalNo],
    ['', L('p1_1b'), d.loanType],
    ['2', L('p1_2'), formatRupees(d.sanctionedAmountMinor)],
    [
      '3',
      L('p1_3'),
      d.disbursal.mode === 'staged'
        ? `${L('v_staged')}${d.disbursal.stagedClauseRef ? ` — ${L('v_clause')} ${d.disbursal.stagedClauseRef}` : ''}`
        : L('v_upfront'),
    ],
    ['4', L('p1_4'), `${String(d.loanTerm.value)} ${wordFor(L, 'v_', d.loanTerm.unit)}`],
    ['6', L('p1_6'), `${formatPercent(d.interest.rateBps)} — ${wordFor(L, 'v_', d.interest.type)}`],
    ['9', L('p1_9'), formatPercent(d.aprBps)],
  ];
  c.table(null, rows.slice(0, 5), [0.06, 0.44, 0.5], { shadeFirstColumn: false });
  // Item 5: instalment details
  c.paragraph(`5. ${L('p1_5')}`, 9, true);
  c.table(
    [L('p1_5_type'), L('p1_5_count'), L('p1_5_amount'), L('p1_5_commence')],
    [instalmentCell(L, d)],
    [0.34, 0.16, 0.2, 0.3],
  );
  c.table(null, rows.slice(5, 6), [0.06, 0.44, 0.5]);
  // Item 7: floating-rate information
  c.paragraph(`7. ${L('p1_7')}`, 9, true);
  if (d.interest.type !== 'fixed' && d.floating) {
    const f = d.floating;
    c.table(
      [L('p1_7_ref'), L('p1_7_b'), L('p1_7_s'), L('p1_7_r'), L('p1_7_reset'), L('p1_7_impact')],
      [
        [
          f.referenceBenchmark,
          formatPercent(f.benchmarkRateBps),
          formatPercent(f.spreadBps),
          formatPercent(f.finalRateBps),
          String(f.resetPeriodicityMonths),
          `B: ${formatRupees(f.impactOf25bps.epiOnBenchmarkMinor)} / ${String(f.impactOf25bps.epiCountOnBenchmark)}; S: ${formatRupees(f.impactOf25bps.epiOnSpreadMinor)} / ${String(f.impactOf25bps.epiCountOnSpread)}`,
        ],
      ],
      [0.18, 0.12, 0.12, 0.14, 0.12, 0.32],
      { size: 8 },
    );
  } else {
    c.paragraph(L('na'), 9);
  }
  // Item 8: fees and charges, split by who receives them
  c.paragraph(`8. ${L('p1_8')}`, 9, true);
  const categories: [string, string][] = [
    ['processing', 'v_processing'],
    ['insurance', 'v_insurance'],
    ['valuation', 'v_valuation'],
    ['other', 'v_other'],
  ];
  const feeRows = categories.map(([cat, word]) => {
    const lines = d.fees.filter((f) => f.category === cat);
    const side = (payee: 'lender' | 'third_party') => {
      const own = lines.filter((f) => f.payee === payee);
      if (own.length === 0) return ['—', '—'];
      return [
        own.map((f) => `${f.label}: ${feeTiming(L, f)}`).join('\n'),
        own.map(feeAmount).join('\n'),
      ];
    };
    const a = side('lender');
    const b = side('third_party');
    return [L(word), a[0] ?? '—', a[1] ?? '—', b[0] ?? '—', b[1] ?? '—'];
  });
  c.table(
    [
      L('item'),
      `${L('p1_8_a')} — ${L('v_one_time')}/${L('v_recurring')}`,
      L('amount_or_pct'),
      `${L('p1_8_b')} — ${L('v_one_time')}/${L('v_recurring')}`,
      L('amount_or_pct'),
    ],
    feeRows,
    [0.2, 0.22, 0.16, 0.26, 0.16],
    { size: 8 },
  );
  if (d.fees.length === 0) c.paragraph(L('none'), 9);
  c.table(null, [['9', L('p1_9'), formatPercent(d.aprBps)]], [0.06, 0.44, 0.5]);
  c.paragraph(`10. ${L('p1_10')}`, 9, true);
  const k = d.contingent;
  c.table(
    null,
    [
      ['(i)', L('p1_10_i'), chargeText(L, k.penalDelayed)],
      ['(ii)', L('p1_10_ii'), chargeText(L, k.otherPenal)],
      ['(iii)', L('p1_10_iii'), chargeText(L, k.foreclosure)],
      ['(iv)', L('p1_10_iv'), chargeText(L, k.switching)],
      [
        '(v)',
        L('p1_10_v'),
        (k.other ?? []).length > 0
          ? (k.other ?? []).map((o) => chargeText(L, o)).join('\n')
          : L('na'),
      ],
    ],
    [0.08, 0.5, 0.42],
  );
}

function renderSheet(c: Canvas, L: Labels, d: KfsDataV1): void {
  c.heading(L('sheet'));
  const x = d.computation;
  const rows: string[][] = [
    ['1', L('p1_2'), formatRupees(d.sanctionedAmountMinor)],
    ['2', L('p1_4'), `${String(d.loanTerm.value)} ${wordFor(L, 'v_', d.loanTerm.unit)}`],
    ['3', L('p1_5'), instalmentCell(L, d).join(' · ')],
    ['4', L('p1_6'), `${formatPercent(d.interest.rateBps)} — ${wordFor(L, 'v_', d.interest.type)}`],
    ['5', L('sheet_interest'), formatRupees(x.totalInterestMinor)],
    ['6', L('sheet_fees'), formatRupees(x.feesTotalMinor)],
    ['  A', L('p1_8_a'), formatRupees(x.feesToLenderMinor)],
    ['  B', L('p1_8_b'), formatRupees(x.feesToThirdPartyMinor)],
    ['7', L('sheet_net'), formatRupees(x.netDisbursedMinor)],
    ['8', L('sheet_total'), formatRupees(x.totalPayableMinor)],
    ['9', L('p1_9'), formatPercent(d.aprBps)],
    ['10', L('sheet_disbursal'), x.scheduleOfDisbursement],
    ['11', L('sch_date'), L('v_ddmmyyyy')],
  ];
  c.table(null, rows, [0.07, 0.5, 0.43]);
  if (x.roundingNote) c.paragraph(`${L('v_rounding')}: ${x.roundingNote}`, 8.5, false, MUTED);
}

function renderSchedule(c: Canvas, L: Labels, d: KfsDataV1): void {
  c.heading(L('schedule'));
  c.table(
    [
      L('sch_no'),
      L('sch_date'),
      L('sch_outstanding'),
      L('sch_principal'),
      L('sch_interest'),
      L('sch_instalment'),
    ],
    d.schedule.map((r) => [
      String(r.no),
      formatDate(r.dueDate),
      formatRupees(r.outstandingPrincipalMinor),
      formatRupees(r.principalMinor),
      formatRupees(r.interestMinor),
      formatRupees(r.instalmentMinor),
    ]),
    [0.1, 0.16, 0.22, 0.17, 0.17, 0.18],
    { size: 8 },
  );
}

function renderPart2(c: Canvas, L: Labels, d: KfsDataV1): void {
  c.heading(L('part2'));
  const p = d.part2;
  const rows: string[][] = [
    ['1', L('p2_1'), `${L('v_clause')} ${p.recoveryAgentClauseRef}`],
    ['2', L('p2_2'), `${L('v_clause')} ${p.grievanceClauseRef}`],
    [
      '3',
      L('p2_3'),
      `${L('v_phone')}: ${p.nodalOfficerPhone}\n${L('v_email')}: ${p.nodalOfficerEmail}`,
    ],
    ['4', L('p2_4'), p.transferOrSecuritisation ? L('yes') : L('no')],
    [
      '5',
      L('p2_5'),
      p.collaborativeLending
        ? `${L('v_orig_re')}: ${p.collaborativeLending.originatingRe} (${formatPercent(p.collaborativeLending.originatingFundingPercentBps)})\n${L('v_partner_re')}: ${p.collaborativeLending.partnerRe} (${formatPercent(p.collaborativeLending.partnerFundingPercentBps)})\n${L('v_blended')}: ${formatPercent(p.collaborativeLending.blendedRateBps)}`
        : L('na'),
    ],
    [
      '6',
      L('p2_6'),
      `${String(p.digital.coolingOffDays)} ${L('v_days')}${p.digital.coolingOffNote ? `\n${p.digital.coolingOffNote}` : ''}${p.digital.lspRecoveryAgent ? `\n${p.digital.lspRecoveryAgent}` : ''}`,
    ],
  ];
  c.table(null, rows, [0.06, 0.5, 0.44]);
}

function placeholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([A-Za-z]+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new RenderError(`placeholder_unknown:${key}`);
    return v;
  });
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------
export async function renderDocument(
  model: RenderModel,
  options: RenderOptions,
): Promise<Uint8Array> {
  const body = model.template.body;
  const language = model.language;
  const L = makeLabels(body, language);
  const d = model.data;
  const lenderName = model.lender.legalName;
  const running = `${lenderName} · ${L('v_proposal')} ${model.proposalNo}`;

  if (model.documentType === 'kfs') {
    if (body.engine !== 'annex_i_v1') throw new RenderError('template_engine_mismatch');
    if (!model.validity) throw new RenderError('validity_missing');
    const c = new Canvas(running, {
      title: `${L('title')} ${model.proposalNo}`,
      author: lenderName,
      created: options.generatedAt,
    });
    c.start();
    c.drawText(L('title'), MARGIN, c.y, CONTENT_W, 18, true);
    c.y += c.lineHeight(18);
    c.paragraph(L('subtitle'), 10, false, MUTED, 6);
    c.box([
      `${L('v_lender')}: ${lenderName}`,
      `${L('v_proposal')}: ${model.proposalNo}`,
      ...(model.udofinReference ? [`${L('v_borrower_ref')}: ${model.udofinReference}`] : []),
      ...(d.borrowerNameAsPerLender
        ? [`${L('v_borrower_name')}: ${d.borrowerNameAsPerLender}`]
        : []),
      `${L('validity')}: ${L('valid_from')} ${formatInstant(model.validity.from)} — ${L('valid_until')} ${formatInstant(model.validity.until)}`,
    ]);
    renderPart1(c, L, d, model.proposalNo);
    renderSheet(c, L, d);
    renderSchedule(c, L, d);
    renderPart2(c, L, d);
    c.paragraph(L('footer_lender'), 8.5, false, MUTED);
    return c.finish(
      (p, t) =>
        `${L('v_proposal')} ${model.proposalNo} · ${lenderName} · ${L('v_page')} ${String(p)} ${L('v_of')} ${String(t)}`,
    );
  }

  // Loan agreement: the lender's approved sections, then the KFS as a summary box built from the same data.
  if (body.engine !== 'agreement_v1') throw new RenderError('template_engine_mismatch');
  if (!model.kfsDocument || !model.kfsTemplate) throw new RenderError('kfs_missing');
  if (model.kfsDocument.contentDigest !== model.contentDigest)
    throw new RenderError('summary_box_mismatch');
  const KL = makeLabels(model.kfsTemplate, language);
  const values: Record<string, string> = {
    lenderName,
    proposalNo: model.proposalNo,
    sanctionedAmount: formatRupees(d.sanctionedAmountMinor),
    tenure: `${String(d.loanTerm.value)} ${wordFor(L, 'v_', d.loanTerm.unit)}`,
    apr: formatPercent(d.aprBps),
    udofinReference: model.udofinReference ?? '',
    borrowerName: d.borrowerNameAsPerLender ?? '',
  };
  const title = body.title ?? 'Loan agreement';
  const c = new Canvas(running, {
    title: `${title} ${model.proposalNo}`,
    author: lenderName,
    created: options.generatedAt,
  });
  c.start();
  c.drawText(title, MARGIN, c.y, CONTENT_W, 18, true);
  c.y += c.lineHeight(18) + 4;
  c.box([
    `${L('v_lender')}: ${lenderName}`,
    `${L('v_proposal')}: ${model.proposalNo}`,
    ...(model.udofinReference ? [`${L('v_borrower_ref')}: ${model.udofinReference}`] : []),
    ...(d.borrowerNameAsPerLender ? [`${L('v_borrower_name')}: ${d.borrowerNameAsPerLender}`] : []),
  ]);
  for (const s of body.sections ?? []) {
    c.heading(placeholders(s.heading, values), 11);
    c.paragraph(placeholders(s.text, values));
  }
  c.newPage();
  c.heading(L('v_summary_box'), 13);
  c.box([`${L('v_proposal')}: ${model.proposalNo}`, `${L('v_digest')}: ${model.contentDigest}`]);
  renderPart1(c, KL, d, model.proposalNo);
  renderSheet(c, KL, d);
  renderPart2(c, KL, d);
  return c.finish(
    (p, t) =>
      `${L('v_proposal')} ${model.proposalNo} · ${lenderName} · ${L('v_page')} ${String(p)} ${L('v_of')} ${String(t)}`,
  );
}
