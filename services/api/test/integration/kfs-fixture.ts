import type { KfsDataV1 } from '@udofin/contracts';

/**
 * SAMPLE data for tests only: the RBI's own illustration (RBC Directions 2025, para 29(3)) with amounts in paise.
 * It is not a lender's offer and not a legal document.
 */
const ROWS: [number, number, number, number][] = [
  [1, 20000, 720, 250],
  [2, 19280, 729, 241],
  [3, 18552, 738, 232],
  [4, 17814, 747, 223],
  [5, 17067, 756, 213],
  [6, 16310, 766, 204],
  [7, 15544, 775, 194],
  [8, 14769, 785, 185],
  [9, 13984, 795, 175],
  [10, 13189, 805, 165],
  [11, 12384, 815, 155],
  [12, 11569, 825, 145],
  [13, 10744, 835, 134],
  [14, 9909, 846, 124],
  [15, 9063, 856, 113],
  [16, 8206, 867, 103],
  [17, 7339, 878, 92],
  [18, 6461, 889, 81],
  [19, 5572, 900, 70],
  [20, 4672, 911, 58],
  [21, 3761, 923, 47],
  [22, 2838, 934, 35],
  [23, 1904, 946, 24],
  [24, 958, 958, 12],
];

export function sampleKfsData(): KfsDataV1 {
  return {
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
        label: 'Insurance (third party)',
        payee: 'third_party',
        timing: 'one_time',
        amountMinor: 16_000,
      },
    ],
    aprBps: 1707,
    contingent: {
      penalDelayed: { percentBps: 200, text: '2% per annum on the overdue amount' },
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
      scheduleOfDisbursement: 'Single disbursement after signing',
      roundingNote: 'Instalments are rounded to the nearest rupee.',
    },
    schedule: ROWS.map(([no, o, p, i]) => ({
      no,
      dueDate: `${String(2026 + Math.floor((10 + no) / 12))}-${String(((10 + no) % 12) + 1).padStart(2, '0')}-01`,
      outstandingPrincipalMinor: o * 100,
      principalMinor: p * 100,
      interestMinor: i * 100,
      instalmentMinor: 97_000,
    })),
    part2: {
      recoveryAgentClauseRef: '14',
      grievanceClauseRef: '18',
      nodalOfficerPhone: '+91-00000-00000',
      nodalOfficerEmail: 'grievance@lender.example',
      transferOrSecuritisation: false,
      digital: { coolingOffDays: 3 },
    },
  };
}
