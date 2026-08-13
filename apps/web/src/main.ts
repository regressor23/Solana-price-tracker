import type { FeedStatus, ServerMessage } from '@sol-warzone/protocol';

import { BattleStage } from './battle/stage.js';
import { Connection, badgeFor, type ConnectionState } from './connection.js';
import { renderDebug } from './debug.js';
import { clock, pct, usd } from './format.js';
import { MarketStore } from './store.js';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const isDebugRoute = location.pathname.replace(/\/+$/, '') === '/debug';

const store = new MarketStore();
let state: ConnectionState = 'closed';
let feed: FeedStatus | null = null;

// ---------------------------------------------------------------------------
// Debug route — raw feed readout, phase 1's deliverable.
// ---------------------------------------------------------------------------

if (isDebugRoute) {
  document.body.classList.add('debug');
  const root = el('stage');
  root.replaceChildren();
  el('topbar').remove();
  el('statusbar').remove();

  const paint = () => renderDebug(root, store, state);

  const connection = new Connection({
    onMessage: (message) => {
      store.apply(message);
      paint();
    },
    onState: (next) => {
      state = next;
      if (next !== 'open') store.reset();
      paint();
    },
  });

  // Ages and the clock must keep moving even when the feed goes quiet.
  setInterval(paint, 1000);
  paint();
  connection.open();
} else {
  // -------------------------------------------------------------------------
  // Main route — the 2D battlefield prototype (phase 3). 3D lands in phase 4.
  // -------------------------------------------------------------------------
  const ui = {
    clock: el('clock'),
    pairLabel: el('pairLabel'),
    price: el('price'),
    tick: el('tick'),
    status: el('status'),
    log: el('log'),
    stageNote: el('stageNote'),
  };

  const paintBadge = (detail?: string) => {
    const badge = badgeFor(state, feed);
    ui.status.textContent = badge.text;
    ui.status.dataset['status'] = badge.tone;
    if (detail) ui.log.textContent = detail;
  };

  const applyTick = (price: number, change: number) => {
    ui.price.textContent = usd(price);
    ui.tick.textContent = `${pct(change)} tick`;
    ui.tick.dataset['dir'] = change >= 0 ? 'up' : 'down';
  };

  const onMessage = (message: ServerMessage): void => {
    store.apply(message);
    switch (message.type) {
      case 'hello':
        feed = message.status;
        ui.pairLabel.textContent = `${message.pair} · JUPITER AGGREGATED`;
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
      default:
        break;
    }
    const { counts } = store.state;
    ui.log.textContent =
      `ticks ${counts.tick} · trades ${counts.trade} · depth ${counts.depth}` +
      ` — raw feed at /debug`;
  };

  const connection = new Connection({
    onMessage,
    onState: (next, detail) => {
      state = next;
      if (next !== 'open') feed = null;
      paintBadge(detail);
    },
  });

  setInterval(() => {
    ui.clock.textContent = `UTC ${clock()}`;
  }, 1000);

  // The canvas replaces the placeholder note rather than sitting beside it.
  const canvas = document.createElement('canvas');
  canvas.className = 'battlefield';
  ui.stageNote.replaceWith(canvas);
  new BattleStage(canvas, store).start();

  connection.open();
}
