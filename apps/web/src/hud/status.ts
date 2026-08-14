import type { FeedStatus } from '@sol-warzone/protocol';

import { badgeFor, type ConnectionState } from '../connection.js';

/**
 * C2 · FeedStatusBadge — how much the numbers can be trusted.
 *
 * Six end states, and each one carries a **shape** as well as a colour, because
 * §9 does not allow colour to be the only carrier and because two of the six
 * share a colour anyway: `degraded` and `demo` are both the orc red.
 *
 * The reason slot is always reserved and only sometimes filled. Letting it
 * appear and disappear would shove the price sideways every time the feed
 * hiccuped, which is exactly when nobody wants the layout moving.
 */

/** What the badge can say, after transport and feed status are folded together. */
export type BadgeTone = FeedStatus | 'connecting' | 'offline' | 'fatal';

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class FeedStatusBadge {
  readonly #root: HTMLElement;
  readonly #value: HTMLElement;
  readonly #detail: HTMLElement;
  #fatal = false;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#root.classList.add('feed-state');
    // A live region, so a feed going degraded is announced without stealing
    // focus. `polite` and not `assertive`: it is news, not an emergency.
    this.#root.setAttribute('role', 'status');
    this.#root.setAttribute('aria-live', 'polite');

    this.#value = el('span', 'feed-state__value');
    this.#detail = el('span', 'feed-state__detail');

    this.#root.replaceChildren(
      el('span', 'feed-state__label', 'FEED'),
      this.#value,
      this.#detail,
    );
  }

  /**
   * The one state the transport cannot recover from: the server is newer than
   * this bundle. Sticky, because every later socket event would otherwise talk
   * over the only message that matters.
   */
  fatal(reason: string): void {
    this.#fatal = true;
    this.#paint('fatal', 'reload', reason);
  }

  update(state: ConnectionState, feed: FeedStatus | null, detail?: string): void {
    if (this.#fatal) return;
    const badge = badgeFor(state, feed);
    this.#paint(badge.tone as BadgeTone, badge.text, detail);
  }

  #paint(tone: BadgeTone, text: string, detail?: string): void {
    this.#root.dataset['status'] = tone;
    this.#value.textContent = text;
    // Live is the only state with nothing to explain. Anything else that has no
    // detail still keeps the empty slot, so the row height never changes.
    this.#detail.textContent = tone === 'live' ? '' : (detail ?? '');
  }
}
