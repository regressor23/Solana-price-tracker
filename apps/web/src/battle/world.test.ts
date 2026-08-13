import { describe, expect, it } from 'vitest';

import {
  FIELD,
  GROUND,
  GROUND_RELIEF,
  groundHeight,
  moodFromFront,
  worldX,
  worldZ,
} from './world.js';

/**
 * The arithmetic between the field's 0…1 and the scene's metres.
 *
 * Worth its own tests because two things sample the same ground — the terrain
 * mesh and every unit standing on it — and a disagreement between them is
 * invisible on flat ground and obvious nowhere else.
 */

describe('field to world', () => {
  it('puts the middle of the field at the origin', () => {
    expect(worldX(0.5)).toBe(0);
    expect(worldZ(0.5)).toBe(0);
  });

  it('gives the orcs the near end and the Nexus the far one', () => {
    // The 2D prototype put orcs at the top of the frame and the Nexus at the
    // bottom; in world terms that is −z and +z, and the camera looks down −z.
    expect(worldZ(0.08)).toBeLessThan(0);
    expect(worldZ(0.92)).toBeGreaterThan(0);
  });

  it('spans exactly the declared field', () => {
    expect(worldX(1) - worldX(0)).toBeCloseTo(FIELD.width);
    expect(worldZ(1) - worldZ(0)).toBeCloseTo(FIELD.depth);
  });
});

describe('ground', () => {
  it('is the same height every time it is asked', () => {
    // Units and terrain call this independently and per frame. Anything random
    // in here would make the army vibrate.
    expect(groundHeight(12.5, -30.25)).toBe(groundHeight(12.5, -30.25));
    expect(groundHeight(-44, 7)).toBe(groundHeight(-44, 7));
  });

  it('stays inside the relief it promises', () => {
    // The camera's ground clearance and the units' feet both assume this
    // bound; terrain that exceeded it would swallow either.
    for (let x = -GROUND.width / 2; x <= GROUND.width / 2; x += 3) {
      for (let z = -GROUND.depth / 2; z <= GROUND.depth / 2; z += 3) {
        expect(Math.abs(groundHeight(x, z))).toBeLessThanOrEqual(GROUND_RELIEF / 2);
      }
    }
  });

  it('rolls rather than steps', () => {
    // A discontinuity would be a cliff a rank walks off. Sampling at half a
    // world unit is finer than the mesh, so a seam cannot hide between samples.
    let worst = 0;
    for (let x = -60; x < 60; x += 0.5) {
      worst = Math.max(worst, Math.abs(groundHeight(x, 4) - groundHeight(x + 0.5, 4)));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('is not flat, which is the only reason it exists', () => {
    const samples = [];
    for (let x = -50; x <= 50; x += 10) samples.push(groundHeight(x, 0));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.8);
  });
});

describe('mood', () => {
  it('runs warm when the orcs press and cold when the Nexus does', () => {
    // The line sits below centre when the orcs are winning, because the Nexus
    // holds the far end and is being pushed back into it.
    expect(moodFromFront(0.8)).toBeGreaterThan(0.8);
    expect(moodFromFront(0.2)).toBeLessThan(0.2);
    expect(moodFromFront(0.5)).toBeCloseTo(0.5);
  });

  it('clamps, because the light has nowhere further to go', () => {
    expect(moodFromFront(-1)).toBe(0);
    expect(moodFromFront(2)).toBe(1);
  });
});
