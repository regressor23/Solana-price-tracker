import {
  Color,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';

import type { ScenePalette } from './palette.js';
import { GROUND, groundHeight } from './world.js';

/**
 * The ground, and the front line drawn into it.
 *
 * The 2D prototype found that territory is the read which survives being seen
 * from across a room — the ground itself changes hands, so "who is winning" does
 * not depend on reading a number. That has to survive the move to 3D, which is
 * why the front line is a shader mask over the whole plane rather than a line
 * laid on top of it: a line is a thing you have to look at, a colour boundary is
 * a thing you cannot avoid seeing.
 *
 * Vertices are displaced by `groundHeight`, the same function the units stand
 * on. One source of ground, so nothing can float.
 */

/** Segments. Sized from the ground, not the field, so the mesh stays even. */
const SEGMENTS_X = 160;
const SEGMENTS_Z = 160;

/** Half-width of the contested band, in world units. About four units wide. */
const EDGE = 4.2;

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vGroundNormal;

  #include <fog_pars_vertex>

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vGroundNormal = normalize(mat3(modelMatrix) * normal);

    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uOrcGround;
  uniform vec3 uNexusGround;
  uniform vec3 uFrontColor;
  uniform vec3 uWarmLight;
  uniform vec3 uCoolLight;
  uniform float uFront;
  uniform float uMood;
  uniform float uTime;

  varying vec3 vWorld;
  varying vec3 vGroundNormal;

  #include <fog_pars_fragment>

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  void main() {
    // A ruler-straight boundary reads as a UI element sitting on the scene.
    // Wobbling it along the width, and slowly in time, makes it a front.
    float wobble = (noise(vec2(vWorld.x * 0.045, uTime * 0.04)) - 0.5) * ${EDGE.toFixed(1)} * 1.7;
    float d = vWorld.z - (uFront + wobble);
    float held = smoothstep(-${EDGE.toFixed(1)}, ${EDGE.toFixed(1)}, d);

    vec3 ground = mix(uOrcGround, uNexusGround, held);

    // A square grid, not the hexagonal one §6 describes — that is art, and art
    // is phase 5. All it has to do here is say the Nexus half is built and the
    // orc half is grown, so the two halves are told apart by more than hue.
    float grid = smoothstep(0.86, 1.0, max(
      abs(sin(vWorld.x * 0.26)),
      abs(sin(vWorld.z * 0.26))));
    // Grain tinted by the ground it sits on, not grey: white noise over a
    // colour this dark washes the orc half to concrete.
    float grain = noise(vWorld.xz * 0.6);
    ground += mix(uOrcGround * grain * 2.4, uNexusGround * grid * 1.6, held);

    vec3 lightColor = mix(uCoolLight, uWarmLight, uMood);
    float lambert = 0.44 + 0.56 * max(dot(normalize(vGroundNormal), normalize(vec3(0.3, 0.92, 0.25))), 0.0);

    // The band itself: hot at the seam, gone within a few units either way.
    float band = 1.0 - smoothstep(0.0, ${EDGE.toFixed(1)} * 1.6, abs(d));
    vec3 color = ground * lightColor * lambert + uFrontColor * band * band * 0.3;

    gl_FragColor = vec4(color, 1.0);

    #include <fog_fragment>
    #include <colorspace_fragment>
  }
`;

export class Terrain {
  readonly mesh: Mesh;
  readonly #material: ShaderMaterial;

  constructor(palette: ScenePalette) {
    this.#material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib['fog'],
        {
          uOrcGround: { value: new Color().setStyle(palette.orcGround) },
          uNexusGround: { value: new Color().setStyle(palette.nexusGround) },
          uFrontColor: { value: new Color().setStyle(palette.frontLine) },
          uWarmLight: { value: new Color().setStyle(palette.lightWarm) },
          uCoolLight: { value: new Color().setStyle(palette.lightCool) },
          uFront: { value: 0 },
          uMood: { value: 0.5 },
          uTime: { value: 0 },
        },
      ]),
    });

    this.mesh = new Mesh(buildGround(), this.#material);
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = false;
  }

  /**
   * Move the boundary. `z` is a world coordinate, not the field's 0…1 — the
   * shader works in world space because the mesh is the whole field.
   */
  setFront(z: number): void {
    this.#material.uniforms['uFront']!.value = z;
  }

  /**
   * 0 is a Nexus-dominated field and 1 an orc-dominated one, which tips the
   * light between cold and warm. Both bases keep their own colours; it is the
   * air between them that changes.
   */
  setMood(warmth: number): void {
    this.#material.uniforms['uMood']!.value = warmth;
  }

  setTime(seconds: number): void {
    this.#material.uniforms['uTime']!.value = seconds;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.#material.dispose();
  }
}

/** The plane, laid flat and pushed into hills by the shared height function. */
export function buildGround(): PlaneGeometry {
  const geometry = new PlaneGeometry(
    GROUND.width,
    GROUND.depth,
    SEGMENTS_X,
    SEGMENTS_Z,
  );
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes['position']!;
  for (let i = 0; i < position.count; i++) {
    position.setY(i, groundHeight(position.getX(i), position.getZ(i)));
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}
