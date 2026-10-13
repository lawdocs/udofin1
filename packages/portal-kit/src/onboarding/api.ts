import { type ZodType } from 'zod';

/** What the onboarding screens need from the API client (structurally satisfied by @udofin/auth-client). */
export type OnboardingResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; code: string };

export interface OnboardingApi {
  get<T>(path: string, schema: ZodType<T>): Promise<OnboardingResult<T>>;
  post<T>(
    path: string,
    schema: ZodType<T>,
    body: unknown,
    idempotencyKey: string,
  ): Promise<OnboardingResult<T>>;
}

export type PortalKind = 'ops' | 'lender';
