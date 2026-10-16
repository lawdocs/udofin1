import { type ColorTokens, type Theme } from './tokens.js';

/**
 * Colours a partner lender may brand. Everything else (text, status colours, surfaces) stays
 * under platform control so that warnings, overdue amounts and disclosures remain legible.
 */
export const TENANT_OVERRIDABLE_COLORS = ['primary', 'onPrimary', 'accent'] as const;
export type TenantColorKey = (typeof TENANT_OVERRIDABLE_COLORS)[number];

export interface TenantBranding {
  displayName?: string;
  colors?: Partial<Pick<ColorTokens, TenantColorKey>>;
}

export class ThemeValidationError extends Error {
  override readonly name = 'ThemeValidationError';

  constructor(readonly problems: readonly string[]) {
    super(`Theme rejected: ${problems.join('; ')}`);
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

/** WCAG 2.x contrast ratio between two #RRGGBB colours (1 to 21). */
export function contrastRatio(foreground: string, background: string): number {
  for (const value of [foreground, background]) {
    if (!HEX.test(value)) throw new ThemeValidationError([`"${value}" is not a #RRGGBB colour`]);
  }
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;
/** WCAG AA for UI components and large text. */
export const MIN_UI_CONTRAST = 3;

/**
 * Applies a lender's branding on top of a base theme. Rejects unknown keys, malformed colours and
 * combinations that would make primary buttons or links unreadable, instead of silently "fixing" them.
 */
export function applyTenantBranding(base: Theme, branding: TenantBranding): Theme {
  const problems: string[] = [];
  const overrides = branding.colors ?? {};

  for (const key of Object.keys(overrides)) {
    if (!(TENANT_OVERRIDABLE_COLORS as readonly string[]).includes(key)) {
      problems.push(`colour "${key}" is not tenant-overridable`);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'string' || !HEX.test(value)) {
      problems.push(`colour "${key}" must be #RRGGBB`);
    }
  }
  if (problems.length > 0) throw new ThemeValidationError(problems);

  const color: ColorTokens = { ...base.color, ...overrides };
  const onPrimary = contrastRatio(color.onPrimary, color.primary);
  if (onPrimary < MIN_TEXT_CONTRAST) {
    problems.push(`onPrimary/primary contrast ${onPrimary.toFixed(2)} < ${MIN_TEXT_CONTRAST}`);
  }
  const primaryOnBackground = contrastRatio(color.primary, color.background);
  if (primaryOnBackground < MIN_UI_CONTRAST) {
    problems.push(
      `primary/background contrast ${primaryOnBackground.toFixed(2)} < ${MIN_UI_CONTRAST}`,
    );
  }
  if (problems.length > 0) throw new ThemeValidationError(problems);

  return {
    ...base,
    name: branding.displayName ? `${base.name}:${branding.displayName}` : base.name,
    color,
  };
}

/** Flattens a theme into CSS custom properties for the web portals, e.g. `--color-primary`. */
export function toCssVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  for (const [key, value] of Object.entries(theme.color) as [string, string][]) {
    vars[`--color-${kebab(key)}`] = value;
  }
  for (const [key, value] of Object.entries(theme.space)) vars[`--space-${key}`] = `${value}px`;
  for (const [key, value] of Object.entries(theme.radius)) vars[`--radius-${key}`] = `${value}px`;
  for (const [key, value] of Object.entries(theme.typography.size)) {
    vars[`--font-size-${key}`] = `${value}px`;
  }
  vars['--font-family'] = theme.typography.fontFamily;
  vars['--font-family-mono'] = theme.typography.fontFamilyMono;
  return vars;
}
