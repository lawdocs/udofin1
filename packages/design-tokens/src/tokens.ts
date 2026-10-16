/**
 * Design tokens shared by the borrower app (React Native) and the web portals (Next.js).
 * Screens reference semantic names (e.g. `color.text`, `space.md`), never raw hex values,
 * so the product team and partner lenders can re-skin the UI without code changes.
 */

export interface ColorTokens {
  /** Brand colour for primary actions. Tenant-overridable. */
  primary: string;
  /** Text/icon colour drawn on top of `primary`. Tenant-overridable. */
  onPrimary: string;
  /** Secondary brand accent. Tenant-overridable. */
  accent: string;
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  /** Status colours carry regulatory meaning (warnings, overdue amounts) and are locked. */
  success: string;
  warning: string;
  danger: string;
  info: string;
  focusRing: string;
}

export interface TypographyTokens {
  fontFamily: string;
  fontFamilyMono: string;
  size: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number };
  weight: { regular: number; medium: number; semibold: number; bold: number };
  lineHeight: { tight: number; normal: number; relaxed: number };
}

export interface Theme {
  name: string;
  mode: 'light' | 'dark';
  color: ColorTokens;
  typography: TypographyTokens;
  /** Spacing scale in density-independent pixels. */
  space: { xxs: number; xs: number; sm: number; md: number; lg: number; xl: number; xxl: number };
  radius: { sm: number; md: number; lg: number; pill: number };
  /** Minimum touch target (dp) for interactive elements — WCAG 2.2 target size. */
  minTouchTarget: number;
}

const typography: TypographyTokens = {
  fontFamily: 'Inter, "Noto Sans", "Noto Sans Devanagari", system-ui, sans-serif',
  fontFamilyMono: '"JetBrains Mono", ui-monospace, monospace',
  size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 22, xxl: 28 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.2, normal: 1.45, relaxed: 1.65 },
};

const space = { xxs: 2, xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
const radius = { sm: 6, md: 10, lg: 16, pill: 999 };

export const lightTheme: Theme = {
  name: 'udofin-light',
  mode: 'light',
  color: {
    primary: '#1D4ED8',
    onPrimary: '#FFFFFF',
    accent: '#0F766E',
    background: '#FFFFFF',
    surface: '#F8FAFC',
    surfaceMuted: '#F1F5F9',
    border: '#CBD5E1',
    text: '#0F172A',
    textMuted: '#475569',
    success: '#15803D',
    warning: '#B45309',
    danger: '#B91C1C',
    info: '#1D4ED8',
    focusRing: '#2563EB',
  },
  typography,
  space,
  radius,
  minTouchTarget: 44,
};

export const darkTheme: Theme = {
  name: 'udofin-dark',
  mode: 'dark',
  color: {
    primary: '#60A5FA',
    onPrimary: '#0B1220',
    accent: '#2DD4BF',
    background: '#0B1220',
    surface: '#111A2E',
    surfaceMuted: '#1A2540',
    border: '#334155',
    text: '#F1F5F9',
    textMuted: '#A3B1C6',
    success: '#4ADE80',
    warning: '#FBBF24',
    danger: '#F87171',
    info: '#60A5FA',
    focusRing: '#93C5FD',
  },
  typography,
  space,
  radius,
  minTouchTarget: 44,
};
