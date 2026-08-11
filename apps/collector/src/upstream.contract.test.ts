import {
  DEPTH_LADDER_SOL,
  SOL_MINT,
  USDC_MINT,
  type Candle,
} from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

/**
 * Contract tests against the live Jupiter API. Run with `npm run verify:upstream`.
 *
 * Every serious defect in phase 1 was the same shape: Jupiter behaves in a way
 * the code assumed it did not. Timestamps in milliseconds where seconds seemed
 * natural, a percent where the field name suggested a fraction, a ladder too
 * short to reach the threshold it advertised, an ExactOut leg with no route,
 * and a free API key that buys nothing.
 *
 * Unit tests cannot catch any of that, because their mocks are written from the
 * same assumptions as the code. These tests ask the real service instead.
 *
 * Deliberately outside the CI gate: they need the network and spend real rate
 * budget, and a red build caused by someone else's throttle teaches people to
 * ignore red builds.
 */

const LITE = 'https://lite-api.jup.ag';
const DATA = 'https://datapi.jup.ag';

/** Spaced out so a full run stays well inside the keyless allowance. */
const PACE_MS = 1_200;
const pace = () => new Promise((resolve) => setTimeout(resolve, PACE_MS));

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  await pace();
  return (await response.json()) as T;
}

const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));

describe('price/v3', () => {
  it('still reports usdPrice, blockId and priceChange24h', async () => {
    const payload = await getJson<Record<string, Record<string, number>>>(
      `${LITE}/price/v3?ids=${SOL_MINT}`,
    );
    const entry = payload[SOL_MINT];
    expect(entry).toBeDefined();
    expect(entry!['usdPrice']).toBeGreaterThan(0);
    expect(Number.isFinite(entry!['blockId'])).toBe(true);
    expect(Number.isFinite(entry!['priceChange24h'])).toBe(true);
  });

  it('reports priceChange24h as a percent, not a fraction', async () => {
    // Reading this as a fraction is a 100x error in the HUD. Cross-check the
    // field against the price a day ago rather than trusting its name.
    const [payload, chart] = await Promise.all([
      getJson<Record<string, Record<string, number>>>(
        `${LITE}/price/v3?ids=${SOL_MINT}`,
      ),
      getJson<{ candles: Candle[] }>(
        `${DATA}/v2/charts/${SOL_MINT}?interval=1_HOUR&baseAsset=${SOL_MINT}` +
          `&from=${Date.now() - 90_000_000}&to=${Date.now()}&candles=30&type=price`,
      ),
    ]);

    const now = payload[SOL_MINT]!['usdPrice']!;
    const reported = payload[SOL_MINT]!['priceChange24h']!;
    const target = Date.now() / 1000 - 86_400;
    const old = chart.candles.reduce((best, candle) =>
      Math.abs(candle.time - target) < Math.abs(best.time - target) ? candle : best,
    );
    const actualPct = ((now - old.close) / old.close) * 100;

    // Generous: the candle is only near 24h old. A fraction would be off by 100.
    expect(Math.abs(reported - actualPct)).toBeLessThan(
      Math.abs(reported - actualPct / 100),
    );
  });
});

describe('charts', () => {
  it('accepts millisecond bounds', async () => {
    const to = Date.now();
    const payload = await getJson<{ candles: Candle[] }>(
      `${DATA}/v2/charts/${SOL_MINT}?interval=1_MINUTE&baseAsset=${SOL_MINT}` +
        `&from=${to - 3_600_000}&to=${to}&candles=60&type=price`,
    );
    expect(payload.candles.length).toBeGreaterThan(0);
    const candle = payload.candles[0]!;
    for (const key of ['time', 'open', 'high', 'low', 'close', 'volume']) {
      expect(Number.isFinite(candle[key as keyof Candle])).toBe(true);
    }
  });

  it('returns candles stamped in seconds even though it takes milliseconds', async () => {
    // The asymmetry that makes the trap easy to fall into.
    const to = Date.now();
    const payload = await getJson<{ candles: Candle[] }>(
      `${DATA}/v2/charts/${SOL_MINT}?interval=1_MINUTE&baseAsset=${SOL_MINT}` +
        `&from=${to - 3_600_000}&to=${to}&candles=60&type=price`,
    );
    const time = payload.candles[0]!.time;
    expect(String(Math.trunc(time))).toHaveLength(10);
  });

  it('silently returns nothing for second bounds — the failure is not an error', async () => {
    // Documents why CandleFeed throws on an empty list instead of caching it.
    const to = Math.floor(Date.now() / 1000);
    const payload = await getJson<{ candles: Candle[] }>(
      `${DATA}/v2/charts/${SOL_MINT}?interval=1_MINUTE&baseAsset=${SOL_MINT}` +
        `&from=${to - 3_600}&to=${to}&candles=60&type=price`,
    );
    expect(payload.candles).toEqual([]);
  });
});

describe('quote', () => {
  it('supports ExactIn for the sell leg', async () => {
    const quote = await getJson<{ outAmount: string; swapMode: string }>(
      `${LITE}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}` +
        `&amount=${lamports(100)}&slippageBps=5000`,
    );
    expect(quote.swapMode).toBe('ExactIn');
    expect(Number(quote.outAmount)).toBeGreaterThan(0);
  });

  it('supports ExactOut for the buy leg', async () => {
    // Both legs fix the SOL amount so the rungs are comparable. Losing ExactOut
    // would silently make the ask ladder measure something else.
    const quote = await getJson<{ inAmount: string; swapMode: string }>(
      `${LITE}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}` +
        `&amount=${lamports(100)}&slippageBps=5000&swapMode=ExactOut`,
    );
    expect(quote.swapMode).toBe('ExactOut');
    expect(Number(quote.inAmount)).toBeGreaterThan(0);
  });

  it('still costs more to buy size than to sell it', async () => {
    const [sell, buy] = [
      await getJson<{ outAmount: string }>(
        `${LITE}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}` +
          `&amount=${lamports(1_000)}&slippageBps=5000`,
      ),
      await getJson<{ inAmount: string }>(
        `${LITE}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}` +
          `&amount=${lamports(1_000)}&slippageBps=5000&swapMode=ExactOut`,
      ),
    ];
    expect(Number(buy.inAmount)).toBeGreaterThan(Number(sell.outAmount));
  });

  it('reaches 1% impact within the configured ladder on the bid side', async () => {
    // The ladder existed once that was untrue, and both walls silently reported
    // the ladder's own notional instead of a measurement.
    const top = DEPTH_LADDER_SOL[DEPTH_LADDER_SOL.length - 1]!;
    const [touch, deepest] = [
      await getJson<{ outAmount: string }>(
        `${LITE}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}` +
          `&amount=${lamports(10)}&slippageBps=5000`,
      ),
      await getJson<{ outAmount: string }>(
        `${LITE}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}` +
          `&amount=${lamports(top)}&slippageBps=5000`,
      ),
    ];
    const mid = Number(touch.outAmount) / 1e6 / 10;
    const deepPrice = Number(deepest.outAmount) / 1e6 / top;
    expect(Math.abs((deepPrice - mid) / mid)).toBeGreaterThan(0.01);
  });
});

describe('swap feed', () => {
  interface Swap {
    type: string;
    usdVolume: number;
    usdPrice: number;
    txHash: string;
    timestamp: string;
  }

  it('still returns the fields the trade feed reads', async () => {
    const payload = await getJson<{ txs: Swap[] }>(
      `${DATA}/v1/txs/${SOL_MINT}?limit=30&minUsdVolume=500`,
    );
    expect(payload.txs.length).toBeGreaterThan(0);
    const swap = payload.txs[0]!;
    expect(['buy', 'sell']).toContain(swap.type);
    expect(swap.usdVolume).toBeGreaterThan(0);
    expect(swap.txHash).toBeTruthy();
    expect(Number.isNaN(Date.parse(swap.timestamp))).toBe(false);
  });

  it('honours the dust filter', async () => {
    // Without it the feed is swamped by sub-cent swaps carrying no pressure.
    const payload = await getJson<{ txs: Swap[] }>(
      `${DATA}/v1/txs/${SOL_MINT}?limit=30&minUsdVolume=5000`,
    );
    for (const swap of payload.txs) {
      expect(swap.usdVolume).toBeGreaterThanOrEqual(5_000);
    }
  });

  it('caps a page at 30 however many are asked for', async () => {
    // The trade feed's dedup window is sized against this.
    const payload = await getJson<{ txs: Swap[] }>(
      `${DATA}/v1/txs/${SOL_MINT}?limit=100&minUsdVolume=100`,
    );
    expect(payload.txs.length).toBeLessThanOrEqual(30);
  });

  it('turns over fast enough to be worth polling every second', async () => {
    const first = await getJson<{ txs: Swap[] }>(
      `${DATA}/v1/txs/${SOL_MINT}?limit=30&minUsdVolume=500`,
    );
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const second = await getJson<{ txs: Swap[] }>(
      `${DATA}/v1/txs/${SOL_MINT}?limit=30&minUsdVolume=500`,
    );

    const seen = new Set(first.txs.map((s) => s.txHash));
    const fresh = second.txs.filter((s) => !seen.has(s.txHash));
    expect(fresh.length).toBeGreaterThan(0);
  });
});
