import http from 'node:http';

import { PAIR_LABEL, PROTOCOL_VERSION } from '@sol-warzone/protocol';

import { config } from './config.js';
import { Hub } from './hub.js';
import { createStaticServer } from './static.js';

const startedAt = Date.now();
const serveStatic = createStaticServer(config.webRoot);

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
    json(res, 200, {
      ok: true,
      pair: PAIR_LABEL,
      protocol: PROTOCOL_VERSION,
      status: hub.status,
      clients: hub.clientCount,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      jupiter: config.jupiter.apiKey ? 'keyed' : 'lite',
    });
    return;
  }

  void serveStatic(url, res).then((served) => {
    if (served) return;
    // No build output yet (or an unknown path) — say so instead of a bare 404,
    // because "did the web app build?" is the usual question here.
    json(res, 404, {
      error: 'not_found',
      hint: 'Run `npm run build` to produce apps/web/dist, then restart.',
      webRoot: config.webRoot,
    });
  });
});

const hub = new Hub(server, config.heartbeatMs);

server.listen(config.port, config.host, () => {
  console.log(
    `[collector] ${PAIR_LABEL} · http://${config.host}:${config.port} · ws /ws · jupiter=${config.jupiter.baseUrl}`,
  );
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
