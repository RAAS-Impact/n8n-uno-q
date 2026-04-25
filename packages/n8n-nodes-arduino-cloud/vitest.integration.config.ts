import path from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Load `.env` from the monorepo root so users can put credentials there
// once and have every package's integration suite pick them up. We resolve
// against this config file's own directory + ../.. (= repo root); INIT_CWD
// would also work but is brittle when vitest is invoked from a sub-shell.
const repoRoot = path.resolve(__dirname, '../..');
const envFromDotfile = loadEnv('', repoRoot, '');

export default defineConfig({
  test: {
    include: ['test/integration.test.ts'],
    // MQTT subscribe + property-update propagation can take a few seconds on
    // a healthy run; the broker's first hop dominates.
    testTimeout: 30_000,
    // Anything the user already exported in their shell wins — vitest merges
    // this map under process.env without overwriting existing keys.
    env: envFromDotfile,
  },
});
