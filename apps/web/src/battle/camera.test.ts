import { describe, expect, it } from 'vitest';

import { CAMERA_PRESETS, dollyForAspect, shotFor } from './camera.js';
import { FIELD, groundHeight, worldZ } from './world.js';

/**
 * Framing, checked without a GPU.
 *
 * Every fault a camera can have is invisible in the medium where you would
 * notice it: a camera inside a hill renders a hill, a camera pointed at the
 * wrong end of the field renders an empty field, and both look like the scene
 * failed to load. Numbers say which.
 */

/** Half the field width a shot can see at the depth it is looking at. */
function visibleHalfWidth(shot: ReturnType<typeof shotFor>, aspect: number): number {
  const dx = shot.position.x - shot.target.x;
  const dy = shot.position.y - shot.target.y;
  const dz = shot.position.z - shot.target.z;
  const distance = Math.hypot(dx, dy, dz);
  return Math.tan((shot.fov / 2) * (Math.PI / 180)) * distance * aspect;
}

describe('every preset', () => {
  it('looks at the front line, wherever it has got to', () => {
    for (const preset of CAMERA_PRESETS) {
      for (const frontY of [0.16, 0.5, 0.84]) {
        const shot = shotFor(preset, frontY, 1.78, 3);
        // The tactical shot deliberately trails the line rather than tracking
        // it exactly, so the test is that it leans the right way, not that it
        // lands on it.
        const front = worldZ(frontY);
        expect(Math.sign(shot.target.z) === Math.sign(front) || front === 0).toBe(true);
        expect(Math.abs(shot.target.z)).toBeLessThanOrEqual(Math.abs(front) + 0.001);
      }
    }
  });

  it('follows the line as it travels', () => {
    for (const preset of CAMERA_PRESETS) {
      const pushedBack = shotFor(preset, 0.2, 1.78, 3).target.z;
      const pushedForward = shotFor(preset, 0.8, 1.78, 3).target.z;
      expect(pushedForward).toBeGreaterThan(pushedBack);
    }
  });

  it('keeps the eye out of the ground', () => {
    for (const preset of CAMERA_PRESETS) {
      for (let frontY = 0.1; frontY <= 0.9; frontY += 0.1) {
        for (const time of [0, 12, 40, 90]) {
          const { position } = shotFor(preset, frontY, 1.78, time);
          const floor = groundHeight(position.x, position.z);
          expect(position.y).toBeGreaterThan(floor + 4);
        }
      }
    }
  });

  it('stays above the field, looking down at it', () => {
    for (const preset of CAMERA_PRESETS) {
      const shot = shotFor(preset, 0.5, 1.78, 5);
      expect(shot.position.y).toBeGreaterThan(shot.target.y);
    }
  });
});

describe('tactical', () => {
  it('fits the whole field across anything from 4:3 up', () => {
    // The default shot is the one that has to answer "who is winning" at a
    // glance, and it cannot if a third of the front line is off screen.
    for (const aspect of [4 / 3, 1.6, 16 / 9, 21 / 9]) {
      const shot = shotFor('tactical', 0.5, aspect, 0);
      expect(visibleHalfWidth(shot, aspect) * 2).toBeGreaterThan(FIELD.width);
    }
  });

  it('trails the line instead of chasing it', () => {
    // Following the front exactly would swing the whole field through frame
    // every time a whale lands.
    const front = worldZ(0.8);
    const shot = shotFor('tactical', 0.8, 1.78, 0);
    expect(shot.target.z).toBeGreaterThan(0);
    expect(shot.target.z).toBeLessThan(front);
  });
});

describe('orbit', () => {
  it('gives each side the near ground in turn', () => {
    const angles = [0, 30, 60, 90].map(
      (t) => shotFor('orbit', 0.5, 1.78, t).position.x,
    );
    expect(Math.max(...angles)).toBeGreaterThan(10);
    expect(Math.min(...angles)).toBeLessThan(-10);
  });

  it('drifts rather than spins', () => {
    // A second of orbit should not be a visible cut. One degree is about the
    // most that reads as camera movement rather than as a jump.
    const a = shotFor('orbit', 0.5, 1.78, 10).position;
    const b = shotFor('orbit', 0.5, 1.78, 11).position;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(5);
  });
});

describe('time', () => {
  it('moves the orbit and nothing else', () => {
    // The two working shots have to be reproducible from the field alone: a
    // screenshot of the same battle taken twice must be the same screenshot,
    // and a camera that drifts on a clock makes every comparison a guess.
    for (const preset of ['tactical', 'front'] as const) {
      const early = shotFor(preset, 0.4, 1.78, 0);
      const late = shotFor(preset, 0.4, 1.78, 900);
      expect(late).toEqual(early);
    }

    expect(shotFor('orbit', 0.4, 1.78, 900)).not.toEqual(
      shotFor('orbit', 0.4, 1.78, 0),
    );
  });

  it('stays on the near side of the field however long it runs', () => {
    // The orbit is an ellipse rather than a circle for one reason: a circle of
    // any useful radius takes the eye past a base, and from behind one the shot
    // is the battle seen through a palisade.
    for (let time = 0; time < 400; time += 3) {
      const { position } = shotFor('orbit', 0.5, 1.78, time);
      expect(Math.abs(position.z)).toBeLessThan(FIELD.depth / 2 + 10);
    }
  });
});

describe('narrow viewports', () => {
  it('pull back, because the field is wider than a phone', () => {
    expect(dollyForAspect(9 / 16)).toBeGreaterThan(dollyForAspect(4 / 3));
    expect(dollyForAspect(4 / 3)).toBeGreaterThan(dollyForAspect(16 / 9));
  });

  it('never push in past the framing the shot was designed at', () => {
    // Ultra-wide gets more field for free; it must not get a closer camera,
    // which would crop the depth instead.
    expect(dollyForAspect(21 / 9)).toBe(1);
    expect(dollyForAspect(32 / 9)).toBe(1);
  });

  it('survive a viewport with no area at all', () => {
    // A hidden tab or a collapsed grid cell reports zero; a NaN camera never
    // recovers, because every later frame eases toward it.
    expect(dollyForAspect(0)).toBe(1);
    expect(Number.isFinite(shotFor('tactical', 0.5, 0, 0).position.y)).toBe(true);
  });
});
