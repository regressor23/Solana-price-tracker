import { describe, expect, it, vi } from 'vitest';

import { Poller } from './poller.js';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('overlap', () => {
  it('skips a tick while the previous one is still in flight', async () => {
    // A slow upstream must not cause requests to stack up behind the timer —
    // that floods the very service that is already struggling.
    const gate = deferred();
    let started = 0;
    const poller = new Poller({
      name: 'slow',
      intervalMs: 1,
      tick: async () => {
        started++;
        await gate.promise;
      },
    });

    const first = poller.runOnce();
    await poller.runOnce();
    await poller.runOnce();

    expect(started).toBe(1);
    expect(poller.skipped).toBe(2);

    gate.resolve();
    await first;
  });

  it('accepts the next tick once the previous one finishes', async () => {
    let started = 0;
    const poller = new Poller({
      name: 'quick',
      intervalMs: 1,
      tick: () => {
        started++;
        return Promise.resolve();
      },
    });
    await poller.runOnce();
    await poller.runOnce();
    expect(started).toBe(2);
    expect(poller.skipped).toBe(0);
  });
});

describe('errors', () => {
  it('reports a rejection without throwing out of the timer', async () => {
    const seen: { name: string; error: unknown }[] = [];
    const poller = new Poller({
      name: 'failing',
      intervalMs: 1,
      tick: () => Promise.reject(new Error('upstream down')),
      onError: (name, error) => seen.push({ name, error }),
    });

    await expect(poller.runOnce()).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('failing');
  });

  it('counts consecutive errors and clears them on success', async () => {
    let shouldFail = true;
    const poller = new Poller({
      name: 'flaky',
      intervalMs: 1,
      tick: () => (shouldFail ? Promise.reject(new Error('no')) : Promise.resolve()),
      onError: () => undefined,
    });

    await poller.runOnce();
    await poller.runOnce();
    expect(poller.consecutiveErrors).toBe(2);
    expect(poller.lastOkAt).toBe(0);

    shouldFail = false;
    await poller.runOnce();
    expect(poller.consecutiveErrors).toBe(0);
    expect(poller.lastOkAt).toBeGreaterThan(0);
  });

  it('releases the running flag after a failure', async () => {
    // A rejection that left the poller marked busy would wedge it forever.
    let started = 0;
    const poller = new Poller({
      name: 'failing',
      intervalMs: 1,
      tick: () => {
        started++;
        return Promise.reject(new Error('no'));
      },
      onError: () => undefined,
    });
    await poller.runOnce();
    await poller.runOnce();
    expect(started).toBe(2);
  });
});

describe('scheduling', () => {
  it('runs immediately on start, then on the interval', async () => {
    vi.useFakeTimers();
    try {
      let started = 0;
      const poller = new Poller({
        name: 'scheduled',
        intervalMs: 1_000,
        tick: () => {
          started++;
          return Promise.resolve();
        },
      });

      poller.start();
      expect(started).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(started).toBe(2);

      poller.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(started).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second start', async () => {
    vi.useFakeTimers();
    try {
      let started = 0;
      const poller = new Poller({
        name: 'once',
        intervalMs: 1_000,
        tick: () => {
          started++;
          return Promise.resolve();
        },
      });
      poller.start();
      poller.start();
      await vi.advanceTimersByTimeAsync(1_000);
      // Two starts must not mean two timers and a doubled request rate.
      expect(started).toBe(2);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates stop before start', () => {
    const poller = new Poller({
      name: 'idle',
      intervalMs: 1,
      tick: () => Promise.resolve(),
    });
    expect(() => poller.stop()).not.toThrow();
  });
});
