import { describe, expect, it } from 'vitest';

import {
  BALANCE,
  DEPTH_LADDER_SOL,
  classifyTrade,
  factionForSide,
  floorsMatchReference,
  victimOf,
} from './index.js';

describe('classifyTrade', () => {
  const ref = 2_000;

  it('treats an average-sized trade as normal', () => {
    expect(classifyTrade(2_500, ref)).toBe('normal');
  });

  it('promotes to heavy at the relative multiple', () => {
    expect(classifyTrade(ref * BALANCE.relHeavyMult, ref)).toBe('heavy');
  });

  it('promotes to whale at the relative multiple', () => {
    expect(classifyTrade(ref * BALANCE.relWhaleMult, ref)).toBe('whale');
  });

  it('holds the bar at the absolute floor on a quiet market', () => {
    // With a near-zero reference, 8x would be pennies. The floor keeps a $500
    // trade ordinary and only promotes once it clears relHeavyFloor.
    expect(classifyTrade(500, 10)).toBe('normal');
    expect(classifyTrade(BALANCE.relHeavyFloor, 10)).toBe('heavy');
  });

  it('clamps a nonsensical reference to the floor', () => {
    expect(classifyTrade(BALANCE.relWhaleFloor, 0)).toBe('whale');
    expect(classifyTrade(BALANCE.relWhaleFloor - 1, 0)).toBe('heavy');
  });

  it('never promotes on a busy market at sizes a quiet one would flag', () => {
    // Same $4k trade: a whale when the market is dead, noise when it is not.
    expect(classifyTrade(4_000, 0)).toBe('whale');
    expect(classifyTrade(4_000, 5_000)).toBe('normal');
  });
});

describe('BALANCE floors', () => {
  it('keeps absolute floors reachable and relative scaling alive', () => {
    // Both mechanisms must agree at the boundary, otherwise one is dead code.
    expect(floorsMatchReference()).toBe(true);
  });
});

describe('factions', () => {
  it('maps buyers to nexus and sellers to orc', () => {
    expect(factionForSide('buy')).toBe('nexus');
    expect(factionForSide('sell')).toBe('orc');
  });

  it('makes each side kill the other', () => {
    expect(victimOf('buy')).toBe('orc');
    expect(victimOf('sell')).toBe('nexus');
  });
});

describe('DEPTH_LADDER_SOL', () => {
  it('is strictly ascending', () => {
    const rungs = [...DEPTH_LADDER_SOL];
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(new Set(rungs).size).toBe(rungs.length);
  });
});
