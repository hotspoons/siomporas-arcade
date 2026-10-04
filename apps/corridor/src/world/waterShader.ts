// Water shading for corridor's streams, ponds and sea.
//
// Ported from tuxalin/water-shader — https://github.com/tuxalin/water-shader —
// MIT License, Copyright (c) 2017 tuxalin:
//
//   shaders/hlsl/water/waves.cginc    the summed Gerstner wave normal
//   shaders/hlsl/water/radiance.cginc the Fresnel/reflected-radiance framing
//   shaders/hlsl/water/depth.cginc    wavelength-dependent colour extinction
//   shaders/hlsl/water/foam.cginc     depth-based shore foam behind noisy edges
//
// No file, texture or shader source is used verbatim. The wave normal is
// evaluated analytically here (GPU Gems 1, ch. 1 — the source tuxalin cites)
// from a per-vertex (depth, flow direction) attribute corridor bakes at build
// time; the extinction and foam are re-derived from that depth. The full MIT
// permission text travels in NOTICE and CREDITS.md.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following condition: the above copyright
// notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
import * as THREE from 'three'

/** attribute carrying (water depth in m, flow direction x, flow direction z), world frame */
export const WATER_ATTR = 'aWater'

/**
 * The full description of a body of water's appearance. This is the thing a game
 * sets per stream, pond or sea — swap `colour`, `extinct`, `foam` and `deep` and
 * the same geometry reads as a black peat bog or a Caribbean flat.
 *
 * `extinct` is the per-channel distance (m) over which light is absorbed: the
 * red channel dies first in every real water. Short distances (a metre or two)
 * are opaque mud; long distances are clear.
 */
export interface WaterLook {
  /** base surface colour */
  colour: number
  /** material opacity, 0…1 */
  opacity: number
  /** specular roughness; low is glassy */
  roughness: number
  /** the tint right at the waterline */
  shore: number
  /** the body colour once light has been absorbed */
  deep: number
  /** per-channel extinction distance in metres: [red, green, blue] */
  extinct: [number, number, number]
  /** how much the depth/extinction mixing shows at all, 0…1 */
  shoreMix: number
  /** shore-foam coverage, 0…1 */
  foam: number
  /** shore-foam band width, × the ~0.5 m default */
  foamBand: number
  /** Gerstner wave strength, relative */
  wave: number
  /** Gerstner amplitude scale */
  amp: number
  /** Gerstner wavelength scale */
  len: number
  /** Gerstner steepness scale */
  steep: number
  /** bank-to-centre depth profile peak (m) of a stream ribbon */
  crown: number
  /** depth to shade a pond/area as (m) — the DEM has no bathymetry */
  pondDepth: number
}

/**
 * Named looks, from a black bog to an island flat. A water body's `look` field
 * picks one; the default is `temperate`. These are deliberately extreme at the
 * ends so the dial is obvious.
 */
export const WATER_PRESETS: Record<string, WaterLook> = {
  temperate: { colour: 0x3d6b73, opacity: 0.82, roughness: 0.28, shore: 0xdfe9df, deep: 0x18323f, extinct: [6, 26, 70], shoreMix: 0.85, foam: 0.7, foamBand: 1, wave: 1, amp: 1, len: 1, steep: 1, crown: 0.9, pondDepth: 1.2 },
  swamp: { colour: 0x2b3320, opacity: 0.9, roughness: 0.45, shore: 0x6b6f3a, deep: 0x10150b, extinct: [2.5, 5.5, 10], shoreMix: 1, foam: 0.45, foamBand: 1.5, wave: 0.5, amp: 0.55, len: 1.5, steep: 0.7, crown: 0.5, pondDepth: 0.9 },
  black: { colour: 0x101812, opacity: 0.94, roughness: 0.35, shore: 0x39422f, deep: 0x05080a, extinct: [1.8, 5, 14], shoreMix: 1, foam: 0.3, foamBand: 1.7, wave: 0.4, amp: 0.4, len: 1.7, steep: 0.5, crown: 0.4, pondDepth: 0.8 },
  caribbean: { colour: 0x2fb8c8, opacity: 0.84, roughness: 0.2, shore: 0xe6f7f0, deep: 0x0a4a6e, extinct: [16, 40, 92], shoreMix: 1, foam: 0.95, foamBand: 1.2, wave: 0.85, amp: 0.5, len: 1, steep: 0.55, crown: 1.1, pondDepth: 1.8 },
  alpine: { colour: 0x2f6f86, opacity: 0.78, roughness: 0.16, shore: 0xbfd8d2, deep: 0x0c2c3d, extinct: [12, 34, 80], shoreMix: 1, foam: 0.4, foamBand: 0.9, wave: 1.3, amp: 1.2, len: 0.9, steep: 1.1, crown: 0.7, pondDepth: 1.5 },
  mud: { colour: 0x5a4326, opacity: 0.93, roughness: 0.55, shore: 0x8a7350, deep: 0x2a1e10, extinct: [1.5, 4, 9], shoreMix: 1, foam: 0.55, foamBand: 1.6, wave: 0.6, amp: 0.5, len: 1.5, steep: 0.6, crown: 0.6, pondDepth: 0.9 },
}

/** the names, in a stable order a numeric tuning knob can index */
export const WATER_LOOK_NAMES = Object.keys(WATER_PRESETS)

/** resolve a look by name, falling back to temperate */
export function lookOf(name: string | undefined): WaterLook {
  return WATER_PRESETS[name ?? ''] ?? WATER_PRESETS.temperate
}

/**
 * Vertex-side declarations: one attribute in, two varyings out.
 *
 * `vWaterPos` is world position (the waves are world-anchored, so they do not
 * swim when the camera moves); `vWater` is the baked (depth, flow) triple.
 */
export const WATER_VERT_PARS = /* glsl */ `
attribute vec3 ${WATER_ATTR};
varying vec3 vWaterPos;
varying vec3 vWater;
`

export const WATER_VERT_BODY = /* glsl */ `
vWaterPos = (modelMatrix * vec4(position, 1.0)).xyz;
vWater = ${WATER_ATTR};
`

/**
 * Fragment-side declarations. Names are prefixed `wsh` so they cannot collide
 * with the value noise already in water.ts (used by the falls/rapids foam).
 */
export const WATER_FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWaveStrength;
uniform float uWaveAmp;
uniform float uWaveLen;
uniform float uWaveSteep;
uniform vec3 uShoreColor;
uniform vec3 uDepthColor;
uniform vec3 uExtinct;
uniform float uFoamAmount;
uniform float uFoamBand;
uniform float uShoreMix;
uniform float uWaveFade;
varying vec3 vWaterPos;
varying vec3 vWater;

float wshHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wshNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wshHash(i), wshHash(i + vec2(1, 0)), u.x), mix(wshHash(i + vec2(0, 1)), wshHash(i + vec2(1, 1)), u.x), u.y);
}
// Four-octave value-noise fBm. Used for the fine ripples: a sum of a few sinusoids has a regular
// spectrum and reads as corduroy, while a noise field gives the irregular grain a normal map would.
float wshFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * wshNoise(p); p = p * 2.07 + 11.3; a *= 0.5; }
  return s;
}

// The summed Gerstner wave normal. Each band is a direction D, an amplitude A, a
// wavelength L and a steepness Q; the surface derivative of a single Gerstner
// wave is
//   dP/dx = (-D.x * w*A*cos v,  -Q*w*A*sin v,  -D.y * w*A*cos v),  v = w*dot(p,D) - c*t, w = 2pi/(L*len)
// and the surface normal is that sum against +Y. Four bands, the long ones
// aligned with the flow and the short ones fanned across it.
vec3 waterGerstnerNormal(vec2 p, vec2 flow, float t) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  #define WATER_BAND(D, A, L, Q, S) { \
    float w_ = 6.2831853 / ((L) * uWaveLen); \
    float v_ = w_ * dot(p, (D)) - sqrt(9.81 * w_) * t + wshNoise(p * (S) + (L)) * 6.2831853; \
    float c_ = cos(v_), s_ = sin(v_); \
    float wa_ = w_ * (A) * uWaveAmp; \
    n.x -= (D).x * wa_ * c_; \
    n.z -= (D).y * wa_ * c_; \
    n.y -= (Q) * uWaveSteep * wa_ * s_; \
  }
  vec2 d0 = flow;
  vec2 d1 = normalize(vec2(d0.x * 0.88 - d0.y * 0.47, d0.x * 0.47 + d0.y * 0.88));
  vec2 d2 = normalize(vec2(d0.x * 0.88 + d0.y * 0.47, -d0.x * 0.47 + d0.y * 0.88));
  // Four bands, the long ones along the flow and the short ones fanned across it. Each band takes a
  // slowly-varying random phase offset, so its crests wander instead of lining up into corduroy —
  // the irregularity a normal map would otherwise supply. The offset is added to the phase only,
  // never to the analytic slope, so it cannot spike the normal.
  WATER_BAND(d0,                  0.110, 17.0, 0.70, 0.05)
  WATER_BAND(d1,                  0.060,  9.5, 0.60, 0.09)
  WATER_BAND(d2,                  0.035,  5.1, 0.50, 0.16)
  WATER_BAND(normalize(d0 + d1),  0.020,  2.9, 0.45, 0.30)
  #undef WATER_BAND
  return normalize(n);
}

vec2 waterFlow() {
  vec2 f = vWater.yz;
  return dot(f, f) < 1e-6 ? uWind : normalize(f);
}
`

/**
 * Replaces three's `<normal_fragment_begin>` body: perturb the (view-space)
 * shading normal with the world-space wave normal.
 */
export const WATER_FRAG_NORMAL = /* glsl */ `
{
  vec3 wn = waterGerstnerNormal(vWaterPos.xz, waterFlow(), uTime);
  vec3 wnView = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  // fade the wave tilt with range: an analytic normal has no mip, so a distant surface would
  // shimmer. Keep a little tilt far out so the sea is not a mirror.
  float wfade = mix(0.18, 1.0, 1.0 - smoothstep(90.0 * uWaveFade, 340.0 * uWaveFade, length(vViewPosition)));
  normal = normalize(mix(normal, wnView, uWaveStrength * wfade));
}
`

/**
 * Appends to `<color_fragment>`: depth-driven colour extinction and shore foam.
 * Applied to `diffuseColor` so the standard lighting, SSR and fog still treat
 * the water as an ordinary surface.
 */
export const WATER_FRAG_COLOR = /* glsl */ `
{
  float depth = max(vWater.x, 0.0);
  // The body is the water's own colour; it deepens with wavelength-dependent
  // extinction (red absorbed first, blue last) and only the last few centimetres
  // lift toward the shore colour. Getting this order wrong is what turns every
  // shallow body into a white sheet.
  vec3 ext = exp(-depth / uExtinct);              // 1 at the shore, 0 offshore
  vec3 body = mix(diffuseColor.rgb, uDepthColor, 1.0 - ext.g);
  body = mix(uShoreColor, body, smoothstep(0.0, 0.55 * uFoamBand, depth));
  diffuseColor.rgb = mix(diffuseColor.rgb, body, uShoreMix);

  // Shore foam: a noisy band in the first half-metre, racing with the flow.
  float band = 1.0 - smoothstep(0.06, 0.5 * uFoamBand, depth);
  vec2 fdir = waterFlow();
  float fn = wshNoise(vWaterPos.xz * 2.7 + fdir * uTime * 0.6) * 0.6
           + wshNoise(vWaterPos.xz * 7.3 - fdir * uTime * 0.9) * 0.4;
  float foam = band * smoothstep(0.42, 0.8, fn) * uFoamAmount;
  // and fade the foam out with range, for the same aliasing reason as the waves
  foam *= 1.0 - smoothstep(140.0 * uWaveFade, 420.0 * uWaveFade, length(vViewPosition));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.96, 0.96), foam);
}
`

/** The per-material uniforms the water material owns (created in water.ts). */
export interface WaterWaveUniforms {
  uTime: { value: number }
  uWind: { value: THREE.Vector2 }
  uWaveStrength: { value: number }
  uWaveAmp: { value: number }
  uWaveLen: { value: number }
  uWaveSteep: { value: number }
  uShoreColor: { value: THREE.Color }
  uDepthColor: { value: THREE.Color }
  uExtinct: { value: THREE.Vector3 }
  uFoamAmount: { value: number }
  uFoamBand: { value: number }
  uShoreMix: { value: number }
  uWaveFade: { value: number }
}

/** the global multipliers a live tuning pass applies on top of a look */
export interface WaterKnobs {
  wave: number
  amp: number
  len: number
  steep: number
  foam: number
  band: number
  clarity: number
  fade: number
}

/**
 * Push a look (scaled by the global knobs) into a material's uniforms. Called at
 * build time and again every tick, so the dials are live.
 */
export function refreshLook(u: WaterWaveUniforms, look: WaterLook, k: WaterKnobs): void {
  u.uWaveStrength.value = look.wave * k.wave
  u.uWaveAmp.value = look.amp * k.amp
  u.uWaveLen.value = look.len * k.len
  u.uWaveSteep.value = look.steep * k.steep
  u.uFoamAmount.value = look.foam * k.foam
  u.uFoamBand.value = look.foamBand * k.band
  u.uWaveFade.value = k.fade
  u.uShoreMix.value = look.shoreMix
  u.uExtinct.value.set(look.extinct[0] * k.clarity, look.extinct[1] * k.clarity, look.extinct[2] * k.clarity)
}

/** set a material's shore/deep tints straight from a look */
export function applyLookColours(u: WaterWaveUniforms, look: WaterLook): void {
  u.uShoreColor.value.setHex(look.shore)
  u.uDepthColor.value.setHex(look.deep)
}

/**
 * Bake the `aWater` attribute onto a built geometry. `fn` is handed the vertex
 * index and its world position and returns (depth, flowX, flowZ).
 */
export function writeWaterAttr(
  geo: THREE.BufferGeometry,
  fn: (i: number, x: number, y: number, z: number) => [number, number, number],
): void {
  const pos = geo.attributes.position
  const a = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const [d, fx, fz] = fn(i, pos.getX(i), pos.getY(i), pos.getZ(i))
    a[i * 3] = d
    a[i * 3 + 1] = fx
    a[i * 3 + 2] = fz
  }
  geo.setAttribute(WATER_ATTR, new THREE.BufferAttribute(a, 3))
}

/** Derive the shallow and deep tints for a material from its base colour. */
export function waterTints(base: THREE.Color, shore: THREE.Color, deep: THREE.Color): void {
  shore.copy(base).lerp(new THREE.Color(0xdfe9df), 0.5)
  deep.copy(base).multiply(new THREE.Color(0.3, 0.52, 0.74))
}
