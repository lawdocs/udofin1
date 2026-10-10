import { describe, expect, it } from 'vitest';
import {
  applyTenantBranding,
  contrastRatio,
  MIN_TEXT_CONTRAST,
  ThemeValidationError,
  toCssVariables,
} from './theme.js';
import { darkTheme, lightTheme } from './tokens.js';

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('base themes', () => {
  it.each([lightTheme, darkTheme])('$name keeps text legible', (theme) => {
    expect(contrastRatio(theme.color.text, theme.color.background)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
    expect(contrastRatio(theme.color.textMuted, theme.color.background)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
    expect(contrastRatio(theme.color.onPrimary, theme.color.primary)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
    for (const status of ['danger', 'warning', 'success'] as const) {
      expect(contrastRatio(theme.color[status], theme.color.background)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('applyTenantBranding', () => {
  it('applies a legible lender brand colour', () => {
    const themed = applyTenantBranding(lightTheme, {
      displayName: 'Example NBFC',
      colors: { primary: '#7C2D12', onPrimary: '#FFFFFF' },
    });
    expect(themed.color.primary).toBe('#7C2D12');
    expect(themed.color.danger).toBe(lightTheme.color.danger);
    expect(themed.name).toBe('udofin-light:Example NBFC');
  });

  it('refuses to let a lender restyle locked status colours', () => {
    expect(() =>
      applyTenantBranding(lightTheme, { colors: { danger: '#00FF00' } as never }),
    ).toThrow(ThemeValidationError);
  });

  it('refuses unreadable combinations instead of silently fixing them', () => {
    expect(() =>
      applyTenantBranding(lightTheme, { colors: { primary: '#FFFF00', onPrimary: '#FFFFFF' } }),
    ).toThrow(/contrast/);
  });

  it('refuses malformed colours', () => {
    expect(() => applyTenantBranding(lightTheme, { colors: { primary: 'red' } })).toThrow(
      /#RRGGBB/,
    );
  });
});

describe('toCssVariables', () => {
  it('exposes semantic tokens as CSS custom properties', () => {
    const vars = toCssVariables(lightTheme);
    expect(vars['--color-primary']).toBe(lightTheme.color.primary);
    expect(vars['--color-text-muted']).toBe(lightTheme.color.textMuted);
    expect(vars['--space-md']).toBe('16px');
  });
});
