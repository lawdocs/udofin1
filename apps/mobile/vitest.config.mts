import { defineConfig } from 'vitest/config';

// Only pure TypeScript modules are unit-tested here (no React Native runtime).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
