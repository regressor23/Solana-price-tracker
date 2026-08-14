import type { DepthRung, DepthSnapshot } from '@sol-warzone/protocol';

/**
 * C4 · LiquidityCurve — the price-impact ladder as a shape.
 *
 * Two measurements from real snapshots decide almost everything here.
 *
 * The ladder is violently non-linear: the first four rungs (10…1000 SOL) all
 * land inside ±0.0002% and are, on a linear axis, the same point. Plotted
 * linearly the curve is a flat line with a hook on the end, which describes the
 * axis rather than the market. So the axis is signed-logarithmic.
 *
 * And it is asymmetric: selling 150k SOL cost −1.72% while buying the same size
 * cost +213%, because above about 100k the ask leg simply has no route. A rung
 * like that cannot be allowed to set the scale — it would compress everything
 * real into a hairline — so the axis clips and the rung is marked at the edge
 * instead of being drawn where it claims to be.
 *
 * No DOM here. Paths are strings, and a string can be compared in a test.
 */

/** Impact beyond this is off the chart, and said to be. */
export const CLIP_PCT = 0.02;

/** Where the walls are measured, and so where the curve is marked. */
export const WALL_PCT = 0.01;

/** Points each side is resampled to before it can be tweened. */
export const SAMPLES = 24;

export interface CurvePoint {
  /** −1…1 across the plotted width; 0 is mid. */
  readonly x: number;
  /** 0…1 up the plotted height, as a share of the side's own total. */
  readonly y: number;
}

export interface CurveSide {
  readonly points: readonly CurvePoint[];
  /** True when a rung was past the clip and is marked at the edge instead. */
  readonly offScale: boolean;
  /** Cumulative USD the side absorbs inside the clip. */
  readonly usd: number;
}

/**
 * Where the log axis stops being logarithmic, in impact.
 *
 * A true logarithm cannot include zero, and the axis has to: mid is the middle
 * of the chart. `asinh` is the way out — logarithmic in the large, linear
 * through the origin, and the crossover sits at `1 / K`. At 1e5 that is a
 * thousandth of a percent, which is an order of magnitude finer than the
 * smallest impact ever measured (0.006%), so every real rung lands in the
 * logarithmic part.
 */
const K = 1e5;

/**
 * Signed log, so four decades of ladder fit and the sign still means a side.
 *
 * The first attempt was `log1p` of the impact scaled to the clip, and a test
 * caught it: `log1p(x) ≈ x` for small x, so across the first four rungs — all
 * inside ±0.0002% — it was doing almost nothing a linear axis would not have
 * done, which was the one thing the axis existed to fix. `asinh` with a
 * crossover far below the data separates them by about thirty times as much.
 */
export function impactToX(impactPct: number): number {
  const clipped = Math.max(-CLIP_PCT, Math.min(CLIP_PCT, impactPct));
  return (
    (Math.sign(impactPct) * Math.asinh(Math.abs(clipped) * K)) /
    Math.asinh(CLIP_PCT * K)
  );
}

/**
 * One leg of the ladder, cumulative.
 *
 * Rungs are already cumulative fills, so `usd` is read as-is; what this adds is
 * the clip, the normalisation and the honest report that something was dropped.
 */
export function sideFor(rungs: readonly DepthRung[], sign: -1 | 1): CurveSide {
  const inside = rungs.filter((rung) => Math.abs(rung.impactPct) <= CLIP_PCT);
  const offScale = inside.length < rungs.length;
  // A side can also simply stop: above ~100k SOL the ask leg has no route at
  // all, so a short ladder is the book talking, not a bug.
  const top = inside.at(-1)?.usd ?? 0;

  const points: CurvePoint[] = [{ x: 0, y: 0 }];
  for (const rung of inside) {
    points.push({
      x: sign * Math.abs(impactToX(rung.impactPct)),
      y: top > 0 ? rung.usd / top : 0,
    });
  }

  return { points, offScale, usd: top };
}

/**
 * Resample to a fixed number of points along the axis.
 *
 * This is what makes two snapshots tweenable. A full ladder has nine rungs and
 * a truncated one has seven, so a point-by-point interpolation between them is
 * not defined — the shapes have different vertex counts and the sides are not
 * even the same length. Resampling both to `SAMPLES` before anything is drawn
 * means `partial` and `full` are always the same shape to the tween, and the
 * only thing that changes between frames is where the points are.
 */
export function resample(side: CurveSide, sign: -1 | 1): CurvePoint[] {
  const reach = side.points.at(-1)?.x ?? 0;
  const out: CurvePoint[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const x = (reach * i) / (SAMPLES - 1);
    out.push({ x, y: heightAt(side.points, x, sign) });
  }
  return out;
}

/** Linear read of the ladder between the two rungs that straddle `x`. */
function heightAt(points: readonly CurvePoint[], x: number, sign: -1 | 1): number {
  const at = sign * x;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const lo = sign * a.x;
    const hi = sign * b.x;
    if (at <= hi || i === points.length - 1) {
      const span = hi - lo;
      const t = span === 0 ? 1 : Math.min(1, Math.max(0, (at - lo) / span));
      return a.y + (b.y - a.y) * t;
    }
  }
  return points.at(-1)?.y ?? 0;
}

/**
 * Both legs as one SVG path in a −1…1 by 0…1 box.
 *
 * The viewBox does the scaling, which is why the stroke needs
 * `vector-effect: non-scaling-stroke` — otherwise a box this small draws a line
 * two units thick.
 */
export function pathFor(points: readonly CurvePoint[]): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(4)},${(1 - p.y).toFixed(4)}`)
    .join(' ');
}

export interface CurveShape {
  readonly bid: CurveSide;
  readonly ask: CurveSide;
  readonly bidPath: string;
  readonly askPath: string;
  readonly mid: number;
  /** Price at the clip edges, for the axis labels. */
  readonly low: number;
  readonly high: number;
}

export function shapeFor(depth: DepthSnapshot): CurveShape {
  // Bids are someone selling into the book, so they sit left of mid.
  const bid = sideFor(depth.bids, -1);
  const ask = sideFor(depth.asks, 1);
  return {
    bid,
    ask,
    bidPath: pathFor(resample(bid, -1)),
    askPath: pathFor(resample(ask, 1)),
    mid: depth.mid,
    low: depth.mid * (1 - CLIP_PCT),
    high: depth.mid * (1 + CLIP_PCT),
  };
}

// ---------------------------------------------------------------------------
// The view. Everything above is arithmetic; this is the only part that needs a
// document, and it holds no state beyond the nodes it owns.
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  className: string,
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  node.setAttribute('class', className);
  return node;
};

export class LiquidityCurve {
  readonly #root: HTMLElement;
  readonly #bid: SVGPathElement;
  readonly #ask: SVGPathElement;
  readonly #labels: readonly HTMLElement[];

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#root.classList.add('curve');
    this.#root.dataset['state'] = 'waiting';

    // A −1…1 by 0…1 box: the viewBox does the scaling, so the stroke needs
    // `vector-effect: non-scaling-stroke` or a line comes out two units thick.
    const svg = svgEl('svg', 'curve__svg');
    svg.setAttribute('viewBox', '-1 0 2 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    // Decorative: every number it encodes is in the axis labels below it.
    svg.setAttribute('aria-hidden', 'true');

    const mid = svgEl('line', 'curve__mid');
    mid.setAttribute('x1', '0');
    mid.setAttribute('y1', '0');
    mid.setAttribute('x2', '0');
    mid.setAttribute('y2', '1');

    this.#bid = svgEl('path', 'curve__path curve__path--bid');
    this.#ask = svgEl('path', 'curve__path curve__path--ask');
    svg.append(mid, ...this.#walls(), this.#bid, this.#ask);

    const axis = document.createElement('div');
    axis.className = 'curve__axis num';
    const labels = [0, 1, 2].map(() => {
      const node = document.createElement('span');
      node.dataset['skeleton'] = 'sm';
      axis.append(node);
      return node;
    });
    this.#labels = labels;

    this.#root.replaceChildren(svg, axis);
  }

  /** The ±1% marks — the level the wall totals in C3 are measured at. */
  #walls(): SVGLineElement[] {
    return [-1, 1].map((side) => {
      const at = side * Math.abs(impactToX(side * WALL_PCT));
      const line = svgEl('line', 'curve__wall');
      line.setAttribute('x1', String(at));
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(at));
      line.setAttribute('y2', '1');
      return line;
    });
  }

  update(depth: DepthSnapshot | null): void {
    if (!depth) {
      this.#root.dataset['state'] = 'waiting';
      this.#bid.removeAttribute('d');
      this.#ask.removeAttribute('d');
      for (const label of this.#labels) label.textContent = '';
      return;
    }

    const shape = shapeFor(depth);
    this.#root.dataset['state'] = 'live';
    // Reported on the root rather than per side, because what the reader needs
    // to know is that the chart is not showing everything — which side it was
    // is already visible from the marker.
    this.#root.dataset['offScale'] = String(shape.bid.offScale || shape.ask.offScale);
    this.#bid.setAttribute('d', shape.bidPath);
    this.#ask.setAttribute('d', shape.askPath);

    const [low, mid, high] = this.#labels;
    if (low) low.textContent = shape.low.toFixed(2);
    if (mid) mid.textContent = shape.mid.toFixed(4);
    if (high) high.textContent = shape.high.toFixed(2);
  }
}
