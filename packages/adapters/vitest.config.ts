import { defineConfig } from 'vitest/config';

// PDF rendering embeds two fonts and shells out to pdftotext; a shared CI runner needs more than the 5 s default.
export default defineConfig({ test: { testTimeout: 60_000 } });
