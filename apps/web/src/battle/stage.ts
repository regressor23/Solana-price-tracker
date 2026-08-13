import type { MarketStore } from '../store.js';
import { drawField, paletteFrom, type Palette } from './canvas.js';
import { BattleField } from './field.js';

/**
 * Wires the field to a canvas and the animation frame.
 *
 * The render loop is the only place that knows about time passing on this
 * side. It also measures how long it was away, which is what lets the field
 * tell "a client that fell behind" from "a client that stopped rendering" —
 * a backgrounded tab gets no frames while the socket keeps delivering.
 */
export class BattleStage {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #store: MarketStore;
  readonly #field: BattleField;
  readonly #palette: Palette;

  #frame = 0;
  #observer: ResizeObserver | undefined;
  #lastFrameAt = 0;
  #lastPulseSeen: number | null = null;

  constructor(canvas: HTMLCanvasElement, store: MarketStore) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#store = store;
    this.#field = new BattleField();
    this.#palette = paletteFrom(canvas);
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
    this.#observer.observe(this.#canvas);
    this.#frame = requestAnimationFrame(this.#tick);
  }

  stop(): void {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#observer?.disconnect();
    this.#observer = undefined;
  }

  #tick = (now: number): void => {
    const elapsed = now - this.#lastFrameAt;
    this.#lastFrameAt = now;

    const battle = this.#store.state.battle;
    if (battle && battle.t !== this.#lastPulseSeen) {
      this.#lastPulseSeen = battle.t;
      // A frame gap far past 16 ms means nothing was drawn — the field uses
      // that to decide whether the backlog is worth animating through.
      this.#field.applyPulse(battle, elapsed);
    }

    // Cap the step so a long stall advances the picture once, not in a burst
    // that would fling every unit across the field in a single frame.
    this.#field.advance(Math.min(elapsed, 100));

    const { clientWidth: width, clientHeight: height } = this.#canvas;
    drawField(this.#ctx, this.#field, this.#palette, width, height);

    this.#frame = requestAnimationFrame(this.#tick);
  };

  #resize = (): void => {
    // Draw at device resolution; the CSS box stays the layout size.
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(this.#canvas.clientWidth * ratio);
    const height = Math.round(this.#canvas.clientHeight * ratio);
    if (width === this.#canvas.width && height === this.#canvas.height) return;

    // Assigning either dimension clears the canvas, so only do it on a real
    // change — otherwise an observer that fires per frame would blank every one.
    this.#canvas.width = width;
    this.#canvas.height = height;
    this.#ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
}
