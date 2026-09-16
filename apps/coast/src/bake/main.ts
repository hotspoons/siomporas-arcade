// The bake, run on purpose rather than on a player's first load: `scripts/bake-atlas.mjs` drives
// this page in headless Chromium and writes what it produces into `public/assets/atlas/`.
//
// It is the SAME code the game runs — `SpriteAtlas.bake`, the same lens, the same lights, the same
// cells — with the plan forced rather than chosen from the device, and every shortcut disabled.
// That matters more than it looks: a build step that reimplements the bake is a build step that
// drifts from it, and the drift would show up as sprites that are subtly the wrong size on the
// devices that got the prebake and right on the ones that did not.
//
// This page is deliberately absent from `vite.config.ts`'s rollup inputs, so it is a dev-server
// tool and not something shipped to anyone.

import { WebGLRenderer } from 'three'

import { SpriteAtlas } from '../render/SpriteAtlas'
import { atlasKey } from '../render/AtlasCache'

declare global {
  interface Window {
    __atlas?: { key: string; size: number; cellScale: number; png: string; kinds: unknown[] }
    __atlasError?: string
  }
}

const q = new URLSearchParams(location.search)
const size = Number(q.get('size') ?? 4096)
const cellScale = Number(q.get('cell') ?? 1)

const say = (msg: string) => {
  document.body.textContent = msg
  console.info(msg)
}

async function main() {
  const canvas = document.createElement('canvas')
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true })
  const max = renderer.capabilities.maxTextureSize
  if (size > max) throw new Error(`this GPU caps textures at ${max}px, cannot bake ${size}px`)

  const atlas = new SpriteAtlas()
  await atlas.bake(renderer, false, (done, total) => say(`baking ${done}/${total} at ${size}px ×${cellScale}`), { size, cellScale })

  const rt = atlas.target
  if (!rt) throw new Error('no render target after bake')

  // Read straight out of the render target, bottom-up, which is how both the IndexedDB cache and
  // the prebaked loader expect to find it — hence `texture.flipY = false` at both ends.
  const px = new Uint8Array(size * size * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, px)

  // A blank bake is the failure this is most likely to hit on a software GL stack, and it looks
  // exactly like success from the outside. Sample the alpha before writing anything.
  let ink = 0
  for (let i = 3; i < px.length && ink < 64; i += 4 * 97) if (px[i] > 8) ink++
  if (ink < 8) throw new Error('the bake came back blank — the GPU dropped it')

  const out = document.createElement('canvas')
  out.width = size
  out.height = size
  out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), size, size), 0, 0)

  window.__atlas = {
    key: atlasKey(size, cellScale),
    size,
    cellScale,
    png: out.toDataURL('image/png'),
    kinds: [...atlas.kinds].map(([kind, k]) => [kind, { frames: k.frames, yaws: k.yaws, pitches: k.pitches, extentM: k.extentM, footM: k.footM }]),
  }
  say(`baked ${atlas.kinds.size} kinds at ${size}px ×${cellScale}`)
}

main().catch((err) => {
  window.__atlasError = String(err?.message ?? err)
  say(`bake failed: ${window.__atlasError}`)
})
