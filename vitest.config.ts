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

    /**
     * Reported, never enforced.
     *
     * A threshold in CI buys tests written for the percentage, and the ones
     * worth having here covered no new lines at all: a repeated pulse, a frame
     * that took no time, a count the wire can carry and the pool cannot. Those
     * are states, not statements. The number is for reading — it says which
     * files nothing has looked at yet — and `npm run check` deliberately does
     * not run it.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['{packages,apps}/*/src/**/*.ts'],
      // The two entry points, and only those. Both are startup wiring — a
      // listen call on one side, a page's element lookups on the other — with
      // no decision in either that a test could reach without booting the
      // thing. Counting them says nothing except how long they are.
      //
      // `webgl.ts` is deliberately *not* excluded, though most of it cannot
      // run here. Its uncovered fraction is the honest measure of how much of
      // the client only a GPU can check, and the whole point of that file is
      // to keep the fraction small.
      exclude: ['**/*.test.ts', 'apps/collector/src/index.ts', 'apps/web/src/main.ts'],
    },
  },
});
