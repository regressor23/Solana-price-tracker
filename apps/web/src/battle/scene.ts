import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PointLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

import { Army, unitGeometry } from './army.js';
import { BASE_Z, nexusPylon, orcFortress } from './bases.js';
import { Bursts } from './bursts.js';
import { shotFor, type CameraPreset } from './camera.js';
import type { BattleField } from './field.js';
import type { ScenePalette } from './palette.js';
import { Terrain } from './terrain.js';
import { groundHeight, moodFromFront, worldX, worldZ } from './world.js';

/**
 * The scene graph, and everything that has to happen to it each frame.
 *
 * Holds no `WebGLRenderer`, which is the point: a `Scene`, a camera, geometry
 * and matrices are arithmetic, so all of this can be built and stepped in a test
 * without a GPU. What cannot — shader compilation, the draw itself — lives in
 * `webgl.ts` and is thin enough to read.
 *
 * Owns no rules either. It is handed a `BattleField` and asks it questions; the
 * field is the same object the 2D renderer draws, so the two views cannot
 * disagree about what is happening.
 */

/** How fast the camera catches up to its shot: seconds to halve the distance. */
const CAMERA_HALF_LIFE = 0.55;

/** …and the mood, which should change over a round and not over a trade. */
const MOOD_HALF_LIFE = 3;

const skyShader = {
  vertex: /* glsl */ `
    varying vec3 vDirection;
    void main() {
      vDirection = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragment: /* glsl */ `
    uniform vec3 uStorm;
    uniform vec3 uNebula;
    varying vec3 vDirection;
    void main() {
      // Two skies, meeting overhead: storm over the orc end, nebula over the
      // Nexus one (§6). The seam sits above the middle of the field, which is
      // where the fighting is, so it is never the thing you are looking at.
      float side = smoothstep(-0.55, 0.55, vDirection.z);
      vec3 sky = mix(uStorm, uNebula, side);
      // Lighter at the horizon: the field has to end somewhere, and a flat
      // dome makes the ground look like it stops rather than recedes.
      float horizon = 1.0 - smoothstep(-0.05, 0.55, vDirection.y);
      gl_FragColor = vec4(sky * (0.75 + horizon * 0.85), 1.0);
      #include <colorspace_fragment>
    }
  `,
};

export class BattleScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(45, 16 / 9, 1, 900);

  readonly #terrain: Terrain;
  readonly #bursts: Bursts;
  readonly #armies: readonly Army[];
  readonly #sky: Mesh;
  readonly #key: DirectionalLight;
  readonly #warmLight: Color;
  readonly #coolLight: Color;

  #preset: CameraPreset = 'tactical';
  #elapsed = 0;
  #mood = 0.5;
  readonly #eye = new Vector3();
  readonly #look = new Vector3();
  #framed = false;

  constructor(palette: ScenePalette) {
    this.#warmLight = new Color().setStyle(palette.lightWarm);
    this.#coolLight = new Color().setStyle(palette.lightCool);

    this.#sky = new Mesh(
      new SphereGeometry(600, 24, 16),
      new ShaderMaterial({
        vertexShader: skyShader.vertex,
        fragmentShader: skyShader.fragment,
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uStorm: { value: new Color().setStyle(palette.skyStorm) },
          uNebula: { value: new Color().setStyle(palette.skyNebula) },
        },
      }),
    );
    this.#sky.name = 'sky';
    this.scene.add(this.#sky);

    // Fog in the sky's own colours, so the ground beyond the field dissolves
    // into the horizon instead of ending at one. It starts past the far corner
    // of the field as seen from the tactical camera — no part of the fighting
    // is ever behind it.
    this.scene.fog = new Fog(
      new Color()
        .setStyle(palette.skyNebula)
        .lerp(new Color().setStyle(palette.skyStorm), 0.5),
      150,
      380,
    );

    this.#terrain = new Terrain(palette);
    this.scene.add(this.#terrain.mesh);

    this.scene.add(orcFortress(palette), nexusPylon(palette));

    this.#armies = [
      new Army('orc', unitGeometry('orc'), palette),
      new Army('nexus', unitGeometry('nexus'), palette),
    ];
    for (const army of this.#armies) this.scene.add(army.mesh);

    this.#bursts = new Bursts(palette);
    this.scene.add(this.#bursts.points);

    // Three lights, and no more: an ambient floor so nothing is ever black, one
    // key that changes temperature with the mood, and a lamp at each base that
    // says whose ground you are standing on.
    this.scene.add(
      new HemisphereLight(
        new Color().setStyle(palette.skyNebula),
        new Color().setStyle(palette.orcGround),
        1.1,
      ),
    );

    this.#key = new DirectionalLight(0xffffff, 1.6);
    this.#key.name = 'key-light';
    this.#key.position.set(38, 90, 26);
    this.scene.add(this.#key);

    const orcFire = new PointLight(
      new Color().setStyle(palette.orcEmissive),
      900,
      150,
      2,
    );
    orcFire.position.set(0, groundHeight(0, BASE_Z.orc) + 12, BASE_Z.orc + 8);
    this.scene.add(orcFire);

    const nexusGlow = new PointLight(new Color().setStyle(palette.nexus), 900, 150, 2);
    nexusGlow.position.set(0, groundHeight(0, BASE_Z.nexus) + 16, BASE_Z.nexus - 4);
    this.scene.add(nexusGlow);
  }

  get preset(): CameraPreset {
    return this.#preset;
  }

  setPreset(preset: CameraPreset): void {
    this.#preset = preset;
  }

  /** Viewport size in device pixels; the camera needs the ratio, points the height. */
  setSize(width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.#bursts.setPixelScale(height);
  }

  /**
   * Step the scene to match the field.
   *
   * The order matters in one place only: the front line moves before the camera
   * is framed, so a frame never shows the camera chasing a line it has already
   * left behind.
   */
  update(field: BattleField, dtSec: number): void {
    this.#elapsed += dtSec;

    const front = worldZ(field.frontY);
    this.#terrain.setFront(front);
    this.#terrain.setTime(this.#elapsed);

    this.#mood = damp(this.#mood, moodFromFront(field.frontY), MOOD_HALF_LIFE, dtSec);
    this.#terrain.setMood(this.#mood);
    this.#key.color.copy(this.#coolLight).lerp(this.#warmLight, this.#mood);

    for (const army of this.#armies) army.sync(field.units, this.#elapsed);

    for (const event of field.events) {
      const x = worldX(event.x);
      const z = worldZ(event.y);
      const y = groundHeight(x, z);
      if (event.kind === 'death')
        this.#bursts.death(event.faction, x, y, z, this.#elapsed);
      else this.#bursts.spawn(event.faction, x, y, z, this.#elapsed);
    }
    this.#bursts.update(this.#elapsed);

    this.#frame(field.frontY, dtSec);
    // The dome travels with the eye: it is a backdrop, not a place.
    this.#sky.position.copy(this.camera.position);
  }

  #frame(frontFieldY: number, dtSec: number): void {
    const shot = shotFor(this.#preset, frontFieldY, this.camera.aspect, this.#elapsed);

    if (!this.#framed) {
      // The first frame cuts. Easing in from the origin would open every
      // session with a two-second dolly nobody asked for.
      this.#eye.set(shot.position.x, shot.position.y, shot.position.z);
      this.#look.set(shot.target.x, shot.target.y, shot.target.z);
      this.#framed = true;
    } else {
      dampVector(this.#eye, shot.position, CAMERA_HALF_LIFE, dtSec);
      dampVector(this.#look, shot.target, CAMERA_HALF_LIFE, dtSec);
    }

    if (this.camera.fov !== shot.fov) {
      this.camera.fov = shot.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(this.#eye);
    this.camera.lookAt(this.#look);
  }

  dispose(): void {
    this.#terrain.dispose();
    this.#bursts.dispose();
    for (const army of this.#armies) army.dispose();
    this.#sky.geometry.dispose();
    (this.#sky.material as ShaderMaterial).dispose();
  }
}

/**
 * Frame-rate independent easing. A plain `a += (b - a) * k` moves further per
 * second at 144 Hz than at 60, which would make the camera's feel a property of
 * the monitor.
 */
function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (!(dt > 0)) return current;
  const k = 1 - Math.pow(0.5, dt / halfLife);
  return current + (target - current) * k;
}

function dampVector(
  current: Vector3,
  target: { x: number; y: number; z: number },
  halfLife: number,
  dt: number,
): void {
  current.set(
    damp(current.x, target.x, halfLife, dt),
    damp(current.y, target.y, halfLife, dt),
    damp(current.z, target.z, halfLife, dt),
  );
}
