import { darkTheme, lightTheme, type Theme } from '@udofin/design-tokens';
import { useColorScheme } from 'react-native';

/** Returns the active theme. Lender branding is applied server-side config later (Phase 4). */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
