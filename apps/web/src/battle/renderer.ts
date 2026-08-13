import type { BattleField } from './field.js';

/**
 * The one thing the stage knows how to talk to.
 *
 * Phase 4 was going to end with a 3D renderer and phase 7 was going to add a 2D
 * fallback. Doing it that way round means writing the fallback last, against a
 * scene that has had three phases to grow assumptions — which is how fallbacks
 * end up being the untested path that only runs on the hardware you do not own.
 *
 * The order is reversed here for free: the 2D renderer already exists, it
 * already draws a `BattleField`, and both renderers are asked the same three
 * questions. Nothing downstream can tell which one is answering.
 */
export interface FieldRenderer {
  readonly kind: RendererKind;
  /** Layout size in CSS pixels. Backing store is the renderer's business. */
  resize(width: number, height: number): void;
  draw(field: BattleField, dtSec: number): void;
  dispose(): void;
}

export type RendererKind = 'webgl' | 'canvas2d';

/**
 * Whether this browser can run the 3D path.
 *
 * Probed on a throwaway canvas, never on the one about to be drawn into: a
 * canvas remembers the first context type it was asked for, so probing the real
 * element would rule out the fallback in the act of testing for it.
 */
export function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    // Some privacy modes throw rather than return null.
    return false;
  }
}
