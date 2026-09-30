// Can you stand a loop-the-loop on a real road at any angle, and does the road meet it smoothly?
//
// Rich has wanted this since he was a child, so the bar is that it actually works rather than that
// it renders. The three things that decide whether it works are arithmetic: the fixture's mouth has
// to be where the transform says, the approach curve has to LEAVE along the road's own tangent and
// ARRIVE along the fixture's, and the footprint has to cover the road it is replacing. All three
// are checked here; none of them needs a screen.
import { describe, expect, it } from 'vitest'
import {
  connectFixture, describeEnd, describeFixture, DEFAULT_TIGHTNESS, dirToSite, endsOf,
  fixtureFootprint, fixtureGeometry, fixtureLength, fixturePath, fixturePorts, fixtureSize, hermite,
  linkLength, linkPath, linksTo, pieceOf, ribbonGeometry, setEnd, STUNT_CELL, Stunts, stuntPieces, tangentOf,
  toSite, validateStunts,
  type Pose, type StuntFixture,
} from '../src/stunts'

const loop = (over: Partial<StuntFixture> = {}): StuntFixture =>
  ({ id: 'l1', name: 'The loop', piece: 'loop', at: [1000, 500], yaw_deg: 0, ...over })

describe('the STUNTIN vocabulary is here, not copied', () => {
  it('has the pieces a stunt track is made of', () => {
    const types = stuntPieces().map((p) => p.type)
    expect(types).toContain('loop')
    expect(types).toContain('corkscrew')
    expect(types).toContain('jump')
    expect(pieceOf('loop')?.label).toBe('Loop')
    expect(pieceOf('nonesuch')).toBeNull()
  })

  it('knows how big one is, in metres rather than cells', () => {
    // a loop is 2 × 2 cells and a cell is 40 m
    expect(STUNT_CELL).toBe(40)
    expect(fixtureSize(loop())).toEqual({ w: 80, h: 80 })
  })
})

describe('standing a piece up anywhere', () => {
  it('centres the footprint on the placement, not its corner', () => {
    const f = loop()
    const poly = fixtureFootprint(f)
    const xs = poly.map((p) => p[0])
    const ys = poly.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(960, 6)
    expect(Math.max(...xs)).toBeCloseTo(1040, 6)
    expect(Math.min(...ys)).toBeCloseTo(460, 6)
    expect(Math.max(...ys)).toBeCloseTo(540, 6)
  })

  it('puts the mouth and the exit where the lane says they are', () => {
    const ports = fixturePorts(loop())!
    // the loop's lane runs +x across the whole 80 m and drifts one cell (+40 m) sideways
    expect(ports.entry.x).toBeCloseTo(960, 3)
    expect(ports.entry.y).toBeCloseTo(480, 3)
    expect(ports.exit.x).toBeCloseTo(1040, 3)
    expect(ports.exit.y).toBeCloseTo(520, 3)
    // and both point along the direction of travel, which at yaw 0 is due east
    expect(ports.entry.dx).toBeCloseTo(1, 3)
    expect(ports.entry.dy).toBeCloseTo(0, 3)
    expect(ports.exit.dx).toBeCloseTo(1, 3)
  })

  it('turns with the fixture — a loop at 90° is entered heading north', () => {
    const ports = fixturePorts(loop({ yaw_deg: 90 }))!
    expect(ports.entry.dx).toBeCloseTo(0, 3)
    expect(ports.entry.dy).toBeCloseTo(1, 3)
    // the mouth has swung a quarter turn about the placement too
    expect(ports.entry.x).toBeCloseTo(1020, 3)
    expect(ports.entry.y).toBeCloseTo(460, 3)
  })

  it('lifts the whole thing when asked', () => {
    const p = toSite(loop({ lift_m: 12 }), { x: 0, y: 3, z: 0 })
    expect(p.z).toBeCloseTo(15, 6)
  })

  it('rotates a direction without changing its length', () => {
    const d = dirToSite(loop({ yaw_deg: 37 }), { x: 1, z: 0 })
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 9)
  })

  /*
   * THE POINT OF A LOOP IS THAT THE SURFACE GOES OVER. Nothing downstream can work that out from
   * positions alone, so the path has to carry the normal — and halfway round, it must point DOWN.
   */
  it('carries the surface normal over the top, so the road mesh knows it is inverted', () => {
    const path = fixturePath(loop(), 128)
    const up = path.map((p) => p.up!.z)
    expect(Math.min(...up)).toBeLessThan(-0.9)
    expect(up[0]).toBeCloseTo(1, 3)
    expect(up[up.length - 1]).toBeCloseTo(1, 3)
    // and it climbs: the top of the loop is well above the road
    expect(Math.max(...path.map((p) => p.z))).toBeGreaterThan(30)
  })

  it('is longer than the ground it covers, because it goes round', () => {
    const straightAcross = 80
    expect(fixtureLength(loop())).toBeGreaterThan(straightAcross + 2 * Math.PI * 17)
  })
})

/* ---- the link ------------------------------------------------------------------------------ */

const pose = (x: number, y: number, dx: number, dy: number, z = 0): Pose => ({ x, y, z, dx, dy })

describe('the bezier link', () => {
  const a = pose(0, 0, 1, 0)
  const b = pose(200, 100, 0, 1)

  it('starts and ends exactly where it is told', () => {
    const p = linkPath(a, b, DEFAULT_TIGHTNESS, 32)
    expect(p[0].x).toBeCloseTo(a.x, 6)
    expect(p[0].y).toBeCloseTo(a.y, 6)
    expect(p[p.length - 1].x).toBeCloseTo(b.x, 6)
    expect(p[p.length - 1].y).toBeCloseTo(b.y, 6)
  })

  /*
   * THIS IS THE ONE THAT MAKES IT "LINK NATURALLY". If the curve leaves at any angle to the road,
   * a car crossing the joint at 40 m/s has to be steered for it, and the whole thing feels bolted
   * on. Tangent continuity at both ends is the property, so it is the property asserted.
   */
  it('leaves along the road and arrives along the fixture, with no corner at either joint', () => {
    const p = linkPath(a, b, DEFAULT_TIGHTNESS, 200)
    expect(p[0].dx).toBeCloseTo(a.dx, 3)
    expect(p[0].dy).toBeCloseTo(a.dy, 3)
    expect(p[p.length - 1].dx).toBeCloseTo(b.dx, 3)
    expect(p[p.length - 1].dy).toBeCloseTo(b.dy, 3)
  })

  it('never turns sharply anywhere in between', () => {
    const p = linkPath(a, b, DEFAULT_TIGHTNESS, 200)
    for (let i = 1; i < p.length; i++) {
      const dot = p[i].dx * p[i - 1].dx + p[i].dy * p[i - 1].dy
      expect(dot).toBeGreaterThan(0.99) // under 8° between samples
    }
  })

  it('eases the height instead of ramping it, so there is no jump at the ends', () => {
    const up = pose(200, 0, 1, 0, 20)
    const p = linkPath(a, up, DEFAULT_TIGHTNESS, 64)
    expect(p[0].z).toBeCloseTo(0, 6)
    expect(p[p.length - 1].z).toBeCloseTo(20, 6)
    // a smoothstep is flat at both ends: the first step up is much smaller than the middle one
    const first = p[1].z - p[0].z
    const middle = p[33].z - p[32].z
    expect(first).toBeLessThan(middle / 3)
  })

  it('makes a tighter curve shorter than a looser one', () => {
    expect(linkLength(a, b, 0.4)).toBeLessThan(linkLength(a, b, 1.6))
  })

  it('is exactly the two endpoints at t=0 and t=1', () => {
    expect(hermite(a, b, 0.8, 0)).toMatchObject({ x: 0, y: 0 })
    const end = hermite(a, b, 0.8, 1)
    expect(end.x).toBeCloseTo(200, 6)
    expect(end.y).toBeCloseTo(100, 6)
  })
})

/* ---- hooking it to a road ------------------------------------------------------------------- */

/** A dead straight road running east along y = 500, so every pose is trivially checkable. */
const straightRoad = (s: number): Pose | null => (s < 0 || s > 5000 ? null : { x: s, y: 500, z: 0, dx: 1, dy: 0 })

describe('connecting a fixture to the road', () => {
  it('gives you road in, the stunt, and road out — joined without a corner', () => {
    const f = loop({ at: [1000, 520], yaw_deg: 0, entry_s: 800, exit_s: 1200 })
    const c = connectFixture(f, straightRoad)!
    expect(c.problems).toEqual([])
    expect(c.approach.length).toBeGreaterThan(8)
    expect(c.through.length).toBeGreaterThan(8)
    expect(c.departure.length).toBeGreaterThan(8)

    // the approach starts on the road at 800 m and ends at the fixture's mouth
    expect(c.approach[0]).toMatchObject({ x: 800, y: 500 })
    const mouth = c.through[0]
    const arrive = c.approach[c.approach.length - 1]
    expect(arrive.x).toBeCloseTo(mouth.x, 3)
    expect(arrive.y).toBeCloseTo(mouth.y, 3)
    // and it arrives pointing the way the loop is entered
    expect(arrive.dx).toBeCloseTo(mouth.dx, 2)
    expect(arrive.dy).toBeCloseTo(mouth.dy, 2)

    // the departure leaves the loop's exit and lands back on the road at 1200 m
    const out = c.through[c.through.length - 1]
    expect(c.departure[0].x).toBeCloseTo(out.x, 3)
    const home = c.departure[c.departure.length - 1]
    expect(home.x).toBeCloseTo(1200, 3)
    expect(home.y).toBeCloseTo(500, 3)
    expect(home.dx).toBeCloseTo(1, 2)
  })

  /*
   * A FIXTURE FACING THE WRONG WAY is the easiest mistake to make and it looks fine from above —
   * the footprint is on the road and the curve is a curve. It is only undriveable, so the connector
   * has to say so rather than hand back a link that turns through 180°.
   */
  it('says when the fixture is facing backwards instead of handing back a U-turn', () => {
    const f = loop({ at: [1000, 520], yaw_deg: 180, entry_s: 800, exit_s: 1200 })
    const c = connectFixture(f, straightRoad)!
    expect(c.problems.join(' ')).toMatch(/doubles back/)
  })

  it('says when the road does not reach that far', () => {
    const f = loop({ at: [1000, 520], entry_s: 9000, exit_s: 1200 })
    expect(connectFixture(f, straightRoad)!.problems.join(' ')).toMatch(/no road at 9000/)
  })

  it('still gives you the stunt when neither end is hooked up yet', () => {
    const c = connectFixture(loop(), straightRoad)!
    expect(c.approach).toEqual([])
    expect(c.through.length).toBeGreaterThan(8)
  })
})

/* ---- the road is flat from side to side ------------------------------------------------------- */

/*
 * Rich, 2026-09-29, with a screenshot of a loop: *"The center of the loop de loop's road is raised
 * to near vertical, the car runs into it and gets stuck. We need the road smoothed out so it is as
 * flat as it can be from side to side without this large crown right in the middle as the car
 * drives up it."*
 *
 * The crown was a SHEAR. The surface across the road is `tangent × normal`, and the tangent used
 * was `dx, dy` — the direction's shadow on the map, which is the tangent only while the road is
 * flat. Where a loop's lane pitches up 62° the cross-section came out 32° from the direction of
 * travel: a quad stretched into a diagonal, which is a ridge running up the middle of the road.
 */
describe('a fixture is flat from side to side, however steep it gets', () => {
  const lane = () => fixturePath(loop({ at: [0, 0] }), 64, 0)

  it('carries the full direction of travel, not just its shadow on the map', () => {
    const path = lane()
    const climbing = path.find((p) => (p.t3?.z ?? 0) > 0.5)!
    expect(climbing).toBeTruthy()
    // a unit vector, and its horizontal part is genuinely shorter than one where it is climbing
    expect(Math.hypot(climbing.t3!.x, climbing.t3!.y, climbing.t3!.z)).toBeCloseTo(1, 6)
    expect(Math.hypot(climbing.t3!.x, climbing.t3!.y)).toBeLessThan(0.9)
    // a flat road pose has none, and the tangent falls back to the shadow
    expect(tangentOf({ x: 0, y: 0, z: 0, dx: 1, dy: 0 })).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('keeps the surface square to the direction of travel all the way round a loop', () => {
    const path = lane()
    const g = ribbonGeometry(path, 5)
    let worst = { deg: 90, pitch: 0 }
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1]
      const b = path[i + 1]
      const t = [b.x - a.x, b.y - a.y, b.z - a.z]
      const tl = Math.hypot(...t)
      const k = i * 6
      const across = [g.positions[k + 3] - g.positions[k], g.positions[k + 4] - g.positions[k + 1], g.positions[k + 5] - g.positions[k + 2]]
      const al = Math.hypot(...across)
      const dot = (t[0] * across[0] + t[1] * across[1] + t[2] * across[2]) / (tl * al)
      const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
      const pitch = (Math.asin((b.z - a.z) / tl) * 180) / Math.PI
      if (Math.abs(deg - 90) > Math.abs(worst.deg - 90)) worst = { deg, pitch }
    }
    // the surface must be perpendicular to travel EVERYWHERE, including where the lane is vertical
    expect(Math.abs(worst.deg - 90)).toBeLessThan(1.5)
    // and the loop really does get steep, or this test would be measuring a flat road
    expect(Math.abs(worst.pitch)).toBeGreaterThan(0)
  })

  it('and the road stays the width it is meant to be', () => {
    const path = lane()
    const g = ribbonGeometry(path, 5)
    for (let i = 0; i < path.length; i++) {
      const k = i * 6
      const w = Math.hypot(g.positions[k + 3] - g.positions[k], g.positions[k + 4] - g.positions[k + 1], g.positions[k + 5] - g.positions[k + 2])
      expect(w).toBeCloseTo(10, 3)
    }
  })
})

/* ---- a track in a field ------------------------------------------------------------------------ */

/*
 * Rich, 2026-09-29: *"the original ask was to be able to drop a stunt piece and place it anywhere,
 * not just on the existing roads, then connect it on both ends to the roads with waypoints and then
 * have curved sections of road link both ends… or not have them link to roads at all. That way I
 * can build complete stunt tracks in a field."*
 *
 * So the three things that have to hold are: a piece with no road anywhere is still a piece; two
 * pieces can be joined to each other by the same curve that joins one to a road; and the join
 * between them is drawn ONCE however both of them describe it.
 */
describe('ends: a road, another piece, or nothing at all', () => {
  const at = (f: StuntFixture) => fixturePorts(f)!

  it('reads the old entry_s/exit_s shape as road ends', () => {
    const e = endsOf(loop({ entry_s: 800, exit_s: 1200, chain: 3 }))
    expect(e.entry).toEqual({ kind: 'road', s: 800, chain: 3 })
    expect(e.exit).toEqual({ kind: 'road', s: 1200, chain: 3 })
  })

  it('treats a missing one as open rather than as zero', () => {
    // `entry_s: 0` is a real station at the start of a chain; undefined is not a station at all
    expect(endsOf(loop()).entry).toEqual({ kind: 'none' })
    expect(endsOf(loop({ entry_s: 0 })).entry).toEqual({ kind: 'road', s: 0, chain: 0 })
  })

  it('retires the legacy field when an end is set, so the JSON says one thing', () => {
    const f = loop({ entry_s: 800 })
    setEnd(f, 'entry', { kind: 'none' })
    expect(f.entry_s).toBeUndefined()
    expect(endsOf(f).entry).toEqual({ kind: 'none' })
  })

  it('takes a road end on a chain of its own at each end', () => {
    const roads = (s: number, chain: number): Pose | null =>
      chain === 0 ? { x: s, y: 500, z: 0, dx: 1, dy: 0 } : { x: s, y: 900, z: 0, dx: 1, dy: 0 }
    const f = loop({
      at: [1000, 700],
      entry: { kind: 'road', chain: 0, s: 700 },
      exit: { kind: 'road', chain: 1, s: 1300 },
    })
    const c = connectFixture(f, roads)!
    // in off the spine at y = 500, out onto the branch at y = 900
    expect(c.approach[0]).toMatchObject({ x: 700, y: 500 })
    expect(c.departure[c.departure.length - 1]).toMatchObject({ x: 1300, y: 900 })
  })

  it('stands a piece up with nothing near it and still gives you the surface', () => {
    const none = (): Pose | null => null
    const c = connectFixture(loop({ at: [9e4, 9e4] }), none)!
    expect(c.problems).toEqual([])
    expect(c.approach).toEqual([])
    expect(c.departure).toEqual([])
    expect(c.through.length).toBeGreaterThan(8)
    // and it is a real driveable surface, not an empty buffer
    expect(fixtureGeometry(c, 5).indices.length).toBeGreaterThan(100)
  })

  it('joins one piece to the next with a curve, with no road involved at all', () => {
    // two loops in a field: the second sits 200 m beyond the first, facing the same way
    const a = loop({ id: 'a', at: [0, 0] })
    const b = loop({ id: 'b', at: [200, 40], entry: { kind: 'fixture', id: 'a', port: 'exit' } })
    const doc = { a, b }
    const c = connectFixture(b, () => null, { fixture: (id) => doc[id as 'a' | 'b'] ?? null })!
    expect(c.problems).toEqual([])
    // the approach starts exactly at a's exit port and ends at b's mouth
    expect(c.approach[0].x).toBeCloseTo(at(a).exit.x, 3)
    expect(c.approach[0].y).toBeCloseTo(at(a).exit.y, 3)
    const last = c.approach[c.approach.length - 1]
    expect(last.x).toBeCloseTo(at(b).entry.x, 3)
    expect(last.y).toBeCloseTo(at(b).entry.y, 3)
  })

  /*
   * THE SAME JOIN DESCRIBED FROM BOTH SIDES IS STILL ONE CURVE. The editor writes both halves so
   * that both panels can say what they are attached to; drawing both would put two coincident
   * ribbons in the world, which z-fight on screen and hand the physics a doubled surface.
   */
  it('draws a mutual join once — from the arriving side', () => {
    const a = loop({ id: 'a', at: [0, 0], exit: { kind: 'fixture', id: 'b', port: 'entry' } })
    const b = loop({ id: 'b', at: [200, 40], entry: { kind: 'fixture', id: 'a', port: 'exit' } })
    const doc = { a, b }
    const look = { fixture: (id: string) => doc[id as 'a' | 'b'] ?? null }
    expect(connectFixture(b, () => null, look)!.approach.length).toBeGreaterThan(8)
    expect(connectFixture(a, () => null, look)!.departure).toEqual([])
  })

  /*
   * TWO PIECES BUTTED TOGETHER. The tangent floor used to be half a cell — 20 m — whatever the gap,
   * so a 20 cm join sent the curve twenty metres forward and twenty metres back: a loop where there
   * should be a joint, on exactly the layout a hand-built track is made of.
   */
  it('does not throw a loop into a join that is inches long', () => {
    const a = loop({ id: 'a', at: [0, 0] })
    const gap = 0.2
    const exit = at(a).exit
    // put b so its mouth lands just past a's exit, pointing the same way
    const b = loop({ id: 'b', at: [0, 0], entry: { kind: 'fixture', id: 'a', port: 'exit' } })
    const mouth = at(b).entry
    b.at = [exit.x + gap - (mouth.x - b.at[0]), exit.y - (mouth.y - b.at[1])]
    const doc = { a, b }
    const c = connectFixture(b, () => null, { fixture: (id) => doc[id as 'a' | 'b'] ?? null })!
    expect(c.problems).toEqual([])
    let len = 0
    for (let i = 1; i < c.approach.length; i++) {
      len += Math.hypot(c.approach[i].x - c.approach[i - 1].x, c.approach[i].y - c.approach[i - 1].y)
    }
    // the join is as long as the gap, not two lengths of a cell
    expect(len).toBeLessThan(gap * 2)
  })

  it('knows which pieces a move invalidates', () => {
    const b = loop({ id: 'b', entry: { kind: 'fixture', id: 'a', port: 'exit' } })
    expect(linksTo(b, 'a')).toBe(true)
    expect(linksTo(b, 'c')).toBe(false)
    expect(linksTo(loop({ entry_s: 100 }), 'a')).toBe(false)
  })

  it('says what an end is joined to, in words a panel can print', () => {
    expect(describeEnd({ kind: 'none' }, 'entry')).toMatch(/open/)
    expect(describeEnd({ kind: 'road', s: 812.4 }, 'exit')).toBe('road at 812 m')
    expect(describeEnd({ kind: 'fixture', id: 'sx2' }, 'entry')).toBe('sx2’s exit')
  })
})

/* ---- the road underneath --------------------------------------------------------------------- */

describe('the road under a fixture is not drawn', () => {
  it('covers the ground the fixture stands on and nothing else', () => {
    const s = new Stunts()
    s.set([loop({ at: [1000, 500] })])
    expect(s.count).toBe(1)
    expect(s.coversRoad(1000, 500)).toBe(true)
    expect(s.coversRoad(1039, 500)).toBe(true)
    expect(s.coversRoad(1041, 500)).toBe(false)  // just past the edge of the 80 m footprint
    expect(s.coversRoad(2000, 500)).toBe(false)
    expect(s.at(1000, 500)?.id).toBe('l1')
    expect(s.at(2000, 500)).toBeNull()
  })

  it('covers the turned footprint when the fixture is at an angle', () => {
    const s = new Stunts()
    s.set([loop({ at: [0, 0], yaw_deg: 45 })])
    // a 45° square's corners reach further along the axes than its sides do
    expect(s.coversRoad(0, 55)).toBe(true)
    expect(s.coversRoad(41, 41)).toBe(false)
  })

  it('ignores a fixture naming a piece this build does not have', () => {
    const s = new Stunts()
    s.set([loop({ piece: 'antigravity-helix' })])
    expect(s.count).toBe(0)
  })
})

describe('validation', () => {
  it('names a piece that does not exist and a duplicate id', () => {
    const r = validateStunts({
      version: 1,
      fixtures: [
        loop({ id: 'a', piece: 'nope' }),
        loop({ id: 'b' }),
        loop({ id: 'b' }),
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/not a piece this build has/)
    expect(r.errors.join(' ')).toMatch(/used twice/)
  })

  /*
   * AND SAYS NOTHING AT ALL about a piece standing on its own, which is the state Rich asked for:
   * *"or not have them link to roads at all. That way I can build complete stunt tracks in a
   * field."* It used to warn, which made the intended workflow feel like a mistake being tolerated.
   */
  it('does not complain about a piece with both ends deliberately open', () => {
    const r = validateStunts({ version: 1, fixtures: [loop({ id: 'free' })] }, straightRoad)
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('refuses a fixture joined to itself — there is no reading of that which works', () => {
    const r = validateStunts({ version: 1, fixtures: [loop({ id: 'me', exit: { kind: 'fixture', id: 'me' } })] }, straightRoad)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/joins its exit to itself/)
  })

  it('warns about a join to a piece that is not there, rather than drawing nothing', () => {
    const r = validateStunts({ version: 1, fixtures: [loop({ id: 'a', entry: { kind: 'fixture', id: 'ghost' } })] }, straightRoad)
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/ghost, which is not in this document/)
  })

  /*
   * A BACKWARDS FIXTURE IS A WARNING, NOT AN ERROR. It is undriveable, not malformed — and the
   * editor's preview saves every file before it runs, so reporting it as an error meant one fixture
   * somebody was halfway through turning blocked saving the whole site.
   */
  it('passes a fixture that is properly hooked up, and only WARNS about a backwards one', () => {
    const good = validateStunts({ version: 1, fixtures: [loop({ at: [1000, 520], entry_s: 800, exit_s: 1200 })] }, straightRoad)
    expect(good.errors).toEqual([])
    expect(good.warnings).toEqual([])

    const back = validateStunts({ version: 1, fixtures: [loop({ at: [1000, 520], yaw_deg: 180, entry_s: 800, exit_s: 1200 })] }, straightRoad)
    expect(back.errors, 'work in progress must stay saveable').toEqual([])
    expect(back.ok).toBe(true)
    expect(back.warnings.join(' ')).toMatch(/doubles back/)
    // and it says what to do about it, rather than only that something is wrong
    expect(back.warnings.join(' ')).toMatch(/turn the fixture round|drag its/)
  })

  it('still refuses a document that is actually meaningless', () => {
    expect(validateStunts({ version: 1, fixtures: [loop({ piece: 'nope' })] }).ok).toBe(false)
    expect(validateStunts({ version: 1, fixtures: [loop({ id: '' })] }).ok).toBe(false)
  })

  it('describes one in a line', () => {
    expect(describeFixture(loop())).toMatch(/Loop · 80×80 m/)
    expect(describeFixture(loop({ piece: 'nope' }))).toMatch(/not a piece/)
  })
})

/*
 * THE HEIGHT IS ADDED ONCE.
 *
 * The first version returned a path relative to the fixture's own base and left the renderer to add
 * the terrain offset — which it also did to the approach curves, whose road anchors were already
 * absolute. Thirty metres of Maryland, applied twice, consistently enough that the whole assembly
 * looked correct while floating over a field. A `Pose` is absolute; this is the test that keeps it
 * that way.
 */
describe('a fixture stands on the ground exactly once', () => {
  const ground = () => 30 // a flat site thirty metres up

  it('puts the lane at the ground height, not at zero and not at twice it', () => {
    const f = loop({ at: [1000, 520], entry_s: 800, exit_s: 1200 })
    const c = connectFixture(f, straightRoad, { groundAt: ground })!
    expect(c.baseZ).toBe(30)
    // the mouth of a loop is on the deck, so it sits at the ground and no higher
    expect(c.through[0].z).toBeCloseTo(30, 6)
    expect(Math.max(...c.through.map((p) => p.z))).toBeGreaterThan(60) // and the top is a loop above it
  })

  it('joins a road at its own height without a step', () => {
    // `straightRoad` is at z = 0 and the ground is at 30, so a naive build steps 30 m at the joint
    const f = loop({ at: [1000, 520], entry_s: 800, exit_s: 1200 })
    const c = connectFixture(f, straightRoad, { groundAt: ground })!
    expect(c.approach[0].z).toBeCloseTo(0, 6)                                  // leaves the road where the road is
    expect(c.approach[c.approach.length - 1].z).toBeCloseTo(c.through[0].z, 6) // and arrives at the mouth
  })

  it('stands on the ROAD when nothing can sample the terrain', () => {
    const highRoad = (s: number): Pose | null => (s < 0 || s > 5000 ? null : { x: s, y: 500, z: 12, dx: 1, dy: 0 })
    const c = connectFixture(loop({ at: [1000, 520], entry_s: 800, exit_s: 1200 }), highRoad)!
    expect(c.baseZ).toBe(12)
    expect(c.through[0].z).toBeCloseTo(12, 6)
  })

  it('adds the fixture lift on top of the ground, not instead of it', () => {
    const c = connectFixture(loop({ at: [1000, 520], lift_m: 5, entry_s: 800, exit_s: 1200 }), straightRoad, { groundAt: ground })!
    expect(c.through[0].z).toBeCloseTo(35, 6)
  })
})

/*
 * THE SURFACE AS NUMBERS — the same geometry the renderer draws and the physics collides with.
 *
 * Rich, 2026-09-29: *"the stunts are not drivable yet, we need to make them into actual roads"*.
 * Two consumers, one generator: if the collider were built from a second copy of this arithmetic,
 * the thing you see would eventually stop being the thing you hit, and a loop you fall through is
 * indistinguishable from a loop that is not there.
 */
describe('the drivable surface', () => {
  it('is two vertices per sample, the road width apart', () => {
    const path = fixturePath(loop(), 48)
    const { positions, indices } = ribbonGeometry(path, 5)
    expect(positions.length).toBe(path.length * 6)
    expect(indices.length).toBe((path.length - 1) * 6)
    for (let i = 0; i < path.length; i++) {
      const k = i * 6
      const w = Math.hypot(positions[k] - positions[k + 3], positions[k + 1] - positions[k + 4], positions[k + 2] - positions[k + 5])
      expect(w, `sample ${i}`).toBeCloseTo(10, 3)
    }
  })

  /*
   * THE PINCH. Taking "across" from the tangent crossed with WORLD UP collapses exactly where the
   * lane is vertical, which on a loop happens twice — the road necks to nothing at the top and the
   * bottom, and a car drives through the gap. The surface normal is what avoids it.
   */
  it('keeps its width where the lane is vertical, which is where the naive cross product dies', () => {
    const path = fixturePath(loop(), 160)
    const { positions } = ribbonGeometry(path, 5)
    let worst = Infinity
    for (let i = 0; i < path.length; i++) {
      const k = i * 6
      worst = Math.min(worst, Math.hypot(positions[k] - positions[k + 3], positions[k + 1] - positions[k + 4], positions[k + 2] - positions[k + 5]))
    }
    expect(worst).toBeGreaterThan(9.9)
    // and the lane really does go vertical, or this test proves nothing
    expect(Math.min(...path.map((p) => p.up!.z))).toBeLessThan(-0.9)
  })

  it('stitches the approach, the stunt and the exit into one mesh with valid indices', () => {
    const f = loop({ at: [1000, 520], entry_s: 800, exit_s: 1200 })
    const parts = connectFixture(f, straightRoad)!
    const g = fixtureGeometry(parts, 5)
    const verts = g.positions.length / 3
    expect(verts).toBe((parts.approach.length + parts.through.length + parts.departure.length) * 2)
    expect(g.indices.length).toBeGreaterThan(0)
    for (const i of g.indices) expect(i).toBeLessThan(verts)
    // the three runs are NOT welded into each other: no triangle may span two of them
    const approachVerts = parts.approach.length * 2
    for (let t = 0; t < g.indices.length; t += 3) {
      const inFirst = [0, 1, 2].map((k) => g.indices[t + k] < approachVerts)
      expect(inFirst[0] === inFirst[1] && inFirst[1] === inFirst[2], `triangle ${t / 3} spans two runs`).toBe(true)
    }
  })

  it('is empty for a path too short to be a surface', () => {
    expect(ribbonGeometry([], 5).positions.length).toBe(0)
    expect(ribbonGeometry([{ x: 0, y: 0, z: 0, dx: 1, dy: 0 }], 5).indices.length).toBe(0)
  })
})
