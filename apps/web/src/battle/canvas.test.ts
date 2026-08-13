import type { Pulse } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { drawField } from './canvas.js';
import { BattleField } from './field.js';
import type { Palette } from './palette.js';

/**
 * The renderer, checked without a browser.
 *
 * Looking at the page proved this cannot be verified by eye on demand: a
 * hidden tab gets no animation frames at all, so an empty canvas there says
 * nothing about whether the drawing is right. A recording context does.
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
