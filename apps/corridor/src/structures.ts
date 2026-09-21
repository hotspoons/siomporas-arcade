// Authored structure overrides: what a human says the road does where the lidar could not tell.
//
//   flatten      the grade between two along-track metres is a straight line — the lidar under a
//                bridge, or in a junk-classified project (Bowie's 2014 delivery), is noise
//   suppress     detected structures inside the interval are ignored
//   bridge_over  a catalog asset spans the road at mid-interval, clearance above the pavement,
//                fitted so its long axis is `span_m`, abutments on the ground
//
// Authored in the editor (the editor agent's), saved as structures.json beside the bake, applied
// here BEFORE the spline is built so the strip, the paint, the car and the bridge all agree.
import * as THREE from 'three'
import { DATA_BASE } from './site'
import { fitModel, loadAssetModel, type CatalogEntry } from './placements'

export interface StructureOverride {
  id: string
  name?: string
  kind: 'flatten' | 'suppress' | 'bridge_over'
  s_start: number
  s_end: number
  clearance_m?: number
  asset?: string
  span_m?: number
  yaw_offset_deg?: number
}

export async function loadStructureOverrides(slug: string): Promise<StructureOverride[]> {
  try {
    const r = await fetch(`${DATA_BASE}/sites/${slug}/structures.json`, { cache: 'no-cache' })
    if (r.ok) return ((await r.json()).items ?? []) as StructureOverride[]
  } catch {
    /* none authored */
  }
  return []
}

/**
 * Apply `flatten` to the spine's z BEFORE splining: inside each interval, z is the straight line
 * between the heights at the interval's ends (taken from the un-flattened spine). `coords` are
 * [x, y, z] in the site frame with a cumulative along-track `s` per point.
 */
export function flattenSpine(coords: [number, number, number][], overrides: StructureOverride[]): [number, number, number][] {
  const flats = overrides.filter((o) => o.kind === 'flatten')
  if (!flats.length) return coords
  const s: number[] = [0]
  for (let i = 1; i < coords.length; i++) s.push(s[i - 1] + Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]))
  const zAt = (q: number) => {
    let i = 1
    while (i < s.length - 1 && s[i] < q) i++
    const u = s[i] === s[i - 1] ? 0 : (q - s[i - 1]) / (s[i] - s[i - 1])
    return coords[i - 1][2] * (1 - u) + coords[i][2] * u
  }
  const out = coords.map((c) => [...c] as [number, number, number])
  for (const f of flats) {
    const z0 = zAt(f.s_start), z1 = zAt(f.s_end)
    for (let i = 0; i < out.length; i++) {
      if (s[i] < f.s_start || s[i] > f.s_end) continue
      const u = (s[i] - f.s_start) / Math.max(1e-6, f.s_end - f.s_start)
      out[i][2] = z0 * (1 - u) + z1 * u
    }
  }
  return out
}

export function suppressed<T extends { s_start: number; s_end: number }>(structures: T[], overrides: StructureOverride[]): T[] {
  const sup = overrides.filter((o) => o.kind === 'suppress' || o.kind === 'flatten')
  if (!sup.length) return structures
  return structures.filter((st) => !sup.some((o) => st.s_start >= o.s_start - 1 && st.s_end <= o.s_end + 1))
}

/** Build the bridge_over assets. `spineAt` in world frame; `groundAt` world x,z → y. */
export async function buildBridges(
  overrides: StructureOverride[],
  catalog: Map<string, CatalogEntry>,
  spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 },
  groundAt: (x: number, z: number) => number | null,
  pavedWidthAt: (s: number) => number,
): Promise<THREE.Group> {
  const g = new THREE.Group()
  g.name = 'authored-bridges'
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.9 })
  for (const o of overrides) {
    if (o.kind !== 'bridge_over') continue
    const mid = (o.s_start + o.s_end) / 2
    const at = spineAt(mid)
    const dir = at.dir.clone().setY(0).normalize()
    const span = o.span_m ?? pavedWidthAt(mid) + 6
    const clearance = o.clearance_m ?? 4.5
    const entry = o.asset ? catalog.get(o.asset) : undefined
    const holder = new THREE.Group()
    holder.userData = { override: o }
    const deckY = at.pos.y + clearance
    holder.position.set(at.pos.x, deckY, at.pos.z)
    // long axis across the road. three.js: rotation.y = θ sends local +Z to (sin θ, 0, cos θ) and
    // local +X to (cos θ, 0, -sin θ). With θ = atan2(dir.x, dir.z) local Z runs ALONG the road and
    // local X is the road's left normal — which is exactly where the span (BoxGeometry's X, the
    // fitted model's long axis) must point. The +π/2 that used to be here turned every bridge
    // 90° and laid the abutments across the carriageway as a wall (Rich, 2026-09-21).
    const across = Math.atan2(dir.x, dir.z) + ((o.yaw_offset_deg ?? 0) * Math.PI) / 180
    holder.rotation.y = across
    const axisX = Math.cos(across)
    const axisZ = -Math.sin(across)
    const model = await loadAssetModel(entry)
    const depth = Math.max(2, o.s_end - o.s_start)
    if (model) {
      const fitted = fitModel(model, entry, entry?.height_m ?? 4, span)
      // fitModel puts the base at y=0; a bridge's base is its deck underside, which sits at clearance
      holder.add(fitted)
    } else {
      // no model yet: a slab and two parapets, so the override is visible while the asset is generated
      const slab = new THREE.Mesh(new THREE.BoxGeometry(span, 0.6, depth), concrete)
      slab.position.y = 0.3
      holder.add(slab)
      for (const sgn of [-1, 1]) {
        const par = new THREE.Mesh(new THREE.BoxGeometry(span, 1.2, 0.25), concrete)
        par.position.set(0, 1.2, (sgn * depth) / 2)
        holder.add(par)
      }
    }
    // abutments: from the deck underside down to the ground at each end of the span
    for (const sgn of [-1, 1]) {
      const ex = at.pos.x + axisX * sgn * (span / 2 - 1.0)
      const ez = at.pos.z + axisZ * sgn * (span / 2 - 1.0)
      const gy = groundAt(ex, ez) ?? at.pos.y
      const hgt = Math.max(0.5, deckY - gy)
      const ab = new THREE.Mesh(new THREE.BoxGeometry(2.0, hgt, depth + 1), concrete)
      ab.position.set(ex, gy + hgt / 2, ez)
      ab.rotation.y = across
      g.add(ab)
    }
    g.add(holder)
  }
  return g
}
