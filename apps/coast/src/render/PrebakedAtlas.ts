// The atlas, baked at build time and shipped, instead of baked on the player's first load.
//
// WHY. The bake reads every model in the manifest — and since the roadside became reconstructions
// rather than Kenney kits, that manifest is tens of megabytes of .glb. All of it is downloaded,
// parsed and rendered into one 4096px texture before the first frame, and then thrown away: nothing
// after the bake ever looks at a mesh again. Shipping the texture instead skips the whole of that.
// The meshes stay in the repository and stay served — `models.html` loads them on demand, and the
// runtime bake below still needs them — they are simply no longer on the path into the game.
//
// THE RUNTIME BAKE IS STILL THERE, and this is deliberate rather than timid. `atlasPlan` chooses a
// size from the device: the GPU's `maxTextureSize`, a smaller atlas on a low-memory touch device,
// and `?atlas=N` for pinning down a machine that renders sprites wrongly. A prebake is one file per
// plan, so a device that lands on a plan nobody baked — or a developer who has just edited
// `models.ts` and whose manifest hash therefore matches nothing on disk — falls through to baking
// for itself. A stale prebake cannot be served by accident either: the key carries the manifest
// hash, so a changed manifest simply 404s and the fallback takes over.
//
// The key is the same one the IndexedDB cache uses, which is why this is checked FIRST: on a repeat
// visit either would do, but on a first visit only this one exists.

import { SRGBColorSpace, Texture } from 'three'

import { MODEL_BY_KIND } from './models'
import type { SpriteFrame, SpriteKind } from './SpriteAtlas'

/** Where `scripts/bake-atlas.mjs` writes, under the game's own public/ so the arcade mirrors it. */
export const ATLAS_DIR = '/assets/atlas'

interface PrebakedKind {
  frames: SpriteFrame[]
  yaws: number[]
  pitches: number[]
  /** Measured extents about the footprint origin; see `SpriteKind.extentM` and `footM`. */
  extentM?: { x: number; z: number }
  footM?: { x: number; z: number }
}

export interface PrebakedAtlas {
  key: string
  size: number
  cellScale: number
  /** Kind name to its frames. `def` is NOT stored: it is the manifest, which is already in the app. */
  kinds: [string, PrebakedKind][]
}

export async function loadPrebakedAtlas(key: string): Promise<{ texture: Texture; kinds: Map<string, SpriteKind> } | null> {
  try {
    const meta = await fetch(`${ATLAS_DIR}/${key}.json`)
    // A dev server answers a missing file with index.html and a 200, so `ok` is not enough: parsing
    // that as JSON throws, and an atlas nobody has baked yet is the ordinary case, not a fault.
    if (!meta.ok || !meta.headers.get('content-type')?.includes('json')) return null
    const rec = (await meta.json()) as PrebakedAtlas
    const img = await fetch(`${ATLAS_DIR}/${key}.png`)
    if (!img.ok) return null

    const bitmap = await createImageBitmap(await img.blob())
    const texture = new Texture(bitmap)
    // Written bottom-up, straight out of the render target, exactly as the IndexedDB cache stores
    // it — so it goes back in the same way round and needs no flip.
    texture.flipY = false
    texture.colorSpace = SRGBColorSpace
    texture.generateMipmaps = false
    texture.needsUpdate = true

    const kinds = new Map<string, SpriteKind>()
    for (const [kind, v] of rec.kinds) {
      const def = MODEL_BY_KIND[kind]
      // A kind in the file that the manifest no longer has means the two have drifted apart despite
      // the hash. Refuse the whole atlas rather than render a world with holes in it.
      if (!def) return null
      kinds.set(kind, { def, frames: v.frames, yaws: v.yaws, pitches: v.pitches, extentM: v.extentM ?? { x: 0, z: 0 }, footM: v.footM ?? { x: 0, z: 0 } })
    }
    return { texture, kinds }
  } catch (err) {
    console.warn('prebaked atlas unavailable, baking instead', err)
    return null
  }
}
