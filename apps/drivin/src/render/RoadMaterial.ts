// One shader for road ribbons and tunnel tubes: asphalt with edge lines and a
// dashed centre, curbs striped on curves, tube walls with rib rings, distance
// fog, a cheap headlight term, flat facets and vertex snapping in retro mode.

import { Color, DoubleSide, ShaderMaterial, Vector2, Vector3 } from 'three'

export interface RoadUniforms {
  uTime: { value: number }
  uCameraPos: { value: Vector3 }
  uFogColor: { value: Color }
  uFogDensity: { value: number }
  uAsphalt: { value: Color }
  uLine: { value: Color }
  uCurbA: { value: Color }
  uCurbB: { value: Color }
  uTube: { value: Color }
  uTubeLine: { value: Color }
  uFlat: { value: number }
  uSnap: { value: Vector2 }
}

export function makeRoadUniforms(): RoadUniforms {
  return {
    uTime: { value: 0 },
    uCameraPos: { value: new Vector3() },
    uFogColor: { value: new Color(0xbcd8f2) },
    uFogDensity: { value: 0.0011 },
    uAsphalt: { value: new Color(0x2a2e38) },
    uLine: { value: new Color(0xf2f4ff) },
    uCurbA: { value: new Color(0xe83a3a) },
    uCurbB: { value: new Color(0xf5f5f5) },
    uTube: { value: new Color(0x1a2233) },
    uTubeLine: { value: new Color(0x4de1ff) },
    uFlat: { value: 0 },
    uSnap: { value: new Vector2(0, 0) },
  }
}

const VERT = /* glsl */ `
attribute vec4 aRoad; // s (m), lateral x (m), kind (0 road, 1 curb, 2 tube), curvature
attribute float aWall; // 0 on the road, 0..1 up a speedbowl's wall (1 = its top edge)
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vRoad;
varying float vWall;
uniform vec2 uSnap;
void main() {
  vRoad = aRoad;
  vWall = aWall;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 clip = projectionMatrix * viewMatrix * w;
  if (uSnap.x > 0.0) {
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
varying vec4 vRoad;
varying float vWall;
uniform float uTime;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uAsphalt;
uniform vec3 uLine;
uniform vec3 uCurbA;
uniform vec3 uCurbB;
uniform vec3 uTube;
uniform vec3 uTubeLine;
uniform float uFlat;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float lineAt(float x, float w) {
  float f = abs(fract(x) - 0.5);
  float aa = max(fwidth(x), 1e-5);
  return smoothstep(0.5 - w - aa, 0.5 - w + aa, f) * clamp(2.0 * w / aa, 0.0, 1.0);
}

void main() {
  float s = vRoad.x;
  float x = vRoad.y;
  float kind = vRoad.z;
  vec3 N = normalize(vNormal);
  if (uFlat > 0.5) { N = normalize(cross(dFdx(vWorld), dFdy(vWorld))); if (dot(N, vNormal) < 0.0) N = -N; }
  vec3 V = normalize(uCameraPos - vWorld);
  float dist = length(uCameraPos - vWorld);
  // Underside of an elevated road / outside of a tube: a plain dark deck.
  if (dot(N, V) < 0.0 && kind < 1.5) {
    vec3 deck = uAsphalt * 0.55 * (0.5 + 0.5 * max(dot(-N, normalize(vec3(0.3, 1.0, 0.2))), 0.0));
    float fogU = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
    gl_FragColor = vec4(mix(deck, uFogColor, clamp(fogU, 0.0, 1.0)), 1.0);
    return;
  }
  float light = 0.45 + 0.55 * pow(max(dot(N, V), 0.0), 1.2) * exp(-dist * 0.003);
  float sun = 0.6 + 0.4 * max(dot(N, normalize(vec3(0.3, 1.0, 0.2))), 0.0);
  if (uFlat > 0.5) { light = floor(light * 4.0 + 0.001) / 4.0; sun = floor(sun * 3.0 + 0.001) / 3.0; }
  vec3 col;
  if (kind > 1.5) {
    // Tube wall: dark panels with glowing rib rings every 8 m and a longitudinal seam.
    float rib = lineAt(s / 8.0, 0.02);
    float seam = lineAt(x / 3.0, 0.02);
    float panel = 0.85 + 0.3 * hash21(vec2(floor(s / 8.0), floor(x / 3.0)));
    col = uTube * light * panel + uTubeLine * (rib * 0.9 + seam * 0.25);
  } else if (kind > 0.5) {
    // Curb: red/white every 2 m, brighter where the road curves.
    float stripe = step(0.5, fract(s / 4.0));
    col = mix(uCurbA, uCurbB, stripe) * (0.6 + 0.4 * sun);
    if (abs(vRoad.w) < 0.004) col = mix(col, uAsphalt * 1.6, 0.6) * sun;
  } else {
    // Asphalt with grain, edge lines and a dashed centre line.
    float grain = 0.9 + 0.2 * hash21(floor(vWorld.xz * 2.0));
    col = uAsphalt * grain * sun * light;
    float edge = 1.0 - smoothstep(0.35, 0.55, abs(abs(x) - 4.6));
    float dash = (1.0 - smoothstep(0.08, 0.16, abs(x))) * step(0.5, fract(s / 6.0));
    if (uFlat > 0.5) { edge = step(0.5, edge); dash = step(0.5, dash); }
    col += uLine * (edge * 0.9 + dash * 0.7) * sun;
    // A speedbowl's wall is a lane, so it is painted like one: a dashed line up the middle of it and
    // a solid one along its top, laid out in how far up the wall you are rather than in metres,
    // because how much wall there is grows with the banking.
    if (vWall > 0.001) {
      float wallDash = (1.0 - smoothstep(0.018, 0.032, abs(vWall - 0.5))) * step(0.5, fract(s / 6.0));
      float wallEdge = 1.0 - smoothstep(0.018, 0.034, abs(vWall - 0.95));
      if (uFlat > 0.5) { wallDash = step(0.5, wallDash); wallEdge = step(0.5, wallEdge); }
      col += uLine * (wallDash * 0.7 + wallEdge * 0.9) * sun;
    }
  }
  float fog = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`

export function makeRoadMaterial(uniforms: RoadUniforms): ShaderMaterial {
  return new ShaderMaterial({ uniforms: uniforms as unknown as ShaderMaterial['uniforms'], vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide })
}
