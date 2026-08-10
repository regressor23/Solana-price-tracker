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

CI runs the same thing on every push and pull request, then builds, then boots
the production server and smoke-tests it.

`check` compiles `packages/protocol` first. Type-aware linting and the tests
both resolve that package through its `dist/`, so on a fresh clone every rule
that needs type information would otherwise fail with "type that cannot be
resolved" rather than a real finding.

Use `npm run clean` rather than deleting `dist` by hand. `tsc --build` trusts
its `.tsbuildinfo`, so after a manual `rm -rf dist` it decides the project is
already current and emits nothing — leaving you debugging an empty directory.

## Build order

`packages/protocol` compiles to `dist/` and both apps import it from there, so
it has to be built first. Each package declares that itself via a `prebuild`
hook rather than relying on the root script, which means any of these work:

```bash
npm run build                                  # root, builds everything
npm run build --workspace=@sol-warzone/web     # pulls in protocol
npm run build --workspace=@sol-warzone/collector   # pulls in protocol + web
```

That matters because a platform that auto-detects workspaces will pick one of
the scoped commands on its own. Protocol may compile more than once in a
cascade; `tsc --build` is incremental, so the repeats are no-ops.

## Deploy

**One Railway service, not two.** The collector serves the client bundle from
its own origin, so a separate web service is redundant — and splitting them
would mean cross-origin WebSocket and CORS for no gain.

Railway builds from `railway.json` with Nixpacks: `npm run build`, then
`npm start`, health-gated on `/healthz`. Set `JUPITER_API_KEY` and
`HELIUS_API_KEY` as service variables when you want the faster feeds.

`/healthz` returns 503 when `NODE_ENV=production` and no client bundle is
present. A collector with nothing to serve is not healthy, and failing the gate
is better than passing it and then 404ing every visitor.

## Licence

MIT. Third-party 3D assets keep their own licences — see PLAN.md §8 step 27.
