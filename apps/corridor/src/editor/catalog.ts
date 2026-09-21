// The catalog: what can be put beside the road, and what it looks like before it has a model.
//
// Everything starts as a labelled box at its real footprint and height, because the placement
// that matters is "a 120 x 80 m big-box store sets back 60 m behind a parking lot", and you can
// judge that from boxes. A .glb replaces the box when one exists; the box stays the fallback, so
// the catalog can grow faster than the asset pipeline.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

export interface CatalogEntry {
  id: string
  name: string
  category: string
  glb?: string
  footprint_m: [number, number]
  height_m: number
  /**
   * How a normalised reconstruction is scaled. `height` (default): uniformly to `height_m`.
   * `span`: uniformly so its longest horizontal axis is a span — `footprint_m[0]` when placed
   * free-form, the structure's `span_m` when it is a `bridge_over`. Bridges are laid across the
   * road and it is their length that has to be right, not their height.
   */
  fit?: 'height' | 'span'
}

export interface Catalog {
  assets: CatalogEntry[]
}

/**
 * Category tints, so a plan view of a whole town reads without labels. The vocabulary is the one
 * `autogen.ts` classifies into, so a generated corridor is colour-coded by what the rules decided:
 * residential greens, commercial oranges, industrial violets, civic greys.
 */
const TINT: Record<string, number> = {
  shed: 0x7d8a72,
  house: 0x6fa36a,
  house_large: 0x548f56,
  townhouse: 0x4e8f7a,
  apartments: 0x3f7f8f,
  restaurant: 0xd9683f,
  retail_unit: 0xc4713f,
  strip_mall: 0xb8632f,
  big_box: 0x7a5fb0,
  gas_station: 0xd8b13a,
  hotel: 0x4f7fc4,
  office: 0x5f6fb0,
  warehouse: 0x6a5f8a,
  school: 0xb0b0bd,
  church: 0xcfcfd6,
  barn: 0x8c5a33,
  utility: 0x6f8f7a,
  sign: 0xd94f6e,
  bridge: 0xd98c3f,
}
export const tintOf = (cat: string) => TINT[cat] ?? 0x8a8a8a

const labels = new Map<string, THREE.Texture>()

/** A canvas texture with the asset's name on it; box UVs put it on every face, top included. */
function labelTexture(entry: CatalogEntry): THREE.Texture {
  const got = labels.get(entry.id)
  if (got) return got
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 256
  const g = c.getContext('2d')!
  const col = new THREE.Color(tintOf(entry.category))
  g.fillStyle = `#${col.getHexString()}`
  g.fillRect(0, 0, c.width, c.height)
  g.strokeStyle = 'rgba(0,0,0,0.55)'
  g.lineWidth = 10
  g.strokeRect(5, 5, c.width - 10, c.height - 10)
  g.fillStyle = '#12141a'
  g.textAlign = 'center'
  g.font = 'bold 44px system-ui, sans-serif'
  g.fillText(entry.name, c.width / 2, 120, c.width - 40)
  g.font = '30px ui-monospace, monospace'
  g.fillText(`${entry.footprint_m[0]}×${entry.footprint_m[1]}×${entry.height_m} m`, c.width / 2, 175)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  labels.set(entry.id, tex)
  return tex
}

const tops = new Map<string, THREE.Texture>()

/**
 * The same label for the box's TOP face, turned half a turn.
 *
 * BoxGeometry lays the +Y face out with v running along +Z — which is SOUTH in this world — so
 * seen from the editor's overhead camera, where north is screen-up, the label arrives upside
 * down. The top face is the one face this editor is always looking at, so it gets its own texture.
 */
function topTexture(entry: CatalogEntry): THREE.Texture {
  const got = tops.get(entry.id)
  if (got) return got
  const tex = labelTexture(entry).clone()
  tex.center.set(0.5, 0.5)
  tex.rotation = Math.PI
  tex.needsUpdate = true
  tops.set(entry.id, tex)
  return tex
}

/** The stand-in: a box of the real footprint and height, sitting ON the ground (origin at base). */
export function proxyOf(entry: CatalogEntry): THREE.Object3D {
  const [w, d] = entry.footprint_m
  const side = new THREE.MeshStandardMaterial({ map: labelTexture(entry), roughness: 0.85 })
  const top = new THREE.MeshStandardMaterial({ map: topTexture(entry), roughness: 0.85 })
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, entry.height_m, d),
    // +x, -x, +y, -y, +z, -z
    [side, side, top, side, side, side],
  )
  box.position.y = entry.height_m / 2
  const holder = new THREE.Group()
  holder.add(box)
  return holder
}

/**
 * The catalog's models come out of `tools/assetgen/finish.mjs`, which always Draco-compresses —
 * there is no option not to. A GLTFLoader with no DRACOLoader registered does not warn about
 * that; it rejects, and the caller falls back to a box. Three real models rendered as three
 * labelled boxes for a whole probe cycle over this.
 *
 * The decoder is copied from `three/examples/jsm/libs/draco/gltf/` rather than fetched from a CDN,
 * so the editor keeps working with no network. It lives under a directory called `vendor` because
 * that is what `.oxlintrc.json` already ignores, and half a megabyte of generated wasm wrapper is
 * not code anyone should be linting.
 */
const gltf = new GLTFLoader()
const draco = new DRACOLoader()
draco.setDecoderPath('/assets/vendor/draco/')
gltf.setDRACOLoader(draco)

const models = new Map<string, Promise<THREE.Object3D | null>>()

/**
 * Load a .glb once and hand out clones. A reconstruction comes back in whatever scale the
 * reconstructor felt like, so the model is recentred on its footprint and rescaled to the
 * catalog's `height_m` (or, with `fit: "span"`, so its long axis is `footprint_m[0]`) — the
 * catalog's numbers are the truth, the mesh is a skin over them.
 */
function loadModel(entry: CatalogEntry): Promise<THREE.Object3D | null> {
  if (!entry.glb) return Promise.resolve(null)
  let p = models.get(entry.id)
  if (!p) {
    p = gltf
      .loadAsync(`/${entry.glb.replace(/^\/+/, '')}`)
      .then((g) => {
        const root = g.scene
        const bb = new THREE.Box3().setFromObject(root)
        const size = bb.getSize(new THREE.Vector3())
        const long = Math.max(size.x, size.z)
        const k = entry.fit === 'span' ? (long > 1e-3 ? entry.footprint_m[0] / long : 1) : size.y > 1e-3 ? entry.height_m / size.y : 1
        root.scale.setScalar(k)
        const c = bb.getCenter(new THREE.Vector3()).multiplyScalar(k)
        root.position.set(-c.x, -bb.min.y * k, -c.z)
        const holder = new THREE.Group()
        holder.add(root)
        return holder as THREE.Object3D
      })
      .catch((e: Error) => {
        console.warn(`catalog: ${entry.id} fell back to a box — ${e.message}`)
        return null
      })
    models.set(entry.id, p)
  }
  return p
}

/** The object to put in the scene for this asset: its model if it has one, else its box. */
export async function instanceOf(entry: CatalogEntry): Promise<THREE.Object3D> {
  const m = await loadModel(entry)
  return m ? m.clone(true) : proxyOf(entry)
}

export async function loadCatalog(): Promise<Catalog> {
  const r = await fetch('/assets/catalog.json', { cache: 'no-cache' })
  if (!r.ok) return { assets: [] }
  return (await r.json()) as Catalog
}
