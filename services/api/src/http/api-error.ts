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
}

/**
 * Translates database errors that mean something to the caller. Anything else is not mapped, so the
 * caller gets a generic 500 and the details stay in the server log.
 */
export function mapDatabaseError(error: unknown): ApiError | undefined {
  const e = error as PgLikeError | null;
  if (!e || typeof e.code !== 'string') return undefined;
  if (e.code === '42501') {
    return e.hint === 'mfa_required'
      ? new ApiError(401, 'mfa_required', 'Unauthorized')
      : new ApiError(403, 'forbidden', 'Forbidden');
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
    case '23505':
    case '23514':
    case '55000':
      return new ApiError(409, 'conflict', 'Conflict');
    default:
      return undefined;
  }
}
