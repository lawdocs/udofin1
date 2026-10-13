import { type BorrowerMe } from '@udofin/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n/I18nProvider';
import { type Language } from '../i18n';
import { createBorrowerClient, type BorrowerClient } from './client';
import { emptyForm, formReducer, type FormAction, type RequestForm } from './form';
import { resolveLanguage } from './journey';

type MeState =
  { kind: 'loading' } | { kind: 'ready'; me: BorrowerMe } | { kind: 'error'; code: string };

interface BorrowerContextValue {
  client: BorrowerClient;
  meState: MeState;
  refresh: () => Promise<void>;
  /** Changes the language on this device and, once signed in, on the account. The form is untouched. */
  changeLanguage: (language: Language) => Promise<void>;
  form: RequestForm;
  dispatch: Dispatch<FormAction>;
}

const BorrowerContext = createContext<BorrowerContextValue | null>(null);

export function useBorrower(): BorrowerContextValue {
  const value = useContext(BorrowerContext);
  if (!value) throw new Error('useBorrower must be used inside BorrowerProvider');
  return value;
}

/**
 * Loads the borrower's own account state from the API and holds the loan-request form above all
 * screens, so neither navigation nor a language change loses what was typed.
 */
export function BorrowerProvider({ children }: { children: ReactNode }) {
  const { api } = useAuth();
  const { language, setLanguage } = useI18n();
  const client = useMemo(() => createBorrowerClient(api), [api]);
  const [meState, setMeState] = useState<MeState>({ kind: 'loading' });
  const [form, dispatch] = useReducer(formReducer, undefined, emptyForm);
  const languageResolved = useRef(false);
  const languageRef = useRef(language);
  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  const apply = useCallback(
    (result: Awaited<ReturnType<BorrowerClient['me']>>) => {
      if (!result.ok) {
        setMeState({ kind: 'error', code: result.code });
        return;
      }
      if (!languageResolved.current) {
        languageResolved.current = true;
        const decision = resolveLanguage({
          local: languageRef.current,
          server: result.data.profile,
        });
        if (decision.language !== languageRef.current) setLanguage(decision.language);
        if (decision.pushToServer)
          void client.updateProfile({ preferredLanguage: decision.language });
      }
      setMeState({ kind: 'ready', me: result.data });
    },
    [client, setLanguage],
  );

  const refresh = useCallback(async () => {
    apply(await client.me());
  }, [client, apply]);

  useEffect(() => {
    let cancelled = false;
    void client.me().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [client, apply]);

  const changeLanguage = useCallback(
    async (next: Language) => {
      setLanguage(next);
      await client.updateProfile({ preferredLanguage: next });
      await refresh();
    },
    [client, refresh, setLanguage],
  );

  const value = useMemo(
    () => ({ client, meState, refresh, changeLanguage, form, dispatch }),
    [client, meState, refresh, changeLanguage, form],
  );
  return <BorrowerContext.Provider value={value}>{children}</BorrowerContext.Provider>;
}
