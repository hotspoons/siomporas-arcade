// Glass, from the alpha channel the reconstructor already wrote.
//
// Rich, 2026-09-28: "trellis.2 puts alpha information into the voxel cloud, we should not be using
// any chroma-keyed glass which was the original approach, it looks terrible."
//
// He is right, and the evidence is in the files. TRELLIS.2's own README says it:
//
//   "The .glb file is exported in OPAQUE mode by default. Although the alpha channel is preserved
//    within the texture map, it is not active initially. To enable transparency, import the asset
//    into your 3D software and manually connect the texture's alpha channel to the material's
//    opacity or alpha input."
//
// Measured on a reconstruction here: the 2048² base colour texture is TrueColorAlpha, 105,588
// texels at alpha 0 and a mean of 235 — the glazing, exactly where the windows are, straight out
// of the voxel cloud. The finished mesh keeps it too (WebP, alpha min 0). Both declare
// `alphaMode: OPAQUE`, so nothing has ever looked at it.
//
// THE OLD WAY WAS A GUESS. `tools/assetlib/glass.mjs` picked glazing by colour with a height guard
// — "glass bakes dark and desaturated, so luma picks it out" — and it picked the roof, the tyres
// and the sill trim along with it. On one car here it called 29.65% of the triangles glass. That
// approach needs a per-asset key that half the library does not have, and where it has none it
// falls back to the heuristic and reports a number that looks like a result.
//
// TRANSMISSION, NOT BLENDING. Alpha blending would also make the windows see-through, but the
// material covers the WHOLE car: turning it transparent puts the body in the transparent queue and
// every panel then sorts against every other one. Transmission is a separate pass with no sorting,
// it is what glass physically is, and it brings ior and thickness with it. three samples the
// transmission map's RED channel, so the map is the alpha inverted: opaque body → 0, window → 1.
import * as THREE from 'three'

/** What a material has to look like before this touches it. */
const isCandidate = (m: THREE.Material): m is THREE.MeshStandardMaterial =>
  (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
  && !!(m as THREE.MeshStandardMaterial).map
  && !(m as THREE.MeshPhysicalMaterial).transmission

/**
 * The base colour's alpha, as a flat array we can ask about a million times.
 *
 * Sampled down to 512² — the mask is used per TRIANGLE, and a triangle covers many texels, so the
 * extra resolution buys nothing and the readback of a 2048² texture costs 16 MB.
 */
function alphaField(image: TexImageSource): { a: Uint8Array; w: number; h: number } | null {
  const iw = (image as HTMLImageElement).width ?? 0
  const ih = (image as HTMLImageElement).height ?? 0
  if (!iw || !ih) return null
  const w = Math.min(512, iw)
  const h = Math.min(512, ih)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  g.drawImage(image as CanvasImageSource, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h).data
  const a = new Uint8Array(w * h)
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j]
  return { a, w, h }
}

const wrap01 = (v: number) => { const f = v - Math.floor(v); return f < 0 ? f + 1 : f }

export interface GlazingResult {
  /** how many meshes had glass separated out of them */
  glazed: number
  /** the share of each one's TRIANGLES that turned out to be glazing */
  shares: number[]
}

/**
 * Separate the glazing out of every mesh whose texture says where it is.
 *
 * WHY A SPLIT AND NOT A MASK. The first version of this put a transmission MASK on the one
 * material the reconstruction comes with, and it did nothing visible. The mask was right — painted
 * onto the body it lights up the windscreen and nothing else — and transmission was 1, and a bare
 * transmissive material on the same geometry was completely see-through. What killed it was the
 * rest of the material: that single material describes the BODY, so it is `roughness: 1` and
 * `metalness: 1` with maps for both, and a fully rough transmissive surface is frosted to the
 * point of being opaque while a metal has no diffuse for transmission to replace at all.
 *
 * One material cannot be a red metallic body and a smooth clear window. So the triangles part
 * company: those whose texture is transparent become a second group with a real glass material,
 * and the body keeps exactly the material it arrived with.
 *
 * The split is driven by the ALPHA the reconstructor wrote, not by colour. `tools/assetlib/glass.mjs`
 * guessed from luma with a height guard and took the roof and the sill trim with it.
 */
export function applyAlphaGlazing(
  root: THREE.Object3D,
  opts: { minShare?: number; maxShare?: number; ior?: number; thickness?: number; roughness?: number } = {},
): GlazingResult {
  const min = opts.minShare ?? 0.002
  const max = opts.maxShare ?? 0.6
  const out: GlazingResult = { glazed: 0, shares: [] }

  const meshes: THREE.Mesh[] = []
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })

  for (const mesh of meshes) {
    if (Array.isArray(mesh.material)) continue // already split, or authored with groups
    const body = mesh.material
    if (!isCandidate(body)) continue
    const image = body.map?.image as TexImageSource | undefined
    if (!image) continue

    let field: { a: Uint8Array; w: number; h: number } | null = null
    try {
      field = alphaField(image)
    } catch {
      continue // a texture the canvas will not read is one to leave alone
    }
    if (!field) continue

    const geo = mesh.geometry
    const uv = geo.getAttribute('uv')
    const pos = geo.getAttribute('position')
    if (!uv || !pos) continue

    // an index to work with, whether or not the file had one
    let index = geo.getIndex()
    if (!index) {
      const n = pos.count
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n)
      for (let i = 0; i < n; i++) arr[i] = i
      index = new THREE.BufferAttribute(arr, 1)
      geo.setIndex(index)
    }

    /*
     * ONE LOOKUP PER TRIANGLE, at its UV centroid.
     *
     * Per-vertex would leave the triangles that straddle the edge of a window in whichever group
     * their first vertex fell into; the centroid puts a triangle where most of it is, which is
     * what the eye reads. `flipY` is false on these textures, so V is used as it comes.
     */
    const tris = index.count / 3
    const glass: number[] = []
    const rest: number[] = []
    for (let t = 0; t < tris; t++) {
      const a = index.getX(t * 3)
      const b = index.getX(t * 3 + 1)
      const c = index.getX(t * 3 + 2)
      const u = wrap01((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3)
      const v = wrap01((uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3)
      const x = Math.min(field.w - 1, Math.floor(u * field.w))
      const y = Math.min(field.h - 1, Math.floor((1 - v) * field.h))
      ;(field.a[y * field.w + x] < 128 ? glass : rest).push(a, b, c)
    }

    const share = glass.length / (tris * 3)
    if (share < min || share > max) continue

    // body first, then glass: two groups over one reordered index
    const merged = index.array.constructor === Uint32Array ? new Uint32Array(rest.length + glass.length) : new Uint16Array(rest.length + glass.length)
    merged.set(rest, 0)
    merged.set(glass, rest.length)
    geo.setIndex(new THREE.BufferAttribute(merged, 1))
    geo.clearGroups()
    geo.addGroup(0, rest.length, 0)
    geo.addGroup(rest.length, glass.length, 1)

    /*
     * WHAT GLASS IS: smooth, not metal, and carrying none of the body's maps.
     *
     * The painted-on window in the base texture is exactly what this replaces, so keeping the map
     * would tint the refraction with the thing it is there to get rid of. A faint colour and a
     * little roughness, because a perfectly clear pane reads as a hole.
     */
    const glassMat = new THREE.MeshPhysicalMaterial({
      name: `${body.name || 'glass'}-glazing`,
      color: new THREE.Color(0.92, 0.95, 0.96),
      metalness: 0,
      roughness: opts.roughness ?? 0.06,
      transmission: 1,
      ior: opts.ior ?? 1.5,
      thickness: opts.thickness ?? 0.01,
      attenuationColor: new THREE.Color(0.85, 0.9, 0.92),
      attenuationDistance: 0.8,
      // seen from both sides: from inside the car, and through the far pane
      side: THREE.DoubleSide,
      envMapIntensity: 1,
    })

    mesh.material = [body, glassMat]
    out.glazed++
    out.shares.push(+share.toFixed(4))
  }
  return out
}
