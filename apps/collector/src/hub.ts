import type { Server } from 'node:http';

import {
  BROADCAST_HZ,
  PAIR_LABEL,
  PROTOCOL_VERSION,
  encodePulse,
  type FeedStatus,
  type ServerMessage,
} from '@sol-warzone/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Fans one upstream feed out to every connected browser.
 *
 * Messages are queued and flushed on a fixed tick rather than sent inline, so
 * a burst of trades costs one frame per client instead of one send per event.
 * Serialisation happens once per flush, not once per client.
 */
export class Hub {
  readonly #wss: WebSocketServer;
  readonly #alive = new WeakMap<WebSocket, boolean>();
  #queue: ServerMessage[] = [];
  #status: FeedStatus = 'sync';
  #flushTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;

  /** Supplies the warm-start payload for a client that just connected. */
  #snapshot: () => ServerMessage | null = () => null;

  constructor(server: Server, heartbeatMs: number) {
    this.#wss = new WebSocketServer({ server, path: '/ws' });

    this.#wss.on('connection', (socket) => {
      this.#alive.set(socket, true);
      socket.on('pong', () => this.#alive.set(socket, true));
      socket.on('error', () => socket.terminate());

      this.#send(socket, {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        t: Date.now(),
        pair: PAIR_LABEL,
        status: this.#status,
      });

      const snapshot = this.#snapshot();
      if (snapshot) this.#send(socket, snapshot);
    });

    this.#flushTimer = setInterval(() => this.#flush(), 1000 / BROADCAST_HZ);
    this.#flushTimer.unref();

    // Railway's proxy drops idle connections; pings keep them warm and let us
    // reap sockets whose client vanished without a close frame.
    this.#heartbeatTimer = setInterval(() => {
      for (const socket of this.#wss.clients) {
        if (this.#alive.get(socket) === false) {
          socket.terminate();
          continue;
        }
        this.#alive.set(socket, false);
        socket.ping();
      }
    }, heartbeatMs);
    this.#heartbeatTimer.unref();
  }

  get clientCount(): number {
    return this.#wss.clients.size;
  }

  get status(): FeedStatus {
    return this.#status;
  }

  onSnapshotRequest(fn: () => ServerMessage | null): void {
    this.#snapshot = fn;
  }

  publish(message: ServerMessage): void {
    this.#queue.push(message);
  }

  setStatus(status: FeedStatus, detail?: string): void {
    if (status === this.#status) return;
    this.#status = status;
    this.publish(
      detail === undefined
        ? { type: 'status', t: Date.now(), status }
        : { type: 'status', t: Date.now(), status, detail },
    );
  }

  async close(): Promise<void> {
    clearInterval(this.#flushTimer);
    clearInterval(this.#heartbeatTimer);
    for (const socket of this.#wss.clients) socket.close(1001, 'shutting down');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  #flush(): void {
    if (this.#queue.length === 0 || this.#wss.clients.size === 0) {
      this.#queue.length = 0;
      return;
    }
    const batch = this.#queue;
    this.#queue = [];

    // One encode for all clients, whatever the framing. The pulse goes out as
    // bytes because it runs at 10 Hz and JSON there costs more than the whole
    // trade stream it replaced; everything else stays readable.
    const frames = batch.map((message) =>
      message.type === 'pulse' ? encodePulse(message) : JSON.stringify(message),
    );
    for (const socket of this.#wss.clients) {
      if (socket.readyState !== socket.OPEN) continue;
      for (const frame of frames) socket.send(frame);
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
