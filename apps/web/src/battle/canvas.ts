import type { BattleField, Unit } from './field.js';

/**
 * Draws a `BattleField` onto a 2D context.
 *
 * Deliberately the only file here that knows what a canvas is: the field
 * itself is pure state, so the part worth testing does not need one.
 *
 * Colours come from the design system's tokens rather than literals, so the
 * prototype and the HUD cannot drift apart while both are being built.
 */

export interface Palette {
  orc: string;
  nexus: string;
  orcDim: string;
  nexusDim: string;
  line: string;
  ink: string;
}

const token = (styles: CSSStyleDeclaration, name: string, fallback: string): string =>
  styles.getPropertyValue(name).trim() || fallback;

/** Read the palette once; these are custom properties, not per-frame state. */
export function paletteFrom(element: Element): Palette {
  const styles = getComputedStyle(element);
  return {
    orc: token(styles, '--orc', '#c4472c'),
    nexus: token(styles, '--nexus', '#00d4ff'),
    orcDim: token(styles, '--orc-deep', '#8b1a1a'),
    nexusDim: token(styles, '--nexus-deep', '#0a2a3a'),
    line: token(styles, '--line-strong', '#2a3542'),
    ink: token(styles, '--bg', '#07090c'),
  };
}

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
