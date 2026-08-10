import type { ServerMessage, Trade } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { MarketStore } from './store.js';

const tick = (price: number, blockId = 1): ServerMessage => ({
  type: 'tick',
  t: 1,
  blockId,
  price,
  tickChange: 0.001,
  change24h: -0.014,
});

const trade = (side: 'buy' | 'sell', usd: number, t = 1): Trade => ({
  type: 'trade',
  t,
  side,
  usd,
  price: 76.5,
  tier: 'normal',
});

describe('lifecycle', () => {
  it('records identity from hello', () => {
    const store = new MarketStore();
    store.apply({
      type: 'hello',
      protocol: 1,
      t: 1,
      pair: 'SOL/USDC',
      status: 'sync',
    });
    expect(store.state).toMatchObject({
      pair: 'SOL/USDC',
      protocol: 1,
      status: 'sync',
    });
  });

  it('tracks status changes', () => {
    const store = new MarketStore();
    store.apply({ type: 'status', t: 1, status: 'degraded', detail: 'stale' });
    expect(store.state.status).toBe('degraded');
  });

  it('clears everything on reset', () => {
    const store = new MarketStore();
    store.apply(tick(76));
    store.apply(trade('buy', 100));
    store.reset();
    expect(store.state.price).toBeNull();
    expect(store.state.trades).toEqual([]);
    expect(store.state.buyUsd).toBe(0);
  });
});

describe('flow accounting', () => {
  it('splits volume by side', () => {
    const store = new MarketStore();
    store.apply(trade('buy', 300));
    store.apply(trade('sell', 100));
    expect(store.state.buyUsd).toBe(300);
    expect(store.state.sellUsd).toBe(100);
    expect(store.netUsd).toBe(200);
  });

  it('goes negative when sellers dominate', () => {
    const store = new MarketStore();
    store.apply(trade('sell', 500));
    expect(store.netUsd).toBe(-500);
  });

  it('does not count snapshot history as live flow', () => {
    // The snapshot replays trades that happened before this client connected.
    // Counting them would open every session with a phantom imbalance.
    const store = new MarketStore();
    store.apply({
      type: 'snapshot',
      t: 1,
      status: 'live',
      price: null,
      depth: null,
      candles: [],
      recentTrades: [trade('buy', 10_000), trade('sell', 20)],
    });
    expect(store.state.buyUsd).toBe(0);
    expect(store.state.sellUsd).toBe(0);
    expect(store.state.trades).toHaveLength(2);
  });
});

describe('trade history', () => {
  it('keeps the newest trade first', () => {
    const store = new MarketStore();
    store.apply(trade('buy', 1, 100));
    store.apply(trade('buy', 2, 200));
    expect(store.state.trades.map((t) => t.usd)).toEqual([2, 1]);
  });

  it('shows snapshot history newest-first too', () => {
    // The wire carries recentTrades oldest-first; the display is the reverse.
    const store = new MarketStore();
    store.apply({
      type: 'snapshot',
      t: 1,
      status: 'live',
      price: null,
      depth: null,
      candles: [],
      recentTrades: [trade('buy', 1, 100), trade('buy', 2, 200)],
    });
    expect(store.state.trades.map((t) => t.usd)).toEqual([2, 1]);
  });

  it('caps history so a long session cannot grow without bound', () => {
    const store = new MarketStore();
    for (let i = 0; i < 500; i++) store.apply(trade('buy', i));
    expect(store.state.trades.length).toBeLessThanOrEqual(60);
    expect(store.state.trades[0]?.usd).toBe(499);
  });
});

describe('counters', () => {
  it('counts each message kind separately', () => {
    const store = new MarketStore();
    store.apply(tick(76, 1));
    store.apply(tick(77, 2));
    store.apply(trade('buy', 5));
    expect(store.state.counts).toMatchObject({ tick: 2, trade: 1, depth: 0 });
  });

  it('records when the last message arrived', () => {
    const store = new MarketStore();
    store.apply(tick(76), 12_345);
    expect(store.state.lastMessageAt).toBe(12_345);
  });

  it('ignores round events for now without corrupting state', () => {
    const store = new MarketStore();
    store.apply(tick(76));
    store.apply({
      type: 'round',
      t: 1,
      winner: 'orc',
      orcFallen: 3,
      nexusFallen: 9,
    });
    expect(store.state.price?.price).toBe(76);
  });
});
