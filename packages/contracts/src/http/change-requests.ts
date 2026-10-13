import { z } from 'zod';

export const CHANGE_REQUEST_TYPES = [
  'organization.create',
  'organization.activate',
  'membership.invite',
  'membership.suspend',
  'role.grant',
  'role.revoke',
  'consent_notice.publish',
] as const;
export const CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'applied', 'expired'] as const;

export const ChangeRequest = z.object({
  id: z.uuid(),
  type: z.enum(CHANGE_REQUEST_TYPES),
  targetOrganizationId: z.uuid().nullable(),
  status: z.enum(CHANGE_REQUEST_STATUSES),
  requestedBy: z.uuid(),
  decidedBy: z.uuid().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;

export const ChangeRequestPage = z.object({
  items: z.array(ChangeRequest),
  nextCursor: z.string().nullable(),
});
export type ChangeRequestPage = z.infer<typeof ChangeRequestPage>;

export const ChangeRequestDecision = z.object({
  id: z.uuid(),
  status: z.enum(CHANGE_REQUEST_STATUSES),
});
export type ChangeRequestDecision = z.infer<typeof ChangeRequestDecision>;
