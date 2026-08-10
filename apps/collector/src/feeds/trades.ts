import { BALANCE, SOL_MINT, classifyTrade, type Trade } from '@sol-warzone/protocol';

import type { HttpClient } from '../http.js';

/** Shape of one entry in `GET /v1/txs/<mint>`. */
interface RawSwap {
  type: 'buy' | 'sell';
  usdVolume: number;
  usdPrice: number;
  txHash: string;
  poolId: string;
  timestamp: string;
  isMev?: boolean;
}

export interface TradeFeedOptions {
  http: HttpClient;
  dataUrl: string;
  mint?: string;
  /**
   * Dust floor. SOL sees a constant drizzle of sub-cent swaps that would swamp
   * the feed with events representing no real pressure.
   */
  minUsdVolume?: number;
  /** Page size; the endpoint caps at 30 whatever we ask for. */
  limit?: number;
  now?: () => number;
}

/** How many hashes to remember for de-duplication. */
const SEEN_CAPACITY = 4_000;

/**
 * Polls Jupiter's swap feed and turns it into sized, classified trades.
 *
 * This covers SOL against everything rather than SOL/USDC alone — the endpoint
 * has no pool filter, and the pool registry only resolves a fraction of the
 * venues that actually carry flow. Every swap is priced in USD regardless, and
 * pressure on SOL is pressure on SOL whoever the counter-asset is, so the feed
 * is treated as aggregated (and labelled that way in the HUD).
 */
export class TradeFeed {
  readonly #http: HttpClient;
  readonly #url: string;
  readonly #now: () => number;

  /** Insertion-ordered, so the oldest hash is the first key. */
  readonly #seen = new Set<string>();
  #primed = false;
  // Annotated: BALANCE is `as const`, so inference would pin this to a literal.
  #refUsd: number = BALANCE.usdRefFloor;

  constructor(options: TradeFeedOptions) {
    this.#http = options.http;
    const mint = options.mint ?? SOL_MINT;
    const minUsd = options.minUsdVolume ?? 500;
    const limit = options.limit ?? 30;
    this.#url = `${options.dataUrl}/v1/txs/${mint}?limit=${limit}&minUsdVolume=${minUsd}`;
    this.#now = options.now ?? Date.now;
  }

  /** Rolling mean trade size that drives tier classification. */
  get refUsd(): number {
    return this.#refUsd;
  }

  async poll(): Promise<Trade[]> {
    const payload = await this.#http.getJson<{ txs?: RawSwap[] }>(this.#url);
    const swaps = payload.txs ?? [];

    const fresh = swaps.filter((swap) => swap.txHash && !this.#seen.has(swap.txHash));
    for (const swap of swaps) this.#remember(swap.txHash);

    // The first poll returns a page of history. Replaying it would open with a
    // burst of ~30 simultaneous casualties that never happened live.
    if (!this.#primed) {
      this.#primed = true;
      for (const swap of fresh) this.#updateReference(swap.usdVolume);
      return [];
    }

    // The endpoint returns newest first; the battle wants chronological order.
    return fresh
      .slice()
      .reverse()
      .map((swap) => this.#toTrade(swap));
  }

  #toTrade(swap: RawSwap): Trade {
    // Classify against the reference as it stood before this trade, so a whale
    // cannot inflate the bar it is about to be measured against.
    const tier = classifyTrade(swap.usdVolume, this.#refUsd);
    this.#updateReference(swap.usdVolume);

    const parsed = Date.parse(swap.timestamp);
    return {
      type: 'trade',
      t: Number.isNaN(parsed) ? this.#now() : parsed,
      side: swap.type,
      usd: swap.usdVolume,
      price: swap.usdPrice,
      tier,
    };
  }

  #updateReference(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.#refUsd = this.#refUsd + (usd - this.#refUsd) * BALANCE.usdRefEma;
  }

  #remember(hash: string): void {
    if (!hash) return;
    this.#seen.add(hash);
    if (this.#seen.size > SEEN_CAPACITY) {
      // Sets iterate in insertion order, so this evicts the oldest hash.
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
  }
}
