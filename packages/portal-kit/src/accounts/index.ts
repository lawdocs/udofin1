// Phase 08a screens for platform staff: payment providers, the account registry, feature switches and platform exceptions.
// Names leaving this folder carry an `Accounts` or `Platform` prefix so they cannot collide with another screen group's exports.
export { createPlatformClient, type PlatformApi, type PlatformResult } from './client.js';
export { type AccountsContext } from './common.js';
export { ProvidersPage as AccountsProvidersPage } from './provider-views.js';
export {
  RegistryPage as AccountsRegistryPage,
  RulesPage as AccountsRulesPage,
  registrationReadiness as accountsRegistrationReadiness,
} from './registry-views.js';
export {
  SettlementPage as AccountsSettlementPage,
  MerchantsPage as AccountsMerchantsPage,
} from './merchant-views.js';
export { FeaturesPage as AccountsFeaturesPage } from './feature-views.js';
export {
  ExceptionsPage as AccountsExceptionsPage,
  ExceptionDetailPage as AccountsExceptionDetailPage,
} from './exception-views.js';
export {
  platformCaps,
  parseAccountsQuery,
  noticeFrom as accountsNoticeFrom,
  returnPath as accountsReturnPath,
  registeredIdFrom as accountsRegisteredIdFrom,
  isId as isPlatformId,
  loadProviders as loadPlatformProviders,
  loadReturnCodes as loadPlatformReturnCodes,
  loadRules as loadPlatformRules,
  loadKeyVersions as loadPlatformKeyVersions,
  loadAccounts as loadPlatformAccounts,
  loadAccount as loadPlatformAccount,
  loadVerifiedAccounts as loadPlatformVerifiedAccounts,
  loadSettlementAccounts as loadPlatformSettlementAccounts,
  loadMerchants as loadPlatformMerchants,
  loadFeatureCatalogue as loadPlatformFeatures,
  loadLenderSwitches as loadPlatformLenderSwitches,
  loadFeatureRequests as loadPlatformFeatureRequests,
  loadOpenExceptions as loadPlatformOpenExceptions,
  loadResolvedExceptions as loadPlatformResolvedExceptions,
  loadException as loadPlatformException,
  loadLenderChoices as loadPlatformLenderChoices,
  type PlatformCaps,
  type AccountsQuery,
} from './data.js';
export {
  runAccountsOperation,
  runAccountRegistration,
  safeAccountsReturnPath,
  accountsNoticeUrl,
  accountsFlashFor,
  accountRegisteredUrl,
  ACCOUNTS_OPERATIONS,
  type AccountsOutcome,
} from './operations.js';
export { type LenderChoice } from './types.js';
export { RULE_STATUSES as ACCOUNTS_RULE_STATUSES } from './wording.js';
export {
  REGISTRY_STATUSES as ACCOUNTS_REGISTRY_STATUSES,
  REQUEST_STATUSES as ACCOUNTS_REQUEST_STATUSES,
  EXCEPTION_SEVERITIES as ACCOUNTS_EXCEPTION_SEVERITIES,
  MERCHANT_STATUSES as ACCOUNTS_MERCHANT_STATUSES,
  MERCHANT_VERIFICATIONS as ACCOUNTS_MERCHANT_VERIFICATIONS,
} from './wording.js';
