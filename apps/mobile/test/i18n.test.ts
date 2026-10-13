import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { hi } from '../src/i18n/hi';
import {
  allCatalogues,
  isLanguage,
  LANGUAGES,
  placeholders,
  translate,
  type MessageKey,
} from '../src/i18n';
import {
  DEFAULT_LANGUAGE,
  loadLanguage,
  saveLanguage,
  type KeyValueStore,
} from '../src/i18n/language-store';

describe('catalogues', () => {
  it('Hindi has exactly the English keys', () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
  });

  it('no string is empty, and Hindi uses the same placeholders as English', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(en[key].trim().length, `en ${key}`).toBeGreaterThan(0);
      expect(hi[key].trim().length, `hi ${key}`).toBeGreaterThan(0);
      expect(placeholders(hi[key]), `placeholders ${key}`).toEqual(placeholders(en[key]));
    }
  });

  it('Hindi text is actually Hindi where it is meant to be (not a copy of English)', () => {
    const copies = (Object.keys(en) as MessageKey[]).filter(
      (k) => hi[k] === en[k] && /[a-z]{4,}/i.test(en[k]) && !['home.title'].includes(k),
    );
    expect(copies).toEqual([]);
  });

  it('every static translation key used in the app exists', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(import.meta.dirname, '..', 'app'));
    walk(join(import.meta.dirname, '..', 'src'));
    const used = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1] ?? '');
      for (const m of text.matchAll(
        /'((?:common|error|signin|otp|home|profile|language|consent|request|requests|settings|delete|stepup)\.[a-zA-Z0-9_.]+)'/g,
      ))
        used.add(m[1] ?? '');
    }
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(40);
  });

  it('dynamic key families are complete (statuses, events, purposes, steps, errors)', () => {
    const need = [
      ...['draft', 'submitted', 'offer_selected', 'withdrawn', 'expired', 'closed'].map(
        (s) => `requests.status.${s}`,
      ),
      ...['created', 'updated', 'submitted', 'withdrawn', 'expired'].map(
        (s) => `requests.event.${s}`,
      ),
      ...['terms_of_use', 'privacy_notice', 'share_with_lenders', 'marketing'].map(
        (s) => `consent.purpose.${s}`,
      ),
      ...[
        'invalid_phone',
        'invalid_code',
        'rate_limited',
        'too_many_attempts',
        'resend_wait',
        'unavailable',
      ].map((s) => `otp.error.${s}`),
      ...['verified', 'invalid', 'expired', 'locked', 'not_found', 'already_verified'].map(
        (s) => `stepup.result.${s}`,
      ),
      ...['offer_acceptance', 'esign', 'bank_account_change', 'mandate_creation'].map(
        (s) => `stepup.action.${s}`,
      ),
      ...['requested', 'blocked', 'anonymised', 'cancelled'].map((s) => `delete.status.${s}`),
      ...LANGUAGES.map((l) => `language.${l}`),
    ];
    expect(need.filter((k) => !(k in en))).toEqual([]);
  });
});

describe('translate', () => {
  it('fills placeholders in the chosen language', () => {
    expect(translate('en', 'home.greeting', { name: 'Asha' })).toBe('Hello, Asha');
    expect(translate('hi', 'home.greeting', { name: 'आशा' })).toBe('नमस्ते, आशा');
    expect(translate('en', 'home.drafts', { count: 3 })).toBe('Drafts: 3');
  });
  it('leaves an unfilled placeholder visible rather than hiding the mistake', () => {
    expect(translate('en', 'home.greeting')).toBe('Hello, {name}');
  });
  it('knows its languages', () => {
    expect(Object.keys(allCatalogues).sort()).toEqual([...LANGUAGES].sort());
    expect(isLanguage('hi')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });
});

describe('language preference storage', () => {
  const memory = (initial: Record<string, string> = {}): KeyValueStore => {
    const data = new Map(Object.entries(initial));
    return {
      get: (k) => Promise.resolve(data.get(k) ?? null),
      set: (k, v) => (data.set(k, v), Promise.resolve()),
    };
  };
  it('round-trips a supported language', async () => {
    const store = memory();
    expect(await loadLanguage(store)).toBeNull();
    await saveLanguage(store, 'hi');
    expect(await loadLanguage(store)).toBe('hi');
  });
  it('ignores a stored value that is not a supported language', async () => {
    expect(await loadLanguage(memory({ 'udofin.language': 'fr' }))).toBeNull();
  });
  it('never throws when storage is unavailable', async () => {
    const broken: KeyValueStore = {
      get: () => Promise.reject(new Error('locked')),
      set: () => Promise.reject(new Error('locked')),
    };
    expect(await loadLanguage(broken)).toBeNull();
    await expect(saveLanguage(broken, 'en')).resolves.toBeUndefined();
    expect(DEFAULT_LANGUAGE).toBe('en');
  });
});
