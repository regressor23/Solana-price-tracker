import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
} from 'three';

import type { ScenePalette } from './palette.js';
import { FIELD, groundHeight, worldX } from './world.js';

/**
 * The two ends of the field.
 *
 * Not decoration: they are what makes the front line's position mean something.
 * A band of colour halfway down an empty plane is halfway between nothing, and
 * the 2D prototype got away with it only because the frame's own edges stood in
 * for the bases. A perspective camera has no edges to lend.
 *
 * Primitives, like the units. Phase 5 replaces them; what has to survive is the
 * silhouette — a low heavy wall against a tall thin spire.
 */

/**
 * Well behind each spawn band, not just past it.
 *
 * Measured by looking: at four units clear, the Nexus pylon stood between the
 * tactical camera and the field and blocked the middle third of the frame. The
 * bases have to be far enough back that the camera looks over the near one.
 */
const ORC_Z = -FIELD.depth / 2 - 22;
const NEXUS_Z = FIELD.depth / 2 + 22;

export function orcFortress(palette: ScenePalette): Group {
  const group = new Group();
  const timber = new MeshStandardMaterial({
    color: new Color().setStyle(palette.orcGround),
    roughness: 1,
    flatShading: true,
  });
  const banner = new MeshStandardMaterial({
    color: new Color().setStyle(palette.orc),
    roughness: 0.85,
    flatShading: true,
  });

  const keep = new Mesh(new BoxGeometry(26, 13, 12), timber);
  keep.position.set(0, groundHeight(0, ORC_Z) + 6.5, ORC_Z);
  group.add(keep);

  const roof = new Mesh(new ConeGeometry(17, 9, 4), banner);
  roof.position.set(0, groundHeight(0, ORC_Z) + 17, ORC_Z);
  roof.rotation.y = Math.PI / 4;
  group.add(roof);

  // A palisade of sharpened logs, thinning toward the flanks. Instanced would
  // be overkill: it is thirty static meshes that never move.
  const log = new CylinderGeometry(0.7, 0.9, 6, 5);
  for (let i = 0; i < 31; i++) {
    const x = worldX(i / 30);
    const post = new Mesh(log, timber);
    post.position.set(x, groundHeight(x, ORC_Z + 7) + 3, ORC_Z + 7);
    post.rotation.z = (i % 3) * 0.04 - 0.04;
    group.add(post);
  }

  // Fires, as light sources rather than as geometry: they are the warm end of
  // `moodWarmth`, and a brazier you can see is worth less than one you can see by.
  for (const x of [-15, 15]) {
    const fire = new Mesh(
      new OctahedronGeometry(1.6),
      new MeshBasicMaterial({ color: new Color().setStyle(palette.orcEmissive) }),
    );
    fire.position.set(x, groundHeight(x, ORC_Z + 9) + 2, ORC_Z + 9);
    group.add(fire);
  }

  return group;
}

export function nexusPylon(palette: ScenePalette): Group {
  const group = new Group();
  const ground = groundHeight(0, NEXUS_Z);

  const plinth = new Mesh(
    new CylinderGeometry(8, 11, 4, 6),
    new MeshStandardMaterial({
      color: new Color().setStyle(palette.nexusGround),
      roughness: 0.4,
      metalness: 0.3,
      flatShading: true,
    }),
  );
  plinth.position.set(0, ground + 2, NEXUS_Z);
  group.add(plinth);

  const crystal = new Mesh(
    new OctahedronGeometry(6),
    new MeshStandardMaterial({
      color: new Color().setStyle(palette.nexusGround),
      emissive: new Color().setStyle(palette.nexus),
      emissiveIntensity: 1.1,
      roughness: 0.15,
      metalness: 0.5,
      flatShading: true,
    }),
  );
  crystal.position.set(0, ground + 12, NEXUS_Z);
  crystal.scale.set(1, 1.7, 1);
  group.add(crystal);

  // No beam into the sky, and the reason is geometric rather than artistic.
  //
  // §6 asks for one, and two attempts were made: a translucent cylinder, which
  // read as a grey rectangle laid over the frame, and a rim-lit one, which read
  // as a wall of light across the middle third. Both failed for the same cause.
  // The tactical camera stands behind this base and looks over it, so anything
  // rising from the pylon is between the eye and the entire battle, and an
  // additive object there brightens every unit behind it.
  //
  // A beam needs the pylon off the camera's axis. That is a decision about
  // where the bases stand, which is phase 5's to make once there are models —
  // and it is a decision, not an oversight, so it is written down here.

  return group;
}

/** World z of each base, for whoever needs to point a light or a camera at it. */
export const BASE_Z = { orc: ORC_Z, nexus: NEXUS_Z } as const;
