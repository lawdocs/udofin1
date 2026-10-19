import { createHash } from 'node:crypto';
import { ApiError } from '../http/api-error.js';
import { type UserTx } from '../db/user-context.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

/** Canonical JSON: object keys sorted recursively, so equivalent payloads hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function requestFingerprint(input: {
  route: string;
  params: unknown;
  body: unknown;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export function parseIdempotencyKey(header: unknown): string {
  const value: unknown = Array.isArray(header) ? (header as unknown[])[0] : header;
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new ApiError(
      400,
      'idempotency_key_required',
      'Bad Request',
      'Send an Idempotency-Key header of 16 to 128 characters (letters, digits, . _ : -).',
    );
  }
  return value;
}

export type IdempotencyStart =
  { outcome: 'proceed' } | { outcome: 'replay'; status: number; body: unknown };

/**
 * Starts an idempotent operation inside the caller's transaction. The record is created in the
 * SAME transaction as the domain write: if the write rolls back, the key disappears and a retry
 * runs again; a concurrent duplicate waits for this transaction and then replays its stored result.
 */
export async function beginIdempotent(
  tx: UserTx,
  input: { route: string; key: string; fingerprint: string; tenantOrgId: string | null },
): Promise<IdempotencyStart> {
  const result = await tx.query<{
    outcome: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    'select outcome, response_status, response_body from private.idempotency_begin($1, $2, $3, $4::uuid)',
    [input.route, input.key, input.fingerprint, input.tenantOrgId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('idempotency_begin returned nothing');
  if (row.outcome === 'replay') {
    return { outcome: 'replay', status: row.response_status ?? 200, body: row.response_body };
  }
  return { outcome: 'proceed' };
}

export async function completeIdempotent(
  tx: UserTx,
  input: { route: string; key: string; status: number; body: unknown },
): Promise<void> {
  await tx.query('select private.idempotency_complete($1, $2, $3, $4::jsonb)', [
    input.route,
    input.key,
    input.status,
    JSON.stringify(input.body ?? null),
  ]);
}
