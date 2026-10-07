// Dressing geometry, off the main thread.
//
// `dressing.ts` works out WHERE each kit part goes (pure geometry, tested headlessly). This draws
// it: quads and boxes in the same merged-geometry style as the massing. It is pure — no THREE, no
// DOM — so it runs in the building worker alongside `massing.ts`; the one main-thread input is the
// ground, and only a `slab` (the driveway apron) needs it, four corner samples per slab.
//
// `pushQuad` SHARES the two vertices of the shared edge (a box is four or five quads, not twenty
// vertices), so unlike the massing these normals are not flat. The worker therefore returns
// positions/colours/indices without normals and the main thread still runs `computeVertexNormals`,
// which is cheap (tens of ms a cell) and keeps the smoothing identical to before.
//
// The draw loop is copied verbatim from buildings.ts (same winding, same anchors, same box faces)
// so a worker cell is identical to a main-thread one. Keep them in step.

import { planDressing, type DressingPart, type DressingSite, type Footprint } from './dressing'
import kitSpec from '../../../../tools/assetlib/specs/buildings-dressing.json'

/** The merged dressing arrays while they are built; typed at the end. */
export interface DressBuild {
  pos: number[]
  col: number[]
  pal: number[]
  lay: number[]
  idx: number[]
}

export type Anchor = 'bottom' | 'below' | 'centre'
export interface Draw {
  /**
   * 'panel' is a flush pane with a frame round it, 'strip' a single quad standing off the wall (a
   * gutter, a ridge vent — a line, not a solid), 'box' stands proud, 'slab' lies on the ground.
   */
  kind: 'panel' | 'strip' | 'box' | 'slab'
  colour: [number, number, number]
  /** frame colour, panels only */
  trim?: [number, number, number]
  /** how far it stands off the wall, boxes only; the spec's own depth wins where it has one */
  depth?: number
  /** what `site.at[2]` means for this part */
  anchor?: Anchor
}

export const DRESS: Record<string, Draw> = {
  'window-double-hung-white': { kind: 'panel', colour: [0.10, 0.13, 0.17], trim: [0.93, 0.93, 0.91] },
  'window-picture-large': { kind: 'panel', colour: [0.11, 0.14, 0.18], trim: [0.93, 0.93, 0.91] },
  'window-commercial-storefront': { kind: 'panel', colour: [0.13, 0.17, 0.21], trim: [0.26, 0.26, 0.27] },
  'door-front-panelled': { kind: 'panel', colour: [0.36, 0.20, 0.14], trim: [0.90, 0.90, 0.88] },
  'door-garage-sectional': { kind: 'panel', colour: [0.80, 0.79, 0.76], trim: [0.88, 0.88, 0.86] },
  // FLAT, not a box: a gutter is a horizontal line under the eaves and nothing sees its back or
  // its ends. As boxes, 68,322 of them cost 820k triangles on crofton-triangle — 40% of the whole
  // dressing budget for the one part that is a line.
  'gutter-half-round-run': { kind: 'strip', colour: [0.86, 0.86, 0.83], anchor: 'below' },
  'downpipe-round': { kind: 'box', colour: [0.86, 0.86, 0.83], depth: 0.09 }, // flush: 4 quads
  'driveway-concrete-apron': { kind: 'slab', colour: [0.63, 0.62, 0.60] },
  'porch-step-concrete': { kind: 'box', colour: [0.72, 0.70, 0.68] },
  'meter-box-utility': { kind: 'panel', colour: [0.76, 0.76, 0.73] },
  'ac-condenser-unit': { kind: 'box', colour: [0.60, 0.62, 0.61] },
  'roof-vent-ridge': { kind: 'strip', colour: [0.30, 0.29, 0.28], anchor: 'centre' },
  'chimney-brick-residential': { kind: 'box', colour: [0.48, 0.33, 0.28] },
  'mailbox-wall-mounted': { kind: 'panel', colour: [0.24, 0.25, 0.28] },
  'awning-fabric-shop': { kind: 'box', colour: [0.50, 0.16, 0.16], anchor: 'below' },
  'fire-escape-landing': { kind: 'box', colour: [0.28, 0.28, 0.30], depth: 1, anchor: 'below' },
}

/** the kit's placement rules, as `tools/assetlib/specs/buildings-dressing.json` declares them */
export const KIT: DressingPart[] = (kitSpec as { assets: DressingPart[] }).assets
const KIT_BY_ID = new Map(KIT.map((p) => [p.id, p]))

/** What `site.at[2]` measures for a part, resolved to the bottom of the thing drawn. */
function anchorZ(s: DressingSite, anchor: Anchor): number {
  return anchor === 'below' ? s.at[2] - s.height : anchor === 'centre' ? s.at[2] - s.height / 2 : s.at[2]
}

/** A wall part's two axes in SITE metres: along its face, and out of it. */
export function axes(yaw: number): { ax: number; ay: number; nx: number; ny: number } {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  // the normal is (sin, cos) by the yaw convention in dressing.ts; along the wall is that turned
  // a quarter the other way, so a positive `w` runs the way the ring is wound
  return { ax: -c, ay: s, nx: s, ny: c }
}

/**
 * A quad in SITE metres, projected to world, with the two vertices of one diagonal shared. That
 * sharing is a third of the dressing's vertex count, and it is what makes the normals worth
 * smoothing — a box's corner vertex is in two faces and takes the average.
 */
function pushQuad(b: DressBuild, p: [number, number, number][], colour: [number, number, number]) {
  const k = b.pos.length / 3
  for (const [x, y, z] of p) {
    b.pos.push(x, z, -y)
    b.col.push(colour[0], colour[1], colour[2])
    b.pal.push(-1)
    b.lay.push(-1)
  }
  b.idx.push(k, k + 1, k + 2, k, k + 2, k + 3)
}

/**
 * A box in site metres, centred on (cx, cy) across `w`, spanning `z0..z1`, `d0..d1` off the face.
 *
 * FOUR OR FIVE FACES, NOT SIX. The bottom of every one of these sits on the ground, on a roof or
 * against the wall, so it is never the visible face — and when the box is flush against a wall the
 * back is not either. That is a third of the geometry of the second-biggest item in the dressing
 * budget for no visible difference.
 */
function pushBoxSite(b: DressBuild, cx: number, cy: number, yaw: number, w: number, z0: number, z1: number, d0: number, d1: number, colour: [number, number, number], { flush = false } = {}) {
  const { ax, ay, nx, ny } = axes(yaw)
  const at = (u: number, v: number, z: number): [number, number, number] => [cx + ax * u + nx * v, cy + ay * u + ny * v, z]
  const h = w / 2
  const c: [number, number, number][][] = [
    [at(-h, d1, z0), at(h, d1, z0), at(h, d1, z1), at(-h, d1, z1)], // front
    [at(h, d1, z0), at(h, d0, z0), at(h, d0, z1), at(h, d1, z1)], // one end
    [at(-h, d0, z0), at(-h, d1, z0), at(-h, d1, z1), at(-h, d0, z1)], // the other
    [at(-h, d0, z1), at(h, d0, z1), at(h, d1, z1), at(-h, d1, z1)], // top
  ]
  if (!flush) c.push([at(h, d0, z0), at(-h, d0, z0), at(-h, d0, z1), at(h, d0, z1)]) // back
  for (const q of c) pushQuad(b, q, colour)
}

/**
 * The ground a hard part sits on, in SITE x, y — `dressBuilding` passed the world-space
 * `groundAt(x, -y)`, so the fallback wraps it that way and the worker replays precomputed values.
 */
export type Ground = (x: number, y: number) => number | null

/** Work out one building's plan. `windowWalls` is `DRESS_WINDOW_WALLS`, passed so the worker does
 * not have to import the tuning module. */
export function planBuilding(bd: Footprint, base: number, street: [number, number] | null, windowWalls: number): DressingSite[] {
  return planDressing(bd, KIT, { street, base, windowWalls })
}

/**
 * A slab's four ground-sample points (SITE x, y), in the exact order `drawSite` asks for them.
 * The worker collects these, has the main thread sample the ground once for all of them, and then
 * replays the values through `drawSite`'s `Ground`.
 */
export function slabCorners(s: DressingSite): [number, number][] {
  const { ax, ay, nx, ny } = axes(s.yaw)
  const hw = s.width / 2
  const hl = s.height / 2
  const at = (u: number, v: number): [number, number] => [s.at[0] + ax * u + nx * v, s.at[1] + ay * u + ny * v]
  return [at(-hw, -hl), at(hw, -hl), at(hw, hl), at(-hw, hl)]
}

/** Draw one planned site into the merged arrays. Copied verbatim from buildings.ts. */
export function drawSite(b: DressBuild, s: DressingSite, ground: Ground): void {
  const d = DRESS[s.part]
  if (!d) return
  const spec = KIT_BY_ID.get(s.part)?.attach
  if (d.kind === 'slab') {
    // a driveway: `width` across, `height` along the normal, lying on the ground
    const { ax, ay, nx, ny } = axes(s.yaw)
    const hw = s.width / 2
    const hl = s.height / 2
    // a 13 m apron laid at the building's floor level cuts into a sloped garden, so each
    // corner takes its own ground height — the one part of the kit long enough for that to show
    const corner = (u: number, v: number): [number, number, number] => {
      const x = s.at[0] + ax * u + nx * v
      const y = s.at[1] + ay * u + ny * v
      const g = ground(x, y)
      return [x, y, (g === null ? s.at[2] : Math.max(g, s.at[2] - 0.6)) + 0.03]
    }
    pushQuad(b, [corner(-hw, -hl), corner(hw, -hl), corner(hw, hl), corner(-hw, hl)], d.colour)
    return
  }
  if (d.kind === 'panel' || d.kind === 'strip') {
    const { ax, ay, nx, ny } = axes(s.yaw)
    const face = (w: number, h: number, z0: number, out: number, colour: [number, number, number]) => {
      const hw = w / 2
      const at = (u: number, z: number): [number, number, number] => [s.at[0] + ax * u + nx * out, s.at[1] + ay * u + ny * out, z]
      pushQuad(b, [at(-hw, z0), at(hw, z0), at(hw, z0 + h), at(-hw, z0 + h)], colour)
    }
    if (d.kind === 'strip') {
      // a line under the eaves or along the ridge: one quad, standing 8 cm off so it catches a
      // different amount of light than the wall behind it and reads as a separate thing
      const z0 = anchorZ(s, d.anchor ?? 'bottom')
      face(s.width, Math.max(0.1, s.height), z0, 0.08, d.colour)
      return
    }
    // THE FRAME COSTS AS MUCH AS THE PANE, so it is spent on the elevation somebody looks at.
    // On the street side: frame 2 cm proud, pane 3 cm further out, and the reveal between the
    // two is what makes it read as a hole rather than a sticker. Everywhere else: just the pane.
    if (d.trim && s.front) face(s.width + 0.14, s.height + 0.14, s.at[2] - 0.07, 0.02, d.trim)
    face(s.width, s.height, s.at[2], 0.05, d.colour)
    return
  }
  // a box: depth from the spec where it has one, `anchor` says what at[2] measures
  const depth = spec?.depthM ?? spec?.projectionM ?? spec?.diameterM ?? d.depth ?? 0.3
  const z0 = anchorZ(s, d.anchor ?? 'bottom')
  // a part standing on the wall face sits just off it so it never z-fights the wall behind it
  const standoff = s.part === 'ac-condenser-unit' ? 0.25 : -0.02
  // flush against a wall: its back face is buried in the wall and nothing can see it
  const flush = s.wall >= 0 && standoff <= 0
  pushBoxSite(b, s.at[0], s.at[1], s.yaw, s.width, z0, z0 + s.height, standoff, standoff + depth, d.colour, { flush })
}

/** Plan and draw one building into the merged arrays. The main-thread fallback path. */
export function dressBuilding(b: DressBuild, bd: Footprint, base: number, street: [number, number] | null, ground: Ground, windowWalls: number): number {
  let n = 0
  for (const s of planBuilding(bd, base, street, windowWalls)) {
    if (!DRESS[s.part]) continue
    n += 1
    drawSite(b, s, ground)
  }
  return n
}
