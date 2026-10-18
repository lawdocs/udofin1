// Phase 08a screens for lender loans, imports, sync, conflicts, documents, quotations and closures.
// The names leaving this folder carry a `Servicing` prefix so they cannot collide with another screen group's exports
// when the package index merges them; the generic helpers (format, wording) are used inside the folder and by its tests.
export {
  LoansPage as ServicingLoansPage,
  LoanDetailPage as ServicingLoanDetailPage,
  DocumentRequestsPage as ServicingRequestsPage,
  ClosuresPage as ServicingClosuresPage,
  SyncPage as ServicingSyncPage,
  ImportDetailPage as ServicingImportPage,
  ConflictsPage as ServicingConflictsPage,
  AnomaliesPage as ServicingAnomaliesPage,
} from './views.js';
export {
  ImportStageForm as ServicingImportForm,
  type StageAction as ServicingStageAction,
} from './stage-form.js';
export { type ServicingContext } from './common.js';
export { openLenderDocument as openServicingDocument } from './document-file.js';
export {
  servicingGrants,
  parseListQuery as parseServicingQuery,
  loadLoans as loadServicingLoans,
  loadLoanDetail as loadServicingLoan,
  loadLoanDocuments as loadServicingDocuments,
  loadLoanQuotes as loadServicingQuotes,
  loadDocumentRequests as loadServicingRequests,
  loadSyncStatus as loadServicingSyncStatus,
  loadImports as loadServicingImports,
  loadImport as loadServicingImport,
  loadCorrectableImports as loadServicingCorrections,
  loadConflicts as loadServicingConflicts,
  loadAnomalies as loadServicingAnomalies,
  loadClosures as loadServicingClosures,
  loadDocumentContent as loadServicingDocumentContent,
  verifiedDocumentBytes as verifiedServicingDocument,
  isUuid as isServicingId,
  type MembershipLike as ServicingMembership,
  type ServicingGrant,
  type StageState as ServicingStageState,
} from './data.js';
export {
  runServicingOperation,
  safeServicingReturnPath,
  noticeUrl as servicingNoticeUrl,
  SERVICING_OPERATIONS,
  type ServicingOutcome,
} from './operations.js';
