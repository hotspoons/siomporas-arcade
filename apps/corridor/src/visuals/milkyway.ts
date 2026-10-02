// The Milky Way, from a map of the real one.
//
// Rich, 2026-09-27: "If there was a public dataset for the sky it would be awesome to use it to
// draw stars and the Milky Way."
//
// So this is not noise shaped like a band. It is the d3-celestial isophotes -- five nested
// brightness contours of the real galaxy -- rasterised by `tools/sky/ingest.mjs` into an
// equirectangular luminance map in equatorial coordinates, and sampled here on the same celestial
// sphere the catalogue stars sit on, turned by the same matrix. The bulge is over Sagittarius
// because that is where the bulge is; the Great Rift is dark because the dust is there.
//
// VECTOR CONTOURS RATHER THAN A PHOTOGRAPH, deliberately. A Brunier panorama behind a stylised
// dome reads as a photograph pasted behind a drawing. Contours blurred to about a degree give a
// soft glow that sits with the stars, which is the look being kept.
//
// The geometry is a sphere and the mapping is computed in the shader from the direction itself
// rather than from the sphere's own UVs: the equatorial frame here has +x at the vernal equinox
// and +z at the pole, three's SphereGeometry has its pole at +y, and reconciling those with a
// rotation is a thing to get subtly wrong once and then never notice.

import * as THREE from 'three'
import { DATA_BASE } from '../world/site'

const VERT = /* glsl */ `
  varying vec3 vDir;
  varying float vAlt;
  void main() {
    vDir = position;
    // at the camera, never parallaxing, exactly as the dome and the stars do
    vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
    gl_Position = p.xyww;
    vAlt = normalize((modelMatrix * vec4(position, 1.0)).xyz).y;
  }
`

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uNight;
  uniform float uGain;
  uniform float uCover;
  varying vec3 vDir;
  varying float vAlt;

  const float PI = 3.1415926535;

  void main() {
    // below the horizon there is no sky, and the last half degree fades rather than cuts
    float horizon = smoothstep(-0.02, 0.07, vAlt);
    if (horizon <= 0.0) discard;
    vec3 d = normalize(vDir);
    // the ingest's own projection: x = (RA + 180) / 360, y = (90 - Dec) / 180
    float ra = atan(d.y, d.x);
    float dec = asin(clamp(d.z, -1.0, 1.0));
    vec2 uv = vec2(fract((ra + PI) / (2.0 * PI)), (0.5 * PI - dec) / PI);
    float v = texture2D(uMap, uv).r;
    if (v <= 0.002) discard;
    // The map is a count of nested contours, so it is already a ramp -- but a linear ramp reads as
    // a flat smear. Squaring it puts the light where the galaxy actually concentrates it and lets
    // the faint outer contour fall away to nothing instead of ending at an edge.
    float b = v * v;
    // the same extinction the stars take: there is more air to look through low down
    float ext = mix(0.3, 1.0, smoothstep(-0.01, 0.35, vAlt));
    float a = b * uNight * uGain * ext * horizon * (1.0 - 0.9 * uCover);
    if (a <= 0.002) discard;
    // a touch blue, and warmer toward the bright core, which is what the dust does to it
    vec3 tint = mix(vec3(0.72, 0.78, 1.0), vec3(1.0, 0.94, 0.84), clamp(b * 1.6, 0.0, 1.0));
    gl_FragColor = vec4(tint * a, 1.0);
  }
`

export class MilkyWay {
  readonly mesh: THREE.Mesh
  private readonly u = {
    uMap: { value: null as THREE.Texture | null },
    uNight: { value: 0 },
    uGain: { value: 0.5 },
    uCover: { value: 0 },
  }

  private constructor(map: THREE.Texture) {
    this.u.uMap.value = map
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    // 32 segments is plenty: nothing here has an edge, and the mapping is per fragment anyway
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat)
    this.mesh.name = 'milkyway'
    // after the dome (-1000) and before the stars (-999): the galaxy is behind them
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
      const r = await fetch(`${DATA_BASE}/assets/sky/milkyway.png`, { cache: 'force-cache' })
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
      tex.colorSpace = THREE.NoColorSpace // a luminance map, not a picture: no sRGB decode
      tex.needsUpdate = true
      return new MilkyWay(tex)
    } catch {
      return null
    }
  }

  /** the celestial-to-world rotation for this place and moment (celestial.ts) */
  setTransform(m: THREE.Matrix4) {
    this.mesh.matrix.copy(m)
    this.mesh.matrixWorldNeedsUpdate = true
  }

  setLook(night: number, gain: number, cover: number) {
    this.u.uNight.value = night
    this.u.uGain.value = gain
    this.u.uCover.value = cover
  }

  dispose() {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.u.uMap.value?.dispose()
  }
}
