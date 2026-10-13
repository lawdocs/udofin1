/** Plain-English labels for stored values. The stored value is the source of truth; labels only help reading. */
const title = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const SPECIAL: Record<string, string> = {
  ind_as: 'Ind AS',
  to_be_confirmed: 'To be confirmed',
  companies_as_rules_or_other_corporate:
    'Companies (Accounting Standards) Rules / other corporate framework',
  banking_sector_framework: 'Applicable banking-sector framework',
  lender_system: 'Lender system',
  udofin: 'Udofin',
  third_party: 'Third party',
  not_applicable: 'Not applicable',
  under_assessment: 'Under assessment',
  profile_created: 'Profile created',
  institution_verified: 'Institution verified',
  approved_for_onboarding: 'Approved for onboarding',
  contract_onboarded: 'Contract onboarding complete',
  service_scope_agreed: 'Service scope agreed',
  product_config_completed: 'Product configuration completed',
  product_config_approved: 'Product configuration approved',
  integration_tested: 'Integration tested',
  production_ready_approved: 'Production readiness approved',
  activated: 'Activated',
};

export const label = (value: string | null | undefined): string =>
  value ? (SPECIAL[value] ?? title(value)) : '—';

export const ERROR_MESSAGES: Record<string, string> = {
  forbidden: 'You are not allowed to do that.',
  self_approval:
    'You contributed to this record or requested this step, so someone else has to decide it.',
  gate_not_met: 'The conditions for that step are not all met yet. See the checklist.',
  gate_order: 'Steps must be taken in order, one at a time.',
  gate_stale: 'The lender has moved on since that request was filed.',
  evidence_required: 'Evidence is required before this can be verified.',
  unconfirmed_not_verifiable:
    'A value that is still "to be confirmed" cannot be verified. Confirm it first.',
  version_immutable: 'That version is agreed and cannot be edited. Propose a new version instead.',
  agreed_scope_required: 'Write the final agreed scope before either side agrees.',
  dependency_open: 'It depends on another requirement that is not closed yet.',
  unsafe_free_text:
    'That text looks like it contains a secret or a personal identifier. Remove it and use a reference instead.',
  document_type_mismatch: 'The file does not match the type you selected.',
  document_too_large: 'The file is larger than 8 MiB.',
  document_store_unavailable: 'Document storage is not available in this environment yet.',
  invalid_request: 'One of the values was not valid.',
  invalid_reference: 'A referenced record does not exist for this lender.',
  conflict: 'That is not possible in the current state.',
  not_found: 'That record was not found.',
  mfa_required: 'Your session needs the second factor again. Sign in once more.',
  validation_failed: 'Please check the values you entered.',
  path_not_allowed: 'That action is not available.',
  network_error: 'The service could not be reached. Try again.',
};

export const errorMessage = (code: string | undefined): string =>
  (code && ERROR_MESSAGES[code]) || 'The action could not be completed.';
