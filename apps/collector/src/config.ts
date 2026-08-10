import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface JupiterConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly dataUrl: string;
}

export interface Config {
  readonly env: string;
  readonly port: number;
  readonly host: string;
  readonly jupiter: JupiterConfig;
  readonly helius: { readonly apiKey: string };
  readonly webRoot: string;
  readonly heartbeatMs: number;
}

/** Environment as a plain record, so tests can pass one without touching the process. */
export type Env = Readonly<Partial<Record<string, string>>>;

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

export function loadConfig(env: Env = process.env): Config {
  /**
   * Jupiter serves the same routes on two hosts: `lite-api` needs no key but is
   * rate limited, `api` needs one and is not. Picking the host off the key means
   * adding `JUPITER_API_KEY` in Railway is the only step to upgrade.
   */
  const jupiterApiKey = env['JUPITER_API_KEY']?.trim() ?? '';

  return {
    env: env['NODE_ENV'] ?? 'development',
    port: num(env['PORT'], 8080),
    host: env['HOST'] ?? '0.0.0.0',

    jupiter: {
      apiKey: jupiterApiKey,
      baseUrl: jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag',
      dataUrl: 'https://datapi.jup.ag',
    },

    /** Optional: enables the per-swap feed (PLAN.md §4.5 tier B). */
    helius: {
      apiKey: env['HELIUS_API_KEY']?.trim() ?? '',
    },

    /**
     * Built web assets. In production the collector serves them so there is one
     * origin, one Railway service, and no CORS or cross-origin WS to configure.
     */
    webRoot: path.resolve(here, '../../web/dist'),

    heartbeatMs: num(env['WS_HEARTBEAT_MS'], 30_000),
  };
}

export const config = loadConfig();
