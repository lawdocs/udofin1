import {
  type SvcActivityEntry as SvcActivityEntrySchema,
  type SvcActivityPage as SvcActivityPageSchema,
  type SvcClosure as SvcClosureSchema,
  type SvcDocumentRequest as SvcDocumentRequestSchema,
  type SvcLoan as SvcLoanSchema,
  type SvcLoanDocument as SvcLoanDocumentSchema,
  type SvcQuote as SvcQuoteSchema,
  type SvcReminder as SvcReminderSchema,
  type SvcSchedule as SvcScheduleSchema,
} from '@udofin/contracts';
import { type z } from 'zod';

/** Types of the Phase 08a wire contracts (the contract package exports the schemas; the types are inferred here). */
export type SvcLoan = z.infer<typeof SvcLoanSchema>;
export type SvcSchedule = z.infer<typeof SvcScheduleSchema>;
export type SvcActivityEntry = z.infer<typeof SvcActivityEntrySchema>;
export type SvcActivityPage = z.infer<typeof SvcActivityPageSchema>;
export type SvcLoanDocument = z.infer<typeof SvcLoanDocumentSchema>;
export type SvcDocumentRequest = z.infer<typeof SvcDocumentRequestSchema>;
export type SvcQuote = z.infer<typeof SvcQuoteSchema>;
export type SvcClosure = z.infer<typeof SvcClosureSchema>;
export type SvcReminder = z.infer<typeof SvcReminderSchema>;
