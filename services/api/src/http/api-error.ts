import { z } from 'zod';

/** Thrown by handlers for expected failures; rendered as RFC 9457 problem+json. Rolls back the request transaction. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(`${status} ${code}`);
  }
}

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  instance: z.string(),
  detail: z.string().optional(),
});

interface PgLikeError {
  code?: string;
  hint?: string;
  message?: string;
}

/**
 * Hints raised by our own SQL functions that are stable, safe to show and useful to a client. The
 * hint becomes the problem `code`. Messages are shown only for hints whose text carries no data.
 */
const RULE_HINTS: Readonly<Record<string, { showMessage: boolean }>> = {
  self_approval: { showMessage: false },
  gate_not_met: { showMessage: true },
  gate_order: { showMessage: false },
  gate_stale: { showMessage: false },
  evidence_required: { showMessage: false },
  unconfirmed_not_verifiable: { showMessage: false },
  version_immutable: { showMessage: false },
  agreed_scope_required: { showMessage: false },
  dependency_open: { showMessage: false },
  unsafe_free_text: { showMessage: false },
  document_quarantined: { showMessage: false },
  waiver_not_allowed: { showMessage: false },
};

/**
 * Translates database errors that mean something to the caller. Anything else is not mapped, so the
 * caller gets a generic 500 and the details stay in the server log.
 */
export function mapDatabaseError(error: unknown): ApiError | undefined {
  const e = error as PgLikeError | null;
  if (!e || typeof e.code !== 'string') return undefined;
  const rule = e.hint ? RULE_HINTS[e.hint] : undefined;
  if (e.code === '42501') {
    if (e.hint === 'mfa_required') return new ApiError(401, 'mfa_required', 'Unauthorized');
    return rule && e.hint
      ? new ApiError(403, e.hint, 'Forbidden')
      : new ApiError(403, 'forbidden', 'Forbidden');
  }
  if (rule && e.hint && (e.code === '55000' || e.code === '22023')) {
    return new ApiError(
      e.code === '22023' ? 422 : 409,
      e.hint,
      e.code === '22023' ? 'Unprocessable Content' : 'Conflict',
      rule.showMessage ? e.message : undefined,
    );
  }
  switch (e.code) {
    case 'IK409':
      return new ApiError(
        422,
        'idempotency_key_reused',
        'Idempotency key reused',
        'This Idempotency-Key was already used with a different request.',
      );
    case 'P0002':
      return new ApiError(404, 'not_found', 'Not Found');
    // Malformed values that passed the shape check but are not real dates/uuids/numbers.
    case '22007':
    case '22008':
    case '22P02':
      return new ApiError(422, 'invalid_request', 'Unprocessable Content');
    case '22023':
      return new ApiError(422, 'invalid_request', 'Unprocessable Content');
    case '23503':
      return new ApiError(422, 'invalid_reference', 'Unprocessable Content');
    case '23505':
    case '23514':
    case '55000':
      return new ApiError(409, 'conflict', 'Conflict');
    default:
      return undefined;
  }
}
