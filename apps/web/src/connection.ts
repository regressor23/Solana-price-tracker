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

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;

/** Same-origin in production; the Vite dev server proxies /ws to the collector. */
function socketUrl(): string {
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
  #socket: WebSocket | undefined;
  #retryMs = MIN_RETRY_MS;
  #retryTimer: number | undefined;
  #closed = false;

  constructor(private readonly handlers: ConnectionHandlers) {}

  open(): void {
    this.#closed = false;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#socket?.close();
    this.#socket = undefined;
  }

  #connect(): void {
    this.handlers.onState('connecting');
    const socket = new WebSocket(socketUrl());
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#retryMs = MIN_RETRY_MS;
      this.handlers.onState('open');
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
        this.handlers.onState('closed', 'protocol mismatch — reload');
        this.close();
        return;
      }
      this.handlers.onMessage(message);
    });

    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#closed) return;
      this.handlers.onState(
        'closed',
        `retrying in ${Math.round(this.#retryMs / 100) / 10}s`,
      );
      this.#scheduleRetry();
    });

    socket.addEventListener('error', () => socket.close());
  }

  #scheduleRetry(): void {
    const jitter = 0.75 + Math.random() * 0.5;
    const delay = Math.round(this.#retryMs * jitter);
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    this.#retryTimer = window.setTimeout(() => this.#connect(), delay);
  }
}

/** Maps transport state + feed status onto the single badge in the HUD. */
export function badgeFor(
  state: ConnectionState,
  feed: FeedStatus | null,
): { text: string; tone: string } {
  if (state !== 'open')
    return { text: state === 'connecting' ? 'connecting' : 'offline', tone: 'offline' };
  if (feed === null) return { text: 'connected', tone: 'sync' };
  return { text: feed, tone: feed };
}
