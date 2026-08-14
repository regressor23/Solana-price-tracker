import type { FeedStatus, ServerMessage } from '@sol-warzone/protocol';

import { BattleStage } from './battle/stage.js';
import { Connection, type ConnectionState } from './connection.js';
import { renderDebug } from './debug.js';
import { clock, pct, usd } from './format.js';
import { LiquidityCurve } from './hud/curve.js';
import { BattleFeed } from './hud/feed.js';
import { FeedStatusBadge } from './hud/status.js';
import { WallBar } from './hud/walls.js';
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
  // The HUD is hidden by the `debug` class rather than removed, so the two
  // routes cannot drift into two different documents.
  el('hud').remove();

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
  // Main route — the battlefield. Which renderer draws it is the stage's
  // business; this side only reports which one answered, and how fast.
  // -------------------------------------------------------------------------
  const ui = {
    clock: el('clock'),
    pairLabel: el('pairLabel'),
    price: el('price'),
    tick: el('tick'),
    log: el('log'),
  };

  const badge = new FeedStatusBadge(el('status'));
  const walls = new WallBar(el('walls'));
  const curve = new LiquidityCurve(el('curveBody'));
  const battleFeed = new BattleFeed(el('feedBody'));

  const paintBadge = (detail?: string) => badge.update(state, feed, detail);

  const applyTick = (price: number, change: number) => {
    ui.price.textContent = usd(price);
    ui.tick.textContent = `${pct(change)} tick`;
    ui.tick.dataset['dir'] = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  };

  const onMessage = (message: ServerMessage): void => {
    store.apply(message);
    switch (message.type) {
      case 'hello':
        feed = message.status;
        ui.pairLabel.textContent = `${message.pair} · JUPITER AGGREGATED`;
        paintBadge(`protocol v${message.protocol}`);
        break;
      case 'status':
        feed = message.status;
        paintBadge(message.detail);
        break;
      case 'snapshot':
        feed = message.status;
        if (message.price) applyTick(message.price.price, message.price.tickChange);
        if (message.depth) {
          walls.update(message.depth);
          curve.update(message.depth);
        }
        // Oldest first, so the feed's own ordering does the sorting.
        for (const past of [...message.recentTrades].reverse()) battleFeed.add(past);
        paintBadge();
        break;
      case 'tick':
        applyTick(message.price, message.tickChange);
        break;
      case 'depth':
        walls.update(message);
        curve.update(message);
        break;

      case 'trade':
        battleFeed.add(message);
        break;

      case 'round':
        battleFeed.round(message);
        break;
      default:
        break;
    }
    const { counts } = store.state;
    ui.log.textContent =
      `ticks ${counts.tick} · trades ${counts.trade} · depth ${counts.depth}` +
      ` · ${stage.rendererKind} ${stage.fps} fps · [c] camera` +
      ` — raw feed at /debug`;
  };

  // Built before the connection so `onMessage` has a stage to report on. The
  // renderer creates its own canvas inside the scene element — which element
  // type that is follows from what the browser can run.
  const stage = new BattleStage(el('stage'), store);
  stage.start();

  const connection = new Connection({
    onMessage,
    onState: (next, detail) => {
      state = next;
      if (next !== 'open') feed = null;
      paintBadge(detail);
    },
  });

  // The clock, and the depth snapshot's age with it: depth polls once a minute,
  // so its age is the number that moves while everything else is still.
  setInterval(() => {
    ui.clock.textContent = `UTC ${clock()}`;
    walls.update(store.state.depth);
    battleFeed.tick();
  }, 1000);

  connection.open();
}
