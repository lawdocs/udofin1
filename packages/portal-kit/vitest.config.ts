import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
    // The form tests type into long forms with simulated keystrokes and render long lists; a starved CI runner must not fail them on time.
    testTimeout: 30_000,
  },
});
