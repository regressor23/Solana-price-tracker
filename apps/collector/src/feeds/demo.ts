import {
  BALANCE,
  DEPTH_LADDER_SOL,
  WALL_IMPACT_PCT,
  classifyTrade,
  type DepthSnapshot,
  type DepthRung,
  type Flow,
  type MarketEvent,
  type PriceTick,
  type Trade,
} from '@sol-warzone/protocol';

/**
 * Stand-in market for when the upstream is gone.
 *
 * A frozen page is worse than an honest fake: the whole point of the site is a
 * battle that moves, and a visitor who arrives during a Jupiter outage would
 * otherwise see a still image with no way to tell it apart from a bug. The
 * client marks the feed `demo` for as long as this is running, so nobody is
 * misled about which it is.
 *
 * Deterministic on purpose — a seeded generator replays identically, which
 * makes the outage path testable rather than something only production sees.
 *
 * Numbers are anchored on what production actually measured on 2026-08-13, so
 * the fake sits in the same range as the real thing and the battle keeps the
 * pace it was tuned for.
 */

/** Measured baselines. See PLAN.md §4 and DESIGN_BRIEF.md §11. */
const BASE_PRICE = 75.85;
const BASE_VOLUME_PER_MIN = 104_150;
const BASE_BID_WALL = 7_760_662;
const BASE_ASK_WALL = 3_936_166;

/** Deterministic and cheap; the sequence only has to look unremarkable. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export interface DemoFeedOptions {
  seed?: number;
  now?: () => number;
  /** Last real price, so the fake starts where the market left off. */
  startPrice?: number;
}

export class DemoFeed {
  readonly #rand: () => number;
  readonly #now: () => number;

  #price: number;
  #blockId = 1;
  #refUsd: number = BALANCE.usdRefFloor;
  #lastDepthAt = 0;
  #secondsRun = 0;

  constructor(options: DemoFeedOptions = {}) {
    this.#rand = lcg(options.seed ?? 20_260_813);
    this.#now = options.now ?? Date.now;
    this.#price = options.startPrice ?? BASE_PRICE;
  }

  /**
   * One second of invented market.
   *
   * Emits the same event mix the real feeds do, so nothing downstream needs to
   * know it is in demo: a tick, an aggregate of small flow, the occasional
   * listed trade, and a depth snapshot on the same 60 s cadence.
   */
  poll(): MarketEvent[] {
    const t = this.#now();
    const events: MarketEvent[] = [];
    this.#secondsRun++;

    events.push(this.#tick(t));
    events.push(this.#flow(t));

    // Roughly one or two listed trades a minute, as production sees.
    if (this.#rand() < 0.025) events.push(this.#trade(t));

    if (t - this.#lastDepthAt >= 60_000) {
      this.#lastDepthAt = t;
      events.push(this.#depth(t));
    }

    return events;
  }

  #tick(t: number): PriceTick {
    // A random walk with a gentle pull home, so a long outage cannot drift the
    // price somewhere absurd and make the fake obvious for the wrong reason.
    const drift = (this.#rand() - 0.5) * 0.0009;
    const pull = (BASE_PRICE - this.#price) * 0.001;
    const previous = this.#price;
    this.#price = this.#price * (1 + drift) + pull;

    return {
      type: 'tick',
      t,
      blockId: ++this.#blockId,
      price: this.#price,
      tickChange: (this.#price - previous) / previous,
      change24h: (this.#price - BASE_PRICE) / BASE_PRICE,
    };
  }

  #flow(t: number): Flow {
    const perSecond = BASE_VOLUME_PER_MIN / 60;
    // Tilt wanders slowly rather than resetting each second, so the battle gets
    // stretches of pressure instead of noise that averages out to nothing.
    const tilt = Math.sin(this.#secondsRun / 90) * 0.35 + (this.#rand() - 0.5) * 0.2;
    return {
      type: 'flow',
      t,
      buyUsd: (perSecond / 2) * (1 + tilt),
      sellUsd: (perSecond / 2) * (1 - tilt),
      trades: 4 + Math.floor(this.#rand() * 3),
    };
  }

  #trade(t: number): Trade {
    // Sized off the live thresholds rather than fixed dollars, because the bar
    // moves: the reference climbs as whales pass through it, and a hard-coded
    // $6,100 that was heavy an hour ago classifies as normal later. A normal
    // trade here would put a row on screen the real pipeline would have summed
    // into Flow, so the tier has to hold by construction.
    const heavyAt = Math.max(
      BALANCE.relHeavyFloor,
      this.#refUsd * BALANCE.relHeavyMult,
    );
    const whaleAt = Math.max(
      BALANCE.relWhaleFloor,
      this.#refUsd * BALANCE.relWhaleMult,
    );

    const whale = this.#rand() < 0.12;
    const usd = whale
      ? whaleAt * (1 + this.#rand() * 9)
      : heavyAt * (1 + this.#rand() * (whaleAt / heavyAt - 1));

    const tier = classifyTrade(usd, this.#refUsd);
    this.#refUsd = this.#refUsd + (usd - this.#refUsd) * BALANCE.usdRefEma;

    return {
      type: 'trade',
      t,
      side: this.#rand() < 0.5 ? 'buy' : 'sell',
      usd,
      price: this.#price,
      tier,
    };
  }

  #depth(t: number): DepthSnapshot {
    const swing = 0.75 + this.#rand() * 0.5;
    const bidWallUsd = BASE_BID_WALL * swing;
    const askWallUsd = BASE_ASK_WALL * (1.75 - swing);

    return {
      type: 'depth',
      t,
      mid: this.#price,
      bids: this.#ladder(-1),
      asks: this.#ladder(1),
      bidWallUsd,
      askWallUsd,
    };
  }

  /**
   * A plausible price-impact ladder: impact grows faster than size, which is
   * the shape every real measurement showed.
   */
  #ladder(direction: 1 | -1): DepthRung[] {
    return DEPTH_LADDER_SOL.map((sizeSol) => {
      const impactPct = direction * WALL_IMPACT_PCT * Math.pow(sizeSol / 75_000, 1.6);
      const avgPrice = this.#price * (1 + impactPct);
      return { sizeSol, usd: sizeSol * avgPrice, avgPrice, impactPct };
    });
  }
}
