import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
} from 'three';

import { BALANCE, type Faction } from '@sol-warzone/protocol';

import type { Unit } from './field.js';
import type { ScenePalette } from './palette.js';
import { groundHeight, worldX, worldZ } from './world.js';

/**
 * One faction, drawn as one instanced mesh.
 *
 * Not six meshes for role×faction, as the plan used to say: the wire carries
 * `orcAlive`, `nexusAlive` and `frontLine`, and nothing about roles. Splitting
 * the draw by a distinction the data does not make would have been six meshes
 * of invented information.
 *
 * The geometry is passed in rather than chosen here. Phase 5 replaces the
 * primitives with loaded models, and when it does, this file should not need to
 * know — that is the seam the plan asks phase 4 to leave.
 */

/**
 * Instance capacity. `poolPerSide` is the live ceiling, and the dying stay on
 * screen for half a second past it, so the pool has to hold both. Doubling is
 * far more headroom than the arithmetic needs and costs 32 KB of matrices.
 */
const CAPACITY = BALANCE.poolPerSide * 2;

const SPAWN_SEC = 0.4;
const DEATH_SEC = 0.5;

export class Army {
  readonly mesh: InstancedMesh;
  readonly #faction: Faction;
  readonly #dummy = new Object3D();
  readonly #color = new Color();
  readonly #live: Color;
  readonly #hit: Color;

  constructor(faction: Faction, geometry: BufferGeometry, palette: ScenePalette) {
    this.#faction = faction;
    this.#live = new Color(1, 1, 1);
    this.#hit = new Color().setStyle(palette.impactFlash);

    const orc = faction === 'orc';
    const material = new MeshStandardMaterial({
      color: new Color().setStyle(orc ? palette.orc : palette.nexus),
      // The two sides are lit differently on purpose (DESIGN_BRIEF §4.3): orcs
      // are physical and take the scene's light, the Nexus makes its own.
      roughness: orc ? 0.92 : 0.35,
      metalness: orc ? 0.05 : 0.15,
      emissive: new Color().setStyle(orc ? palette.orcEmissive : palette.nexusEmissive),
      emissiveIntensity: orc ? 0.06 : 0.55,
      flatShading: true,
    });

    this.mesh = new InstancedMesh(geometry, material, CAPACITY);
    this.mesh.name = `army:${faction}`;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    // The pool spans the whole field and the camera sits inside its bounds at
    // the `front` preset; culling it as one object would blink the army out.
    this.mesh.frustumCulled = false;
  }

  /**
   * Lay this faction's units out for the current frame.
   *
   * Every living unit is written every frame. That is 250 matrices at 60 Hz,
   * which is nothing next to the draw it saves — and the alternative, tracking
   * which instances moved, would have to be correct about a population that
   * changes ten times a second.
   */
  sync(units: readonly Unit[], timeSec: number): void {
    let index = 0;

    for (const unit of units) {
      if (unit.faction !== this.#faction) continue;
      if (index >= CAPACITY) break;

      const x = worldX(unit.x);
      const z = worldZ(unit.y);
      const ground = groundHeight(x, z);

      // A per-unit phase, so a rank breathes instead of pulsing in unison.
      const phase = unit.id * 0.7;
      let scale = 1;
      let lean = 0;
      let lift = 0;

      switch (unit.state) {
        case 'spawning': {
          // Both sides arrive rather than appear, but differently: the Nexus
          // materialises from above (§6 warp-in), orcs come up out of the mud.
          const t = Math.min(1, unit.stateAge / SPAWN_SEC);
          scale = 0.25 + 0.75 * t * t;
          lift = this.#faction === 'nexus' ? (1 - t) * 7 : -(1 - t) * 1.6;
          break;
        }
        case 'dying': {
          // Falls and shrinks at once. A unit that only faded would leave a
          // hole in the rank; one that only fell would still be a silhouette.
          const t = Math.min(1, unit.stateAge / DEATH_SEC);
          scale = 1 - t * 0.75;
          lean = t * (Math.PI / 2);
          break;
        }
        case 'fighting': {
          // Swinging, not standing. The bob is what tells a held line from a
          // stalled one at tactical range, where no animation would be visible.
          scale = 1 + Math.sin(timeSec * 9 + phase) * 0.07;
          lift = Math.abs(Math.sin(timeSec * 9 + phase)) * 0.35;
          break;
        }
        default: {
          lift = Math.abs(Math.sin(timeSec * 4.5 + phase)) * 0.22;
          break;
        }
      }

      this.#dummy.position.set(x, ground + lift, z);
      // Face the enemy: orcs hold the −z end and march toward +z.
      this.#dummy.rotation.set(
        lean * (this.#faction === 'orc' ? 1 : -1),
        this.#faction === 'orc' ? 0 : Math.PI,
        0,
      );
      this.#dummy.scale.setScalar(Math.max(0.001, scale));
      this.#dummy.updateMatrix();
      this.mesh.setMatrixAt(index, this.#dummy.matrix);

      // Instance colour multiplies the diffuse, so it can brighten a fighter
      // and burn out a casualty without a second material.
      if (unit.state === 'dying') {
        const t = Math.min(1, unit.stateAge / DEATH_SEC);
        this.#color.copy(this.#hit).multiplyScalar(1.6 * (1 - t));
      } else if (unit.state === 'fighting') {
        this.#color.setScalar(1.15);
      } else {
        this.#color.copy(this.#live);
      }
      this.mesh.setColorAt(index, this.#color);

      index++;
    }

    this.mesh.count = index;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}

/**
 * Placeholder silhouettes.
 *
 * Two shapes chosen so the sides are told apart with the colour taken away —
 * orcs squat and heavy, the Nexus tall and sharp. That is the property phase 5
 * has to preserve when real models land, and stating it as geometry now is
 * cheaper than discovering it from a screenshot later.
 */
export function unitGeometry(faction: Faction): BufferGeometry {
  const geometry =
    faction === 'orc'
      ? new CylinderGeometry(0.62, 1.05, 1.9, 5)
      : new ConeGeometry(0.72, 2.7, 4);
  // Origin at the feet, so placing a unit is placing it on the ground rather
  // than half-buried in it.
  geometry.translate(0, faction === 'orc' ? 0.95 : 1.35, 0);
  return geometry;
}
