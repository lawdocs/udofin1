import { type ApiClient, type ApiResult } from '@udofin/auth-client';
import {
  BpHandoffLink,
  BpMandate,
  BpMandateCancelRequested,
  BpMandateDebitList,
  BpMandateList,
  BpMandateOptions,
  BpMandateRequest,
} from '@udofin/contracts';
import { CLIENT_REFUSAL } from './payments';
import { newAttemptKey } from './payments-ids';

const id = encodeURIComponent;

/**
 * Borrower mandate calls over the generic API client. The step-up code (action `mandate_creation`, bound to the mandate id) is
 * asked for and checked by the existing step-up screen BEFORE `requestMandate`; the API refuses a request without it.
 *
 * `requestMandate` checks the body against the contract first. The contract only accepts a MASKED account reference (letters X
 * or *, then 2 to 4 digits), so even a screen bug cannot send a full account number: the request is refused on the device.
 */
export function createMandatesClient(api: Pick<ApiClient, 'get' | 'post'>) {
  return {
    mandateOptions: (loanId: string) =>
      api.get(`/v1/loans/${id(loanId)}/mandate-options`, BpMandateOptions),

    requestMandate: (
      loanId: string,
      body: BpMandateRequest,
      idempotencyKey: string,
    ): Promise<ApiResult<BpMandate>> => {
      const checked = BpMandateRequest.safeParse(body);
      if (!checked.success) {
        return Promise.resolve({ ok: false, status: 0, code: CLIENT_REFUSAL });
      }
      return api.post(`/v1/loans/${id(loanId)}/mandates`, BpMandate, checked.data, idempotencyKey);
    },

    mandates: () => api.get('/v1/mandates', BpMandateList),
    mandate: (mandateId: string) => api.get(`/v1/mandates/${id(mandateId)}`, BpMandate),
    debits: (mandateId: string) =>
      api.get(`/v1/mandates/${id(mandateId)}/debits`, BpMandateDebitList),

    /** Fetch ONLY on the borrower's tap, and only while the status is `registration_pending`. */
    mandateLink: (mandateId: string) =>
      api.get(`/v1/mandates/${id(mandateId)}/link`, BpHandoffLink),

    /** A REQUEST: the mandate is cancelled only when the provider confirms it. */
    requestCancellation: (mandateId: string, idempotencyKey: string = newAttemptKey()) =>
      api.post(
        `/v1/mandates/${id(mandateId)}/cancel`,
        BpMandateCancelRequested,
        {},
        idempotencyKey,
      ),
  };
}
export type MandatesClient = ReturnType<typeof createMandatesClient>;
