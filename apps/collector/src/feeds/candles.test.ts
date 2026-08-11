import type { Candle } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { CandleFeed } from './candles.js';
import { HttpClient } from '../http.js';

const candle = (time: number, close: number, volume: number): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

/** Records the URLs asked for and replies with a fixed candle list. */
function feedOf(candles: Candle[], options: { minutes?: number; now?: number } = {}) {
  const urls: string[] = [];
  const http = new HttpClient({
    fetch: ((url: string) => {
      urls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ candles }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch,
  });
  const feed = new CandleFeed({
    http,
    dataUrl: 'https://datapi.jup.ag',
    now: () => options.now ?? 1_786_400_000_000,
    ...(options.minutes === undefined ? {} : { minutes: options.minutes }),
  });
  return { feed, urls };
}

describe('request shape', () => {
  it('sends millisecond bounds', async () => {
    // The endpoint takes ms and returns seconds. Passing seconds is not an
    // error — it quietly returns an empty list, which looks like a dead market
    // rather than a bug. This assertion is the guard against that regression.
    const now = 1_786_400_000_000;
    const { feed, urls } = feedOf([candle(1, 76, 1)], { now, minutes: 60 });
    await feed.poll();

    const params = new URL(urls[0]!).searchParams;
    expect(params.get('to')).toBe(String(now));
    expect(params.get('from')).toBe(String(now - 60 * 60_000));
    // A seconds-based bound would be ten digits; ms is thirteen.
    expect(params.get('to')).toHaveLength(13);
  });

  it('asks for one-minute buckets over the requested window', async () => {
    const { feed, urls } = feedOf([candle(1, 76, 1)], { minutes: 30 });
    await feed.poll();

    const params = new URL(urls[0]!).searchParams;
    expect(params.get('interval')).toBe('1_MINUTE');
    expect(params.get('candles')).toBe('30');
    const span = Number(params.get('to')) - Number(params.get('from'));
    expect(span).toBe(30 * 60_000);
  });
});

describe('results', () => {
  it('exposes the candles it fetched', async () => {
    const { feed } = feedOf([candle(1, 76, 100), candle(2, 77, 200)]);
    const candles = await feed.poll();
    expect(candles).toHaveLength(2);
    expect(feed.last).toEqual(candles);
  });

  it('starts empty before the first poll', () => {
    const { feed } = feedOf([]);
    expect(feed.last).toEqual([]);
    expect(feed.volumePerMinute).toBeNull();
  });

  it('averages volume across the window', async () => {
    // Drives trade-size calibration, so an off-by-one in the divisor would
    // quietly skew every unit count later.
    const { feed } = feedOf([
      candle(1, 76, 100),
      candle(2, 76, 200),
      candle(3, 76, 300),
    ]);
    await feed.poll();
    expect(feed.volumePerMinute).toBe(200);
  });
});

describe('failure', () => {
  it('throws on an empty candle list rather than reporting a dead market', async () => {
    // Empty is exactly what the wrong timestamp unit produces, so it has to be
    // loud. Silently caching [] would leave the HUD blank with no explanation.
    const { feed } = feedOf([]);
    await expect(feed.poll()).rejects.toThrow(/no candles/);
  });

  it('mentions the millisecond trap in the error', async () => {
    const { feed } = feedOf([]);
    await expect(feed.poll()).rejects.toThrow(/ms/);
  });

  it('treats a missing candles field as empty', async () => {
    const http = new HttpClient({
      fetch: (() =>
        Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof globalThis.fetch,
    });
    const feed = new CandleFeed({ http, dataUrl: 'https://x' });
    await expect(feed.poll()).rejects.toThrow(/no candles/);
  });

  it('keeps the previous window when a later poll fails', async () => {
    // A joining client should still get warm history through a blip.
    let good = true;
    const http = new HttpClient({
      attempts: 1,
      fetch: (() =>
        Promise.resolve(
          good
            ? new Response(JSON.stringify({ candles: [candle(1, 76, 5)] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response('nope', { status: 500 }),
        )) as unknown as typeof globalThis.fetch,
    });
    const feed = new CandleFeed({ http, dataUrl: 'https://x' });

    await feed.poll();
    good = false;
    await expect(feed.poll()).rejects.toThrow();
    expect(feed.last).toHaveLength(1);
  });
});
