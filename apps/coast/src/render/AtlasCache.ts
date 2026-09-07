// Caches the baked sprite atlas (PNG + frame table) in IndexedDB, keyed by a
// hash of the model manifest, so a returning player skips loading 36 models
// and rendering ~80 cells. Any change to models.ts invalidates it.

import { NearestFilter, LinearFilter, SRGBColorSpace, Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import type { SpriteKind } from './SpriteAtlas'
import { ATLAS_SIZE } from './RenderTuning'
import { MODELS } from './models'
import { PROCGEN_VERSION } from './procgen'

const DB = 'apex-coast'
const STORE = 'atlas'
/** Bump when the bake itself changes (lighting, camera, cell layout). */
const BAKE_VERSION = 3

interface CachedAtlas {
  key: string
  png: Blob
  kinds: [string, { def: SpriteKind['def']; frames: SpriteKind['frames']; yaws: number[] }][]
}

export function atlasKey(): string {
  // The manifest fully determines the atlas; `build` functions are identified by kind name.
  const manifest = MODELS.map((m) => `${m.kind}|${m.file}|${m.heightM}|${m.yaws.join(',')}|${m.cell}|${m.fit ?? 1}|${m.build ? 'b' : 'f'}`).join(';')
  let h = 2166136261
  for (let i = 0; i < manifest.length; i++) {
    h ^= manifest.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `v${BAKE_VERSION}.${PROCGEN_VERSION}-${(h >>> 0).toString(16)}-${ATLAS_SIZE}`
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadCachedAtlas(key: string): Promise<{ texture: Texture; kinds: Map<string, SpriteKind> } | null> {
  try {
    const db = await open()
    const rec = await new Promise<CachedAtlas | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get('current')
      req.onsuccess = () => resolve(req.result as CachedAtlas | undefined)
      req.onerror = () => reject(req.error)
    })
    if (!rec || rec.key !== key) return null
    const bitmap = await createImageBitmap(rec.png)
    const texture = new Texture(bitmap)
    // Stored bottom-up straight from the render target, so no flip on the way back in.
    texture.flipY = false
    texture.colorSpace = SRGBColorSpace
    texture.generateMipmaps = false
    texture.needsUpdate = true
    const kinds = new Map<string, SpriteKind>()
    for (const [k, v] of rec.kinds) kinds.set(k, { def: v.def, frames: v.frames, yaws: v.yaws })
    return { texture, kinds }
  } catch (err) {
    console.warn('atlas cache read failed', err)
    return null
  }
}

export async function saveCachedAtlas(key: string, renderer: WebGLRenderer, rt: WebGLRenderTarget, kinds: Map<string, SpriteKind>): Promise<void> {
  try {
    const px = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, ATLAS_SIZE, ATLAS_SIZE, px)
    const canvas = document.createElement('canvas')
    canvas.width = ATLAS_SIZE
    canvas.height = ATLAS_SIZE
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), ATLAS_SIZE, ATLAS_SIZE), 0, 0)
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!png) return
    const rec: CachedAtlas = {
      key,
      png,
      kinds: [...kinds.entries()].map(([k, v]) => [k, { def: { ...v.def, build: undefined }, frames: v.frames, yaws: v.yaws }]),
    }
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(rec, 'current')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('atlas cache write failed', err)
  }
}

export function applyAtlasFilters(texture: Texture, retro: boolean): void {
  texture.minFilter = texture.magFilter = retro ? NearestFilter : LinearFilter
  texture.needsUpdate = true
}
