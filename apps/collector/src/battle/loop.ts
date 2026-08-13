import { BALANCE, PULSE_HZ, type MarketEvent } from '@sol-warzone/protocol';

import { BattleScorer } from './scorer.js';

export interface BattleLoopOptions {
  publish: (event: MarketEvent) => void;
  /** Read at each round boundary — volume drifts, and the cost of a life follows. */
  volumePerMinute: () => number | null;
  now?: () => number;
}

/**
 * Drives the scorer on a clock and puts its output on the wire.
 *
 * Kept apart from `MarketFeeds`, which exists to talk to Jupiter and nothing
 * else. This class talks to no one upstream: it watches the same event stream
 * every client gets and derives the score from it, which is the whole reason
 * the score is identical for everyone.
 */
export class BattleLoop {
  readonly #scorer: BattleScorer;
  readonly #publish: (event: MarketEvent) => void;
  readonly #volumePerMinute: () => number | null;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | undefined;
  #lastTickAt = 0;
  #nextRoundAt = 0;

  constructor(options: BattleLoopOptions) {
    this.#publish = options.publish;
    this.#volumePerMinute = options.volumePerMinute;
    this.#now = options.now ?? Date.now;
    this.#scorer = new BattleScorer({ volumePerMinute: options.volumePerMinute() });
  }

  /**
   * Feed the scorer anything that moves the battle.
   *
   * Called for every event on its way to the hub, so the score is derived from
   * exactly what the clients were told — not from a parallel reading of it.
   */
  observe(event: MarketEvent): void {
    switch (event.type) {
      case 'flow':
        this.#scorer.applyFlow(event);
        break;
      case 'trade':
        this.#scorer.applyTrade(event);
        break;
      case 'depth':
        this.#scorer.applyDepth(event);
        break;
      default:
        break;
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#lastTickAt = this.#now();
    this.#nextRoundAt = this.#lastTickAt + BALANCE.roundSec * 1_000;
    this.#timer = setInterval(() => this.#tick(), 1_000 / PULSE_HZ);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #tick(): void {
    const now = this.#now();
    // Measured elapsed time rather than the nominal interval: a busy event loop
    // would otherwise make the battle run slow without anything looking wrong.
    this.#scorer.advance(now - this.#lastTickAt);
    this.#lastTickAt = now;

    while (now >= this.#nextRoundAt) {
      this.#scorer.setVolumePerMinute(this.#volumePerMinute());
      this.#publish(this.#scorer.endRound(this.#nextRoundAt));
      this.#nextRoundAt += BALANCE.roundSec * 1_000;
    }

    this.#publish({ type: 'pulse', t: now, ...this.#scorer.pulse() });
  }
}
