import {
  DEPTH_LADDER_SOL,
  SOL_DECIMALS,
  SOL_MINT,
  USDC_MINT,
  WALL_IMPACT_PCT,
  type DepthRung,
  type DepthSnapshot,
} from '@sol-warzone/protocol';

import type { HttpClient } from '../http.js';

interface QuoteResponse {
  inAmount: string;
  outAmount: string;
  swapMode: string;
  routePlan?: { swapInfo: { label?: string }; percent: number }[];
}

export interface DepthFeedOptions {
  http: HttpClient;
  baseUrl: string;
  ladder?: readonly number[];
  now?: () => number;
}

const toLamports = (sol: number): bigint =>
  BigInt(Math.round(sol * 10 ** SOL_DECIMALS));

/**
 * Builds a two-sided liquidity curve from Jupiter quotes.
 *
 * Solana has no order book, so there are no bid and ask levels to read. The
 * equivalent is what a given size actually costs to execute: quoting the same
 * SOL amount in both directions gives the average fill price on each side, and
 * the spread of those against mid is the same shape as a depth chart — with the
 * advantage of describing real executable liquidity across every DEX at once.
 *
 * Both sides fix the SOL amount — ExactIn when selling, ExactOut when buying —
 * so the two curves are directly comparable rung for rung.
 */
export class DepthFeed {
  readonly #http: HttpClient;
  readonly #baseUrl: string;
  readonly #ladder: readonly number[];
  readonly #now: () => number;

  #last: DepthSnapshot | undefined;

  constructor(options: DepthFeedOptions) {
    this.#http = options.http;
    this.#baseUrl = options.baseUrl;
    this.#ladder = options.ladder ?? DEPTH_LADDER_SOL;
    this.#now = options.now ?? Date.now;
  }

  get last(): DepthSnapshot | undefined {
    return this.#last;
  }

  async poll(): Promise<DepthSnapshot> {
    // Rungs are settled individually. The top of the ask ladder routinely has
    // no route — nothing on Solana can fill 150k SOL in one go — and losing the
    // whole curve because its deepest rung is unquotable would be absurd.
    const [bids, asks] = await Promise.all([
      settleRungs(this.#ladder.map((size) => this.#sell(size))),
      settleRungs(this.#ladder.map((size) => this.#buy(size))),
    ]);

    // The tightest rung on each side is the closest thing to a touch price.
    const bestBid = bids[0]?.avgPrice;
    const bestAsk = asks[0]?.avgPrice;
    if (bestBid === undefined || bestAsk === undefined) {
      throw new Error('depth ladder produced no rungs');
    }
    const mid = (bestBid + bestAsk) / 2;

    const snapshot: DepthSnapshot = {
      type: 'depth',
      t: this.#now(),
      mid,
      bids: bids.map((rung) => withImpact(rung, mid)),
      asks: asks.map((rung) => withImpact(rung, mid)),
      bidWallUsd: 0,
      askWallUsd: 0,
    };

    const withWalls: DepthSnapshot = {
      ...snapshot,
      bidWallUsd: wallUsd(snapshot.bids),
      askWallUsd: wallUsd(snapshot.asks),
    };

    this.#last = withWalls;
    return withWalls;
  }

  /** Selling `sizeSol` into the market — the bid side. */
  async #sell(sizeSol: number): Promise<RawRung> {
    const url =
      `${this.#baseUrl}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}` +
      `&amount=${toLamports(sizeSol)}&slippageBps=5000`;
    const quote = await this.#http.getJson<QuoteResponse>(url);
    const usd = Number(quote.outAmount) / 1e6;
    return { sizeSol, usd, avgPrice: usd / sizeSol };
  }

  /** Buying `sizeSol` out of the market — the ask side. */
  async #buy(sizeSol: number): Promise<RawRung> {
    const url =
      `${this.#baseUrl}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}` +
      `&amount=${toLamports(sizeSol)}&slippageBps=5000&swapMode=ExactOut`;
    const quote = await this.#http.getJson<QuoteResponse>(url);
    const usd = Number(quote.inAmount) / 1e6;
    return { sizeSol, usd, avgPrice: usd / sizeSol };
  }
}

interface RawRung {
  sizeSol: number;
  usd: number;
  avgPrice: number;
}

/**
 * Keeps the rungs that quoted and discards the rest, preserving order.
 *
 * A rung is also dropped when it prices at or below zero: a malformed quote
 * that slipped through would otherwise produce an impact of -100% and pin the
 * front line to one end of the map.
 */
async function settleRungs(promises: Promise<RawRung>[]): Promise<RawRung[]> {
  const settled = await Promise.allSettled(promises);
  return settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((rung) => Number.isFinite(rung.avgPrice) && rung.avgPrice > 0);
}

const withImpact = (rung: RawRung, mid: number): DepthRung => ({
  ...rung,
  impactPct: (rung.avgPrice - mid) / mid,
});

/**
 * USD absorbable before price moves WALL_IMPACT_PCT away from mid.
 *
 * The ladder is coarse, so the crossing almost never lands on a rung. Linear
 * interpolation between the straddling rungs keeps the number from jumping in
 * big steps as liquidity shifts — a wall that snaps from $2M to $9M because one
 * rung crossed a threshold reads as noise.
 */
export function wallUsd(rungs: readonly DepthRung[]): number {
  let previous: DepthRung | undefined;

  for (const rung of rungs) {
    const impact = Math.abs(rung.impactPct);
    if (impact >= WALL_IMPACT_PCT) {
      if (!previous) return rung.usd * (WALL_IMPACT_PCT / impact);
      const spanImpact = impact - Math.abs(previous.impactPct);
      if (spanImpact <= 0) return previous.usd;
      const fraction = (WALL_IMPACT_PCT - Math.abs(previous.impactPct)) / spanImpact;
      return previous.usd + (rung.usd - previous.usd) * fraction;
    }
    previous = rung;
  }

  // The whole ladder fits inside the band; report what we measured rather than
  // extrapolating into sizes nobody quoted.
  return previous?.usd ?? 0;
}
