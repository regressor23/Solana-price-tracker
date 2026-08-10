import { describe, expect, it } from 'vitest';

import { HttpClient } from './http.js';

/**
 * The rate budget is the difference between a working site and a throttled one.
 * Measured 2026-08-10, lite-api serves 60 requests a minute and starts refusing
 * at around 125, and the collector is the single upstream consumer for every
 * visitor — so exceeding it takes everyone down at once.
 */

function budgetedClient(perMinute: number, startRatePerMin = perMinute) {
  let clock = 0;
  const slept: number[] = [];
  let served = 0;

  const client = new HttpClient({
    budgetPerMin: perMinute,
    startRatePerMin,
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

describe('adaptive rate', () => {
  it('opens well below a high ceiling instead of trusting it', async () => {
    // Booting at the ceiling is what produced a burst of 429s on every deploy:
    // the bucket spent its whole allowance before it had any evidence the
    // upstream would accept that rate.
    const h = budgetedClient(600, 55);
    expect(h.client.budgetPerMin).toBe(55);

    // The opening allowance is the start rate, not the ceiling: request 56 has
    // to wait, where booting at 600 would have let 600 straight through.
    for (let i = 0; i < 55; i++) await h.client.getJson('https://x');
    expect(h.slept).toEqual([]);
    await h.client.getJson('https://x');
    expect(h.slept.at(-1)).toBeGreaterThan(0);
  });

  it('halves the rate on a 429', async () => {
    let clock = 0;
    let throttle = true;
    const client = new HttpClient({
      budgetPerMin: 120,
      startRatePerMin: 120,
      attempts: 2,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetch: (() => {
        const response = throttle
          ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
          : new Response('{}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
        throttle = false;
        return Promise.resolve(response);
      }) as unknown as typeof globalThis.fetch,
    });

    await client.getJson('https://x');
    expect(client.budgetPerMin).toBe(60);
  });

  it('never paces below the floor however many 429s arrive', async () => {
    let clock = 0;
    const client = new HttpClient({
      budgetPerMin: 600,
      startRatePerMin: 600,
      attempts: 40,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetch: (() =>
        Promise.resolve(
          new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
        )) as unknown as typeof globalThis.fetch,
    });

    await client.getJson('https://x').catch(() => undefined);
    // A stalled feed is worse than a slow one.
    expect(client.budgetPerMin).toBeGreaterThanOrEqual(12);
  });

  it('climbs back after a run of clean requests', async () => {
    const h = budgetedClient(600, 24);
    // Enough successes to trip the recovery streak more than once.
    for (let i = 0; i < 40; i++) await h.client.getJson('https://x');
    expect(h.client.budgetPerMin).toBeGreaterThan(24);
  });

  it('never climbs past the ceiling', async () => {
    const h = budgetedClient(60, 60);
    for (let i = 0; i < 200; i++) await h.client.getJson('https://x');
    expect(h.client.budgetPerMin).toBe(60);
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
