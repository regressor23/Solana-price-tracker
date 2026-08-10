import {
  PROTOCOL_VERSION,
  type FeedStatus,
  type ServerMessage,
} from '@sol-warzone/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface ConnectionHandlers {
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState, detail?: string) => void;
}

/**
 * Seams for tests. Production never passes these — the defaults are the real
 * browser globals.
 */
export interface ConnectionOptions {
  /** Opens the transport. */
  createSocket?: (url: string) => WebSocket;
  /** Resolved per attempt, so a page moved between origins still reconnects. */
  url?: () => string;
  /** Backoff jitter source. */
  random?: () => number;
}

export const MIN_RETRY_MS = 500;
export const MAX_RETRY_MS = 15_000;

/** Same-origin in production; the Vite dev server proxies /ws to the collector. */
export function defaultSocketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/**
 * Auto-reconnecting client socket.
 *
 * Backoff is exponential with jitter so a collector restart does not bring
 * every browser back in the same millisecond.
 */
export class Connection {
  readonly #handlers: ConnectionHandlers;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #url: () => string;
  readonly #random: () => number;

  #socket: WebSocket | undefined;
  #retryMs = MIN_RETRY_MS;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(handlers: ConnectionHandlers, options: ConnectionOptions = {}) {
    this.#handlers = handlers;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#url = options.url ?? defaultSocketUrl;
    this.#random = options.random ?? Math.random;
  }

  /** Milliseconds the next reconnect attempt will wait. Exposed for the HUD. */
  get retryMs(): number {
    return this.#retryMs;
  }

  open(): void {
    this.#closed = false;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }

  #connect(): void {
    this.#handlers.onState('connecting');
    const socket = this.#createSocket(this.#url());
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#retryMs = MIN_RETRY_MS;
      this.#handlers.onState('open');
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'hello' && message.protocol !== PROTOCOL_VERSION) {
        // The server was redeployed with a newer contract than this bundle.
        this.#handlers.onState('closed', 'protocol mismatch — reload');
        this.close();
        return;
      }
      this.#handlers.onMessage(message);
    });

    socket.addEventListener('close', () => {
      // A socket replaced by a newer attempt must not drive state any more.
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#closed) return;
      this.#handlers.onState(
        'closed',
        `retrying in ${Math.round(this.#retryMs / 100) / 10}s`,
      );
      this.#scheduleRetry();
    });

    socket.addEventListener('error', () => socket.close());
  }

  #scheduleRetry(): void {
    const jitter = 0.75 + this.#random() * 0.5;
    const delay = Math.round(this.#retryMs * jitter);
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }
}

/** Maps transport state + feed status onto the single badge in the HUD. */
export function badgeFor(
  state: ConnectionState,
  feed: FeedStatus | null,
): { text: string; tone: string } {
  if (state !== 'open')
    return {
      text: state === 'connecting' ? 'connecting' : 'offline',
      tone: 'offline',
    };
  if (feed === null) return { text: 'connected', tone: 'sync' };
  return { text: feed, tone: feed };
}
