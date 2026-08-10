import { WALL_IMPACT_PCT, type DepthRung } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { DepthFeed, wallUsd } from './depth.js';
import { HttpClient } from '../http.js';

const rung = (sizeSol: number, usd: number, impactPct: number): DepthRung => ({
  sizeSol,
  usd,
  avgPrice: usd / sizeSol,
  impactPct,
});

describe('wallUsd', () => {
  it('interpolates between the rungs that straddle the threshold', () => {
    // 1% sits exactly halfway between 0.5% and 1.5%, so the answer is the
    // midpoint of the two notionals.
    const walls = wallUsd([rung(100, 1_000, 0.005), rung(300, 3_000, 0.015)]);
    expect(walls).toBeCloseTo(2_000, 6);
  });

  it('reads the same on either side — impact sign must not matter', () => {
    const asks = wallUsd([rung(100, 1_000, 0.005), rung(300, 3_000, 0.015)]);
    const bids = wallUsd([rung(100, 1_000, -0.005), rung(300, 3_000, -0.015)]);
    expect(bids).toBeCloseTo(asks, 6);
  });

  it('reports the deepest measured rung when the ladder never reaches 1%', () => {
    // Extrapolating here would invent liquidity nobody quoted.
    expect(wallUsd([rung(100, 1_000, 0.001), rung(300, 3_000, 0.004)])).toBe(3_000);
  });

  it('scales down when even the first rung is already past the threshold', () => {
    // A 2% impact on the smallest size means roughly half of it fits in 1%.
    expect(wallUsd([rung(100, 1_000, 0.02)])).toBeCloseTo(500, 6);
  });

  it('returns zero for an empty ladder', () => {
    expect(wallUsd([])).toBe(0);
  });

  it('lands on the rung value when it sits exactly at the threshold', () => {
    expect(wallUsd([rung(100, 1_000, WALL_IMPACT_PCT)])).toBeCloseTo(1_000, 6);
  });

  it('does not divide by zero when two rungs report identical impact', () => {
    const result = wallUsd([rung(100, 1_000, 0.02), rung(300, 3_000, 0.02)]);
    expect(Number.isFinite(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** Serves quotes from a price-impact model instead of the network. */
function quotingClient(impactPerSol = 1e-7, mid = 80): HttpClient {
  const priceFor = (size: number) => mid * (1 + impactPerSol * size);
  return new HttpClient({
    fetch: ((url: string) => {
      const params = new URL(url).searchParams;
      const exactOut = params.get('swapMode') === 'ExactOut';
      const sol = Number(params.get('amount')) / 1e9;
      // Buying pays above mid, selling receives below it.
      const usdc = exactOut ? sol * priceFor(sol) : sol * (2 * mid - priceFor(sol));
      const body = exactOut
        ? {
            inAmount: String(Math.round(usdc * 1e6)),
            outAmount: '0',
            swapMode: 'ExactOut',
          }
        : {
            inAmount: '0',
            outAmount: String(Math.round(usdc * 1e6)),
            swapMode: 'ExactIn',
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch,
  });
}

describe('DepthFeed', () => {
  it('quotes a fixed SOL amount on both sides so rungs are comparable', async () => {
    const requested: { amount: string; mode: string }[] = [];
    const http = new HttpClient({
      fetch: ((url: string) => {
        const params = new URL(url).searchParams;
        requested.push({
          amount: params.get('amount') ?? '',
          mode: params.get('swapMode') ?? 'ExactIn',
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({ inAmount: '8000000000', outAmount: '8000000000' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await new DepthFeed({ http, baseUrl: 'https://x', ladder: [10, 100] }).poll();

    // Same lamport amount on both sides — the ask leg uses ExactOut precisely
    // so it can fix SOL rather than USDC.
    const amounts = new Set(requested.map((r) => r.amount));
    expect([...amounts].sort()).toEqual(['10000000000', '100000000000']);
    expect(requested.filter((r) => r.mode === 'ExactOut')).toHaveLength(2);
  });

  it('produces a curve that worsens with size on both sides', async () => {
    const feed = new DepthFeed({
      http: quotingClient(),
      baseUrl: 'https://x',
      ladder: [10, 1_000, 100_000],
    });
    const snapshot = await feed.poll();

    const askImpacts = snapshot.asks.map((r) => r.impactPct);
    const bidImpacts = snapshot.bids.map((r) => r.impactPct);
    expect(askImpacts).toEqual([...askImpacts].sort((a, b) => a - b));
    expect(bidImpacts).toEqual([...bidImpacts].sort((a, b) => b - a));

    // Sign convention: bids sit below mid, asks above.
    expect(Math.max(...bidImpacts)).toBeLessThanOrEqual(0);
    expect(Math.min(...askImpacts)).toBeGreaterThanOrEqual(0);
  });

  it('derives mid from the tightest rung on each side', async () => {
    const feed = new DepthFeed({
      http: quotingClient(1e-7, 80),
      baseUrl: 'https://x',
      ladder: [10, 1_000],
    });
    const snapshot = await feed.poll();
    expect(snapshot.mid).toBeCloseTo(80, 4);
  });

  it('exposes the last snapshot for warm starts', async () => {
    const feed = new DepthFeed({
      http: quotingClient(),
      baseUrl: 'https://x',
      ladder: [10],
    });
    expect(feed.last).toBeUndefined();
    const snapshot = await feed.poll();
    expect(feed.last).toBe(snapshot);
  });

  it('fails loudly rather than reporting a mid of NaN', async () => {
    const feed = new DepthFeed({
      http: quotingClient(),
      baseUrl: 'https://x',
      ladder: [],
    });
    await expect(feed.poll()).rejects.toThrow(/no rungs/);
  });
});

describe('partial ladders', () => {
  /** Fails any quote at or above `failFrom` SOL, as the real ask leg does. */
  function client(failFrom: number): HttpClient {
    return new HttpClient({
      attempts: 1,
      fetch: ((url: string) => {
        const params = new URL(url).searchParams;
        const sol = Number(params.get('amount')) / 1e9;
        if (sol >= failFrom) {
          return Promise.resolve(new Response('no route', { status: 400 }));
        }
        const usdc = sol * 80;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              inAmount: String(Math.round(usdc * 1e6)),
              outAmount: String(Math.round(usdc * 1e6)),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof globalThis.fetch,
    });
  }

  it('keeps the rungs that quoted when a deep one has no route', async () => {
    // Nothing on Solana fills 150k SOL in one buy. Losing the entire curve over
    // its unquotable top rung would blank the HUD for no reason.
    const feed = new DepthFeed({
      http: client(100_000),
      baseUrl: 'https://x',
      ladder: [10, 1_000, 150_000],
    });
    const snapshot = await feed.poll();
    expect(snapshot.bids).toHaveLength(2);
    expect(snapshot.asks).toHaveLength(2);
    expect(snapshot.bids.map((r) => r.sizeSol)).toEqual([10, 1_000]);
  });

  it('still throws when nothing at all quoted', async () => {
    const feed = new DepthFeed({
      http: client(1),
      baseUrl: 'https://x',
      ladder: [10, 1_000],
    });
    await expect(feed.poll()).rejects.toThrow(/no rungs/);
  });

  it('discards a rung that priced at zero instead of showing -100% impact', async () => {
    const http = new HttpClient({
      fetch: ((url: string) => {
        const sol = Number(new URL(url).searchParams.get('amount')) / 1e9;
        const usdc = sol === 1_000 ? 0 : sol * 80;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              inAmount: String(Math.round(usdc * 1e6)),
              outAmount: String(Math.round(usdc * 1e6)),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof globalThis.fetch,
    });
    const feed = new DepthFeed({
      http,
      baseUrl: 'https://x',
      ladder: [10, 1_000],
    });
    const snapshot = await feed.poll();
    expect(snapshot.bids.map((r) => r.sizeSol)).toEqual([10]);
    expect(snapshot.bids.every((r) => Number.isFinite(r.impactPct))).toBe(true);
  });
});
