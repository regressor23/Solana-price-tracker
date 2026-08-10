import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { PAIR_LABEL, PROTOCOL_VERSION } from '@sol-warzone/protocol';

import { config } from './config.js';
import { Hub } from './hub.js';
import { createStaticServer } from './static.js';

const startedAt = Date.now();
const serveStatic = createStaticServer(config.webRoot);

/**
 * The collector serves the client bundle, so a build that produced no bundle
 * leaves the site completely broken. Detect it once at boot: the contents of
 * webRoot cannot change while the container is running.
 */
const webBundlePresent = fs.existsSync(path.join(config.webRoot, 'index.html'));
const isProduction = config.env === 'production';

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/healthz') {
    // Report unhealthy in production when the bundle is missing, so a bad
    // deploy goes red instead of passing the health gate and then serving 404s
    // to every visitor. Locally the bundle is often absent on purpose, because
    // `npm run dev:web` serves the client from Vite instead.
    const healthy = webBundlePresent || !isProduction;
    json(res, healthy ? 200 : 503, {
      ok: healthy,
      pair: PAIR_LABEL,
      protocol: PROTOCOL_VERSION,
      env: config.env,
      web: webBundlePresent ? 'ok' : 'missing',
      status: hub.status,
      clients: hub.clientCount,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      jupiter: config.jupiter.apiKey ? 'keyed' : 'lite',
    });
    return;
  }

  void serveStatic(url, res).then((served) => {
    if (served) return;
    json(res, 404, {
      error: 'not_found',
      hint: webBundlePresent
        ? 'No such path.'
        : 'apps/web/dist is empty — the build step did not run `npm run build`.',
      webRoot: config.webRoot,
    });
  });
});

const hub = new Hub(server, config.heartbeatMs);

server.listen(config.port, config.host, () => {
  console.log(
    `[collector] ${PAIR_LABEL} · http://${config.host}:${config.port} · ws /ws · jupiter=${config.jupiter.baseUrl}`,
  );
  if (!webBundlePresent) {
    console.warn(
      `[collector] WARNING: no client bundle at ${config.webRoot}. ` +
        'Run `npm run build` at the repo root. Every non-/healthz request will 404.',
    );
  }
});

const shutdown = (signal: string): void => {
  console.log(`[collector] ${signal} — shutting down`);
  void hub.close().then(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
