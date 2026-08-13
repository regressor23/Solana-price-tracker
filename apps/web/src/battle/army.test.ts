import { BALANCE, type Faction } from '@sol-warzone/protocol';
import { Color, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Army, unitGeometry } from './army.js';
import type { ScenePalette } from './palette.js';
import type { Unit, UnitState } from './field.js';
import { groundHeight, worldX, worldZ } from './world.js';

/**
 * One faction's instances, driven directly rather than through a field.
 *
 * `scene.test.ts` checks that a running battle ends up looking right; this
 * checks the cases a running battle almost never produces — a pool asked for
 * more units than it holds, a unit at the instant it dies, a population that
 * shrinks — where being almost right is indistinguishable from being right
 * until the day it is not.
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

const army = (faction: Faction): Army =>
  new Army(faction, unitGeometry(faction), palette);

let nextId = 1;

function unit(faction: Faction, over: Partial<Unit> = {}): Unit {
  return {
    id: nextId++,
    faction,
    x: 0.5,
    y: faction === 'orc' ? 0.3 : 0.7,
    state: 'marching',
    stateAge: 0,
    rank: 0,
    ...over,
  };
}

interface Placed {
  position: Vector3;
  rotation: Euler;
  /** Which way the instance is turned — asked of the rotation, not read off it. */
  facing: Vector3;
  scale: Vector3;
}

function placed(a: Army, index: number): Placed {
  const matrix = new Matrix4();
  a.mesh.getMatrixAt(index, matrix);
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return {
    position,
    rotation: new Euler().setFromQuaternion(quaternion),
    // A yaw of π decomposes into several equivalent Euler triples, none of them
    // reliably (0, π, 0). Turning a vector by the quaternion asks the question
    // that was actually meant.
    facing: new Vector3(0, 0, 1).applyQuaternion(quaternion),
    scale,
  };
}

const colorAt = (a: Army, index: number): Color => {
  const color = new Color();
  a.mesh.getColorAt(index, color);
  return color;
};

describe('the pool', () => {
  it('draws only its own faction', () => {
    const orcs = army('orc');
    orcs.sync([unit('orc'), unit('nexus'), unit('orc'), unit('nexus')], 0);
    expect(orcs.mesh.count).toBe(2);
  });

  it('shrinks with the army rather than leaving stale instances standing', () => {
    const orcs = army('orc');
    const units = Array.from({ length: 30 }, () => unit('orc'));
    orcs.sync(units, 0);
    expect(orcs.mesh.count).toBe(30);

    orcs.sync(units.slice(0, 4), 0);
    expect(orcs.mesh.count).toBe(4);
  });

  it('refuses to draw past its capacity instead of writing off the end', () => {
    // The field clamps to the pool, so this should be unreachable — which is
    // exactly why it is worth pinning. Writing past the matrix buffer is not an
    // exception, it is a silently corrupted instance somewhere else.
    const orcs = army('orc');
    const capacity = orcs.mesh.instanceMatrix.count;
    const units = Array.from({ length: capacity + 50 }, () => unit('orc'));

    expect(() => orcs.sync(units, 0)).not.toThrow();
    expect(orcs.mesh.count).toBe(capacity);
    expect(capacity).toBeGreaterThanOrEqual(BALANCE.poolPerSide);
  });

  it('handles an empty army without drawing anything', () => {
    const orcs = army('orc');
    orcs.sync([unit('nexus')], 0);
    expect(orcs.mesh.count).toBe(0);
  });
});

describe('placement', () => {
  it('puts a unit at its own coordinates, on the ground', () => {
    const orcs = army('orc');
    orcs.sync([unit('orc', { x: 0.2, y: 0.35, state: 'fighting', stateAge: 5 })], 0);

    const { position } = placed(orcs, 0);
    expect(position.x).toBeCloseTo(worldX(0.2));
    expect(position.z).toBeCloseTo(worldZ(0.35));
    expect(position.y).toBeGreaterThanOrEqual(groundHeight(position.x, position.z));
  });

  it('turns the two sides to face each other', () => {
    // Orcs hold the −z end and the Nexus the +z one. A faction rendered facing
    // its own base is an army with its back to the fight.
    const orcs = army('orc');
    const nexus = army('nexus');
    orcs.sync([unit('orc')], 0);
    nexus.sync([unit('nexus')], 0);

    expect(placed(orcs, 0).facing.z).toBeCloseTo(1);
    expect(placed(nexus, 0).facing.z).toBeCloseTo(-1);
  });

  it('never scales an instance to nothing', () => {
    // A zero scale makes the matrix singular, and `decompose` on a singular
    // matrix is undefined behaviour that shows up much later as NaN positions.
    const orcs = army('orc');
    orcs.sync([unit('orc', { state: 'dying', stateAge: 10 })], 0);

    const { scale, position } = placed(orcs, 0);
    expect(scale.x).toBeGreaterThan(0);
    expect(Number.isFinite(position.x)).toBe(true);
    expect(Number.isFinite(position.y)).toBe(true);
  });
});

describe('states', () => {
  it('grows a new unit in rather than popping it into the line', () => {
    const orcs = army('orc');
    orcs.sync([unit('orc', { state: 'spawning', stateAge: 0 })], 0);
    const arriving = placed(orcs, 0).scale.y;

    orcs.sync([unit('orc', { state: 'spawning', stateAge: 0.35 })], 0);
    const nearlyThere = placed(orcs, 0).scale.y;

    expect(arriving).toBeLessThan(0.4);
    expect(nearlyThere).toBeGreaterThan(arriving);
    expect(nearlyThere).toBeLessThanOrEqual(1);
  });

  it('warps the Nexus in from above and pushes orcs up out of the ground', () => {
    // §6: the Nexus materialises, orcs arrive. Same state, opposite direction,
    // and it is the only thing distinguishing the two spawns without art.
    const orcs = army('orc');
    const nexus = army('nexus');
    const fresh = { state: 'spawning' as UnitState, stateAge: 0 };
    orcs.sync([unit('orc', fresh)], 0);
    nexus.sync([unit('nexus', fresh)], 0);

    const orcY = placed(orcs, 0).position;
    const nexusY = placed(nexus, 0).position;
    expect(orcY.y).toBeLessThan(groundHeight(orcY.x, orcY.z));
    expect(nexusY.y).toBeGreaterThan(groundHeight(nexusY.x, nexusY.z) + 3);
  });

  it('collapses a casualty over its death, not at the end of it', () => {
    const orcs = army('orc');
    const scales = [0, 0.15, 0.3, 0.45].map((stateAge) => {
      orcs.sync([unit('orc', { id: 7, state: 'dying', stateAge })], 0);
      return placed(orcs, 0).scale.y;
    });

    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]!).toBeLessThan(scales[i - 1]!);
    }
  });

  it('tips a casualty over as it falls', () => {
    const orcs = army('orc');
    orcs.sync([unit('orc', { state: 'dying', stateAge: 0.45 })], 0);
    expect(Math.abs(placed(orcs, 0).rotation.x)).toBeGreaterThan(1);
  });

  it('burns a casualty to the impact colour and then out', () => {
    // The flash is what makes a whale read as a blow. It has to be brightest at
    // the moment of the hit and gone by the time the body lands.
    const orcs = army('orc');
    orcs.sync([unit('orc', { state: 'dying', stateAge: 0 })], 0);
    const struck = colorAt(orcs, 0).getHSL({ h: 0, s: 0, l: 0 }).l;

    orcs.sync([unit('orc', { state: 'dying', stateAge: 0.45 })], 0);
    const spent = colorAt(orcs, 0).getHSL({ h: 0, s: 0, l: 0 }).l;

    expect(struck).toBeGreaterThan(spent);
  });

  it('lifts a fighter above a marching one so the line is visibly busy', () => {
    // At tactical range no animation is legible; the bob is the only thing
    // separating a held line from a stalled one.
    const orcs = army('orc');
    const at = (state: UnitState, time: number): number => {
      orcs.sync([unit('orc', { id: 3, state, stateAge: 4 })], time);
      return placed(orcs, 0).position.y;
    };

    const fighting = [0, 0.1, 0.2, 0.3].map((t) => at('fighting', t));
    expect(Math.max(...fighting) - Math.min(...fighting)).toBeGreaterThan(0.05);
  });
});

describe('silhouettes', () => {
  it('gives the sides different shapes, so colour is not the only signal', () => {
    // The property phase 5 has to preserve when real models land: the two
    // factions must be told apart with the colour taken away.
    const orc = unitGeometry('orc');
    const nexus = unitGeometry('nexus');
    orc.computeBoundingBox();
    nexus.computeBoundingBox();

    const orcBox = orc.boundingBox!;
    const nexusBox = nexus.boundingBox!;
    const ratio = (box: typeof orcBox): number =>
      (box.max.y - box.min.y) / (box.max.x - box.min.x);

    // Orcs squat and heavy, the Nexus tall and narrow.
    expect(ratio(nexusBox)).toBeGreaterThan(ratio(orcBox) * 1.5);
  });

  it('stands both on their feet rather than half-buried', () => {
    for (const faction of ['orc', 'nexus'] as const) {
      const geometry = unitGeometry(faction);
      geometry.computeBoundingBox();
      expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 1);
    }
  });
});
