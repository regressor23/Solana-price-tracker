import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

/**
 * Jupiter serves the same routes on two hosts: `lite-api` needs no key but is
 * rate limited, `api` needs one and is not. Picking the host off the key means
 * adding `JUPITER_API_KEY` in Railway is the only step to upgrade.
 */
const jupiterApiKey = process.env['JUPITER_API_KEY']?.trim() ?? '';

export const config = {
  env: process.env['NODE_ENV'] ?? 'development',
  port: num(process.env['PORT'], 8080),
  host: process.env['HOST'] ?? '0.0.0.0',

  jupiter: {
    apiKey: jupiterApiKey,
    baseUrl: jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag',
    dataUrl: 'https://datapi.jup.ag',
  },

  /** Optional: enables the per-swap feed (PLAN.md §4.5 tier B). */
  helius: {
    apiKey: process.env['HELIUS_API_KEY']?.trim() ?? '',
  },

  /**
   * Built web assets. In production the collector serves them so there is one
   * origin, one Railway service, and no CORS or cross-origin WS to configure.
   */
  webRoot: path.resolve(here, '../../web/dist'),

  heartbeatMs: num(process.env['WS_HEARTBEAT_MS'], 30_000),
} as const;

export type Config = typeof config;
