import {
  FEED_PROFILES,
  RATE_BUDGET_PER_MIN,
  budgetForRps,
  profileForRps,
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
  /** Requests per second the configured Jupiter plan allows. */
  rps: number;
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
/**
 * How many refusals to absorb before concluding a key is not buying headroom.
 * High enough to ride out a transient bad patch on a key that is genuinely fine.
 */
const KEYED_THROTTLE_TOLERANCE = 10;
/**
 * How often to judge the upstream independently of any poll finishing.
 *
 * Severe throttling makes a poll take minutes — the depth ladder is 18 requests
 * and each one waits for a token — so a check that only runs when a tick
 * completes would leave the collector stuck on a bad host for exactly as long
 * as that host is worst.
 */
const SUPERVISOR_MS = 5_000;

export interface FeedDiagnostics {
  status: FeedStatus;
  profile: string;
  keyRejected: boolean;
  downgradeReason: string | null;
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
  #keyed = false;
  #quoteHost = '';
  #keyRejected = false;
  #downgradeReason: string | null = null;
  #started = false;
  #supervisor: ReturnType<typeof setInterval> | undefined;

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

    // Only use the keyed host when the plan actually beats the keyless budget.
    // A free-plan key allows 1 RPS — less than lite-api gives away — so trying
    // it first would mean throttling and downgrading on every single boot.
    const keyWorthUsing =
      Boolean(options.apiKey) &&
      budgetForRps(options.rps) > RATE_BUDGET_PER_MIN.liteApi;
    this.#installQuoteTier(keyWorthUsing);
  }

  start(): void {
    this.#started = true;
    for (const poller of [...this.#quotePollers, ...this.#dataPollers]) {
      poller.start();
    }
    this.#supervisor = setInterval(() => {
      this.#checkKeyIsEarningItsPlace();
    }, SUPERVISOR_MS);
    this.#supervisor.unref?.();
  }

  stop(): void {
    this.#started = false;
    for (const poller of [...this.#quotePollers, ...this.#dataPollers]) {
      poller.stop();
    }
    if (this.#supervisor !== undefined) clearInterval(this.#supervisor);
    this.#supervisor = undefined;
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
      downgradeReason: this.#downgradeReason,
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
    if (isAuthFailure(error)) {
      this.#downgrade('api key rejected — running keyless');
    }
    this.#refreshStatus();
  };

  /**
   * Abandon the keyed host if it cannot beat the keyless one.
   *
   * A key that authenticates is not automatically a key that helps. Observed in
   * production: api.jup.ag accepted the key without complaint but throttled
   * below the floor anyway, which is worse than the 55/min the keyless host
   * sustains happily. The adaptive rate collapsing that far is the signal — it
   * means the upstream has refused repeatedly at rates the keyless host allows.
   */
  #checkKeyIsEarningItsPlace(): boolean {
    if (!this.#keyed) return false;
    const rate = this.#quoteHttp.budgetPerMin;
    if (rate === null || rate > RATE_BUDGET_PER_MIN.liteApi / 2) return false;
    if (this.#quoteHttp.throttleHits < KEYED_THROTTLE_TOLERANCE) return false;

    this.#downgrade(
      `keyed host throttled to ${Math.round(rate)}/min — keyless is faster`,
    );
    return true;
  }

  #installQuoteTier(keyed: boolean): void {
    const { apiKey, keyedUrl, liteUrl, http, rps } = this.#options;
    // The plan decides the cadence. A key on the free plan buys 1 RPS, which is
    // what the keyless host already allows, so it must not unlock a faster one.
    this.#profile = keyed ? profileForRps(rps) : 'lite';
    this.#keyed = keyed;
    this.#quoteHost = keyed ? keyedUrl : liteUrl;
    const cadence = FEED_PROFILES[this.#profile];

    this.#quoteHttp =
      http ??
      new HttpClient({
        ...(keyed && apiKey ? { apiKey } : {}),
        budgetPerMin: keyed ? budgetForRps(rps) : RATE_BUDGET_PER_MIN.liteApi,
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
  #downgrade(reason: string): void {
    if (this.#keyRejected || !this.#keyed) return;
    this.#keyRejected = true;
    this.#downgradeReason = reason;

    console.warn(
      `[collector] ${reason}. Falling back to ${this.#options.liteUrl} at the ` +
        'slower cadence. Check the key and its plan at portal.jup.ag.',
    );

    for (const poller of this.#quotePollers) poller.stop();
    this.#installQuoteTier(false);
    if (this.#started) for (const poller of this.#quotePollers) poller.start();

    this.#status = 'degraded';
    this.#setStatus('degraded', reason);
  }

  /**
   * Price is the heartbeat. Depth and candles refresh far more slowly, so
   * gating "live" on them would flap; they only matter for the warm start.
   */
  #refreshStatus(): void {
    // Runs on every tick, success or failure: the client often recovers from a
    // 429 after retrying, so waiting for an outright poll failure would let the
    // throttling go unnoticed. A downgrade rebuilds the pollers, so the status
    // it just set is the authoritative one.
    if (this.#checkKeyIsEarningItsPlace()) return;

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
