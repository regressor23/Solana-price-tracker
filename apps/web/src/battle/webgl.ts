import { WebGLRenderer } from 'three';

import type { CameraPreset } from './camera.js';
import type { BattleField } from './field.js';
import { scenePaletteFrom } from './palette.js';
import type { FieldRenderer } from './renderer.js';
import { BattleScene } from './scene.js';

/**
 * The part that needs a GPU, and nothing else.
 *
 * Everything with a decision in it — where units stand, where the camera looks,
 * how high the ground is — is in `scene.ts` and its neighbours, which run
 * anywhere. What is left here is context creation, a resize, a draw call and
 * one failure to handle. That split is why phase 4 has tests at all.
 */

export interface WebGLRendererOptions {
  /**
   * Called when the GPU takes the context away. The stage's answer is to fall
   * back to 2D rather than to wait: `webglcontextrestored` may never arrive,
   * and a black rectangle in the meantime is exactly the state the fallback
   * exists to prevent.
   */
  onContextLost?: () => void;
}

export class WebGLFieldRenderer implements FieldRenderer {
  readonly kind = 'webgl';
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: WebGLRenderer;
  readonly #scene: BattleScene;

  constructor(host: HTMLElement, options: WebGLRendererOptions = {}) {
    this.#canvas = document.createElement('canvas');
    this.#canvas.className = 'battlefield';
    host.append(this.#canvas);

    this.#canvas.addEventListener('webglcontextlost', (event) => {
      // Stop the driver from restoring behind our back: whichever renderer the
      // stage settles on should be the only one holding the element.
      event.preventDefault();
      options.onContextLost?.();
    });

    try {
      this.#renderer = new WebGLRenderer({
        canvas: this.#canvas,
        antialias: true,
        // The scene is opaque to the horizon, so there is nothing to composite
        // against and no reason to pay for an alpha channel.
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      // The caller will fall back, and it needs the stage empty when it does:
      // a canvas left behind here sits over the 2D one for the rest of the
      // session, absolutely positioned and blank.
      this.#canvas.remove();
      throw error;
    }
    // Retina at 3× costs nine times the fill for a battle made of flat shapes.
    // Two is the point past which the extra pixels stop being visible here.
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.#scene = new BattleScene(scenePaletteFrom(this.#canvas));
  }

  get preset(): CameraPreset {
    return this.#scene.preset;
  }

  setPreset(preset: CameraPreset): void {
    this.#scene.setPreset(preset);
  }

  resize(width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    // `false` leaves the CSS box alone: the stylesheet already stretches the
    // canvas over the stage, and letting the renderer write inline dimensions
    // would fight it every frame.
    this.#renderer.setSize(width, height, false);
    const ratio = this.#renderer.getPixelRatio();
    this.#scene.setSize(width * ratio, height * ratio);
  }

  draw(field: BattleField, dtSec: number): void {
    this.#scene.update(field, dtSec);
    this.#renderer.render(this.#scene.scene, this.#scene.camera);
  }

  dispose(): void {
    this.#scene.dispose();
    this.#renderer.dispose();
    this.#canvas.remove();
  }
}
