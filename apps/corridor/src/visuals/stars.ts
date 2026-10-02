// Nine thousand real stars, in the right place, turning the way the sky turns.
//
// Rich, 2026-09-27: "make the night sky based on reality wrt stars ... Stars are currently nicely
// rendered so I'd want to try to keep aesthetic."
//
// So the LOOK is kept and only the positions change. What the procedural version got right — a
// star is an unresolvable point, so a tight core with a faint halo rather than a soft blob; a slow
// twinkle that gets restless near the horizon; three brightness tiers so the sky has depth — all
// of that is here. What it got wrong is that it was a hash, so there was no Orion in it.
//
// ONE OBJECT, ONE MATRIX. The catalogue's J2000 right ascension and declination become a unit
// vector once, at load. Everything after that is the celestial-to-world rotation from
// `celestial.ts`, applied to the whole Points object — which is both exact and what the sky is
// actually doing. Nine thousand stars cost one matrix a frame.
//
// DRAWN AS BACKGROUND, like the dome it sits in: no depth test, no depth write, at the far edge of
// clip space, just after the dome and before the world. The world then paints over it with its own
// depth, which is what a star being behind a tree means.

import * as THREE from 'three'
import { DATA_BASE } from '../world/site'

/** what the ingest wrote — see tools/sky/ingest.mjs */
const BYTES_PER_STAR = 12

const VERT = /* glsl */ `
  attribute float aMag;
  attribute float aBV;
  uniform float uPixel;
  uniform float uMagLimit;
  uniform float uSize;
  varying float vBright;
  varying vec3 vTint;
  varying float vAlt;
  varying float vSeed;

  /**
   * A star's colour from its B-V index, which is what colour a star IS: about -0.3 for the hot
   * blue ones (Rigel), 0 for white (Vega), +1.6 for the cold red ones (Betelgeuse). A coarse ramp
   * through those three is indistinguishable from a blackbody fit at this size and needs no table.
   */
  vec3 tintOf(float bv) {
    float t = clamp((bv + 0.4) / 2.0, 0.0, 1.0);
    vec3 blue = vec3(0.72, 0.80, 1.00);
    vec3 white = vec3(1.00, 0.98, 0.95);
    vec3 red = vec3(1.00, 0.80, 0.62);
    return t < 0.35 ? mix(blue, white, t / 0.35) : mix(white, red, (t - 0.35) / 0.65);
  }

  void main() {
    // the sphere sits at the camera and never parallaxes, exactly as the dome does
    vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
    gl_Position = p.xyww;
    vAlt = normalize((modelMatrix * vec4(position, 1.0)).xyz).y;
    // BRIGHTNESS IS A MAGNITUDE, so it is logarithmic: five magnitudes is a factor of a hundred.
    // Without that the sky is a uniform dusting and Sirius looks like everything else.
    vBright = clamp(pow(10.0, -0.4 * (aMag - 1.0)), 0.0, 6.0) * step(aMag, uMagLimit);
    vTint = tintOf(aBV);
    vSeed = fract(aMag * 13.73 + aBV * 7.31 + float(gl_VertexID) * 0.0137);
    // A STAR IS A POINT. The sprite is only big enough to hold the core and its halo, and the
    // bright ones get a little more room for the halo rather than a bigger disc — which is what a
    // lens does, and what stops Sirius reading as a planet.
    gl_PointSize = uPixel * uSize * (1.0 + 0.55 * min(vBright, 3.0));
  }
`

const FRAG = /* glsl */ `
  uniform float uNight;
  uniform float uStars;
  uniform float uCover;
  uniform float uTime;
  varying float vBright;
  varying vec3 vTint;
  varying float vAlt;
  varying float vSeed;

  void main() {
    // below the horizon there are no stars; the fade is the last half degree of atmosphere
    float horizon = smoothstep(-0.015, 0.06, vAlt);
    if (horizon <= 0.0 || vBright <= 0.0) discard;
    vec2 q = gl_PointCoord - 0.5;
    float r = length(q) * 2.0;
    // the same profile the procedural version had: a tight core, and a faint halo only a bright
    // star shows. A wide smoothstep is what made stars read as fuzzy squares.
    float core = pow(max(0.0, 1.0 - r), 6.0);
    float halo = pow(max(0.0, 1.0 - r), 2.0) * 0.16 * min(vBright, 4.0);
    // twinkle: slow, per star, and stronger low down where there is more air to look through
    float air = mix(1.0, 0.45, smoothstep(0.35, 0.02, vAlt));
    float tw = 1.0 - air * 0.3 * (0.5 + 0.5 * sin(uTime * (1.2 + 2.2 * vSeed) + vSeed * 31.4));
    // extinction near the horizon, on top of the twinkle: the air dims as well as unsettles
    float ext = mix(0.35, 1.0, smoothstep(-0.01, 0.35, vAlt));
    float a = (core + halo) * vBright * tw * ext * horizon * uNight * uStars * (1.0 - 0.85 * uCover);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vTint * a, 1.0);
  }
`

export class Stars {
  readonly points: THREE.Points
  /** how many the catalogue gave us, and how many are drawn at the current limit */
  count = 0
  private readonly u = {
    uNight: { value: 0 },
    uStars: { value: 0.7 },
    uCover: { value: 0 },
    uTime: { value: 0 },
    uPixel: { value: 2.2 },
    uMagLimit: { value: 6.5 },
    uSize: { value: 1 },
  }

  private constructor(geo: THREE.BufferGeometry, count: number) {
    this.count = count
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.name = 'stars'
    // just after the dome (-1000) and well before the world, and never culled: the object is a
    // whole celestial sphere and its bounding box says nothing useful once it is rotated
    this.points.renderOrder = -999
    this.points.frustumCulled = false
    this.points.matrixAutoUpdate = false
  }

  /**
   * Load the packed catalogue. Returns null rather than throwing if the asset is absent, so a
   * build without the sky assets still runs — with the dome and no stars, which is a night sky
   * with cloud in it rather than a crash.
   */
  static async load(): Promise<Stars | null> {
    try {
      const r = await fetch(`${DATA_BASE}/assets/sky/stars.bin`, { cache: 'force-cache' })
      if (!r.ok) return null
      const buf = await r.arrayBuffer()
      const n = Math.floor(buf.byteLength / BYTES_PER_STAR)
      if (!n) return null
      const dv = new DataView(buf)
      const pos = new Float32Array(n * 3)
      const mag = new Float32Array(n)
      const bv = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const o = i * BYTES_PER_STAR
        const ra = dv.getFloat32(o, true)
        const dec = dv.getFloat32(o + 4, true)
        const cd = Math.cos(dec)
        // the equatorial frame celestial.ts documents: x to the vernal equinox, z to the pole
        pos[i * 3] = cd * Math.cos(ra)
        pos[i * 3 + 1] = cd * Math.sin(ra)
        pos[i * 3 + 2] = Math.sin(dec)
        mag[i] = dv.getInt16(o + 8, true) / 100
        bv[i] = dv.getInt8(o + 10) / 50
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1))
      geo.setAttribute('aBV', new THREE.BufferAttribute(bv, 1))
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1)
      return new Stars(geo, n)
    } catch {
      return null
    }
  }

  /** the celestial-to-world rotation for this place and moment (celestial.ts) */
  setTransform(m: THREE.Matrix4) {
    this.points.matrix.copy(m)
    this.points.matrixWorldNeedsUpdate = true
  }

  setLook(night: number, stars: number, cover: number) {
    this.u.uNight.value = night
    this.u.uStars.value = stars
    this.u.uCover.value = cover
  }

  tick(seconds: number, dprHeight: number, pixel: number, size: number, magLimit: number) {
    this.u.uTime.value = seconds
    // a star should be about the same number of pixels whatever the window is, so the sprite is
    // sized against the drawing buffer rather than left in clip units
    this.u.uPixel.value = Math.max(1, pixel * (dprHeight / 900))
    this.u.uSize.value = size
    this.u.uMagLimit.value = magLimit
  }

  dispose() {
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}
