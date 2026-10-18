import {
  type FeatureSwitchList as FeatureSwitchListSchema,
  type MerchantPage as MerchantPageSchema,
  type PaymentConfigHistory as ConfigHistorySchema,
  type PaymentConfigPage as ConfigPageSchema,
  type PaymentProviderChoiceList as ProviderChoiceListSchema,
  type SettlementAccountPage as SettlementPageSchema,
  type SettlementAccountRegistryStatusList as RegistryStatusListSchema,
} from '@udofin/contracts';
import { type z } from 'zod';

// The contracts export most of these as schemas only; the types the screens read are derived from them here.
export type FeatureSwitchList = z.infer<typeof FeatureSwitchListSchema>;
export type MerchantPage = z.infer<typeof MerchantPageSchema>;
export type PaymentConfigHistory = z.infer<typeof ConfigHistorySchema>;
export type PaymentConfigPage = z.infer<typeof ConfigPageSchema>;
export type PaymentProviderChoiceList = z.infer<typeof ProviderChoiceListSchema>;
export type SettlementAccountPage = z.infer<typeof SettlementPageSchema>;
export type SettlementAccountRegistryStatusList = z.infer<typeof RegistryStatusListSchema>;

/** The rows of rail limits a configuration form offers. */
export const RAIL_LIMIT_ROWS = 8;
/** The kinds of value a rail limit has: text as written, a yes or no, an amount (typed in rupees, stored in paise) or a count. */
export const RAIL_VALUE_KINDS = ['text', 'flag', 'amount', 'count'] as const;

/** What a successful draft hands back to the one form that asked: shown once, never put in an address or stored. */
export interface DraftedConfig {
  id: string;
  endpointToken: string;
  callbackPath: string;
}
