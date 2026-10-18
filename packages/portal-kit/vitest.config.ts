import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
    // The form tests type into long forms with simulated keystrokes; a busy machine must not turn that into a failure.
    testTimeout: 20_000,
  },
});
