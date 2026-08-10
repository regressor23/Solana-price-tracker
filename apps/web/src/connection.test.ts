import { PROTOCOL_VERSION, type ServerMessage } from '@sol-warzone/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Connection,
  MAX_RETRY_MS,
  MIN_RETRY_MS,
  badgeFor,
  type ConnectionState,
} from './connection.js';

/** A WebSocket stand-in the test drives by hand. No DOM required. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closeCalls++;
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** What the browser does on close(): the close event follows. */
  closeFromServer(): void {
    this.emit('close');
  }
}

const asWebSocket = (socket: FakeSocket) => socket as unknown as WebSocket;

interface Harness {
  connection: Connection;
  states: { state: ConnectionState; detail?: string }[];
  messages: ServerMessage[];
}

function harness(random = () => 0.5): Harness {
  const states: Harness['states'] = [];
  const messages: ServerMessage[] = [];
  const connection = new Connection(
    {
      onMessage: (message) => messages.push(message),
      onState: (state, detail) =>
        states.push(detail === undefined ? { state } : { state, detail }),
    },
    {
      createSocket: (url) => asWebSocket(new FakeSocket(url)),
      url: () => 'ws://test/ws',
      random,
    },
  );
  return { connection, states, messages };
}

const latest = () => FakeSocket.instances.at(-1)!;

const hello = (protocol = PROTOCOL_VERSION) =>
  JSON.stringify({
    type: 'hello',
    protocol,
    t: 0,
    pair: 'SOL/USDC',
    status: 'sync',
  });

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connect', () => {
  it('reports connecting before the socket opens, then open', () => {
    const { connection, states } = harness();
    connection.open();
    expect(states).toEqual([{ state: 'connecting' }]);

    latest().emit('open');
    expect(states.at(-1)).toEqual({ state: 'open' });
  });

  it('opens the url from the injected resolver', () => {
    const { connection } = harness();
    connection.open();
    expect(latest().url).toBe('ws://test/ws');
  });
});

describe('messages', () => {
  it('forwards a parsed message', () => {
    const { connection, messages } = harness();
    connection.open();
    latest().emit('message', { data: hello() });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'hello' });
  });

  it('ignores malformed json rather than throwing', () => {
    const { connection, messages } = harness();
    connection.open();
    expect(() => latest().emit('message', { data: '{not json' })).not.toThrow();
    expect(messages).toHaveLength(0);
  });

  it('ignores non-string frames', () => {
    // Binary framing arrives in phase 2; until then a binary frame is a bug,
    // not something to hand to JSON.parse.
    const { connection, messages } = harness();
    connection.open();
    latest().emit('message', { data: new ArrayBuffer(8) });
    expect(messages).toHaveLength(0);
  });

  it('stops for good on a protocol mismatch', () => {
    // The bundle is older than the server. Retrying cannot fix that, so the
    // connection must stay down and tell the user to reload.
    const { connection, states, messages } = harness();
    connection.open();
    const socket = latest();
    socket.emit('message', { data: hello(PROTOCOL_VERSION + 1) });

    expect(messages).toHaveLength(0);
    expect(states.at(-1)).toEqual({
      state: 'closed',
      detail: 'protocol mismatch — reload',
    });
    expect(socket.closeCalls).toBe(1);

    socket.closeFromServer();
    vi.advanceTimersByTime(MAX_RETRY_MS * 4);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('reconnect', () => {
  it('opens a new socket after the backoff elapses', () => {
    const { connection } = harness();
    connection.open();
    latest().emit('open');
    latest().closeFromServer();

    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(MIN_RETRY_MS);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('does not reconnect before the delay is up', () => {
    const { connection } = harness();
    connection.open();
    latest().closeFromServer();

    vi.advanceTimersByTime(MIN_RETRY_MS - 50);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('doubles the delay on each successive failure', () => {
    // random() === 0.5 makes the jitter factor exactly 1.0, so the delays are
    // the raw backoff values.
    const { connection } = harness(() => 0.5);
    connection.open();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const expected = connection.retryMs;
      latest().closeFromServer();
      vi.advanceTimersByTime(expected - 1);
      expect(FakeSocket.instances).toHaveLength(attempt + 1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(attempt + 2);
      delays.push(expected);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  it('caps the delay so a long outage still retries regularly', () => {
    const { connection } = harness();
    connection.open();
    for (let attempt = 0; attempt < 12; attempt++) {
      latest().closeFromServer();
      vi.advanceTimersByTime(MAX_RETRY_MS);
    }
    expect(connection.retryMs).toBe(MAX_RETRY_MS);
  });

  it('jitters within ±25% so clients do not return in lockstep', () => {
    const earliest = harness(() => 0); // factor 0.75
    earliest.connection.open();
    earliest.connection.close();

    const spread = [0, 1].map((r) => {
      FakeSocket.instances = [];
      const { connection } = harness(() => r);
      connection.open();
      latest().closeFromServer();
      // Walk forward until the retry fires to discover the actual delay.
      let elapsed = 0;
      while (FakeSocket.instances.length === 1 && elapsed <= MIN_RETRY_MS * 2) {
        vi.advanceTimersByTime(1);
        elapsed++;
      }
      return elapsed;
    });

    expect(spread[0]).toBe(Math.round(MIN_RETRY_MS * 0.75));
    expect(spread[1]).toBe(Math.round(MIN_RETRY_MS * 1.25));
  });

  it('resets the backoff once a connection succeeds', () => {
    const { connection } = harness();
    connection.open();
    latest().closeFromServer();
    vi.advanceTimersByTime(MIN_RETRY_MS);
    latest().closeFromServer();
    vi.advanceTimersByTime(MIN_RETRY_MS * 2);
    expect(connection.retryMs).toBeGreaterThan(MIN_RETRY_MS);

    latest().emit('open');
    expect(connection.retryMs).toBe(MIN_RETRY_MS);
  });

  it('closes the socket on error so the close path drives the retry', () => {
    const { connection } = harness();
    connection.open();
    const socket = latest();
    socket.emit('error');
    expect(socket.closeCalls).toBe(1);
  });

  it('ignores a close from a socket that was already superseded', () => {
    // A stale socket firing late must not schedule a second retry chain.
    const { connection } = harness();
    connection.open();
    const stale = latest();
    stale.closeFromServer();
    vi.advanceTimersByTime(MIN_RETRY_MS);
    expect(FakeSocket.instances).toHaveLength(2);

    stale.closeFromServer();
    vi.advanceTimersByTime(MAX_RETRY_MS * 2);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('close', () => {
  it('cancels a pending retry', () => {
    const { connection } = harness();
    connection.open();
    latest().closeFromServer();
    connection.close();

    vi.advanceTimersByTime(MAX_RETRY_MS * 4);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('can be reopened after being closed', () => {
    const { connection } = harness();
    connection.open();
    connection.close();
    connection.open();
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('badgeFor', () => {
  it.each([
    ['connecting' as const, null, 'connecting', 'offline'],
    ['closed' as const, null, 'offline', 'offline'],
    ['open' as const, null, 'connected', 'sync'],
    ['open' as const, 'live' as const, 'live', 'live'],
    ['open' as const, 'demo' as const, 'demo', 'demo'],
    ['open' as const, 'degraded' as const, 'degraded', 'degraded'],
  ])('renders %s/%s as %s', (state, feed, text, tone) => {
    expect(badgeFor(state, feed)).toEqual({ text, tone });
  });

  it('shows offline regardless of the last known feed status', () => {
    // A stale "live" badge on a dead socket is worse than no badge.
    expect(badgeFor('closed', 'live')).toEqual({ text: 'offline', tone: 'offline' });
  });
});
