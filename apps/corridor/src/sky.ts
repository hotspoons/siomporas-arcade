// The sky. There was not one: `scene.background` was a flat colour and Rich called it "mid
// atlantic hot summer hazy day with no clouds" (2026-09-26), which is exactly what a single
// blue-grey fill looks like. This is a dome that follows the camera and paints, in one fragment
// shader: a zenith-to-horizon gradient, haze that thickens toward the horizon, a sun disc with a
// halo, and two layers of procedural cumulus that drift.
//
// The colours come from the season and the weather, the same two things `applySky` already
// combines for the fog: the zenith is the season's sky pulled toward the weather's tint, the
// horizon is the fog colour, and the cloud cover is the weather's `skyMix` — a clear day is a
// third covered, an overcast one is shut. Nothing here is a new knob; the sky is what the weather
// system already knew, drawn.
//
// Drawn first, without depth, so nothing about the log-depth buffer or the fog applies to it: the
// dome is the background and the scene lands on top. The radius is only there to keep the sphere
// well inside the far plane.
import * as THREE from 'three'

export interface SkyLook {
  zenith: THREE.Color
  horizon: THREE.Color
  /** 0 clear … 1 overcast: how much of the sky is cloud */
  cover: number
  /** 0 crisp … 1 milky: how far up the horizon haze reaches */
  haze: number
  sunDir: THREE.Vector3
  sunColour: THREE.Color
}

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // the dome sits at the camera: drop the translation so it never parallaxes
    vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
    // and lives at the far edge of clip space, so it never occludes anything with depth on
    gl_Position = p.xyww;
  }
`

const FRAG = /* glsl */ `
  #include <common>
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform float uCover;
  uniform float uHaze;
  uniform float uTime;
  varying vec3 vDir;

  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, -0.05, 1.0);

    // gradient: horizon colour at the horizon, zenith overhead, with the haze deciding how far up
    // the horizon reaches. A hazy day is pale a long way up; a crisp one turns blue fast.
    float t = pow(clamp(up, 0.0, 1.0), mix(0.55, 0.25, uHaze));
    vec3 sky = mix(uHorizon, uZenith, t);

    // sun: a disc and a soft halo, brighter through haze the way it really is
    float cosang = dot(d, uSunDir);
    float disc = smoothstep(0.9993, 0.9997, cosang);
    float halo = pow(max(0.0, cosang), 32.0) * (0.10 + 0.25 * uHaze);
    sky += uSunColour * (disc * 3.0 + halo);

    // clouds: the direction is projected onto a plane at cloud height so the field is flat, not
    // painted on the sphere; near the horizon it compresses into a band, which is the look.
    if (up > 0.01) {
      vec2 p = d.xz / max(up, 0.02);
      float far = 1.0 - exp(-length(p) * 0.35);           // thins the field toward the horizon
      vec2 drift = vec2(uTime * 0.004, uTime * 0.0015);
      float base = fbm(p * 0.35 + drift);
      float detail = fbm(p * 1.4 - drift * 2.0 + 3.7);
      float field = base * 0.7 + detail * 0.3;
      // cover moves the threshold: 0 cover leaves only the tallest tops, 1 fills the sky
      float thresh = mix(0.68, 0.30, uCover);
      float cloud = smoothstep(thresh, thresh + 0.16, field);
      // lit from the sun side, grey underneath; an overcast sky goes flat and lowers the whole tone
      float lit = 0.55 + 0.45 * clamp(dot(normalize(vec3(uSunDir.x, 0.6, uSunDir.z)), vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
      vec3 cloudCol = mix(vec3(0.62, 0.64, 0.68), vec3(1.0, 0.99, 0.97) * lit, 1.0 - uCover * 0.7);
      cloudCol = mix(cloudCol, uHorizon, far * 0.6);
      sky = mix(sky, cloudCol, cloud * (1.0 - far * 0.5) * (0.85 + 0.15 * uCover));
    }
    gl_FragColor = vec4(sky, 1.0);
    #include <colorspace_fragment>
  }
`

export class Sky {
  readonly mesh: THREE.Mesh
  private readonly u = {
    uZenith: { value: new THREE.Color(0x5d8fd6) },
    uHorizon: { value: new THREE.Color(0xd9e4ee) },
    uSunDir: { value: new THREE.Vector3(-3000, 4000, 2500).normalize() },
    uSunColour: { value: new THREE.Color(0xfff0d8) },
    uCover: { value: 0.35 },
    uHaze: { value: 0.5 },
    uTime: { value: 0 },
  }

  constructor() {
    const geo = new THREE.SphereGeometry(1, 48, 24)
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.name = 'sky'
    this.mesh.renderOrder = -1000
    this.mesh.frustumCulled = false
    // unit sphere with the translation dropped in the shader: the radius is irrelevant, the
    // position is irrelevant, it is the background
  }

  set(look: SkyLook) {
    this.u.uZenith.value.copy(look.zenith)
    this.u.uHorizon.value.copy(look.horizon)
    this.u.uCover.value = look.cover
    this.u.uHaze.value = look.haze
    this.u.uSunDir.value.copy(look.sunDir).normalize()
    this.u.uSunColour.value.copy(look.sunColour)
  }

  tick(seconds: number) {
    this.u.uTime.value = seconds
  }
}
