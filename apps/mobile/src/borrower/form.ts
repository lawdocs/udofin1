import { type Language } from '../i18n';

/**
 * The loan-request form lives outside every translated component, so switching language never
 * resets what the borrower typed. Nothing here depends on the language.
 */
export interface RequestForm {
  categoryKey: string | null;
  purposeCode: string | null;
  amountText: string;
  monthsText: string;
  productVersionId: string | null;
  /** Server draft being edited, and the version we last saw. */
  draftId: string | null;
  draftVersion: number | null;
  /** Idempotency key for the current submit attempt so a retry after a lost response is the same attempt. */
  submitKey: string | null;
}

export const emptyForm = (): RequestForm => ({
  categoryKey: null,
  purposeCode: null,
  amountText: '',
  monthsText: '',
  productVersionId: null,
  draftId: null,
  draftVersion: null,
  submitKey: null,
});

export type FormAction =
  | {
      type: 'set';
      field: 'categoryKey' | 'purposeCode' | 'amountText' | 'monthsText' | 'productVersionId';
      value: string | null;
    }
  | { type: 'saved'; id: string; version: number }
  | { type: 'loaded'; form: Partial<RequestForm> }
  | { type: 'submitKey'; key: string | null }
  | { type: 'reset' };

export function formReducer(state: RequestForm, action: FormAction): RequestForm {
  switch (action.type) {
    case 'set': {
      // Any edit starts a new intent: an earlier submit key must not be reused for different content.
      const next = { ...state, [action.field]: action.value, submitKey: null };
      return action.field === 'categoryKey' && action.value !== state.categoryKey
        ? { ...next, productVersionId: null }
        : next;
    }
    case 'saved':
      return { ...state, draftId: action.id, draftVersion: action.version };
    case 'loaded':
      return { ...state, ...action.form, submitKey: null };
    case 'submitKey':
      return { ...state, submitKey: action.key };
    case 'reset':
      return emptyForm();
  }
}

/** Random enough to be unique per attempt; an idempotency key is not a secret. */
export function newIdempotencyKey(random: () => number = Math.random): string {
  const part = () =>
    Math.floor(random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  return `m-${part()}${part()}${part()}`;
}

/** Type-level guard that the form never depends on the UI language. */
export type FormIsLanguageFree = RequestForm extends { language: Language } ? never : true;
