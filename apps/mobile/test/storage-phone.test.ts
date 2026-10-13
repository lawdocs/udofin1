import { describe, expect, it } from 'vitest';
import { maskPhone, normaliseIndianMobile } from '../src/auth/phone';
import {
  createSecureSessionStorage,
  type SecureStoreLike,
} from '../src/auth/secure-session-storage';

function fakeStore() {
  const data = new Map<string, string>();
  const store: SecureStoreLike = {
    getItemAsync: (k) => Promise.resolve(data.get(k) ?? null),
    setItemAsync: (k, v) => {
      if (v.length > 2048) return Promise.reject(new Error('value too large for SecureStore'));
      data.set(k, v);
      return Promise.resolve();
    },
    deleteItemAsync: (k) => (data.delete(k), Promise.resolve()),
  };
  return { store, data };
}

describe('secure session storage', () => {
  it('round-trips a session larger than one SecureStore value', async () => {
    const { store, data } = fakeStore();
    const storage = createSecureSessionStorage(store);
    const value = JSON.stringify({ accessToken: 'a'.repeat(4000), refreshToken: 'r'.repeat(100) });
    await storage.save(value);
    expect(data.size).toBeGreaterThan(2);
    expect(await storage.load()).toBe(value);
  });

  it('replaces the previous session completely and clears every chunk', async () => {
    const { store, data } = fakeStore();
    const storage = createSecureSessionStorage(store);
    await storage.save('x'.repeat(5000));
    await storage.save('short');
    expect(await storage.load()).toBe('short');
    expect(data.size).toBe(2);
    await storage.clear();
    expect(data.size).toBe(0);
    expect(await storage.load()).toBeNull();
  });

  it('treats a torn or tampered write as no session', async () => {
    const { store, data } = fakeStore();
    const storage = createSecureSessionStorage(store);
    await storage.save('y'.repeat(4000));
    data.delete('udofin.session.1');
    expect(await storage.load()).toBeNull();
    data.set('udofin.session.n', '9999');
    expect(await storage.load()).toBeNull();
    data.set('udofin.session.n', 'abc');
    expect(await storage.load()).toBeNull();
  });
});

describe('phone numbers', () => {
  it('normalises common Indian formats to E.164', () => {
    for (const input of [
      '9876543210',
      '09876543210',
      '+91 98765 43210',
      '91-98765-43210',
      '(98765) 43210',
    ]) {
      expect(normaliseIndianMobile(input)).toBe('+919876543210');
    }
  });

  it('rejects anything that cannot be an Indian mobile number', () => {
    for (const input of [
      '',
      '12345',
      '5876543210',
      '98765432101',
      '+1 650 555 0100',
      'abcdefghij',
      '+91 98765 4321x',
    ]) {
      expect(normaliseIndianMobile(input)).toBeNull();
    }
  });

  it('masks the number for display', () => {
    expect(maskPhone('+919876543210')).toBe('+9198•••••210');
    expect(maskPhone('+9')).toBe('•••');
  });
});
