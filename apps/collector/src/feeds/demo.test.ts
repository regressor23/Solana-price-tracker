import { BALANCE, type MarketEvent } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { DemoFeed } from './demo.js';
import { replay } from '../battle/replay.js';

/** Run the generator for `seconds`, advancing its clock a second at a time. */
function run(seconds: number, options: { seed?: number; startPrice?: number } = {}) {
  let t = 1_000_000;
  const feed = new DemoFeed({ ...options, now: () => t });
  const events: MarketEvent[] = [];
  for (let i = 0; i < seconds; i++) {
    events.push(...feed.poll());
    t += 1_000;
  }
  return events;
}

const only = <T extends MarketEvent['type']>(
  events: MarketEvent[],
  type: T,
): Extract<MarketEvent, { type: T }>[] =>
  events.filter(
    (event): event is Extract<MarketEvent, { type: T }> => event.type === type,
  );

describe('DemoFeed', () => {
  it('replays identically from the same seed', () => {
    // Determinism is what makes the outage path testable rather than something
    // only production ever sees.
    expect(run(120, { seed: 7 })).toEqual(run(120, { seed: 7 }));
  });

  it('produces a different market from a different seed', () => {
    expect(run(120, { seed: 7 })).not.toEqual(run(120, { seed: 8 }));
  });

  it('carries on from the last real price instead of jumping', () => {
    // Someone already watching when the upstream died should not see the
    // number teleport — that reads as a bug, not as a fallback.
    const first = only(run(1, { startPrice: 91.5 }), 'tick')[0];
    expect(first?.price).toBeGreaterThan(91);
    expect(first?.price).toBeLessThan(92);
  });

  it('emits the same event mix the real feeds do', () => {
    const events = run(300);
    expect(only(events, 'tick')).toHaveLength(300);
    expect(only(events, 'flow')).toHaveLength(300);
    // Depth is on the same 60 s cadence as the real ladder.
    expect(only(events, 'depth').length).toBeGreaterThanOrEqual(5);
    expect(only(events, 'trade').length).toBeGreaterThan(0);
  });

  it('stays in the range production actually measured', () => {
    const events = run(3_600);
    const prices = only(events, 'tick').map((tick) => tick.price);
    // A random walk with no pull home would wander somewhere absurd over an
    // hour, and the fake would be obvious for the wrong reason.
    expect(Math.min(...prices)).toBeGreaterThan(60);
    expect(Math.max(...prices)).toBeLessThan(95);

    const volumePerMin =
      (only(events, 'flow').reduce((sum, f) => sum + f.buyUsd + f.sellUsd, 0) /
        events.length) *
      60;
    expect(volumePerMin).toBeGreaterThan(50_000);
    expect(volumePerMin).toBeLessThan(200_000);
  });

  it('only invents trades the feed would actually list', () => {
    // Anything below heavy would be summed into Flow by the real pipeline, so
    // generating one here would put a row on screen that cannot occur live.
    const trades = only(run(3_600), 'trade');
    expect(trades.length).toBeGreaterThan(10);
    expect(trades.every((trade) => trade.tier !== 'normal')).toBe(true);
  });

  it('drives a battle that behaves like the real one', () => {
    // The point of the fallback is that the page keeps moving sensibly, so the
    // generated market has to satisfy the same invariants live data does.
    const report = replay(run(3_600), { volumePerMinute: 104_150 });
    // Not "never reaches zero" — a whale finishing off a weakened army is the
    // drama, and the restoring force brings it straight back. Being *stuck*
    // there is the failure, so what matters is how long it lasts.
    expect(report.longestWipedSec).toBeLessThan(2);
    expect(report.casualtiesPerMinute).toBeGreaterThan(
      BALANCE.targetCasualtiesPerMin * 0.5,
    );
    const winners = new Set(report.rounds.map((round) => round.winner));
    expect(winners.size).toBeGreaterThan(1);
  });
});
