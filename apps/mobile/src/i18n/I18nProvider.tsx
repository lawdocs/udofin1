import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_LANGUAGE, translate, type Language, type MessageKey } from './index';
import { loadLanguage, saveLanguage, type KeyValueStore } from './language-store';

const store: KeyValueStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
};

interface I18nValue {
  language: Language;
  /** Persists on this device. Callers that are signed in also save it to the account. */
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

/**
 * Holds the language for the whole app. Changing it only changes the strings: screens are not
 * remounted, so anything typed into a form is kept.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(store).then((saved) => {
      if (!cancelled && saved) setLanguageState(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void saveLanguage(store, next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ language, setLanguage, t: (key, vars) => translate(language, key, vars) }),
    [language, setLanguage],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
