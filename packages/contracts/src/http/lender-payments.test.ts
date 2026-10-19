import { describe, expect, it } from 'vitest';
import {
  LP_RECEIPT_LAG_HOURS,
  LP_SETTLEMENT_LAG_DAYS,
  LpPaymentStage,
  LpReconciliationSettingsInput,
  LpRunReport,
} from './lender-payments.js';

const LENDER = '0198f3a0-0000-7000-8000-000000000001';

describe('LpReconciliationSettingsInput: the range the database accepts', () => {
  const input = (settlementLagDays: unknown, receiptLagHours: unknown) =>
    LpReconciliationSettingsInput.safeParse({
      lenderId: LENDER,
      settlementLagDays,
      receiptLagHours,
    }).success;

  it('names the ranges as 1 to 7 days and 1 to 168 hours', () => {
    expect(LP_SETTLEMENT_LAG_DAYS).toEqual({ min: 1, max: 7 });
    expect(LP_RECEIPT_LAG_HOURS).toEqual({ min: 1, max: 168 });
  });

  it('accepts both ends of each range', () => {
    expect(input(1, 1)).toBe(true);
    expect(input(7, 168)).toBe(true);
    expect(input(3, 72)).toBe(true);
  });

  it('refuses a value outside either range, a fraction and a text', () => {
    for (const [days, hours] of [
      [0, 72],
      [8, 72],
      [30, 72],
      [100_000, 72],
      [3, 0],
      [3, 169],
      [3, 720],
      [3, 1_000_000],
      [3.5, 72],
      [3, 72.5],
      ['3', 72],
      [3, '72'],
    ] as const)
      expect(input(days, hours), `${String(days)} days, ${String(hours)} hours`).toBe(false);
  });
});

describe('LpRunReport: what the standing line rests on', () => {
  const report = {
    runDate: '2026-10-16',
    paymentsConsidered: 10,
    matched: { settlement: 8, bank: 7, receipt: 6 },
    notReconcilable: [],
    settledToNonLender: { items: 0, minor: 0 },
    settlementEvidence: {
      settlementReportExists: true,
      offAccountBatches: 0,
      offAccountNetMinor: 0,
      destinationUnstatedBatches: 0,
      destinationUnstatedMinor: 0,
      destinationUnstatedNetMinor: 0,
      zeroIsEvidence: true,
    },
    settings: { settlementLagDays: 3, receiptLagHours: 72, abovePlatformDefault: false },
  };

  it('carries the evidence and whether a waiting time is above the platform default', () => {
    expect(LpRunReport.safeParse(report).success).toBe(true);
  });

  it('reads a value the run did not record as null, not as zero or false', () => {
    const unrecorded = {
      ...report,
      settlementEvidence: {
        settlementReportExists: null,
        offAccountBatches: null,
        offAccountNetMinor: null,
        destinationUnstatedBatches: null,
        destinationUnstatedMinor: null,
        destinationUnstatedNetMinor: null,
        zeroIsEvidence: null,
      },
      settings: { settlementLagDays: null, receiptLagHours: null, abovePlatformDefault: null },
    };
    expect(LpRunReport.safeParse(unrecorded).success).toBe(true);
  });

  it('is strict: the evidence is required and an extra field is refused', () => {
    const { settlementEvidence: _dropped, ...without } = report;
    expect(LpRunReport.safeParse(without).success).toBe(false);
    expect(
      LpRunReport.safeParse({
        ...report,
        settlementEvidence: { ...report.settlementEvidence, extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      LpRunReport.safeParse({ ...report, settings: { settlementLagDays: 3, receiptLagHours: 72 } })
        .success,
    ).toBe(false);
  });

  it('refuses a negative amount of money', () => {
    expect(
      LpRunReport.safeParse({
        ...report,
        settlementEvidence: { ...report.settlementEvidence, destinationUnstatedMinor: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('LpPaymentStage: what a bank-confirmed stage rests on', () => {
  const stage = {
    stage: 'bank_confirmed',
    providerCaptured: true,
    providerSettled: true,
    bankConfirmed: true,
    bankConfirmationBasis: 'lender_reported_credit',
    lenderPosted: false,
    settlementDestinationOk: true,
  };

  it('names the lender’s own reported credit as the only basis, and null when nothing is confirmed', () => {
    expect(LpPaymentStage.safeParse(stage).success).toBe(true);
    expect(
      LpPaymentStage.safeParse({
        ...stage,
        stage: 'provider_settled',
        bankConfirmed: false,
        bankConfirmationBasis: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a basis it does not know, and a stage with no basis field', () => {
    expect(
      LpPaymentStage.safeParse({ ...stage, bankConfirmationBasis: 'bank_statement' }).success,
    ).toBe(false);
    const { bankConfirmationBasis: _dropped, ...without } = stage;
    expect(LpPaymentStage.safeParse(without).success).toBe(false);
  });
});
