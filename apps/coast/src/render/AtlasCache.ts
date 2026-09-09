// Caches the baked sprite atlas (PNG + frame table) in IndexedDB, keyed by a
// hash of the model manifest, so a returning player skips loading 36 models
// and rendering ~80 cells. Any change to models.ts invalidates it.

import { NearestFilter, LinearFilter, SRGBColorSpace, Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import { DEFAULT_PITCH, type SpriteKind } from './SpriteAtlas'

import { MODELS } from './models'
import { PROCGEN_VERSION } from './procgen'

const DB = 'apex-coast'
const STORE = 'atlas'
/** Bump when the bake itself changes (lighting, camera, cell layout). */
const BAKE_VERSION = 6

interface CachedAtlas {
  key: string
  png: Blob
  kinds: [string, { def: SpriteKind['def']; frames: SpriteKind['frames']; yaws: number[]; pitches?: number[] }][]
}

/**
 * Vite swaps modules under a running page, and the atlas is baked once at startup: edit the car's
 * geometry or the bake camera mid-session and the page can end up baking half-new models with
 * half-old frame maths, then storing the result under the *new* key — a poisoned cache that survives
 * every reload until site data is cleared. So once anything has hot-updated, this session neither
 * trusts nor writes the cache.
 */
let hotDirty = false
if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', () => { hotDirty = true })

export function atlasKey(size: number, cellScale: number): string {
  // The manifest fully determines the atlas; `build` functions are identified by kind name.
  const manifest = MODELS.map((m) => `${m.kind}|${m.file}|${m.heightM}|${m.yaws.join(',')}|${(m.pitches ?? []).join(',')}|${m.cell}|${m.fit ?? 1}|${m.build ? 'b' : 'f'}`).join(';')
  let h = 2166136261
  for (let i = 0; i < manifest.length; i++) {
    h ^= manifest.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `v${BAKE_VERSION}.${PROCGEN_VERSION}-${(h >>> 0).toString(16)}-${size}x${cellScale}`
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
  if (hotDirty) return null
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
    for (const [k, v] of rec.kinds) kinds.set(k, { def: v.def, frames: v.frames, yaws: v.yaws, pitches: v.pitches ?? [DEFAULT_PITCH] })
    return { texture, kinds }
  } catch (err) {
    console.warn('atlas cache read failed', err)
    return null
  }
}

export async function saveCachedAtlas(key: string, renderer: WebGLRenderer, rt: WebGLRenderTarget, kinds: Map<string, SpriteKind>, size: number): Promise<void> {
  if (hotDirty) {
    console.info('[atlas] not caching a bake from a hot-updated session')
    return
  }
  try {
    const px = new Uint8Array(size * size * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px)
    // An atlas that came back empty is a bake the GPU dropped. Storing it would serve black sprites
    // from the cache on every later load, which is far worse than baking again.
    let ink = 0
    for (let i = 3; i < px.length && ink < 64; i += 4 * 97) if (px[i] > 8) ink++
    if (ink < 8) {
      console.warn('atlas cache: the bake came back blank, not caching it')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), size, size), 0, 0)
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!png) return
    const rec: CachedAtlas = {
      key,
      png,
      kinds: [...kinds.entries()].map(([k, v]) => [k, { def: { ...v.def, build: undefined }, frames: v.frames, yaws: v.yaws, pitches: v.pitches }]),
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
