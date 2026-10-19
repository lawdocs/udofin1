import { z } from 'zod';
import { DataClassification, Timestamp, Uuid } from '../primitives.js';

/**
 * Event type naming: reverse-DNS product prefix, aggregate, past-tense fact, major version.
 * Example: `in.udofin.application.submitted.v1`. A breaking payload change requires a new
 * major version; producers publish both versions until every consumer has migrated.
 */
export const EVENT_TYPE_PATTERN =
  /^in\.(udofin|finbyx|lawdocscomply|equator)\.[a-z_]+\.[a-z_]+\.v\d+$/;

/**
 * Integration event envelope, based on CloudEvents 1.0 (structured JSON mode) with Udofin
 * extension attributes. Used on queues, webhooks to partner systems and the outbox table.
 */
export const EventEnvelope = z.object({
  specversion: z.literal('1.0'),
  /** Unique per event; consumers de-duplicate on (source, id). */
  id: Uuid,
  /** URI reference of the producing system, e.g. `urn:udofin:api`. */
  source: z.string().min(1).max(200),
  type: z.string().regex(EVENT_TYPE_PATTERN, 'in.<product>.<aggregate>.<fact>.v<major>'),
  time: Timestamp,
  /** Aggregate identifier the event is about (never a PAN, Aadhaar number or phone number). */
  subject: z.string().min(1).max(200),
  datacontenttype: z.literal('application/json'),
  /** Partner lender (tenant) the event belongs to; absent only for platform-level events. */
  tenantid: Uuid.optional(),
  /** Groups every event caused by one business request across services. */
  correlationid: Uuid,
  /** The event or command that directly caused this one. */
  causationid: Uuid.optional(),
  dataclassification: DataClassification,
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Parses untrusted input into an envelope, returning typed issues instead of throwing. */
export function parseEventEnvelope(input: unknown) {
  return EventEnvelope.safeParse(input);
}
