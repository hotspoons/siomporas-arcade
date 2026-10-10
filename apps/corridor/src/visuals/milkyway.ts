// The Milky Way, from a photograph of the real one.
//
// Rich, 2026-09-27: "If there was a public dataset for the sky it would be awesome to use it to
// draw stars and the Milky Way." Then, 2026-10-03, looking at the old five-contour isophote map:
// "the milky way sucks. I'd prefer we had an ultra high resolution actual raster of it".
//
// So it is the real thing now: NASA's Deep Star Maps 2020, the Milky Way layer, a 4096 x 2048
// equirectangular image in celestial coordinates -- dust lanes, the bulge over Sagittarius, both
// Magellanic Clouds. NASA removed the bright Hipparcos/Tycho stars from this layer on purpose, so
// it layers under this renderer's own catalogue stars instead of doubling them. `tools/sky/
// ingest.mjs` decodes the OpenEXR, turns it into this file's equatorial convention, black-points
// it and writes the committed JPEG; see that file for the source and the credit.
//
// KEYED ON BLACK. The ingest drives the empty sky to exactly zero before encoding, and this shader
// keys on luminance as well. Between them the map can only ADD light to the dome: it never pastes
// a black rectangle over the sky, and the soft key also swallows the JPEG's ringing around the
// band. That is what "alpha key on black" has to mean for a bitmap this large without shipping a
// second, six-megabyte alpha channel.
//
// THREE KNOBS, because the plate as ingested is only the start. SKY_MILKYWAY_SHARP is an unsharp
// mask over the band's own texels, SKY_MILKYWAY_CONTRAST is a hue-preserving gamma on its light,
// and SKY_MILKYWAY_BLUR is a nine-tap gaussian at a radius in texels. All three sit BELOW the
// black key, so only the galaxy pays for them -- an empty sky is discarded before any is reached,
// and a zero blur is not sampled at all.
//
// The geometry is a sphere and the mapping is computed in the shader from the direction itself
// rather than from the sphere's own UVs: the equatorial frame here has +x at the vernal equinox
// and +z at the pole, three's SphereGeometry has its pole at +y, and reconciling those with a
// rotation is a thing to get subtly wrong once and then never notice.

import * as THREE from 'three'
import { FAR_PLANE_GLSL } from '@apex/engine/render/depth'
import { DATA_BASE } from '../world/site'

const VERT = /* glsl */ `
${FAR_PLANE_GLSL}
  varying vec3 vDir;
  varying float vAlt;
  void main() {
    vDir = position;
    // at the camera, never parallaxing, exactly as the dome and the stars do
    vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
    // THE FAR PLANE, WHICHEVER WAY DEPTH RUNS. z = w is the far plane of a forward depth buffer and
    // the NEAR plane of a reversed one: the dome then drew in front of the whole world, a sky and
    // nothing else (2026-10-08). toFarPlane is the engine's (@apex/engine/render/depth).
    gl_Position = toFarPlane(p);
    vAlt = normalize((modelMatrix * vec4(position, 1.0)).xyz).y;
  }
`

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uTexel;
  uniform float uNight;
  uniform float uGain;
  uniform float uCover;
  uniform float uSharp;
  uniform float uContrast;
  uniform float uBlur;
  varying vec3 vDir;
  varying float vAlt;

  const float PI = 3.1415926535;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  void main() {
    // below the horizon there is no sky, and the last half degree fades rather than cuts
    float horizon = smoothstep(-0.02, 0.07, vAlt);
    if (horizon <= 0.0) discard;
    vec3 d = normalize(vDir);
    // the ingest's own projection: x = (RA + 180) / 360, y = (90 - Dec) / 180
    float ra = atan(d.y, d.x);
    float dec = asin(clamp(d.z, -1.0, 1.0));
    vec2 uv = vec2(fract((ra + PI) / (2.0 * PI)), (0.5 * PI - dec) / PI);
    // an sRGB texture, so this is already linear light
    vec3 c = texture2D(uMap, uv).rgb;
    float lum = dot(c, LUMA);
    // THE KEY. Everything at or below the black is not sky and is thrown away, so nothing here
    // can darken the dome; a soft shoulder keeps the band's faint edge instead of cutting it.
    float key = smoothstep(0.003, 0.02, lum);
    if (key <= 0.0) discard;
    // BLUR. A nine-tap gaussian at a radius in texels, for a softer, deeper-sky band and to melt
    // the grain and the one satellite trail NASA's composite still carries. Zero is a REAL zero:
    // the branch is not taken and the taps are not paid at all.
    if (uBlur > 0.0) {
      vec2 r = uTexel * uBlur;
      c = c * 0.25
        + (texture2D(uMap, uv + vec2(r.x, 0.0)).rgb + texture2D(uMap, uv - vec2(r.x, 0.0)).rgb
         + texture2D(uMap, uv + vec2(0.0, r.y)).rgb + texture2D(uMap, uv - vec2(0.0, r.y)).rgb) * 0.125
        + (texture2D(uMap, uv + r).rgb + texture2D(uMap, uv - r).rgb
         + texture2D(uMap, uv + vec2(r.x, -r.y)).rgb + texture2D(uMap, uv + vec2(-r.x, r.y)).rgb) * 0.0625;
      lum = dot(c, LUMA);
    }
    // CONTRAST. A gamma on the band's own luminance, applied to the colour too so hue is kept:
    // black stays black and only the midtones move, which is what lifts the mist off the dust.
    if (uContrast != 1.0) {
      float l2 = pow(max(lum, 1e-4), 1.0 / uContrast);
      c *= l2 / max(lum, 1e-4);
      lum = l2;
    }
    // SHARPNESS. Unsharp mask against the four-neighbour mean. It is BELOW the key on purpose:
    // the empty sky is already gone by here, so the four extra taps are only paid over the band
    // itself, which is a small part of the sphere.
    if (uSharp > 0.0) {
      vec3 blur = (
        texture2D(uMap, uv + vec2(uTexel.x, 0.0)).rgb +
        texture2D(uMap, uv - vec2(uTexel.x, 0.0)).rgb +
        texture2D(uMap, uv + vec2(0.0, uTexel.y)).rgb +
        texture2D(uMap, uv - vec2(0.0, uTexel.y)).rgb
      ) * 0.25;
      c = max(c + (c - blur) * uSharp, 0.0);
    }
    // the same extinction the stars take: there is more air to look through low down
    float ext = mix(0.3, 1.0, smoothstep(-0.01, 0.35, vAlt));
    float a = key * uNight * uGain * ext * horizon * (1.0 - 0.9 * uCover);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(c * a, 1.0);
  }
`

export interface MilkyWayLook {
  night: number
  gain: number
  cover: number
  sharp: number
  contrast: number
  blur: number
}

export class MilkyWay {
  readonly mesh: THREE.Mesh
  private readonly u = {
    uMap: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1 / 4096, 1 / 2048) },
    uNight: { value: 0 },
    uGain: { value: 0.05 },
    uCover: { value: 0 },
    uSharp: { value: 1.2 },
    uContrast: { value: 0.95 },
    uBlur: { value: 0 },
  }

  private constructor(map: THREE.Texture) {
    this.u.uMap.value = map
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    // 32 segments is plenty: nothing here has an edge, and the mapping is per fragment anyway
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat)
    this.mesh.name = 'milkyway'
    // OPAQUE, with the dome. A transparent material is drawn after the world, and depthTest off
    // then paints the galaxy over the trees. The dome is -1000; this is just after it and before
    // the stars (-999), still before every piece of the world, which overwrites it.
    this.mesh.renderOrder = -999.5
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
  }

  /**
   * Load the map. Null rather than a throw if it is absent, like the catalogue: a build without
   * the sky assets still runs, with a dome and no galaxy in it.
   */
  static async load(): Promise<MilkyWay | null> {
    try {
      const r = await fetch(`${DATA_BASE}/assets/sky/milkyway.jpg`, { cache: 'force-cache' })
      if (!r.ok) return null
      const bitmap = await createImageBitmap(await r.blob(), { imageOrientation: 'none' })
      const tex = new THREE.Texture(bitmap)
      // EXPLICITLY NOT FLIPPED, so v = 0 is the first row of the file, which the ingest wrote as
      // declination +90. three's flipY is not applied consistently to an ImageBitmap across
      // browsers, and the failure it produces -- a galaxy mirrored about the celestial equator --
      // is one that still looks like a Milky Way.
      tex.flipY = false
      // WRAPS IN RIGHT ASCENSION AND NOT IN DECLINATION. RA 359.9 is next to RA 0.1, so repeat;
      // declination ends at the poles, and a repeat there folds the north sky onto the south.
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      // the ingest wrote sRGB-encoded colour; decode it on sample so the maths below is in light
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      const mw = new MilkyWay(tex)
      // one texel, for the unsharp mask. Taken from the bitmap rather than assumed: the ingest can
      // re-cut the plate at another size and this must follow it.
      mw.u.uTexel.value.set(1 / bitmap.width, 1 / bitmap.height)
      return mw
    } catch {
      return null
    }
  }

  /** the celestial-to-world rotation for this place and moment (celestial.ts) */
  setTransform(m: THREE.Matrix4) {
    this.mesh.matrix.copy(m)
    this.mesh.matrixWorldNeedsUpdate = true
  }

  setLook(look: MilkyWayLook) {
    this.u.uNight.value = look.night
    this.u.uGain.value = look.gain
    this.u.uCover.value = look.cover
    this.u.uSharp.value = look.sharp
    this.u.uContrast.value = look.contrast
    this.u.uBlur.value = look.blur
  }

  dispose() {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.u.uMap.value?.dispose()
  }
}
