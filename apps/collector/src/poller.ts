export interface PollerOptions {
  name: string;
  intervalMs: number;
  /** One pass. Rejections are reported, never thrown into the timer. */
  tick: () => Promise<void>;
  onError?: (name: string, error: unknown) => void;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

/**
 * Runs an async task on an interval without ever overlapping itself.
 *
 * A Jupiter call that takes longer than the interval must not stack up behind
 * the timer — that turns one slow upstream into a self-inflicted request flood
 * exactly when the upstream is least able to take it. A tick that is still
 * running simply skips the next slot.
 */
export class Poller {
  readonly #options: Required<Pick<PollerOptions, 'name' | 'intervalMs' | 'tick'>> &
    PollerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #skipped = 0;
  #lastOkAt = 0;
  #lastErrorAt = 0;
  #consecutiveErrors = 0;

  constructor(options: PollerOptions) {
    this.#options = options;
  }

  get name(): string {
    return this.#options.name;
  }
  get lastOkAt(): number {
    return this.#lastOkAt;
  }
  get lastErrorAt(): number {
    return this.#lastErrorAt;
  }
  get consecutiveErrors(): number {
    return this.#consecutiveErrors;
  }
  /** Ticks dropped because the previous one was still in flight. */
  get skipped(): number {
    return this.#skipped;
  }

  /** Runs one pass immediately, then every intervalMs. */
  start(): void {
    if (this.#timer !== undefined) return;
    const schedule = this.#options.setInterval ?? setInterval;
    void this.runOnce();
    this.#timer = schedule(() => void this.runOnce(), this.#options.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    const cancel = this.#options.clearInterval ?? clearInterval;
    cancel(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running) {
      this.#skipped++;
      return;
    }
    this.#running = true;
    try {
      await this.#options.tick();
      this.#lastOkAt = Date.now();
      this.#consecutiveErrors = 0;
    } catch (error) {
      this.#lastErrorAt = Date.now();
      this.#consecutiveErrors++;
      this.#options.onError?.(this.#options.name, error);
    } finally {
      this.#running = false;
    }
  }
}
