import { groundHeight, worldZ } from './world.js';

/**
 * Where the camera stands, given where the fighting is.
 *
 * The front line travels a third of the field in each direction, so a fixed
 * camera shows the battle in the top of the frame for one half of a round and
 * the bottom for the other. Every shot here is anchored to the line rather than
 * to the field, and the renderer eases toward the result instead of cutting.
 *
 * Pure arithmetic, returning plain numbers rather than three.js vectors, so the
 * framing can be asserted without a GPU — which matters, because a camera that
 * ends up inside the ground is invisible in exactly the situation where you are
 * least able to debug it.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Shot {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
}

/**
 * `tactical` is the default and the neutral one: high enough that neither base
 * is obviously the viewer's. `front` trades that neutrality for the only view
 * where individual units read. `orbit` gives each side the near ground in turn.
 */
export type CameraPreset = 'tactical' | 'front' | 'orbit';

export const CAMERA_PRESETS: readonly CameraPreset[] = ['tactical', 'front', 'orbit'];

/** Never let the eye get within this of the ground under it. */
const GROUND_CLEARANCE = 5;

/**
 * How much to pull back on a narrow viewport.
 *
 * A vertical FOV framing 120 world units of width at 16:10 crops badly at 9:16:
 * the ranks run off both sides and the front line becomes the only thing
 * legible. Dollying back by the aspect shortfall keeps the field's width in
 * frame, at the price of smaller units — the right trade, since on a phone the
 * territory colour is the read anyway.
 */
export function dollyForAspect(aspect: number): number {
  if (!(aspect > 0)) return 1;
  return Math.min(2.4, Math.max(1, 1.6 / aspect));
}

export function shotFor(
  preset: CameraPreset,
  frontY: number,
  aspect: number,
  timeSec: number,
): Shot {
  const front = worldZ(frontY);
  const dolly = dollyForAspect(aspect);
  return lift(shot(preset, front, dolly, timeSec));
}

function shot(preset: CameraPreset, front: number, dolly: number, time: number): Shot {
  switch (preset) {
    case 'front': {
      // Low and near, off the axis so the ranks are seen along their length
      // rather than end on. This is the shot that has to survive real models.
      return {
        position: { x: 15 * dolly, y: 11, z: front + 34 * dolly },
        target: { x: 0, y: 2.5, z: front },
        fov: 50,
      };
    }
    case 'orbit': {
      // Slow enough that it reads as drift, not as a turntable: a full circle
      // takes about two minutes, which is two rounds.
      const angle = time * 0.055;
      const radius = 64 * dolly;
      return {
        position: {
          x: Math.sin(angle) * radius,
          y: 34,
          z: front + Math.cos(angle) * radius,
        },
        target: { x: 0, y: 3, z: front },
        fov: 45,
      };
    }
    default: {
      // Anchored only partly to the line: following it all the way would swing
      // the whole field through the frame every time a whale lands. Two thirds
      // of the travel is enough to keep the fighting centred.
      //
      // High and back far enough to look over the near base rather than at it.
      const anchor = front * 0.62;
      return {
        position: { x: 0, y: 54 * dolly, z: anchor + 80 * dolly },
        target: { x: 0, y: 0, z: anchor },
        fov: 45,
      };
    }
  }
}

/** Push the eye above whatever hill it happens to be standing on. */
function lift(s: Shot): Shot {
  const floor = groundHeight(s.position.x, s.position.z) + GROUND_CLEARANCE;
  if (s.position.y >= floor) return s;
  return { ...s, position: { ...s.position, y: floor } };
}
