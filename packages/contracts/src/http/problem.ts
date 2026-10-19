import { z } from 'zod';

/**
 * Error body for every HTTP API (RFC 9457 "Problem Details for HTTP APIs").
 * `detail` is written for the caller and must never include stack traces, SQL,
 * provider responses or personal data.
 */
export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  /** Request identifier the caller can quote to support. */
  instance: z.string().optional(),
  /** Stable machine-readable code, e.g. `consent_required`, `rate_limited`. */
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Field-level validation issues, when relevant. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
