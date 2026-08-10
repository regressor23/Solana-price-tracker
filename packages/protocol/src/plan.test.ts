import { describe, expect, it } from 'vitest';

import {
  FAST_PROFILE_DEMAND_PER_MIN,
  JUPITER_PLAN_RPS,
  RATE_BUDGET_PER_MIN,
  budgetForRps,
  profileForRps,
} from './index.js';

/**
 * Jupiter's published tiers, 2026-08-11: keyless 0.5 RPS, free 1, developer 10,
 * launch 50, pro 150. The free plan is the trap — a key on it buys exactly the
 * 60/min the keyless lite host already allows, so a key alone must never unlock
 * a faster cadence.
 */

describe('budgetForRps', () => {
  it('leaves headroom rather than spending the whole allowance', () => {
    expect(budgetForRps(10)).toBeLessThan(10 * 60);
  });

  it('never returns a rate that would stall the feed', () => {
    expect(budgetForRps(0)).toBeGreaterThanOrEqual(12);
  });

  it('scales with the plan', () => {
    expect(budgetForRps(JUPITER_PLAN_RPS.developer)).toBeGreaterThan(
      budgetForRps(JUPITER_PLAN_RPS.free),
    );
  });
});

describe('profileForRps', () => {
  it('keeps the free plan on the slow cadence', () => {
    // The whole point: a free key is not a faster key.
    expect(profileForRps(JUPITER_PLAN_RPS.free)).toBe('lite');
  });

  it('keeps keyless on the slow cadence', () => {
    expect(profileForRps(JUPITER_PLAN_RPS.keyless)).toBe('lite');
  });

  it('unlocks the fast cadence on a paid plan', () => {
    expect(profileForRps(JUPITER_PLAN_RPS.developer)).toBe('fast');
    expect(profileForRps(JUPITER_PLAN_RPS.pro)).toBe('fast');
  });

  it('demands more than the free plan can give', () => {
    // If this ever stopped holding, the fast profile would be reachable on a
    // plan that cannot serve it and the collector would throttle itself again.
    expect(FAST_PROFILE_DEMAND_PER_MIN).toBeGreaterThan(
      budgetForRps(JUPITER_PLAN_RPS.free),
    );
  });

  it('demands more than the keyless lite budget, so falling back is honest', () => {
    expect(FAST_PROFILE_DEMAND_PER_MIN).toBeGreaterThan(RATE_BUDGET_PER_MIN.liteApi);
  });
});
