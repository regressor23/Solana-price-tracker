import { SOL_MINT, type Candle } from '@sol-warzone/protocol';

import type { HttpClient } from '../http.js';

export interface CandleFeedOptions {
  http: HttpClient;
  dataUrl: string;
  mint?: string;
  /** How much history to warm a joining client with. */
  minutes?: number;
  now?: () => number;
}

/**
 * One-minute OHLCV, used to warm a client that joins mid-battle and to
 * calibrate how much volume a minute normally carries.
 *
 * The endpoint takes millisecond bounds and returns second timestamps. Passing
 * seconds is not an error — it quietly returns an empty candle list, which is
 * why the conversion is explicit here.
 */
export class CandleFeed {
  readonly #http: HttpClient;
  readonly #dataUrl: string;
  readonly #mint: string;
  readonly #minutes: number;
  readonly #now: () => number;

  #last: readonly Candle[] = [];

  constructor(options: CandleFeedOptions) {
    this.#http = options.http;
    this.#dataUrl = options.dataUrl;
    this.#mint = options.mint ?? SOL_MINT;
    this.#minutes = options.minutes ?? 60;
    this.#now = options.now ?? Date.now;
  }

  get last(): readonly Candle[] {
    return this.#last;
  }

  /** Mean USD volume per minute, or null before the first successful poll. */
  get volumePerMinute(): number | null {
    if (this.#last.length === 0) return null;
    const total = this.#last.reduce((sum, candle) => sum + candle.volume, 0);
    return total / this.#last.length;
  }

  async poll(): Promise<readonly Candle[]> {
    const to = this.#now();
    const from = to - this.#minutes * 60_000;
    const url =
      `${this.#dataUrl}/v2/charts/${this.#mint}` +
      `?interval=1_MINUTE&baseAsset=${this.#mint}` +
      `&from=${from}&to=${to}&candles=${this.#minutes}&type=price`;

    const payload = await this.#http.getJson<{ candles?: Candle[] }>(url);
    const candles = payload.candles ?? [];
    if (candles.length === 0) {
      throw new Error('charts returned no candles — check that bounds are in ms');
    }

    this.#last = candles;
    return candles;
  }
}
