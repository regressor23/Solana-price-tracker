import type { MarketEvent } from '@sol-warzone/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketFeeds } from './index.js';

/**
 * A rejected key took production down: every quote returned 401, the ladder
 * produced no rungs, and the collector kept retrying a credential that was
 * never going to start working. Falling back to the keyless host has to be
 * automatic, because the keyed host is *stricter* than the keyless one for
 * callers it will not authenticate.
 */

interface Harness {
  feeds: MarketFeeds;
  hosts: string[];
  statuses: { status: string; detail?: string }[];
  events: MarketEvent[];
}

function harness(options: { rejectKeyed: boolean; apiKey?: string }): Harness {
  const hosts: string[] = [];
  const statuses: Harness['statuses'] = [];
  const events: MarketEvent[] = [];

  const fetchImpl = (url: string) => {
    const { origin, pathname, searchParams } = new URL(url);
    hosts.push(origin);

    if (options.rejectKeyed && origin === 'https://api.jup.ag') {
      return Promise.resolve(new Response('invalid api key', { status: 401 }));
    }

    const body = pathname.startsWith('/price/v3')
      ? {
          So11111111111111111111111111111111111111112: {
            usdPrice: 76.5,
            blockId: Date.now(),
            priceChange24h: -1,
            decimals: 9,
            liquidity: 1,
          },
        }
      : pathname.startsWith('/swap/v1/quote')
        ? (() => {
            const sol = Number(searchParams.get('amount')) / 1e9;
            const usdc = Math.round(sol * 76.5 * 1e6);
            return { inAmount: String(usdc), outAmount: String(usdc) };
          })()
        : pathname.includes('/txs/')
          ? { txs: [] }
          : {
              candles: [{ time: 1, open: 76, high: 76, low: 76, close: 76, volume: 1 }],
            };

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  vi.stubGlobal('fetch', fetchImpl);

  const feeds = new MarketFeeds({
    liteUrl: 'https://lite-api.jup.ag',
    keyedUrl: 'https://api.jup.ag',
    dataUrl: 'https://datapi.jup.ag',
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    publish: (event) => events.push(event),
    setStatus: (status, detail) =>
      statuses.push(detail === undefined ? { status } : { status, detail }),
  });

  return { feeds, hosts, statuses, events };
}

/** Lets queued promise callbacks run without advancing wall-clock time. */
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('host selection', () => {
  it('uses the keyless host when no key is configured', async () => {
    const h = harness({ rejectKeyed: false });
    h.feeds.start();
    await settle();
    h.feeds.stop();

    expect(h.hosts.some((host) => host === 'https://api.jup.ag')).toBe(false);
    expect(h.feeds.diagnostics().profile).toBe('lite');
  });

  it('uses the keyed host when a key is accepted', async () => {
    const h = harness({ rejectKeyed: false, apiKey: 'good' });
    h.feeds.start();
    await settle();
    h.feeds.stop();

    expect(h.hosts).toContain('https://api.jup.ag');
    expect(h.feeds.diagnostics().profile).toBe('keyed');
    expect(h.feeds.diagnostics().keyRejected).toBe(false);
  });
});

describe('rejected key', () => {
  it('falls back to the keyless host instead of retrying forever', async () => {
    const h = harness({ rejectKeyed: true, apiKey: 'revoked' });
    h.feeds.start();
    await settle();

    const diagnostics = h.feeds.diagnostics();
    expect(diagnostics.keyRejected).toBe(true);
    expect(diagnostics.profile).toBe('lite');
    expect(diagnostics.upstream.quoteHost).toBe('https://lite-api.jup.ag');
    h.feeds.stop();
  });

  it('keeps serving prices from the keyless host afterwards', async () => {
    // The point of the fallback: the site stays up on a bad key.
    const h = harness({ rejectKeyed: true, apiKey: 'revoked' });
    h.feeds.start();
    await settle();
    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    h.feeds.stop();

    expect(h.events.some((event) => event.type === 'tick')).toBe(true);
  });

  it('says why it degraded rather than just going quiet', async () => {
    const h = harness({ rejectKeyed: true, apiKey: 'revoked' });
    h.feeds.start();
    await settle();
    h.feeds.stop();

    expect(
      h.statuses.some(
        (entry) =>
          entry.status === 'degraded' && /key rejected/.test(entry.detail ?? ''),
      ),
    ).toBe(true);
  });

  it('does not keep re-running the fallback on every later error', async () => {
    const h = harness({ rejectKeyed: true, apiKey: 'revoked' });
    h.feeds.start();
    await settle();
    const afterFirst = h.feeds.diagnostics();

    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    h.feeds.stop();

    // Still keyless, still one downgrade — not a restart loop.
    expect(h.feeds.diagnostics().profile).toBe('lite');
    expect(h.feeds.diagnostics().keyRejected).toBe(afterFirst.keyRejected);
  });

  it('never returns to the keyed host on its own', async () => {
    const h = harness({ rejectKeyed: true, apiKey: 'revoked' });
    h.feeds.start();
    await settle();
    const before = h.hosts.length;

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    h.feeds.stop();

    const laterHosts = h.hosts.slice(before);
    expect(laterHosts).not.toContain('https://api.jup.ag');
  });
});
