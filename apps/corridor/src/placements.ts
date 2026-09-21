// Placed assets: what the editor put in the world (placements.json + the catalog), rendered in
// the viewer. A catalog entry with a glb loads it; without one it is a labelled box of the
// entry's footprint and height, so the layout reads before any model exists. Snap-to-ground
// items take the strip/DEM height at their position.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { DATA_BASE } from './site'

export interface Placement {
  id: string
  asset: string
  x: number
  y: number
  z: number | null
  yaw_deg: number
  scale: number
  snap?: string
  tags?: string[]
}

export interface CatalogEntry {
  id: string
  name: string
  category: string
  glb?: string | null
  footprint_m: [number, number]
  height_m: number
}

// tools/assetgen/finish.mjs always Draco-compresses; without a decoder GLTFLoader rejects silently
// and every real model would fall back to a box. The decoder is vendored by the editor agent.
const draco = new DRACOLoader()
draco.setDecoderPath('/assets/vendor/draco/')
const loader = new GLTFLoader()
loader.setDRACOLoader(draco)
const glbCache = new Map<string, Promise<THREE.Group>>()

function label(text: string, w: number): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.fillStyle = 'rgba(16,18,24,0.8)'
  ctx.fillRect(0, 0, 512, 128)
  ctx.fillStyle = '#ffdc00'
  ctx.font = 'bold 56px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text.slice(0, 18), 256, 64)
  const t = new THREE.CanvasTexture(c)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true }))
  s.scale.set(Math.max(6, w * 0.8), Math.max(1.5, w * 0.2), 1)
  return s
}

export async function loadCatalog(): Promise<Map<string, CatalogEntry>> {
  const m = new Map<string, CatalogEntry>()
  try {
    const r = await fetch('/assets/catalog.json', { cache: 'no-cache' })
    if (r.ok) for (const e of ((await r.json()).assets ?? []) as CatalogEntry[]) m.set(e.id, e)
  } catch {
    /* no catalog yet */
  }
  return m
}

export async function loadPlacements(slug: string): Promise<Placement[]> {
  try {
    const r = await fetch(`${DATA_BASE}/sites/${slug}/placements.json`, { cache: 'no-cache' })
    if (r.ok) return ((await r.json()).items ?? []) as Placement[]
  } catch {
    /* none */
  }
  return []
}

/** Build the placed objects. `groundAt` is world x,z → y. */
export async function buildPlacements(items: Placement[], catalog: Map<string, CatalogEntry>, groundAt: (x: number, z: number) => number | null): Promise<THREE.Group> {
  const g = new THREE.Group()
  g.name = 'placements'
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a3, roughness: 0.9 })
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x6b4a3a, roughness: 0.9 })
  for (const it of items) {
    const entry = catalog.get(it.asset)
    const wz = -it.y
    const y = it.z ?? groundAt(it.x, wz) ?? 0
    const holder = new THREE.Group()
    holder.position.set(it.x, y, wz)
    holder.rotation.y = -(it.yaw_deg * Math.PI) / 180
    holder.scale.setScalar(it.scale || 1)
    holder.userData = { placement: it, entry }
    const [fw, fl] = entry?.footprint_m ?? [10, 10]
    const h = entry?.height_m ?? 5
    if (entry?.glb) {
      const url = `/${entry.glb.replace(/^\//, '')}`
      let p = glbCache.get(url)
      if (!p) {
        p = loader.loadAsync(url).then((gltf) => gltf.scene)
        glbCache.set(url, p)
      }
      try {
        // TRELLIS reconstructions come normalised to a ~1 m cube with no real scale; fit the model
        // to the catalog's height (uniform) and set its base on the ground
        const model = (await p).clone(true)
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const k = size.y > 1e-6 ? h / size.y : 1
        model.scale.setScalar(k)
        model.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k)
        holder.add(model)
      } catch (e) {
        console.warn(`placement ${it.id}: ${url} failed to load, drawing a box`, e)
        holder.add(new THREE.Mesh(new THREE.BoxGeometry(fw, h, fl), boxMat).translateY(h / 2))
      }
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(fw, h * 0.85, fl), boxMat)
      body.position.y = (h * 0.85) / 2
      const roof = new THREE.Mesh(new THREE.BoxGeometry(fw * 1.04, h * 0.15, fl * 1.04), roofMat)
      roof.position.y = h * 0.85 + (h * 0.15) / 2
      holder.add(body, roof)
    }
    const tag = label(entry?.name ?? it.asset, Math.max(fw, fl))
    tag.position.y = h + 2
    holder.add(tag)
    g.add(holder)
  }
  return g
}
