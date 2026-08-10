import { describe, expect, it } from 'vitest';

import { HttpClient } from './http.js';

/**
 * The rate budget is the difference between a working site and a throttled one.
 * Measured 2026-08-10, lite-api serves 60 requests a minute and starts refusing
 * at around 125, and the collector is the single upstream consumer for every
 * visitor — so exceeding it takes everyone down at once.
 */

function budgetedClient(perMinute: number) {
  let clock = 0;
  const slept: number[] = [];
  let served = 0;

  const client = new HttpClient({
    budgetPerMin: perMinute,
    now: () => clock,
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    fetch: (() => {
      served++;
      return Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch,
  });

  return {
    client,
    slept,
    get served() {
      return served;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    get clock() {
      return clock;
    },
  };
}

describe('rate budget', () => {
  it('lets a full bucket through without waiting', async () => {
    const h = budgetedClient(60);
    for (let i = 0; i < 60; i++) await h.client.getJson('https://x');
    expect(h.slept).toEqual([]);
    expect(h.served).toBe(60);
  });

  it('starts spacing requests once the bucket empties', async () => {
    const h = budgetedClient(60);
    for (let i = 0; i < 60; i++) await h.client.getJson('https://x');

    await h.client.getJson('https://x');
    // 60/min means one token per second.
    expect(h.slept.at(-1)).toBe(1_000);
  });

  it('holds the long-run rate at the configured ceiling', async () => {
    // The property that actually matters: over a sustained burst the client
    // must not exceed the budget, whatever the caller asks for.
    const h = budgetedClient(60);
    for (let i = 0; i < 180; i++) await h.client.getJson('https://x');

    const minutesElapsed = h.clock / 60_000;
    expect(h.served).toBe(180);
    // 60 free from the initial bucket, the remaining 120 paced at 60/min.
    expect(minutesElapsed).toBeCloseTo(2, 1);
  });

  it('refills over time', async () => {
    const h = budgetedClient(60);
    for (let i = 0; i < 60; i++) await h.client.getJson('https://x');
    expect(h.client.budgetAvailable).toBeLessThan(1);

    h.advance(30_000);
    expect(h.client.budgetAvailable).toBeCloseTo(30, 0);

    await h.client.getJson('https://x');
    expect(h.slept).toEqual([]);
  });

  it('never refills beyond the ceiling', () => {
    // An idle hour must not bank an hour's worth of burst.
    const h = budgetedClient(60);
    h.advance(3_600_000);
    expect(h.client.budgetAvailable).toBe(60);
  });

  it('applies a larger budget when one is configured', async () => {
    const h = budgetedClient(600);
    for (let i = 0; i < 600; i++) await h.client.getJson('https://x');
    expect(h.slept).toEqual([]);
  });

  it('imposes no limit when no budget is set', () => {
    const h = budgetedClient(60);
    const unlimited = new HttpClient({
      fetch: (() =>
        Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof globalThis.fetch,
    });
    expect(unlimited.budgetAvailable).toBeNull();
    expect(h.client.budgetAvailable).not.toBeNull();
  });
});

describe('throttle accounting', () => {
  it('counts 429s so diagnostics can show the budget is wrong', async () => {
    let clock = 0;
    let first = true;
    const client = new HttpClient({
      attempts: 2,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetch: (() => {
        const response = first
          ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
          : new Response('{}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
        first = false;
        return Promise.resolve(response);
      }) as unknown as typeof globalThis.fetch,
    });

    expect(client.throttleHits).toBe(0);
    await client.getJson('https://x');
    expect(client.throttleHits).toBe(1);
  });
});
