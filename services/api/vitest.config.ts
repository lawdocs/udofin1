import { defineConfig } from 'vitest/config';
import FixedOrderSequencer from './test/support/sequencer.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Integration files share one database and one outbox; running them one after another keeps their fixtures and jobs apart.
    fileParallelism: false,
    sequence: { sequencer: FixedOrderSequencer },
  },
});
