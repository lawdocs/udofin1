import { type ApplicationDocuments, type KfsDataV1 } from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import {
  ackBlock,
  base64ToBytes,
  documentStatusKey,
  kfsRows,
  KFS_SECTIONS,
  nextStep,
  shownSections,
  signingKey,
  type KfsSectionKey,
} from '../src/borrower/documents';
import { translate, type Language, type MessageKey } from '../src/i18n';
import { en } from '../src/i18n/en';
import { hi } from '../src/i18n/hi';

const data: KfsDataV1 = {
  schema: 'kfs_data_v1',
  loanType: 'Personal loan (sample)',
  sanctionedAmountMinor: 2_000_000,
  disbursal: { mode: 'upfront' },
  loanTerm: { value: 24, unit: 'months' },
  tenureDays: 720,
  instalments: {
    type: 'epi',
    frequency: 'monthly',
    count: 24,
    amountMinor: 97_000,
    commencementDaysAfterSanction: 30,
  },
  interest: { rateBps: 1500, type: 'fixed' },
  fees: [
    {
      category: 'processing',
      label: 'Processing fee',
      payee: 'lender',
      timing: 'one_time',
      amountMinor: 24_000,
    },
    {
      category: 'insurance',
      label: 'Insurance',
      payee: 'third_party',
      timing: 'one_time',
      amountMinor: 16_000,
    },
  ],
  aprBps: 1707,
  contingent: {
    penalDelayed: { percentBps: 200, text: '2% a year on the overdue amount' },
    otherPenal: { notApplicable: true },
    foreclosure: { notApplicable: true },
    switching: { notApplicable: true },
  },
  computation: {
    totalInterestMinor: 327_400,
    feesTotalMinor: 40_000,
    feesToLenderMinor: 24_000,
    feesToThirdPartyMinor: 16_000,
    netDisbursedMinor: 1_960_000,
    totalPayableMinor: 2_327_400,
    scheduleOfDisbursement: 'Single disbursement',
    roundingNote: 'Rounded to the nearest rupee.',
  },
  schedule: [
    {
      no: 1,
      dueDate: '2026-12-01',
      outstandingPrincipalMinor: 2_000_000,
      principalMinor: 72_000,
      interestMinor: 25_000,
      instalmentMinor: 97_000,
    },
  ],
  part2: {
    recoveryAgentClauseRef: '14',
    grievanceClauseRef: '18',
    nodalOfficerPhone: '+91-00000-00000',
    nodalOfficerEmail: 'grievance@lender.example',
    transferOrSecuritisation: false,
    digital: { coolingOffDays: 3 },
  },
};

const word = (language: Language) => (key: MessageKey, vars?: Record<string, string | number>) =>
  translate(language, key, vars);

describe('the KFS rows carry the lender figures exactly', () => {
  it('shows money and rates as stored, with nothing calculated', () => {
    const rows = kfsRows(data, word('en'));
    const text = Object.values(rows)
      .flat()
      .map((r) => `${r.labelKey}=${r.value}`)
      .join('\n');
    expect(text).toContain('kfs.row.sanctioned=₹20,000');
    expect(text).toContain('kfs.row.apr=17.07%');
    expect(text).toContain('kfs.row.net=₹19,600');
    expect(text).toContain('kfs.row.totalPayable=₹23,274');
    expect(text).toContain('kfs.row.totalInterest=₹3,274');
    expect(text).toContain('principal ₹720');
    expect(rows.schedule).toHaveLength(1);
    expect(text).toContain('Rounded to the nearest rupee.');
    // No figure the lender did not supply appears (the schedule above does not add up to the total, and the app does not say so).
    expect(text).not.toMatch(/19,999|3,275/);
  });

  it('works in Hindi with the same figures', () => {
    const text = Object.values(kfsRows(data, word('hi')))
      .flat()
      .map((r) => r.value)
      .join('\n');
    expect(text).toContain('₹20,000');
    expect(text).toContain('17.07%');
    expect(text).toContain('मूलधन ₹720');
  });

  it('uses only labels that exist in both languages', () => {
    for (const row of Object.values(kfsRows(data, word('en'))).flat()) {
      expect(row.labelKey in en && row.labelKey in hi, row.labelKey).toBe(true);
    }
  });

  it('shows a floating-rate table only when the lender gave one', () => {
    const floating: KfsDataV1 = {
      ...data,
      interest: { rateBps: 1500, type: 'floating' },
      floating: {
        referenceBenchmark: 'Sample benchmark',
        benchmarkRateBps: 1000,
        spreadBps: 500,
        finalRateBps: 1500,
        resetPeriodicityMonths: 6,
        impactOf25bps: {
          epiOnBenchmarkMinor: 1200,
          epiOnSpreadMinor: 1100,
          epiCountOnBenchmark: 1,
          epiCountOnSpread: 1,
        },
      },
    };
    expect(kfsRows(data, word('en')).part1.some((r) => r.labelKey === 'kfs.row.floating')).toBe(
      false,
    );
    expect(kfsRows(floating, word('en')).part1.some((r) => r.labelKey === 'kfs.row.floating')).toBe(
      true,
    );
  });
});

const view = {
  ackSections: [...KFS_SECTIONS],
  wording: {
    noticeId: 'n',
    version: 1,
    language: 'en',
    title: 't',
    body: 'b',
    languageFallback: false,
  },
  sourceMode: 'generated',
  issuanceStatus: 'issued',
  acknowledged: false,
};
const all = new Set<KfsSectionKey>(KFS_SECTIONS);

describe('acknowledging needs explicit steps, never inferred', () => {
  it('blocks until the file was opened, every section was opened and the box was ticked', () => {
    expect(ackBlock({ shown: all, fileOpened: false, checked: true, view })).toBe('open_file');
    expect(
      ackBlock({ shown: new Set<KfsSectionKey>(['part1']), fileOpened: true, checked: true, view }),
    ).toBe('review_sections');
    expect(ackBlock({ shown: all, fileOpened: true, checked: false, view })).toBe('tick');
    expect(ackBlock({ shown: all, fileOpened: true, checked: true, view })).toBeNull();
  });
  it('never starts ticked: with nothing done the first block is "open the file"', () => {
    expect(ackBlock({ shown: new Set(), fileOpened: false, checked: false, view })).toBe(
      'open_file',
    );
  });
  it('refuses when there is no approved wording, when the statement is not current, and when already acknowledged', () => {
    expect(
      ackBlock({ shown: all, fileOpened: true, checked: true, view: { ...view, wording: null } }),
    ).toBe('no_wording');
    expect(
      ackBlock({
        shown: all,
        fileOpened: true,
        checked: true,
        view: { ...view, issuanceStatus: 'superseded' },
      }),
    ).toBe('not_current');
    expect(
      ackBlock({
        shown: all,
        fileOpened: true,
        checked: true,
        view: { ...view, acknowledged: true },
      }),
    ).toBe('already');
  });
  it('treats opening the file as the review for a lender-issued file, and reports no sections it could not show', () => {
    const uploaded = { ...view, sourceMode: 'lender_uploaded', ackSections: [] };
    expect(
      ackBlock({ shown: new Set(), fileOpened: true, checked: true, view: uploaded }),
    ).toBeNull();
    expect(shownSections(all, 'lender_uploaded')).toEqual([]);
    expect(shownSections(new Set<KfsSectionKey>(['part2', 'part1']), 'generated')).toEqual([
      'part1',
      'part2',
    ]);
  });
});

const base: ApplicationDocuments = {
  applicationId: '00000000-0000-4000-8000-000000000001',
  applicationStatus: 'approved',
  lenderName: 'L',
  offer: {
    offerId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    status: 'issued',
    validUntil: '2026-12-01T00:00:00Z',
    principalMinor: 1,
    tenureDays: 1,
    aprBps: 1,
    monthlyRepaymentMinor: null,
    lenderOfferRef: null,
  },
  kfs: {
    documentId: '00000000-0000-4000-8000-000000000003',
    version: 1,
    issuanceStatus: 'issued',
    proposalNo: 'P',
    language: 'en',
    sourceMode: 'generated',
    validFrom: '2026-11-01T00:00:00Z',
    validUntil: '2026-11-10T00:00:00Z',
    issuedAt: '2026-11-01T00:00:00Z',
    sha256: 'a',
    contentDigest: 'b',
  },
  acknowledgement: null,
  acceptance: null,
  agreement: null,
  signing: null,
  documents: [],
};
const NOW = new Date('2026-11-05T00:00:00Z');

describe('what happens next follows only what was recorded', () => {
  it('walks the steps', () => {
    expect(nextStep({ ...base, offer: null, kfs: null }, NOW)).toBe('waiting_for_kfs');
    expect(nextStep({ ...base, kfs: null }, NOW)).toBe('waiting_for_kfs');
    expect(nextStep(base, NOW)).toBe('review_kfs');
    expect(
      nextStep(
        {
          ...base,
          acknowledgement: { acknowledgementId: 'x', acknowledgedAt: 'y', language: 'en' },
        },
        NOW,
      ),
    ).toBe('accept');
    const accepted = {
      ...base,
      acceptance: {
        acceptedAt: 'z',
        signatureStatus: 'not_signed' as const,
        disbursementStatus: 'not_started' as const,
      },
    };
    expect(nextStep(accepted, NOW)).toBe('waiting_for_agreement');
    const agreement = {
      documentId: '00000000-0000-4000-8000-000000000004',
      version: 1,
      issuanceStatus: 'issued',
      issuedAt: null,
    };
    expect(nextStep({ ...accepted, agreement }, NOW)).toBe('review_agreement');
    expect(
      nextStep(
        {
          ...accepted,
          agreement,
          signing: { requestId: 'r', state: 'initiated', providerMode: 'mock', updatedAt: 'u' },
        },
        NOW,
      ),
    ).toBe('signing');
    expect(
      nextStep(
        {
          ...accepted,
          agreement,
          signing: { requestId: 'r', state: 'executed', providerMode: 'mock', updatedAt: 'u' },
        },
        NOW,
      ),
    ).toBe('executed');
  });
  it('closes an offer that expired, was withdrawn, or whose statement validity ended; nothing is offered to accept', () => {
    expect(
      nextStep(
        {
          ...base,
          offer: {
            ...(base.offer as NonNullable<typeof base.offer>),
            validUntil: '2026-11-01T00:00:00Z',
          },
        },
        NOW,
      ),
    ).toBe('offer_closed');
    expect(
      nextStep(
        {
          ...base,
          offer: { ...(base.offer as NonNullable<typeof base.offer>), status: 'withdrawn' },
        },
        NOW,
      ),
    ).toBe('offer_closed');
    expect(
      nextStep(
        {
          ...base,
          kfs: {
            ...(base.kfs as NonNullable<typeof base.kfs>),
            validUntil: '2026-11-04T00:00:00Z',
          },
        },
        NOW,
      ),
    ).toBe('offer_closed');
    expect(
      nextStep(
        {
          ...base,
          kfs: { ...(base.kfs as NonNullable<typeof base.kfs>), issuanceStatus: 'superseded' },
        },
        NOW,
      ),
    ).toBe('offer_closed');
  });
  it('uses separate dates: the KFS can end before the offer does', () => {
    expect(base.kfs?.validUntil).not.toBe(base.offer?.validUntil);
  });
});

describe('labels and decoding', () => {
  it('has a message for every signing and document status', () => {
    for (const s of [
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
      'zzz',
    ]) {
      expect(signingKey(s) in en).toBe(true);
    }
    for (const s of ['issued', 'superseded', 'withdrawn', 'expired', 'zzz'])
      expect(documentStatusKey(s) in en).toBe(true);
  });
  it('never says signed or delivered for the uncertain states', () => {
    expect(en[signingKey('requires_reconciliation')]).toMatch(/could not confirm/i);
    expect(en[signingKey('awaiting_borrower')]).not.toMatch(/signing is complete/i);
    expect(en['agr.delivery.accepted_by_provider']).toMatch(/does not confirm/i);
    expect(en['agr.delivery.requested']).toMatch(/not that it arrived/i);
  });
  it('decodes base64 without Buffer and rejects malformed input', () => {
    expect([...base64ToBytes('JVBERi0=')]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect([...base64ToBytes('TWE=')]).toEqual([77, 97]);
    expect([...base64ToBytes('TQ==')]).toEqual([77]);
    expect(() => base64ToBytes('abc')).toThrow();
    expect(() => base64ToBytes('ab$d')).toThrow();
  });
});
