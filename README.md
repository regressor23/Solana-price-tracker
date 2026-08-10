# SOL Warzone

Live **SOL/USDC** order flow from Jupiter, rendered as a 3D battle:
**Orcs** (red — sellers) against the **Nexus** (cyan — buyers).

Implementation plan and research notes: [PLAN.md](./PLAN.md).

## Status

**Phase 1 — live data, no graphics.** Price, liquidity curve, per-swap flow and
candles from Jupiter, broadcast over the socket. Raw readout at `/debug`. The
battlefield itself is phase 4.

## Where the data comes from

|           | Endpoint                    | Notes                                       |
| --------- | --------------------------- | ------------------------------------------- |
| Price     | `lite-api` `/price/v3`      | Deduplicated on the reported slot           |
| Liquidity | `lite-api` `/swap/v1/quote` | Ladder of quotes — Solana has no order book |
| Trades    | `datapi` `/v1/txs/{mint}`   | Real per-swap flow, free, no key            |
| Candles   | `datapi` `/v2/charts`       | 1m OHLCV, **bounds in milliseconds**        |

The liquidity curve is the order-book substitute: quoting the same SOL size in
both directions gives the average fill price each way, which has the shape of a
depth chart and describes real executable liquidity across every DEX at once.
Both legs fix the SOL amount — ExactIn selling, ExactOut buying — so the rungs
are comparable. Above roughly 100k SOL the buy leg has no route and drops out;
a partial ladder is expected, not an error.

Trade flow covers SOL against everything rather than SOL/USDC alone. The
endpoint has no pool filter and the pool registry resolves only a fraction of
the venues carrying flow, so the HUD says "aggregated" — as the reference does.

**The rate limit is the binding constraint**, and a free API key does not lift
it. Jupiter allows 0.5 RPS keyless, 1 RPS on the free plan, and 10 RPS on the
paid Developer tier. Measured keyless `lite-api` sustains ~60/min and 429s at
~125 — which is the free plan's 1 RPS, so a free key buys nothing. One liquidity
ladder costs 18 requests.

The cadence therefore comes from `JUPITER_PLAN`, not from whether a key exists:
`free`/`keyless` get price every 2s and a ladder every 45s, `developer` and up
get 1s and 10s. If the keyed host throttles below what the keyless one sustains,
or rejects the key outright, the collector falls back on its own and says why in
`/api/diagnostics`.

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
Binance, which is free and unmetered. Jupiter is not: one liquidity ladder is 18
quote requests against a ceiling of about 60 a minute, so a handful of visitors
doing it themselves would be throttled within seconds. One collector makes the
requests once and broadcasts the result. See PLAN.md §7.

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

No API keys are needed to run it. Copy `.env.example` to `.env` and set
`JUPITER_API_KEY` to lift the rate ceiling — everything still works without it,
just at a slower cadence.

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
`npm start`, health-gated on `/healthz`. Set `JUPITER_API_KEY` as a service
variable to run the faster cadence.

`/healthz` returns 503 when `NODE_ENV=production` and no client bundle is
present. A collector with nothing to serve is not healthy, and failing the gate
is better than passing it and then 404ing every visitor.

## Licence

MIT. Third-party 3D assets keep their own licences — see PLAN.md §8 step 27.
