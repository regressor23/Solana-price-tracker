import { SOL_MINT, type PriceTick } from '@sol-warzone/protocol';

import type { HttpClient } from '../http.js';

/** Shape of `GET /price/v3?ids=<mint>`. */
interface PriceV3Entry {
  usdPrice: number;
  blockId: number;
  /** Percent, not a fraction — verified against hourly candles 2026-08-10. */
  priceChange24h: number;
  decimals: number;
  liquidity: number;
}

export interface PriceFeedOptions {
  http: HttpClient;
  baseUrl: string;
  mint?: string;
  now?: () => number;
}

/**
 * Polls Jupiter's aggregated USD price.
 *
 * Jupiter reports the slot the price came from, so a poll that lands inside the
 * same slot is a duplicate rather than a zero-move tick. Emitting those would
 * paint a flatline of fake activity, so they are dropped.
 */
export class PriceFeed {
  readonly #http: HttpClient;
  readonly #url: string;
  readonly #mint: string;
  readonly #now: () => number;

  #last: PriceTick | undefined;
  #lastBlockId = -1;

  constructor(options: PriceFeedOptions) {
    this.#http = options.http;
    this.#mint = options.mint ?? SOL_MINT;
    this.#url = `${options.baseUrl}/price/v3?ids=${this.#mint}`;
    this.#now = options.now ?? Date.now;
  }

  get last(): PriceTick | undefined {
    return this.#last;
  }

  /** Returns the new tick, or null when the slot has not advanced. */
  async poll(): Promise<PriceTick | null> {
    const payload = await this.#http.getJson<Record<string, PriceV3Entry>>(this.#url);
    const entry = payload[this.#mint];
    if (!entry || !Number.isFinite(entry.usdPrice) || entry.usdPrice <= 0) {
      throw new Error(`price/v3 returned no usable price for ${this.#mint}`);
    }

    if (entry.blockId <= this.#lastBlockId) return null;

    const previous = this.#last?.price;
    const tick: PriceTick = {
      type: 'tick',
      t: this.#now(),
      blockId: entry.blockId,
      price: entry.usdPrice,
      tickChange: previous === undefined ? 0 : (entry.usdPrice - previous) / previous,
      // The API reports a percent; the wire contract is fractions throughout.
      change24h: entry.priceChange24h / 100,
    };

    this.#lastBlockId = entry.blockId;
    this.#last = tick;
    return tick;
  }
}
