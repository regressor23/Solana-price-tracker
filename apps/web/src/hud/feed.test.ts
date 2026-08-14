// @vitest-environment happy-dom
import type { RoundEnd, Trade } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { BattleFeed } from './feed.js';

/**
 * C5 · BattleFeed.
 *
 * The behaviour worth pinning is not "a row appears". It is the pinned whale,
 * which is the only element in the HUD whose lifetime is tied to a round rather
 * than to a clock, and which must come back into the list at its own time
 * instead of being duplicated at the top.
 */

const trade = (
  t: number,
  usd: number,
  tier: Trade['tier'] = 'heavy',
  side: Trade['side'] = 'buy',
): Trade => ({ type: 'trade', t, side, usd, price: 75.85, tier });

const round = (t: number, winner: RoundEnd['winner'] = 'orc'): RoundEnd => ({
  type: 'round',
  t,
  winner,
  orcFallen: 47,
  nexusFallen: 12,
});

function feed(): { root: HTMLElement; feed: BattleFeed } {
  const root = document.createElement('div');
  document.body.append(root);
  return { root, feed: new BattleFeed(root) };
}

const cells = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll('.feed__cell')] as HTMLElement[];

const column = (root: HTMLElement, name: string): string[] =>
  [...root.querySelectorAll(`.feed__cell--${name}`)].map((n) => n.textContent ?? '');

describe('the quiet state', () => {
  it('explains itself instead of looking unfinished', () => {
    // Whales can be an hour apart. An empty panel is a normal state and has to
    // read as a deliberate one.
    const { root } = feed();
    const empty = root.querySelector('.feed__empty') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).not.toBe('');
  });

  it('gets out of the way once there is something to show', () => {
    const { root, feed: f } = feed();
    f.add(trade(1_000, 8_000));
    expect((root.querySelector('.feed__empty') as HTMLElement).hidden).toBe(true);
  });
});

describe('rows', () => {
  it('are four flat cells, with no wrapper', () => {
    // §3.11 is explicit: columns come from a grid over a flat list of spans.
    const { root, feed: f } = feed();
    f.add(trade(1_000, 8_000));

    const list = root.querySelector('.feed__list') as HTMLElement;
    expect(list.childElementCount).toBe(4);
    expect([...list.children].every((n) => n.tagName === 'SPAN')).toBe(true);
  });

  it('put the newest first', () => {
    const { root, feed: f } = feed();
    f.add(trade(1_000, 8_000));
    f.add(trade(2_000, 9_000));
    f.add(trade(3_000, 7_000));

    expect(column(root, 'what')).toEqual([
      'Large buy $7.0K',
      'Large buy $9.0K',
      'Large buy $8.0K',
    ]);
  });

  it('carry neither the price nor an empty route column', () => {
    // Both measured: every trade in a burst sits within a thousandth of mid, and
    // `dex` was absent in 100% of live trades. A column of identical numbers and
    // a column that is always blank are two wasted nodes out of four.
    const { root, feed: f } = feed();
    f.add(trade(1_000, 8_000));

    expect(cells(root)).toHaveLength(4);
    expect(column(root, 'what')[0]).not.toContain('75.85');
    expect(column(root, 'note')).toEqual(['']);
  });

  it('show the route when there happens to be one', () => {
    const { root, feed: f } = feed();
    f.add({ ...trade(1_000, 8_000), dex: 'HumidiFi' });
    expect(column(root, 'note')).toEqual(['HumidiFi']);
  });

  it('stop at sixteen', () => {
    const { root, feed: f } = feed();
    for (let i = 0; i < 40; i++) f.add(trade(1_000 + i, 8_000));

    expect(column(root, 'time')).toHaveLength(16);
    expect((root.querySelector('.feed__list') as HTMLElement).childElementCount).toBe(
      64,
    );
  });
});

describe('a whale', () => {
  it('is pinned above the feed rather than listed in it', () => {
    const { root, feed: f } = feed();
    f.add(trade(1_000, 412_000, 'whale'));

    const slot = root.querySelector('.feed__whale') as HTMLElement;
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toContain('Whale buy $412.0K');
    expect(cells(root)).toHaveLength(0);
  });

  it('takes no room at all when there is none', () => {
    const { root } = feed();
    expect((root.querySelector('.feed__whale') as HTMLElement).hidden).toBe(true);
  });

  it('is released by the verdict, not by a timer', () => {
    // Tying it to the round means the slot is freed by something visible — the
    // verdict row arriving — instead of by an invisible sixty seconds.
    const { root, feed: f } = feed();
    f.add(trade(1_000, 412_000, 'whale'));
    f.round(round(5_000));

    expect((root.querySelector('.feed__whale') as HTMLElement).hidden).toBe(true);
  });

  it('rejoins the list at its own time, not at the top', () => {
    // Two heavies arrived while it was pinned, so the whale is now the third
    // row. Putting it back on top would be a lie about when it happened.
    const { root, feed: f } = feed();
    f.add(trade(1_000, 412_000, 'whale'));
    f.add(trade(2_000, 9_000));
    f.add(trade(3_000, 7_000));
    f.round(round(4_000));

    expect(column(root, 'what')).toEqual([
      'Orcs hold the field',
      'Large buy $7.0K',
      'Large buy $9.0K',
      'Whale buy $412.0K',
    ]);
  });

  it('is never in two places at once', () => {
    const { root, feed: f } = feed();
    f.add(trade(1_000, 412_000, 'whale'));
    f.round(round(2_000));

    const whales = column(root, 'what').filter((t) => t.startsWith('Whale'));
    expect(whales).toHaveLength(1);
    expect((root.querySelector('.feed__whale') as HTMLElement).hidden).toBe(true);
  });
});

describe('the verdict row', () => {
  it('names the winner and what it cost', () => {
    const { root, feed: f } = feed();
    f.round(round(1_000, 'nexus'));

    expect(column(root, 'what')).toEqual(['Nexus holds the field']);
    expect(column(root, 'note')).toEqual(['orcs −47 · nexus −12']);
  });

  it('has a word for a draw', () => {
    const { root, feed: f } = feed();
    f.round(round(1_000, 'draw'));
    expect(column(root, 'what')).toEqual(['Stalemate']);
  });
});

describe('ageing', () => {
  it('goes quiet rather than disappearing', () => {
    // Rows leave by being pushed out, never by getting old: a panel that
    // empties itself reads as broken.
    const { root, feed: f } = feed();
    f.add(trade(1_000, 8_000), 1_000);
    expect(cells(root)).toHaveLength(4);

    f.tick(1_000 + 11 * 60_000);

    expect(cells(root)).toHaveLength(4);
    for (const cell of cells(root)) expect(cell.dataset['aged']).toBe('true');
  });

  it('leaves fresh rows alone', () => {
    const { root, feed: f } = feed();
    f.add(trade(1_000, 8_000), 1_000);
    f.tick(1_000 + 60_000);
    for (const cell of cells(root)) expect(cell.dataset['aged']).toBe('false');
  });
});
