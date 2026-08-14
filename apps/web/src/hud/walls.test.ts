// @vitest-environment happy-dom
import { BALANCE, type DepthSnapshot } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { WallBar, variantFor, wallBalance } from './walls.js';

/**
 * C3 · WallBar.
 *
 * The bar and the front line in the scene are two views of one number, and
 * nothing but a test says so: the collector divides the walls to set each
 * side's reinforcement target, and this divides them again to place a marker.
 * Two divisions of the same quantity in two languages is exactly the sort of
 * pair that drifts apart the first time either is touched.
 */

const depth = (bidWallUsd: number, askWallUsd: number, t = 1_000): DepthSnapshot => ({
  type: 'depth',
  t,
  mid: 75.85,
  bids: [],
  asks: [],
  bidWallUsd,
  askWallUsd,
});

const host = (): HTMLElement => {
  const node = document.createElement('div');
  document.body.append(node);
  return node;
};

const marker = (root: HTMLElement): string =>
  (root.querySelector('.walls__marker') as HTMLElement).style.getPropertyValue('--at');

const values = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.walls__value')].map((n) => n.textContent ?? '');

describe('the imbalance', () => {
  it('is zero when the book is even', () => {
    expect(wallBalance(depth(5e6, 5e6))).toBe(0);
  });

  it('leans to the orcs when the bid wall is the heavier one', () => {
    // A big bid wall is a market that resists being pushed down, which is the
    // orcs' half of the field — the same reading the collector takes.
    expect(wallBalance(depth(7.76e6, 3.94e6))).toBeLessThan(0);
    expect(wallBalance(depth(3.94e6, 7.76e6))).toBeGreaterThan(0);
  });

  it('mirrors the front line, because both come from the same share', () => {
    // The collector's own arithmetic: orcShare = bid / (bid + ask), and the
    // front line follows the army difference that share produces. Written the
    // other way round here, the two must still be the same number.
    for (const [bid, ask] of [
      [7.76e6, 3.94e6],
      [1e6, 9e6],
      [5e6, 5e6],
      [2.5e6, 7.5e6],
    ] as const) {
      const orcShare = bid / (bid + ask);
      expect(wallBalance(depth(bid, ask))).toBeCloseTo(1 - 2 * orcShare, 10);
    }
  });

  it('survives a book with nothing in it', () => {
    // Both legs can drop out at once — the ask ladder has no route above about
    // 100k SOL, and a fresh collector has neither. Zero over zero would put the
    // marker at NaN%, which CSS silently ignores and leaves stuck.
    expect(wallBalance(depth(0, 0))).toBe(0);
    expect(Number.isFinite(wallBalance(depth(0, 0)))).toBe(true);
  });

  it('stays inside the track at ten to one', () => {
    // §C3: the ratio has to hold to 10:1 without breaking the layout.
    const extreme = wallBalance(depth(10e6, 1e6));
    expect(extreme).toBeGreaterThanOrEqual(-1);
    expect(0.5 + extreme / 2).toBeGreaterThanOrEqual(0);
  });
});

describe('which side is called', () => {
  it('calls a near-even book contested rather than picking a winner', () => {
    expect(variantFor(0)).toBe('contested');
    expect(variantFor(0.09)).toBe('contested');
    expect(variantFor(-0.09)).toBe('contested');
  });

  it('names a side once the gap is real', () => {
    expect(variantFor(-0.4)).toBe('orc-dominant');
    expect(variantFor(0.4)).toBe('nexus-dominant');
  });
});

describe('the bar', () => {
  it('shows plates rather than glyphs before the first snapshot', () => {
    // Depth can take a full minute on the lite profile. A `$—` placeholder is
    // text, so it is invisible during the font's blocking period — which is
    // exactly the window it exists to cover.
    const root = host();
    const bar = new WallBar(root);
    bar.update(null);

    expect(root.dataset['state']).toBe('waiting');
    expect(values(root)).toEqual(['', '']);
    for (const node of root.querySelectorAll('.walls__value')) {
      expect(node.getAttribute('data-skeleton')).toBe('wall');
    }
  });

  it('puts both totals up and the marker between them', () => {
    const root = host();
    new WallBar(root).update(depth(7.76e6, 3.94e6), 1_000);

    expect(values(root)).toEqual(['$7.76M', '$3.94M']);
    expect(root.dataset['variant']).toBe('orc-dominant');
    // Orc-heavy, so left of centre.
    expect(Number.parseFloat(marker(root))).toBeLessThan(50);
  });

  it('says how old the snapshot is, not only when it is too old', () => {
    // A number that appears only once something is wrong teaches nobody what
    // normal looks like, and here normal is up to a minute.
    const root = host();
    const bar = new WallBar(root);

    bar.update(depth(5e6, 5e6, 1_000), 31_000);
    expect(root.dataset['state']).toBe('live');
    expect(root.querySelector('.walls__age')?.textContent).toBe('30s');

    bar.update(depth(5e6, 5e6, 1_000), 121_000);
    expect(root.dataset['state']).toBe('stale');
  });

  it('goes back to waiting if the feed is reset under it', () => {
    const root = host();
    const bar = new WallBar(root);
    bar.update(depth(5e6, 5e6));
    bar.update(null);

    expect(root.dataset['state']).toBe('waiting');
    expect(values(root)).toEqual(['', '']);
  });

  it('places the marker where the pool would put the armies', () => {
    // Sanity in the other direction: an all-orc book should read as the orc end
    // of the track, and the pool ceiling is what the scene would show.
    const root = host();
    new WallBar(root).update(depth(BALANCE.poolPerSide, 0));
    expect(Number.parseFloat(marker(root))).toBe(0);
  });
});
