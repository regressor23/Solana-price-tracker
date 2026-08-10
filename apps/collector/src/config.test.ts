import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, type Env } from './config.js';

const load = (env: Env = {}) => loadConfig(env);

describe('defaults', () => {
  it('runs with a completely empty environment', () => {
    const config = load();
    expect(config).toMatchObject({
      env: 'development',
      port: 8080,
      host: '0.0.0.0',
      heartbeatMs: 30_000,
    });
  });

  it('points webRoot at the web workspace build output', () => {
    // The collector serves this directory, so a wrong path means a site that
    // 404s everything while /healthz still looks fine.
    const config = load();
    expect(config.webRoot.split(path.sep).slice(-3)).toEqual(['apps', 'web', 'dist']);
    expect(path.isAbsolute(config.webRoot)).toBe(true);
  });
});

describe('numeric parsing', () => {
  it('reads a supplied port', () => {
    expect(load({ PORT: '3000' }).port).toBe(3000);
  });

  it('falls back when the value is empty or whitespace', () => {
    // Railway sets variables to empty strings rather than unsetting them.
    expect(load({ PORT: '' }).port).toBe(8080);
    expect(load({ PORT: '   ' }).port).toBe(8080);
    expect(load({ WS_HEARTBEAT_MS: '' }).heartbeatMs).toBe(30_000);
  });

  it('throws on a value that is not a number', () => {
    // Better a crash at boot than a server listening on NaN.
    expect(() => load({ PORT: 'eight thousand' })).toThrow(/Expected a number/);
  });
});

describe('jupiter hosts', () => {
  it('always offers both hosts, so a rejected key has somewhere to fall back', () => {
    const { jupiter } = load();
    expect(jupiter.liteUrl).toBe('https://lite-api.jup.ag');
    expect(jupiter.keyedUrl).toBe('https://api.jup.ag');
  });

  it('reports no key when none is set', () => {
    expect(load().jupiter.apiKey).toBe('');
  });

  it('carries the key through when one is set', () => {
    expect(load({ JUPITER_API_KEY: 'jup_live_xxx' }).jupiter.apiKey).toBe(
      'jup_live_xxx',
    );
  });

  it('assumes the free plan when a key is present but no plan is declared', () => {
    // The trap this exists for: a free-plan key allows 1 RPS, the same as the
    // keyless host already gives away. Assuming a key means speed is how the
    // collector ended up throttled in production.
    const { jupiter } = load({ JUPITER_API_KEY: 'k' });
    expect(jupiter.plan).toBe('free');
    expect(jupiter.rps).toBe(1);
  });

  it('assumes keyless when there is no key at all', () => {
    expect(load().jupiter.plan).toBe('keyless');
  });

  it('takes the declared plan when one is given', () => {
    const { jupiter } = load({ JUPITER_API_KEY: 'k', JUPITER_PLAN: 'developer' });
    expect(jupiter.plan).toBe('developer');
    expect(jupiter.rps).toBe(10);
  });

  it('accepts a plan name in any case', () => {
    expect(load({ JUPITER_PLAN: 'Developer' }).jupiter.plan).toBe('developer');
  });

  it('rejects a plan it does not know rather than guessing a limit', () => {
    expect(() => load({ JUPITER_PLAN: 'unlimited' })).toThrow(/JUPITER_PLAN/);
  });

  it('treats a whitespace-only key as absent', () => {
    // A variable left blank in the Railway UI must not select the keyed host,
    // which rejects unauthenticated callers harder than the keyless one does.
    expect(load({ JUPITER_API_KEY: '   ' }).jupiter.apiKey).toBe('');
  });

  it('trims a key that was pasted with padding', () => {
    expect(load({ JUPITER_API_KEY: '  jup_live_xxx\n' }).jupiter.apiKey).toBe(
      'jup_live_xxx',
    );
  });

  it('keeps the data host fixed — it has no keyed variant', () => {
    expect(load({ JUPITER_API_KEY: 'k' }).jupiter.dataUrl).toBe(
      'https://datapi.jup.ag',
    );
  });
});

describe('helius', () => {
  it('defaults to empty, which disables the per-swap feed', () => {
    expect(load().helius.apiKey).toBe('');
  });

  it('trims like the jupiter key does', () => {
    expect(load({ HELIUS_API_KEY: ' abc ' }).helius.apiKey).toBe('abc');
  });
});

describe('isolation', () => {
  it('does not read the ambient process environment', () => {
    // loadConfig takes the environment as an argument precisely so tests never
    // depend on what happens to be exported in the shell running them.
    const before = process.env['PORT'];
    process.env['PORT'] = '9999';
    try {
      expect(load({}).port).toBe(8080);
    } finally {
      if (before === undefined) delete process.env['PORT'];
      else process.env['PORT'] = before;
    }
  });
});
