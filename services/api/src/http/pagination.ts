import { z } from 'zod';
import { ApiError } from './api-error.js';

/**
 * Keyset cursor over (timestamp, id). Opaque to clients. It is not signed: it only chooses a
 * position inside rows the caller is already allowed to see (row-level security still applies), so
 * tampering cannot widen access. Malformed cursors are rejected, never passed to SQL unvalidated.
 */
const CursorSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T][\d:.]+(\+|-)\d{2}(:?\d{2})?$/),
  id: z.uuid(),
});
export type Cursor = z.infer<typeof CursorSchema>;

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return undefined;
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Bad Request', 'The cursor is not valid.');
  }
}
