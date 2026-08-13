import { BALANCE, PULSE_HZ, type MarketEvent } from '@sol-warzone/protocol';

import { BattleScorer, type ScorerOptions } from './scorer.js';

/**
 * Runs a stream of market events through the scorer, off the clock.
 *
 * Balance constants cannot be judged by watching: a side pins at zero eleven
 * minutes in, or the verdict lands on the same faction every round, and neither
 * shows up in a screenshot. This drives the model over a recorded hour in
 * milliseconds and reports what it did, so the numbers are settled by
 * assertion rather than by eye.
 *
 * Feed it real capture (`npm run capture`) or a synthetic stream from a test.
 */

export interface ReplaySample {
  readonly t: number;
  readonly orcAlive: number;
  readonly nexusAlive: number;
  readonly frontLine: number;
}

export interface ReplayReport {
  readonly samples: readonly ReplaySample[];
  readonly rounds: readonly {
    winner: string;
    orcFallen: number;
    nexusFallen: number;
  }[];
  /**
   * Longest unbroken stretch, in seconds, either side spent wiped out.
   *
   * Only the floor counts. Sitting at full strength is where the deeper book is
   * *supposed* to put a side — the target is capped at `poolPerSide`, so any
   * side holding more than half the liquidity approaches it by design. Zero is
   * the pathology, and the one a restoring force exists to prevent.
   */
  readonly longestWipedSec: number;
  readonly casualtiesPerMinute: number;
  readonly elapsedSec: number;
}

const WIPED_EPSILON = 0.5;

/**
 * Replay `events`, stepping the scorer at `PULSE_HZ` between them.
 *
 * Events must be ordered by `t`. Anything without a usable timestamp is
 * dropped rather than guessed at — a misplaced event would quietly distort
 * every statistic downstream.
 */
export function replay(
  events: readonly MarketEvent[],
  options: ScorerOptions = {},
): ReplayReport {
  const ordered = events
    .filter((event) => Number.isFinite(event.t))
    .slice()
    .sort((a, b) => a.t - b.t);

  const scorer = new BattleScorer(options);
  const samples: ReplaySample[] = [];
  const rounds: ReplayReport['rounds'][number][] = [];

  if (ordered.length === 0) {
    return {
      samples,
      rounds,
      longestWipedSec: 0,
      casualtiesPerMinute: 0,
      elapsedSec: 0,
    };
  }

  const stepMs = 1_000 / PULSE_HZ;
  const start = ordered[0]?.t ?? 0;
  const end = ordered.at(-1)?.t ?? start;

  let cursor = 0;
  let wipedSec = 0;
  let longestWipedSec = 0;
  let totalFallen = 0;
  let nextRound = start + BALANCE.roundSec * 1_000;

  for (let now = start; now <= end; now += stepMs) {
    // Everything that happened during this frame, applied before it advances.
    while (cursor < ordered.length && (ordered[cursor]?.t ?? Infinity) <= now) {
      const event = ordered[cursor++];
      if (!event) continue;
      switch (event.type) {
        case 'flow':
          scorer.applyFlow(event);
          break;
        case 'trade':
          scorer.applyTrade(event);
          break;
        case 'depth':
          scorer.applyDepth(event);
          break;
        default:
          break;
      }
    }

    scorer.advance(stepMs);

    while (now >= nextRound) {
      const round = scorer.endRound(nextRound);
      rounds.push(round);
      totalFallen += round.orcFallen + round.nexusFallen;
      nextRound += BALANCE.roundSec * 1_000;
    }

    const pulse = scorer.pulse();
    samples.push({ t: now, ...pulse });

    const wiped = pulse.orcAlive <= WIPED_EPSILON || pulse.nexusAlive <= WIPED_EPSILON;

    wipedSec = wiped ? wipedSec + stepMs / 1_000 : 0;
    if (wipedSec > longestWipedSec) longestWipedSec = wipedSec;
  }

  const elapsedSec = (end - start) / 1_000;
  return {
    samples,
    rounds,
    longestWipedSec,
    casualtiesPerMinute: elapsedSec > 0 ? (totalFallen / elapsedSec) * 60 : 0,
    elapsedSec,
  };
}
