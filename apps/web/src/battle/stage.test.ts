// @vitest-environment happy-dom
import type { Pulse } from '@sol-warzone/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketStore } from '../store.js';
import type { BattleField } from './field.js';
import type { FieldRenderer } from './renderer.js';
import { BattleStage } from './stage.js';

/**
 * The render loop.
 *
 * The only part of the client that cannot be checked by looking at it. It runs
 * exactly where there is an animation frame, and every state worth checking is
 * one a browser will not produce on request: the same pulse arriving twice, a
 * tab coming back after a minute in the background, a GPU context taken away
 * mid-session. So the frame clock is driven by hand here, and the renderer is a
 * stand-in that writes down what it was asked to draw.
 */

interface Draw {
  field: BattleField;
  dtSec: number;
}

class FakeRenderer implements FieldRenderer {
  readonly kind = 'webgl';
  readonly draws: Draw[] = [];
  readonly sizes: [number, number][] = [];
  disposed = 0;

  draw(field: BattleField, dtSec: number): void {
    this.draws.push({ field, dtSec });
  }

  resize(width: number, height: number): void {
    this.sizes.push([width, height]);
  }

  dispose(): void {
    this.disposed++;
  }
}

/** A hand-cranked `requestAnimationFrame`, so a frame happens when the test says. */
function frameClock() {
  let pending: FrameRequestCallback | null = null;
  let now = 0;

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pending = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = null;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);

  return {
    /** Let `ms` pass and run the frame that was waiting for it. */
    tick(ms: number): void {
      now += ms;
      const callback = pending;
      pending = null;
      callback?.(now);
    },
    frames(count: number, ms = 1_000 / 60): void {
      for (let i = 0; i < count; i++) this.tick(ms);
    },
    get scheduled(): boolean {
      return pending !== null;
    },
  };
}

/** Enough of a 2D context for the real fallback to be built, not to draw. */
const fake2d = (): CanvasRenderingContext2D =>
  ({
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
  }) as unknown as CanvasRenderingContext2D;

function host(width = 1280, height = 720): HTMLElement {
  const element = document.createElement('section');
  Object.defineProperty(element, 'clientWidth', { value: width });
  Object.defineProperty(element, 'clientHeight', { value: height });
  document.body.append(element);
  return element;
}

const pulse = (t: number, orcAlive: number, nexusAlive = 200): Pulse => ({
  type: 'pulse',
  t,
  orcAlive,
  nexusAlive,
  frontLine: 0,
});

let clock: ReturnType<typeof frameClock>;

beforeEach(() => {
  clock = frameClock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function stageWith(renderer: FieldRenderer, store = new MarketStore()) {
  const element = host();
  const stage = new BattleStage(element, store, { createRenderer: () => renderer });
  return { stage, store, element };
}

describe('the loop', () => {
  it('draws once a frame, in seconds', () => {
    const renderer = new FakeRenderer();
    const { stage } = stageWith(renderer);
    stage.start();

    clock.frames(3, 16);

    expect(renderer.draws).toHaveLength(3);
    for (const draw of renderer.draws) expect(draw.dtSec).toBeCloseTo(0.016);
  });

  it('keeps asking for the next frame', () => {
    const { stage } = stageWith(new FakeRenderer());
    stage.start();
    clock.frames(5);
    expect(clock.scheduled).toBe(true);
  });

  it('starts once, however many times it is asked', () => {
    // Two chains would double the step and halve the apparent frame time.
    const renderer = new FakeRenderer();
    const { stage } = stageWith(renderer);
    stage.start();
    stage.start();

    clock.frames(2, 16);
    expect(renderer.draws).toHaveLength(2);
  });

  it('stops', () => {
    const renderer = new FakeRenderer();
    const { stage } = stageWith(renderer);
    stage.start();
    clock.frames(2);
    stage.stop();
    clock.frames(2);

    expect(renderer.draws).toHaveLength(2);
    expect(clock.scheduled).toBe(false);
  });

  it('advances a long stall once rather than in a burst', () => {
    // A tab in the background reports the whole gap on the frame it returns.
    // Stepping the field by it would fling every unit across the field at once.
    const renderer = new FakeRenderer();
    const { stage } = stageWith(renderer);
    stage.start();
    clock.tick(45_000);

    expect(renderer.draws.at(-1)?.dtSec).toBeCloseTo(0.1);
  });
});

describe('pulses', () => {
  it('applies each one exactly once', () => {
    // Pulses arrive at 10 Hz and frames at 60. Re-applying the same one every
    // frame would restart the reconciliation six times over.
    const renderer = new FakeRenderer();
    const { stage, store } = stageWith(renderer);
    stage.start();

    store.apply(pulse(1_000, 200));
    clock.frames(6);
    const field = renderer.draws.at(-1)!.field;
    expect(field.resyncs).toBe(1);

    store.apply(pulse(1_100, 196));
    clock.frames(6);
    expect(field.resyncs).toBe(1);
    expect(field.countOf('orc')).toBe(196);
  });

  it('tells the field how long nothing was drawn', () => {
    // This is what separates "fell behind" from "stopped rendering": the field
    // only snaps if the client was not watching, and the loop is the only thing
    // that knows whether it was.
    const renderer = new FakeRenderer();
    const { stage, store } = stageWith(renderer);
    stage.start();

    store.apply(pulse(1_000, 200));
    clock.frames(30);
    const field = renderer.draws.at(-1)!.field;
    expect(field.resyncs).toBe(1);

    // The order is the one a real background tab produces: the socket keeps
    // filling the store while no frame runs, and the gap is only discovered on
    // the frame that returns. Two units of difference, far under the gap
    // threshold — it snaps because of the five seconds, not the two units.
    store.apply(pulse(6_000, 198));
    clock.tick(5_000);

    expect(field.resyncs).toBe(2);
  });

  it('ignores a store that has seen no battle yet', () => {
    const renderer = new FakeRenderer();
    const { stage } = stageWith(renderer);
    stage.start();
    clock.frames(4);

    expect(renderer.draws.at(-1)?.field.units).toHaveLength(0);
  });
});

describe('the frame-time readout', () => {
  it('settles on the interval it is actually running at', () => {
    const { stage } = stageWith(new FakeRenderer());
    stage.start();
    clock.frames(400, 1_000 / 30);

    expect(stage.fps).toBe(30);
  });

  it('does not report a collapse that already ended', () => {
    // A tab returning from the background hands back a gap of seconds. Averaged
    // in, it would read as one frame per second for the next twenty frames.
    const { stage } = stageWith(new FakeRenderer());
    stage.start();
    clock.frames(200, 1_000 / 60);
    const settled = stage.fps;

    clock.tick(30_000);

    expect(stage.fps).toBe(settled);
  });
});

describe('layout', () => {
  it('sizes the renderer to the host on start', () => {
    const renderer = new FakeRenderer();
    const { stage } = stageWith(renderer);
    stage.start();

    expect(renderer.sizes[0]).toEqual([1280, 720]);
  });
});

describe('losing the context', () => {
  it('falls back to 2D and lets go of the old renderer', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      kind: string,
    ) => (kind === '2d' ? fake2d() : null)) as HTMLCanvasElement['getContext']);

    const renderer = new FakeRenderer();
    let lose = (): void => undefined;
    const element = host();
    const stage = new BattleStage(element, new MarketStore(), {
      createRenderer: (_host, onContextLost) => {
        lose = onContextLost;
        return renderer;
      },
    });
    stage.start();
    clock.frames(3);

    lose();

    expect(stage.rendererKind).toBe('canvas2d');
    expect(renderer.disposed).toBe(1);
    // The battle has to keep moving: the whole point of the fallback is that
    // the viewer never sees a blank rectangle.
    const before = renderer.draws.length;
    clock.frames(3);
    expect(renderer.draws).toHaveLength(before);
    expect(element.querySelectorAll('canvas')).toHaveLength(1);
  });
});

describe('the camera key', () => {
  it('cycles on c', () => {
    const { stage } = stageWith(new FakeRenderer());
    stage.start();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    expect(stage.preset).toBe('front');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C' }));
    expect(stage.preset).toBe('orbit');
  });

  it('keeps out of the way of typing and of shortcuts', () => {
    const { stage } = stageWith(new FakeRenderer());
    stage.start();

    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }));

    expect(stage.preset).toBe('tactical');
  });

  it('lets go of the window when it stops', () => {
    // A stage that kept listening would go on cycling a camera it no longer
    // draws, and hold the whole scene alive through the closure.
    const { stage } = stageWith(new FakeRenderer());
    stage.start();
    stage.stop();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    expect(stage.preset).toBe('tactical');
  });
});
