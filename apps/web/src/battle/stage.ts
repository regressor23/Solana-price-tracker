import type { MarketStore } from '../store.js';
import { Canvas2DRenderer } from './canvas.js';
import { CAMERA_PRESETS, type CameraPreset } from './camera.js';
import { BattleField } from './field.js';
import { hasWebGL, type FieldRenderer, type RendererKind } from './renderer.js';
import { WebGLFieldRenderer } from './webgl.js';

/**
 * Wires the field to a renderer and the animation frame.
 *
 * The render loop is the only place that knows about time passing on this
 * side. It also measures how long it was away, which is what lets the field
 * tell "a client that fell behind" from "a client that stopped rendering" —
 * a backgrounded tab gets no frames while the socket keeps delivering.
 *
 * Which renderer is drawing is the stage's business and nobody else's. It picks
 * one at startup and can change its mind mid-session if the GPU takes the
 * context away; the field, the store and the HUD never find out.
 */

/** Longest step the field is allowed to take in one frame, ms. */
const MAX_STEP_MS = 100;

export interface BattleStageOptions {
  /** Forced in tests, and by a browser that cannot run the 3D path. */
  webgl?: boolean;
}

export class BattleStage {
  readonly #host: HTMLElement;
  readonly #store: MarketStore;
  readonly #field: BattleField;

  #renderer: FieldRenderer;
  #frame = 0;
  #observer: ResizeObserver | undefined;
  #lastFrameAt = 0;
  #lastPulseSeen: number | null = null;
  #frameMs = 1_000 / 60;
  #preset: CameraPreset = 'tactical';

  constructor(host: HTMLElement, store: MarketStore, options: BattleStageOptions = {}) {
    this.#host = host;
    this.#store = store;
    this.#field = new BattleField();
    this.#renderer = this.#build(options.webgl ?? hasWebGL());
  }

  get rendererKind(): RendererKind {
    return this.#renderer.kind;
  }

  /** Smoothed frames per second. Phase 4's own acceptance criterion. */
  get fps(): number {
    return Math.round(1_000 / Math.max(this.#frameMs, 0.001));
  }

  get preset(): CameraPreset {
    return this.#preset;
  }

  /**
   * Next camera preset. A key rather than a control, because the HUD that owns
   * controls is phase 6 (DESIGN_BRIEF §C14) — but three presets nobody can
   * reach are three presets nobody has looked at.
   */
  cyclePreset(): void {
    const next = (CAMERA_PRESETS.indexOf(this.#preset) + 1) % CAMERA_PRESETS.length;
    this.#preset = CAMERA_PRESETS[next]!;
    this.#apply();
  }

  start(): void {
    if (this.#frame) return;
    this.#lastFrameAt = performance.now();
    this.#resize();
    // Watch the element, not the window. The canvas sits in a grid cell that
    // changes with the HUD around it — measured 263x150 of backing store under
    // a 1280x730 box, because the one resize at start ran before layout had
    // settled and no window event ever followed to correct it.
    this.#observer = new ResizeObserver(this.#resize);
    this.#observer.observe(this.#host);
    // On the window, not the host: a `section` takes no focus, so a listener
    // there would never fire without making the battlefield a tab stop, and
    // what belongs in the tab order is the controls phase 6 adds.
    window.addEventListener('keydown', this.#onKey);
    this.#frame = requestAnimationFrame(this.#tick);
  }

  stop(): void {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#observer?.disconnect();
    this.#observer = undefined;
    window.removeEventListener('keydown', this.#onKey);
  }

  #tick = (now: number): void => {
    const elapsed = now - this.#lastFrameAt;
    this.#lastFrameAt = now;
    // Only count frames that were actually drawn back to back. A tab returning
    // from the background reports a gap of seconds, and averaging that in would
    // read as a performance collapse that already ended.
    if (elapsed > 0 && elapsed < MAX_STEP_MS) {
      this.#frameMs += (elapsed - this.#frameMs) * 0.08;
    }

    const battle = this.#store.state.battle;
    if (battle && battle.t !== this.#lastPulseSeen) {
      this.#lastPulseSeen = battle.t;
      // A frame gap far past 16 ms means nothing was drawn — the field uses
      // that to decide whether the backlog is worth animating through.
      this.#field.applyPulse(battle, elapsed);
    }

    // Cap the step so a long stall advances the picture once, not in a burst
    // that would fling every unit across the field in a single frame.
    const step = Math.min(elapsed, MAX_STEP_MS);
    this.#field.advance(step);
    this.#renderer.draw(this.#field, step / 1_000);

    this.#frame = requestAnimationFrame(this.#tick);
  };

  #build(webgl: boolean): FieldRenderer {
    if (!webgl) return new Canvas2DRenderer(this.#host);
    try {
      return new WebGLFieldRenderer(this.#host, { onContextLost: this.#onContextLost });
    } catch {
      // The probe said yes and construction said no. Rare, but the answer is
      // the same as if the probe had said no, so there is no reason to be loud.
      return new Canvas2DRenderer(this.#host);
    }
  }

  #onContextLost = (): void => {
    if (this.#renderer.kind !== 'webgl') return;
    this.#renderer.dispose();
    this.#renderer = new Canvas2DRenderer(this.#host);
    this.#resize();
  };

  #onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'c' && event.key !== 'C') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Nothing on the page takes text yet, but a global key handler that eats a
    // "c" the moment one does is a bug written a phase early.
    const target = event.target;
    if (target instanceof HTMLElement && target.isContentEditable) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }
    this.cyclePreset();
  };

  #apply(): void {
    if (this.#renderer instanceof WebGLFieldRenderer) {
      this.#renderer.setPreset(this.#preset);
    }
  }

  #resize = (): void => {
    this.#renderer.resize(this.#host.clientWidth, this.#host.clientHeight);
  };
}
