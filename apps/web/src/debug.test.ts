// @vitest-environment happy-dom
import type { DepthRung, ServerMessage, Trade } from '@sol-warzone/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderDebug } from './debug.js';
import { MarketStore } from './store.js';

/**
 * The debug view is phase 1's deliverable: its whole job is to make bad data
 * obvious. A rendering fault here would disguise exactly the problems it exists
 * to expose, so these tests read the numbers back out of the DOM.
 */

const rung = (sizeSol: number, impactPct: number): DepthRung => ({
  sizeSol,
  usd: sizeSol * 76,
  avgPrice: 76 * (1 + impactPct),
  impactPct,
});

const trade = (side: 'buy' | 'sell', usd: number, tier: Trade['tier']): Trade => ({
  type: 'trade',
  t: Date.UTC(2026, 7, 11, 20, 25, 15),
  side,
  usd,
  price: 76.2,
  tier,
});

const snapshot = (): ServerMessage => ({
  type: 'snapshot',
  t: 1,
  status: 'live',
  price: {
    type: 'tick',
    t: 1,
    blockId: 438_469_277,
    price: 76.18,
    tickChange: 0.00001,
    change24h: -0.0122,
  },
  depth: {
    type: 'depth',
    t: 1,
    mid: 76.2136,
    bids: [rung(10, -0.0001), rung(150_000, -0.0162)],
    asks: [rung(10, 0.0001)],
    bidWallUsd: 8_170_000,
    askWallUsd: 3_600_000,
  },
  candles: [
    { time: 1, open: 76, high: 77, low: 75, close: 76.1773, volume: 100_000 },
    { time: 2, open: 76, high: 77, low: 75, close: 76.2, volume: 300_000 },
  ],
  recentTrades: [trade('buy', 1_000, 'normal')],
});

let root: HTMLElement;
let store: MarketStore;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  store = new MarketStore();
});

const text = () => root.textContent ?? '';

describe('empty state', () => {
  it('renders without data instead of throwing', () => {
    expect(() => renderDebug(root, store, 'connecting')).not.toThrow();
    expect(text()).toContain('waiting…');
  });

  it('omits the ladders until depth arrives', () => {
    renderDebug(root, store, 'connecting');
    expect(text()).not.toContain('BID LADDER');
  });

  it('shows the transport and feed state together', () => {
    renderDebug(root, store, 'connecting');
    expect(root.querySelector('.dbg__badge')?.textContent).toBe('connecting / —');
  });
});

describe('populated state', () => {
  beforeEach(() => {
    store.apply(snapshot());
    renderDebug(root, store, 'open', Date.UTC(2026, 7, 11, 20, 25, 20));
  });

  it('shows the price and its moves', () => {
    expect(text()).toContain('$76.18');
    expect(text()).toContain('+0.001%');
    expect(text()).toContain('-1.22%');
  });

  it('shows the slot so a frozen feed is visible', () => {
    expect(text()).toContain('438469277');
  });

  it('shows both walls with their real asymmetry', () => {
    // Equal-looking walls were the symptom of a ladder too short to measure
    // anything; the view has to make the difference legible.
    expect(text()).toContain('$8.17M');
    expect(text()).toContain('$3.60M');
  });

  it('renders every rung of both ladders', () => {
    const ladders = root.querySelectorAll('.dbg__ladder');
    expect(ladders).toHaveLength(2);
    // Four header cells plus four per rung.
    expect(ladders[0]!.children).toHaveLength(4 + 2 * 4);
    expect(ladders[1]!.children).toHaveLength(4 + 1 * 4);
  });

  it('tolerates the ask ladder being shorter than the bid ladder', () => {
    // Routine above ~100k SOL: the buy leg has no route and drops out.
    expect(text()).toContain('150,000 SOL');
    expect(text()).toContain('-1.620%');
  });

  it('summarises candles rather than listing them', () => {
    expect(text()).toContain('mean volume/min');
    expect(text()).toContain('$200.0K');
    expect(text()).toContain('$300.0K');
  });

  it('marks trade direction so the colour rule has something to bind to', () => {
    const row = root.querySelector('.dbg__trade');
    expect(row?.getAttribute('data-side')).toBe('buy');
    expect(row?.getAttribute('data-tier')).toBe('normal');
  });
});

describe('flow accounting', () => {
  it('separates live flow from replayed history', () => {
    // Snapshot trades must not appear in the running totals.
    store.apply(snapshot());
    renderDebug(root, store, 'open');
    expect(text()).toContain('$0.00');

    store.apply(trade('sell', 5_000, 'heavy'));
    renderDebug(root, store, 'open');
    expect(text()).toContain('$5.0K');
  });

  it('labels a whale so it stands out from the drizzle', () => {
    store.apply(trade('buy', 400_000, 'whale'));
    renderDebug(root, store, 'open');
    expect(text()).toContain('WHALE');
    expect(root.querySelector('.dbg__trade')?.getAttribute('data-tier')).toBe('whale');
  });

  it('leaves ordinary trades unlabelled to keep the list scannable', () => {
    store.apply(trade('buy', 900, 'normal'));
    renderDebug(root, store, 'open');
    expect(text()).not.toContain('NORMAL');
  });
});

describe('repeat renders', () => {
  it('replaces content instead of appending it', () => {
    // The view repaints every second; appending would grow the DOM unbounded.
    store.apply(snapshot());
    renderDebug(root, store, 'open');
    const first = root.children.length;
    renderDebug(root, store, 'open');
    expect(root.children.length).toBe(first);
  });

  it('caps the trade list even when history is long', () => {
    for (let i = 0; i < 100; i++) store.apply(trade('buy', 1_000 + i, 'normal'));
    renderDebug(root, store, 'open');
    expect(root.querySelectorAll('.dbg__trade').length).toBeLessThanOrEqual(25);
  });
});
