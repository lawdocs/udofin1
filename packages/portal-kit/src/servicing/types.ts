import {
  type LsAnomalyPage as AnomalyPageSchema,
  type LsClosurePage as ClosurePageSchema,
  type LsConflictPage as ConflictPageSchema,
  type LsDocumentList as DocumentListSchema,
  type LsDocumentRequestPage as RequestPageSchema,
  type LsImportBatchPage as BatchPageSchema,
  type LsImportDetail as ImportDetailSchema,
  type LsLoanPage as LoanPageSchema,
  type LsQuotePage as QuotePageSchema,
  type LsSyncStatus as SyncStatusSchema,
  type LsAnomaly as AnomalySchema,
  type LsBalanceReport as ReportSchema,
  type LsClosure as ClosureSchema,
  type LsConflict as ConflictSchema,
  type LsDocumentRequest as RequestSchema,
} from '@udofin/contracts';
import { type z } from 'zod';

// The contracts export most of these as schemas only; the types the screens read are derived from them here.
export type LsSyncStatus = z.infer<typeof SyncStatusSchema>;
export type LsImportBatchPage = z.infer<typeof BatchPageSchema>;
export type LsImportDetail = z.infer<typeof ImportDetailSchema>;
export type LsLoanPage = z.infer<typeof LoanPageSchema>;
export type LsConflict = z.infer<typeof ConflictSchema>;
export type LsConflictPage = z.infer<typeof ConflictPageSchema>;
export type LsAnomaly = z.infer<typeof AnomalySchema>;
export type LsAnomalyPage = z.infer<typeof AnomalyPageSchema>;
export type LsBalanceReport = z.infer<typeof ReportSchema>;
export type LsDocumentList = z.infer<typeof DocumentListSchema>;
export type LsDocumentRequest = z.infer<typeof RequestSchema>;
export type LsDocumentRequestPage = z.infer<typeof RequestPageSchema>;
export type LsQuotePage = z.infer<typeof QuotePageSchema>;
export type LsClosure = z.infer<typeof ClosureSchema>;
export type LsClosurePage = z.infer<typeof ClosurePageSchema>;
