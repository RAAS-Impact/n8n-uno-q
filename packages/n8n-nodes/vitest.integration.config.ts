import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration.test.ts'],
    // Single-fork serial — the SSH server is a process singleton and
    // spawning ssh clients across parallel workers would race.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
