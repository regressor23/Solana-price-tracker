import type { DepthRung, DepthSnapshot } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import {
  CLIP_PCT,
  SAMPLES,
  impactToX,
  pathFor,
  resample,
  shapeFor,
  sideFor,
} from './curve.js';

/**
 * C4 · LiquidityCurve, checked against a real snapshot.
 *
 * The numbers below are the measured ladder from DESIGN_BRIEF §11.3, last row
 * and all: 150k SOL to buy came back at an average price of $237.99, +213%,
 * because there is no route for a purchase that size. That row is not bad data
 * to be cleaned — it is the case the chart has to survive, and a curve that
 * scaled to fit it would compress everything real into a hairline.
 */

const rung = (sizeSol: number, impactPct: number, avgPrice: number): DepthRung => ({
  sizeSol,
  usd: sizeSol * avgPrice,
  avgPrice,
  impactPct,
});

/** The measured bid ladder: selling into the book. */
const BIDS: DepthRung[] = [
  rung(10, -0.00006, 75.8423),
  rung(50, -0.00011, 75.8383),
  rung(200, -0.00007, 75.8421),
  rung(1_000, -0.00011, 75.8386),
  rung(4_000, -0.00018, 75.8333),
  rung(12_000, -0.0004, 75.8167),
  rung(35_000, -0.00165, 75.7215),
  rung(75_000, -0.00555, 75.4261),
  rung(150_000, -0.01724, 74.5397),
];

/** …and the ask ladder, whose last rung has no route at all. */
const ASKS: DepthRung[] = [
  rung(10, 0.00006, 75.8517),
  rung(50, 0.00007, 75.8521),
  rung(200, 0.0001, 75.8546),
  rung(1_000, 0.00025, 75.8659),
  rung(4_000, 0.00079, 75.907),
  rung(12_000, 0.00222, 76.0153),
  rung(35_000, 0.00633, 76.3274),
  rung(75_000, 0.01533, 77.01),
  rung(150_000, 2.138, 237.99),
];

const snapshot = (bids = BIDS, asks = ASKS): DepthSnapshot => ({
  type: 'depth',
  t: 1_000,
  mid: 75.847,
  bids,
  asks,
  bidWallUsd: 7.76e6,
  askWallUsd: 3.94e6,
});

describe('the axis', () => {
  it('separates the rungs a linear axis would stack on the origin', () => {
    // The first four rungs are all inside ±0.0002%. Linearly they are one
    // point, and the whole chart becomes a flat line with a hook.
    const impacts = BIDS.slice(0, 4).map((r) => r.impactPct);
    const placed = impacts.map((p) => impactToX(p));
    const spread = Math.max(...placed) - Math.min(...placed);
    // What a linear axis would have given those same four impacts.
    const linear = (Math.max(...impacts) - Math.min(...impacts)) / CLIP_PCT;

    expect(spread).toBeGreaterThan(linear * 10);
  });

  it('reaches the edge exactly at the clip and no further', () => {
    expect(impactToX(CLIP_PCT)).toBeCloseTo(1, 6);
    expect(impactToX(-CLIP_PCT)).toBeCloseTo(-1, 6);
    expect(impactToX(2.138)).toBeCloseTo(1, 6);
    expect(impactToX(-99)).toBeCloseTo(-1, 6);
  });

  it('keeps the sign, because the sign is which side', () => {
    expect(impactToX(0.005)).toBeGreaterThan(0);
    expect(impactToX(-0.005)).toBeLessThan(0);
    expect(impactToX(0)).toBe(0);
  });

  it('is monotonic, or the ladder would fold over itself', () => {
    let previous = -Infinity;
    for (let pct = -0.02; pct <= 0.02; pct += 0.0005) {
      const x = impactToX(pct);
      expect(x).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = x;
    }
  });
});

describe('a leg of the ladder', () => {
  it('drops the rung that has no route, and says that it did', () => {
    const ask = sideFor(ASKS, 1);
    expect(ask.offScale).toBe(true);
    // Eight rungs plus the origin: the +213% one is marked at the edge, not
    // drawn at 213 times the width of the chart.
    expect(ask.points).toHaveLength(9);
    for (const point of ask.points) expect(point.x).toBeLessThanOrEqual(1);
  });

  it('keeps a leg that merely stops early', () => {
    // Above about 100k SOL the ask side simply has no route. A short ladder is
    // the book talking, not an error.
    const short = sideFor(ASKS.slice(0, 6), 1);
    expect(short.offScale).toBe(false);
    expect(short.points).toHaveLength(7);
  });

  it('reports the money it can actually account for', () => {
    // The wall total is measured to ±1%; this is the top of what is plotted,
    // and it must not include the rung that was thrown away.
    const ask = sideFor(ASKS, 1);
    expect(ask.usd).toBeCloseTo(75_000 * 77.01, 0);
  });

  it('puts each side on its own half', () => {
    for (const point of sideFor(BIDS, -1).points)
      expect(point.x).toBeLessThanOrEqual(0);
    for (const point of sideFor(ASKS, 1).points)
      expect(point.x).toBeGreaterThanOrEqual(0);
  });

  it('survives a leg with nothing in it', () => {
    const empty = sideFor([], 1);
    expect(empty.points).toHaveLength(1);
    expect(empty.usd).toBe(0);
    expect(pathFor(resample(empty, 1))).not.toContain('NaN');
  });
});

describe('resampling', () => {
  it('makes a full ladder and a truncated one the same shape', () => {
    // This is the whole reason it exists. Nine rungs against seven cannot be
    // interpolated point by point, and depth arrives once a minute, so every
    // update is a tween between two shapes that need not match.
    const full = resample(sideFor(ASKS, 1), 1);
    const partial = resample(sideFor(ASKS.slice(0, 6), 1), 1);

    expect(full).toHaveLength(SAMPLES);
    expect(partial).toHaveLength(SAMPLES);
    expect(pathFor(full).split(' ')).toHaveLength(pathFor(partial).split(' ').length);
  });

  it('climbs, because the ladder is cumulative', () => {
    let previous = -Infinity;
    for (const point of resample(sideFor(BIDS, -1), -1)) {
      expect(point.y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = point.y;
    }
  });

  it('stays inside the box it is drawn in', () => {
    for (const sign of [-1, 1] as const) {
      const rungs = sign === -1 ? BIDS : ASKS;
      for (const point of resample(sideFor(rungs, sign), sign)) {
        expect(Math.abs(point.x)).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the whole snapshot', () => {
  it('draws both legs and labels the clip edges', () => {
    const shape = shapeFor(snapshot());
    expect(shape.bidPath.startsWith('M0.0000')).toBe(true);
    expect(shape.askPath.startsWith('M0.0000')).toBe(true);
    expect(shape.low).toBeCloseTo(75.847 * 0.98, 4);
    expect(shape.high).toBeCloseTo(75.847 * 1.02, 4);
  });

  it('never emits a path a browser would silently drop', () => {
    // An `NaN` in a `d` attribute is not an error anywhere: the path simply
    // does not render, and the chart looks like it has no data.
    const shape = shapeFor(snapshot([], []));
    expect(shape.bidPath).not.toContain('NaN');
    expect(shape.askPath).not.toContain('NaN');
  });
});
