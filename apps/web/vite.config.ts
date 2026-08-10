import { defineConfig } from 'vite';

const COLLECTOR = process.env['COLLECTOR_URL'] ?? 'http://localhost:8080';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js and the renderer land in phase 4; keep them out of the entry.
    chunkSizeWarningLimit: 900,
  },
  server: {
    // In production the collector serves this bundle from its own origin, so
    // the client always talks to a same-origin /ws. Proxying keeps dev identical.
    proxy: {
      '/ws': { target: COLLECTOR, ws: true },
      '/healthz': { target: COLLECTOR },
    },
  },
});
