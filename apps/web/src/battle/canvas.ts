import type { BattleField, Unit } from './field.js';
import { paletteFrom, type Palette } from './palette.js';
import type { FieldRenderer } from './renderer.js';

/**
 * Draws a `BattleField` onto a 2D context.
 *
 * Written in phase 3 as the prototype, kept in phase 4 as the fallback. It is
 * the same drawing either way, because it draws the same `BattleField` the 3D
 * scene does — a browser without WebGL sees a plainer battle, not a different
 * one, and there is no second set of rules to keep in step.
 *
 * Colours come from the design system's tokens rather than literals, so the
 * prototype and the HUD cannot drift apart while both are being built.
 */

const UNIT_RADIUS = 2.4;

export function drawField(
  ctx: CanvasRenderingContext2D,
  field: BattleField,
  palette: Palette,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);

  drawTerritory(ctx, field, palette, width, height);
  drawFrontLine(ctx, field, palette, width, height);

  // Dying units draw under the living, so a death never hides a fighter.
  for (const unit of field.units) {
    if (unit.state === 'dying') drawUnit(ctx, unit, palette, width, height);
  }
  for (const unit of field.units) {
    if (unit.state !== 'dying') drawUnit(ctx, unit, palette, width, height);
  }
}

/**
 * The 2D renderer as the stage sees it.
 *
 * Owns its canvas rather than being handed one: which renderer a browser gets
 * is decided at runtime, and a canvas that has been given a WebGL context can
 * never be given a 2D one. Creating the element alongside the context is the
 * only way that stays true after a fallback.
 */
export class Canvas2DRenderer implements FieldRenderer {
  readonly kind = 'canvas2d';
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #palette: Palette;
  #width = 0;
  #height = 0;

  constructor(host: HTMLElement) {
    this.#canvas = document.createElement('canvas');
    this.#canvas.className = 'battlefield';
    host.append(this.#canvas);

    const ctx = this.#canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.#ctx = ctx;
    this.#palette = paletteFrom(this.#canvas);
  }

  resize(width: number, height: number): void {
    // Draw at device resolution; the CSS box stays the layout size.
    const ratio = window.devicePixelRatio || 1;
    this.#width = width;
    this.#height = height;

    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    if (backingWidth === this.#canvas.width && backingHeight === this.#canvas.height) {
      return;
    }
    // Assigning either dimension clears the canvas, so only do it on a real
    // change — otherwise an observer that fires per frame would blank every one.
    this.#canvas.width = backingWidth;
    this.#canvas.height = backingHeight;
    this.#ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(field: BattleField): void {
    drawField(this.#ctx, field, this.#palette, this.#width, this.#height);
  }

  dispose(): void {
    this.#canvas.remove();
  }
}

function drawTerritory(
  ctx: CanvasRenderingContext2D,
  field: BattleField,
  palette: Palette,
  width: number,
  height: number,
): void {
  const front = field.frontY * height;
  // Territory is the clearest read of who is winning at a glance — the ground
  // itself changes hands, so the answer survives being seen from across a room.
  ctx.fillStyle = palette.orcDim;
  ctx.globalAlpha = 0.28;
  ctx.fillRect(0, 0, width, front);
  ctx.fillStyle = palette.nexusDim;
  ctx.fillRect(0, front, width, height - front);
  ctx.globalAlpha = 1;
}

function drawFrontLine(
  ctx: CanvasRenderingContext2D,
  field: BattleField,
  palette: Palette,
  width: number,
  height: number,
): void {
  const y = field.frontY * height;
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
}

function drawUnit(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  palette: Palette,
  width: number,
  height: number,
): void {
  const base = unit.faction === 'orc' ? palette.orc : palette.nexus;

  // Arriving units fade up and dying ones fade out, so both edges of the
  // population are a transition rather than a pop.
  ctx.globalAlpha =
    unit.state === 'spawning'
      ? Math.min(1, unit.stateAge / 0.4)
      : unit.state === 'dying'
        ? Math.max(0, 1 - unit.stateAge / 0.5)
        : 1;

  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(
    unit.x * width,
    unit.y * height,
    unit.state === 'dying' ? UNIT_RADIUS * 1.6 : UNIT_RADIUS,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.globalAlpha = 1;
}
