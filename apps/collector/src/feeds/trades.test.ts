import { describe, expect, it } from 'vitest';

import { TradeFeed } from './trades.js';
import { HttpClient } from '../http.js';

interface Swap {
  type: 'buy' | 'sell';
  usdVolume: number;
  usdPrice?: number;
  txHash: string;
  timestamp?: string;
  poolId?: string;
}

/**
 * Sizes either side of the tier bar, which sits at $1,000 while the reference
 * rests on its floor. Only listed tiers arrive as their own event now, so a
 * test about individual trades has to use a size that stays one.
 */
const HEAVY = 2_000;
const SMALL = 200;

const swap = (
  txHash: string,
  type: 'buy' | 'sell',
  usdVolume: number,
  timestamp = '2026-08-10T19:46:00.000Z',
): Swap => ({ txHash, type, usdVolume, usdPrice: 76.5, timestamp, poolId: 'p' });

/** Serves a scripted sequence of pages, newest-first as the API does. */
function feedOf(pages: Swap[][]): TradeFeed {
  let index = 0;
  const http = new HttpClient({
    fetch: (() => {
      const txs = pages[Math.min(index++, pages.length - 1)] ?? [];
      return Promise.resolve(
        new Response(JSON.stringify({ txs }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch,
  });
  return new TradeFeed({ http, dataUrl: 'https://x', now: () => 5_000 });
}

const empty = { trades: [], flow: null };

describe('priming', () => {
  it('emits nothing on the first poll', async () => {
    // The opening page is history. Replaying it would kill thirty units for
    // trades that happened before anyone was watching.
    const feed = feedOf([[swap('a', 'buy', 1_000), swap('b', 'sell', 2_000)]]);
    expect(await feed.poll()).toEqual(empty);
  });

  it('still learns the size reference while priming', async () => {
    const feed = feedOf([[swap('a', 'buy', 50_000)]]);
    const before = feed.refUsd;
    await feed.poll();
    expect(feed.refUsd).toBeGreaterThan(before);
  });
});

describe('aggregation', () => {
  it('sums the small trades instead of listing them', async () => {
    const feed = feedOf([
      [],
      [swap('a', 'buy', SMALL), swap('b', 'sell', 300), swap('c', 'buy', 100)],
    ]);
    await feed.poll();
    const { trades, flow } = await feed.poll();

    expect(trades).toEqual([]);
    expect(flow).toEqual({
      type: 'flow',
      t: 5_000,
      buyUsd: 300,
      sellUsd: 300,
      trades: 3,
    });
  });

  it('splits a mixed batch, never counting a trade twice', async () => {
    // Flow and the individual trades describe disjoint sets. A client wanting
    // the true total adds them, so an overlap here would inflate every figure
    // downstream.
    const feed = feedOf([[], [swap('big', 'buy', HEAVY), swap('small', 'buy', SMALL)]]);
    await feed.poll();
    const { trades, flow } = await feed.poll();

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ usd: HEAVY, tier: 'heavy' });
    expect(flow).toMatchObject({ buyUsd: SMALL, trades: 1 });
  });

  it('sends no frame at all on a quiet second', async () => {
    // A zeroed Flow ten times a minute would be pure overhead.
    const feed = feedOf([[], []]);
    await feed.poll();
    expect((await feed.poll()).flow).toBeNull();
  });

  it('keeps a batch of only large trades out of the aggregate', async () => {
    const feed = feedOf([[], [swap('a', 'buy', HEAVY), swap('b', 'sell', HEAVY)]]);
    await feed.poll();
    const { trades, flow } = await feed.poll();
    expect(trades).toHaveLength(2);
    expect(flow).toBeNull();
  });
});

describe('deduplication', () => {
  it('emits only swaps not seen before', async () => {
    const feed = feedOf([
      [swap('a', 'buy', HEAVY)],
      [swap('b', 'sell', HEAVY), swap('a', 'buy', HEAVY)],
    ]);
    await feed.poll();
    const { trades } = await feed.poll();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: 'sell', usd: HEAVY });
  });

  it('never re-emits across many polls of an unchanging page', async () => {
    const page = [swap('a', 'buy', HEAVY), swap('b', 'sell', SMALL)];
    const feed = feedOf([page, page, page, page]);
    await feed.poll();
    expect(await feed.poll()).toEqual(empty);
    expect(await feed.poll()).toEqual(empty);
  });
});

describe('ordering', () => {
  it('reverses the newest-first page into chronological order', async () => {
    // The battle consumes events as a timeline; playing them backwards would
    // make the front line lurch the wrong way.
    const feed = feedOf([
      [],
      [
        swap('newest', 'buy', 3_000, '2026-08-10T19:46:03.000Z'),
        swap('middle', 'buy', 2_000, '2026-08-10T19:46:02.000Z'),
        swap('oldest', 'buy', 1_000, '2026-08-10T19:46:01.000Z'),
      ],
    ]);
    await feed.poll();
    const { trades } = await feed.poll();
    expect(trades.map((t) => t.usd)).toEqual([1_000, 2_000, 3_000]);
  });
});

describe('classification', () => {
  it('measures a whale against the reference from before it landed', async () => {
    // Otherwise a huge trade lifts the EMA it is judged against and demotes
    // itself — the bigger the whale, the more it hides.
    const ordinary = Array.from({ length: 40 }, (_, i) => swap(`o${i}`, 'buy', 1_000));
    const feed = feedOf([ordinary, [swap('whale', 'buy', 500_000)]]);
    await feed.poll();
    const { trades } = await feed.poll();
    expect(trades[0]?.tier).toBe('whale');
  });

  it('folds an average trade into the aggregate rather than listing it', async () => {
    const feed = feedOf([
      Array.from({ length: 40 }, (_, i) => swap(`o${i}`, 'buy', 5_000)),
      [swap('next', 'buy', 5_200)],
    ]);
    await feed.poll();
    const { trades, flow } = await feed.poll();

    // A busy market raises the bar: $5,200 is ordinary here, so it is summed.
    expect(trades).toEqual([]);
    expect(flow).toMatchObject({ buyUsd: 5_200, trades: 1 });
  });
});

describe('field mapping', () => {
  it('carries side, size, price and timestamp through', async () => {
    const feed = feedOf([[], [swap('x', 'sell', 1_234.5)]]);
    await feed.poll();
    const { trades } = await feed.poll();
    expect(trades[0]).toMatchObject({
      type: 'trade',
      side: 'sell',
      usd: 1_234.5,
      price: 76.5,
      t: Date.parse('2026-08-10T19:46:00.000Z'),
    });
  });

  it('falls back to receive time when the timestamp is unparseable', async () => {
    const feed = feedOf([[], [swap('x', 'buy', HEAVY, 'not-a-date')]]);
    await feed.poll();
    const { trades } = await feed.poll();
    expect(trades[0]?.t).toBe(5_000);
  });

  it('requests the dust filter and the page size', async () => {
    const urls: string[] = [];
    const http = new HttpClient({
      fetch: ((url: string) => {
        urls.push(url);
        return Promise.resolve(
          new Response('{"txs":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
    });
    await new TradeFeed({ http, dataUrl: 'https://x', minUsdVolume: 750 }).poll();
    expect(urls[0]).toContain('minUsdVolume=750');
    expect(urls[0]).toContain('limit=30');
  });
});

describe('resilience', () => {
  it('treats a missing txs array as an empty page', async () => {
    const http = new HttpClient({
      fetch: (() =>
        Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof globalThis.fetch,
    });
    const feed = new TradeFeed({ http, dataUrl: 'https://x' });
    await expect(feed.poll()).resolves.toEqual(empty);
  });

  it('ignores entries with no hash instead of emitting them repeatedly', async () => {
    const feed = feedOf([[], [{ ...swap('', 'buy', HEAVY), txHash: '' }]]);
    await feed.poll();
    expect(await feed.poll()).toEqual(empty);
  });
});
