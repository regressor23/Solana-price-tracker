/**
 * Where the field's numbers land in three dimensions.
 *
 * `BattleField` speaks in normalised coordinates — x and y both 0…1 — because
 * phase 3 deliberately gave it no opinion about pixels. This is the one place
 * that turns those into metres, so the 3D renderer and anything measuring
 * against it cannot disagree about where the front line is.
 *
 * No three.js here on purpose: it is arithmetic, and arithmetic is worth
 * testing without a GPU.
 */

/**
 * Field size in world units, where a unit stands about 2 tall.
 *
 * Wider than it is deep, as the 2D prototype was: the front line is a band
 * across the width, and a square field would let it travel far enough to leave
 * the frame. 120 across takes forty-wide ranks at three units of spacing, which
 * is the file width phase 3 assumed.
 */
export const FIELD = { width: 120, depth: 78 } as const;

/**
 * How far the ground runs past the field it holds.
 *
 * The 2D prototype could stop the world at the field's edge because the frame
 * stopped there too. A perspective camera looking down the field sees past the
 * far end, and a plane cut to size ends in a straight seam with sky under it —
 * the horizon reads as the terrain failing to load. Ground beyond the fighting
 * costs two triangles' worth of nothing and removes the seam.
 */
export const GROUND = { width: FIELD.width * 2.4, depth: FIELD.depth * 3.4 } as const;

/**
 * How far the ground rolls, peak to trough. Kept near unit height, so the
 * terrain reads as terrain and never as a wall an army walks into.
 */
export const GROUND_RELIEF = 4.6;

export const worldX = (fieldX: number): number => (fieldX - 0.5) * FIELD.width;
export const worldZ = (fieldY: number): number => (fieldY - 0.5) * FIELD.depth;

/**
 * Height of the ground under a world position.
 *
 * Value noise rather than a texture, for one reason: both the terrain mesh and
 * every unit standing on it call this. A heightmap sampled two different ways
 * puts the army above the ground exactly where the ground stops being flat, and
 * that is the kind of fault that only shows up on the slope nobody screenshotted.
 *
 * Deterministic, so a screenshot of the field is reproducible and the tests are
 * not chasing a new landscape each run.
 */
export function groundHeight(x: number, z: number): number {
  // Two octaves: a slow roll that the camera reads as landscape, and a finer
  // one that keeps ranks from looking like they are standing on glass.
  const broad = valueNoise(x / 34, z / 34) - 0.5;
  const fine = valueNoise(x / 11 + 19, z / 11 + 7) - 0.5;
  return (broad * 0.78 + fine * 0.22) * GROUND_RELIEF;
}

/**
 * How warm the light should be, from where the line has ended up.
 *
 * `moodWarmth` in PLAN.md §6: 1 when the orcs are pressing and the field is lit
 * by their fires, 0 when the Nexus is. Derived from the front line rather than
 * from the unit counts because the line is the thing already smoothed — counts
 * jump on every whale, and a light that jumped with them would strobe.
 */
export function moodFromFront(frontFieldY: number): number {
  const t = 0.5 + (frontFieldY - 0.5) / 0.68;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const fade = (t: number): number => t * t * (3 - 2 * t);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hash to 0…1. `sin` is not a good hash, but it is a stable one. */
function hash(x: number, z: number): number {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43_758.545_312_3;
  return n - Math.floor(n);
}

function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(z - zi);
  return lerp(
    lerp(hash(xi, zi), hash(xi + 1, zi), u),
    lerp(hash(xi, zi + 1), hash(xi + 1, zi + 1), u),
    v,
  );
}
