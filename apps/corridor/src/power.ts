// Power lines and their poles — the thing a rural roadside actually has most of.
//
// OSM carries `power=line|minor_line` ways and `power=tower|pole|portal` nodes, and the bake now
// emits both (`manifest.power`). Rich's Crofton region has 247 towers and 304 poles in it and we
// were drawing none of them. Two pieces:
//
//   supports  one instanced mesh per kind: a tapered wooden pole with a crossarm, or a lattice
//             tower as a tapered box frame. Instanced, so a thousand of them is two draw calls.
//   wires     a catenary between consecutive supports — the SAG is the whole point. A straight
//             line between two poles reads as a scratch on the sky; the curve is what your eye
//             knows. Sag is a fraction of the span, which is how real conductors are strung.
//
// Where a line has no supports mapped (OSM often has the way and not the towers) the line's own
// vertices are the supports: a wire bends where a pole is.
import * as THREE from 'three'
import type { Manifest } from './site'
import * as T from './tuning'

const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

export interface PowerResult {
  group: THREE.Group
  supports: number
  spans: number
  wireKm: number
}

/** A wooden pole: tapered trunk, one crossarm, three insulator nubs. Built once, instanced. */
function poleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const trunk = new THREE.CylinderGeometry(0.13, 0.19, 1, 6, 1)
  trunk.translate(0, 0.5, 0)
  parts.push(trunk)
  const arm = new THREE.BoxGeometry(0.16, 0.1, 2.1)
  arm.translate(0, 0.9, 0)
  parts.push(arm)
  for (const s of [-1, 0, 1]) {
    const ins = new THREE.CylinderGeometry(0.05, 0.05, 0.16, 5)
    ins.translate(0, 0.98, s * 0.9)
    parts.push(ins)
  }
  return mergeGeometries(parts)
}

/** A lattice tower: four legs narrowing to a waist, two crossarms. Cheap, reads right at distance. */
function towerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
    const leg = new THREE.CylinderGeometry(0.06, 0.1, 1, 4, 1)
    leg.translate(sx * 0.18, 0.5, sz * 0.18)
    parts.push(leg)
  }
  for (const h of [0.62, 0.86]) {
    const arm = new THREE.BoxGeometry(0.12, 0.09, h === 0.62 ? 1.5 : 1.1)
    arm.translate(0, h, 0)
    parts.push(arm)
  }
  return mergeGeometries(parts)
}

/** Merge without pulling in three's addon: same attributes, concatenated. */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  for (const g of list) {
    const gi = g.index
    const gp = g.getAttribute('position') as THREE.BufferAttribute
    const gn = g.getAttribute('normal') as THREE.BufferAttribute
    const base = pos.length / 3
    for (let i = 0; i < gp.count; i++) {
      pos.push(gp.getX(i), gp.getY(i), gp.getZ(i))
      nor.push(gn.getX(i), gn.getY(i), gn.getZ(i))
    }
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i))
    else for (let i = 0; i < gp.count; i++) idx.push(base + i)
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  out.setIndex(idx)
  return out
}

/**
 * Build the poles and the wires.
 *
 * `groundAt` takes world x, z. Supports stand on the ground under them, not on the bake's own
 * sample, so a pole beside the road stands on the road's verge and not two metres under it.
 */
export function buildPower(manifest: Manifest, groundAt: (x: number, z: number) => number | null): PowerResult {
  const group = new THREE.Group()
  group.name = 'power'
  const data = manifest.power
  if (!data || (!data.lines?.length && !data.supports?.length)) return { group, supports: 0, spans: 0, wireKm: 0 }

  const wood = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.95 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x8e9195, roughness: 0.7, metalness: 0.3 })
  const byKind: Record<string, { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; at: { x: number; y: number; z: number; h: number }[] }> = {
    pole: { geo: poleGeometry(), mat: wood, at: [] },
    tower: { geo: towerGeometry(), mat: steel, at: [] },
  }

  const support: { x: number; y: number; z: number; h: number }[] = []
  for (const s of data.supports ?? []) {
    const p = toWorld(s.x, s.y, 0)
    const g = groundAt(p.x, p.z)
    const rec = { x: p.x, y: g ?? s.z, z: p.z, h: (s.height_m || 10) * T.POWER_HEIGHT_SCALE }
    support.push(rec)
    ;(byKind[s.kind === 'tower' || s.kind === 'portal' ? 'tower' : 'pole'] ?? byKind.pole).at.push(rec)
  }

  for (const k of Object.keys(byKind)) {
    const b = byKind[k]
    if (!b.at.length) {
      b.geo.dispose()
      continue
    }
    const mesh = new THREE.InstancedMesh(b.geo, b.mat, b.at.length)
    mesh.name = `power:${k}`
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    b.at.forEach((a, i) => {
      // the geometry is a unit-tall pole: scale Y to the real height, X/Z a little with it
      const w = k === 'tower' ? a.h * 0.28 : 1
      m.compose(new THREE.Vector3(a.x, a.y, a.z), q, new THREE.Vector3(w, a.h, w))
      mesh.setMatrixAt(i, m)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    group.add(mesh)
  }

  // --- the wires ---------------------------------------------------------------------------
  // attach each line's vertices to the nearest support within 25 m; otherwise hang from the
  // vertex itself at the line's nominal height
  const wireMat = new THREE.LineBasicMaterial({ color: 0x23262a, transparent: true, opacity: 0.85 })
  const pts: number[] = []
  let spans = 0
  let wire = 0
  const nearest = (x: number, z: number) => {
    let best: { x: number; y: number; z: number; h: number } | null = null
    let bd = 25 * 25
    for (const s of support) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2
      if (d < bd) { bd = d; best = s }
    }
    return best
  }
  for (const ln of data.lines ?? []) {
    const nominal = ln.kind === 'line' ? 24 : 9.5
    const hang = (c: [number, number, number]) => {
      const p = toWorld(c[0], c[1], 0)
      const s = nearest(p.x, p.z)
      if (s) return new THREE.Vector3(s.x, s.y + s.h * 0.92, s.z)
      const g = groundAt(p.x, p.z) ?? c[2]
      return new THREE.Vector3(p.x, g + nominal * T.POWER_HEIGHT_SCALE, p.z)
    }
    const ends = (ln.coords ?? []).map(hang)
    for (let i = 0; i < ends.length - 1; i++) {
      const a = ends[i], b = ends[i + 1]
      const span = a.distanceTo(b)
      if (span < 1 || span > 600) continue
      spans++
      wire += span
      // catenary, approximated by a parabola: sag is what makes a wire look like a wire
      const sag = Math.min(T.POWER_SAG_MAX, span * T.POWER_SAG)
      const n = Math.max(2, Math.min(12, Math.round(span / 12)))
      for (const off of [-1, 0, 1]) {
        // three conductors, spread along the crossarm's normal
        const dx = b.x - a.x, dz = b.z - a.z
        const L = Math.hypot(dx, dz) || 1
        const ox = (-dz / L) * off * 0.9, oz = (dx / L) * off * 0.9
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n
          for (const tt of [t0, t1]) {
            const y = a.y + (b.y - a.y) * tt - sag * 4 * tt * (1 - tt)
            pts.push(a.x + dx * tt + ox, y, a.z + dz * tt + oz)
          }
        }
      }
    }
  }
  if (pts.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const lines = new THREE.LineSegments(geo, wireMat)
    lines.name = 'power:wires'
    lines.frustumCulled = false
    group.add(lines)
  }
  return { group, supports: support.length, spans, wireKm: Math.round(wire / 100) / 10 }
}
