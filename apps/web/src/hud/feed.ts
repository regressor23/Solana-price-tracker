import type { RoundEnd, Trade } from '@sol-warzone/protocol';

import { clock, num, usdCompact } from '../format.js';

/**
 * C5 · BattleFeed — the events worth reading, and only those.
 *
 * The raw stream is ~4.5 trades a second with a median of $755, arriving in
 * bursts of four to six that all share one timestamp. A feed showing every
 * trade is an unreadable waterfall with a column of identical clocks, so only
 * `heavy` and above reach it — one or two a minute — and the collector already
 * sends nothing else individually.
 *
 * Sixteen rows is therefore about ten minutes of history, which is why there is
 * no virtualisation here: at this rate it would add machinery and buy nothing.
 *
 * Rows are four flat spans in a grid with no wrapper, per §3.11. That shapes
 * the code more than it looks: ageing a row means touching its four spans
 * rather than one parent, and the rows are kept as records so nothing has to be
 * read back out of the DOM.
 */

/** Rows kept. Ten minutes of heavy flow, and more than the panel can show. */
const MAX_ROWS = 16;

/** Past this a row stops being news and goes quiet. */
const AGED_MS = 600_000;

const COLUMNS = 4;

type Entry =
  | { readonly kind: 'trade'; readonly at: number; readonly trade: Trade }
  | { readonly kind: 'round'; readonly at: number; readonly round: RoundEnd };

interface Row {
  readonly entry: Entry;
  readonly cells: HTMLElement[];
  aged: boolean;
}

const span = (className: string, text: string): HTMLElement => {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
};

/** What a trade says in the feed, without its price. */
function describe(trade: Trade): string {
  const size = trade.tier === 'whale' ? 'Whale' : 'Large';
  return `${size} ${trade.side} ${usdCompact(trade.usd)}`;
}

/**
 * The fourth column.
 *
 * Not the trade's price: measured, every trade in a burst sits within a
 * thousandth of the header's mid, so it would be a column of the same number.
 * Not a `dex` column either — it was absent in 100% of live trades, and a
 * column that is always empty is a wasted node from a budget of four. It goes
 * in here as a suffix when it happens to exist.
 */
const noteFor = (entry: Entry): string =>
  entry.kind === 'round'
    ? `orcs −${num(entry.round.orcFallen)} · nexus −${num(entry.round.nexusFallen)}`
    : (entry.trade.dex ?? '');

const verdictFor = (round: RoundEnd): string =>
  round.winner === 'draw'
    ? 'Stalemate'
    : round.winner === 'orc'
      ? 'Orcs hold the field'
      : 'Nexus holds the field';

export class BattleFeed {
  readonly #root: HTMLElement;
  readonly #list: HTMLElement;
  readonly #whale: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #rows: Row[] = [];

  /** The whale on show above the feed, and out of the list while it is. */
  #pinned: Trade | null = null;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#root.classList.add('feed');

    this.#whale = document.createElement('div');
    this.#whale.className = 'feed__whale num';
    this.#whale.hidden = true;

    this.#list = document.createElement('div');
    this.#list.className = 'feed__list num';
    // A log rather than a status: additions are the news, and only additions.
    this.#list.setAttribute('role', 'log');
    this.#list.setAttribute('aria-live', 'polite');
    this.#list.setAttribute('aria-relevant', 'additions');

    this.#empty = document.createElement('p');
    this.#empty.className = 'feed__empty';
    this.#empty.textContent = 'No heavy flow yet — the market is quiet.';

    this.#root.replaceChildren(this.#whale, this.#list, this.#empty);
  }

  /**
   * A trade the collector thought worth sending on its own.
   *
   * A whale goes to the pinned slot instead of the list, and stays there until
   * the round ends. Not "for sixty seconds": tying it to the round means the
   * slot is freed by something the viewer can see happening — the verdict row
   * arriving — rather than by an invisible timer.
   */
  add(trade: Trade, now = Date.now()): void {
    if (trade.tier === 'whale') {
      this.#pinned = trade;
      this.#whale.hidden = false;
      this.#whale.textContent = `${describe(trade)} · ${clock(trade.t)}`;
      this.#whale.dataset['side'] = trade.side;
      return;
    }
    this.#insert({ kind: 'trade', at: trade.t, trade }, now);
  }

  /** The verdict, and with it the release of whatever whale was pinned. */
  round(round: RoundEnd, now = Date.now()): void {
    const released = this.#pinned;
    this.#pinned = null;
    this.#whale.hidden = true;

    // The whale goes in at its own time, which by now may be several rows down.
    // Duplicating it into the top instead would break both `aria-live` and the
    // meaning of "the last N events".
    if (released) this.#insert({ kind: 'trade', at: released.t, trade: released }, now);
    this.#insert({ kind: 'round', at: round.t, round }, now);
  }

  /**
   * Re-read the ages.
   *
   * Rows are never dropped for being old — only for being pushed out — because
   * a panel that empties itself reads as broken. They go quiet instead, and
   * lose their faction colour with it: the battle colours belong to the
   * present, and §9 already carries the side in the text.
   */
  tick(now = Date.now()): void {
    for (const row of this.#rows) {
      const aged = now - row.entry.at > AGED_MS;
      if (aged === row.aged) continue;
      row.aged = aged;
      for (const cell of row.cells) cell.dataset['aged'] = String(aged);
    }
  }

  #insert(entry: Entry, now: number): void {
    const cells = this.#cellsFor(entry);
    // Chronological, not always at the top: a released whale is older than the
    // rows that arrived while it was pinned.
    const at = this.#rows.findIndex((row) => row.entry.at <= entry.at);
    const index = at === -1 ? this.#rows.length : at;

    const before = this.#rows[index]?.cells[0] ?? null;
    for (const cell of cells) this.#list.insertBefore(cell, before);

    this.#rows.splice(index, 0, { entry, cells, aged: false });
    this.#trim();
    this.tick(now);
    this.#empty.hidden = this.#rows.length > 0;
  }

  #cellsFor(entry: Entry): HTMLElement[] {
    const isRound = entry.kind === 'round';
    const cells = [
      span('feed__cell feed__cell--time', clock(entry.at)),
      span(
        'feed__cell feed__cell--what',
        isRound ? verdictFor(entry.round) : describe(entry.trade),
      ),
      span('feed__cell feed__cell--tier', isRound ? '' : entry.trade.tier),
      span('feed__cell feed__cell--note', noteFor(entry)),
    ];

    for (const cell of cells) {
      cell.dataset['kind'] = entry.kind;
      // Written from the start rather than on the first change, so the state is
      // always readable in the DOM and CSS can key off either value.
      cell.dataset['aged'] = 'false';
      if (entry.kind === 'trade') {
        cell.dataset['side'] = entry.trade.side;
        cell.dataset['tier'] = entry.trade.tier;
      } else {
        cell.dataset['winner'] = entry.round.winner;
      }
    }
    return cells;
  }

  #trim(): void {
    while (this.#rows.length > MAX_ROWS) {
      const dropped = this.#rows.pop();
      for (const cell of dropped?.cells ?? []) cell.remove();
    }
    // Cheap invariant, and the one that would break first if a column were
    // added: the grid has four tracks, so the node count must stay a multiple.
    if (this.#list.childElementCount !== this.#rows.length * COLUMNS) {
      this.#list.replaceChildren(...this.#rows.flatMap((row) => row.cells));
    }
  }
}
