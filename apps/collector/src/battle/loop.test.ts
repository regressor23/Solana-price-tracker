import { BALANCE, PULSE_HZ, type MarketEvent } from '@sol-warzone/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BattleLoop } from './loop.js';

/**
 * The clock and the wire around the scorer.
 *
 * `scorer.test.ts` proves the model; this proves the thing that drives it —
 * that pulses actually leave at the rate they claim, that a round closes on
 * the boundary rather than on the next event, and that a stalled event loop
 * slows the process without also slowing the battle.
 */

interface Harness {
  loop: BattleLoop;
  events: MarketEvent[];
  /** Advance both the timer and the clock the loop reads. */
  tick(ms: number): Promise<void>;
  setVolume(value: number | null): void;
}

function harness(startVolume: number | null = 104_150): Harness {
  const events: MarketEvent[] = [];
  let clock = 1_000_000;
  let volume = startVolume;

  const loop = new BattleLoop({
    publish: (event) => events.push(event),
    volumePerMinute: () => volume,
    now: () => clock,
  });

  return {
    loop,
    events,
    async tick(ms) {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    setVolume(value) {
      volume = value;
    },
  };
}

const only = <T extends MarketEvent['type']>(
  events: MarketEvent[],
  type: T,
): Extract<MarketEvent, { type: T }>[] =>
  events.filter(
    (event): event is Extract<MarketEvent, { type: T }> => event.type === type,
  );

const flow = (t: number, buyUsd: number, sellUsd: number): MarketEvent => ({
  type: 'flow',
  t,
  buyUsd,
  sellUsd,
  trades: 4,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('pulse cadence', () => {
  it('publishes at the rate the protocol advertises', async () => {
    const h = harness();
    h.loop.start();
    await h.tick(1_000);
    h.loop.stop();

    // Within one frame either way — the interval and the clock are independent.
    expect(only(h.events, 'pulse').length).toBeGreaterThanOrEqual(PULSE_HZ - 1);
    expect(only(h.events, 'pulse').length).toBeLessThanOrEqual(PULSE_HZ + 1);
  });

  it('stops publishing once stopped', async () => {
    const h = harness();
    h.loop.start();
    await h.tick(500);
    h.loop.stop();
    const settled = h.events.length;

    await h.tick(2_000);
    expect(h.events).toHaveLength(settled);
  });

  it('survives being started twice without doubling the rate', async () => {
    const h = harness();
    h.loop.start();
    h.loop.start();
    await h.tick(1_000);
    h.loop.stop();

    expect(only(h.events, 'pulse').length).toBeLessThanOrEqual(PULSE_HZ + 1);
  });
});

describe('rounds', () => {
  it('closes a round on the boundary, not on the next event', async () => {
    const h = harness();
    h.loop.start();

    await h.tick(BALANCE.roundSec * 1_000 - 500);
    expect(only(h.events, 'round')).toHaveLength(0);

    await h.tick(1_000);
    h.loop.stop();
    expect(only(h.events, 'round')).toHaveLength(1);
  });

  it('catches up every boundary a stall skipped past', async () => {
    // A blocked event loop must not silently swallow rounds: the verdict is a
    // statistic of a 60 s window, and dropping windows would lose casualties.
    const h = harness();
    h.loop.start();
    await h.tick(BALANCE.roundSec * 1_000 * 3 + 1_000);
    h.loop.stop();

    expect(only(h.events, 'round')).toHaveLength(3);
  });

  it('re-reads volume at each boundary, so the cost of a life follows it', async () => {
    const h = harness(104_150);
    h.loop.start();
    await h.tick(1_000);

    // Ten times the volume means ten times the dollars per casualty, so the
    // same flow should now kill far fewer.
    h.setVolume(1_041_500);
    await h.tick(BALANCE.roundSec * 1_000);

    h.loop.observe(flow(0, 100_000, 0));
    await h.tick(100);
    h.loop.stop();

    const before = BALANCE.baseTroops;
    const after = only(h.events, 'pulse').at(-1)?.orcAlive ?? 0;
    // At the old rate 100k would have erased over a hundred; at the new one it
    // is a tenth of that, so the army is still nearly intact.
    expect(before - after).toBeLessThan(30);
  });
});

describe('observation', () => {
  it('routes flow, trades and depth into the score', async () => {
    const h = harness();
    h.loop.start();
    await h.tick(100);
    const opening = only(h.events, 'pulse').at(-1)?.orcAlive ?? 0;

    h.loop.observe(flow(0, 50_000, 0));
    await h.tick(100);
    h.loop.stop();

    expect(only(h.events, 'pulse').at(-1)?.orcAlive).toBeLessThan(opening);
  });

  it('ignores events that are not the battles business', async () => {
    const h = harness();
    h.loop.start();
    await h.tick(100);
    const opening = only(h.events, 'pulse').at(-1);

    h.loop.observe({
      type: 'tick',
      t: 0,
      blockId: 1,
      price: 75.85,
      tickChange: 0.5,
      change24h: 0,
    });
    await h.tick(100);
    h.loop.stop();

    const after = only(h.events, 'pulse').at(-1);
    expect(after?.orcAlive).toBe(opening?.orcAlive);
    expect(after?.nexusAlive).toBe(opening?.nexusAlive);
  });
});

describe('elapsed time', () => {
  it('advances by the clock, not by the nominal interval', async () => {
    // A busy process fires the interval late. Charging the scorer the nominal
    // 100 ms would make the battle run slow whenever the host is loaded, and
    // nothing would look broken while it happened.
    const gutted = () => {
      const h = harness();
      h.loop.start();
      h.loop.observe(flow(0, 100_000_000, 0));
      return h;
    };

    const prompt = gutted();
    await prompt.tick(100);
    prompt.loop.stop();

    const stalled = gutted();
    // One interval firing, but ten seconds of wall clock passed meanwhile.
    stalled.loop.observe(flow(0, 100_000_000, 0));
    await stalled.tick(10_000);
    stalled.loop.stop();

    const promptRecovery = only(prompt.events, 'pulse').at(-1)?.orcAlive ?? 0;
    const stalledRecovery = only(stalled.events, 'pulse').at(-1)?.orcAlive ?? 0;
    expect(stalledRecovery).toBeGreaterThan(promptRecovery);
  });
});
