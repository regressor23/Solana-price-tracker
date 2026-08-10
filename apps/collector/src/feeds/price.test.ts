import { SOL_MINT } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { PriceFeed } from './price.js';
import { HttpClient } from '../http.js';

interface Entry {
  usdPrice: number;
  blockId: number;
  priceChange24h: number;
  decimals?: number;
  liquidity?: number;
}

/** Serves a scripted sequence of price/v3 responses. */
function feedOf(entries: (Entry | null)[]): PriceFeed {
  let index = 0;
  const http = new HttpClient({
    fetch: (() => {
      const entry = entries[Math.min(index++, entries.length - 1)];
      const body = entry === null ? {} : { [SOL_MINT]: entry };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch,
  });
  return new PriceFeed({ http, baseUrl: 'https://x', now: () => 1_000 });
}

describe('PriceFeed', () => {
  it('emits the first observation with a zero tick', async () => {
    const feed = feedOf([{ usdPrice: 76.5, blockId: 100, priceChange24h: -1.46 }]);
    const tick = await feed.poll();
    expect(tick).toMatchObject({ type: 'tick', price: 76.5, tickChange: 0 });
  });

  it('converts the reported percent into a fraction', async () => {
    // price/v3 reports -1.4597 meaning -1.46%; the wire contract is fractions,
    // so a mix-up here would be a 100x error in the HUD.
    const feed = feedOf([{ usdPrice: 76.5, blockId: 1, priceChange24h: -1.4597 }]);
    const tick = await feed.poll();
    expect(tick?.change24h).toBeCloseTo(-0.014597, 8);
  });

  it('computes the tick against the previous price', async () => {
    const feed = feedOf([
      { usdPrice: 100, blockId: 1, priceChange24h: 0 },
      { usdPrice: 101, blockId: 2, priceChange24h: 0 },
    ]);
    await feed.poll();
    const second = await feed.poll();
    expect(second?.tickChange).toBeCloseTo(0.01, 10);
  });

  it('drops a poll that landed in the same slot', async () => {
    // Two polls inside one slot are the same observation, not a flat tick.
    const feed = feedOf([
      { usdPrice: 100, blockId: 7, priceChange24h: 0 },
      { usdPrice: 100, blockId: 7, priceChange24h: 0 },
    ]);
    expect(await feed.poll()).not.toBeNull();
    expect(await feed.poll()).toBeNull();
  });

  it('drops a slot that went backwards', async () => {
    const feed = feedOf([
      { usdPrice: 100, blockId: 10, priceChange24h: 0 },
      { usdPrice: 999, blockId: 9, priceChange24h: 0 },
    ]);
    await feed.poll();
    expect(await feed.poll()).toBeNull();
    expect(feed.last?.price).toBe(100);
  });

  it('keeps the previous price as the tick base across a dropped poll', async () => {
    const feed = feedOf([
      { usdPrice: 100, blockId: 1, priceChange24h: 0 },
      { usdPrice: 100, blockId: 1, priceChange24h: 0 },
      { usdPrice: 102, blockId: 2, priceChange24h: 0 },
    ]);
    await feed.poll();
    await feed.poll();
    const third = await feed.poll();
    expect(third?.tickChange).toBeCloseTo(0.02, 10);
  });

  it.each([
    ['missing mint', null],
    ['zero price', { usdPrice: 0, blockId: 1, priceChange24h: 0 }],
    ['negative price', { usdPrice: -5, blockId: 1, priceChange24h: 0 }],
    ['non-finite price', { usdPrice: Number.NaN, blockId: 1, priceChange24h: 0 }],
  ])('throws on %s rather than publishing it', async (_label, entry) => {
    // A zero price would put the battlefield in an undefined state; better to
    // fail the poll and let the status go degraded.
    await expect(feedOf([entry]).poll()).rejects.toThrow(/no usable price/);
  });
});
