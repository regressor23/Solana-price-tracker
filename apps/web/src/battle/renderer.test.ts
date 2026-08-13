// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketStore } from '../store.js';
import { hasWebGL } from './renderer.js';
import { BattleStage } from './stage.js';

/**
 * Which renderer the browser gets, and what happens when the answer is wrong.
 *
 * This is the path that is never exercised where it is written and always
 * exercised on somebody else's machine. Every case here is one a developer
 * cannot reproduce on purpose: no WebGL at all, WebGL that the probe finds and
 * the constructor then refuses, and a context taken away mid-session.
 */

/** Enough of a 2D context for the fallback to be constructed, not to draw. */
const fake2d = (): CanvasRenderingContext2D =>
  ({ setTransform: () => undefined }) as unknown as CanvasRenderingContext2D;

function stubContexts(handler: (kind: string) => unknown): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    // The real signature is a pile of overloads; the tests only care about the
    // string that comes in and the object that comes back.
    ((kind: string) => handler(kind)) as HTMLCanvasElement['getContext'],
  );
}

const host = (): HTMLElement => document.createElement('section');

const canvases = (element: HTMLElement): number =>
  element.querySelectorAll('canvas').length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasWebGL', () => {
  it('says no when the browser hands back nothing', () => {
    stubContexts(() => null);
    expect(hasWebGL()).toBe(false);
  });

  it('says yes on either WebGL version', () => {
    stubContexts((kind) => (kind === 'webgl2' ? {} : null));
    expect(hasWebGL()).toBe(true);

    stubContexts((kind) => (kind === 'webgl' ? {} : null));
    expect(hasWebGL()).toBe(true);
  });

  it('treats a thrown context as an absent one', () => {
    // Some hardened privacy modes throw rather than return null, and an
    // exception here would take down the whole page instead of one renderer.
    stubContexts(() => {
      throw new Error('blocked');
    });
    expect(hasWebGL()).toBe(false);
  });
});

describe('the stage', () => {
  it('draws in 2D when there is no 3D to be had', () => {
    stubContexts((kind) => (kind === '2d' ? fake2d() : null));
    const element = host();

    const stage = new BattleStage(element, new MarketStore(), { webgl: false });

    expect(stage.rendererKind).toBe('canvas2d');
    expect(canvases(element)).toBe(1);
  });

  it('falls back when the probe was more optimistic than the driver', () => {
    // The probe canvas succeeds and the real one does not — a combination that
    // happens for real when the GPU process is already out of contexts.
    stubContexts((kind) => (kind === '2d' ? fake2d() : null));
    const element = host();

    const stage = new BattleStage(element, new MarketStore(), { webgl: true });

    expect(stage.rendererKind).toBe('canvas2d');
    // And exactly one canvas: the 3D attempt has to take its element with it,
    // or a blank, absolutely-positioned canvas sits over the battle for the
    // rest of the session.
    expect(canvases(element)).toBe(1);
  });

  it('reports frames per second before it has drawn any', () => {
    // The status line reads this on the first message, which can arrive before
    // the first frame. A zero or a NaN there is a bug report about performance.
    stubContexts((kind) => (kind === '2d' ? fake2d() : null));
    const stage = new BattleStage(host(), new MarketStore(), { webgl: false });

    expect(stage.fps).toBeGreaterThan(0);
    expect(Number.isFinite(stage.fps)).toBe(true);
  });

  it('cycles the camera through every preset and back', () => {
    stubContexts((kind) => (kind === '2d' ? fake2d() : null));
    const stage = new BattleStage(host(), new MarketStore(), { webgl: false });

    // Harmless on the 2D renderer, which has no camera — but the stage must
    // not care which one is listening, or the fallback becomes a special case.
    const seen = new Set([stage.preset]);
    for (let i = 0; i < 3; i++) {
      stage.cyclePreset();
      seen.add(stage.preset);
    }
    expect(seen.size).toBe(3);
    expect(stage.preset).toBe('tactical');
  });
});
