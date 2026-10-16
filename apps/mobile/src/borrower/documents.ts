import { type ApplicationDocuments, type KfsDataV1, type KfsView } from '@udofin/contracts';
import { type MessageKey } from '../i18n';
import { formatRupees } from './money';
import { formatAprBps } from './routing';

/** The sections of the KFS the borrower reviews and the acknowledgement refers to (RBC Directions 2025, Annex I). */
export type KfsSectionKey = 'part1' | 'apr_sheet' | 'schedule' | 'part2';
export const KFS_SECTIONS: readonly KfsSectionKey[] = ['part1', 'apr_sheet', 'schedule', 'part2'];

export interface Row {
  labelKey: MessageKey;
  value: string;
}

const rupees = (paise: number) => `₹${formatRupees(paise)}`;
const unit = (u: 'days' | 'months' | 'years') => `kfs.unit.${u}` as MessageKey;

/**
 * The lender's own figures as readable rows. Money and rates are shown exactly as stored (integer paise and basis points
 * moved by a decimal point); nothing is calculated, rounded or corrected. Words that depend on language come from the
 * message catalogue through `word`, never from this file.
 */
export function kfsRows(
  data: KfsDataV1,
  word: (key: MessageKey, vars?: Record<string, string | number>) => string,
): Record<KfsSectionKey, Row[]> {
  const i = data.instalments;
  const part1: Row[] = [
    { labelKey: 'kfs.row.loanType', value: data.loanType },
    { labelKey: 'kfs.row.sanctioned', value: rupees(data.sanctionedAmountMinor) },
    {
      labelKey: 'kfs.row.disbursal',
      value:
        data.disbursal.mode === 'upfront'
          ? word('kfs.disbursal.upfront')
          : word('kfs.disbursal.staged', { clause: data.disbursal.stagedClauseRef ?? '' }),
    },
    {
      labelKey: 'kfs.row.term',
      value: `${String(data.loanTerm.value)} ${word(unit(data.loanTerm.unit))}`,
    },
    {
      labelKey: 'kfs.row.instalments',
      value: word('kfs.instalments', {
        type: word(`kfs.instType.${i.type}` as MessageKey),
        frequency: word(`kfs.freq.${i.frequency}` as MessageKey),
        count: i.count,
        amount: i.amountMinor === undefined ? word('kfs.notApplicable') : rupees(i.amountMinor),
        days: i.commencementDaysAfterSanction,
      }),
    },
    {
      labelKey: 'kfs.row.rate',
      value: `${formatAprBps(data.interest.rateBps)} — ${word(`kfs.rateType.${data.interest.type}` as MessageKey)}`,
    },
  ];
  if (data.floating) {
    const f = data.floating;
    part1.push({
      labelKey: 'kfs.row.floating',
      value: word('kfs.floating', {
        benchmark: f.referenceBenchmark,
        b: formatAprBps(f.benchmarkRateBps),
        s: formatAprBps(f.spreadBps),
        r: formatAprBps(f.finalRateBps),
        reset: f.resetPeriodicityMonths,
        impactB: `${rupees(f.impactOf25bps.epiOnBenchmarkMinor)} / ${String(f.impactOf25bps.epiCountOnBenchmark)}`,
        impactS: `${rupees(f.impactOf25bps.epiOnSpreadMinor)} / ${String(f.impactOf25bps.epiCountOnSpread)}`,
      }),
    });
  }
  for (const fee of data.fees) {
    const amount =
      fee.amountMinor !== undefined ? rupees(fee.amountMinor) : formatAprBps(fee.percentBps ?? 0);
    part1.push({
      labelKey: 'kfs.row.fee',
      value: word('kfs.fee', {
        label: fee.label,
        amount,
        payee: word(`kfs.payee.${fee.payee}` as MessageKey),
        timing: word(`kfs.timing.${fee.timing}` as MessageKey),
      }),
    });
  }
  if (data.fees.length === 0) part1.push({ labelKey: 'kfs.row.fee', value: word('kfs.noFees') });
  part1.push({ labelKey: 'kfs.row.apr', value: formatAprBps(data.aprBps) });
  const charge = (c: KfsDataV1['contingent']['penalDelayed']): string => {
    const parts: string[] = [];
    if (c.amountMinor !== undefined) parts.push(rupees(c.amountMinor));
    if (c.percentBps !== undefined) parts.push(formatAprBps(c.percentBps));
    if (c.text) parts.push(c.text);
    return parts.length > 0 ? parts.join(' · ') : word('kfs.notApplicable');
  };
  part1.push(
    { labelKey: 'kfs.row.penal', value: charge(data.contingent.penalDelayed) },
    { labelKey: 'kfs.row.otherPenal', value: charge(data.contingent.otherPenal) },
    { labelKey: 'kfs.row.foreclosure', value: charge(data.contingent.foreclosure) },
    { labelKey: 'kfs.row.switching', value: charge(data.contingent.switching) },
  );

  const c = data.computation;
  const sheet: Row[] = [
    { labelKey: 'kfs.row.totalInterest', value: rupees(c.totalInterestMinor) },
    { labelKey: 'kfs.row.feesTotal', value: rupees(c.feesTotalMinor) },
    { labelKey: 'kfs.row.feesLender', value: rupees(c.feesToLenderMinor) },
    { labelKey: 'kfs.row.feesThird', value: rupees(c.feesToThirdPartyMinor) },
    { labelKey: 'kfs.row.net', value: rupees(c.netDisbursedMinor) },
    { labelKey: 'kfs.row.totalPayable', value: rupees(c.totalPayableMinor) },
    { labelKey: 'kfs.row.apr', value: formatAprBps(data.aprBps) },
    { labelKey: 'kfs.row.disbursalSchedule', value: c.scheduleOfDisbursement },
  ];
  if (c.roundingNote) sheet.push({ labelKey: 'kfs.row.rounding', value: c.roundingNote });

  const schedule: Row[] = data.schedule.map((r) => ({
    labelKey: 'kfs.row.instalment',
    value: word('kfs.scheduleLine', {
      n: r.no,
      date: r.dueDate.split('-').reverse().join('/'),
      principal: rupees(r.principalMinor),
      interest: rupees(r.interestMinor),
      total: rupees(r.instalmentMinor),
      outstanding: rupees(r.outstandingPrincipalMinor),
    }),
  }));

  const p = data.part2;
  const part2: Row[] = [
    { labelKey: 'kfs.row.recoveryClause', value: p.recoveryAgentClauseRef },
    { labelKey: 'kfs.row.grievanceClause', value: p.grievanceClauseRef },
    { labelKey: 'kfs.row.nodal', value: `${p.nodalOfficerPhone} · ${p.nodalOfficerEmail}` },
    {
      labelKey: 'kfs.row.transfer',
      value: p.transferOrSecuritisation ? word('common.yes') : word('common.no'),
    },
    {
      labelKey: 'kfs.row.coolingOff',
      value:
        word('kfs.coolingOff', { days: p.digital.coolingOffDays }) +
        (p.digital.coolingOffNote ? ` ${p.digital.coolingOffNote}` : ''),
    },
  ];
  if (p.collaborativeLending) {
    const cl = p.collaborativeLending;
    part2.push({
      labelKey: 'kfs.row.collaborative',
      value: `${cl.originatingRe} (${formatAprBps(cl.originatingFundingPercentBps)}) · ${cl.partnerRe} (${formatAprBps(cl.partnerFundingPercentBps)}) · ${formatAprBps(cl.blendedRateBps)}`,
    });
  }
  return { part1, apr_sheet: sheet, schedule, part2 };
}

export interface AckInputs {
  /** Sections the borrower has opened on screen. A section counts only after an explicit tap. */
  shown: ReadonlySet<KfsSectionKey>;
  /** The borrower fetched the actual file. Downloading is not acknowledging. */
  fileOpened: boolean;
  checked: boolean;
  view: Pick<KfsView, 'ackSections' | 'wording' | 'sourceMode' | 'issuanceStatus' | 'acknowledged'>;
}

/** Why the acknowledgement button is not available yet, or null when it is. Nothing here is ever pre-selected. */
export type AckBlock =
  'already' | 'not_current' | 'no_wording' | 'open_file' | 'review_sections' | 'tick';

export function ackBlock(input: AckInputs): AckBlock | null {
  const { view } = input;
  if (view.acknowledged) return 'already';
  if (view.issuanceStatus !== 'issued') return 'not_current';
  if (!view.wording) return 'no_wording';
  if (!input.fileOpened) return 'open_file';
  // An uploaded KFS has no sections the app can show: opening the file is the review.
  if (
    view.sourceMode === 'generated' &&
    !view.ackSections.every((s) => input.shown.has(s as KfsSectionKey))
  ) {
    return 'review_sections';
  }
  if (!input.checked) return 'tick';
  return null;
}

/** The sections to report as shown: only those actually opened. */
export function shownSections(
  shown: ReadonlySet<KfsSectionKey>,
  sourceMode: string,
): KfsSectionKey[] {
  return sourceMode === 'generated' ? KFS_SECTIONS.filter((s) => shown.has(s)) : [];
}

export type NextStep =
  | 'waiting_for_kfs'
  | 'review_kfs'
  | 'accept'
  | 'waiting_for_agreement'
  | 'review_agreement'
  | 'signing'
  | 'executed'
  | 'offer_closed';

/** What the borrower can do next, derived only from what the lender and the database have recorded. */
export function nextStep(docs: ApplicationDocuments, now: Date): NextStep {
  const offer = docs.offer;
  if (!offer) return 'waiting_for_kfs';
  if (docs.signing?.state === 'executed') return 'executed';
  if (docs.acceptance) {
    if (!docs.agreement) return 'waiting_for_agreement';
    if (docs.agreement.issuanceStatus !== 'issued') return 'offer_closed';
    return docs.signing ? 'signing' : 'review_agreement';
  }
  if (
    offer.status === 'withdrawn' ||
    offer.status === 'expired' ||
    new Date(offer.validUntil) <= now
  )
    return 'offer_closed';
  const kfs = docs.kfs;
  if (!kfs || kfs.issuanceStatus !== 'issued') return kfs ? 'offer_closed' : 'waiting_for_kfs';
  if (kfs.validUntil && new Date(kfs.validUntil) <= now) return 'offer_closed';
  return docs.acknowledgement ? 'accept' : 'review_kfs';
}

export function signingKey(state: string): MessageKey {
  const known = [
    'not_required',
    'awaiting_initiation',
    'ready_for_signing',
    'initiated',
    'awaiting_borrower',
    'executed',
    'failed',
    'expired',
    'cancelled',
    'requires_reconciliation',
  ];
  return (known.includes(state) ? `signing.state.${state}` : 'signing.state.unknown') as MessageKey;
}

export function documentStatusKey(status: string): MessageKey {
  const known = ['issued', 'superseded', 'withdrawn', 'expired'];
  return (known.includes(status) ? `docs.status.${status}` : 'docs.status.unknown') as MessageKey;
}

/** Decodes base64 without Buffer (not available in React Native). Throws on malformed input. */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/\s/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    throw new Error('invalid base64');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = alphabet.indexOf(clean[i] ?? 'A');
    const b = alphabet.indexOf(clean[i + 1] ?? 'A');
    const c = clean[i + 2] === '=' ? 0 : alphabet.indexOf(clean[i + 2] ?? 'A');
    const d = clean[i + 3] === '=' ? 0 : alphabet.indexOf(clean[i + 3] ?? 'A');
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
