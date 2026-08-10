/**
 * HTTP with the retry behaviour every Jupiter call needs.
 *
 * The collector is the single upstream consumer for every visitor, so getting
 * throttled takes the whole site down rather than one browser. Backoff is
 * therefore conservative and honours Retry-After.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface HttpClientOptions {
  /** Sent as x-api-key when non-empty. */
  apiKey?: string;
  timeoutMs?: number;
  /** Total tries, not retries. */
  attempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Upper bound the adaptive rate may climb to. Omit for no client-side limit. */
  budgetPerMin?: number;
  /** Opening rate. Defaults to a conservative value well under the ceiling. */
  startRatePerMin?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Never pace below this, or a bad patch of 429s would stall the feed entirely. */
const MIN_RATE_PER_MIN = 12;
/** Successful requests needed before the rate creeps back up. */
const RECOVERY_STREAK = 10;
/**
 * Opening rate when none is given.
 *
 * Measured safe against the keyless host, and the only number here that is not
 * a guess. Starting at the ceiling instead cost a burst of 429s on every boot:
 * the bucket handed out its whole allowance before it had any evidence the
 * upstream would accept that rate, then spent minutes climbing back down.
 * Starting low and probing upward pays a few slow seconds instead.
 */
const DEFAULT_START_PER_MIN = 55;

/**
 * Token bucket that tunes its own ceiling.
 *
 * The configured rate is an upper bound, not a known-good number. Jupiter's
 * published limits vary by tier and the collector cannot see which tier a key
 * belongs to, so guessing high and hoping is how the keyed profile ended up
 * throttled in production. Instead the bucket halves its rate on every 429 and
 * edges back up after a run of clean requests, which converges on whatever the
 * real limit turns out to be without anyone having to measure it.
 */
class Budget {
  #tokens: number;
  #updatedAt: number;
  #rate: number;
  #streak = 0;

  constructor(
    readonly ceiling: number,
    startRate: number,
    private readonly now: () => number,
  ) {
    this.#rate = Math.min(ceiling, Math.max(MIN_RATE_PER_MIN, startRate));
    this.#tokens = this.#rate;
    this.#updatedAt = now();
  }

  /** Rate currently being enforced, which may be below the ceiling. */
  get perMinute(): number {
    return this.#rate;
  }

  /** Milliseconds until a token is available, 0 when one can be spent now. */
  waitMs(): number {
    this.#refill();
    if (this.#tokens >= 1) return 0;
    return Math.ceil(((1 - this.#tokens) * 60_000) / this.#rate);
  }

  spend(): void {
    this.#refill();
    this.#tokens -= 1;
  }

  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  /** Multiplicative decrease — the upstream just told us we are too fast. */
  penalise(): void {
    this.#refill();
    this.#rate = Math.max(MIN_RATE_PER_MIN, this.#rate / 2);
    this.#tokens = Math.min(this.#tokens, 0);
    this.#streak = 0;
  }

  /** Additive increase, so a one-off 429 does not cap the feed forever. */
  reward(): void {
    if (this.#rate >= this.ceiling) return;
    if (++this.#streak < RECOVERY_STREAK) return;
    this.#streak = 0;
    this.#rate = Math.min(this.ceiling, this.#rate + MIN_RATE_PER_MIN);
  }

  #refill(): void {
    const at = this.now();
    const elapsed = at - this.#updatedAt;
    if (elapsed <= 0) return;
    this.#updatedAt = at;
    this.#tokens = Math.min(this.#rate, this.#tokens + (elapsed * this.#rate) / 60_000);
  }
}

/** 429 and 5xx are worth another go; a 400 will fail the same way forever. */
const isRetryable = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class HttpClient {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #budget: Budget | undefined;

  #throttledUntil = 0;
  #throttleHits = 0;
  #authFailures = 0;

  constructor(options: HttpClientOptions = {}) {
    this.#apiKey = options.apiKey ?? '';
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#attempts = options.attempts ?? 3;
    this.#baseBackoffMs = options.baseBackoffMs ?? 500;
    this.#maxBackoffMs = options.maxBackoffMs ?? 20_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#budget =
      options.budgetPerMin === undefined
        ? undefined
        : new Budget(
            options.budgetPerMin,
            options.startRatePerMin ?? DEFAULT_START_PER_MIN,
            this.#now,
          );
  }

  /** Wall-clock ms until the shared throttle lifts, 0 when clear. */
  throttleRemaining(now = this.#now()): number {
    return Math.max(0, this.#throttledUntil - now);
  }

  /** How many 429s this client has absorbed. Surfaced in diagnostics. */
  get throttleHits(): number {
    return this.#throttleHits;
  }

  /** Spare requests in the current budget window, or null when unlimited. */
  get budgetAvailable(): number | null {
    return this.#budget?.available ?? null;
  }

  /** Rate currently enforced, which drops below the ceiling after a 429. */
  get budgetPerMin(): number | null {
    return this.#budget?.perMinute ?? null;
  }

  /** Count of 401/403 responses — a rejected or revoked key. */
  get authFailures(): number {
    return this.#authFailures;
  }

  get hasApiKey(): boolean {
    return this.#apiKey !== '';
  }

  async getJson<T>(url: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      // A 429 on any request means the whole client should ease off, not just
      // the unlucky caller — every feed shares one upstream budget.
      const throttled = this.throttleRemaining();
      if (throttled > 0) await this.#sleep(throttled);

      if (this.#budget) {
        const wait = this.#budget.waitMs();
        if (wait > 0) await this.#sleep(wait);
        this.#budget.spend();
      }

      try {
        const response = await this.#fetch(url, {
          headers: this.#apiKey ? { 'x-api-key': this.#apiKey } : {},
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (response.ok) {
          this.#budget?.reward();
          return (await response.json()) as T;
        }

        // A rejected key never fixes itself by retrying. Tell the caller once
        // so it can fall back, rather than burning the retry budget on it.
        if (response.status === 401 || response.status === 403) {
          const body = await response.text().catch(() => '');
          this.#authFailures++;
          throw new HttpError(response.status, url, body.slice(0, 200));
        }

        const body = await response.text().catch(() => '');
        const error = new HttpError(response.status, url, body.slice(0, 200));

        if (!isRetryable(response.status) || attempt === this.#attempts) {
          throw error;
        }

        const advertised = retryAfterMs(
          response.headers.get('retry-after'),
          this.#now(),
        );
        const wait = advertised ?? this.#backoff(attempt);
        if (response.status === 429) {
          this.#throttledUntil = this.#now() + wait;
          this.#throttleHits++;
          this.#budget?.penalise();
        }
        lastError = error;
        await this.#sleep(wait);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // Network failure or timeout.
        if (attempt === this.#attempts) throw error;
        lastError = error;
        await this.#sleep(this.#backoff(attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('request failed');
  }

  #backoff(attempt: number): number {
    const exponential = this.#baseBackoffMs * 2 ** (attempt - 1);
    const jitter = 0.75 + this.#random() * 0.5;
    return Math.min(Math.round(exponential * jitter), this.#maxBackoffMs);
  }
}
