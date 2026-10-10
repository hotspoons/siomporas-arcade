// Is an authored document in the bake's frame? Measured against the roads, not guessed from a date.
//
// Rich, 2026-10-10, about a banner over dc-metro-take-2's five Beltway zones — written over MCP on
// 2026-10-08 in exactly the frame the bake serves, but unstamped, so the old rule said they were
// probably from before 2026-09-22: "This screenshot about zones.json is bullshit."
//
// And 2026-09-30, on a brand new bake: a file with no coordinates cannot be in the wrong frame.
import { describe, expect, it } from 'vitest'
import { checkFrame, judgeFrame, measureFrame, oldFrameMove, RoadIndex, stationsOf, type BakeFrame, type FrameMeasure, type RoadStation, type Shapes } from '../src/editor/store/framecheck'

// dc-metro-take-2's own frame block (its manifest, 2026-10-10)
const dc: BakeFrame = { kind: 'enu', epsg: 32618, anchor: { lon: -77.005045, lat: 38.911621 }, utm_convergence_deg: 1.2597258, utm_scale: 1.0000245797 }
const move = oldFrameMove(dc)!
/** new → old: what a document written before 2026-09-22 holds for a place that is `p` today */
const unmove = ([x, y]: [number, number]): [number, number] => {
  const t = (-dc.utm_convergence_deg! * Math.PI) / 180, s = 1 / dc.utm_scale!
  return [s * (Math.cos(t) * x - Math.sin(t) * y), s * (Math.sin(t) * x + Math.cos(t) * y)]
}

/**
 * A Beltway-like road running EAST from 8 to 12 km out, stations every 10 m. Radial on purpose: the
 * old frame is a turn about the anchor, so it moves things ACROSS a radial road (220 m at 10 km)
 * and only ALONG a road that circles the anchor — where, rightly, the roads cannot tell.
 */
const ROAD: RoadStation[] = Array.from({ length: 401 }, (_, i) => ({ x: 8_000 + i * 10, y: 0, half: 15 }))
const roads = new RoadIndex(ROAD)
/** A 90 m strip around a kilometre of it, drawn down one side and back up the other — what MCP's traffic_zone_add writes. */
const strip = (x0: number): [number, number][] => [[x0, -45], [x0 + 1_000, -45], [x0 + 1_000, 45], [x0, 45]]
const zones = (rings: [number, number][][]): Shapes => ({ polygons: rings.map((ring, i) => ({ id: `z-0${i + 1}`, ring })), points: [] })

describe('oldFrameMove', () => {
  it('is the bake’s recorded fit: pyproj’s answer at dc-metro to a quarter of a metre at 10 km', () => {
    // tools/corridor geo.Frame.to_enu for UTM origin + (10 000, 0) and (0, 10 000)
    const [e1, n1] = move([10_000, 0])
    expect(Math.hypot(e1 - 9998.067, n1 - 219.857)).toBeLessThan(0.3)
    const [e2, n2] = move([0, 10_000])
    expect(Math.hypot(e2 - -220.066, n2 - 9997.853)).toBeLessThan(0.3)
  })
  it('has nothing to offer for a bake that is not ENU, or that recorded no fit', () => {
    expect(oldFrameMove({ kind: 'utm' })).toBeNull()
    expect(oldFrameMove({ kind: 'enu' })).toBeNull()
    expect(oldFrameMove(undefined)).toBeNull()
  })
})

describe('RoadIndex', () => {
  it('measures to the pavement edge, negative on it, capped', () => {
    expect(roads.distance(10_000, 0)).toBeCloseTo(-15)
    expect(roads.distance(10_000, 35)).toBeCloseTo(20)
    expect(roads.distance(0, 0)).toBe(200)
  })
  it('counts the stations inside a polygon', () => {
    expect(roads.inside(strip(9_005))).toBe(100)
    expect(roads.inside([[0, 0], [10, 0], [10, 10]])).toBe(0)
  })
  it('samples a chain in the site frame (world z is minus north)', () => {
    const st = stationsOf([{ length_m: 100, half: 4, at: (s) => ({ pos: { x: s, z: -50 } }) }])
    expect(st).toHaveLength(11)
    expect(st[3]).toEqual({ x: 30, y: 50, half: 4 })
  })
})

describe('checkFrame', () => {
  const lazy = () => roads
  it('says nothing about a file with no coordinates in it, stamped or not', () => {
    expect(checkFrame(undefined, dc, { polygons: [], points: [] }, lazy).state).toBe('stamped')
    expect(checkFrame({ kind: 'utm' }, dc, { polygons: [], points: [] }, lazy).state).toBe('stamped')
  })

  it('does not measure a file stamped in the frame the bake serves', () => {
    let built = false
    const v = checkFrame({ kind: 'enu', anchor: dc.anchor }, dc, zones([strip(9_000)]), () => { built = true; return roads })
    expect(v.state).toBe('stamped')
    expect(built).toBe(false)
  })

  it('THE DC CASE: unstamped zones lying on the road as written fit, and get no banner', () => {
    const v = checkFrame(undefined, dc, zones([strip(8_500), strip(9_600), strip(10_700)]), lazy, 'zones')
    expect(v.state).toBe('fits')
    if (v.state === 'fits') expect(v.measure).toMatchObject({ n: 3, onNow: 3, onOld: 0, betterNow: 3, roadNow: 300, roadOld: 0 })
  })

  it('unstamped zones written in the old frame are shown, with the numbers and a move that puts them back', () => {
    const old = [strip(8_500), strip(9_600), strip(10_700)].map((r) => r.map(unmove))
    const v = checkFrame(undefined, dc, zones(old), lazy, 'zones')
    expect(v.state).toBe('old')
    if (v.state !== 'old') return
    expect(v.measure).toMatchObject({ n: 3, onNow: 0, onOld: 3, betterOld: 3 })
    expect(v.message).toMatch(/3 of 3 zones \(z-01, z-02, z-03\) sit on the roads better in the pre-2026-09-22 frame than as they are written — 0\.0 km of road inside them as written, 3\.0 km after the turn/)
    expect(v.message).toMatch(/1\.26°/)
    // ~220 m: the turn at 10 km out
    expect(v.measure.shift).toBeGreaterThan(150)
    // and the move really does put them back where they belong
    const back = old[0].map(v.move)
    back.forEach((p, i) => expect(Math.hypot(p[0] - strip(8_500)[i][0], p[1] - strip(8_500)[i][1])).toBeLessThan(0.01))
  })

  it('a file STAMPED "utm" under an ENU bake is measured too, not trusted blindly either way', () => {
    const old = [strip(8_500)].map((r) => r.map(unmove))
    expect(checkFrame({ kind: 'utm' }, dc, zones(old), lazy).state).toBe('old')
    // stamped utm but measuring on the road as written: the stamp is what is wrong
    expect(checkFrame({ kind: 'utm' }, dc, zones([strip(8_500)]), lazy).state).toBe('fits')
  })

  it('says nothing when the roads cannot tell — nothing near a road either way', () => {
    const v = checkFrame(undefined, dc, zones([[[0, 5_000], [100, 5_000], [100, 5_100]]]), lazy)
    expect(v.state).toBe('unknown')
  })

  it('near the anchor the two frames agree, so whatever it was written in is right', () => {
    const near = new RoadIndex(Array.from({ length: 41 }, (_, i) => ({ x: 100, y: -200 + i * 10, half: 10 })))
    const v = checkFrame(undefined, dc, { polygons: [], points: [{ id: 'p', at: [150, 0] }] }, () => near)
    expect(v.state).toBe('fits')
  })

  it('measures points by distance: a kerbside start written in the old frame is caught', () => {
    const pts = [{ id: 'start', at: unmove([9_000, 20]) }, { id: 'finish', at: unmove([11_500, -15]) }]
    const v = checkFrame(undefined, dc, { polygons: [], points: pts }, lazy, 'points')
    expect(v.state).toBe('old')
    if (v.state === 'old') expect(v.message).toMatch(/start, finish/)
    expect(checkFrame(undefined, dc, { polygons: [], points: [{ id: 'start', at: [9_000, 20] }] }, lazy).state).toBe('fits')
  })

  it('a different anchor is reported, not "repaired"', () => {
    const v = checkFrame({ kind: 'enu', anchor: { lon: -76.7, lat: 39 } }, dc, zones([strip(9_000)]), lazy)
    expect(v.state).toBe('other')
    if (v.state === 'other') expect(v.message).toMatch(/different anchor/)
  })

  it('an ENU bake with no recorded fit, or no roads: nothing to measure against, nothing to say', () => {
    expect(checkFrame(undefined, { kind: 'enu', anchor: dc.anchor }, zones([strip(9_000)]), lazy).state).toBe('unknown')
    expect(checkFrame(undefined, dc, zones([strip(9_000)]), () => null).state).toBe('unknown')
  })
})

describe('judgeFrame', () => {
  const m = (o: Partial<FrameMeasure>): FrameMeasure => ({ n: 4, onNow: 0, onOld: 0, betterNow: 0, betterOld: 0, roadNow: 0, roadOld: 0, shift: 200, movedOn: [], ...o })
  it('needs the roads to say "old" clearly: half better after the turn, and at most half as many better as written', () => {
    expect(judgeFrame(m({ onNow: 1, onOld: 4, betterNow: 1, betterOld: 3 }))).toBe('old')
    expect(judgeFrame(m({ onNow: 2, onOld: 4, betterNow: 2, betterOld: 2 }))).toBe('fits')
    expect(judgeFrame(m({ onOld: 1, betterOld: 1 }))).toBe('unknown')
    expect(judgeFrame(m({ onNow: 4, onOld: 4 }))).toBe('fits')
    expect(judgeFrame(m({ n: 0 }))).toBe('unknown')
    expect(judgeFrame(m({ onOld: 4, betterOld: 4, shift: 3 }))).toBe('fits')
  })
  it('the measurement itself can fail: a strip off the road counts as off', () => {
    const r = measureFrame(zones([strip(9_000).map(([x, y]) => [x, y + 300] as [number, number])]), roads, (p) => p)
    expect(r.onNow).toBe(0)
  })
})

describe('a ring road around the anchor — the Beltway', () => {
  // dc-metro-take-2's anchor is downtown and the Beltway circles it 15–20 km out, so the old-frame
  // turn slides a zone mostly ALONG the road. Covering "some road" is true either way; covering ALL
  // of it is what tells the frames apart. Measured on the real file: z-01 covers 1000 stations as
  // written and 528 after the turn; an off-frame copy of it covers 509 as written and 1000 after.
  //
  // The ring is OFF-CENTRE, as the Beltway is: a ring centred exactly on the anchor maps onto
  // itself under any turn about it, and then nothing could tell the frames apart — rightly.
  const R = 15_000, CX = 4_000, CY = -2_500
  const ring: RoadStation[] = Array.from({ length: Math.ceil((2 * Math.PI * R) / 10) }, (_, i) => {
    const t = (i * 10) / R
    return { x: CX + R * Math.cos(t), y: CY + R * Math.sin(t), half: 18 }
  })
  const beltway = new RoadIndex(ring)
  /** a 90 m strip along the ring from angle t0 to t1 */
  const arc = (t0: number, t1: number): [number, number][] => {
    const out: [number, number][] = [], back: [number, number][] = []
    for (let t = t0; t <= t1 + 1e-9; t += (t1 - t0) / 40) {
      out.push([CX + (R - 45) * Math.cos(t), CY + (R - 45) * Math.sin(t)])
      back.push([CX + (R + 45) * Math.cos(t), CY + (R + 45) * Math.sin(t)])
    }
    return [...out, ...back.reverse()]
  }
  // five zones of ~1 km each, round the ring
  const five = [0.3, 1.5, 2.6, 3.9, 5.2].map((t) => arc(t, t + 1_000 / R))
  it('zones on the ring as written fit', () => {
    const v = checkFrame(undefined, dc, zones(five), () => beltway, 'zones')
    expect(v.state).toBe('fits')
    if (v.state === 'fits') {
      // some are still on road after the turn — which is why "on a road" alone could not decide
      expect(v.measure!.onOld).toBeGreaterThan(0)
      expect(v.measure!.roadNow).toBeGreaterThan(v.measure!.roadOld * 1.25)
    }
  })
  it('an off-frame copy of them is caught, by how much road it covers', () => {
    const v = checkFrame(undefined, dc, zones(five.map((r) => r.map(unmove))), () => beltway, 'zones')
    expect(v.state).toBe('old')
  })
})
