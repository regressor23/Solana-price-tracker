import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { PROTOCOL_VERSION, type ServerMessage } from '@sol-warzone/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { type RawData } from 'ws';

import { Hub } from './hub.js';

/** `ws` hands back a Buffer, an ArrayBuffer or a list of Buffers. */
const decode = (raw: RawData): string => {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
};

/**
 * These run against a real http server and real sockets on an ephemeral port.
 * The handshake, the upgrade path and the batching timer are exactly the parts
 * a mocked socket would not exercise.
 */

let server: http.Server;
let hub: Hub;
let port: number;

const HEARTBEAT_MS = 50_000; // long enough never to fire mid-test

beforeEach(async () => {
  server = http.createServer((_req, res) => res.end('ok'));
  hub = new Hub(server, HEARTBEAT_MS);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Connects and collects every message until `settle` ms of quiet. */
async function connect(settle = 250): Promise<{
  socket: WebSocket;
  messages: ServerMessage[];
  drain: () => Promise<ServerMessage[]>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: ServerMessage[] = [];
  socket.on('message', (raw: RawData) =>
    messages.push(JSON.parse(decode(raw)) as ServerMessage),
  );
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const drain = async () => {
    await new Promise((resolve) => setTimeout(resolve, settle));
    return messages;
  };
  return { socket, messages, drain };
}

describe('handshake', () => {
  it('greets a new client with the protocol version and pair', async () => {
    const { socket, drain } = await connect();
    const [hello] = await drain();
    expect(hello).toMatchObject({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      pair: 'SOL/USDC',
      status: 'sync',
    });
    socket.close();
  });

  it('rejects a connection on any path other than /ws', async () => {
    const stray = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    const outcome = await new Promise<string>((resolve) => {
      stray.once('open', () => resolve('opened'));
      stray.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  });

  it('replays a snapshot after hello when one is available', async () => {
    // A client joining mid-battle must not wait for the next event to render.
    const snapshot: ServerMessage = {
      type: 'snapshot',
      t: 1,
      status: 'live',
      price: null,
      depth: null,
      candles: [],
      recentTrades: [],
    };
    hub.onSnapshotRequest(() => snapshot);

    const { socket, drain } = await connect();
    const received = await drain();
    expect(received.map((m) => m.type)).toEqual(['hello', 'snapshot']);
    socket.close();
  });

  it('sends only hello when there is nothing to replay yet', async () => {
    const { socket, drain } = await connect();
    expect((await drain()).map((m) => m.type)).toEqual(['hello']);
    socket.close();
  });
});

describe('broadcast', () => {
  it('delivers queued events to every connected client', async () => {
    const a = await connect();
    const b = await connect();

    hub.publish({
      type: 'tick',
      t: 1,
      blockId: 1,
      price: 76.5,
      tickChange: 0,
      change24h: 0,
    });
    hub.publish({
      type: 'tick',
      t: 2,
      blockId: 2,
      price: 76.6,
      tickChange: 0.001,
      change24h: 0,
    });

    const [seenA, seenB] = await Promise.all([a.drain(), b.drain()]);
    expect(seenA.filter((m) => m.type === 'tick')).toHaveLength(2);
    expect(seenB.filter((m) => m.type === 'tick')).toHaveLength(2);

    a.socket.close();
    b.socket.close();
  });

  it('preserves event order across a flush', async () => {
    const { socket, drain } = await connect();
    for (let blockId = 1; blockId <= 5; blockId++) {
      hub.publish({
        type: 'tick',
        t: blockId,
        blockId,
        price: 76 + blockId,
        tickChange: 0,
        change24h: 0,
      });
    }
    const ticks = (await drain()).filter((m) => m.type === 'tick');
    expect(ticks.map((m) => m.blockId)).toEqual([1, 2, 3, 4, 5]);
    socket.close();
  });

  it('drops events published while nobody is listening', async () => {
    // The queue must not grow without bound on an idle deployment, and a client
    // that connects later gets the snapshot instead of a backlog.
    hub.publish({
      type: 'tick',
      t: 1,
      blockId: 1,
      price: 76,
      tickChange: 0,
      change24h: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const { socket, drain } = await connect();
    expect((await drain()).map((m) => m.type)).toEqual(['hello']);
    socket.close();
  });
});

describe('status', () => {
  it('broadcasts a change and remembers it for later clients', async () => {
    const early = await connect();
    hub.setStatus('live');
    const seen = await early.drain();
    expect(seen.some((m) => m.type === 'status' && m.status === 'live')).toBe(true);

    const late = await connect();
    const [hello] = await late.drain();
    expect(hello).toMatchObject({ type: 'hello', status: 'live' });

    early.socket.close();
    late.socket.close();
  });

  it('ignores a repeat of the current status', async () => {
    const { socket, drain } = await connect();
    hub.setStatus('live');
    hub.setStatus('live');
    hub.setStatus('live');
    const changes = (await drain()).filter((m) => m.type === 'status');
    expect(changes).toHaveLength(1);
    socket.close();
  });

  it('carries an optional detail through', async () => {
    const { socket, drain } = await connect();
    hub.setStatus('degraded', 'jupiter rate limited');
    const change = (await drain()).find((m) => m.type === 'status');
    expect(change).toMatchObject({
      status: 'degraded',
      detail: 'jupiter rate limited',
    });
    socket.close();
  });
});

describe('lifecycle', () => {
  it('tracks the client count as sockets come and go', async () => {
    expect(hub.clientCount).toBe(0);

    const a = await connect();
    expect(hub.clientCount).toBe(1);

    const b = await connect();
    expect(hub.clientCount).toBe(2);

    a.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(hub.clientCount).toBe(1);

    b.socket.close();
  });

  it('closes every socket on shutdown', async () => {
    const { socket } = await connect();
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    await hub.close();
    // 1001 "going away" tells the client this was a restart, not an error.
    await expect(closed).resolves.toBe(1001);
  });
});
