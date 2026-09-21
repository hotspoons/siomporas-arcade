// Draping: a polygon authored in plan has to be seen lying ON the ground, not hovering over the
// valley it crosses. Two meshes per area — an outline and a translucent fill — both built by
// sampling the site's height field, never by projecting a flat shape downward.
//
// The fill is triangulated in 2D and then SUBDIVIDED until no edge is longer than `maxEdge`,
// because a triangle that spans a cutting reads as a lid over it. Subdividing first and lifting
// every vertex afterwards is the cheap way to make a plane follow terrain.
import * as THREE from 'three'

export type HeightAt = (x: number, y: number) => number

const OUTLINE_STEP = 6 // m between draped outline samples
const FILL_EDGE = 24 // m: longest triangle edge the fill tolerates before it splits

/** Resample a closed ring so no segment is longer than `step`, still in the site frame. */
export function densify(poly: [number, number][], step = OUTLINE_STEP): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(len / step))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

/** A closed line lying on the ground `lift` metres up. */
export function outlineMesh(poly: [number, number][], h: HeightAt, color: number, lift = 0.5): THREE.LineLoop {
  const pts = densify(poly).map(([x, y]) => new THREE.Vector3(x, h(x, y) + lift, -y))
  const g = new THREE.BufferGeometry().setFromPoints(pts)
  const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
  const line = new THREE.LineLoop(g, m)
  line.renderOrder = 10
  return line
}

/** Triangulate a ring, split until every edge is short, then lift each vertex onto the ground. */
export function fillMesh(poly: [number, number][], h: HeightAt, color: number, opacity = 0.22, lift = 0.4, maxEdge = FILL_EDGE): THREE.Mesh {
  const verts: [number, number][] = poly.map(([x, y]) => [x, y])
  let tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, y]) => new THREE.Vector2(x, y)), []).map((t) => [...t] as [number, number, number])

  const mid = new Map<string, number>()
  const midpoint = (a: number, b: number) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`
    const got = mid.get(k)
    if (got !== undefined) return got
    const i = verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]) - 1
    mid.set(k, i)
    return i
  }
  const len2 = (a: number, b: number) => (verts[a][0] - verts[b][0]) ** 2 + (verts[a][1] - verts[b][1]) ** 2
  // Split the longest edge of any oversized triangle, repeatedly. Bounded so a pathological
  // polygon (a 6 km band at 24 m) cannot eat the frame: ~200k triangles is already far past
  // anything the eye can tell apart.
  const limit = maxEdge * maxEdge
  for (let pass = 0; pass < 24 && tris.length < 200_000; pass++) {
    let split = false
    const next: [number, number, number][] = []
    for (const [a, b, c] of tris) {
      const e: [number, number, number][] = [[a, b, c], [b, c, a], [c, a, b]]
      e.sort((p, q) => len2(q[0], q[1]) - len2(p[0], p[1]))
      const [p, q, r] = e[0]
      if (len2(p, q) > limit) {
        const m = midpoint(p, q)
        next.push([p, m, r], [m, q, r])
        split = true
      } else next.push([a, b, c])
    }
    tris = next
    if (!split) break
  }

  const pos = new Float32Array(verts.length * 3)
  verts.forEach(([x, y], i) => {
    pos[i * 3] = x
    pos[i * 3 + 1] = h(x, y) + lift
    pos[i * 3 + 2] = -y
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(tris.flat())
  g.computeVertexNormals()
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })
  const mesh = new THREE.Mesh(g, m)
  mesh.renderOrder = 9
  return mesh
}

/** A small sphere the cursor can grab: polygon vertices while drawing and while selected. */
export function handleMesh(color: number, radius = 2.2): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }))
  m.renderOrder = 12
  return m
}
