import { z } from 'zod';

/** RFC 9562 UUID (any version). Udofin generates time-ordered v7 identifiers. */
export const Uuid = z.uuid();

/** RFC 3339 timestamp with an explicit offset; integrations must never send local times. */
export const Timestamp = z.iso.datetime({ offset: true });

/**
 * Money on the wire: integer minor units (paise) as a decimal string, because JSON numbers
 * cannot represent all 64-bit integers exactly.
 */
export const MoneyMinor = z.object({
  minor: z.string().regex(/^-?\d{1,18}$/, 'integer paise as a string'),
  currency: z.literal('INR'),
});
export type MoneyMinor = z.infer<typeof MoneyMinor>;

/**
 * Sensitivity label carried with every event and export so consumers can apply the right
 * handling (logging, retention, onward sharing). `restricted` covers identity documents,
 * bureau data and anything that must never appear in logs.
 */
export const DataClassification = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type DataClassification = z.infer<typeof DataClassification>;
