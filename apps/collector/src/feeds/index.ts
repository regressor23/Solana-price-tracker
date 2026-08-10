import {
  FEED_PROFILES,
  RATE_BUDGET_PER_MIN,
  type Candle,
  type FeedStatus,
  type MarketEvent,
  type Snapshot,
  type Trade,
} from '@sol-warzone/protocol';

import { HttpClient, HttpError } from '../http.js';
import { Poller } from '../poller.js';
import { CandleFeed } from './candles.js';
import { DepthFeed } from './depth.js';
import { PriceFeed } from './price.js';
import { TradeFeed } from './trades.js';

export interface MarketFeedsOptions {
  /** Keyless host. Also the fallback when a key turns out to be bad. */
  liteUrl: string;
  /** Keyed host, used only while a key is configured and accepted. */
  keyedUrl: string;
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
  keyRejected: boolean;
  refUsd: number;
  volumePerMinute: number | null;
  upstream: {
    quoteHost: string;
    quoteRatePerMin: number | null;
    quoteBudgetLeft: number | null;
    quoteThrottleHits: number;
    quoteAuthFailures: number;
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

const isAuthFailure = (error: unknown): boolean =>
  error instanceof HttpError && (error.status === 401 || error.status === 403);

/**
 * Owns every upstream poller and the state a joining client needs.
 *
 * One instance per process: this is the single Jupiter consumer that the whole
 * fan-out depends on.
 */
export class MarketFeeds {
  readonly #options: MarketFeedsOptions;
  readonly #publish: (event: MarketEvent) => void;
  readonly #setStatus: (status: FeedStatus, detail?: string) => void;
  readonly #now: () => number;

  readonly #trades: TradeFeed;
  readonly #candles: CandleFeed;
  readonly #dataHttp: HttpClient;
  readonly #dataPollers: Poller[];

  #quoteHttp!: HttpClient;
  #price!: PriceFeed;
  #depth!: DepthFeed;
  #quotePollers: Poller[] = [];
  #profile: keyof typeof FEED_PROFILES = 'lite';
  #quoteHost = '';
  #keyRejected = false;
  #started = false;

  #recentTrades: Trade[] = [];
  #status: FeedStatus = 'sync';

  constructor(options: MarketFeedsOptions) {
    this.#options = options;
    this.#publish = options.publish;
    this.#setStatus = options.setStatus;
    this.#now = options.now ?? Date.now;

    // Two clients, because the hosts have very different ceilings: the quote
    // API tolerates about 60 requests a minute keyless, the data API more than
    // twice that. A single shared budget would throttle trades to protect
    // quotes.
    this.#dataHttp =
      options.http ?? new HttpClient({ budgetPerMin: RATE_BUDGET_PER_MIN.dataApi });
    const data = this.#dataHttp;

    this.#trades = new TradeFeed({ http: data, dataUrl: options.dataUrl });
    this.#candles = new CandleFeed({ http: data, dataUrl: options.dataUrl });

    this.#dataPollers = [
      new Poller({
        name: 'trades',
        intervalMs: FEED_PROFILES.lite.trades,
        onError: this.#onError,
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
        intervalMs: FEED_PROFILES.lite.candles,
        onError: this.#onError,
        tick: async () => {
          await this.#candles.poll();
        },
      }),
    ];

    this.#installQuoteTier(Boolean(options.apiKey));
  }

  start(): void {
    this.#started = true;
    for (const poller of [...this.#quotePollers, ...this.#dataPollers]) {
      poller.start();
    }
  }

  stop(): void {
    this.#started = false;
    for (const poller of [...this.#quotePollers, ...this.#dataPollers]) {
      poller.stop();
    }
  }

  /** Warm-start payload for a client that just connected. */
  snapshot(): Snapshot {
    return {
      type: 'snapshot',
      t: this.#now(),
      status: this.#status,
      price: this.#price.last ?? null,
      depth: this.#depth.last ?? null,
      candles: this.#candles.last,
      recentTrades: this.#recentTrades,
    };
  }

  diagnostics(): FeedDiagnostics {
    return {
      status: this.#status,
      profile: this.#profile,
      keyRejected: this.#keyRejected,
      refUsd: this.#trades.refUsd,
      volumePerMinute: this.#candles.volumePerMinute,
      upstream: {
        quoteHost: this.#quoteHost,
        quoteRatePerMin: this.#quoteHttp.budgetPerMin,
        quoteBudgetLeft: this.#quoteHttp.budgetAvailable,
        quoteThrottleHits: this.#quoteHttp.throttleHits,
        quoteAuthFailures: this.#quoteHttp.authFailures,
        dataThrottleHits: this.#dataHttp.throttleHits,
      },
      pollers: [...this.#quotePollers, ...this.#dataPollers].map((poller) => ({
        name: poller.name,
        lastOkAt: poller.lastOkAt,
        lastErrorAt: poller.lastErrorAt,
        consecutiveErrors: poller.consecutiveErrors,
        skipped: poller.skipped,
      })),
    };
  }

  get candles(): readonly Candle[] {
    return this.#candles.last;
  }

  // -------------------------------------------------------------------------

  readonly #onError = (name: string, error: unknown): void => {
    console.warn(
      `[feed:${name}] ${error instanceof Error ? error.message : String(error)}`,
    );
    // A rejected key is not a transient failure. Retrying it forever leaves the
    // site dead, and the keyed host is stricter than the keyless one for
    // unauthenticated callers, so staying put is the worst of both.
    if (isAuthFailure(error)) this.#dropRejectedKey();
    this.#refreshStatus();
  };

  #installQuoteTier(keyed: boolean): void {
    const { apiKey, keyedUrl, liteUrl, http } = this.#options;
    this.#profile = keyed ? 'keyed' : 'lite';
    this.#quoteHost = keyed ? keyedUrl : liteUrl;
    const cadence = FEED_PROFILES[this.#profile];

    this.#quoteHttp =
      http ??
      new HttpClient({
        ...(keyed && apiKey ? { apiKey } : {}),
        budgetPerMin: keyed
          ? RATE_BUDGET_PER_MIN.keyedApi
          : RATE_BUDGET_PER_MIN.liteApi,
      });

    const client = this.#quoteHttp;
    this.#price = new PriceFeed({ http: client, baseUrl: this.#quoteHost });
    this.#depth = new DepthFeed({ http: client, baseUrl: this.#quoteHost });

    this.#quotePollers = [
      new Poller({
        name: 'price',
        intervalMs: cadence.price,
        onError: this.#onError,
        tick: async () => {
          const tick = await this.#price.poll();
          if (tick) this.#publish(tick);
          this.#refreshStatus();
        },
      }),
      new Poller({
        name: 'depth',
        intervalMs: cadence.depth,
        onError: this.#onError,
        tick: async () => {
          this.#publish(await this.#depth.poll());
          this.#refreshStatus();
        },
      }),
    ];
  }

  /** Rebuild the quote tier without a key, keeping the process running. */
  #dropRejectedKey(): void {
    if (this.#keyRejected || this.#profile !== 'keyed') return;
    this.#keyRejected = true;

    console.warn(
      '[collector] JUPITER_API_KEY was rejected — falling back to the keyless ' +
        'host and the slower cadence. Check the key at portal.jup.ag.',
    );

    for (const poller of this.#quotePollers) poller.stop();
    this.#installQuoteTier(false);
    if (this.#started) for (const poller of this.#quotePollers) poller.start();

    this.#setStatus('degraded', 'api key rejected — running keyless');
    this.#status = 'degraded';
  }

  /**
   * Price is the heartbeat. Depth and candles refresh far more slowly, so
   * gating "live" on them would flap; they only matter for the warm start.
   */
  #refreshStatus(): void {
    const lastOk = this.#quotePollers[0]?.lastOkAt ?? 0;
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
