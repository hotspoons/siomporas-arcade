// The tarmac of a stunt fixture: a ribbon that follows the lane, including upside down.
//
// `stunts.ts` works out WHERE the surface goes and says nothing about geometry; this turns that
// into something you can see and, later, drive on. Kept apart for the usual reason — the placement
// arithmetic is checkable in a test and this is not — and because a headless tool that wants to
// know whether a fixture is connected to the road should not have to load three.
//
// WHY NOT `apps/stuntin/src/render/RoadBuilder.ts`. It builds a far better road than this: curbs,
// pillars under the elevated sections, tube walls through tunnels, bridge parapets over water. But
// it takes STUNTIN's own `Track` — a baked graph of placed pieces, links and lanes on a grid — and
// corridor has one piece standing in a field. Building a synthetic `Track` to satisfy it means
// faking a grid position, a level and a link table for a thing that has none of them. The honest
// options are to extract its ribbon generator so both games share one, or to write the simple
// version here first and find out what is actually missing. This is the second, and the note in
// `docs/corridor/PLAN-RACES-TRAFFIC.md` says so.
//
// THE FRAME IS THE FIDDLY PART. `Pose` is the corridor site frame — x east, y north, z up — and
// three is x east, y UP, z SOUTH. Every vertex crosses that boundary, so the conversion happens in
// exactly one function and nothing else in this file may do it.
//
// AND THE HEIGHT IS ALREADY RIGHT. A `Pose` is absolute — `connectFixture` stands the fixture on
// the ground when it builds the path — so nothing here adds a terrain offset. It used to, which
// lifted the approach curves by the terrain height a SECOND time; consistently enough that the
// whole assembly looked correct while floating thirty metres over a field.

import * as THREE from 'three'
import { ROAD_HALF_WIDTH } from '@apex/stunt-pieces/geometry'
import { fixturePath, tangentOf, type Pose, type StuntFixture } from './stunts'

/** Site frame (x east, y north, z up) to three's (x east, y up, z south). The only place it happens. */
function v3(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y)
}

export interface RibbonOpts {
  /** half the drivable width, metres. Defaults to the vocabulary's own */
  halfWidth?: number
  /** how many samples along a fixture's lane; more is smoother and heavier */
  samples?: number
  colour?: number
  name?: string
  /**
   * The road surface to wear.
   *
   * Rich, 2026-09-29: *"It would be great if they could texture the same as our roads in the game"*.
   * Pass the site's own asphalt material and a loop is made of the same tarmac as the road it
   * joins — which is the whole point, since it REPLACES that road. Left out, a plain dark surface,
   * which is what a headless test and the editor's first draft want.
   *
   * SHARED, NOT CLONED. The material belongs to the surface set and is used by every road quad in
   * the world; cloning it per fixture would double the texture memory for no visible difference,
   * and — worse — a later change of season or of paint would reach the roads and not the loops.
   */
  material?: THREE.Material
  /**
   * STUNTIN's red-and-white kerbs down both edges.
   *
   * Rich: *"with the option to use the stuntin' styles with the red and white rumble strips on the
   * outsides"*. They are not decoration on a stunt piece — on a loop or a corkscrew the kerb is the
   * only thing that tells you where the surface ends while you are upside down, which is why every
   * game that has ever drawn a loop has drawn them.
   */
  kerbs?: boolean
}

/** Kerb geometry: how wide the striped strip is, and how long one red or white block runs. */
const KERB_W = 0.8
const KERB_BLOCK_M = 4
const KERB_LIFT = 0.06

export interface Ribbon {
  group: THREE.Group
  /** the poses it was built from, for a camera, a spline or a collider */
  path: Pose[]
  dispose: () => void
}

/**
 * A ribbon along any run of poses: a fixture's lane, or one of its approach curves.
 *
 * THE UP VECTOR IS NOT A CONVENIENCE, IT IS THE POINT. A loop's surface is inverted at the top, so
 * the sideways direction across the road cannot be "the tangent crossed with world up" — that
 * degenerates exactly where the lane is vertical, which on a loop happens twice, and the ribbon
 * pinches to nothing at both. Every pose carries its own surface normal, so across = tangent ×
 * normal and the road stays the same width the whole way round.
 */
export function buildRibbon(path: Pose[], opts: RibbonOpts = {}): Ribbon {
  const half = opts.halfWidth ?? ROAD_HALF_WIDTH
  const name = opts.name ?? 'stunt-road'
  const group = new THREE.Group()
  group.name = name
  if (path.length < 2) return { group, path, dispose: () => {} }

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const t = new THREE.Vector3()
  const n = new THREE.Vector3()
  const across = new THREE.Vector3()
  const centre = new THREE.Vector3()
  const left = new THREE.Vector3()
  const right = new THREE.Vector3()
  let run = 0

  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    if (i) {
      const q = path[i - 1]
      run += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
    }

    /*
     * THE FULL DIRECTION OF TRAVEL, not its shadow on the map. `dx, dy` is only the tangent while
     * the road is flat; on a loop's climb the two are sixty degrees apart, and `tangent × normal`
     * then gives a cross-section that is not across the road at all — the quads shear into a
     * diagonal ridge up the middle of it. See `Pose.t3`.
     */
    const d3 = tangentOf(p)
    t.set(d3.x, d3.z, -d3.y).normalize()
    const up = p.up ?? { x: 0, y: 0, z: 1 }
    n.set(up.x, up.z, -up.y)
    if (n.lengthSq() < 1e-9) n.set(0, 1, 0)
    n.normalize()
    /*
     * Re-square the normal against the tangent. They are not exactly perpendicular where a piece's
     * path turns sharply, and without this the ribbon's width wobbles through a corkscrew — which
     * reads as the road breathing.
     */
    n.addScaledVector(t, -n.dot(t)).normalize()
    across.crossVectors(t, n).normalize().multiplyScalar(half)

    v3(p.x, p.y, p.z, centre)
    left.copy(centre).sub(across)
    right.copy(centre).add(across)
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z)
    normals.push(n.x, n.y, n.z, n.x, n.y, n.z)
    // v runs in metres, so the surface does not stretch through the slow parts of a lane
    uvs.push(0, run / (half * 2), 1, run / (half * 2))

    if (i) {
      const a = (i - 1) * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setIndex(indices)
  geom.computeBoundingSphere()

  /*
   * THE SITE'S OWN TARMAC WHEN IT IS OFFERED. It is shared with every road quad in the world, so it
   * is NOT disposed with this ribbon — disposing a borrowed material takes the roads with it.
   */
  const borrowed = !!opts.material
  const mat = opts.material ?? new THREE.MeshStandardMaterial({
    color: opts.colour ?? 0x2b2f36,
    roughness: 0.92,
    metalness: 0,
    // VISIBLE FROM UNDERNEATH, because half a loop is seen from its back. A single-sided ribbon
    // vanishes the moment you are past vertical, which looks like the road ending.
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geom, mat)
  mesh.name = name
  mesh.receiveShadow = true
  group.add(mesh)

  const extra: { dispose: () => void }[] = []
  if (opts.kerbs) {
    const k = buildKerbs(path, half, `${name}:kerbs`)
    group.add(k.group)
    extra.push(k)
  }

  return {
    group,
    path,
    dispose: () => {
      geom.dispose()
      if (!borrowed) mat.dispose()
      for (const e of extra) e.dispose()
    },
  }
}

/** The ribbon for one fixture's own lane. */
export function buildStuntMesh(f: StuntFixture, opts: RibbonOpts = {}): Ribbon {
  return buildRibbon(fixturePath(f, opts.samples ?? 160), { ...opts, name: opts.name ?? `stunt:${f.id}` })
}

/**
 * A whole fixture as it is driven: the approach, the stunt, the way out.
 *
 * Three ribbons rather than one, because they have different lifetimes — move the fixture and the
 * links are rebuilt while the lane is not, and re-tuning the tightness rebuilds only the links.
 */
export function buildFixture(
  f: StuntFixture,
  parts: { approach: Pose[]; through: Pose[]; departure: Pose[] },
  opts: RibbonOpts = {},
): Ribbon {
  const group = new THREE.Group()
  group.name = `fixture:${f.id}`
  const made: Ribbon[] = []
  const add = (path: Pose[], name: string) => {
    if (path.length < 2) return
    const r = buildRibbon(path, { ...opts, name })
    made.push(r)
    group.add(r.group)
  }
  add(parts.approach, `approach:${f.id}`)
  add(parts.through, `stunt:${f.id}`)
  add(parts.departure, `departure:${f.id}`)
  return {
    group,
    path: [...parts.approach, ...parts.through, ...parts.departure],
    dispose: () => { for (const r of made) r.dispose() },
  }
}


/* ---- the red and white ------------------------------------------------------------------------ */

/**
 * STUNTIN's kerbs: a striped strip outboard of each edge, alternating red and white.
 *
 * TWO MESHES, NOT A TEXTURE. A stripe texture would need a UV that runs in metres along a surface
 * that loops back over itself, and the seam lands somewhere different on every piece. Alternating
 * QUADS between two materials costs a handful of triangles per block, puts every stripe boundary
 * exactly where the arithmetic says, and cannot smear when the lane turns.
 *
 * OUTBOARD AND SLIGHTLY PROUD. The strip sits beyond the drivable half-width so it never covers the
 * road, and a few centimetres along the surface normal so it does not z-fight with it — the same
 * lift a real kerb has, and for the same visual reason.
 */
function buildKerbs(path: Pose[], half: number, name: string): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group()
  group.name = name
  const red = new THREE.MeshStandardMaterial({ color: 0xc0342b, roughness: 0.85, side: THREE.DoubleSide })
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.85, side: THREE.DoubleSide })

  const t = new THREE.Vector3()
  const n = new THREE.Vector3()
  const across = new THREE.Vector3()
  const c = new THREE.Vector3()

  // one buffer per colour per side; the blocks alternate by distance travelled
  const buckets = [
    { mat: red, pos: [] as number[], idx: [] as number[] },
    { mat: white, pos: [] as number[], idx: [] as number[] },
  ]

  for (const sign of [-1, 1]) {
    let run = 0
    let prev: { inner: THREE.Vector3; outer: THREE.Vector3 } | null = null
    for (let i = 0; i < path.length; i++) {
      const p = path[i]
      if (i) {
        const q = path[i - 1]
        run += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
      }
      // the same full tangent the road surface uses, or the kerbs peel away from their own edges
      const d3 = tangentOf(p)
      t.set(d3.x, d3.z, -d3.y).normalize()
      const up = p.up ?? { x: 0, y: 0, z: 1 }
      n.set(up.x, up.z, -up.y)
      if (n.lengthSq() < 1e-9) n.set(0, 1, 0)
      n.normalize().addScaledVector(t, -n.dot(t)).normalize()
      across.crossVectors(t, n).normalize()
      c.set(p.x, p.z, -p.y).addScaledVector(n, KERB_LIFT)
      const inner = c.clone().addScaledVector(across, sign * half)
      const outer = c.clone().addScaledVector(across, sign * (half + KERB_W))
      if (prev) {
        const b = buckets[Math.floor(run / KERB_BLOCK_M) % 2]
        const k = b.pos.length / 3
        b.pos.push(prev.inner.x, prev.inner.y, prev.inner.z, prev.outer.x, prev.outer.y, prev.outer.z,
          inner.x, inner.y, inner.z, outer.x, outer.y, outer.z)
        b.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
      }
      prev = { inner, outer }
    }
  }

  const made: THREE.BufferGeometry[] = []
  for (const b of buckets) {
    if (!b.idx.length) continue
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
    g.setIndex(b.idx)
    g.computeVertexNormals()
    g.computeBoundingSphere()
    made.push(g)
    group.add(new THREE.Mesh(g, b.mat))
  }
  return {
    group,
    dispose: () => {
      for (const g of made) g.dispose()
      red.dispose()
      white.dispose()
    },
  }
}
