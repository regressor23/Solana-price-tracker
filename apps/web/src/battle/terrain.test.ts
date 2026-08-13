import { describe, expect, it } from 'vitest';

import { buildGround } from './terrain.js';
import { FIELD, GROUND, groundHeight } from './world.js';

/**
 * The ground mesh, checked against the function the units stand on.
 *
 * This is the whole reason `groundHeight` is a shared function rather than two
 * conveniently similar pieces of noise: if these ever disagree, the army floats
 * — and only on the slopes, which is to say only in the screenshots nobody took.
 */

describe('the ground mesh', () => {
  const geometry = buildGround();
  const position = geometry.attributes['position']!;

  it('puts every vertex exactly where a unit standing there would be', () => {
    for (let i = 0; i < position.count; i += 7) {
      expect(position.getY(i)).toBeCloseTo(
        groundHeight(position.getX(i), position.getZ(i)),
        6,
      );
    }
  });

  it('runs well past the field, so the horizon is not a cut edge', () => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < position.count; i++) {
      minX = Math.min(minX, position.getX(i));
      maxX = Math.max(maxX, position.getX(i));
      minZ = Math.min(minZ, position.getZ(i));
      maxZ = Math.max(maxZ, position.getZ(i));
    }
    expect(maxX - minX).toBeCloseTo(GROUND.width);
    expect(maxZ - minZ).toBeCloseTo(GROUND.depth);
    // And the field is well inside it — the tactical camera sits a field's
    // length behind the near base and still has to land on ground.
    expect(GROUND.width).toBeGreaterThan(FIELD.width * 2);
    expect(GROUND.depth).toBeGreaterThan(FIELD.depth * 3);
  });

  it('is fine enough that the relief is not sampled away', () => {
    // Vertices further apart than the noise's short wavelength would flatten
    // the hills into facets and leave units standing off the visible surface.
    const spacing = GROUND.width / Math.sqrt(position.count);
    expect(spacing).toBeLessThan(2.5);
  });

  it('has normals, or nothing would be lit', () => {
    const normal = geometry.attributes['normal']!;
    expect(normal.count).toBe(position.count);
    // Flat ground would point every normal straight up; rolling ground must not.
    let tilted = 0;
    for (let i = 0; i < normal.count; i++) if (normal.getY(i) < 0.999) tilted++;
    expect(tilted).toBeGreaterThan(normal.count / 2);
  });
});
