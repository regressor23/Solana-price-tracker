import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
} from 'three';

import type { Faction } from '@sol-warzone/protocol';

import type { ScenePalette } from './palette.js';

/**
 * Warp-ins and deaths, as points on the GPU.
 *
 * These are the only two effects phase 4 draws, and the reason is the same one
 * that removed roles from the army: they are the only two the model actually
 * has. Arrows and psi-storms describe who is shooting at whom, and the server
 * does not say — it says how many are left. Inventing the rest would be
 * animation that contradicts the count the moment anyone checked.
 *
 * Every particle's whole trajectory is decided when it is emitted, so the CPU
 * writes six floats once and then never touches it again. A whale that kills
 * sixty units in one frame costs sixty writes, not sixty per frame after.
 */

/** Enough for the worst frame the balance allows: `maxUnitsPerTrade` deaths at once. */
const POOL = 2_048;

const PARTICLES_PER_DEATH = 14;
const PARTICLES_PER_SPAWN = 10;

const vertexShader = /* glsl */ `
  attribute vec3 aVelocity;
  attribute vec3 aTint;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;

  uniform float uTime;
  uniform float uScale;

  varying vec3 vTint;
  varying float vFade;

  void main() {
    float age = uTime - aBirth;
    // Spent particles are collapsed to nothing rather than removed: the pool is
    // fixed, and a zero-size point costs a vertex, not a draw.
    float alive = step(0.0, age) * step(age, aLife);
    vFade = alive * (1.0 - age / max(aLife, 0.0001));
    vTint = aTint;

    vec3 world = position + aVelocity * age + vec3(0.0, -9.0, 0.0) * age * age * 0.5;
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // Perspective-correct size, so a death at the far base is not the same
    // handful of pixels as one under the camera.
    gl_PointSize = alive * aSize * uScale / max(-mvPosition.z, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vTint;
  varying float vFade;

  void main() {
    // Round and soft. A square particle reads as a rendering fault at any size
    // where you can see its corners.
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5 || vFade <= 0.0) discard;
    float falloff = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vTint * falloff * vFade, falloff * vFade);
  }
`;

export class Bursts {
  readonly points: Points;
  readonly #geometry: BufferGeometry;
  readonly #material: ShaderMaterial;

  readonly #position: BufferAttribute;
  readonly #velocity: BufferAttribute;
  readonly #tint: BufferAttribute;
  readonly #birth: BufferAttribute;
  readonly #life: BufferAttribute;
  readonly #size: BufferAttribute;

  readonly #orcTint: Color;
  readonly #nexusTint: Color;
  readonly #flash: Color;

  #next = 0;
  #dirty = false;

  constructor(palette: ScenePalette) {
    this.#orcTint = new Color().setStyle(palette.orcEmissive);
    this.#nexusTint = new Color().setStyle(palette.nexusEmissive);
    this.#flash = new Color().setStyle(palette.impactFlash);

    this.#position = new BufferAttribute(new Float32Array(POOL * 3), 3);
    this.#velocity = new BufferAttribute(new Float32Array(POOL * 3), 3);
    this.#tint = new BufferAttribute(new Float32Array(POOL * 3), 3);
    // Born long ago and already spent, so an untouched pool draws nothing.
    this.#birth = new BufferAttribute(new Float32Array(POOL).fill(-1_000), 1);
    this.#life = new BufferAttribute(new Float32Array(POOL).fill(1), 1);
    this.#size = new BufferAttribute(new Float32Array(POOL), 1);

    this.#geometry = new BufferGeometry();
    this.#geometry.setAttribute('position', this.#position);
    this.#geometry.setAttribute('aVelocity', this.#velocity);
    this.#geometry.setAttribute('aTint', this.#tint);
    this.#geometry.setAttribute('aBirth', this.#birth);
    this.#geometry.setAttribute('aLife', this.#life);
    this.#geometry.setAttribute('aSize', this.#size);

    this.#material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uTime: { value: 0 }, uScale: { value: 300 } },
      transparent: true,
      blending: AdditiveBlending,
      // Sparks light what is behind them; writing depth would let one spark
      // punch a hole in the unit standing in front of it.
      depthWrite: false,
    });

    this.points = new Points(this.#geometry, this.#material);
    this.points.name = 'bursts';
    this.points.frustumCulled = false;
  }

  /** Dirt and sparks on the orc side, a shield coming apart on the Nexus one. */
  death(faction: Faction, x: number, y: number, z: number, now: number): void {
    const tint = faction === 'orc' ? this.#orcTint : this.#nexusTint;
    for (let i = 0; i < PARTICLES_PER_DEATH; i++) {
      // Half the shower is white-hot at the moment of impact, the rest keeps
      // the faction's colour — so a death reads as both a hit and a side.
      this.#emit(
        x,
        y + 1,
        z,
        (Math.random() - 0.5) * 9,
        2 + Math.random() * 8,
        (Math.random() - 0.5) * 9,
        i % 2 === 0 ? this.#flash : tint,
        0.45 + Math.random() * 0.35,
        7 + Math.random() * 6,
        now,
      );
    }
  }

  /** Arrival: a column rather than a shower, so it reads as the opposite. */
  spawn(faction: Faction, x: number, y: number, z: number, now: number): void {
    const tint = faction === 'orc' ? this.#orcTint : this.#nexusTint;
    for (let i = 0; i < PARTICLES_PER_SPAWN; i++) {
      const angle = (i / PARTICLES_PER_SPAWN) * Math.PI * 2;
      this.#emit(
        x + Math.cos(angle) * 1.2,
        y,
        z + Math.sin(angle) * 1.2,
        Math.cos(angle) * 1.6,
        6 + Math.random() * 4,
        Math.sin(angle) * 1.6,
        tint,
        0.4,
        5 + Math.random() * 3,
        now,
      );
    }
  }

  /** Advance the clock. Nothing moves on the CPU; the shader reads the age. */
  update(now: number): void {
    this.#material.uniforms['uTime']!.value = now;
    if (!this.#dirty) return;
    this.#dirty = false;
    for (const attribute of [
      this.#position,
      this.#velocity,
      this.#tint,
      this.#birth,
      this.#life,
      this.#size,
    ]) {
      attribute.needsUpdate = true;
    }
  }

  /** Point size is in pixels, so it has to follow the backing store. */
  setPixelScale(heightPx: number): void {
    this.#material.uniforms['uScale']!.value = heightPx * 0.42;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
  }

  #emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    tint: Color,
    life: number,
    size: number,
    now: number,
  ): void {
    // A ring, not a queue: the oldest particle is overwritten, which at 2048
    // means the effect degrades by dropping its own tail under a burst nobody
    // could follow anyway.
    const i = this.#next;
    this.#next = (this.#next + 1) % POOL;

    this.#position.setXYZ(i, x, y, z);
    this.#velocity.setXYZ(i, vx, vy, vz);
    this.#tint.setXYZ(i, tint.r, tint.g, tint.b);
    this.#birth.setX(i, now);
    this.#life.setX(i, life);
    this.#size.setX(i, size);
    this.#dirty = true;
  }
}
