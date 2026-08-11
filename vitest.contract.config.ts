import { defineConfig } from 'vitest/config';

/**
 * Live checks against Jupiter, run by `npm run verify:upstream`.
 *
 * Kept out of the default suite and out of CI: they need the network, spend
 * real rate budget, and can fail for reasons that have nothing to do with the
 * commit under test. A gate that goes red for someone else's throttle stops
 * being a gate people trust.
 */
export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.contract.test.ts'],
    environment: 'node',
    // Paced requests plus a deliberate 4s wait in the turnover check.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Serial: parallel files would spend the rate budget several times over.
    fileParallelism: false,
    maxConcurrency: 1,
    retry: 1,
  },
});
