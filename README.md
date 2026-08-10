# SOL Warzone

Live **SOL/USDC** order flow from Jupiter, rendered as a 3D battle:
**Orcs** (red — sellers) against the **Nexus** (cyan — buyers).

Implementation plan and research notes: [PLAN.md](./PLAN.md).

## Status

**Phase 0 — scaffold.** Monorepo, shared wire contract, WebSocket transport,
Railway deploy. No market data and no battlefield yet; those are phases 1 and 4.

## Layout

```
packages/protocol   wire contract shared by both sides — events, balance constants
apps/collector      the only process that talks to Jupiter; serves the web build
                    and fans data out over /ws
apps/web            Vite + TypeScript client (three.js lands in phase 4)
```

One Railway service runs the collector, which also serves `apps/web/dist`.
Single origin means no CORS and no cross-origin WebSocket to configure.

## Why a backend at all

The reference implementation this is modelled on connects browsers straight to
Binance, which is free and unmetered. Jupiter is not: a depth ladder is 24 quote
requests, so 1000 visitors doing that themselves would be banned within seconds.
One collector makes the requests once and broadcasts the result. See PLAN.md §7.

## Local development

```bash
npm install
npm run build          # protocol -> web -> collector
npm start              # http://localhost:8080
```

Two-process mode with hot reload for the client:

```bash
npm run dev            # collector on :8080, watch mode
npm run dev:web        # Vite on :5173, proxies /ws to the collector
```

No API keys are needed. Copy `.env.example` to `.env` to raise the polling rate
or enable the per-swap feed.

## Checks

```bash
npm run check          # format + lint + typecheck + test
```

## Deploy

Railway builds from `railway.json` with Nixpacks: `npm run build` then
`npm start`, health-gated on `/healthz`. Set `JUPITER_API_KEY` and
`HELIUS_API_KEY` as service variables when you want the faster feeds.

## Licence

MIT. Third-party 3D assets keep their own licences — see PLAN.md §8 step 27.
