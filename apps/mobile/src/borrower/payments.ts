import { type ApiClient, type ApiResult } from '@udofin/auth-client';
import {
  BpHandoffLink,
  BpPaymentCancelled,
  BpPaymentDetail,
  BpPaymentOptions,
  BpPaymentRequest,
} from '@udofin/contracts';
import { newAttemptKey } from './payments-ids';

/** What the client reports when it refuses to send a request that does not match the contract. No request is made. */
export const CLIENT_REFUSAL = 'invalid_input';
const refused = (): { ok: false; status: number; code: string } => ({
  ok: false,
  status: 0,
  code: CLIENT_REFUSAL,
});

const id = encodeURIComponent;

/**
 * Borrower payment calls over the generic API client. Reads carry nothing but opaque ids in the path; the one write that creates
 * money movement carries an Idempotency-Key that the screen keeps for the same content and renews when the content changes.
 *
 * `paymentLink` returns the provider's hand-off link, a bearer secret. Callers use it inside one tap handler and drop it (see
 * payments-handoff.ts). Nothing in this file logs, stores or caches a response.
 */
export function createPaymentsClient(api: Pick<ApiClient, 'get' | 'post'>) {
  return {
    paymentOptions: (loanId: string) =>
      api.get(`/v1/loans/${id(loanId)}/payment-options`, BpPaymentOptions),

    /** The body is checked against the contract first: a malformed request never leaves the device. */
    requestPayment: (
      loanId: string,
      body: BpPaymentRequest,
      idempotencyKey: string,
    ): Promise<ApiResult<BpPaymentDetail>> => {
      const checked = BpPaymentRequest.safeParse(body);
      if (!checked.success) return Promise.resolve(refused());
      return api.post(
        `/v1/loans/${id(loanId)}/payments`,
        BpPaymentDetail,
        checked.data,
        idempotencyKey,
      );
    },

    payment: (paymentId: string) => api.get(`/v1/payments/${id(paymentId)}`, BpPaymentDetail),

    /** Fetch ONLY on the borrower's tap. */
    paymentLink: (paymentId: string) =>
      api.get(`/v1/payments/${id(paymentId)}/link`, BpHandoffLink),

    cancelPayment: (paymentId: string, idempotencyKey: string = newAttemptKey()) =>
      api.post(`/v1/payments/${id(paymentId)}/cancel`, BpPaymentCancelled, {}, idempotencyKey),
  };
}
export type PaymentsClient = ReturnType<typeof createPaymentsClient>;
