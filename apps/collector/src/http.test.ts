import { describe, expect, it, vi } from 'vitest';

import { HttpClient, HttpError } from './http.js';

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Records sleeps instead of performing them, so tests stay instant. */
function clientOf(responses: (Response | Error)[], options: { apiKey?: string } = {}) {
  const slept: number[] = [];
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;

  const client = new HttpClient({
    ...options,
    attempts: 3,
    baseBackoffMs: 100,
    random: () => 0.5,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    fetch: ((url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      const next = responses[Math.min(index++, responses.length - 1)];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next!.clone());
    }) as unknown as typeof globalThis.fetch,
  });

  return { client, slept, calls };
}

describe('success', () => {
  it('parses a json body', async () => {
    const { client } = clientOf([jsonResponse({ ok: 1 })]);
    await expect(client.getJson('https://x')).resolves.toEqual({ ok: 1 });
  });

  it('sends no api key header when none is configured', async () => {
    const { client, calls } = clientOf([jsonResponse({})]);
    await client.getJson('https://x');
    expect(calls[0]?.headers).toEqual({});
  });

  it('sends the api key when configured', async () => {
    const { client, calls } = clientOf([jsonResponse({})], { apiKey: 'k' });
    await client.getJson('https://x');
    expect(calls[0]?.headers).toEqual({ 'x-api-key': 'k' });
  });
});

describe('retry', () => {
  it('retries a 500 and returns the eventual success', async () => {
    const { client, calls } = clientOf([
      jsonResponse({ e: 1 }, 500),
      jsonResponse({ ok: true }),
    ]);
    await expect(client.getJson('https://x')).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    const { client } = clientOf([new Error('ECONNRESET'), jsonResponse({ ok: 1 })]);
    await expect(client.getJson('https://x')).resolves.toEqual({ ok: 1 });
  });

  it('gives up after the configured number of attempts', async () => {
    const { client, calls } = clientOf([jsonResponse({}, 503)]);
    await expect(client.getJson('https://x')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 400 — it will fail the same way forever', async () => {
    const { client, calls } = clientOf([jsonResponse({ bad: true }, 400)]);
    await expect(client.getJson('https://x')).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('backs off exponentially', async () => {
    const { client, slept } = clientOf([jsonResponse({}, 500)]);
    await client.getJson('https://x').catch(() => undefined);
    // random() === 0.5 makes the jitter factor exactly 1.
    expect(slept).toEqual([100, 200]);
  });
});

describe('rate limiting', () => {
  it('honours Retry-After given in seconds', async () => {
    const { client, slept } = clientOf([
      jsonResponse({}, 429, { 'retry-after': '2' }),
      jsonResponse({ ok: 1 }),
    ]);
    await client.getJson('https://x');
    expect(slept[0]).toBe(2_000);
  });

  it('honours Retry-After given as a date', async () => {
    const when = new Date(Date.now() + 3_000).toUTCString();
    const { client, slept } = clientOf([
      jsonResponse({}, 429, { 'retry-after': when }),
      jsonResponse({ ok: 1 }),
    ]);
    await client.getJson('https://x');
    expect(slept[0]).toBeGreaterThan(1_500);
    expect(slept[0]).toBeLessThanOrEqual(3_000);
  });

  it('falls back to backoff when Retry-After is nonsense', async () => {
    const { client, slept } = clientOf([
      jsonResponse({}, 429, { 'retry-after': 'soon' }),
      jsonResponse({ ok: 1 }),
    ]);
    await client.getJson('https://x');
    expect(slept[0]).toBe(100);
  });

  it('applies the throttle to every caller, not just the one that hit it', async () => {
    // All four feeds share one upstream budget. A 429 on the depth ladder must
    // slow the price poll too, or the client keeps digging.
    vi.useFakeTimers();
    try {
      const { client, slept } = clientOf([
        jsonResponse({}, 429, { 'retry-after': '5' }),
        jsonResponse({ ok: 1 }),
      ]);
      await client.getJson('https://first');
      expect(client.throttleRemaining()).toBeGreaterThan(0);

      slept.length = 0;
      await client.getJson('https://second');
      // The second call waited out the shared throttle before its first try.
      expect(slept[0]).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no throttle once the window has passed', () => {
    const { client } = clientOf([jsonResponse({})]);
    expect(client.throttleRemaining()).toBe(0);
  });
});

describe('HttpError', () => {
  it('carries status, url and a truncated body', async () => {
    const { client } = clientOf([new Response('x'.repeat(500), { status: 400 })]);
    const error = await client.getJson('https://x/api').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, url: 'https://x/api' });
    expect((error as HttpError).body).toHaveLength(200);
  });
});
