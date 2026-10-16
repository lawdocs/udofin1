import { DEFAULT_LANGUAGE, isLanguage, type Language } from './index';

/** Minimal async key-value port (SecureStore in the app, a Map in tests). A language choice is not sensitive. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const KEY = 'udofin.language';

export async function loadLanguage(store: KeyValueStore): Promise<Language | null> {
  try {
    const value = await store.get(KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null; // storage unavailable: fall back to the default, never block the app
  }
}

export async function saveLanguage(store: KeyValueStore, language: Language): Promise<void> {
  try {
    await store.set(KEY, language);
  } catch {
    // The choice still applies for this session and is also saved to the account once signed in.
  }
}

export { DEFAULT_LANGUAGE };
