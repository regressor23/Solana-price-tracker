import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  PROTOCOL_VERSION,
  PULSE_BYTES,
  decodePulse,
  type ServerMessage,
} from '@sol-warzone/protocol';
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

/** Keeps frames as they arrived, so the two wire formats stay distinguishable. */
async function connectRaw(settle = 250) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: { binary: boolean; data: Buffer }[] = [];
  socket.on('message', (raw: RawData, isBinary: boolean) => {
    const data = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw);
    frames.push({ binary: isBinary, data });
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const drain = async () => {
    await new Promise((resolve) => setTimeout(resolve, settle));
    return frames;
  };
  return { socket, drain };
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

describe('framing', () => {
  it('sends the pulse as bytes and everything else as text', async () => {
    // The junction of the two formats. Getting this wrong would either cost the
    // bandwidth the codec exists to save, or hand the client unparseable JSON.
    const { socket, drain } = await connectRaw();
    hub.publish({
      type: 'pulse',
      t: 1,
      orcAlive: 203,
      nexusAlive: 138,
      frontLine: -0.327,
    });
    hub.publish({ type: 'flow', t: 2, buyUsd: 900, sellUsd: 400, trades: 5 });

    const frames = (await drain()).filter(
      (f) => f.binary || !f.data.includes('"hello"'),
    );
    const binary = frames.filter((f) => f.binary);
    const text = frames.filter((f) => !f.binary);

    expect(binary).toHaveLength(1);
    expect(binary[0]?.data).toHaveLength(PULSE_BYTES);
    expect(text.some((f) => f.data.toString('utf8').includes('"flow"'))).toBe(true);
    socket.close();
  });

  it('sends a pulse the client can actually read back', async () => {
    const { socket, drain } = await connectRaw();
    hub.publish({
      type: 'pulse',
      t: 1,
      orcAlive: 41,
      nexusAlive: 219,
      frontLine: 0.712,
    });

    const frame = (await drain()).find((f) => f.binary);
    // Copy rather than slice the view: Buffer can sit on a SharedArrayBuffer,
    // and the codec takes a plain one.
    const decoded = frame ? decodePulse(Uint8Array.from(frame.data).buffer) : null;

    expect(decoded).toMatchObject({ orcAlive: 41, nexusAlive: 219 });
    expect(decoded?.frontLine).toBeCloseTo(0.712, 4);
    socket.close();
  });

  it('keeps order across the two formats', async () => {
    // The client applies these in sequence; a pulse overtaking the depth it was
    // derived from would show a battle reacting before its cause arrived.
    const { socket, drain } = await connectRaw();
    hub.publish({ type: 'flow', t: 1, buyUsd: 1, sellUsd: 1, trades: 1 });
    hub.publish({ type: 'pulse', t: 2, orcAlive: 1, nexusAlive: 2, frontLine: 0 });
    hub.publish({ type: 'flow', t: 3, buyUsd: 2, sellUsd: 2, trades: 2 });

    const shape = (await drain())
      .filter((f) => f.binary || !f.data.includes('"hello"'))
      .map((f) => (f.binary ? 'binary' : 'text'));

    expect(shape).toEqual(['text', 'binary', 'text']);
    socket.close();
  });
});

describe('pulse coalescing', () => {
  it('sends only the newest pulse when a flush caught several', async () => {
    // The pulse timer and the flush run at the same nominal rate on separate
    // clocks, so batches of two happen. An older count is not history — it was
    // already wrong when the next one arrived.
    const { socket, drain } = await connectRaw();
    for (let orcAlive = 200; orcAlive >= 197; orcAlive--) {
      hub.publish({
        type: 'pulse',
        t: orcAlive,
        orcAlive,
        nexusAlive: 150,
        frontLine: 0,
      });
    }

    const binary = (await drain()).filter((f) => f.binary);
    expect(binary).toHaveLength(1);
    expect(new DataView(Uint8Array.from(binary[0]!.data).buffer).getUint16(1)).toBe(
      197,
    );
    socket.close();
  });

  it('keeps every non-pulse event and their order', async () => {
    // Coalescing must touch pulses and nothing else: a dropped Flow would lose
    // volume that no later message repeats.
    const { socket, drain } = await connectRaw();
    hub.publish({ type: 'flow', t: 1, buyUsd: 1, sellUsd: 1, trades: 1 });
    hub.publish({ type: 'pulse', t: 2, orcAlive: 1, nexusAlive: 1, frontLine: 0 });
    hub.publish({ type: 'flow', t: 3, buyUsd: 2, sellUsd: 2, trades: 2 });
    hub.publish({ type: 'pulse', t: 4, orcAlive: 9, nexusAlive: 9, frontLine: 0 });

    const frames = (await drain()).filter(
      (f) => f.binary || !f.data.includes('"hello"'),
    );
    expect(frames.map((f) => (f.binary ? 'binary' : 'text'))).toEqual([
      'text',
      'text',
      'binary',
    ]);
    socket.close();
  });
});
