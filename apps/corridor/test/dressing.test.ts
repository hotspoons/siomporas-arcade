// Does the dressing plan describe a building somebody could live in?
//
// Placement has a specific failure mode: it never throws, it never looks wrong in a unit test that
// checks arithmetic, and it produces a house with a door in the middle of a blank wall. So these
// ask the questions an eye would ask from the pavement — is the door on the street side, does the
// window sit IN the wall, do two openings share a hole, does the driveway reach the road — and
// none of them repeat the formula from `dressing.ts`.
//
// The kit comes off disk rather than out of a fixture: a placement rule that silently stops
// matching because somebody renamed a part is exactly the bug this should catch.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RoadIndex, classify, frontWall, normalOf, onWall, planDressing, spaceAlong, storeysOf, walls,
  type DressingPart, type DressingSite, type Footprint,
} from '../src/world/dressing'

const KIT: DressingPart[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../tools/assetlib/specs/buildings-dressing.json', import.meta.url)), 'utf8'),
).assets

/** an axis-aligned rectangle, counter-clockwise, centred on the origin */
function box(w: number, d: number, cx = 0, cy = 0): [number, number][] {
  return [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]]
}

const house = (over: Partial<Footprint> = {}): Footprint => ({
  ring: box(12, 8),
  height_m: 6,
  area_m2: 96,
  rect: { w: 12, d: 8, yaw_deg: 0 },
  ...over,
})

/** distance from a point to the nearest wall face of a ring, ignoring height */
function toNearestWall(ring: [number, number][], p: [number, number]): number {
  return Math.min(...walls(ring).map((w) => {
    const dx = (w.b[0] - w.a[0]) / w.len
    const dy = (w.b[1] - w.a[1]) / w.len
    const t = Math.max(0, Math.min(w.len, (p[0] - w.a[0]) * dx + (p[1] - w.a[1]) * dy))
    return Math.hypot(p[0] - (w.a[0] + dx * t), p[1] - (w.a[1] + dy * t))
  }))
}

const named = (s: DressingSite[], id: string) => s.filter((x) => x.part === id)

describe('walls', () => {
  it('points every normal outwards, whichever way the ring is wound', () => {
    for (const ring of [box(10, 6), [...box(10, 6)].reverse() as [number, number][]]) {
      for (const w of walls(ring)) {
        const n = normalOf(w.yaw)
        // the centroid is the origin here, so "outward" is simply "away from it"
        expect(w.mid[0] * n[0] + w.mid[1] * n[1]).toBeGreaterThan(0)
      }
    }
  })

  it('drops the slivers an OSM ring leaves behind', () => {
    const ring: [number, number][] = [[0, 0], [10, 0], [10.2, 0], [10.2, 6], [0, 6]]
    expect(walls(ring)).toHaveLength(4)
  })
})

describe('frontWall', () => {
  it('picks the wall looking at the road, not the one nearest a corner', () => {
    // a corner plot: the road runs past the south face, and the east face's corner is closer to it
    const ring = box(12, 8)
    const i = frontWall(ring, [4, -20])
    const n = normalOf(walls(ring)[i].yaw)
    expect(n[1]).toBeLessThan(-0.9) // faces south
  })

  it('agrees with itself when the ring is wound the other way', () => {
    const a = walls(box(12, 8))[frontWall(box(12, 8), [0, -20])]
    const rev = [...box(12, 8)].reverse() as [number, number][]
    const b = walls(rev)[frontWall(rev, [0, -20])]
    expect(b.mid[0]).toBeCloseTo(a.mid[0], 6)
    expect(b.mid[1]).toBeCloseTo(a.mid[1], 6)
  })

  it('falls back to the longest wall with no street', () => {
    const ring = box(20, 6)
    expect(walls(ring)[frontWall(ring, null)].len).toBeCloseTo(20, 6)
  })
})

describe('spaceAlong', () => {
  it('gives nothing to a wall too short for one', () => {
    expect(spaceAlong(1.5, 0.9)).toEqual([])
  })

  it('keeps everything inside the inset and never closer than the gap', () => {
    const xs = spaceAlong(12, 0.9)
    expect(xs.length).toBeGreaterThan(1)
    expect(xs[0] - 0.45).toBeGreaterThanOrEqual(0.6 - 1e-9)
    expect(xs[xs.length - 1] + 0.45).toBeLessThanOrEqual(12 - 0.6 + 1e-9)
    for (let i = 1; i < xs.length; i += 1) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(0.9 + 0.8 - 1e-9)
  })

  it('centres the row it produces', () => {
    const xs = spaceAlong(12, 0.9)
    expect((xs[0] + xs[xs.length - 1]) / 2).toBeCloseTo(6, 6)
  })
})

describe('classify', () => {
  it('reads the OSM tag over the shape', () => {
    expect(classify({ ring: box(40, 40), area_m2: 1600, height_m: 8, kind: 'house' })).toBe('house')
    expect(classify({ ring: box(10, 8), area_m2: 80, height_m: 6, kind: 'retail' })).toBe('commercial')
  })

  it('calls a big flat thing commercial and a small low one a shed', () => {
    expect(classify({ ring: box(40, 30), area_m2: 1200, height_m: 7 })).toBe('commercial')
    expect(classify({ ring: box(4, 3), area_m2: 12, height_m: 2.4 })).toBe('shed')
    expect(classify({ ring: box(20, 20), area_m2: 400, height_m: 30 })).toBe('block')
  })
})

describe('planDressing', () => {
  const street: [number, number] = [0, -20]

  it('puts every opening exactly in the face of its wall', () => {
    // an opening is a HOLE. A hole 30 cm proud of the wall is a floating pane of glass, and a hole
    // 30 cm inside it is invisible, so this is the one placement with no tolerance at all.
    const b = house()
    for (const s of planDressing(b, KIT, { street })) {
      if (!s.opening) continue
      expect(toNearestWall(b.ring, [s.at[0], s.at[1]])).toBeLessThan(1e-9)
    }
  })

  it('faces every wall part outward', () => {
    const b = house()
    for (const s of planDressing(b, KIT, { street })) {
      if (s.wall < 0) continue
      const n = normalOf(s.yaw)
      expect(s.at[0] * n[0] + s.at[1] * n[1]).toBeGreaterThan(0)
    }
  })

  it('puts the front door on the wall facing the street', () => {
    for (const st of [[0, -20], [0, 20], [20, 0], [-20, 0]] as [number, number][]) {
      const sites = planDressing(house(), KIT, { street: st })
      const door = named(sites, 'door-front-panelled')[0]
      expect(door).toBeTruthy()
      const n = normalOf(door.yaw)
      const to = [st[0] - door.at[0], st[1] - door.at[1]]
      const d = Math.hypot(to[0], to[1])
      expect((to[0] / d) * n[0] + (to[1] / d) * n[1]).toBeGreaterThan(0.9)
    }
  })

  it('stands the door on the ground and never buries it', () => {
    const door = named(planDressing(house(), KIT, { street, base: 12.5 }), 'door-front-panelled')[0]
    expect(door.at[2]).toBeCloseTo(12.5, 6)
  })

  it('never cuts two openings out of the same piece of wall', () => {
    // a long frontage, so a door, a garage, a mailbox and a row of windows all compete for it.
    // Only openings are checked: a porch step and a condenser stand IN FRONT of the wall on
    // purpose, and the driveway runs under the garage door by definition.
    const b = house({ ring: box(22, 10), area_m2: 220, rect: { w: 22, d: 10, yaw_deg: 0 } })
    const holes = planDressing(b, KIT, { street }).filter((s) => s.opening)
    expect(holes.length).toBeGreaterThan(6)
    for (const a of holes) {
      for (const c of holes) {
        if (a === c || a.wall !== c.wall) continue
        // a different storey is a different piece of wall
        if (Math.abs(a.at[2] - c.at[2]) > 1.5) continue
        const gap = Math.hypot(a.at[0] - c.at[0], a.at[1] - c.at[1])
        expect(gap).toBeGreaterThan((a.width + c.width) / 2 - 1e-6)
      }
    }
  })

  it('puts every wall part ON the face and lets the renderer project it', () => {
    // THE CONTRACT. The planner says where on the wall; how far a porch step or a condenser stands
    // off it is the renderer's business, read from the spec's own depthM. When both ends applied
    // the offset, every projecting part stood off by twice its depth.
    const b = house({ ring: box(22, 10), area_m2: 220, rect: { w: 22, d: 10, yaw_deg: 0 } })
    const w = walls(b.ring)
    for (const s of planDressing(b, KIT, { street })) {
      if (s.wall < 0 || s.part === 'driveway-concrete-apron') continue
      const n = normalOf(w[s.wall].yaw)
      const out = (s.at[0] - w[s.wall].mid[0]) * n[0] + (s.at[1] - w[s.wall].mid[1]) * n[1]
      expect(out).toBeCloseTo(0, 9)
    }
  })

  it('keeps every opening under the eaves, not through the roof', () => {
    // a 6 m gabled house has 4.2 m of WALL and 1.8 m of roof (buildings.ts gables at 0.7 h). Two
    // storeys' worth of height, one storey's worth of wall: the second row has to be dropped or it
    // comes out of the tiles.
    const b = house({ height_m: 6 })
    const sites = planDressing(b, KIT, { street })
    for (const s of sites) {
      if (!s.opening) continue
      expect(s.at[2] + s.height).toBeLessThan(6 * 0.7)
    }
    expect(new Set(named(sites, 'window-double-hung-white').map((s) => s.at[2].toFixed(2))).size).toBe(1)

    // and the awkward case the storey count alone does not catch: 4.6 m of flat wall rounds to two
    // storeys, but a 1.5 m window on a 3 m sill tops out at 5.4 m
    const low = planDressing({ ring: box(30, 20), area_m2: 600, height_m: 4.6, kind: 'retail' }, KIT, { street })
    expect(storeysOf(4.6)).toBe(2)
    for (const s of low) {
      if (!s.opening) continue
      expect(s.at[2] + s.height).toBeLessThan(4.6)
    }
  })

  it('keeps every opening within the wall it is on', () => {
    const b = house()
    const w = walls(b.ring)
    for (const s of planDressing(b, KIT, { street })) {
      if (!s.opening || s.wall < 0) continue
      const wall = w[s.wall]
      const t = (s.at[0] - wall.a[0]) * ((wall.b[0] - wall.a[0]) / wall.len) + (s.at[1] - wall.a[1]) * ((wall.b[1] - wall.a[1]) / wall.len)
      expect(t - s.width / 2).toBeGreaterThan(-1e-6)
      expect(t + s.width / 2).toBeLessThan(wall.len + 1e-6)
    }
  })

  it('gives the same plan every time', () => {
    const a = planDressing(house(), KIT, { street })
    const b = planDressing(house(), KIT, { street })
    expect(b).toEqual(a)
  })

  it('gives a building one row of windows per storey of WALL', () => {
    expect(storeysOf(3)).toBe(1)
    expect(storeysOf(6)).toBe(2)
    // flat-roofed, so the whole height is wall: 4 m one row, 9 m three
    const flat = (h: number) => planDressing(
      { ring: box(30, 20), area_m2: 600, height_m: h, kind: 'retail' }, KIT, { street },
    ).filter((s) => s.part.startsWith('window-'))
    const rows = (s: DressingSite[]) => new Set(s.map((x) => x.at[2].toFixed(2))).size
    expect(rows(flat(4))).toBe(1)
    expect(rows(flat(9))).toBe(3)
  })

  it('gives a bungalow three windows an elevation, not six', () => {
    // 12 m by 8 m, one storey. Two or three an elevation is a house; six is a corridor of rooms.
    const b = house({ height_m: 3.2, area_m2: 96 })
    const win = planDressing(b, KIT, { street }).filter((s) => s.part.startsWith('window-'))
    for (let i = 0; i < 4; i += 1) {
      const n = win.filter((s) => s.wall === i).length
      expect(n).toBeLessThanOrEqual(4)
    }
    expect(win.length).toBeGreaterThan(4)
  })

  it('spends the window budget on the street first, then the long walls', () => {
    // dressing every elevation of crofton-triangle plans 138,532 windows; the back of a house with
    // another house behind it is where that money goes, so the budget is what makes it affordable
    const b = house({ ring: box(22, 8), area_m2: 176, height_m: 3.2, rect: { w: 22, d: 8, yaw_deg: 0 } })
    const walls4 = (n: number) => new Set(
      planDressing(b, KIT, { street, windowWalls: n }).filter((s) => s.part.startsWith('window-')).map((s) => s.wall),
    )
    expect(walls4(4).size).toBe(4)
    expect(walls4(2).size).toBe(2)
    const one = walls4(1)
    expect(one.size).toBe(1)
    // and the one it keeps is the street's
    const door = named(planDressing(b, KIT, { street }), 'door-front-panelled')[0]
    expect([...one][0]).toBe(door.wall)
    // the second is the other long elevation, not a gable end
    expect([...walls4(2)].every((i) => walls(b.ring)[i].len > 20)).toBe(true)
  })

  it('flags the street-facing elevation so the renderer can spend detail on it', () => {
    const sites = planDressing(house(), KIT, { street })
    const door = named(sites, 'door-front-panelled')[0]
    expect(door.front).toBe(true)
    for (const s of sites) {
      if (s.wall < 0) continue
      expect(s.front).toBe(s.wall === door.wall)
    }
  })

  it('leaves a shed bare', () => {
    const sites = planDressing({ ring: box(4, 3), area_m2: 12, height_m: 2.4 }, KIT, { street })
    expect(named(sites, 'door-front-panelled')).toHaveLength(0)
    expect(named(sites, 'window-double-hung-white')).toHaveLength(0)
    expect(named(sites, 'ac-condenser-unit')).toHaveLength(0)
  })

  it('puts storefronts on a shop and double-hung windows on a house', () => {
    const shop = planDressing({ ring: box(30, 20), area_m2: 600, height_m: 5, kind: 'retail' }, KIT, { street })
    expect(named(shop, 'window-commercial-storefront').length).toBeGreaterThan(0)
    expect(named(shop, 'awning-fabric-shop').length).toBeGreaterThan(0)
    const home = planDressing(house(), KIT, { street })
    expect(named(home, 'window-commercial-storefront')).toHaveLength(0)
    expect(named(home, 'window-double-hung-white').length).toBeGreaterThan(0)
  })

  it('keeps a storefront on the pavement and shrinks a window that will not fit', () => {
    // a storefront sits 0.15 m off the ground ON PURPOSE. A sill floor applied to everything
    // dropped every one of them and the shop came back with sash windows.
    const shop = planDressing({ ring: box(30, 20), area_m2: 600, height_m: 5, kind: 'retail' }, KIT, { street })
    const store = named(shop, 'window-commercial-storefront')
    expect(store.length).toBeGreaterThan(0)
    for (const s of store) expect(s.at[2]).toBeCloseTo(0.15, 6)

    // and the other half of the same rule: 2.24 m of wall on a low gabled bungalow still gets
    // windows, lowered and shortened to fit, rather than a blank elevation
    const low = planDressing(house({ height_m: 3.2 }), KIT, { street }).filter((s) => s.part.startsWith('window-'))
    expect(low.length).toBeGreaterThan(4)
    for (const s of low) expect(s.at[2] + s.height).toBeLessThan(3.2 * 0.7)
  })

  it('hangs the fire escape off the back of a block, one per upper floor', () => {
    const b: Footprint = { ring: box(20, 20), area_m2: 400, height_m: 24, kind: 'office' }
    const sites = planDressing(b, KIT, { street })
    const esc = named(sites, 'fire-escape-landing')
    expect(esc).toHaveLength(storeysOf(24) - 1)
    const n = normalOf(esc[0].yaw)
    const to = [street[0] - esc[0].at[0], street[1] - esc[0].at[1]]
    const d = Math.hypot(to[0], to[1])
    expect((to[0] / d) * n[0] + (to[1] / d) * n[1]).toBeLessThan(0) // faces away from the road
  })

  it('runs a gutter the length of every eave', () => {
    const b = house()
    const gutters = named(planDressing(b, KIT, { street }), 'gutter-half-round-run')
    expect(gutters.map((g) => g.width).sort((x, y) => x - y)).toEqual([8, 8, 12, 12])
    // at the eaves line buildings.ts actually draws, not at the ridge
    for (const g of gutters) expect(g.at[2]).toBeCloseTo(6 * 0.7, 6)
  })

  it('keeps the downpipe off the front', () => {
    const sites = planDressing(house(), KIT, { street })
    const pipe = named(sites, 'downpipe-round')[0]
    const door = named(sites, 'door-front-panelled')[0]
    expect(pipe.wall).not.toBe(door.wall)
    expect(pipe.height).toBeGreaterThan(4)
  })

  it('runs the driveway from the garage all the way to the kerb', () => {
    const b = house({ ring: box(22, 10), area_m2: 220, rect: { w: 22, d: 10, yaw_deg: 0 } })
    const sites = planDressing(b, KIT, { street: [0, -18] })
    const garage = named(sites, 'door-garage-sectional')[0]
    const drive = named(sites, 'driveway-concrete-apron')[0]
    expect(garage).toBeTruthy()
    // the garage face is at y = -5; the kerb at y = -18, so the apron is 13 m long and its centre
    // sits halfway between them
    expect(drive.height).toBeCloseTo(13, 6)
    expect(drive.at[1]).toBeCloseTo(-11.5, 6)
    expect(drive.width).toBeGreaterThanOrEqual(garage.width)
  })

  it('gives a narrow house no garage', () => {
    const sites = planDressing(house({ ring: box(7, 8), area_m2: 56, rect: { w: 7, d: 8, yaw_deg: 0 } }), KIT, { street })
    expect(named(sites, 'door-garage-sectional')).toHaveLength(0)
    expect(named(sites, 'driveway-concrete-apron')).toHaveLength(0)
  })

  it('puts the chimney and the ridge vent on the ridge of a gabled house', () => {
    const sites = planDressing(house(), KIT, { street })
    const vent = named(sites, 'roof-vent-ridge')[0]
    const chimney = named(sites, 'chimney-brick-residential')[0]
    expect(vent.at[2]).toBeCloseTo(6, 6)
    expect(vent.at[0]).toBeCloseTo(0, 6)
    expect(vent.at[1]).toBeCloseTo(0, 6)
    // rect.yaw_deg 0 means the long axis runs east, so the chimney moves east along it
    expect(chimney.at[0]).toBeCloseTo(3, 6)
    expect(chimney.at[1]).toBeCloseTo(0, 6)
  })

  it('leaves a flat-roofed building off the ridge', () => {
    // buildings.ts only gables a house-sized footprint; dressing must agree or the vent floats
    const flat: Footprint = { ring: box(40, 30), area_m2: 1200, height_m: 7, rect: { w: 40, d: 30, yaw_deg: 0 } }
    expect(named(planDressing(flat, KIT, { street }), 'roof-vent-ridge')).toHaveLength(0)
  })

  it('survives a degenerate footprint', () => {
    expect(planDressing({ ring: [] }, KIT)).toEqual([])
    expect(planDressing({ ring: [[0, 0], [1, 0]] }, KIT)).toEqual([])
    expect(planDressing({ ring: box(0.2, 0.2), area_m2: 0.04, height_m: 3 }, KIT)).toEqual([])
  })

  it('places the whole plan relative to a footprint that is nowhere near the origin', () => {
    const near = planDressing(house(), KIT, { street: [0, -20] })
    const far = planDressing(house({ ring: box(12, 8, 900, -400) }), KIT, { street: [900, -420] })
    expect(far).toHaveLength(near.length)
    for (let i = 0; i < near.length; i += 1) {
      expect(far[i].at[0] - 900).toBeCloseTo(near[i].at[0], 6)
      expect(far[i].at[1] + 400).toBeCloseTo(near[i].at[1], 6)
      expect(far[i].yaw).toBeCloseTo(near[i].yaw, 6)
    }
  })

  it('reaches a point on the wall face from either end', () => {
    const w = walls(box(12, 8))[0]
    expect(onWall(w, 0)).toEqual([w.a[0], w.a[1]])
    const mid = onWall(w, w.len / 2)
    expect(mid[0]).toBeCloseTo(w.mid[0], 6)
    expect(mid[1]).toBeCloseTo(w.mid[1], 6)
  })
})

describe('RoadIndex', () => {
  const line = (a: [number, number], b: [number, number]): [number, number][] => [a, b]

  it('finds the middle of a long straight road, not only its ends', () => {
    // the bug this exists for: a sibling road emitted as two points 600 m apart
    const idx = new RoadIndex([line([-300, 0], [300, 0])])
    const p = idx.nearest(0, 20)
    expect(p).toBeTruthy()
    expect(Math.hypot(p![0] - 0, p![1] - 0)).toBeLessThan(8)
  })

  it('agrees with brute force over a scatter of queries', () => {
    const lines: [number, number][][] = [
      [[-200, -50], [200, -50]],
      [[0, -200], [0, 200]],
      [[-150, 90], [-40, 140], [120, 60]],
    ]
    const idx = new RoadIndex(lines, { step: 4 })
    // the same densified points, brute-forced
    const pts: [number, number][] = []
    for (const l of lines) {
      for (let i = 0; i + 1 < l.length; i += 1) {
        const d = Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1])
        for (let t = 0; t <= d; t += 0.25) pts.push([l[i][0] + ((l[i + 1][0] - l[i][0]) * t) / d, l[i][1] + ((l[i + 1][1] - l[i][1]) * t) / d])
      }
    }
    for (let k = 0; k < 200; k += 1) {
      const x = ((k * 37) % 400) - 200
      const y = ((k * 53) % 400) - 200
      const got = idx.nearest(x, y, 400)
      const want = pts.reduce((b, p) => (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(b[0] - x, b[1] - y) ? p : b), pts[0])
      // the index searches a 4 m densification; it may land on a neighbouring sample, no further
      expect(Math.hypot(got![0] - x, got![1] - y)).toBeLessThan(Math.hypot(want[0] - x, want[1] - y) + 4.01)
    }
  })

  it('gives a building in the middle of a field no street', () => {
    const idx = new RoadIndex([line([-200, 0], [200, 0])])
    // 60 m out is well inside the cells the search visits — it has to be rejected on DISTANCE,
    // not by running out of rings, or a barn faces a road it cannot see
    expect(idx.nearest(0, 60, 40)).toBeNull()
    expect(idx.nearest(0, 60, 80)).toBeTruthy()
    expect(idx.nearest(0, 500, 80)).toBeNull()
  })

  it('is empty when the site has no roads', () => {
    const idx = new RoadIndex([])
    expect(idx.size).toBe(0)
    expect(idx.nearest(0, 0)).toBeNull()
  })

  it('grows by addLine the same as building it whole', () => {
    // a streamed world feeds the index one vector tile at a time; addLine must land the same points
    // the constructor would, so a house dressed later still faces the same street
    const lines: [number, number][][] = [line([-300, 0], [300, 0]), [[0, 100], [0, 300]]]
    const whole = new RoadIndex(lines, { step: 4 })
    const grown = new RoadIndex([], { step: 4 })
    grown.addLine(lines[0])
    grown.addLine(lines[1])
    expect(grown.size).toBe(whole.size)
    for (const [x, y] of [[0, 10], [120, 40], [0, 200], [-250, -30]] as [number, number][]) {
      expect(grown.nearest(x, y, 400)).toEqual(whole.nearest(x, y, 400))
    }
    // and a coords-3 line (the manifest shape) is accepted too
    const three = new RoadIndex([], { step: 4 })
    three.addLine([[-300, 0, 5], [300, 0, 6]])
    expect(three.nearest(0, 20)).toBeTruthy()
  })
})
