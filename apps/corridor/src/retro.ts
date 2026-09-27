// Retroreflection: the things that are only bright because your headlights are on them.
//
// Rich, 2026-09-27: "pavement markings seem to not be affected by night time … It would be great
// to have retroreflective things like street signs, stop signs and pavement markings super
// sensitive to head lights so if they caught the edge of the light cone they'd light up, but
// right now it is glow in the dark lines which is cool and cyberpunk but not quite the default
// night aesthetic."
//
// He is describing two different faults with one symptom. Measured at 32 degrees below the
// horizon on his own session:
//
//   129 `road:markings` meshes on an unlit MeshBasicMaterial at pure white. An unlit material
//   ignores every light in the scene by definition, so the paint was never going to get dark —
//   no sun, no moon and no ambient knob could touch it.
//
// So the paint needs to be LIT. But a plain lit white paint at night is then invisible, which is
// how it came to be unlit in the first place (see the comment this replaces in intersections.ts:
// "a lit grey on grey asphalt was invisible from above"). Real paint solves this with glass
// beads, and real signs with prismatic sheeting: they throw light back at whoever sent it, which
// is why the lines and the stop sign are the brightest things on an unlit road at night and
// nearly invisible from the side.
//
// That is the model here. Brightness is
//
//     ambient (goes to almost nothing at night)  +  retro (only what your lamps sent back)
//
// and the second term is computed against the car's two headlamps rather than against three.js's
// lights, because a retroreflector is not a diffuse surface and the standard BRDF cannot express
// one: it returns light along the incoming ray, so what matters is the lamp's cone and almost
// not at all the surface's angle. The cone used here is deliberately WIDER than the visible beam
// — Rich asked for "the edge of the light cone" to light things up, which is exactly what real
// sheeting does, and it is the effect that makes a sign announce itself before the beam reaches
// it.

import * as THREE from 'three'
import * as T from './tuning'
import { SPLAT_MASK_PARS, splatMaskUniforms } from './splatmask'

/** One lamp: where it is, where it points, in world space. */
interface Lamp {
  pos: THREE.Vector3
  dir: THREE.Vector3
}

/**
 * The uniforms every retroreflective material shares, by reference.
 *
 * One object, handed to every material, so the per-frame update is a handful of vector copies
 * rather than a walk over every marking mesh on the site.
 */
export interface RetroUniforms {
  uNight: { value: number }
  uTint: { value: THREE.Color }
  uLampPos: { value: THREE.Vector3[] }
  uLampDir: { value: THREE.Vector3[] }
  uLampOn: { value: number }
  uLampRange: { value: number }
  uCosOuter: { value: number }
  uCosInner: { value: number }
  [k: string]: { value: unknown }
}

export const LAMPS = 2

export function retroUniforms(): RetroUniforms {
  return {
    uNight: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uLampPos: { value: Array.from({ length: LAMPS }, () => new THREE.Vector3()) },
    uLampDir: { value: Array.from({ length: LAMPS }, () => new THREE.Vector3(1, 0, 0)) },
    uLampOn: { value: 0 },
    uLampRange: { value: 70 },
    uCosOuter: { value: Math.cos(0.7) },
    uCosInner: { value: Math.cos(0.2) },
  }
}

/**
 * The lamps, for any shader that lights itself.
 *
 * Grass, the tree impostor cards and the road paint all draw through custom shaders, which means
 * three.js's lights — including the car's two spot lights — never reach them. Rich, 2026-09-27:
 * "Grass doesn't seem to be affected by headlights at all." It could not be: nothing in that
 * shader had ever heard of a light. This is the shared half — where the lamps are and how much of
 * one reaches a point — and `RETRO_PARS` below adds the retroreflective half on top.
 */
export const LAMP_PARS = /* glsl */ `
  uniform float uNight;
  uniform vec3 uTint;
  uniform vec3 uLampPos[${LAMPS}];
  uniform vec3 uLampDir[${LAMPS}];
  uniform float uLampOn;
  uniform float uLampRange;
  uniform float uCosOuter;
  uniform float uCosInner;

  /** the beam's share at this point: cone x falloff, 0..1, per lamp */
  float lampReach(vec3 worldPos, int k, out vec3 dir) {
    vec3 d = worldPos - uLampPos[k];
    float dist = length(d);
    dir = d / max(dist, 1e-4);
    if (dist > uLampRange) return 0.0;
    float cone = smoothstep(uCosOuter, uCosInner, dot(dir, normalize(uLampDir[k])));
    // inverse-square would make near ground blinding and far ground nothing; a real beam on a
    // real road reads far more evenly than that
    float fall = 1.0 - smoothstep(uLampRange * 0.35, uLampRange, dist);
    return cone * fall;
  }

  /**
   * Ordinary diffuse light from the headlamps, for a surface that is NOT retroreflective.
   *
   * This is what grass and the tree cards want: they are lit by the beam like anything else, they
   * just had no way to know it. Lambert against the lamp direction, warm, and gated on uLampOn so
   * it costs nothing by day.
   */
  vec3 lampDiffuse(vec3 worldPos, vec3 nrm, float gain) {
    if (uLampOn <= 0.0 || gain <= 0.0) return vec3(0.0);
    float sum = 0.0;
    for (int k = 0; k < ${LAMPS}; k++) {
      vec3 dir;
      float reach = lampReach(worldPos, k, dir);
      if (reach <= 0.0) continue;
      // half-Lambert: a blade of grass is thin and translucent, and a hard terminator on one
      // looks like a cardboard cutout
      sum += reach * (dot(nrm, -dir) * 0.5 + 0.5);
    }
    return vec3(1.0, 0.96, 0.87) * (min(sum, 1.6) * gain * uLampOn);
  }
`

/** The retroreflective half: the lamps, plus what comes back from sheeting and glass beads. */
export const RETRO_PARS = /* glsl */ `
  ${LAMP_PARS}
  uniform float uRetro;
  uniform float uRetroFacing;

  /**
   * How much of your own headlight comes back from this fragment.
   *
   * The facing weight mixes in the surface's angle to the lamp: 0 for pavement markings, which are flat on
   * the ground and are hit at a grazing angle that a dot product would wrongly extinguish (the
   * beads in real paint are built for precisely that geometry), and 1 for a sign, which faces the
   * traffic it is for and should fade as you pass it.
   */
  float retroAt(vec3 worldPos, vec3 nrm, float facing) {
    if (uLampOn <= 0.0 || uRetro <= 0.0) return 0.0;
    float sum = 0.0;
    for (int k = 0; k < ${LAMPS}; k++) {
      vec3 dir;
      float reach = lampReach(worldPos, k, dir);
      if (reach <= 0.0) continue;
      // a branch rather than a mix: a geometry with no normal attribute reads zero, and
      // mix(1.0, dot(NaN), 0.0) is NaN because GLSL multiplies before it adds
      float ang = facing > 0.0 ? mix(1.0, max(dot(nrm, -dir), 0.0), facing) : 1.0;
      sum += reach * ang;
    }
    return min(sum, 1.4) * uRetro * uLampOn;
  }
`

/**
 * Paint: white or yellow, flat on the road, lit by the sky and by your lamps and by nothing else.
 *
 * Replaces the MeshBasicMaterial the markings used to carry. `vertexColors` is kept because the
 * marking geometry is one mesh whose colours (white edge line, yellow centre) live in the
 * attribute — see props.ts.
 */
export function paintMaterial(u: RetroUniforms, opts: { vertexColors?: boolean; color?: number } = {}): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      // NOT merged: merge() clones, and these must stay shared by reference so one update per
      // frame reaches every material. They are assigned over the top afterwards.
      {},
    ]),
    defines: opts.vertexColors ? { USE_PAINT_VCOL: '' } : {},
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      #ifdef USE_PAINT_VCOL
        attribute vec3 color;
      #endif
      varying vec3 vCol;
      varying vec3 vWorld;
      varying vec3 vNrm;
      void main() {
        #ifdef USE_PAINT_VCOL
          vCol = color;
        #else
          vCol = vec3(1.0);
        #endif
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNrm = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      ${RETRO_PARS}
      ${SPLAT_MASK_PARS}
      uniform vec3 uBase;
      varying vec3 vCol;
      varying vec3 vWorld;
      varying vec3 vNrm;
      void main() {
        splatDissolve(vWorld);
        #include <logdepthbuf_fragment>
        vec3 base = uBase * vCol;
        // the ambient half goes to almost nothing at night; the retro half is all yours
        vec3 lit = base * (uNight * uTint) + base * retroAt(vWorld, normalize(vNrm), uRetroFacing);
        gl_FragColor = vec4(lit, 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    fog: true,
  })
  // share the rig's uniforms by reference, and give this material its own gain
  Object.assign(m.uniforms, u, splatMaskUniforms(), {
    uBase: { value: new THREE.Color(opts.color ?? 0xffffff) },
    uRetro: { value: 0 },
    uRetroFacing: { value: 0 },
  })
  m.userData.retroKind = 'paint'
  return m
}

/**
 * A sign keeps its PBR material — by day it is a painted metal plate and should look like one —
 * and gains the retro term on top. `onBeforeCompile` rather than a replacement shader, so the
 * map, the roughness and the environment all keep working.
 */
export function makeRetroreflective(mat: THREE.Material, u: RetroUniforms, facing = 1): void {
  if (mat.userData.retroKind) return
  mat.userData.retroKind = 'sign'
  const own = { uRetro: { value: 0 }, uRetroFacing: { value: facing } }
  mat.userData.retroOwn = own
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, own)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRetroWorld;\nvarying vec3 vRetroNrm;')
      // AFTER project_vertex, and through instanceMatrix.
      //
      // `modelMatrix * transformed` is NOT where an instance is: three applies the instance
      // matrix in project_vertex, not in begin_vertex, so a patch that reads modelMatrix alone
      // puts every instance at the mesh's origin. Stop signs are an InstancedMesh and street
      // blades are one merged geometry, which is exactly why the blades lit up and the stop
      // signs did not (Rich, 2026-09-27).
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  vec4 retroP = vec4(transformed, 1.0);
  vec3 retroN = objectNormal;
  #ifdef USE_INSTANCING
    retroP = instanceMatrix * retroP;
    retroN = mat3(instanceMatrix) * retroN;
  #endif
  vRetroWorld = (modelMatrix * retroP).xyz;
  vRetroNrm = normalize(mat3(modelMatrix) * retroN);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRetroWorld;\nvarying vec3 vRetroNrm;\n${RETRO_PARS}`)
      .replace(
        '#include <opaque_fragment>',
        '  outgoingLight += diffuseColor.rgb * retroAt(vRetroWorld, normalize(vRetroNrm), uRetroFacing);\n#include <opaque_fragment>',
      )
  }
  mat.needsUpdate = true
}

/**
 * The rig: owns the uniforms, reads the car's lamps once a frame, and carries the knobs.
 *
 * It takes the lamps' WORLD transforms from the SpotLights the car already has, so the retro cone
 * and the visible beam can never drift apart — there is one source of truth for where the
 * headlights point, and it is the car.
 */
export class Retro {
  readonly uniforms = retroUniforms()
  private mats: { mat: THREE.Material; kind: 'paint' | 'sign' }[] = []

  /** register a material so the per-frame knob push reaches it */
  add(mat: THREE.Material, kind: 'paint' | 'sign'): void {
    this.mats.push({ mat, kind })
  }

  /** a new site is being built: the old site's materials are gone */
  clear(): void {
    this.mats = []
  }

  /** how many materials are answering to the lamps, for probes */
  get count(): { paint: number; sign: number } {
    return { paint: this.mats.filter((m) => m.kind === 'paint').length, sign: this.mats.filter((m) => m.kind === 'sign').length }
  }

  /** the scene's day/night level and tint, the same numbers the grass and the impostors get */
  setLight(level: number, tint: THREE.Color): void {
    this.uniforms.uNight.value = level
    this.uniforms.uTint.value.copy(tint)
  }

  /** where the lamps are this frame, and how hard they are on (0 by day) */
  setLamps(lamps: Lamp[], on: number): void {
    this.uniforms.uLampOn.value = on
    for (let i = 0; i < LAMPS; i++) {
      const l = lamps[Math.min(i, lamps.length - 1)]
      if (!l) continue
      this.uniforms.uLampPos.value[i].copy(l.pos)
      this.uniforms.uLampDir.value[i].copy(l.dir)
    }
  }

  /** knobs, once a frame */
  tick(): void {
    const u = this.uniforms
    u.uLampRange.value = T.HEADLIGHT_RANGE
    // the retro cone is the beam's own angle, widened: the edge of the light is where a real
    // sign starts to answer, and Rich asked for exactly that
    const outer = Math.min(1.45, T.HEADLIGHT_ANGLE * T.RETRO_SPREAD)
    u.uCosOuter.value = Math.cos(outer)
    u.uCosInner.value = Math.cos(outer * 0.35)
    for (const { mat, kind } of this.mats) {
      const own = (kind === 'sign' ? mat.userData.retroOwn : (mat as THREE.ShaderMaterial).uniforms) as Record<string, { value: number }> | undefined
      if (!own?.uRetro) continue
      own.uRetro.value = kind === 'paint' ? T.RETRO_MARKINGS : T.RETRO_SIGNS
    }
  }
}

/**
 * The one rig.
 *
 * A singleton rather than something threaded through every builder: paint and signs are made in
 * four different modules several calls deep, and the alternative was a parameter added to a dozen
 * signatures to carry a thing there is only ever one of. `clear()` on a site rebuild is the whole
 * cost of that choice.
 */
export const retro = new Retro()
