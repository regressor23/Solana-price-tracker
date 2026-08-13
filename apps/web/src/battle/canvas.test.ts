// @vitest-environment happy-dom
import type { Pulse } from '@sol-warzone/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Canvas2DRenderer, drawField } from './canvas.js';
import { BattleField } from './field.js';
import type { Palette } from './palette.js';

/**
 * The renderer, checked without a browser.
 *
 * Looking at the page proved this cannot be verified by eye on demand: a
 * hidden tab gets no animation frames at all, so an empty canvas there says
 * nothing about whether the drawing is right. A recording context does.
 *
 * This is also the fallback now, which raises the stakes: it runs on the
 * machines least able to report what went wrong.
 */

interface Call {
  op: string;
  args: unknown[];
}

/** Records the drawing calls instead of rasterising them. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]) =>
      void calls.push({ op, args });

  const ctx = {
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    arc: record('arc'),
    fill: record('fill'),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;

  return { ctx, calls };
}

const palette: Palette = {
  orc: '#c4472c',
  nexus: '#00d4ff',
  orcDim: '#8b1a1a',
  nexusDim: '#0a2a3a',
  line: '#2a3542',
  ink: '#07090c',
};

const seeded = (): (() => number) => {
  let state = 20_260_813;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const pulse = (
  orcAlive: number,
  nexusAlive: number,
  frontLine = 0,
): Omit<Pulse, 'type' | 't'> => ({ orcAlive, nexusAlive, frontLine });

function fieldWith(p: Omit<Pulse, 'type' | 't'>): BattleField {
  const field = new BattleField({ random: seeded() });
  field.applyPulse(p);
  return field;
}

const W = 800;
const H = 400;

describe('drawField', () => {
  it('clears before it draws, so frames do not smear', () => {
    const { ctx, calls } = recorder();
    drawField(ctx, fieldWith(pulse(10, 10)), palette, W, H);
    expect(calls[0]?.op).toBe('clearRect');
  });

  it('draws one circle per unit', () => {
    const { ctx, calls } = recorder();
    const field = fieldWith(pulse(12, 7));
    drawField(ctx, field, palette, W, H);

    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(19);
    expect(field.units).toHaveLength(19);
  });

  it('splits the ground at the front line', () => {
    // Territory is the read that survives being seen from across a room, so
    // the two rectangles have to meet exactly at the line and cover the field.
    const { ctx, calls } = recorder();
    const field = fieldWith(pulse(10, 10, 0.5));
    drawField(ctx, field, palette, W, H);

    const [orcGround, nexusGround] = calls.filter((c) => c.op === 'fillRect');
    const front = field.frontY * H;

    expect(orcGround?.args).toEqual([0, 0, W, front]);
    expect(nexusGround?.args).toEqual([0, front, W, H - front]);
  });

  it('puts the front line where the field says it is', () => {
    const { ctx, calls } = recorder();
    const field = fieldWith(pulse(10, 10, -0.6));
    drawField(ctx, field, palette, W, H);

    const to = calls.find((c) => c.op === 'lineTo');
    expect(to?.args).toEqual([W, field.frontY * H]);
  });

  it('draws the dying under the living', () => {
    // A death that hides the fighter standing over it reads as a gap in the
    // line rather than as a casualty.
    const field = fieldWith(pulse(20, 20));
    for (let i = 0; i < 60; i++) field.advance(1_000 / 60);
    field.applyPulse(pulse(15, 20));
    field.advance(1_000 / 60);

    const { ctx, calls } = recorder();
    drawField(ctx, field, palette, W, H);

    const arcs = calls.filter((c) => c.op === 'arc');
    const dyingRadius = 2.4 * 1.6;
    const lastDying = arcs.map((c) => c.args[2]).lastIndexOf(dyingRadius);
    const firstLiving = arcs.findIndex((c) => c.args[2] === 2.4);

    expect(lastDying).toBeGreaterThanOrEqual(0);
    expect(lastDying).toBeLessThan(firstLiving);
  });

  it('scales positions into the canvas box', () => {
    const { ctx, calls } = recorder();
    const field = fieldWith(pulse(30, 30));
    drawField(ctx, field, palette, W, H);

    for (const arc of calls.filter((c) => c.op === 'arc')) {
      expect(arc.args[0] as number).toBeGreaterThanOrEqual(0);
      expect(arc.args[0] as number).toBeLessThanOrEqual(W);
      expect(arc.args[1] as number).toBeGreaterThanOrEqual(0);
      expect(arc.args[1] as number).toBeLessThanOrEqual(H);
    }
  });
});

describe('Canvas2DRenderer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub the context so a canvas can be built where there is no rasteriser. */
  function mounted(dpr = 1): {
    host: HTMLElement;
    renderer: Canvas2DRenderer;
    calls: Call[];
  } {
    const { ctx, calls } = recorder();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      kind: string,
    ) => (kind === '2d' ? ctx : null)) as HTMLCanvasElement['getContext']);
    Object.defineProperty(window, 'devicePixelRatio', {
      value: dpr,
      configurable: true,
    });

    const host = document.createElement('section');
    document.body.append(host);
    return { host, renderer: new Canvas2DRenderer(host), calls };
  }

  it('brings its own canvas', () => {
    // It has to: a canvas remembers the first context type it was asked for, so
    // a WebGL attempt cannot hand its element over to the fallback.
    const { host, renderer } = mounted();

    const canvas = host.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.className).toBe('battlefield');

    renderer.dispose();
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('draws at device resolution inside a layout-sized box', () => {
    const { host, renderer } = mounted(2);
    renderer.resize(800, 400);

    const canvas = host.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([1600, 800]);
  });

  it('leaves the canvas alone when the size has not changed', () => {
    // Assigning either dimension clears the canvas, and the observer that calls
    // this can fire every frame — so a resize that reassigns unconditionally
    // blanks every one of them.
    const { renderer, calls } = mounted(1);
    renderer.resize(640, 360);
    const transforms = calls.filter((c) => c.op === 'setTransform').length;

    renderer.resize(640, 360);
    renderer.resize(640, 360);

    expect(calls.filter((c) => c.op === 'setTransform')).toHaveLength(transforms);
  });

  it('draws in layout pixels, not in backing-store ones', () => {
    // The context is scaled by the ratio, so the drawing itself works in the
    // box the stylesheet laid out. Getting this backwards puts the whole
    // battle in the top-left quarter of a retina canvas.
    const { renderer, calls } = mounted(2);
    renderer.resize(800, 400);

    const field = fieldWith(pulse(20, 20, 0.5));
    renderer.draw(field);

    const ground = calls.filter((c) => c.op === 'fillRect');
    expect(ground[0]?.args).toEqual([0, 0, 800, field.frontY * 400]);
  });

  it('draws nothing before it has been given a size', () => {
    // The stage sizes it on start, but a draw can still arrive first if the
    // host is laid out late. A zero-sized clear is fine; a crash is not.
    const { renderer, calls } = mounted();
    expect(() => renderer.draw(fieldWith(pulse(10, 10)))).not.toThrow();
    expect(calls[0]?.args).toEqual([0, 0, 0, 0]);
  });
});
