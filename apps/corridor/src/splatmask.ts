// Where the capture wins, and how the built world gets out of its way.
//
// Rich, 2026-09-27: "let's get my neighborhood baked into the world properly with a crossfade of
// corridor rendered world as you approach the edge of the splats."
//
// `SplatField.weightAt` already answers "how much of this point belongs to the capture" — but it
// answers it by walking every segment of every pass, which on arrowhead-2026-09 is 7,703 of them.
// That is fine a few times a frame and impossible per vertex, per blade, or per fragment. So the
// envelope is rasterised ONCE into a small single-channel texture in site metres, and every shader
// that has to yield samples that instead.
//
// WHY A DITHER AND NOT A BLEND. The built world fades out by discarding a screen-door pattern of
// fragments, not by turning transparent. Gaussians are sorted by Spark against everything else in
// the scene; a half-transparent road would need to take part in that order and it cannot. A
// dissolve writes depth normally, so the two worlds interleave correctly at any angle, which is
// the same trick the tree impostors already use to hand over to their models.
//
// The raster is deliberately coarse. The envelope is a 25 m tube around a driven path with an 18 m
// fade on it, so a 4 m cell resolves it to about a fifth of the fade band, and the bilinear read
// smooths what is left. It costs 600 kB for a 3 km world.

import * as THREE from 'three'

export interface SplatMaskUniforms {
  /** coverage in site metres, R8, bilinear */
  uSplatMap: { value: THREE.Texture | null }
  /** the raster's box in site metres: x0, z0, x1, z1 */
  uSplatBox: { value: THREE.Vector4 }
  /** master: 0 leaves the built world alone entirely */
  uSplatFade: { value: number }
}

export function splatMaskUniforms(): SplatMaskUniforms {
  return {
    uSplatMap: { value: null },
    uSplatBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSplatFade: { value: 0 },
  }
}

/**
 * The GLSL. `splatCover(worldPos)` is 0 where the built world owns the ground and 1 where the
 * capture does; `splatDissolve` turns that into a discard.
 */
export const SPLAT_MASK_PARS = /* glsl */ `
  uniform sampler2D uSplatMap;
  uniform vec4 uSplatBox;
  uniform float uSplatFade;

  float splatCover(vec3 wp) {
    if (uSplatFade <= 0.0) return 0.0;
    vec2 t = (wp.xz - uSplatBox.xy) / max(uSplatBox.zw - uSplatBox.xy, vec2(1e-3));
    // outside the raster is outside the capture, and a clamped read would smear its edge row
    // across the whole world
    if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return 0.0;
    return texture2D(uSplatMap, t).r * uSplatFade;
  }

  /**
   * The 4x4 ordered dither, COMPUTED rather than indexed.
   *
   * The obvious spelling is a 'const mat4' and 'B[x][y]', and GLSL ES 1.0 does not allow a matrix
   * to be indexed by anything but a constant expression or a loop counter -- so on a driver that
   * enforces it the whole program fails to link, and everything the material was drawing vanishes
   * rather than dithering. The classic nesting M4 = 4*M2[y>>1][x>>1] + M2[y&1][x&1] needs no
   * indexing at all.
   */
  float m2(float x, float y) { return mix(2.0 * x, 3.0 - 2.0 * x, y); }
  float bayer4(vec2 p) {
    vec2 q = mod(floor(p), 4.0);
    float lo = m2(mod(q.x, 2.0), mod(q.y, 2.0));
    float hi = m2(floor(q.x * 0.5), floor(q.y * 0.5));
    return (4.0 * hi + lo + 0.5) / 16.0;
  }

  /**
   * A screen-door dissolve, discarding where the capture has taken over.
   *
   * The 4x4 ordered matrix rather than a hash: a hash makes the surviving fragments crawl as the
   * camera moves, which on a road surface reads as static. An ordered matrix is fixed to the
   * screen, so the holes stay put and the eye takes it for a fade.
   */
  void splatDissolve(vec3 wp) {
    float c = splatCover(wp);
    if (c <= 0.0) return;
    if (c >= 0.999) discard;
    if (c > bayer4(gl_FragCoord.xy)) discard;
  }
`

/**
 * Rasterise a capture's envelope into a coverage texture.
 *
 * DRAWN, NOT QUERIED. The obvious way round is to walk every texel and ask `weightAt`, and on
 * arrowhead-2026-09 that is 613,000 texels against 7,703 pass segments -- 4.7 billion distance
 * tests, which is minutes of a frozen tab. Instead each segment is STAMPED into the grid over the
 * only cells it can possibly reach, which is 7,703 brushes of about four hundred cells: three
 * million tests, and it runs in the time it takes to decode the JSON.
 *
 * The result is geometric -- it says where the capture COVERS, not what is resident. Residency is
 * a property of the stream and changes every few seconds; baking it into the seam would mean
 * rebuilding this every time a tile arrives, and a seam that moves while you drive is worse than
 * a hole. `SplatField.weightAt` still applies the residency test for point queries.
 */
export function rasteriseEnvelope(
  box: { x0: number; z0: number; x1: number; z1: number },
  cellM: number,
  passes: { x: number; y: number }[][],
  core: number,
  fade: number,
): { tex: THREE.DataTexture; box: THREE.Vector4; w: number; h: number; covered: number; segments: number } {
  const w = Math.max(2, Math.min(2048, Math.ceil((box.x1 - box.x0) / cellM)))
  const h = Math.max(2, Math.min(2048, Math.ceil((box.z1 - box.z0) / cellM)))
  const sx = (box.x1 - box.x0) / w
  const sz = (box.z1 - box.z0) / h
  const data = new Uint8Array(w * h)
  const reach = core + Math.max(0.1, fade)
  let segments = 0
  const toI = (x: number) => (x - box.x0) / sx - 0.5
  const toJ = (z: number) => (z - box.z0) / sz - 0.5
  for (const pass of passes) {
    for (let k = 1; k < pass.length; k++) {
      // the pass is in site metres with y = NORTH; the raster's second axis is world z = -north
      const ax = pass[k - 1].x
      const az = -pass[k - 1].y
      const bx = pass[k].x
      const bz = -pass[k].y
      segments++
      const i0 = Math.max(0, Math.floor(toI(Math.min(ax, bx) - reach)))
      const i1 = Math.min(w - 1, Math.ceil(toI(Math.max(ax, bx) + reach)))
      const j0 = Math.max(0, Math.floor(toJ(Math.min(az, bz) - reach)))
      const j1 = Math.min(h - 1, Math.ceil(toJ(Math.max(az, bz) + reach)))
      if (i1 < i0 || j1 < j0) continue
      const dx = bx - ax
      const dz = bz - az
      const L = dx * dx + dz * dz || 1
      for (let j = j0; j <= j1; j++) {
        // the texel CENTRE, not its corner: half a cell of bias here shifts the whole seam, which
        // is the kind of thing that looks like a fit problem and is not
        const z = box.z0 + ((j + 0.5) / h) * (box.z1 - box.z0)
        for (let i = i0; i <= i1; i++) {
          const x = box.x0 + ((i + 0.5) / w) * (box.x1 - box.x0)
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L))
          const ddx = ax + u * dx - x
          const ddz = az + u * dz - z
          const d = Math.sqrt(ddx * ddx + ddz * ddz)
          if (d >= reach) continue
          // the same smoothstep `weightAt` uses, so the drawn seam and a point query agree
          const t = Math.max(0, Math.min(1, (d - core) / Math.max(0.1, fade)))
          const v = 1 - t * t * (3 - 2 * t)
          const q = Math.round(v * 255)
          const o = j * w + i
          if (q > data[o]) data[o] = q
        }
      }
    }
  }
  let covered = 0
  for (let k = 0; k < data.length; k++) if (data[k] > 0) covered++
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return { tex, box: new THREE.Vector4(box.x0, box.z0, box.x1, box.z1), w, h, covered, segments }
}

/**
 * Give an ordinary lit material the dissolve, the way `makeRetroreflective` gives it the lamps:
 * through `onBeforeCompile`, so the map, the roughness and the environment all keep working.
 */
export function makeSplatFading(mat: THREE.Material, u: SplatMaskUniforms): void {
  if (mat.userData.splatFading) return
  mat.userData.splatFading = true
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    Object.assign(shader.uniforms, u)
    if (!/vSplatWorld/.test(shader.vertexShader)) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSplatWorld;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
  vec4 splatP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    splatP = instanceMatrix * splatP;
  #endif
  vSplatWorld = (modelMatrix * splatP).xyz;`,
        )
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSplatWorld;\n${SPLAT_MASK_PARS}`)
      // before anything is computed: a discarded fragment should cost nothing
      .replace('void main() {', 'void main() {\n  splatDissolve(vSplatWorld);')
  }
  mat.needsUpdate = true
}
