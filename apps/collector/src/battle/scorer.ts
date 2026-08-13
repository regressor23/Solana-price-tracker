import {
  BALANCE,
  usdPerTroop,
  victimOf,
  type DepthSnapshot,
  type Faction,
  type Flow,
  type Pulse,
  type RoundEnd,
  type Trade,
} from '@sol-warzone/protocol';

/**
 * The server's half of the battle: the score.
 *
 * The client owns the spectacle — where units stand, who swings at whom — but
 * the numbers a viewer could argue about live here, so every viewer sees the
 * same ones. Clients join at different moments from different snapshots, so a
 * deterministic client-side simulation would still have drifted apart; see
 * PLAN.md §7.
 *
 * The model has three parts, and they are deliberately of different kinds:
 *
 * 1. **Casualties are event-driven and real.** Enemy volume removes units at
 *    `usdPerTroop`, which is itself derived from live volume rather than fixed.
 * 2. **Reinforcement is a restoring force, not an accumulator.** Each side is
 *    pulled toward a target set by its share of resting liquidity. Accumulators
 *    pin at their bounds; a restoring force cannot, because the gap it works on
 *    grows as the side falls behind.
 * 3. **The front line is derived, not stored.** It reads the difference in unit
 *    counts, so it can never disagree with them.
 *
 * No timers and no IO: `advance` takes its own elapsed time, so a recorded hour
 * of production events replays through this in milliseconds.
 */

/** Convert a half-life in seconds into a per-second decay rate. */
const rateFor = (halfLifeSec: number): number => Math.LN2 / halfLifeSec;

/** Exponential approach of `value` toward `target` over `dtSec`. */
const approach = (value: number, target: number, rate: number, dtSec: number): number =>
  target + (value - target) * Math.exp(-rate * dtSec);

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export interface ScorerOptions {
  /** Mean USD volume per minute, from the candle feed. Null until it arrives. */
  volumePerMinute?: number | null;
}

export class BattleScorer {
  #orcAlive: number = BALANCE.baseTroops;
  #nexusAlive: number = BALANCE.baseTroops;

  /**
   * Smoothed share of resting liquidity behind the orcs, 0…1.
   *
   * Starts even, because before the first depth snapshot — up to 60 s on the
   * lite profile — an unmeasured market is not evidence for either side.
   */
  #orcShare = 0.5;
  /** Where the share is heading, set by depth and eased toward by `advance`. */
  #targetOrcShare = 0.5;
  #frontLine = 0;

  #orcFallen = 0;
  #nexusFallen = 0;

  #volumePerMinute: number | null;

  constructor(options: ScorerOptions = {}) {
    this.#volumePerMinute = options.volumePerMinute ?? null;
  }

  /** USD of flow that currently removes one unit. */
  get usdPerTroop(): number {
    return usdPerTroop(this.#volumePerMinute);
  }

  /** Volume drifts; the cost of a life follows it. */
  setVolumePerMinute(volumePerMinute: number | null): void {
    this.#volumePerMinute = volumePerMinute;
  }

  /**
   * Aggregated small trades. Both sides can take losses in the same batch,
   * because both sides traded during that second.
   */
  applyFlow(flow: Flow): void {
    this.#kill('orc', flow.buyUsd / this.usdPerTroop);
    this.#kill('nexus', flow.sellUsd / this.usdPerTroop);
  }

  /**
   * One listed trade. Capped at `maxUnitsPerTrade` so a single whale cannot
   * erase a side outright — it should land as a blow, not as an ending.
   */
  applyTrade(trade: Trade): void {
    const units = Math.min(trade.usd / this.usdPerTroop, BALANCE.maxUnitsPerTrade);
    this.#kill(victimOf(trade.side), units);
  }

  /**
   * Resting liquidity sets where each side is heading, not where it is.
   *
   * Depth arrives once a minute, so the raw share would step and reinforcement
   * would visibly change gear. `advance` eases toward this instead.
   */
  applyDepth(depth: DepthSnapshot): void {
    const total = depth.bidWallUsd + depth.askWallUsd;
    if (!(total > 0)) return;
    this.#targetOrcShare = depth.bidWallUsd / total;
  }

  /** Advance the restoring force and the front line by `dtMs`. */
  advance(dtMs: number): void {
    if (!(dtMs > 0)) return;
    const dt = dtMs / 1_000;

    this.#orcShare = approach(
      this.#orcShare,
      this.#targetOrcShare,
      rateFor(BALANCE.wallShareHalfLifeSec),
      dt,
    );

    const reinforce = rateFor(BALANCE.reinforceHalfLifeSec);
    this.#orcAlive = approach(
      this.#orcAlive,
      this.#targetFor(this.#orcShare),
      reinforce,
      dt,
    );
    this.#nexusAlive = approach(
      this.#nexusAlive,
      this.#targetFor(1 - this.#orcShare),
      reinforce,
      dt,
    );

    this.#frontLine = approach(
      this.#frontLine,
      (this.#nexusAlive - this.#orcAlive) / BALANCE.poolPerSide,
      rateFor(BALANCE.frontLineHalfLifeSec),
      dt,
    );
  }

  /** The frame the client renders. Rounded here, so the wire carries integers. */
  pulse(): Omit<Pulse, 'type' | 't'> {
    return {
      orcAlive: Math.round(this.#orcAlive),
      nexusAlive: Math.round(this.#nexusAlive),
      frontLine: clamp(this.#frontLine, -1, 1),
    };
  }

  /**
   * Close the round and start the next.
   *
   * The verdict is a statistic of the last 60 seconds, not a reading of the
   * unit counts — so armies never reset, and the counters do not jump on the
   * minute. Who is winning and who is left are different questions.
   */
  endRound(t: number): RoundEnd {
    const orcFallen = Math.round(this.#orcFallen);
    const nexusFallen = Math.round(this.#nexusFallen);
    this.#orcFallen = 0;
    this.#nexusFallen = 0;

    const winner: Faction | 'draw' =
      orcFallen === nexusFallen ? 'draw' : orcFallen > nexusFallen ? 'nexus' : 'orc';

    return { type: 'round', t, winner, orcFallen, nexusFallen };
  }

  /** Where a side is heading, given its share of resting liquidity. */
  #targetFor(share: number): number {
    // Doubling makes an even split map to a full pool, so the target reads as
    // "your share of the field" rather than "half of it".
    return clamp(
      BALANCE.poolPerSide * 2 * share,
      BALANCE.minTroops,
      BALANCE.poolPerSide,
    );
  }

  #kill(faction: Faction, units: number): void {
    if (!Number.isFinite(units) || units <= 0) return;
    if (faction === 'orc') {
      const dead = Math.min(units, this.#orcAlive);
      this.#orcAlive -= dead;
      this.#orcFallen += dead;
    } else {
      const dead = Math.min(units, this.#nexusAlive);
      this.#nexusAlive -= dead;
      this.#nexusFallen += dead;
    }
  }
}
