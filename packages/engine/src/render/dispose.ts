// Giving a scene's GPU memory back.
//
// `renderer.dispose()` plus `forceContextLoss()` frees everything the driver is holding, so
// strictly this walk is belt and braces. It earns its place anyway: it also drops the CPU-side
// typed arrays hanging off every BufferGeometry, which are frequently the larger half of a track
// or a sprite atlas, and it makes a leak visible in a heap snapshot as a retained Scene rather
// than as an anonymous forest of Float32Arrays.

import type { Material, Object3D, Texture } from 'three'

function disposeMaterial(material: Material): void {
  // Every texture-ish property a material can carry, whatever its type.
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    const tex = value as Texture | null
    if (tex && typeof tex === 'object' && (tex as { isTexture?: boolean }).isTexture) tex.dispose()
  }
  material.dispose()
}

/** Dispose every geometry, material and texture under `root`, and empty it. */
export function disposeObject3D(root: Object3D): void {
  root.traverse((obj) => {
    const o = obj as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] }
    o.geometry?.dispose()
    if (Array.isArray(o.material)) for (const m of o.material) disposeMaterial(m)
    else if (o.material) disposeMaterial(o.material)
  })
  root.clear()
}
