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
import { FAR_PLANE_GLSL } from '@apex/engine/render/depth'

export interface SkyLook {
  zenith: THREE.Color
  horizon: THREE.Color
  /** 0 clear … 1 overcast: how much of the sky is cloud */
  cover: number
  /** 0 crisp … 1 milky: how far up the horizon haze reaches */
  haze: number
  sunDir: THREE.Vector3
  sunColour: THREE.Color
  /** 0 full day … 1 full night: the sun's own elevation decides it (main.ts applySky) */
  night?: number
  /** how many stars, 0 … 1; they are only drawn into the night part */
  stars?: number
  /** high cirrus brightness, 0 … 1. Coverage is cirrusAmt */
  cirrus?: number
  /** how much of the sky the wisps cover, 0 clear … 1 a deck */
  cirrusAmt?: number
  /** noise-units per second the high layer travels, already scaled by speed and heading */
  cirrusWind?: THREE.Vector2
  /** cumulus coverage, 0 clear … 1 a deck. The time-of-day cloud knobs scale it */
  cumulusAmt?: number
  /** noise-units per second the cumulus deck travels */
  cumulusWind?: THREE.Vector2
  /** the cumulus deck, 0 … 1. 0 removes the band on the horizon; cirrus does not */
  clouds?: number
  /** the horizon wash: colour, how tightly it sits on the horizon, how strongly it shows */
  atten?: THREE.Color
  attenSlope?: number
  attenAmt?: number
  /** where the moon is; its elevation lights the night the way the sun lights the day */
  moonDir?: THREE.Vector3
  /** 0 new … 1 full */
  moonPhase?: number
}

const VERT = /* glsl */ `
${FAR_PLANE_GLSL}
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // the dome sits at the camera: drop the translation so it never parallaxes
    vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
    // and lives at the far edge of clip space, so it never occludes anything with depth on
    // THE FAR PLANE, WHICHEVER WAY DEPTH RUNS. z = w is the far plane of a forward depth buffer and
    // the NEAR plane of a reversed one: the dome then drew in front of the whole world, a sky and
    // nothing else (2026-10-08). toFarPlane is the engine's (@apex/engine/render/depth).
    gl_Position = toFarPlane(p);
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
  uniform float uNight;
  uniform float uStars;
  uniform float uCirrus;
  uniform float uCirrusAmt;
  uniform vec2 uCirrusWind;
  uniform float uCloud;
  uniform float uCumulusAmt;
  uniform vec2 uCumulusWind;
  uniform vec3 uAtten;
  uniform float uAttenSlope;
  uniform float uAttenAmt;
  uniform vec3 uMoonDir;
  uniform float uMoonPhase;
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

  /** a hash over a direction, stable in world space so the stars do not swim as you turn */
  float starHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  /**
   * Stars, as points on a coarse lattice over the sphere: one candidate per cell, kept if its hash
   * is high enough, drawn as a tight gaussian. Twinkle is a slow per-star wobble, stronger near the
   * horizon where a real one has more air to look through.
   */
  vec3 starField(vec3 d, float amount) {
    if (amount <= 0.001) return vec3(0.0);
    vec3 acc = vec3(0.0);
    // POINTS, NOT BLOBS (Rich, 2026-09-26). A star is unresolvable: what a lens shows is a
    // point spread a pixel or two across, so the lattice is fine and the falloff is tight and
    // raised to a high power — a wide smoothstep over a coarse lattice is what made them read as
    // fuzzy squares. The three layers differ in density and brightness, not in size.
    for (float layer = 0.0; layer < 3.0; layer += 1.0) {
      // THE LATTICE HAS TO BE COARSER THAN A PIXEL. A cell subtends 1/scale radians, which at this
      // field of view is about 600/scale pixels: at 420 a cell was 1.4 px and a 0.16-cell core was
      // a quarter of a pixel, so the stars fell between the samples and vanished entirely. At 130
      // a cell is ~4.6 px and the core is under a pixel — a point, which is what a star is.
      float scale = 130.0 + layer * 85.0;
      vec3 q = d * scale;
      vec3 cell = floor(q);
      float h = starHash(cell);
      // density stays in 0..1; amount above that is brightness, same as the catalogue gain
      if (h < mix(0.996, 0.972, clamp(amount, 0.0, 1.0))) continue;
      vec3 centre = cell + 0.5 + 0.7 * (vec3(starHash(cell + 1.7), starHash(cell + 3.3), starHash(cell + 5.9)) - 0.5);
      // distance in PIXELS, near enough: the dome is drawn over the whole screen, so one cell is
      // about (screen height / scale) pixels and a star should be about one of them across
      float dist = length(q - centre);
      float core = pow(smoothstep(0.19, 0.0, dist), 2.0);
      float bloom = pow(smoothstep(0.45, 0.0, dist), 6.0) * 0.28;   // the faint halo a bright star has
      float twinkle = 0.72 + 0.28 * sin(uTime * (1.3 + 2.0 * h) + h * 31.4);
      // the horizon is thicker air: dimmer and more restless
      float alt = smoothstep(-0.02, 0.30, d.y);
      vec3 tint = mix(vec3(1.0, 0.92, 0.82), vec3(0.78, 0.86, 1.0), starHash(cell + 11.0));
      float mag = (0.35 + 0.65 * pow(h, 6.0)) * (1.0 - layer * 0.22);   // a few bright ones, many faint
      acc += tint * (core + bloom) * twinkle * alt * mag;
    }
    return acc * amount * 1.6;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, -0.05, 1.0);

    // gradient: horizon colour at the horizon, zenith overhead, with the haze deciding how far up
    // the horizon reaches. A hazy day is pale a long way up; a crisp one turns blue fast.
    float t = pow(clamp(up, 0.0, 1.0), mix(0.55, 0.25, uHaze));
    vec3 sky = mix(uHorizon, uZenith, t);

    // atmospheric wash: the air itself, paler toward the horizon. Slope is how tightly it sits
    // there — high is a thin band, low reaches the zenith. Amount is how much of it shows.
    float band = pow(1.0 - clamp(up, 0.0, 1.0), max(uAttenSlope, 0.05));
    sky = mix(sky, uAtten, band * uAttenAmt);

    // STARS FIRST, under everything else: they are the background at night, so the sun's halo, the
    // moon and the clouds all draw over them. Clouds hide stars, which is most of what a cloudy
    // night looks like.
    sky += starField(d, uStars * uNight * (1.0 - 0.85 * uCover));

    // sun: a disc and a soft halo, brighter through haze the way it really is. Below the horizon
    // it stops lighting the sky — but not abruptly: the halo is what twilight IS.
    float cosang = dot(d, uSunDir);
    float disc = smoothstep(0.9993, 0.9997, cosang) * step(-0.02, uSunDir.y);
    float halo = pow(max(0.0, cosang), 32.0) * (0.10 + 0.25 * uHaze);
    float sunUp = smoothstep(-0.18, 0.02, uSunDir.y);
    sky += uSunColour * (disc * 3.0 + halo * mix(0.25, 1.0, sunUp));

    // moon: a disc with a terminator from the phase, and a cool halo. It is the night's sun.
    if (uNight > 0.01 && uMoonDir.y > -0.1) {
      float mcos = dot(d, uMoonDir);
      float mdisc = smoothstep(0.99955, 0.99975, mcos);
      // the lit fraction: 0 new, 1 full. A crescent is the disc minus an offset disc.
      vec3 side = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
      float across = dot(normalize(d - uMoonDir * mcos), side);
      float lit = smoothstep(-1.0, 1.0, (across + (uMoonPhase * 2.0 - 1.0) * 1.6) * 1.2);
      float mhalo = pow(max(0.0, mcos), 200.0) * 0.25;
      sky += vec3(0.95, 0.96, 0.9) * (mdisc * 2.2 * mix(0.05, 1.0, lit) + mhalo) * uNight;
    }

    // cirrus: high, thin, stretched. Amount moves the threshold, so 0 is a clear sky and 1 fills
    // it. Brightness only fades the same streaks, which is what made the layer look fixed.
    if (up > 0.01 && uCirrus > 0.001 && uCirrusAmt > 0.001) {
      vec2 q = d.xz / max(up, 0.02) * 0.11;
      vec2 drift = uCirrusWind * uTime;
      float f = fbm(vec2(q.x * 0.35, q.y * 2.6) + drift);
      float thresh = mix(1.02, 0.08, uCirrusAmt);
      float edge = mix(0.34, 0.12, uCirrusAmt);
      float streak = smoothstep(thresh, thresh + edge, f) * smoothstep(0.0, 0.25, up);
      vec3 col = mix(vec3(0.86, 0.89, 0.94), uSunColour * 1.1, 0.35 * sunUp);
      float gain = mix(0.35, 1.15, uCirrusAmt);
      sky = mix(sky, mix(col, uHorizon, 0.35), streak * uCirrus * gain * (1.0 - uNight * 0.55));
    }

    // cumulus: projected onto a plane so the field is flat, and compressed into a band at the
    // horizon. Amount is how much of that field is cloud. uCloud is the time-of-day scale.
    if (up > 0.01 && uCloud > 0.001 && uCumulusAmt > 0.001) {
      vec2 p = d.xz / max(up, 0.02);
      float far = 1.0 - exp(-length(p) * 0.35);
      vec2 wind = uCumulusWind * uTime;
      float base = fbm(p * 0.35 + wind);
      float detail = fbm(p * 1.4 - wind * 2.0 + 3.7);
      float field = base * 0.7 + detail * 0.3;
      float thresh = mix(1.05, 0.18, uCumulusAmt);
      float edge = mix(0.28, 0.12, uCumulusAmt);
      float cloud = smoothstep(thresh, thresh + edge, field);
      float lit = 0.55 + 0.45 * clamp(dot(normalize(vec3(uSunDir.x, 0.6, uSunDir.z)), vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
      vec3 cloudCol = mix(vec3(0.62, 0.64, 0.68), vec3(1.0, 0.99, 0.97) * lit, 1.0 - uCover * 0.7);
      cloudCol = mix(cloudCol, uHorizon, far * 0.6);
      cloudCol = mix(cloudCol, mix(vec3(0.05, 0.06, 0.09), vec3(0.20, 0.21, 0.26), uMoonPhase * 0.6), uNight);
      float gain = mix(0.55, 1.05, uCumulusAmt);
      sky = mix(sky, cloudCol, cloud * (1.0 - far * 0.5) * gain * uCloud);
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
    uNight: { value: 0 },
    uStars: { value: 0.7 },
    uCirrus: { value: 0.25 },
    uCirrusAmt: { value: 0.55 },
    uCirrusWind: { value: new THREE.Vector2(0.0016, 0.0006) },
    uCloud: { value: 1 },
    uCumulusAmt: { value: 0.55 },
    uCumulusWind: { value: new THREE.Vector2(0.004, 0.0015) },
    uAtten: { value: new THREE.Color(0xc5daf2) },
    uAttenSlope: { value: 1.5 },
    uAttenAmt: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0.3, 0.6, -0.7).normalize() },
    uMoonPhase: { value: 0.6 },
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
    this.u.uNight.value = look.night ?? 0
    this.u.uStars.value = look.stars ?? 0.7
    this.u.uCirrus.value = look.cirrus ?? 0.25
    this.u.uCirrusAmt.value = look.cirrusAmt ?? 0.55
    if (look.cirrusWind) this.u.uCirrusWind.value.copy(look.cirrusWind)
    this.u.uCloud.value = look.clouds ?? 1
    this.u.uCumulusAmt.value = look.cumulusAmt ?? 0.55
    if (look.cumulusWind) this.u.uCumulusWind.value.copy(look.cumulusWind)
    if (look.atten) this.u.uAtten.value.copy(look.atten)
    this.u.uAttenSlope.value = look.attenSlope ?? 1.5
    this.u.uAttenAmt.value = look.attenAmt ?? 0
    if (look.moonDir) this.u.uMoonDir.value.copy(look.moonDir).normalize()
    if (look.moonPhase !== undefined) this.u.uMoonPhase.value = look.moonPhase
  }

  tick(seconds: number) {
    this.u.uTime.value = seconds
  }
}
