// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { FeedStatusBadge } from './status.js';

/**
 * C2 · FeedStatusBadge.
 *
 * The badge is the only thing on the page that says whether the numbers can be
 * trusted, so its failure mode is the worst kind: it keeps saying `live` while
 * the feed is anything but. What is checked here is that every state reaches
 * the DOM, that the reason slot never changes the layout, and that the one
 * unrecoverable state cannot be talked over by a later socket event.
 */

function badge(): { root: HTMLElement; badge: FeedStatusBadge } {
  const root = document.createElement('div');
  document.body.append(root);
  return { root, badge: new FeedStatusBadge(root) };
}

const text = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)?.textContent ?? '';

describe('the six states', () => {
  it('reports the transport before it reports the feed', () => {
    // A feed status from before the socket dropped would be a stale claim about
    // data that is no longer arriving.
    const { root, badge: b } = badge();

    b.update('connecting', null);
    expect(root.dataset['status']).toBe('offline');
    expect(text(root, '.feed-state__value')).toBe('connecting');

    b.update('closed', 'live');
    expect(root.dataset['status']).toBe('offline');
  });

  it('reports the feed once the socket is open', () => {
    const { root, badge: b } = badge();

    b.update('open', null);
    expect(root.dataset['status']).toBe('sync');

    for (const status of ['live', 'sync', 'degraded', 'demo'] as const) {
      b.update('open', status);
      expect(root.dataset['status']).toBe(status);
      expect(text(root, '.feed-state__value')).toBe(status);
    }
  });
});

describe('the reason slot', () => {
  it('exists whether or not there is a reason', () => {
    // Reserved always: a slot that appears and vanishes would shove the price
    // sideways every time the feed hiccuped.
    const { root, badge: b } = badge();
    b.update('open', 'live');
    expect(root.querySelector('.feed-state__detail')).not.toBeNull();
    expect(text(root, '.feed-state__detail')).toBe('');
  });

  it('carries the reason when there is one', () => {
    const { root, badge: b } = badge();
    b.update('closed', null, 'retrying in 1.5s');
    expect(text(root, '.feed-state__detail')).toBe('retrying in 1.5s');
  });

  it('stays empty on live, whatever it is handed', () => {
    // Live has nothing to explain, and an explanation there reads as a warning
    // about a feed that is working.
    const { root, badge: b } = badge();
    b.update('open', 'live', 'protocol v1');
    expect(text(root, '.feed-state__detail')).toBe('');
  });
});

describe('a protocol mismatch', () => {
  it('cannot be talked over by whatever the socket does next', () => {
    // The socket is closed for good and the bundle is the wrong one. Every
    // later transport event would otherwise overwrite the only message that
    // matters with a hopeful "connecting".
    const { root, badge: b } = badge();
    b.fatal('server is newer — reload');

    expect(root.dataset['status']).toBe('fatal');

    b.update('connecting', null);
    b.update('open', 'live');

    expect(root.dataset['status']).toBe('fatal');
    expect(text(root, '.feed-state__detail')).toBe('server is newer — reload');
  });
});

describe('assistive technology', () => {
  it('announces changes without stealing focus', () => {
    const { root } = badge();
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-live')).toBe('polite');
  });
});
