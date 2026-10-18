import type * as C from '@udofin/contracts';
import { type z } from 'zod';

/** The shapes the payment screens read, taken from the wire contracts so a screen cannot drift from the API. */
export type PaymentPage = z.infer<typeof C.LpPaymentPage>;
export type PaymentRow = z.infer<typeof C.LpPaymentRow>;
export type PaymentDetail = z.infer<typeof C.LpPaymentDetail>;
export type ProviderEventPage = z.infer<typeof C.LpProviderEventPage>;
export type WebhookSummary = z.infer<typeof C.LpWebhookSummary>;
export type PaymentPolicyList = z.infer<typeof C.LpPaymentPolicyList>;
export type MandatePolicyList = z.infer<typeof C.LpMandatePolicyList>;
export type ReconSettingsList = z.infer<typeof C.LpReconciliationSettingsList>;
export type MandatePage = z.infer<typeof C.LpMandatePage>;
export type MandateDetail = z.infer<typeof C.LpMandateDetail>;
export type MandateDebit = z.infer<typeof C.LpMandateDebit>;
export type MandateDebitPage = z.infer<typeof C.LpMandateDebitPage>;
export type RunPage = z.infer<typeof C.LpRunPage>;
export type ReconSummary = z.infer<typeof C.LpReconciliationSummary>;
export type SettlementBatch = z.infer<typeof C.LpSettlementBatch>;
export type SettlementBatchPage = z.infer<typeof C.LpSettlementBatchPage>;
export type SettlementItemPage = z.infer<typeof C.LpSettlementItemPage>;
export type ExceptionPage = z.infer<typeof C.LpExceptionPage>;
export type ExceptionRow = z.infer<typeof C.LpException>;
export type ExceptionDetail = z.infer<typeof C.LpExceptionDetail>;
export type SettlementAccounts = z.infer<typeof C.SettlementAccountRegistryStatusList>;
