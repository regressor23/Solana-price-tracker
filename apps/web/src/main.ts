import type { FeedStatus, ServerMessage } from '@sol-warzone/protocol';

import { Connection, badgeFor, type ConnectionState } from './connection.js';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const ui = {
  clock: el('clock'),
  pairLabel: el('pairLabel'),
  price: el('price'),
  tick: el('tick'),
  status: el('status'),
  log: el('log'),
  stageNote: el('stageNote'),
};

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

let state: ConnectionState = 'closed';
let feed: FeedStatus | null = null;

function paintBadge(detail?: string): void {
  const badge = badgeFor(state, feed);
  ui.status.textContent = badge.text;
  ui.status.dataset['status'] = badge.tone;
  if (detail) ui.log.textContent = detail;
}

function onMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'hello':
      feed = message.status;
      ui.pairLabel.textContent = `${message.pair} · JUPITER`;
      paintBadge(`connected · protocol v${message.protocol}`);
      break;

    case 'status':
      feed = message.status;
      paintBadge(message.detail);
      break;

    case 'snapshot':
      feed = message.status;
      if (message.price) applyTick(message.price.price, message.price.tickChange);
      paintBadge(`snapshot · ${message.candles.length} candles`);
      break;

    case 'tick':
      applyTick(message.price, message.tickChange);
      break;

    // Trades, depth and rounds arrive from phase 1 onward; the battle
    // simulation consumes them, not this placeholder HUD.
    default:
      break;
  }
}

function applyTick(price: number, change: number): void {
  ui.price.textContent = usd.format(price);
  ui.tick.textContent = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(3)}% tick`;
  ui.tick.dataset['dir'] = change >= 0 ? 'up' : 'down';
}

const connection = new Connection({
  onMessage,
  onState: (next, detail) => {
    state = next;
    if (next !== 'open') feed = null;
    paintBadge(detail);
  },
});

setInterval(() => {
  ui.clock.textContent = `UTC ${new Date().toISOString().slice(11, 19)}`;
}, 1000);

ui.stageNote.textContent = 'Phase 0 — transport only. Battlefield lands in phase 4.';
connection.open();
