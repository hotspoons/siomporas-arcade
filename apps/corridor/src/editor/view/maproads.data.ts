// The map's road classes and the bucketing of every road into merged, culled segment lists.
//
// PURE — no DOM, no three — so the worker that reads `context.json` and the main thread that reads
// a manifest's own branches share one definition, and a test can hold it.
//
// THREE TIERS, because the ask was three zooms. Rich, 2026-10-10: *"We need to make sure we have
// major roads listed at high level overview zooms, and then have overlays showing secondary roads
// when zoomed in at z14 level."* Tier 0 is drawn at every zoom; tier 1 from the z14 pixel down;
// tier 2 (service roads and tracks — car parks, alleys, farm lanes; a third of dc-metro's
// vertices) only once a street is a few pixels wide. The thresholds are in maproads.ts.
//
// A BUCKET IS ONE DRAW. Tier 0 is a single bucket for the whole world — about 50 k segments on
// dc-metro, cheap to draw every frame and never culled away at overview. Tiers 1 and 2 are cut
// into square cells so the frustum drops what is off screen and a cell is only built (heights
// sampled, buffers uploaded) the first time it is wanted.

export interface RoadStyle {
  /** OSM highway values drawn with this style */
  cls: string[]
  /** fill, CSS hex */
  colour: string
  /** fill width, CSS pixels */
  width: number
  tier: 0 | 1 | 2
  /** label priority, 0 first */
  rank: number
}

/**
 * Colours are the minimap's (game/move/minimap.worker.ts `CLASS_STYLE`) — one palette for the roads
 * in this project — a touch wider, because these sit on aerial imagery rather than a flat ground.
 */
export const ROAD_STYLES: RoadStyle[] = [
  { cls: ['motorway'], colour: '#ffb648', width: 4.5, tier: 0, rank: 0 },
  { cls: ['trunk'], colour: '#ffd07a', width: 4, tier: 0, rank: 1 },
  { cls: ['primary'], colour: '#ffe8a8', width: 3.5, tier: 0, rank: 2 },
  { cls: ['motorway_link', 'trunk_link', 'primary_link'], colour: '#ffc46a', width: 2.5, tier: 0, rank: 8 },
  { cls: ['secondary'], colour: '#ffffff', width: 3, tier: 1, rank: 3 },
  { cls: ['tertiary'], colour: '#f2f2f2', width: 2.5, tier: 1, rank: 4 },
  { cls: ['secondary_link', 'tertiary_link'], colour: '#e8e8e8', width: 2, tier: 1, rank: 8 },
  { cls: ['residential', 'unclassified', 'living_street', 'road'], colour: '#dcdcdc', width: 2, tier: 1, rank: 5 },
  { cls: ['service'], colour: '#b4b4b4', width: 1.5, tier: 2, rank: 6 },
  { cls: ['track'], colour: '#b49a6a', width: 1.5, tier: 2, rank: 7 },
]

const STYLE_BY_CLASS = new Map<string, number>()
ROAD_STYLES.forEach((s, i) => { for (const c of s.cls) STYLE_BY_CLASS.set(c, i) })

/** the style index for an OSM highway value, or -1 for something the map does not draw */
export const styleOf = (cls: string | null | undefined): number => STYLE_BY_CLASS.get(cls ?? '') ?? -1

/** metres between label anchors along a named road, per tier */
export const LABEL_SPACING_M = [1500, 380, 160]
/** a named road shorter than this gets no label: a 12 m stub of "Main Street" reads as clutter */
export const LABEL_MIN_M = 30

/** One road as a polyline in the site frame (x east, y north, metres); `z` when it is known. */
export interface RoadLine {
  cls: string
  name: string | null
  xy: Float32Array
  z: Float32Array | null
}

export interface Bucket {
  key: string
  tier: number
  /** site-frame bounds, metres */
  bbox: [number, number, number, number]
  /** vertices: x, y pairs */
  xy: Float32Array
  /** heights per vertex, when the source carried them (a manifest branch); else NaN-free zeros and `hasZ` false */
  z: Float32Array
  hasZ: boolean
  /** segments: pairs of vertex indices */
  segs: Uint32Array
  /** style index per segment */
  style: Uint8Array
  labels: { x: Float32Array; y: Float32Array; ang: Float32Array; name: Uint32Array; rank: Uint8Array }
}

class Acc {
  xy: number[] = []
  z: number[] = []
  segs: number[] = []
  style: number[] = []
  lx: number[] = []
  ly: number[] = []
  la: number[] = []
  ln: number[] = []
  lr: number[] = []
  hasZ = false
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity
  key: string
  tier: number
  constructor(key: string, tier: number) {
    this.key = key
    this.tier = tier
  }
  vertex(x: number, y: number, z: number): number {
    const i = this.xy.length / 2
    this.xy.push(x, y)
    this.z.push(z)
    if (x < this.x0) this.x0 = x
    if (x > this.x1) this.x1 = x
    if (y < this.y0) this.y0 = y
    if (y > this.y1) this.y1 = y
    return i
  }
  done(): Bucket {
    return {
      key: this.key,
      tier: this.tier,
      bbox: [this.x0, this.y0, this.x1, this.y1],
      xy: Float32Array.from(this.xy),
      z: Float32Array.from(this.z),
      hasZ: this.hasZ,
      segs: Uint32Array.from(this.segs),
      style: Uint8Array.from(this.style),
      labels: { x: Float32Array.from(this.lx), y: Float32Array.from(this.ly), ang: Float32Array.from(this.la), name: Uint32Array.from(this.ln), rank: Uint8Array.from(this.lr) },
    }
  }
}

/**
 * Cut every road into buckets: tier 0 into one, tiers 1 and 2 into `cell`-metre squares by each
 * segment's midpoint. Named roads leave label anchors every `LABEL_SPACING_M[tier]` along their
 * length (one at the middle when shorter), each with the road's direction there.
 */
export function bucketRoads(lines: RoadLine[], cell: number, keyPrefix = ''): { names: string[]; buckets: Bucket[] } {
  const names: string[] = []
  const nameIdx = new Map<string, number>()
  const accs = new Map<string, Acc>()
  const accFor = (tier: number, x: number, y: number) => {
    const key = tier === 0 ? `${keyPrefix}major` : `${keyPrefix}${tier}:${Math.floor(x / cell)},${Math.floor(y / cell)}`
    let a = accs.get(key)
    if (!a) accs.set(key, (a = new Acc(key, tier)))
    return a
  }
  for (const ln of lines) {
    const si = styleOf(ln.cls)
    if (si < 0) continue
    const st = ROAD_STYLES[si]
    const tier = st.tier
    const n = ln.xy.length / 2
    if (n < 2) continue
    let prevAcc: Acc | null = null
    let prevIdx = -1
    let length = 0
    for (let i = 0; i < n - 1; i++) {
      const ax = ln.xy[i * 2], ay = ln.xy[i * 2 + 1], bx = ln.xy[i * 2 + 2], by = ln.xy[i * 2 + 3]
      const seg = Math.hypot(bx - ax, by - ay)
      length += seg
      if (seg < 1e-3) continue
      const acc = accFor(tier, (ax + bx) / 2, (ay + by) / 2)
      if (ln.z) acc.hasZ = true
      const ia = acc === prevAcc && prevIdx >= 0 ? prevIdx : acc.vertex(ax, ay, ln.z ? ln.z[i] : 0)
      const ib = acc.vertex(bx, by, ln.z ? ln.z[i + 1] : 0)
      acc.segs.push(ia, ib)
      acc.style.push(si)
      prevAcc = acc
      prevIdx = ib
    }
    const name = ln.name?.trim()
    if (!name || length < LABEL_MIN_M) continue
    let ni = nameIdx.get(name)
    if (ni === undefined) {
      ni = names.push(name) - 1
      nameIdx.set(name, ni)
    }
    const spacing = LABEL_SPACING_M[tier]
    const anchors: number[] = []
    if (length <= spacing) anchors.push(length / 2)
    else for (let s = spacing / 2; s < length; s += spacing) anchors.push(s)
    // walk the polyline once, dropping each anchor where its arc length falls
    let k = 0
    let run = 0
    for (let i = 0; i < n - 1 && k < anchors.length; i++) {
      const ax = ln.xy[i * 2], ay = ln.xy[i * 2 + 1], bx = ln.xy[i * 2 + 2], by = ln.xy[i * 2 + 3]
      const seg = Math.hypot(bx - ax, by - ay)
      while (k < anchors.length && anchors[k] <= run + seg) {
        const f = seg > 0 ? (anchors[k] - run) / seg : 0
        const x = ax + (bx - ax) * f, y = ay + (by - ay) * f
        const acc = accFor(tier, x, y)
        acc.lx.push(x)
        acc.ly.push(y)
        acc.la.push(Math.atan2(by - ay, bx - ax))
        acc.ln.push(ni)
        acc.lr.push(st.rank)
        k++
      }
      run += seg
    }
  }
  const buckets: Bucket[] = []
  for (const a of accs.values()) {
    if (!a.segs.length && !a.lx.length) continue
    // the bounds hold the label anchors as well as the segments: an anchor can sit in a cell its
    // road's segments only touch, and it must still be found when that cell is in view
    for (let i = 0; i < a.lx.length; i++) {
      a.x0 = Math.min(a.x0, a.lx[i]); a.x1 = Math.max(a.x1, a.lx[i])
      a.y0 = Math.min(a.y0, a.ly[i]); a.y1 = Math.max(a.y1, a.ly[i])
    }
    buckets.push(a.done())
  }
  return { names, buckets }
}
