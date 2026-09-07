// Chunked, pooled tunnel geometry. Each chunk is CHUNK_LENGTH metres of rings
// swept along the track frames. A rolling window of chunks ahead/behind the
// craft is kept resident; chunks that leave the window are rewritten in place
// (same BufferAttributes, needsUpdate) for whichever chunk enters. Split
// branches get their own chunks over the split's range.

import { BufferAttribute, BufferGeometry, Mesh, Object3D, ShaderMaterial } from 'three'
import { angleDelta } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import { Track } from '../../sim/track/Track'
import { makeFrame } from '../../sim/track/TrackSpline'
import { hasSurface } from '../../sim/track/TrackProfile'
import { CHUNKS_AHEAD, CHUNKS_BEHIND, CHUNK_LENGTH, RING_SEGMENTS_MODERN, RING_SPACING } from '../RenderTuning'

const RINGS_PER_CHUNK = Math.round(CHUNK_LENGTH / RING_SPACING) + 1
const MAX_SEGMENTS = RING_SEGMENTS_MODERN
const VERTS_PER_RING = MAX_SEGMENTS + 1
const VERTS_PER_CHUNK = RINGS_PER_CHUNK * VERTS_PER_RING
const INDICES_PER_CHUNK = (RINGS_PER_CHUNK - 1) * MAX_SEGMENTS * 6
/** Enough for the trunk window plus a full branch window. */
const POOL_SIZE = (CHUNKS_AHEAD + CHUNKS_BEHIND + 1) * 2

class Chunk {
  key = -1
  readonly geometry = new BufferGeometry()
  readonly mesh: Mesh
  readonly position: BufferAttribute
  readonly normal: BufferAttribute
  readonly uv: BufferAttribute
  readonly track: BufferAttribute
  readonly index: BufferAttribute

  constructor(material: ShaderMaterial) {
    this.position = new BufferAttribute(new Float32Array(VERTS_PER_CHUNK * 3), 3)
    this.normal = new BufferAttribute(new Float32Array(VERTS_PER_CHUNK * 3), 3)
    this.uv = new BufferAttribute(new Float32Array(VERTS_PER_CHUNK * 2), 2)
    this.track = new BufferAttribute(new Float32Array(VERTS_PER_CHUNK * 4), 4)
    this.index = new BufferAttribute(new Uint32Array(INDICES_PER_CHUNK), 1)
    this.geometry.setAttribute('position', this.position)
    this.geometry.setAttribute('normal', this.normal)
    this.geometry.setAttribute('uv', this.uv)
    this.geometry.setAttribute('aTrack', this.track)
    this.geometry.setIndex(this.index)
    this.mesh = new Mesh(this.geometry, material)
    // Chunks are big and always partly on screen; culling them costs more than drawing.
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }
}

export class TunnelMeshPool {
  readonly root = new Object3D()
  segments = RING_SEGMENTS_MODERN
  private readonly chunks: Chunk[] = []
  private readonly byKey = new Map<number, Chunk>()
  private readonly wanted = new Set<number>()
  private track: Track
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  /** Chunk count drawn last update, for the perf overlay. */
  visibleChunks = 0

  constructor(track: Track, material: ShaderMaterial) {
    this.track = track
    for (let i = 0; i < POOL_SIZE; i++) {
      const c = new Chunk(material)
      this.chunks.push(c)
      this.root.add(c.mesh)
    }
  }

  setTrack(track: Track): void {
    this.track = track
    this.invalidate()
  }

  /** Force every chunk to rebuild (ring count or track changed). */
  invalidate(): void {
    for (const c of this.chunks) {
      c.key = -1
      c.mesh.visible = false
    }
    this.byKey.clear()
  }

  setSegments(n: number): void {
    if (n === this.segments) return
    this.segments = Math.min(MAX_SEGMENTS, Math.max(4, n))
    this.invalidate()
  }

  /** Ensure the window around arc length `s` is resident. */
  update(s: number): void {
    const track = this.track
    const centre = Math.floor(s / CHUNK_LENGTH)
    const wanted = this.wanted
    wanted.clear()
    for (let i = centre - CHUNKS_BEHIND; i <= centre + CHUNKS_AHEAD; i++) {
      if (i < 0) continue
      const sStart = i * CHUNK_LENGTH
      if (sStart > track.length) break
      wanted.add(keyFor(0, i))
      // Branch chunks wherever the trunk chunk overlaps a split.
      const split = track.splitAt(sStart + 1) ?? track.splitAt(sStart + CHUNK_LENGTH - 1)
      if (split) wanted.add(keyFor(1, i))
    }
    // Release chunks that fell out of the window.
    for (const c of this.chunks) {
      if (c.key >= 0 && !wanted.has(c.key)) {
        this.byKey.delete(c.key)
        c.key = -1
        c.mesh.visible = false
      }
    }
    // Fill the gaps.
    let count = 0
    for (const key of wanted) {
      let c = this.byKey.get(key)
      if (!c) {
        c = this.chunks.find((x) => x.key < 0)
        if (!c) break // pool exhausted; skip rather than allocate
        this.build(c, key)
        this.byKey.set(key, c)
      }
      if (c.mesh.visible) count++
    }
    this.visibleChunks = count
  }

  private build(c: Chunk, key: number): void {
    const branch = key >= 1_000_000 ? 1 : 0
    const chunkIndex = key % 1_000_000
    const track = this.track
    const segs = this.segments
    const pos = c.position.array as Float32Array
    const nor = c.normal.array as Float32Array
    const uv = c.uv.array as Float32Array
    const tr = c.track.array as Float32Array
    const idx = c.index.array as Uint32Array
    const f = this.frame
    const radial = this.vA
    const p = this.vB
    const boosts = track.boosts
    let anyVisible = false

    for (let r = 0; r < RINGS_PER_CHUNK; r++) {
      const s = chunkIndex * CHUNK_LENGTH + r * RING_SPACING
      track.frameAt(s, branch, f)
      const arc = f.arc
      const visible = hasSurface(arc) ? 1 : 0
      if (visible) anyVisible = true
      const full = arc >= Math.PI - 1e-3
      // Boost strips covering this s.
      let bLo = -1
      let bHi = -1
      for (let b = 0; b < boosts.length; b++) {
        if (boosts[b].sStart > s) break
        if (boosts[b].sEnd >= s) {
          if (bLo < 0) bLo = b
          bHi = b
        }
      }
      for (let k = 0; k < VERTS_PER_RING; k++) {
        const vi = r * VERTS_PER_RING + k
        const t = k / segs
        const kk = Math.min(k, segs) // verts beyond `segs` collapse onto the seam
        const theta = full ? -Math.PI + (kk / segs) * 2 * Math.PI : -arc + (kk / segs) * 2 * arc
        Track.radial(f, theta, radial)
        p.copy(f.pos).addScaled(radial, f.radius)
        pos[vi * 3] = p.x
        pos[vi * 3 + 1] = p.y
        pos[vi * 3 + 2] = p.z
        nor[vi * 3] = -radial.x
        nor[vi * 3 + 1] = -radial.y
        nor[vi * 3 + 2] = -radial.z
        uv[vi * 2] = full ? t : theta / (2 * Math.PI)
        uv[vi * 2 + 1] = s
        let boost = 0
        if (bLo >= 0 && visible) {
          for (let b = bLo; b <= bHi; b++) {
            const st = boosts[b]
            if (s >= st.sStart && s <= st.sEnd && Math.abs(angleDelta(st.theta, theta)) <= st.halfWidth) {
              boost = 1
              break
            }
          }
        }
        tr[vi * 4] = s
        tr[vi * 4 + 1] = full ? 100 : (arc - Math.abs(theta)) * f.radius
        tr[vi * 4 + 2] = boost
        tr[vi * 4 + 3] = visible
      }
    }
    // Index: quads between rings; only `segs` columns are real.
    let n = 0
    for (let r = 0; r < RINGS_PER_CHUNK - 1; r++) {
      for (let k = 0; k < MAX_SEGMENTS; k++) {
        const a = r * VERTS_PER_RING + k
        const b = a + 1
        const cIdx = a + VERTS_PER_RING
        const d = cIdx + 1
        if (k < segs) {
          idx[n++] = a
          idx[n++] = cIdx
          idx[n++] = b
          idx[n++] = b
          idx[n++] = cIdx
          idx[n++] = d
        } else {
          // Degenerate triangles for unused columns keep the index count fixed.
          idx[n++] = a
          idx[n++] = a
          idx[n++] = a
          idx[n++] = a
          idx[n++] = a
          idx[n++] = a
        }
      }
    }
    c.position.needsUpdate = true
    c.normal.needsUpdate = true
    c.uv.needsUpdate = true
    c.track.needsUpdate = true
    c.index.needsUpdate = true
    c.key = key
    c.mesh.visible = anyVisible
  }

  dispose(): void {
    for (const c of this.chunks) c.geometry.dispose()
  }
}

function keyFor(branch: number, chunkIndex: number): number {
  return branch * 1_000_000 + chunkIndex
}
