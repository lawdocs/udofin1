import { lightTheme, toCssVariables } from '@udofin/design-tokens';

/**
 * Serves design tokens as CSS custom properties from the same origin, so pages need no inline
 * styles (keeping the CSP strict). Lender-specific branding will be layered on here in Phase 4.
 */
export function GET() {
  const declarations = Object.entries(toCssVariables(lightTheme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return new Response(`:root {\n${declarations}\n}\n`, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
