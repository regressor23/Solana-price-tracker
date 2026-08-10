/**
 * Wire contract between the collector and the web client.
 *
 * Everything the browser knows about the market arrives as a `ServerMessage`.
 * The collector is the only thing that talks to Jupiter — see PLAN.md §7 for why.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Market identity
// ---------------------------------------------------------------------------

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

export const PAIR_LABEL = 'SOL/USDC';

// ---------------------------------------------------------------------------
// Factions
//
// `nexus` are the buyers (green, high-tech). `orc` are the sellers (red,
// medieval). Kept as opaque ids so the renderer owns all naming and art.
// ---------------------------------------------------------------------------

export type Faction = 'orc' | 'nexus';

export const factionForSide = (side: TradeSide): Faction =>
  side === 'buy' ? 'nexus' : 'orc';

/** The faction that loses units when `side` trades happen. */
export const victimOf = (side: TradeSide): Faction =>
  side === 'buy' ? 'orc' : 'nexus';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type TradeSide = 'buy' | 'sell';

/** Relative size class, derived from a rolling EMA of trade size (PLAN.md §5). */
export type TradeTier = 'normal' | 'heavy' | 'whale';

export interface PriceTick {
  readonly type: 'tick';
  /** Collector wall-clock, ms. */
  readonly t: number;
  /** Solana slot the price was observed at — used to de-duplicate polls. */
  readonly blockId: number;
  readonly price: number;
  /** Signed fraction vs the previous tick, e.g. -0.00008 for -0.008%. */
  readonly tickChange: number;
  /** Signed fraction over 24h, as reported by Jupiter. */
  readonly change24h: number;
}

export interface Trade {
  readonly type: 'trade';
  readonly t: number;
  readonly side: TradeSide;
  readonly usd: number;
  readonly price: number;
  readonly tier: TradeTier;
  /** Route label from Jupiter (`Orca`, `Raydium`, `HumidiFi`, …) when known. */
  readonly dex?: string;
}

/** One rung of the price-impact ladder — our stand-in for an order book level. */
export interface DepthRung {
  /** Ladder size in SOL. */
  readonly sizeSol: number;
  /** Notional value of the fill, in USD. */
  readonly usd: number;
  /** Average fill price across the whole rung. */
  readonly avgPrice: number;
  /** Signed fraction away from mid: negative on bids, positive on asks. */
  readonly impactPct: number;
}

export interface DepthSnapshot {
  readonly type: 'depth';
  readonly t: number;
  readonly mid: number;
  /** SOL -> USDC ladder (someone selling into the book). */
  readonly bids: readonly DepthRung[];
  /** USDC -> SOL ladder (someone buying out of the book). */
  readonly asks: readonly DepthRung[];
  /** USD absorbable before price drops 1% — the "orc wall". */
  readonly bidWallUsd: number;
  /** USD absorbable before price rises 1% — the "nexus wall". */
  readonly askWallUsd: number;
}

export interface Candle {
  /** Bucket start, seconds (Jupiter returns seconds even though it takes ms). */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface RoundEnd {
  readonly type: 'round';
  readonly t: number;
  readonly winner: Faction | 'draw';
  readonly orcFallen: number;
  readonly nexusFallen: number;
}

export type MarketEvent = PriceTick | Trade | DepthSnapshot | RoundEnd;

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/** How trustworthy the current feed is. Drives the "LIVE" badge in the HUD. */
export type FeedStatus = 'live' | 'sync' | 'degraded' | 'demo';

export interface Hello {
  readonly type: 'hello';
  readonly protocol: number;
  readonly t: number;
  readonly pair: string;
  readonly status: FeedStatus;
}

/** Full state replay so a client that joins mid-battle starts warm. */
export interface Snapshot {
  readonly type: 'snapshot';
  readonly t: number;
  readonly status: FeedStatus;
  readonly price: PriceTick | null;
  readonly depth: DepthSnapshot | null;
  readonly candles: readonly Candle[];
  readonly recentTrades: readonly Trade[];
}

export interface StatusChange {
  readonly type: 'status';
  readonly t: number;
  readonly status: FeedStatus;
  readonly detail?: string;
}

export type ServerMessage = Hello | Snapshot | StatusChange | MarketEvent;

/** Client -> server. Deliberately tiny; the client mostly listens. */
export type ClientMessage = { readonly type: 'ping'; readonly t: number };

// ---------------------------------------------------------------------------
// Feed tuning
// ---------------------------------------------------------------------------

/**
 * Ladder sizes in SOL, log-spaced: resolution near the touch where the curve
 * bends, reach at the top where the wall threshold lands.
 *
 * Measured 2026-08-10 at SOL ~$76. The book is markedly asymmetric — selling
 * 100k costs -0.80% while buying the same size costs +4.27% — so the ladder has
 * to run past 100k for the bid side to cross 1% at all. Above roughly 100k the
 * ask leg has no route and simply drops out; a partial ladder is expected here,
 * not an error.
 *
 * Every rung costs one upstream request on each side, so length is charged
 * directly against the rate budget. Nine is the most that fits.
 */
export const DEPTH_LADDER_SOL = [
  10, 50, 200, 1_000, 4_000, 12_000, 35_000, 75_000, 150_000,
] as const;

/** Wall totals are measured out to this much price impact. */
export const WALL_IMPACT_PCT = 0.01;

/**
 * Sustained request budget per upstream host, requests per minute.
 *
 * Measured 2026-08-10: lite-api serves 60/min cleanly and starts returning 429
 * at around 125/min. datapi took 131/min without complaint. The keyless numbers
 * sit under the measured ceiling with margin, because the collector is the only
 * consumer for every visitor — getting throttled takes the whole site down.
 */
export const RATE_BUDGET_PER_MIN = {
  liteApi: 55,
  keyedApi: 600,
  dataApi: 90,
} as const;

/**
 * Poll cadences. Without a key the whole site shares 55 requests a minute, so
 * price gets half the budget and depth takes the rest: one ladder is 18
 * requests, which at 45s is 24/min.
 *
 * A key raises the ceiling enough that both can run at their natural rate. Get
 * one free at portal.jup.ag and set JUPITER_API_KEY.
 */
export const FEED_PROFILES = {
  lite: { price: 2_000, depth: 45_000, trades: 1_000, candles: 60_000 },
  keyed: { price: 1_000, depth: 10_000, trades: 1_000, candles: 60_000 },
} as const;

export type FeedProfile = keyof typeof FEED_PROFILES;

/** Server -> client broadcast rate. */
export const BROADCAST_HZ = 10;

// ---------------------------------------------------------------------------
// Battle balance
//
// Starting values only. Absolute USD thresholds do not transfer from BTC, so
// the sim classifies trades relative to a rolling EMA instead — see PLAN.md §5.
// ---------------------------------------------------------------------------

export const BALANCE = {
  /** Smoothing factor for the rolling mean trade size. */
  usdRefEma: 0.03,
  /** Lower bound on the reference, so a dead market cannot make everything a whale. */
  usdRefFloor: 125,

  /**
   * A tier threshold is `max(floor, reference * multiplier)` — the floor raises
   * the bar on a quiet market, it never lowers it.
   *
   * Invariant: each floor equals `usdRefFloor * mult`. If the floor were lower
   * it could never bind (the reference clamp already exceeds it); if higher, the
   * relative scaling would be dead below that point. `floorsMatchReference`
   * guards this. Change one of these numbers and you must change its pair.
   */
  relHeavyFloor: 1_000, // 125 * 8
  relHeavyMult: 8,
  relWhaleFloor: 3_750, // 125 * 30
  relWhaleMult: 30,

  /** USD of flow that removes one enemy unit. */
  usdPerTroop: 900,
  /** USD of resting liquidity that queues one reinforcement. */
  usdPerReinforce: 400,

  poolPerSide: 250,
  baseTroops: 200,
  minTroops: 40,
  maxUnitsPerTrade: 60,

  /** Round length, seconds. */
  roundSec: 60,
  flowScale: 60_000,
} as const;

export type Balance = typeof BALANCE;

/** True when the absolute floors line up with the clamped reference. */
export const floorsMatchReference = (b: Balance = BALANCE): boolean =>
  b.relHeavyFloor === b.usdRefFloor * b.relHeavyMult &&
  b.relWhaleFloor === b.usdRefFloor * b.relWhaleMult;

/**
 * Classify a trade against the running mean. Mirrors the relative-threshold
 * approach in the reference implementation, with SOL-scaled floors.
 */
export function classifyTrade(usd: number, refUsd: number): TradeTier {
  const ref = Math.max(refUsd, BALANCE.usdRefFloor);
  if (usd >= Math.max(BALANCE.relWhaleFloor, ref * BALANCE.relWhaleMult)) {
    return 'whale';
  }
  if (usd >= Math.max(BALANCE.relHeavyFloor, ref * BALANCE.relHeavyMult)) {
    return 'heavy';
  }
  return 'normal';
}
