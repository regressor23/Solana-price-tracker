import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.test.ts'],
    // Live upstream checks are opt-in via `npm run verify:upstream`; they need
    // the network and would make this suite fail for reasons unrelated to the
    // code under test.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.contract.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
