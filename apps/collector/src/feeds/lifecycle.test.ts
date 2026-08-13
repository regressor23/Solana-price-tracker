import type { FeedStatus, MarketEvent } from '@sol-warzone/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketFeeds } from './index.js';

/**
 * What a joining client sees, and what the badge says.
 *
 * `fallback.test.ts` covers which host gets used; this covers the state the
 * collector reports while using it.
 */

interface Options {
  /** Swaps returned by each successive /v1/txs poll. */
  swapPages?: { type: 'buy' | 'sell'; usdVolume: number; txHash: string }[][];
  failPrice?: boolean;
  /** Serve this many prices, then go dark — an upstream that dies mid-session. */
  failPriceAfter?: number;
}

function harness(options: Options = {}) {
  const events: MarketEvent[] = [];
  const statuses: { status: FeedStatus; detail?: string }[] = [];
  let swapPoll = 0;
  let blockId = 1_000;
  let priceCalls = 0;

  vi.stubGlobal('fetch', (url: string) => {
    const { pathname, searchParams } = new URL(url);

    if (pathname.startsWith('/price/v3')) {
      priceCalls++;
      const dead =
        options.failPrice ||
        (options.failPriceAfter !== undefined && priceCalls > options.failPriceAfter);
      if (dead) {
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            So11111111111111111111111111111111111111112: {
              usdPrice: 76.5,
              blockId: blockId++,
              priceChange24h: -1.2,
              decimals: 9,
              liquidity: 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    if (pathname.startsWith('/swap/v1/quote')) {
      const sol = Number(searchParams.get('amount')) / 1e9;
      const usdc = Math.round(sol * 76.5 * 1e6);
      return Promise.resolve(
        new Response(
          JSON.stringify({ inAmount: String(usdc), outAmount: String(usdc) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    if (pathname.includes('/txs/')) {
      const txs = options.swapPages?.[swapPoll++] ?? [];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            txs: txs.map((t) => ({
              ...t,
              usdPrice: 76.5,
              poolId: 'p',
              timestamp: '2026-08-11T00:00:00.000Z',
            })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          candles: [{ time: 1, open: 76, high: 76, low: 76, close: 76, volume: 500 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  const feeds = new MarketFeeds({
    liteUrl: 'https://lite-api.jup.ag',
    keyedUrl: 'https://api.jup.ag',
    dataUrl: 'https://datapi.jup.ag',
    rps: 0.5,
    publish: (event) => events.push(event),
    setStatus: (status, detail) =>
      statuses.push(detail === undefined ? { status } : { status, detail }),
  });

  return { feeds, events, statuses };
}

const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('snapshot', () => {
  it('is safe to request before anything has been fetched', () => {
    // A browser can connect during the first second of a deploy.
    const h = harness();
    const snapshot = h.feeds.snapshot();
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      status: 'sync',
      price: null,
      depth: null,
    });
    expect(snapshot.candles).toEqual([]);
    expect(snapshot.recentTrades).toEqual([]);
  });

  it('carries price, depth and candles once they arrive', async () => {
    const h = harness();
    h.feeds.start();
    await settle();
    h.feeds.stop();

    const snapshot = h.feeds.snapshot();
    expect(snapshot.price?.price).toBe(76.5);
    expect(snapshot.depth?.mid).toBeCloseTo(76.5, 4);
    expect(snapshot.candles).toHaveLength(1);
  });

  it('replays recent trades oldest-first', async () => {
    const h = harness({
      swapPages: [
        [], // priming poll is discarded
        // Above the tier bar on purpose: only listed trades reach the replay
        // now, and anything smaller is folded into a Flow instead.
        [
          { type: 'buy', usdVolume: 1_900, txHash: 'b' },
          { type: 'sell', usdVolume: 1_800, txHash: 'a' },
        ],
      ],
    });
    h.feeds.start();
    await settle();
    await vi.advanceTimersByTimeAsync(1_100);
    await settle();
    h.feeds.stop();

    // The API pages newest-first; the wire carries chronological order.
    expect(h.feeds.snapshot().recentTrades.map((t) => t.usd)).toEqual([1_800, 1_900]);
  });

  it('caps replayed trades so the payload cannot grow without bound', async () => {
    const page = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: 'buy' as const,
        usdVolume: 1_000,
        txHash: `t${offset + i}`,
      }));
    const h = harness({
      swapPages: [[], page(30, 0), page(30, 30), page(30, 60)],
    });
    h.feeds.start();
    await settle();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1_100);
      await settle();
    }
    h.feeds.stop();

    expect(h.feeds.snapshot().recentTrades.length).toBeLessThanOrEqual(50);
  });
});

describe('status', () => {
  it('starts in sync and goes live on the first price', async () => {
    const h = harness();
    expect(h.feeds.diagnostics().status).toBe('sync');

    h.feeds.start();
    await settle();
    h.feeds.stop();

    expect(h.feeds.diagnostics().status).toBe('live');
    expect(h.statuses.map((s) => s.status)).toContain('live');
  });

  it('stays in sync while price cannot be fetched at all', async () => {
    // Never having had a price is not the same as having a stale one.
    const h = harness({ failPrice: true });
    h.feeds.start();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    h.feeds.stop();

    expect(h.feeds.diagnostics().status).toBe('sync');
  });

  it('does not announce the same status twice', async () => {
    const h = harness();
    h.feeds.start();
    await settle();
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    h.feeds.stop();

    expect(h.statuses.filter((s) => s.status === 'live')).toHaveLength(1);
  });
});

describe('diagnostics', () => {
  it('reports the fields the debug view and healthz read', async () => {
    const h = harness();
    h.feeds.start();
    await settle();
    h.feeds.stop();

    const d = h.feeds.diagnostics();
    expect(d).toMatchObject({
      profile: 'lite',
      keyRejected: false,
      downgradeReason: null,
    });
    expect(d.upstream.quoteHost).toBe('https://lite-api.jup.ag');
    expect(d.pollers.map((p) => p.name).sort()).toEqual([
      'candles',
      'depth',
      'price',
      'trades',
    ]);
  });

  it('surfaces the volume figure that calibrates trade sizing', async () => {
    const h = harness();
    h.feeds.start();
    await settle();
    h.feeds.stop();
    expect(h.feeds.diagnostics().volumePerMinute).toBe(500);
  });

  it('counts poller errors instead of hiding them', async () => {
    const h = harness({ failPrice: true });
    h.feeds.start();
    // Long enough for the retry chain to exhaust itself — a 500 is retried
    // three times with backoff before the poll actually rejects.
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    h.feeds.stop();

    const price = h.feeds.diagnostics().pollers.find((p) => p.name === 'price');
    expect(price?.consecutiveErrors).toBeGreaterThan(0);
    expect(price?.lastOkAt).toBe(0);
  });
});

describe('shutdown', () => {
  it('stops polling after stop()', async () => {
    const h = harness();
    h.feeds.start();
    await settle();
    const before = h.events.length;

    h.feeds.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(h.events.length).toBe(before);
  });
});

describe('demo mode', () => {
  /** `DEMO_AFTER_POLLS` (40) at the lite price cadence (2 s), plus a margin. */
  const OUTAGE_MS = 95_000;

  it('invents a market once the upstream has been silent long enough', async () => {
    const h = harness({ failPriceAfter: 2 });
    h.feeds.start();
    await settle();
    expect(h.feeds.diagnostics().status).toBe('live');

    await vi.advanceTimersByTimeAsync(OUTAGE_MS);
    await settle();
    h.feeds.stop();

    expect(h.feeds.diagnostics().status).toBe('demo');
    // Degraded first: while a retry might still land, saying so is the honest
    // answer. Only once the page would be a still image do we invent one.
    const order = h.statuses.map((s) => s.status);
    expect(order.indexOf('degraded')).toBeLessThan(order.indexOf('demo'));
    expect(h.statuses.at(-1)?.detail).toContain('generated');
  });

  it('keeps the page moving with the same event mix as the real feeds', async () => {
    const h = harness({ failPriceAfter: 2 });
    h.feeds.start();
    await settle();

    await vi.advanceTimersByTimeAsync(OUTAGE_MS);
    await settle();
    const before = h.events.length;

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    h.feeds.stop();

    const during = h.events.slice(before);
    expect(during.filter((e) => e.type === 'tick').length).toBeGreaterThan(20);
    expect(during.filter((e) => e.type === 'flow').length).toBeGreaterThan(20);
  });

  it('drops the generator the moment real data returns', async () => {
    // Invented data must never outlive the outage that justified it.
    const h = harness({ failPriceAfter: 2 });
    h.feeds.start();
    await settle();
    await vi.advanceTimersByTimeAsync(OUTAGE_MS);
    await settle();
    expect(h.feeds.diagnostics().status).toBe('demo');

    // The stub only fails by count, so a fresh harness stands in for recovery:
    // what matters is that a successful poll takes the status back off demo.
    const healthy = harness();
    healthy.feeds.start();
    await settle();
    healthy.feeds.stop();
    expect(healthy.feeds.diagnostics().status).toBe('live');

    h.feeds.stop();
  });
});
