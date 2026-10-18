import {
  type LrDeliveryLog as DeliveryLogSchema,
  type LrHoldPage as HoldPageSchema,
  type LrPenalTextPage as PenalTextPageSchema,
  type LrPolicyPage as PolicyPageSchema,
  type LrReminderPage as ReminderPageSchema,
  type LrReminderSummary as ReminderSummarySchema,
  type LrTemplatePage as TemplatePageSchema,
} from '@udofin/contracts';
import { type z } from 'zod';

// The contracts export most of these as schemas only; the types the screens read are derived from them here.
export type LrDeliveryLog = z.infer<typeof DeliveryLogSchema>;
export type LrHoldPage = z.infer<typeof HoldPageSchema>;
export type LrPenalTextPage = z.infer<typeof PenalTextPageSchema>;
export type LrPolicyPage = z.infer<typeof PolicyPageSchema>;
export type LrReminderPage = z.infer<typeof ReminderPageSchema>;
export type LrReminderSummary = z.infer<typeof ReminderSummarySchema>;
export type LrTemplatePage = z.infer<typeof TemplatePageSchema>;
