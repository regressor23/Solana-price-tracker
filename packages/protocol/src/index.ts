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

/**
 * Aggregate of the trades that were *not* sent individually.
 *
 * Measured on production: the raw stream runs ~4.5 trades/s with a median of
 * $755, and 88.6% of all socket traffic was those trades. The client only ever
 * lists `heavy` and above, so shipping the rest one by one paid for bandwidth
 * nobody spent. They arrive here as a sum instead.
 *
 * The simulation loses nothing: at `poolPerSide: 250` and `usdPerTroop: 900`,
 * one $755 trade is indistinguishable from two of $377.
 *
 * **`Flow` and `Trade` describe disjoint sets.** A trade is either summed here
 * or delivered as its own `Trade`, never both, so a client wanting the true
 * total simply adds them. Overlapping the two would make double-counting the
 * default mistake.
 */
export interface Flow {
  readonly type: 'flow';
  readonly t: number;
  /** Normal-tier buy volume since the previous `Flow`, USD. */
  readonly buyUsd: number;
  readonly sellUsd: number;
  /** How many trades were folded into this sum. */
  readonly trades: number;
}

/**
 * Authoritative battle state, broadcast at `PULSE_HZ` as a binary frame.
 *
 * The server owns the score (PLAN.md §7): flow, casualties, front line and the
 * round verdict are identical for every viewer, while the client owns only the
 * spectacle — where units stand and how they swing.
 *
 * Carried as binary because at 10 Hz JSON costs more than the raw trade stream
 * it replaces: a 132-byte frame ten times a second is 1393 B/s against the 597
 * B/s measured today, whereas `PULSE_BYTES` of binary is 223 B/s. This is the
 * one frame where a hand-rolled codec earns its keep, so it is the only one
 * that gets it — everything else stays JSON and stays readable.
 *
 * `t` is not on the wire. The client stamps arrival instead, which costs
 * nothing and saves 13 digits per frame.
 */
export interface Pulse {
  readonly type: 'pulse';
  readonly t: number;
  /** Living orc units, 0…`BALANCE.poolPerSide`. */
  readonly orcAlive: number;
  readonly nexusAlive: number;
  /** Front line position, −1 (orcs winning) … +1 (nexus winning). */
  readonly frontLine: number;
}

export type MarketEvent = PriceTick | Trade | DepthSnapshot | RoundEnd | Flow | Pulse;

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
 * at around 125/min. datapi took 131/min without complaint. These sit under the
 * measured ceiling with margin, because the collector is the only consumer for
 * every visitor — getting throttled takes the whole site down.
 */
export const RATE_BUDGET_PER_MIN = {
  liteApi: 55,
  dataApi: 90,
} as const;

/**
 * Requests per second Jupiter allows, by plan. Published tiers, 2026-08-11.
 *
 * The free plan is the trap: an API key on it allows 1 RPS, which is the same
 * 60/min the keyless lite-api host already gives away. A key is worth nothing
 * here until a paid plan sits behind it, so the collector asks for the plan
 * rather than inferring capability from the mere presence of a key.
 */
export const JUPITER_PLAN_RPS = {
  keyless: 0.5,
  free: 1,
  developer: 10,
  launch: 50,
  pro: 150,
} as const;

export type JupiterPlan = keyof typeof JUPITER_PLAN_RPS;

/** Fraction of the plan's headroom to actually use. */
const SAFETY = 0.8;

export const budgetForRps = (rps: number): number =>
  Math.max(12, Math.round(rps * 60 * SAFETY));

/**
 * Poll cadences.
 *
 * `lite` must fit inside the keyless budget *with headroom*, not merely fit.
 * Price at 2s and one 18-request ladder every 45s came to 54/min against a
 * budget of 55, and the ladder firing 18 requests at once pushed price polls
 * into the queue behind it — a quarter of them were dropped in production.
 * Backing the ladder off to 60s leaves ~13% spare, which absorbs the burst.
 *
 * `fast` needs about 168/min — roughly 2.8 RPS — so it is only reachable on a
 * paid plan. `demandPerMin` and the tests keep both honest.
 */
export const FEED_PROFILES = {
  lite: { price: 2_000, depth: 60_000, trades: 1_000, candles: 60_000 },
  fast: { price: 1_000, depth: 10_000, trades: 1_000, candles: 60_000 },
} as const;

/** The fast cadence is only honest when the plan can actually sustain it. */
export const profileForRps = (rps: number): FeedProfile =>
  budgetForRps(rps) >= demandPerMin('fast') ? 'fast' : 'lite';

/** Requests per minute a profile asks for: price polls plus depth ladders. */
export const demandPerMin = (profile: FeedProfile): number => {
  const cadence = FEED_PROFILES[profile];
  return (
    60_000 / cadence.price + (60_000 / cadence.depth) * DEPTH_LADDER_SOL.length * 2
  );
};

export type FeedProfile = keyof typeof FEED_PROFILES;

/** Server -> client broadcast rate. */
export const BROADCAST_HZ = 10;

/** `Pulse` rate. Full broadcast rate, so the front line moves without the client easing it. */
export const PULSE_HZ = 10;

/** `Flow` rate. The trades poller runs at 1 Hz, so nothing new exists more often. */
export const FLOW_HZ = 1;

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

  /**
   * Casualties per minute the battle aims for, across both sides.
   *
   * This is the spectacle dial, and the only number here chosen by taste. With
   * 250 a side, 120 a minute turns over about a quarter of the field each
   * round — attrition you can watch without a wipe. `usdPerTroop` follows from
   * it and from live volume; see `usdPerTroop()`.
   */
  targetCasualtiesPerMin: 120,

  /**
   * Stand-in until candles arrive, and the floor if volume collapses.
   *
   * Measured 2026-08-13: SOL ran $104k/min, which at the target above gives
   * ~$870. The reference implementation guessed 900 for BTC and we inherited
   * it; the agreement is a coincidence worth noting and not worth trusting.
   */
  fallbackUsdPerTroop: 870,

  /**
   * Division guard, not a target. It binds only below about $7k/min — a market
   * that has genuinely stopped — where the derived figure would approach zero
   * and make dust lethal. Anywhere above that the derivation must be free to
   * move, including downward: a quieter market should still get its 120
   * casualties, otherwise the battle dies with the volume.
   */
  minUsdPerTroop: 60,

  /** No single trade may erase more than this, however large the whale. */
  maxUnitsPerTrade: 60,

  poolPerSide: 250,
  baseTroops: 200,
  minTroops: 40,

  /**
   * Reinforcement is a restoring force, not an accumulator: each side is
   * pulled toward a target set by its share of resting liquidity. That is what
   * keeps the model from pinning — the further a side falls behind its target,
   * the faster it recovers, so zero is unreachable and the ceiling cannot
   * stick either.
   */
  reinforceHalfLifeSec: 25,

  /**
   * Wall shares arrive once every 60 s on the lite profile, so the target
   * would otherwise step once a minute and reinforcement would visibly change
   * gear. Smoothing over longer than the poll interval spreads each step out.
   */
  wallShareHalfLifeSec: 90,

  /** Light on purpose: enough to ease the line, not enough to hide a whale. */
  frontLineHalfLifeSec: 2,

  /** Round length, seconds. */
  roundSec: 60,
} as const;

/**
 * USD of flow that removes one enemy unit, derived from what the market is
 * actually doing rather than fixed.
 *
 * A constant tuned at one volume stops meaning anything at another: the same
 * $900 that gives a lively battle at $104k/min would barely scratch it at ten
 * times that, and would wipe the field at a tenth. Deriving it keeps the
 * spectacle legible across both.
 */
export function usdPerTroop(volumePerMinute: number | null): number {
  if (
    volumePerMinute === null ||
    !Number.isFinite(volumePerMinute) ||
    volumePerMinute <= 0
  ) {
    return BALANCE.fallbackUsdPerTroop;
  }
  const derived = volumePerMinute / BALANCE.targetCasualtiesPerMin;
  return Math.max(derived, BALANCE.minUsdPerTroop);
}

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

// ---------------------------------------------------------------------------
// Binary frames
//
// Only `Pulse` is binary, and only because it runs at 10 Hz — see its doc
// comment for the measurement. Every other message stays JSON, because a
// readable wire is worth more than bytes nobody is short of.
// ---------------------------------------------------------------------------

/**
 * Leading byte of every binary frame. Lets the reader dispatch on kind, and
 * lets a future frame be added without guessing from the length.
 */
export const FRAME_PULSE = 1;

export const PULSE_BYTES = 7;

/**
 * Fixed-point scale for `frontLine`. −1…+1 becomes −10000…+10000, which fits
 * an int16 with room to spare and stays legible in a hex dump: 5000 is plainly
 * half way. A raw int16 range would buy precision far below one screen pixel.
 */
const FRONT_LINE_SCALE = 10_000;

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Pack a pulse into `PULSE_BYTES`: kind, two u16 unit counts, one i16 front
 * line. Big-endian, which is both the `DataView` default and network order.
 *
 * Out-of-range values are clamped rather than rejected. This runs inside the
 * broadcast loop, and a simulation bug should not be able to throw there and
 * take the socket down for every viewer — the numbers are for display, so a
 * pinned counter is a far better failure than a dead stream.
 */
export function encodePulse(pulse: Omit<Pulse, 'type' | 't'>): ArrayBuffer {
  const buffer = new ArrayBuffer(PULSE_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, FRAME_PULSE);
  view.setUint16(1, clamp(Math.round(pulse.orcAlive), 0, 65_535), false);
  view.setUint16(3, clamp(Math.round(pulse.nexusAlive), 0, 65_535), false);
  view.setInt16(5, Math.round(clamp(pulse.frontLine, -1, 1) * FRONT_LINE_SCALE), false);
  return buffer;
}

/**
 * Read a pulse, or `null` if the frame is not one.
 *
 * Returning `null` rather than throwing mirrors how the client already treats
 * unparseable JSON: skip the frame and wait for the next one, which is 100 ms
 * away. A malformed frame is not worth dropping a working connection over.
 *
 * `now` is a seam for tests; production lets it default.
 */
export function decodePulse(frame: ArrayBuffer, now = Date.now()): Pulse | null {
  if (frame.byteLength !== PULSE_BYTES) return null;
  const view = new DataView(frame);
  if (view.getUint8(0) !== FRAME_PULSE) return null;
  return {
    type: 'pulse',
    t: now,
    orcAlive: view.getUint16(1, false),
    nexusAlive: view.getUint16(3, false),
    frontLine: view.getInt16(5, false) / FRONT_LINE_SCALE,
  };
}
