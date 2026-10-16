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

/**
 * Phase 08a read models: integer paise as a JSON number. The database caps every amount at 100,000,000,000,000 paise
 * (far below 2^53), so a number is exact. Never a float, never rupees.
 */
export const Paise = z.number().int().min(0).max(100_000_000_000_000);
export type Paise = z.infer<typeof Paise>;

/** A calendar date (YYYY-MM-DD), as the lender and the schedule state it. */
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type DateOnly = z.infer<typeof DateOnly>;
