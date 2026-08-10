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

describe('priming', () => {
  it('emits nothing on the first poll', async () => {
    // The opening page is history. Replaying it would kill thirty units for
    // trades that happened before anyone was watching.
    const feed = feedOf([[swap('a', 'buy', 1_000), swap('b', 'sell', 2_000)]]);
    expect(await feed.poll()).toEqual([]);
  });

  it('still learns the size reference while priming', async () => {
    const feed = feedOf([[swap('a', 'buy', 50_000)]]);
    const before = feed.refUsd;
    await feed.poll();
    expect(feed.refUsd).toBeGreaterThan(before);
  });
});

describe('deduplication', () => {
  it('emits only swaps not seen before', async () => {
    const feed = feedOf([
      [swap('a', 'buy', 100)],
      [swap('b', 'sell', 200), swap('a', 'buy', 100)],
    ]);
    await feed.poll();
    const second = await feed.poll();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ side: 'sell', usd: 200 });
  });

  it('never re-emits across many polls of an unchanging page', async () => {
    const page = [swap('a', 'buy', 100), swap('b', 'sell', 200)];
    const feed = feedOf([page, page, page, page]);
    await feed.poll();
    expect(await feed.poll()).toEqual([]);
    expect(await feed.poll()).toEqual([]);
  });
});

describe('ordering', () => {
  it('reverses the newest-first page into chronological order', async () => {
    // The battle consumes events as a timeline; playing them backwards would
    // make the front line lurch the wrong way.
    const feed = feedOf([
      [],
      [
        swap('newest', 'buy', 300, '2026-08-10T19:46:03.000Z'),
        swap('middle', 'buy', 200, '2026-08-10T19:46:02.000Z'),
        swap('oldest', 'buy', 100, '2026-08-10T19:46:01.000Z'),
      ],
    ]);
    await feed.poll();
    const trades = await feed.poll();
    expect(trades.map((t) => t.usd)).toEqual([100, 200, 300]);
  });
});

describe('classification', () => {
  it('measures a whale against the reference from before it landed', async () => {
    // Otherwise a huge trade lifts the EMA it is judged against and demotes
    // itself — the bigger the whale, the more it hides.
    const ordinary = Array.from({ length: 40 }, (_, i) => swap(`o${i}`, 'buy', 1_000));
    const feed = feedOf([ordinary, [swap('whale', 'buy', 500_000)]]);
    await feed.poll();
    const [whale] = await feed.poll();
    expect(whale?.tier).toBe('whale');
  });

  it('leaves an average trade normal', async () => {
    const feed = feedOf([
      Array.from({ length: 40 }, (_, i) => swap(`o${i}`, 'buy', 5_000)),
      [swap('next', 'buy', 5_200)],
    ]);
    await feed.poll();
    const [trade] = await feed.poll();
    expect(trade?.tier).toBe('normal');
  });
});

describe('field mapping', () => {
  it('carries side, size, price and timestamp through', async () => {
    const feed = feedOf([[], [swap('x', 'sell', 1_234.5)]]);
    await feed.poll();
    const [trade] = await feed.poll();
    expect(trade).toMatchObject({
      type: 'trade',
      side: 'sell',
      usd: 1_234.5,
      price: 76.5,
      t: Date.parse('2026-08-10T19:46:00.000Z'),
    });
  });

  it('falls back to receive time when the timestamp is unparseable', async () => {
    const feed = feedOf([[], [swap('x', 'buy', 10, 'not-a-date')]]);
    await feed.poll();
    const [trade] = await feed.poll();
    expect(trade?.t).toBe(5_000);
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
    await expect(feed.poll()).resolves.toEqual([]);
  });

  it('ignores entries with no hash instead of emitting them repeatedly', async () => {
    const feed = feedOf([[], [{ ...swap('', 'buy', 100), txHash: '' }]]);
    await feed.poll();
    expect(await feed.poll()).toEqual([]);
  });
});
