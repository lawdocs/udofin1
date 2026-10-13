import { z, type ZodType } from 'zod';
import { APPLICATION_OPERATIONS } from '../applications/operations.js';
import { PRODUCT_OPERATIONS } from '../products/operations.js';
import { type OnboardingApi, type OnboardingResult, type PortalKind } from './api.js';

/**
 * The only writes the onboarding screens can make. A form names an operation; this table maps it to
 * one API call with validated fields. Anything not listed here cannot be invoked from a portal, and
 * the API authorises every call again, so this list narrows the surface, it is not the authority.
 */

const text = (max = 2000) => z.string().trim().min(1).max(max);
const optText = (max = 2000) => text(max).optional();
const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

export interface Operation {
  portals: readonly PortalKind[];
  run(
    api: OnboardingApi,
    form: FormData,
    key: string,
  ): Promise<OnboardingResult<unknown> | { ok: false; status: number; code: string }>;
}

/** Base64 without Node's Buffer, so this module stays runtime-neutral. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const invalid = { ok: false as const, status: 422, code: 'validation_failed' };
const anyResponse: ZodType<unknown> = z.unknown();

/** Reads the string fields of a form; blank fields are treated as absent. */
function fields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string' && value.trim() !== '') out[name] = value.trim();
  }
  return out;
}

function define<S extends ZodType>(
  portals: readonly PortalKind[],
  schema: S,
  call: (api: OnboardingApi, input: z.output<S>, key: string) => Promise<OnboardingResult<unknown>>,
): Operation {
  return {
    portals,
    run: async (api, form, key) => {
      const parsed = schema.safeParse(fields(form));
      if (!parsed.success) return invalid;
      return call(api, parsed.data, key);
    },
  };
}

const both = ['ops', 'lender'] as const;
const ops = ['ops'] as const;
const post = (api: OnboardingApi, path: string, body: unknown, key: string) =>
  api.post(path, anyResponse, body, key);

const profileFields = {
  regulator: optText(80),
  registrationNo: optText(60),
  cin: optText(25),
  licenceType: optText(120),
  licenceIssuedOn: day.optional(),
  licenceValidUntil: day.optional(),
  licenceStatus: optText(20),
  notes: optText(2000),
};

const accountingFields = {
  accountingFramework: optText(60),
  indAsApplicability: optText(40),
  indAsImplementationStatus: optText(40),
  applicabilityBasis: optText(40),
  applicabilityBasisNote: optText(2000),
  effectiveFy: optText(7),
  effectiveDate: day.optional(),
  statementScope: optText(40),
  listedStatus: optText(40),
  groupRelationships: optText(2000),
  netWorthPaise: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  netWorthMeasuredOn: day.optional(),
  netWorthFy: optText(7),
  confirmationSource: optText(60),
  evidenceDocumentId: uuid.optional(),
  notes: optText(4000),
  nextReviewOn: day.optional(),
};

const serviceFields = {
  requestedScope: optText(4000),
  proposedScope: optText(4000),
  agreedScope: optText(4000),
  responsibleParty: optText(20),
  accountableParty: optText(20),
  sharedAllocation: optText(4000),
  prerequisites: optText(4000),
  dataExchanged: optText(4000),
  permittedPurpose: optText(2000),
  systemOfRecord: optText(30),
  integrationRequirements: optText(4000),
  slaSummary: optText(2000),
  escalationPath: optText(2000),
  contractReference: optText(120),
  effectiveFrom: day.optional(),
  reviewOn: day.optional(),
};

/** Fields that are only sent when present (an unticked or blank input never overwrites a value). */
const present = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

/** Supporting parties arrive as repeated checkboxes. */
function withSupporting(form: FormData, body: Record<string, unknown>): Record<string, unknown> {
  const supporting = form
    .getAll('supportingParties')
    .filter((v): v is string => typeof v === 'string');
  return supporting.length > 0 ? { ...body, supportingParties: supporting } : body;
}

const BASE_OPERATIONS: Readonly<Record<string, Operation>> = {
  'profile.create': define(
    ops,
    z.object({ lenderOrgId: uuid, categoryKey: text(40), ...profileFields }),
    (api, v, key) => post(api, '/v1/onboarding/lenders', present(v), key),
  ),
  'profile.update': define(
    both,
    z.object({ lenderId: uuid, categoryKey: optText(40), ...profileFields }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/profile`, present(rest), key),
  ),
  'verification.submit': define(
    both,
    z.object({ lenderId: uuid, evidenceDocumentId: uuid }),
    (api, v, key) =>
      post(
        api,
        `/v1/onboarding/lenders/${v.lenderId}/verification/submit`,
        { evidenceDocumentId: v.evidenceDocumentId },
        key,
      ),
  ),
  'verification.decide': define(
    ops,
    z.object({ lenderId: uuid, approve: bool, note: optText(), reverifyBy: day.optional() }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/verification/decision`, present(rest), key),
  ),
  'category.signoff': define(
    ops,
    z.object({ categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), sourceRef: text(500) }),
    (api, v, key) =>
      post(
        api,
        `/v1/onboarding/institution-categories/${v.categoryKey}/signoff`,
        { sourceRef: v.sourceRef },
        key,
      ),
  ),
  'category.revoke': define(
    ops,
    z.object({ categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) }),
    (api, v, key) =>
      post(api, `/v1/onboarding/institution-categories/${v.categoryKey}/revoke-signoff`, {}, key),
  ),
  'document.upload': {
    portals: both,
    run: async (api, form, key) => {
      const parsed = z
        .object({ lenderId: uuid, purpose: text(40), label: text(120) })
        .safeParse(fields(form));
      const file = form.get('file');
      if (!parsed.success || !(file instanceof File)) return invalid;
      if (file.size === 0 || file.size > MAX_FILE_BYTES) {
        return { ok: false as const, status: 413, code: 'document_too_large' };
      }
      const mimeType = MIME_TYPES.find((m) => m === file.type);
      if (!mimeType) return { ok: false as const, status: 422, code: 'document_type_mismatch' };
      const contentBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
      return post(
        api,
        `/v1/onboarding/lenders/${parsed.data.lenderId}/documents`,
        { purpose: parsed.data.purpose, label: parsed.data.label, mimeType, contentBase64 },
        key,
      );
    },
  },
  'accounting.save': define(
    both,
    z.object({ lenderId: uuid, ...accountingFields }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/accounting-profiles`, present(rest), key),
  ),
  'accounting.submit': define(both, z.object({ id: uuid }), (api, v, key) =>
    post(api, `/v1/onboarding/accounting-profiles/${v.id}/submit`, {}, key),
  ),
  'accounting.decide': define(
    ops,
    z.object({ id: uuid, approve: bool, note: optText() }),
    (api, v, key) =>
      post(
        api,
        `/v1/onboarding/accounting-profiles/${v.id}/decision`,
        present({ approve: v.approve, note: v.note }),
        key,
      ),
  ),
  'service.create': {
    portals: both,
    run: async (api, form, key) => {
      const parsed = z
        .object({ lenderId: uuid, categoryKey: text(50), title: text(160), ...serviceFields })
        .safeParse(fields(form));
      if (!parsed.success) return invalid;
      const { lenderId, ...rest } = parsed.data;
      return post(
        api,
        `/v1/onboarding/lenders/${lenderId}/services`,
        withSupporting(form, present(rest)),
        key,
      );
    },
  },
  'service.revise': {
    portals: both,
    run: async (api, form, key) => {
      const parsed = z.object({ id: uuid, ...serviceFields }).safeParse(fields(form));
      if (!parsed.success) return invalid;
      const { id, ...rest } = parsed.data;
      return post(
        api,
        `/v1/onboarding/services/${id}/revise`,
        withSupporting(form, present(rest)),
        key,
      );
    },
  },
  'service.agree': define(both, z.object({ id: uuid }), (api, v, key) =>
    post(api, `/v1/onboarding/service-versions/${v.id}/agree`, {}, key),
  ),
  'service.activate': define(ops, z.object({ id: uuid }), (api, v, key) =>
    post(api, `/v1/onboarding/service-versions/${v.id}/activate`, {}, key),
  ),
  'service.state': define(
    ops,
    z.object({ id: uuid, to: z.enum(['suspended', 'active', 'terminated']), note: text() }),
    (api, v, key) =>
      post(api, `/v1/onboarding/service-versions/${v.id}/state`, { to: v.to, note: v.note }, key),
  ),
  'requirement.generate': define(ops, z.object({ lenderId: uuid }), (api, v, key) =>
    post(api, `/v1/onboarding/lenders/${v.lenderId}/requirements/generate`, {}, key),
  ),
  'requirement.create': define(
    ops,
    z.object({
      lenderId: uuid,
      title: text(200),
      description: optText(),
      serviceId: uuid.optional(),
      dueOn: day.optional(),
      mandatory: bool.optional(),
      evidenceRequired: bool.optional(),
    }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/requirements`, present(rest), key),
  ),
  'requirement.status': define(
    both,
    z.object({ id: uuid, to: text(20), note: optText(), evidenceDocumentId: uuid.optional() }),
    (api, { id, ...rest }, key) =>
      post(api, `/v1/onboarding/requirements/${id}/status`, present(rest), key),
  ),
  'requirement.dependency': define(ops, z.object({ id: uuid, dependsOnId: uuid }), (api, v, key) =>
    post(
      api,
      `/v1/onboarding/requirements/${v.id}/dependencies`,
      { dependsOnId: v.dependsOnId },
      key,
    ),
  ),
  'integration.create': define(
    both,
    z.object({
      lenderId: uuid,
      kind: text(30),
      name: text(160),
      purpose: optText(),
      notes: optText(),
    }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/integrations`, present(rest), key),
  ),
  'integration.result': define(
    ops,
    z.object({
      id: uuid,
      status: z.enum(['in_progress', 'tested', 'failed']),
      evidenceDocumentId: uuid.optional(),
      testedOn: day.optional(),
      note: optText(),
    }),
    (api, { id, ...rest }, key) =>
      post(api, `/v1/onboarding/integrations/${id}/result`, present(rest), key),
  ),
  'integration.exception': define(ops, z.object({ id: uuid, reason: text() }), (api, v, key) =>
    post(api, `/v1/onboarding/integrations/${v.id}/exception`, { reason: v.reason }, key),
  ),
  'integration.exceptionDecide': define(ops, z.object({ id: uuid, approve: bool }), (api, v, key) =>
    post(
      api,
      `/v1/onboarding/integrations/${v.id}/exception/decision`,
      { approve: v.approve },
      key,
    ),
  ),
  'contract.record': define(
    ops,
    z.object({
      lenderId: uuid,
      contractType: text(40),
      reference: text(120),
      executedOn: day.optional(),
      effectiveFrom: day.optional(),
      effectiveUntil: day.optional(),
      documentId: uuid.optional(),
      status: z.enum(['draft', 'executed']).optional(),
      note: optText(),
    }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/contracts`, present(rest), key),
  ),
  'contract.decide': define(
    ops,
    z.object({ id: uuid, approve: bool, note: optText() }),
    (api, v, key) =>
      post(
        api,
        `/v1/onboarding/contracts/${v.id}/decision`,
        present({ approve: v.approve, note: v.note }),
        key,
      ),
  ),
  'waiver.request': define(ops, z.object({ lenderId: uuid, reason: text() }), (api, v, key) =>
    post(api, `/v1/onboarding/lenders/${v.lenderId}/accounting-waivers`, { reason: v.reason }, key),
  ),
  'waiver.decide': define(
    ops,
    z.object({ id: uuid, approve: bool, revoke: bool.optional(), note: optText() }),
    (api, { id, ...rest }, key) =>
      post(api, `/v1/onboarding/accounting-waivers/${id}/decision`, present(rest), key),
  ),
  'setting.set': define(
    ops,
    z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/), value: bool, reason: text() }),
    (api, v, key) =>
      post(api, `/v1/onboarding/settings/${v.key}`, { value: v.value, reason: v.reason }, key),
  ),
  'gate.request': define(
    ops,
    z.object({ lenderId: uuid, targetStage: text(40), note: optText() }),
    (api, { lenderId, ...rest }, key) =>
      post(api, `/v1/onboarding/lenders/${lenderId}/gate-requests`, present(rest), key),
  ),
  'gate.decide': define(
    ops,
    z.object({ id: uuid, approve: bool, note: optText() }),
    (api, v, key) =>
      post(
        api,
        `/v1/onboarding/gate-requests/${v.id}/decision`,
        present({ approve: v.approve, note: v.note }),
        key,
      ),
  ),
  'gate.cancel': define(ops, z.object({ id: uuid }), (api, v, key) =>
    post(api, `/v1/onboarding/gate-requests/${v.id}/cancel`, {}, key),
  ),
};

export const OPERATIONS: Readonly<Record<string, Operation>> = {
  ...BASE_OPERATIONS,
  ...PRODUCT_OPERATIONS,
  ...APPLICATION_OPERATIONS,
};

export type OperationOutcome = { ok: true } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

/** Runs the operation a form names. Unknown operations and operations of the other portal are refused. */
export async function runOperation(
  api: OnboardingApi,
  form: FormData,
  portal: PortalKind,
): Promise<OperationOutcome> {
  const name = form.get('op');
  const key = form.get('key');
  const operation =
    typeof name === 'string' && Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : undefined;
  if (!operation || !operation.portals.includes(portal))
    return { ok: false, code: 'path_not_allowed' };
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  const result = await operation.run(api, form, key);
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

/** Only same-portal onboarding pages may be returned to (prevents open redirects). */
export function safeReturnPath(value: unknown): string {
  return typeof value === 'string' &&
    (/^\/onboarding(\/categories|\/[0-9a-f-]{36}(\?tab=[a-z]{3,20})?)?$/.test(value) ||
      /^\/products$/.test(value) ||
      /^\/applications(\/[0-9a-f-]{36})?$/.test(value) ||
      /^\/transactions(\?[A-Za-z0-9=&,_.%:-]{0,600})?$/.test(value))
    ? value
    : '/onboarding';
}
