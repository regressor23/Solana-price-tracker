import { Box3, type Mesh, Raycaster, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { BASE_Z, nexusPylon, orcFortress } from './bases.js';
import { CAMERA_PRESETS, shotFor } from './camera.js';
import type { ScenePalette } from './palette.js';
import { FIELD, groundHeight, worldZ } from './world.js';

/**
 * The two ends of the field.
 *
 * Most of what is checked here was learned by looking at a frame rather than by
 * reasoning about one. The Nexus pylon originally stood four units past the
 * spawn band with a beam rising out of it, and the tactical camera — which
 * stands behind that base and looks over it — put both squarely between the eye
 * and the entire battle. These are that lesson written down, so the next thing
 * added to a base has to clear the same bar.
 */

const palette: ScenePalette = {
  orc: '#c4472c',
  orcEmissive: '#ff7a2f',
  orcGround: '#2e1a12',
  nexus: '#00d4ff',
  nexusEmissive: '#7fffd4',
  nexusGround: '#0a2a3a',
  frontLine: '#f2e3c0',
  skyStorm: '#191218',
  skyNebula: '#0b1b2e',
  lightWarm: '#ffb26b',
  lightCool: '#8fe8ff',
  impactFlash: '#fff3d0',
};

interface Base {
  object: Object3D;
  z: number;
  name: string;
}

/** Each base with the z it was built around, so a test can ask about its ground. */
function bases(): Base[] {
  const built: Base[] = [
    { object: orcFortress(palette), z: BASE_Z.orc, name: 'fortress' },
    { object: nexusPylon(palette), z: BASE_Z.nexus, name: 'pylon' },
  ];
  for (const { object } of built) object.updateMatrixWorld(true);
  return built;
}

/** Every position the front line can reach, in field coordinates. */
const FRONTS = [0.16, 0.25, 0.4, 0.5, 0.6, 0.75, 0.84];

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((node) => {
    if ((node as Mesh).isMesh) found.push(node as Mesh);
  });
  return found;
}

describe('where they stand', () => {
  it('places them at opposite ends, the way the field is laid out', () => {
    // Orcs hold −z and the Nexus +z, matching `worldZ` and the 2D prototype's
    // top and bottom. A base on the wrong end is a battle fought backwards.
    expect(BASE_Z.orc).toBeLessThan(0);
    expect(BASE_Z.nexus).toBeGreaterThan(0);
  });

  it('keeps them off the field, so no unit ever stands inside one', () => {
    // Spawns land in a band at each end; a base overlapping that band would
    // have reinforcements walking out through a wall.
    expect(BASE_Z.orc).toBeLessThan(worldZ(0.08) - 10);
    expect(BASE_Z.nexus).toBeGreaterThan(worldZ(0.92) + 10);
  });

  it('sits each of them on the shared ground', () => {
    // The failure the terrain tests exist for, one scale up: a base that
    // sampled its own height would stand on air over the hills the army walks
    // on. Asked of the whole structure rather than of each part — a roof is
    // supposed to be above the ground, a fortress is not.
    for (const { object, z, name } of bases()) {
      const ground = groundHeight(0, z);
      const foot = new Box3().setFromObject(object).min.y;
      expect({ name, high: foot > ground + 1, sunk: foot < ground - 5 }).toEqual({
        name,
        high: false,
        sunk: false,
      });
    }
  });

  it('stays inside the ground it is standing on', () => {
    // The terrain runs past the field, but not forever.
    for (const { object } of bases()) {
      const box = new Box3().setFromObject(object);
      expect(Math.abs(box.min.z)).toBeLessThan(FIELD.depth * 1.7);
      expect(Math.abs(box.max.z)).toBeLessThan(FIELD.depth * 1.7);
    }
  });
});

describe('what they may not do', () => {
  it('never puts anything between the camera and the fighting', () => {
    // The beam finding, as an invariant, and it caught a second case the eye
    // had not: a circular orbit of any useful radius swings the camera past a
    // base, and from behind one the shot is a battle seen through a palisade.
    const built = bases().map((base) => base.object);
    const raycaster = new Raycaster();
    const blocked: string[] = [];

    for (const preset of CAMERA_PRESETS) {
      for (const frontY of FRONTS) {
        for (const time of [0, 15, 30, 45, 60, 75, 90, 105]) {
          const shot = shotFor(preset, frontY, 16 / 9, time);
          const eye = new Vector3(shot.position.x, shot.position.y, shot.position.z);
          const target = new Vector3(shot.target.x, shot.target.y, shot.target.z);
          const toTarget = target.clone().sub(eye);

          raycaster.set(eye, toTarget.clone().normalize());
          raycaster.far = toTarget.length();
          for (const hit of raycaster.intersectObjects(built, true)) {
            blocked.push(`${preset} at front ${frontY}, t=${time}: ${hit.object.type}`);
          }
        }
      }
    }

    expect(blocked).toEqual([]);
  });

  it('never lets the camera end up inside one', () => {
    // The tactical shot rides the front line and comes back level with the
    // Nexus base at a rout. Clipping through a wall is the one rendering fault
    // a viewer reads as the page itself being broken.
    // Boxes rather than bounding spheres: the fortress roof is a four-sided
    // cone turned 45°, whose axis-aligned sphere is twice the size of the roof
    // and reports a collision with a camera thirty units above it.
    const built = bases();
    const inside: string[] = [];
    // The near plane is 1; anything closer than this is already clipping.
    const margin = new Vector3(2, 2, 2);

    for (const preset of CAMERA_PRESETS) {
      for (const frontY of FRONTS) {
        for (const time of [0, 20, 55, 90]) {
          const shot = shotFor(preset, frontY, 16 / 9, time);
          const eye = new Vector3(shot.position.x, shot.position.y, shot.position.z);

          for (const { object, name } of built) {
            for (const mesh of meshes(object)) {
              const box = new Box3().setFromObject(mesh).expandByVector(margin);
              if (box.containsPoint(eye)) {
                inside.push(`${preset} at front ${frontY}, t=${time}: ${name}`);
              }
            }
          }
        }
      }
    }

    expect(inside).toEqual([]);
  });

  it('keeps both silhouettes under the height the camera can look over', () => {
    // The ceiling the beam failed. Stated as a number so the next tall thing
    // added to a base has to argue with it rather than slip past.
    const CEILING = 30;
    for (const { object, z, name } of bases()) {
      const height = new Box3().setFromObject(object).max.y - groundHeight(0, z);
      expect({ name, tooTall: height > CEILING }).toEqual({ name, tooTall: false });
    }
  });
});

describe('what they are for', () => {
  it('gives the two ends different shapes', () => {
    // The bases are what make the front line's position mean anything: a band
    // of colour halfway down an empty plane is halfway between nothing. They
    // have to be told apart at a glance — low and wide against tall and thin.
    const [fortress, pylon] = bases();
    const width = (base: Base): number => {
      const box = new Box3().setFromObject(base.object);
      return box.max.x - box.min.x;
    };
    expect(width(fortress!)).toBeGreaterThan(width(pylon!) * 2);
  });
});
