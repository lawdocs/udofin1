import { z } from 'zod';

/** GET /v1/me. Identity and permissions are resolved by the server; clients only display them. */
export const MeResponse = z.object({
  userId: z.uuid(),
  actor: z.enum(['borrower', 'lender', 'platform']),
  memberships: z.array(
    z.object({
      membershipId: z.uuid(),
      organizationId: z.uuid(),
      organizationKind: z.string(),
      organizationName: z.string(),
      permissions: z.array(z.string()),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;
