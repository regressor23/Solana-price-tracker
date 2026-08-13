import {
  BALANCE,
  usdPerTroop,
  type DepthSnapshot,
  type Flow,
  type MarketEvent,
  type Trade,
} from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { replay } from './replay.js';
import { BattleScorer } from './scorer.js';

/** Today's measured market: $104k a minute, so ~$870 buys one life. */
const VOLUME = 104_150;

const flow = (t: number, buyUsd: number, sellUsd: number): Flow => ({
  type: 'flow',
  t,
  buyUsd,
  sellUsd,
  trades: 4,
});

const trade = (t: number, side: 'buy' | 'sell', usd: number): Trade => ({
  type: 'trade',
  t,
  side,
  usd,
  price: 75.85,
  tier: usd >= 23_000 ? 'whale' : 'heavy',
});

const depth = (t: number, bidWallUsd: number, askWallUsd: number): DepthSnapshot => ({
  type: 'depth',
  t,
  mid: 75.85,
  bids: [],
  asks: [],
  bidWallUsd,
  askWallUsd,
});

/** Seeded, so a balance invariant can never flake into a green run. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A balanced hour at the volume production actually runs at.
 *
 * The jitter is not decoration. A perfectly symmetric stream makes every round
 * an honest draw, which tells us nothing about whether the scorer can be moved
 * — real markets are balanced on average and lopsided second to second, and
 * that is the case the verdict has to handle.
 */
function balancedStream(minutes: number, from = 0): MarketEvent[] {
  const events: MarketEvent[] = [];
  const rand = noise(20_260_813);
  const perSecond = VOLUME / 60;

  for (let second = 0; second < minutes * 60; second++) {
    const t = from + second * 1_000;
    const tilt = rand() * 0.6 - 0.3;
    events.push(flow(t, (perSecond / 2) * (1 + tilt), (perSecond / 2) * (1 - tilt)));
    if (second % 30 === 0) events.push(depth(t, 5_000_000, 5_000_000));
  }
  return events;
}

describe('usdPerTroop', () => {
  it('follows live volume so the battle keeps its pace', () => {
    // The whole reason it is derived: ten times the volume must not mean ten
    // times the casualties, or a busy hour wipes the field.
    expect(usdPerTroop(VOLUME)).toBeCloseTo(VOLUME / BALANCE.targetCasualtiesPerMin, 5);
    expect(usdPerTroop(VOLUME * 10)).toBeCloseTo(usdPerTroop(VOLUME) * 10, 5);
  });

  it('falls back before the candle feed has answered', () => {
    expect(usdPerTroop(null)).toBe(BALANCE.fallbackUsdPerTroop);
  });

  it('guards the divide without neutering the derivation', () => {
    // The floor must bind only on a market that has genuinely stopped. If it
    // bound at ordinary volume the derivation would be decorative.
    expect(usdPerTroop(VOLUME / 2)).toBeLessThan(usdPerTroop(VOLUME));
    expect(usdPerTroop(1)).toBe(BALANCE.minUsdPerTroop);
  });
});

describe('casualties', () => {
  it('bills enemy flow against the side it hurts', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    const before = scorer.pulse();
    scorer.applyFlow(flow(0, scorer.usdPerTroop * 10, 0));

    // Buying kills orcs — the sellers are the ones being run over.
    expect(scorer.pulse().orcAlive).toBe(before.orcAlive - 10);
    expect(scorer.pulse().nexusAlive).toBe(before.nexusAlive);
  });

  it('caps a whale so one trade lands as a blow, not an ending', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    const before = scorer.pulse();
    scorer.applyTrade(trade(0, 'sell', scorer.usdPerTroop * 5_000));

    const lost = before.nexusAlive - scorer.pulse().nexusAlive;
    expect(lost).toBe(BALANCE.maxUnitsPerTrade);
  });

  it('never takes a side below zero', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    for (let i = 0; i < 100; i++) {
      scorer.applyFlow(flow(i, scorer.usdPerTroop * 1_000, 0));
    }
    expect(scorer.pulse().orcAlive).toBe(0);
  });
});

describe('reinforcement', () => {
  it('recovers a gutted side, because the gap is what drives it', () => {
    // The property that makes a restoring force the right shape here: zero is
    // unreachable, so no market can permanently delete a faction.
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    scorer.applyFlow(flow(0, scorer.usdPerTroop * 1_000, 0));
    expect(scorer.pulse().orcAlive).toBe(0);

    scorer.advance(BALANCE.reinforceHalfLifeSec * 1_000);
    expect(scorer.pulse().orcAlive).toBeGreaterThan(BALANCE.minTroops);
  });

  it('lets the deeper wall support the larger army', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    // Measured 2026-08-13: bid $7.76M against ask $3.94M.
    scorer.applyDepth(depth(0, 7_760_662, 3_936_166));
    scorer.advance(10 * 60_000);

    const { orcAlive, nexusAlive } = scorer.pulse();
    expect(orcAlive).toBeGreaterThan(nexusAlive);
  });

  it('eases the once-a-minute wall step instead of changing gear', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    scorer.applyDepth(depth(0, 9_000_000, 1_000_000));
    scorer.advance(1_000);
    const afterOneSecond = scorer.pulse();

    scorer.advance(5 * 60_000);
    const afterFiveMinutes = scorer.pulse();

    // A step in depth must not arrive as a step in the army.
    expect(afterOneSecond.orcAlive - BALANCE.baseTroops).toBeLessThan(5);
    expect(afterFiveMinutes.orcAlive).toBeGreaterThan(afterOneSecond.orcAlive);
  });
});

describe('rounds', () => {
  it('scores the window, not the survivors', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    scorer.applyFlow(flow(0, scorer.usdPerTroop * 30, scorer.usdPerTroop * 10));

    const round = scorer.endRound(60_000);
    expect(round).toMatchObject({ winner: 'nexus', orcFallen: 30, nexusFallen: 10 });
  });

  it('starts each round from zero, so armies never reset', () => {
    const scorer = new BattleScorer({ volumePerMinute: VOLUME });
    scorer.applyFlow(flow(0, scorer.usdPerTroop * 20, 0));
    scorer.endRound(60_000);

    const alive = scorer.pulse().orcAlive;
    const second = scorer.endRound(120_000);

    expect(second).toMatchObject({ winner: 'draw', orcFallen: 0, nexusFallen: 0 });
    expect(scorer.pulse().orcAlive).toBe(alive);
  });
});

describe('replay over a balanced hour', () => {
  const report = replay(balancedStream(60), { volumePerMinute: VOLUME });

  it('holds the casualty rate the spectacle was tuned for', () => {
    expect(report.casualtiesPerMinute).toBeGreaterThan(
      BALANCE.targetCasualtiesPerMin * 0.8,
    );
    expect(report.casualtiesPerMinute).toBeLessThan(
      BALANCE.targetCasualtiesPerMin * 1.2,
    );
  });

  it('never wipes a side out', () => {
    // The failure an accumulator would have produced, and the reason this
    // model is a restoring force instead.
    expect(report.longestWipedSec).toBe(0);
  });

  it('keeps a balanced market contested rather than always electing one side', () => {
    const orcWins = report.rounds.filter((r) => r.winner === 'orc').length;
    expect(report.rounds.length).toBeGreaterThan(50);
    expect(orcWins).toBeGreaterThan(0);
    expect(orcWins).toBeLessThan(report.rounds.length);
  });

  it('holds the front line near the middle when neither side leads', () => {
    const drift = Math.max(...report.samples.map((s) => Math.abs(s.frontLine)));
    expect(drift).toBeLessThan(0.15);
  });
});

describe('replay over a one-sided hour', () => {
  it('moves the line and keeps it there', () => {
    const events: MarketEvent[] = [];
    for (let second = 0; second < 3_600; second++) {
      const t = second * 1_000;
      // Buyers running the market over: orcs take the losses.
      events.push(flow(t, VOLUME / 60, VOLUME / 600));
      if (second % 60 === 0) events.push(depth(t, 3_000_000, 7_000_000));
    }

    const report = replay(events, { volumePerMinute: VOLUME });
    const settled = report.samples.at(-1);

    expect(settled?.frontLine).toBeGreaterThan(0.2);
    expect(report.rounds.filter((r) => r.winner === 'nexus').length).toBeGreaterThan(
      report.rounds.length * 0.9,
    );
    // Even under a full hour of one-way pressure, nobody is wiped out.
    expect(report.longestWipedSec).toBe(0);
  });
});

describe('replay edge cases', () => {
  it('survives an empty capture', () => {
    expect(replay([])).toMatchObject({ rounds: [], casualtiesPerMinute: 0 });
  });

  it('orders a shuffled capture before scoring it', () => {
    const ordered = balancedStream(5);
    const shuffled = [...ordered].reverse();
    expect(replay(shuffled, { volumePerMinute: VOLUME }).rounds).toEqual(
      replay(ordered, { volumePerMinute: VOLUME }).rounds,
    );
  });
});
