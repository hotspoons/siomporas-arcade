// Every .glb in this game goes through here, and the reason is Draco.
//
// The generated meshes are Draco-compressed — 83 MB of reconstructions does not fit in a Cloudflare
// Worker bundle and 16 MB does — and a GLTFLoader without a decoder attached does not degrade, it
// throws: "No DRACOLoader instance provided". That happened exactly as expected in the one place I
// had not wired it, the full-3D mode, where every hero livery fell back to its sprite. Three
// callers, three chances to forget; so, one loader.
//
// The decoder sits under `assets/` rather than a `vendor/` of its own because
// `scripts/sync-arcade-assets.mjs` mirrors each game\'s `public/assets` into the arcade and nothing
// else — that is the only path that resolves both at localhost:5182 and at /radrun.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

let draco: DRACOLoader | null = null

/**
 * A GLTFLoader that can read our meshes. `path` is the base every load resolves against — '/' for
 * anything in the game, because in the arcade the game is served at /radrun and a bare
 * "assets/..." would resolve against whatever menu the URL is on.
 */
export function glbLoader(path = '/'): GLTFLoader {
  draco ??= new DRACOLoader().setDecoderPath('/assets/draco/')
  return new GLTFLoader().setPath(path).setDRACOLoader(draco)
}
