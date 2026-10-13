import { type SessionStorage } from '@udofin/auth-client';

/** The slice of expo-secure-store we use (injected so this module is testable without a device). */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

// SecureStore warns above ~2 KB per value on some platforms, so a session is split into chunks.
const CHUNK = 1500;
const PREFIX = 'udofin.session';

/**
 * Persists the session in the platform keystore (Android Keystore / iOS Keychain through
 * expo-secure-store). Nothing is written to AsyncStorage, files or logs.
 */
export function createSecureSessionStorage(store: SecureStoreLike): SessionStorage {
  const countKey = `${PREFIX}.n`;
  const chunkKey = (i: number) => `${PREFIX}.${String(i)}`;

  async function clear(): Promise<void> {
    const n = Number(await store.getItemAsync(countKey));
    await store.deleteItemAsync(countKey);
    for (let i = 0; Number.isInteger(n) && i < n && i < 20; i += 1)
      await store.deleteItemAsync(chunkKey(i));
  }

  return {
    async load() {
      const n = Number(await store.getItemAsync(countKey));
      if (!Number.isInteger(n) || n < 1 || n > 20) return null;
      const parts: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const part = await store.getItemAsync(chunkKey(i));
        if (part === null) return null; // a torn write is treated as no session
        parts.push(part);
      }
      return parts.join('');
    },
    async save(value) {
      await clear();
      const chunks = value.match(new RegExp(`.{1,${String(CHUNK)}}`, 'gs')) ?? [];
      for (let i = 0; i < chunks.length; i += 1)
        await store.setItemAsync(chunkKey(i), chunks[i] ?? '');
      await store.setItemAsync(countKey, String(chunks.length)); // written last: readers never see a half session
    },
    clear,
  };
}
