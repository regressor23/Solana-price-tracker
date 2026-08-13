import type { Pulse } from '@sol-warzone/protocol';
import {
  type Color,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  type Points,
  Quaternion,
  type ShaderMaterial,
  Vector3,
  type DirectionalLight,
} from 'three';
import { describe, expect, it } from 'vitest';

import { BattleField } from './field.js';
import type { ScenePalette } from './palette.js';
import { BattleScene } from './scene.js';
import { groundHeight, GROUND_RELIEF, worldZ } from './world.js';

/**
 * The 3D scene, stepped without a GPU.
 *
 * `BattleScene` holds no `WebGLRenderer` precisely so this file can exist: a
 * scene graph is matrices, and matrices can be read back. What is checked here
 * is what a screenshot would have to be inspected for anyway — that the army
 * stands on the ground, that it is where the count says, that the two sides are
 * on their own halves — except that it is checked on every run rather than on
 * the days somebody remembers to look.
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

const seeded = (): (() => number) => {
  let state = 20_260_813;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const pulse = (
  orcAlive: number,
  nexusAlive: number,
  frontLine = 0,
): Omit<Pulse, 'type' | 't'> => ({ orcAlive, nexusAlive, frontLine });

const STEP = 1 / 60;

function drive(scene: BattleScene, field: BattleField, seconds: number): void {
  for (let i = 0; i < seconds * 60; i++) {
    field.advance(1_000 / 60);
    scene.update(field, STEP);
  }
}

function setup(): { scene: BattleScene; field: BattleField } {
  return {
    scene: new BattleScene(palette),
    field: new BattleField({ random: seeded() }),
  };
}

const army = (scene: BattleScene, faction: string): InstancedMesh =>
  scene.scene.getObjectByName(`army:${faction}`) as InstancedMesh;

interface Placed {
  position: Vector3;
  scale: Vector3;
}

/** Read an instance back out of the matrix buffer. */
function placed(mesh: InstancedMesh, index: number): Placed {
  const matrix = new Matrix4();
  mesh.getMatrixAt(index, matrix);
  const position = new Vector3();
  const scale = new Vector3();
  matrix.decompose(position, new Quaternion(), scale);
  return { position, scale };
}

function all(mesh: InstancedMesh): Placed[] {
  return Array.from({ length: mesh.count }, (_, i) => placed(mesh, i));
}

describe('the armies', () => {
  it('draws exactly what the field holds and no leftovers', () => {
    // The instance pool is far larger than the field ever gets. Anything that
    // forgot to move `count` would leave a rank of stale units standing where
    // they died several minutes ago.
    const { scene, field } = setup();
    field.applyPulse(pulse(203, 138));
    drive(scene, field, 1);

    expect(army(scene, 'orc').count).toBe(
      field.units.filter((u) => u.faction === 'orc').length,
    );
    expect(army(scene, 'nexus').count).toBe(
      field.units.filter((u) => u.faction === 'nexus').length,
    );

    field.applyPulse(pulse(90, 138));
    drive(scene, field, 2);
    expect(army(scene, 'orc').count).toBe(
      field.units.filter((u) => u.faction === 'orc').length,
    );
  });

  it('stands them on the ground rather than above or under it', () => {
    // The one fault that a flat test field would never show: terrain and units
    // must sample the same height function, or the army floats over the hills.
    const { scene, field } = setup();
    field.applyPulse(pulse(180, 180));
    drive(scene, field, 4);

    for (const faction of ['orc', 'nexus']) {
      for (const unit of all(army(scene, faction))) {
        const ground = groundHeight(unit.position.x, unit.position.z);
        expect(unit.position.y).toBeGreaterThanOrEqual(ground - 0.01);
        expect(unit.position.y - ground).toBeLessThan(1);
      }
    }
  });

  it('keeps each side on its own half of the line', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(160, 160, 0.4));
    drive(scene, field, 5);

    const front = worldZ(field.frontY);
    for (const unit of all(army(scene, 'orc'))) {
      expect(unit.position.z).toBeLessThan(front + 2);
    }
    for (const unit of all(army(scene, 'nexus'))) {
      expect(unit.position.z).toBeGreaterThan(front - 2);
    }
  });

  it('collapses the dying instead of deleting them', () => {
    // A casualty that vanished between frames is the picture contradicting
    // itself: the count fell, and nothing on screen accounted for it.
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200));
    drive(scene, field, 2);

    field.applyPulse(pulse(160, 200));
    drive(scene, field, 0.25);

    const shrunk = all(army(scene, 'orc')).filter((u) => u.scale.y < 0.9);
    expect(shrunk.length).toBeGreaterThan(20);
  });

  it('never asks for more instances than the pool holds', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(250, 250));
    drive(scene, field, 1);
    for (const faction of ['orc', 'nexus']) {
      const mesh = army(scene, faction);
      expect(mesh.count).toBeLessThanOrEqual(mesh.instanceMatrix.count);
    }
  });
});

describe('the ground', () => {
  it('hands over territory as the line moves', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200, 0));
    drive(scene, field, 1);

    const material = (scene.scene.getObjectByName('terrain') as Mesh)
      .material as ShaderMaterial;
    const centred = material.uniforms['uFront']!.value as number;

    field.applyPulse(pulse(200, 200, 0.9));
    drive(scene, field, 3);
    const pushed = material.uniforms['uFront']!.value as number;

    expect(centred).toBeCloseTo(0, 1);
    // The Nexus is winning, so the boundary moves toward the orc end, which is
    // −z. The shader is given world coordinates, not the field's 0…1.
    expect(pushed).toBeLessThan(-15);
  });
});

describe('the light', () => {
  it('warms when the orcs take the field and cools when they lose it', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(240, 90, -0.9));
    drive(scene, field, 12);

    const key = scene.scene.getObjectByName('key-light') as DirectionalLight;
    const warm = key.color.clone();

    field.applyPulse(pulse(90, 240, 0.9));
    drive(scene, field, 12);
    const cool = key.color.clone();

    expect(warmth(warm)).toBeGreaterThan(warmth(cool));
  });

  it('changes over a round, not over a trade', () => {
    // Mood follows the front line rather than the counts for this reason, and
    // is damped on top of it. A light that tracked casualties would strobe.
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200, 0));
    drive(scene, field, 6);

    const key = scene.scene.getObjectByName('key-light') as DirectionalLight;
    const before = warmth(key.color);

    field.applyPulse(pulse(60, 240, 1));
    drive(scene, field, 0.2);

    expect(Math.abs(warmth(key.color) - before)).toBeLessThan(0.1);
  });
});

describe('the camera', () => {
  it('opens on the shot instead of flying into it', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200, 0));
    field.advance(1_000 / 60);
    scene.update(field, STEP);

    // Easing from the origin would start every session with a dolly nobody
    // asked for, and the first thing anyone sees would be the underside of the
    // terrain.
    expect(scene.camera.position.y).toBeGreaterThan(GROUND_RELIEF);
    expect(scene.camera.position.length()).toBeGreaterThan(50);
  });

  it('follows a moving line without cutting to it', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200, 0));
    drive(scene, field, 2);
    const settled = scene.camera.position.z;

    field.applyPulse(pulse(60, 240, 1));
    field.advance(1_000 / 60);
    scene.update(field, STEP);
    const afterOneFrame = scene.camera.position.z;

    drive(scene, field, 6);
    const moved = scene.camera.position.z;

    expect(Math.abs(afterOneFrame - settled)).toBeLessThan(2);
    expect(moved).toBeLessThan(settled - 10);
  });

  it('changes shot when the preset changes', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200, 0));
    drive(scene, field, 2);
    const tactical = scene.camera.position.y;

    scene.setPreset('front');
    drive(scene, field, 4);

    expect(scene.preset).toBe('front');
    expect(scene.camera.position.y).toBeLessThan(tactical / 2);
  });
});

describe('bursts', () => {
  it('marks a death where the unit fell', () => {
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200));
    drive(scene, field, 2);
    const quiet = emitted(scene);

    // Under the resync threshold on purpose: past it the field rebuilds rather
    // than kills, and the next test is the one about that.
    field.applyPulse(pulse(175, 200));
    drive(scene, field, 0.1);

    expect(emitted(scene)).toBeGreaterThan(quiet);
  });

  it('stays silent through a resync', () => {
    // A resync is the client admitting it lost the thread. Four hundred units
    // are rebuilt in one frame, and every one of them would otherwise warp in.
    const { scene, field } = setup();
    field.applyPulse(pulse(200, 200));
    drive(scene, field, 2);
    const quiet = emitted(scene);

    field.applyPulse(pulse(60, 250), 5_000);
    expect(field.resyncs).toBeGreaterThan(0);
    drive(scene, field, 0.05);

    expect(emitted(scene)).toBe(quiet);
  });
});

/** How many particles have ever been given a birth time. */
function emitted(scene: BattleScene): number {
  const points = scene.scene.getObjectByName('bursts') as Points;
  const birth = points.geometry.getAttribute('aBirth');
  let count = 0;
  for (let i = 0; i < birth.count; i++) if (birth.getX(i) >= 0) count++;
  return count;
}

/** Positive when a colour leans orange, negative when it leans cyan. */
const warmth = (color: Color): number => color.r - color.b;
