import type { DepthRung } from '@sol-warzone/protocol';

import type { ConnectionState } from './connection.js';
import { age, clock, num, pct, usd, usdCompact } from './format.js';
import type { MarketStore } from './store.js';

/**
 * Raw feed readout — phase 1's whole deliverable.
 *
 * Its job is to make bad data obvious before any of it drives a battle: if the
 * numbers here look wrong, the problem is upstream, and if they look right but
 * the battlefield does not, the problem is the simulation. Kept deliberately
 * unstyled beyond monospace and alignment.
 */

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function section(title: string): HTMLElement {
  const node = el('section', 'dbg__section');
  node.append(el('h2', 'dbg__title', title));
  return node;
}

function rows(pairs: [string, string, string?][]): HTMLElement {
  const table = el('div', 'dbg__rows');
  for (const [label, value, tone] of pairs) {
    const row = el('div', 'dbg__row');
    row.append(el('span', 'dbg__label', label));
    const valueNode = el('span', 'dbg__value', value);
    if (tone) valueNode.dataset['tone'] = tone;
    row.append(valueNode);
    table.append(row);
  }
  return table;
}

const toneFor = (value: number): string =>
  value > 0 ? 'up' : value < 0 ? 'down' : 'flat';

function ladder(title: string, rungs: readonly DepthRung[]): HTMLElement {
  const node = section(title);
  const table = el('div', 'dbg__ladder');
  table.append(
    el('span', 'dbg__lh', 'SIZE'),
    el('span', 'dbg__lh', 'NOTIONAL'),
    el('span', 'dbg__lh', 'AVG PRICE'),
    el('span', 'dbg__lh', 'IMPACT'),
  );
  for (const rung of rungs) {
    table.append(
      el('span', '', `${num(rung.sizeSol)} SOL`),
      el('span', '', usdCompact(rung.usd)),
      el('span', '', rung.avgPrice.toFixed(4)),
      el('span', '', pct(rung.impactPct, 3)),
    );
  }
  node.append(table);
  return node;
}

export function renderDebug(
  root: HTMLElement,
  store: MarketStore,
  connection: ConnectionState,
  now = Date.now(),
): void {
  const s = store.state;
  root.replaceChildren();

  const header = el('header', 'dbg__header');
  header.append(
    el('span', '', `UTC ${clock(now)}`),
    el('span', '', `${s.pair} · JUPITER AGGREGATED`),
    el('span', 'dbg__badge', `${connection} / ${s.status ?? '—'}`),
  );
  root.append(header);

  const grid = el('div', 'dbg__grid');

  // ---- price -------------------------------------------------------------
  const price = section('PRICE');
  price.append(
    rows(
      s.price
        ? [
            ['last', usd(s.price.price)],
            ['tick', pct(s.price.tickChange), toneFor(s.price.tickChange)],
            ['24h', pct(s.price.change24h, 2), toneFor(s.price.change24h)],
            ['slot', String(s.price.blockId)],
            ['age', age(s.price.t, now)],
          ]
        : [['last', 'waiting…']],
    ),
  );
  grid.append(price);

  // ---- depth -------------------------------------------------------------
  const depth = section('LIQUIDITY');
  depth.append(
    rows(
      s.depth
        ? [
            ['mid', s.depth.mid.toFixed(4)],
            ['bid wall (−1%)', usdCompact(s.depth.bidWallUsd), 'down'],
            ['ask wall (+1%)', usdCompact(s.depth.askWallUsd), 'up'],
            [
              'imbalance',
              pct(
                (s.depth.askWallUsd - s.depth.bidWallUsd) /
                  Math.max(1, s.depth.askWallUsd + s.depth.bidWallUsd),
                1,
              ),
            ],
            ['age', age(s.depth.t, now)],
          ]
        : [['mid', 'waiting…']],
    ),
  );
  grid.append(depth);

  // ---- flow --------------------------------------------------------------
  const flow = section('FLOW (since connect)');
  flow.append(
    rows([
      ['buy volume', usdCompact(s.buyUsd), 'up'],
      ['sell volume', usdCompact(s.sellUsd), 'down'],
      ['net', usdCompact(store.netUsd), toneFor(store.netUsd)],
      ['trades', String(s.counts.trade)],
      ['ticks', String(s.counts.tick)],
      ['depth snapshots', String(s.counts.depth)],
      ['last message', age(s.lastMessageAt, now)],
    ]),
  );
  grid.append(flow);

  // ---- candles -----------------------------------------------------------
  const candles = section('CANDLES (1m)');
  const volumes = s.candles.map((c) => c.volume);
  candles.append(
    rows(
      s.candles.length
        ? [
            ['count', String(s.candles.length)],
            ['last close', (s.candles.at(-1)?.close ?? 0).toFixed(4)],
            [
              'mean volume/min',
              usdCompact(volumes.reduce((a, b) => a + b, 0) / volumes.length),
            ],
            ['max volume/min', usdCompact(Math.max(...volumes))],
          ]
        : [['count', 'waiting…']],
    ),
  );
  grid.append(candles);

  root.append(grid);

  if (s.depth) {
    const ladders = el('div', 'dbg__grid');
    ladders.append(ladder('BID LADDER (selling)', s.depth.bids));
    ladders.append(ladder('ASK LADDER (buying)', s.depth.asks));
    root.append(ladders);
  }

  // ---- trades ------------------------------------------------------------
  const trades = section(`TRADES (${s.trades.length})`);
  const list = el('div', 'dbg__trades');
  for (const trade of s.trades.slice(0, 25)) {
    const row = el('div', 'dbg__trade');
    row.dataset['side'] = trade.side;
    row.dataset['tier'] = trade.tier;
    row.append(
      el('span', '', clock(trade.t)),
      el('span', '', trade.side.toUpperCase()),
      el('span', '', usdCompact(trade.usd)),
      el('span', '', trade.price.toFixed(4)),
      el('span', '', trade.tier === 'normal' ? '' : trade.tier.toUpperCase()),
    );
    list.append(row);
  }
  if (s.trades.length === 0) list.append(el('div', '', 'waiting…'));
  trades.append(list);
  root.append(trades);
}
