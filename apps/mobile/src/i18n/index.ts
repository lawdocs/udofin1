import { en, type MessageKey } from './en';
import { hi } from './hi';

export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];
export type { MessageKey } from './en';

export const DEFAULT_LANGUAGE: Language = 'en';
const catalogues = { en, hi } satisfies Record<Language, Record<MessageKey, string>>;

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);

/** Replaces `{name}` placeholders. Unknown placeholders are left visible so a typo is noticed, not hidden. */
export function translate(
  language: Language,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const template = catalogues[language][key] ?? catalogues.en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

export const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

export const allCatalogues = catalogues;
