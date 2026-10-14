// Root ESLint flat config shared by every workspace.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ESLint replaces, it does not merge, the options of a rule when a later block sets the same rule for
// the same file. Blocks below that restrict imports under services/api/src therefore both list this.
const SYSTEM_POOL_PATTERN = {
  group: ['**/system/pool.js', '**/system/pool'],
  message: 'The system (service_role) pool is private to src/system and src/workers.',
};
const MODULE_BOUNDARY_MESSAGE =
  'API modules must not import each other (ADR 0003). Move code two modules need into a shared folder such as src/db, src/http or src/auth; do not reach into a sibling module.';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'supabase/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.config.mjs',
            '*.config.js',
            '*.config.ts',
            'apps/*/*.config.mjs',
            'apps/*/*.config.js',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain JS config files are not part of any TS project.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The domain package holds pure business rules: no I/O, no frameworks, no vendors.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'http',
                'https',
                'net',
                'pg',
                'pg-*',
                '@supabase/*',
                'fastify',
                'fastify-*',
                '@fastify/*',
                'react',
                'react-native',
                'next',
                'next/*',
                'axios',
              ],
              message: 'packages/domain must stay free of I/O, frameworks and vendors.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only src/system and src/workers may touch the service_role pool (spec W5).
    files: ['services/api/src/**/*.ts'],
    ignores: ['services/api/src/system/**', 'services/api/src/workers/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SYSTEM_POOL_PATTERN] }],
    },
  },
  {
    // Module boundaries: a module under services/api/src/modules may import itself (./x) and the
    // shared folders two levels up (../../http, ../../db, ../../auth ...), never a sibling module.
    // Module files sit directly in their folder, so any import that climbs exactly one level (../x)
    // lands in a sibling, and any path through `modules/` is another module's code. Limits: this
    // checks import/export declarations only (not import() or require()), and it assumes module files
    // stay directly inside their module folder; a nested sub-folder would need its own pattern.
    files: ['services/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            SYSTEM_POOL_PATTERN,
            { regex: '^\\.\\./(?!\\.\\./)', message: MODULE_BOUNDARY_MESSAGE },
            { regex: '(^|/)modules/', message: MODULE_BOUNDARY_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['apps/ops-portal/**/*.{ts,tsx}', 'apps/lender-portal/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: ['apps/ops-portal/', 'apps/lender-portal/'] } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
