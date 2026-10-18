import {
  type AccountFormatRuleEntry,
  type FeatureCatalogEntry,
  type FeatureChangeRequestEntry,
  type FeatureSwitchState,
  type FingerprintKeyVersionEntry,
  type LpException,
  type LpExceptionDetail,
  type MerchantEntry,
  type PaymentProviderEntry,
  type RegistryAccountEntry,
  type ReturnCodeClassEntry,
  type SettlementAccountForLinking,
} from '@udofin/contracts';
import { type z } from 'zod';

/** What a loader gives a view: the data, or a status and a stable code (never server text). */
export type Loaded<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; reasons?: readonly string[] };

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ProviderEntry = PaymentProviderEntry;
export type ReturnCodeEntry = z.infer<typeof ReturnCodeClassEntry>;
export type RuleEntry = AccountFormatRuleEntry;
export type KeyVersionEntry = z.infer<typeof FingerprintKeyVersionEntry>;
export type RegistryEntry = RegistryAccountEntry;
export type SettlementEntry = z.infer<typeof SettlementAccountForLinking>;
export type MerchantRow = MerchantEntry;
export type CatalogueEntry = z.infer<typeof FeatureCatalogEntry>;
export type SwitchState = FeatureSwitchState;
export type ChangeRequest = FeatureChangeRequestEntry;
export type PlatformException = z.infer<typeof LpException>;
export type ExceptionDetail = z.infer<typeof LpExceptionDetail>;

/** A lender the person can choose in a form: the id the API needs and the name to show. */
export interface LenderChoice {
  id: string;
  name: string;
}
