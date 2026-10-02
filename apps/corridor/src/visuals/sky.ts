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
  /** 0 full day … 1 full night: the sun's own elevation decides it (main.ts applySky) */
  night?: number
  /** how many stars, 0 … 1; they are only drawn into the night part */
  stars?: number
  /** high cirrus, 0 … 1 — the wispy layer above the cumulus */
  cirrus?: number
  /** where the moon is; its elevation lights the night the way the sun lights the day */
  moonDir?: THREE.Vector3
  /** 0 new … 1 full */
  moonPhase?: number
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
  uniform float uNight;
  uniform float uStars;
  uniform float uCirrus;
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
      if (h < mix(0.996, 0.972, amount)) continue;
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

    // cirrus: high, thin, stretched — the wispy layer, well above the cumulus and much flatter
    if (up > 0.01 && uCirrus > 0.001) {
      vec2 q = d.xz / max(up, 0.02) * 0.11;
      vec2 drift = vec2(uTime * 0.0016, uTime * 0.0006);
      float f = fbm(vec2(q.x * 0.35, q.y * 2.6) + drift);
      float streak = smoothstep(0.52, 0.86, f) * smoothstep(0.0, 0.25, up);
      vec3 col = mix(vec3(0.86, 0.89, 0.94), uSunColour * 1.1, 0.35 * sunUp);
      sky = mix(sky, mix(col, uHorizon, 0.35), streak * uCirrus * 0.7 * (1.0 - uNight * 0.55));
    }

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
      // AT NIGHT A CLOUD IS DARKER THAN THE SKY, not brighter. Lit by nothing but the moon and the
      // towns below, it reads as a hole in the stars — which is also how a night sky tells you it
      // is cloudy. Left at its daytime grey it was a bright ceiling with no stars under it.
      cloudCol = mix(cloudCol, mix(vec3(0.05, 0.06, 0.09), vec3(0.20, 0.21, 0.26), uMoonPhase * 0.6), uNight);
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
    uNight: { value: 0 },
    uStars: { value: 0.7 },
    uCirrus: { value: 0.25 },
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
    if (look.moonDir) this.u.uMoonDir.value.copy(look.moonDir).normalize()
    if (look.moonPhase !== undefined) this.u.uMoonPhase.value = look.moonPhase
  }

  tick(seconds: number) {
    this.u.uTime.value = seconds
  }
}
