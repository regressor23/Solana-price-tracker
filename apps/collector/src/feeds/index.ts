import {
  FEED_PROFILES,
  RATE_BUDGET_PER_MIN,
  type Candle,
  type DepthSnapshot,
  type FeedStatus,
  type MarketEvent,
  type PriceTick,
  type Snapshot,
  type Trade,
} from '@sol-warzone/protocol';

import { HttpClient } from '../http.js';
import { Poller } from '../poller.js';
import { CandleFeed } from './candles.js';
import { DepthFeed } from './depth.js';
import { PriceFeed } from './price.js';
import { TradeFeed } from './trades.js';

export interface MarketFeedsOptions {
  baseUrl: string;
  dataUrl: string;
  apiKey?: string;
  publish: (event: MarketEvent) => void;
  setStatus: (status: FeedStatus, detail?: string) => void;
  http?: HttpClient;
  now?: () => number;
}

/**
 * How many missed price polls make the feed no longer "live".
 *
 * Expressed in polls rather than seconds because the cadence halves once an API
 * key is present; a fixed 15s would be lenient on one profile and twitchy on
 * the other.
 */
const STALE_AFTER_POLLS = 8;
/** Trades are bursty; absence is normal, so this is generous. */
const RECENT_TRADES = 50;

export interface FeedDiagnostics {
  status: FeedStatus;
  profile: string;
  refUsd: number;
  volumePerMinute: number | null;
  upstream: {
    quoteBudgetLeft: number | null;
    quoteThrottleHits: number;
    dataThrottleHits: number;
  };
  pollers: {
    name: string;
    lastOkAt: number;
    lastErrorAt: number;
    consecutiveErrors: number;
    skipped: number;
  }[];
}

/**
 * Owns every upstream poller and the state a joining client needs.
 *
 * One instance per process: this is the single Jupiter consumer that the whole
 * fan-out depends on.
 */
export class MarketFeeds {
  readonly #publish: (event: MarketEvent) => void;
  readonly #setStatus: (status: FeedStatus, detail?: string) => void;
  readonly #now: () => number;

  readonly #price: PriceFeed;
  readonly #depth: DepthFeed;
  readonly #trades: TradeFeed;
  readonly #candles: CandleFeed;
  readonly #pollers: Poller[];
  readonly #profile: keyof typeof FEED_PROFILES;
  readonly #quoteHttp: HttpClient;
  readonly #dataHttp: HttpClient;

  #recentTrades: Trade[] = [];
  #status: FeedStatus = 'sync';

  constructor(options: MarketFeedsOptions) {
    this.#publish = options.publish;
    this.#setStatus = options.setStatus;
    this.#now = options.now ?? Date.now;

    const keyed = Boolean(options.apiKey);
    this.#profile = keyed ? 'keyed' : 'lite';
    const cadence = FEED_PROFILES[this.#profile];

    // Two clients, because the hosts have very different ceilings: the quote
    // API tolerates about 60 requests a minute, the data API more than twice
    // that. A single shared budget would throttle trades to protect quotes.
    this.#quoteHttp =
      options.http ??
      new HttpClient({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        budgetPerMin: keyed
          ? RATE_BUDGET_PER_MIN.keyedApi
          : RATE_BUDGET_PER_MIN.liteApi,
      });
    this.#dataHttp =
      options.http ?? new HttpClient({ budgetPerMin: RATE_BUDGET_PER_MIN.dataApi });

    const http = this.#quoteHttp;
    const data = this.#dataHttp;

    this.#price = new PriceFeed({ http, baseUrl: options.baseUrl });
    this.#depth = new DepthFeed({ http, baseUrl: options.baseUrl });
    this.#trades = new TradeFeed({ http: data, dataUrl: options.dataUrl });
    this.#candles = new CandleFeed({ http: data, dataUrl: options.dataUrl });

    const onError = (name: string, error: unknown) => {
      console.warn(
        `[feed:${name}] ${error instanceof Error ? error.message : String(error)}`,
      );
      this.#refreshStatus();
    };

    this.#pollers = [
      new Poller({
        name: 'price',
        intervalMs: cadence.price,
        onError,
        tick: async () => {
          const tick = await this.#price.poll();
          if (tick) this.#publish(tick);
          this.#refreshStatus();
        },
      }),
      new Poller({
        name: 'depth',
        intervalMs: cadence.depth,
        onError,
        tick: async () => {
          this.#publish(await this.#depth.poll());
          this.#refreshStatus();
        },
      }),
      // Trades share the price cadence: the feed turns over several times a
      // second, so a slower poll would silently drop events off the page.
      new Poller({
        name: 'trades',
        intervalMs: cadence.trades,
        onError,
        tick: async () => {
          for (const trade of await this.#trades.poll()) {
            this.#publish(trade);
            this.#recentTrades.push(trade);
          }
          if (this.#recentTrades.length > RECENT_TRADES) {
            this.#recentTrades = this.#recentTrades.slice(-RECENT_TRADES);
          }
        },
      }),
      new Poller({
        name: 'candles',
        intervalMs: cadence.candles,
        onError,
        tick: async () => {
          await this.#candles.poll();
        },
      }),
    ];
  }

  start(): void {
    for (const poller of this.#pollers) poller.start();
  }

  stop(): void {
    for (const poller of this.#pollers) poller.stop();
  }

  /** Warm-start payload for a client that just connected. */
  snapshot(): Snapshot {
    return {
      type: 'snapshot',
      t: this.#now(),
      status: this.#status,
      price: this.#priceTick,
      depth: this.#depthSnapshot,
      candles: this.#candles.last,
      recentTrades: this.#recentTrades,
    };
  }

  diagnostics(): FeedDiagnostics {
    return {
      status: this.#status,
      profile: this.#profile,
      refUsd: this.#trades.refUsd,
      volumePerMinute: this.#candles.volumePerMinute,
      upstream: {
        quoteBudgetLeft: this.#quoteHttp.budgetAvailable,
        quoteThrottleHits: this.#quoteHttp.throttleHits,
        dataThrottleHits: this.#dataHttp.throttleHits,
      },
      pollers: this.#pollers.map((poller) => ({
        name: poller.name,
        lastOkAt: poller.lastOkAt,
        lastErrorAt: poller.lastErrorAt,
        consecutiveErrors: poller.consecutiveErrors,
        skipped: poller.skipped,
      })),
    };
  }

  get #priceTick(): PriceTick | null {
    return this.#price.last ?? null;
  }

  get #depthSnapshot(): DepthSnapshot | null {
    return this.#depth.last ?? null;
  }

  get candles(): readonly Candle[] {
    return this.#candles.last;
  }

  /**
   * Price is the heartbeat. Depth and candles refresh far more slowly, so
   * gating "live" on them would flap; they only matter for the warm start.
   */
  #refreshStatus(): void {
    const pricePoller = this.#pollers[0];
    const lastOk = pricePoller?.lastOkAt ?? 0;
    const age = this.#now() - lastOk;

    let next: FeedStatus;
    let detail: string | undefined;

    if (lastOk === 0) {
      next = 'sync';
    } else if (age > FEED_PROFILES[this.#profile].price * STALE_AFTER_POLLS) {
      next = 'degraded';
      detail = `price ${Math.round(age / 1000)}s stale`;
    } else {
      next = 'live';
    }

    if (next === this.#status) return;
    this.#status = next;
    this.#setStatus(next, detail);
  }
}
