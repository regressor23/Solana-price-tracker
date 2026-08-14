import type { DepthSnapshot } from '@sol-warzone/protocol';

import { age, usdCompact } from '../format.js';

/**
 * C3 · WallBar — resting liquidity as a tug of war.
 *
 * The two numbers are how much money the book absorbs before the price moves
 * one percent each way, and the marker between them is their imbalance. That
 * imbalance is not a presentation choice: the collector computes
 * `bidWallUsd / (bidWallUsd + askWallUsd)` to set each side's reinforcement
 * target, so the marker and the front line in the scene are two views of one
 * number. `mirrorsFrontLine` in the tests is what keeps them that way.
 *
 * Depth arrives once a minute on the lite profile, so "old" is a normal state
 * here rather than a fault, and it is shown rather than hidden.
 */

/** Beyond this the sides are called, inside it the market is contested. */
const CONTESTED = 0.1;

/** Past this the snapshot is old enough to say so. One poll interval plus slack. */
const STALE_MS = 90_000;

export type WallVariant = 'orc-dominant' | 'nexus-dominant' | 'contested';

/**
 * −1 all orc, +1 all Nexus, 0 even.
 *
 * The same quantity the scorer works in, spelled the other way round:
 * `1 − 2 × orcShare`. A big bid wall is a market that resists being pushed
 * down, which is the orcs' half of the field.
 */
export function wallBalance(depth: DepthSnapshot): number {
  const total = depth.bidWallUsd + depth.askWallUsd;
  if (!(total > 0)) return 0;
  return (depth.askWallUsd - depth.bidWallUsd) / total;
}

export const variantFor = (balance: number): WallVariant =>
  Math.abs(balance) < CONTESTED
    ? 'contested'
    : balance < 0
      ? 'orc-dominant'
      : 'nexus-dominant';

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class WallBar {
  readonly #root: HTMLElement;
  readonly #orcValue: HTMLElement;
  readonly #nexusValue: HTMLElement;
  readonly #marker: HTMLElement;
  readonly #stamp: HTMLElement;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#root.classList.add('walls');
    this.#root.dataset['state'] = 'waiting';

    this.#orcValue = el('span', 'walls__value num');
    this.#nexusValue = el('span', 'walls__value num');
    this.#marker = el('span', 'walls__marker');
    this.#stamp = el('span', 'walls__age num');

    // Skeleton plates come from CSS on an empty element, so an unknown value is
    // a plate of the right width and never a glyph — see §C1.
    this.#orcValue.dataset['skeleton'] = 'wall';
    this.#nexusValue.dataset['skeleton'] = 'wall';

    const orc = el('div', 'walls__side walls__side--orc');
    orc.append(el('span', 'walls__label', 'ORC WALL'), this.#orcValue);

    const nexus = el('div', 'walls__side walls__side--nexus');
    nexus.append(this.#nexusValue, el('span', 'walls__label', 'NEXUS WALL'));

    const track = el('div', 'walls__track');
    track.append(this.#marker, this.#stamp);

    this.#root.replaceChildren(orc, track, nexus);
  }

  update(depth: DepthSnapshot | null, now = Date.now()): void {
    if (!depth) {
      this.#root.dataset['state'] = 'waiting';
      this.#root.dataset['variant'] = 'contested';
      this.#orcValue.textContent = '';
      this.#nexusValue.textContent = '';
      this.#stamp.textContent = '';
      this.#marker.style.setProperty('--at', '50%');
      return;
    }

    const balance = wallBalance(depth);
    const stale = now - depth.t > STALE_MS;

    this.#root.dataset['state'] = stale ? 'stale' : 'live';
    this.#root.dataset['variant'] = variantFor(balance);
    this.#orcValue.textContent = usdCompact(depth.bidWallUsd);
    this.#nexusValue.textContent = usdCompact(depth.askWallUsd);
    // Age is shown always rather than only when stale: a number that appears
    // only once something is wrong teaches nobody what normal looks like.
    this.#stamp.textContent = age(depth.t, now);
    this.#marker.style.setProperty('--at', `${(0.5 + balance / 2) * 100}%`);
  }
}
