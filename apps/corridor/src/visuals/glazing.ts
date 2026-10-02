// Glass, by using the alpha channel as alpha.
//
// Rich, 2026-09-28: "trellis.2 puts alpha information into the voxel cloud, we should not be using
// any chroma-keyed glass which was the original approach, it looks terrible." And TRELLIS.2's own
// README, which is the whole of the method:
//
//   "The .glb file is exported in OPAQUE mode by default. Although the alpha channel is preserved
//    within the texture map, it is not active initially. To enable transparency, import the asset
//    into your 3D software and manually connect the texture's alpha channel to the material's
//    opacity or alpha input."
//
// THERE IS NO CLASSIFIER HERE, AND THAT IS THE POINT. Two earlier attempts tried to work out which
// texels were glass — the first from colour with a height guard (`tools/assetlib/glass.mjs`: it
// called 29.65% of one car's triangles glass, the roof included), the second from a threshold on
// the alpha plus a blob filter. Both were wrong the same way: that alpha is the reconstruction's
// OPACITY, not a window mask. It is low wherever the model is see-through AND wherever the field
// was thin or uncertain — a vent slot, a wheel-arch gap, a spoiler edge. No threshold separates
// "glass" from "unsure", and every constant added to make one asset right made another wrong: at
// `alpha < 224` a 911's rear fender came out as cut glass while its windows stayed black.
//
// Used as opacity it is right in all of those cases without deciding anything. A half-alpha window
// is half see-through; a thin vent is partly see-through; and a bus whose windows reconstructed as
// solid black paint at full opacity stays painted, which is the honest answer — that asset needs
// regenerating, not a cleverer reader of it.
//
// WHY THE BODY DOES NOT GO TRANSPARENT TOO. One material covers the whole car, so this puts all of
// it in the transparent queue — but the body's texels are alpha 1: they write depth and render
// solid. Only the texels that are actually transparent blend, which is what the file says.
import * as THREE from 'three'

/** Only a lit material with a base colour texture can have this done to it. */
const isCandidate = (m: THREE.Material): m is THREE.MeshStandardMaterial =>
  (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
  && !!(m as THREE.MeshStandardMaterial).map
  && m.transparent !== true

/**
 * How much of this texture is see-through?
 *
 * The one thing worth asking, because putting a fully opaque asset in the sorted queue costs
 * something and buys nothing. Sampled on a grid rather than counted: a 2048² texture is four
 * million texels and a coarse grid gives the same answer.
 */
function clearShare(image: TexImageSource): number {
  const w = (image as HTMLImageElement).width ?? 0
  const h = (image as HTMLImageElement).height ?? 0
  if (!w || !h) return 0
  const step = Math.max(1, Math.floor(Math.min(w, h) / 128))
  const cw = Math.max(1, Math.floor(w / step))
  const ch = Math.max(1, Math.floor(h / step))
  const c = document.createElement('canvas')
  c.width = cw
  c.height = ch
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) return 0
  g.drawImage(image as CanvasImageSource, 0, 0, cw, ch)
  const d = g.getImageData(0, 0, cw, ch).data
  let clear = 0
  // 224 is where the opaque mode starts on every asset measured here; below it a texel lets
  // something through, however little
  for (let i = 3; i < d.length; i += 4) if (d[i] < 224) clear++
  return clear / (d.length / 4)
}

export interface GlazingResult {
  /** how many materials were switched to using their alpha */
  glazed: number
  /** the share of each one's texture that is see-through, for a panel to report */
  shares: number[]
}

/**
 * Let every material that has transparency in its texture actually use it.
 *
 * Call it on a loaded glTF scene, once; idempotent, since a material already marked transparent is
 * left alone. `minShare` is the only number in here and it is not a classifier: below it there is
 * nothing to see and the sort is not worth paying for.
 */
export function applyAlphaGlazing(root: THREE.Object3D, opts: { minShare?: number } = {}): GlazingResult {
  const min = opts.minShare ?? 0.002
  const out: GlazingResult = { glazed: 0, shares: [] }
  const seen = new Set<THREE.Material>()

  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(m) || !isCandidate(m)) continue
      seen.add(m)
      const image = m.map?.image as TexImageSource | undefined
      if (!image) continue
      let share = 0
      try {
        share = clearShare(image)
      } catch {
        continue // a texture the canvas will not read is one to leave alone
      }
      if (share < min) continue

      m.transparent = true
      /*
       * DEPTH IS STILL WRITTEN. The usual reason to turn `depthWrite` off for a transparent
       * material is that it is transparent all over; this one is a car body with windows in it,
       * and its opaque texels have to occlude what is behind them or the far side of the shell
       * draws through the near side.
       */
      m.depthWrite = true
      /*
       * AND BOTH SIDES, so a windscreen shows the inside of the car rather than nothing. A
       * reconstruction is a shell with no interior, so what you see through the glass is the
       * inside of the far panels — which is what a dark cabin looks like.
       */
      m.side = THREE.DoubleSide
      m.needsUpdate = true
      out.glazed++
      out.shares.push(+share.toFixed(4))
    }
  })
  return out
}
