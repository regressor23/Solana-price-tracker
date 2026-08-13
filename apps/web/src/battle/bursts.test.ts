import { BALANCE } from '@sol-warzone/protocol';
import type { BufferAttribute, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { Bursts } from './bursts.js';
import type { ScenePalette } from './palette.js';

/**
 * The particle pool.
 *
 * Fixed size and never compacted, so the only ways it can go wrong are the two
 * that leave no trace: writing past the end of an attribute, and running out of
 * room on the one frame that matters — the whale that takes sixty units at once
 * and is the loudest thing the product ever shows.
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

const attribute = (bursts: Bursts, name: string): BufferAttribute =>
  bursts.points.geometry.getAttribute(name) as BufferAttribute;

const uniforms = (bursts: Bursts): ShaderMaterial['uniforms'] =>
  (bursts.points.material as ShaderMaterial).uniforms;

/** Particles whose birth time falls inside the run. */
function live(bursts: Bursts): number {
  const birth = attribute(bursts, 'aBirth');
  let count = 0;
  for (let i = 0; i < birth.count; i++) if (birth.getX(i) >= 0) count++;
  return count;
}

describe('an untouched pool', () => {
  it('draws nothing', () => {
    // Every particle is born long ago and already spent, so a scene with no
    // casualties yet is not a scene covered in sparks at the origin.
    const bursts = new Bursts(palette);
    expect(live(bursts)).toBe(0);
    expect(attribute(bursts, 'aBirth').getX(0)).toBeLessThan(0);
  });
});

describe('emitting', () => {
  it('throws a spread of directions, not one line of sparks', () => {
    const bursts = new Bursts(palette);
    bursts.death('orc', 10, 2, -30, 1);

    const velocity = attribute(bursts, 'aVelocity');
    const xs = new Set<number>();
    for (let i = 0; i < live(bursts); i++) xs.add(velocity.getX(i));
    expect(xs.size).toBeGreaterThan(4);
  });

  it('sends the debris up before gravity takes it', () => {
    const bursts = new Bursts(palette);
    bursts.death('nexus', 0, 0, 0, 1);

    const velocity = attribute(bursts, 'aVelocity');
    for (let i = 0; i < live(bursts); i++) {
      expect(velocity.getY(i)).toBeGreaterThan(0);
    }
  });

  it('puts the effect where the unit was', () => {
    const bursts = new Bursts(palette);
    bursts.spawn('nexus', 42, 3, -17, 5);

    const position = attribute(bursts, 'position');
    for (let i = 0; i < live(bursts); i++) {
      expect(Math.abs(position.getX(i) - 42)).toBeLessThan(3);
      expect(Math.abs(position.getZ(i) + 17)).toBeLessThan(3);
    }
  });

  it('gives arrivals a ring and deaths a shower', () => {
    // The two effects have to read as opposites, because they mean opposite
    // things and the client has no other way of saying which just happened.
    const spawned = new Bursts(palette);
    spawned.spawn('nexus', 0, 0, 0, 0);
    const spawnVelocity = attribute(spawned, 'aVelocity');
    let spawnSpread = 0;
    for (let i = 0; i < live(spawned); i++) {
      spawnSpread = Math.max(spawnSpread, Math.abs(spawnVelocity.getX(i)));
    }

    const died = new Bursts(palette);
    died.death('nexus', 0, 0, 0, 0);
    const deathVelocity = attribute(died, 'aVelocity');
    let deathSpread = 0;
    for (let i = 0; i < live(died); i++) {
      deathSpread = Math.max(deathSpread, Math.abs(deathVelocity.getX(i)));
    }

    expect(deathSpread).toBeGreaterThan(spawnSpread * 2);
  });

  it('gives every particle a finite trajectory', () => {
    // A NaN here is permanent: the attribute is never rewritten until the ring
    // wraps, so one bad particle is a stuck vertex for the next two thousand.
    const bursts = new Bursts(palette);
    bursts.death('orc', 1, 2, 3, 0.5);
    bursts.spawn('orc', 1, 2, 3, 0.5);

    for (const name of ['position', 'aVelocity', 'aTint', 'aBirth', 'aLife', 'aSize']) {
      const values = attribute(bursts, name).array;
      for (const value of values) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('the worst frame the balance allows', () => {
  it('has room for a whale taking the maximum in one blow', () => {
    // `maxUnitsPerTrade` deaths land on a single frame. If the pool cannot hold
    // that, the effect eats its own beginning and the blow reads as smaller
    // than it was — which is exactly backwards.
    const bursts = new Bursts(palette);
    for (let i = 0; i < BALANCE.maxUnitsPerTrade; i++) {
      bursts.death('orc', i, 0, 0, 1);
    }
    expect(live(bursts)).toBe(BALANCE.maxUnitsPerTrade * 14);
    expect(live(bursts)).toBeLessThanOrEqual(attribute(bursts, 'aBirth').count);
  });

  it('overwrites its own tail rather than growing or throwing', () => {
    const bursts = new Bursts(palette);
    const capacity = attribute(bursts, 'aBirth').count;

    expect(() => {
      for (let i = 0; i < capacity; i++) bursts.death('orc', 0, 0, 0, i);
    }).not.toThrow();

    expect(attribute(bursts, 'aBirth').count).toBe(capacity);
    expect(live(bursts)).toBe(capacity);
  });
});

describe('the clock', () => {
  it('is the only thing that moves once a particle is emitted', () => {
    // The whole trajectory lives in the shader. If the CPU had to touch each
    // particle per frame, a whale would cost sixty writes every frame instead
    // of sixty once.
    const bursts = new Bursts(palette);
    bursts.death('orc', 0, 0, 0, 1);
    const before = Array.from(attribute(bursts, 'position').array);

    bursts.update(9);

    expect(uniforms(bursts)['uTime']?.value).toBe(9);
    expect(Array.from(attribute(bursts, 'position').array)).toEqual(before);
  });

  it('scales point size with the backing store', () => {
    // Point size is in device pixels, so a retina canvas with an unchanged
    // scale draws sparks at half the size the design asked for.
    const bursts = new Bursts(palette);
    bursts.setPixelScale(1080);
    const tall = uniforms(bursts)['uScale']?.value as number;
    bursts.setPixelScale(540);
    expect(uniforms(bursts)['uScale']?.value).toBeLessThan(tall);
  });

  it('survives being asked to update before anything happened', () => {
    const bursts = new Bursts(palette);
    expect(() => bursts.update(0)).not.toThrow();
    expect(() => bursts.dispose()).not.toThrow();
  });
});
