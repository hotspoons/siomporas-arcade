// The tunnel is mostly emissive: light comes from the architecture. One
// ShaderMaterial does the grid, the ribs, the boost strips, the open-edge glow,
// distance fog, a cheap headlight term, and — in retro mode — flat facets, hard
// light bands and vertex snapping. Styles swap uniforms, not materials.

import { Color, DoubleSide, ShaderMaterial, Vector2, Vector3 } from 'three'
import { RING_SPACING } from '../RenderTuning'

export interface TunnelUniforms {
  uTime: { value: number }
  uCameraPos: { value: Vector3 }
  uFogColor: { value: Color }
  uFogDensity: { value: number }
  uLineColor: { value: Color }
  uRibColor: { value: Color }
  uWallColor: { value: Color }
  uBoostColor: { value: Color }
  uEdgeColor: { value: Color }
  uFlat: { value: number }
  uSnap: { value: Vector2 }
  uBoostPulse: { value: number }
  uSpeed: { value: number }
  uGlow: { value: number }
}

export function makeTunnelUniforms(): TunnelUniforms {
  return {
    uTime: { value: 0 },
    uCameraPos: { value: new Vector3() },
    uFogColor: { value: new Color(0x06040f) },
    uFogDensity: { value: 0.0011 },
    uLineColor: { value: new Color(0x25e8ff) },
    uRibColor: { value: new Color(0x7ff6ff) },
    uWallColor: { value: new Color(0x0d1226) },
    uBoostColor: { value: new Color(0xff5fd2) },
    uEdgeColor: { value: new Color(0xffc857) },
    uFlat: { value: 0 },
    uSnap: { value: new Vector2(0, 0) },
    uBoostPulse: { value: 0 },
    uSpeed: { value: 300 },
    uGlow: { value: 1 },
  }
}

const VERT = /* glsl */ `
attribute vec4 aTrack; // s, edgeDistance(m), boost, visible
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec4 vTrack;
uniform vec2 uSnap;
void main() {
  vUv = uv;
  vTrack = aTrack;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 clip = projectionMatrix * viewMatrix * w;
  if (uSnap.x > 0.0) {
    // Integer vertex snapping, as a fixed-point rasteriser would do it.
    vec2 ndc = clip.xy / clip.w;
    ndc = floor(ndc * uSnap * 0.5) / (uSnap * 0.5);
    clip.xy = ndc * clip.w;
  }
  gl_Position = clip;
}
`

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec4 vTrack;
uniform float uTime;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uLineColor;
uniform vec3 uRibColor;
uniform vec3 uWallColor;
uniform vec3 uBoostColor;
uniform vec3 uEdgeColor;
uniform float uFlat;
uniform float uBoostPulse;
uniform float uSpeed;
uniform float uGlow;

const float RING = ${RING_SPACING.toFixed(1)};

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Anti-aliased line at the integer boundaries of x, width w in x units.
// Intensity falls with coverage so a sub-pixel line at grazing angles dims
// instead of smearing into a solid sheet.
float gridLine(float x, float w) {
  float f = abs(fract(x) - 0.5);
  float aa = max(fwidth(x), 1e-5);
  float line = smoothstep(0.5 - w - aa, 0.5 - w + aa, f);
  return line * clamp(2.0 * w / aa, 0.0, 1.0);
}

void main() {
  if (vTrack.w < 0.5) discard;
  float s = vTrack.x;
  float u = vUv.x; // turns around the tube (theta / 2pi)

  vec3 N = normalize(vNormal);
  if (uFlat > 0.5) {
    N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(N, vNormal) < 0.0) N = -N;
  }
  vec3 V = normalize(uCameraPos - vWorld);
  float dist = length(uCameraPos - vWorld);
  // Seen from outside (open sections, flight): a dark hull with faint ribs.
  if (dot(N, V) < 0.0) {
    float ribO = gridLine(s / (RING * 5.0), 0.01);
    vec3 hull = uWallColor * 0.5 + uLineColor * ribO * 0.25 * uGlow;
    float fogO = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
    gl_FragColor = vec4(mix(hull, uFogColor, clamp(fogO, 0.0, 1.0)), 1.0);
    return;
  }

  // Cheap headlight: walls near the camera pick up light, far ones don't.
  float ndv = max(dot(N, V), 0.0);
  float light = 0.25 + 0.6 * pow(ndv, 1.4) * exp(-dist * 0.004);
  if (uFlat > 0.5) light = floor(light * 4.0 + 0.001) / 4.0;

  // Panels: per-cell brightness so the wall isn't a flat sheet.
  vec2 cell = vec2(floor(s / RING), floor(u * 32.0));
  float panel = 0.8 + 0.4 * hash21(cell);

  vec3 col = uWallColor * light * panel;

  // Fine ring lines every RING metres, ribs every 5 rings, longitudinals every 1/16 turn.
  float fine = gridLine(s / RING, 0.035);
  float rib = gridLine(s / (RING * 5.0), 0.006);
  float longi = gridLine(u * 16.0, 0.02);
  if (uFlat > 0.5) {
    fine = step(0.5, fine);
    rib = step(0.5, rib);
    longi = step(0.5, longi);
  }
  // Ribs pulse forward at speed so the tunnel reads as flowing.
  float ribPulse = 0.75 + 0.25 * sin(s * 0.05 - uTime * 9.0);
  col += uLineColor * fine * 0.22 * uGlow;
  col += uLineColor * longi * 0.2 * uGlow;
  col += uRibColor * rib * ribPulse * 0.65 * uGlow;

  // Boost strips: hot chevrons scrolling toward the player.
  if (vTrack.z > 0.01) {
    float chev = fract(s * 0.08 - uTime * 7.0);
    float stripe = smoothstep(0.35, 0.5, chev) * (1.0 - smoothstep(0.5, 0.65, chev));
    if (uFlat > 0.5) stripe = step(0.5, stripe);
    vec3 boost = uBoostColor * (0.55 + 0.9 * stripe + 0.4 * uBoostPulse);
    col = mix(col, boost, vTrack.z * 0.85);
  }

  // Open-profile edges glow like a warning lip.
  float edge = 1.0 - smoothstep(0.0, 0.9, vTrack.y);
  col += uEdgeColor * edge * 1.1 * uGlow;

  // Distance fog to the background colour hides the chunk window.
  float fog = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`

export function makeTunnelMaterial(uniforms: TunnelUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: uniforms as unknown as ShaderMaterial['uniforms'],
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: DoubleSide,
    // Derivatives (dFdx/fwidth) are core in WebGL2 GLSL; three prepends the
    // right version header when the context is WebGL2.
  })
}
