import { describe, expect, it } from 'vitest'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { SEG_LENGTH, SIM_DT } from '../src/sim/Tuning'
import { CURVE_UNIT } from '../src/render/RenderTuning'
import { builtinAsWorld, trackFromStage } from '../src/world/builtin'
import { compileTrack, curveToRadius, MAX_CURVE, radiusToCurve } from '../src/world/compile'
import { buildPath } from '../src/world/path'
import { WorldRoute } from '../src/world/Route'
import { SCENES, SCENE_IDS } from '../src/world/scenes'
import { checkWorld, emptyTrack, emptyWorld, reachable, routeLengthOf, type CoastTrack, type WorldData } from '../src/world/types'
import { VIBES, vibeAt, weatherAt } from '../src/world/vibes'
import { Stage } from '../src/sim/Road'
import { STAGES, THEMES } from '../src/sim/Stages'

/** A track whose centreline is a straight run of `metres`. */
function straight(metres: number, over: Partial<CoastTrack> = {}): CoastTrack {
  return {
    ...emptyTrack('t', 'Straight'),
    nodes: [
      { x: 0, z: 0, y: 0 },
      { x: 0, z: metres / 2, y: 0 },
      { x: 0, z: metres, y: 0 },
    ],
    ...over,
  }
}

/** A track that follows a circle of `radius` through `degrees`. */
function arc(radius: number, degrees: number, steps = 8): CoastTrack {
  const nodes = []
  for (let i = 0; i <= steps; i++) {
    const a = (degrees * Math.PI) / 180 / steps * i
    nodes.push({ x: radius * (1 - Math.cos(a)), z: radius * Math.sin(a), y: 0 })
  }
  return { ...emptyTrack('t', 'Arc'), nodes }
}

describe('centreline', () => {
  it('measures a straight run and keeps it straight', () => {
    const p = buildPath(straight(1200).nodes)
    expect(p.length).toBeCloseTo(1200, 0)
    for (const s of [0, 300, 600, 1199]) expect(p.headingAt(s)).toBeCloseTo(0, 4)
  })

  it('measures an arc close to its true length', () => {
    const r = 1000
    const p = buildPath(arc(r, 90).nodes)
    expect(p.length).toBeGreaterThan(((Math.PI / 2) * r) * 0.98)
    expect(p.length).toBeLessThan(((Math.PI / 2) * r) * 1.02)
    // Very nearly a quarter turn: the end handles run along the last chord rather than
    // the true tangent, so the traced heading falls half a step short at each end.
    const turned = p.headingAt(p.length) - p.headingAt(0)
    expect(turned).toBeGreaterThan(Math.PI / 2 * 0.85)
    expect(turned).toBeLessThan(Math.PI / 2 * 1.01)
  })

  it('reports arc position and lateral offset of a point beside the road', () => {
    const p = buildPath(straight(1000).nodes)
    const near = p.nearest(20, 400)
    expect(near.s).toBeCloseTo(400, 0)
    expect(near.lateral).toBeCloseTo(20, 1)
    expect(p.nearest(-15, 700).lateral).toBeCloseTo(-15, 1)
  })

  it('holds an elevation hump instead of overshooting it', () => {
    const p = buildPath([
      { x: 0, z: 0, y: 0 },
      { x: 0, z: 300, y: 30 },
      { x: 0, z: 600, y: 30 },
      { x: 0, z: 900, y: 0 },
    ])
    for (let s = 0; s <= p.length; s += 10) {
      expect(p.elevationAt(s)).toBeGreaterThanOrEqual(-0.001)
      expect(p.elevationAt(s)).toBeLessThanOrEqual(30.001)
    }
    expect(p.elevationAt(450)).toBeCloseTo(30, 1)
  })

  it('mirrors a handle on a smooth node and leaves a cusp alone', () => {
    const smooth = buildPath([
      { x: 0, z: 0, y: 0 },
      { x: 0, z: 100, y: 0, outX: 60, outZ: 0 },
      { x: 0, z: 200, y: 0 },
    ])
    const cusp = buildPath([
      { x: 0, z: 0, y: 0 },
      { x: 0, z: 100, y: 0, outX: 60, outZ: 0, cusp: true },
      { x: 0, z: 200, y: 0 },
    ])
    // The mirrored in-handle bends the first span too, so the smooth road is longer.
    expect(smooth.length).toBeGreaterThan(cusp.length)
  })
})

describe('compiler', () => {
  it('turns a straight track into straight segments of the right length', () => {
    const { stage, report } = compileTrack(straight(1200), 1)
    expect(report.segments).toBe(Math.round(1200 / SEG_LENGTH))
    expect(stage.length).toBe(report.segments)
    for (let i = 0; i < stage.length; i++) expect(Math.abs(stage.segments[i].curve)).toBeLessThan(0.01)
    // A runway still hangs off the end for the horizon.
    expect(stage.segments.length).toBeGreaterThan(stage.length)
    expect(stage.segments[stage.segments.length - 1].runway).toBe(true)
  })

  it('gives an arc the curve its radius calls for', () => {
    const r = 1200
    const { stage } = compileTrack(arc(r, 90), 1)
    const want = radiusToCurve(r)
    // Sample the middle of the arc, clear of the eased ends.
    const mid = Math.floor(stage.length / 2)
    const got = stage.segments[mid].curve
    expect(got).toBeGreaterThan(want * 0.85)
    expect(got).toBeLessThan(want * 1.15)
    expect(curveToRadius(got)).toBeGreaterThan(r * 0.85)
  })

  it('opens out a corner the car could never hold, and says so', () => {
    const { stage, report } = compileTrack(arc(120, 90), 1)
    expect(report.clamped).toBeGreaterThan(0)
    expect(report.problems.join(' ')).toMatch(/opened out/)
    for (let i = 0; i < stage.length; i++) expect(Math.abs(stage.segments[i].curve)).toBeLessThanOrEqual(MAX_CURVE + 1e-6)
  })

  it('ends level so stages join without a step', () => {
    const t = straight(1200)
    t.nodes[1].y = 40
    t.nodes[2].y = 25
    const { stage } = compileTrack(t, 1)
    expect(Math.abs(stage.segments[stage.length - 1].y1)).toBeLessThan(0.6)
  })

  it('lays scene stops along the track and indexes them per segment', () => {
    const t = straight(3000, { scenes: [{ at: 0, scene: 'coast' }, { at: 0.5, scene: 'city' }] })
    const { stage } = compileTrack(t, 1)
    expect(stage.scenes.map((s) => s.id)).toEqual(['coast', 'city'])
    expect(stage.segments[10].scene).toBe(0)
    expect(stage.segments[stage.length - 10].scene).toBe(1)
    expect(stage.themeAt(100).id).toBe('coast')
    expect(stage.themeAt(stage.metres - 100).id).toBe('city')
    // The city scene is four lanes; the coast three. Width follows the scene.
    expect(stage.scenes[1].lanes).toBe(4)
  })

  it('builds the macro elements: ocean front, tunnel, roadworks, crossings', () => {
    const t = straight(3000, {
      spans: [
        { kind: 'shore', from: 0.1, to: 0.2, side: 1 },
        { kind: 'tunnel', from: 0.4, to: 0.45 },
        { kind: 'workzone', from: 0.6, to: 0.72, side: -1 },
      ],
      crossings: [{ at: 0.85 }],
    })
    const { stage } = compileTrack(t, 1)
    const segs = stage.segments
    expect(segs.some((s) => s.shore === 1)).toBe(true)
    expect(segs.filter((s) => s.tunnel).length).toBeGreaterThan(10)
    expect(segs.some((s) => s.portal)).toBe(true)
    expect(segs.filter((s) => s.closed === -1).length).toBeGreaterThan(10)
    // A jersey barrier run is bracketed by leading and trailing barrier tapers.
    const barriers = segs.filter((s) => s.sprites.some((p) => p.kind === 'barrier'))
    expect(barriers.length).toBeGreaterThanOrEqual(8)
    expect(segs.filter((s) => s.crossing).length).toBe(2)
    // Nothing grows in a tunnel or in the sea.
    for (const s of segs) if (s.tunnel) expect(s.sprites.length).toBe(0)
    for (const s of segs) if (s.shore === 1) expect(s.sprites.every((p) => p.offset < 0)).toBe(true)
  })

  it('keeps hand-placed props exactly where they were put', () => {
    const t = straight(2000, { props: [{ kind: 'rockTall', at: 0.5, offset: -1.8, scale: 2 }] })
    const { stage } = compileTrack(t, 1)
    const hit = stage.segments.filter((s) => s.sprites.some((p) => p.kind === 'rockTall' && p.scale === 2))
    expect(hit.length).toBe(1)
    expect(hit[0].index / stage.length).toBeCloseTo(0.5, 1)
  })

  it('splits the road at the end when the track forks', () => {
    const t = straight(2000, { next: ['a', 'b'] })
    const { stage } = compileTrack(t, 1)
    expect(stage.forks).toBe(true)
    expect(stage.segments[stage.length - 1].fork).toBeCloseTo(1, 5)
    expect(stage.segments[0].fork).toBe(-1)
  })

  it('is deterministic for a seed and only the scatter depends on it', () => {
    const t = straight(2400)
    const a = compileTrack(t, 5).stage
    const b = compileTrack(t, 5).stage
    const c = compileTrack(t, 9).stage
    expect(a.segments.map((s) => s.sprites.length)).toEqual(b.segments.map((s) => s.sprites.length))
    expect(a.segments.map((s) => s.curve)).toEqual(c.segments.map((s) => s.curve))
  })

  it('every scene in the palette compiles and grows something', () => {
    for (const id of SCENE_IDS) {
      const { stage } = compileTrack(straight(2400, { scenes: [{ at: 0, scene: id }] }), 3)
      const sprites = stage.segments.reduce((n, s) => n + s.sprites.length, 0)
      expect(sprites, `${id} grew nothing`).toBeGreaterThan(20)
      expect(SCENES[id].theme.lanes).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('vibes', () => {
  it('holds the first vibe before any change', () => {
    const stops = [{ at: 0, vibe: 'day' }, { at: 0.6, vibe: 'night' }]
    expect(vibeAt(stops, 0).id).toBe('day')
    expect(vibeAt(stops, 0.3).id).toBe('day')
    expect(vibeAt(stops, 1).id).toBe('night')
  })

  it('slides night in across the fade rather than cutting to it', () => {
    const stops = [{ at: 0, vibe: 'day' }, { at: 0.5, vibe: 'night', fade: 0.2 }]
    const out = { night: 0, rain: 0 }
    weatherAt(stops, 0.35, out)
    expect(out.night).toBeCloseTo(0, 3)
    weatherAt(stops, 0.5, out)
    expect(out.night).toBeCloseTo(0.5, 1)
    weatherAt(stops, 0.65, out)
    expect(out.night).toBeCloseTo(1, 3)
    // Monotone through the transition: no flicker back to daylight.
    let prev = -1
    for (let at = 0.3; at <= 0.7; at += 0.02) {
      weatherAt(stops, at, out)
      expect(out.night).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = out.night
    }
  })

  it('can shift twice along one track, Rad Mobile style', () => {
    const stops = [{ at: 0, vibe: 'day' }, { at: 0.4, vibe: 'sunset' }, { at: 0.8, vibe: 'rainNight' }]
    const out = { night: 0, rain: 0 }
    weatherAt(stops, 0.1, out)
    expect(out.night).toBeCloseTo(0, 3)
    weatherAt(stops, 0.5, out)
    expect(out.night).toBeCloseTo(VIBES.sunset.night, 2)
    expect(out.rain).toBeCloseTo(0, 3)
    weatherAt(stops, 0.95, out)
    expect(out.night).toBeCloseTo(1, 2)
    expect(out.rain).toBeCloseTo(1, 2)
  })

  it('every vibe is a complete definition', () => {
    for (const [id, v] of Object.entries(VIBES)) {
      expect(v.id).toBe(id)
      expect(v.night).toBeGreaterThanOrEqual(0)
      expect(v.night).toBeLessThanOrEqual(1)
      expect(v.rain).toBeGreaterThanOrEqual(0)
      expect(v.fogK).toBeGreaterThan(0)
      expect(v.sunPos).toHaveLength(2)
    }
  })
})

describe('track sets', () => {
  const world = (): WorldData => ({
    v: 1,
    name: 'Set',
    start: 'a',
    tracks: [
      { ...straight(1200), id: 'a', name: 'Start', next: ['b1', 'b2'] },
      { ...straight(1200), id: 'b1', name: 'Left', next: ['end'] },
      { ...straight(1200), id: 'b2', name: 'Right', next: ['end'] },
      { ...straight(1200), id: 'end', name: 'Finish', next: [] },
    ],
  })

  it('walks a branch that rejoins a common last stage', () => {
    const w = world()
    expect(checkWorld(w)).toEqual([])
    expect(reachable(w).map((t) => t.id)).toEqual(['a', 'b1', 'b2', 'end'])
    expect(routeLengthOf(w, 'a')).toBe(3)
  })

  it('rejects a route that loops or points nowhere', () => {
    const looped = world()
    looped.tracks[3].next = ['a']
    expect(checkWorld(looped).some((p) => p.text.includes('loops'))).toBe(true)
    const broken = world()
    broken.tracks[1].next = ['nope']
    expect(checkWorld(broken).some((p) => p.text.includes('missing track'))).toBe(true)
    const tripleFork = world()
    tripleFork.tracks[0].next = ['b1', 'b2', 'end']
    expect(checkWorld(tripleFork).some((p) => p.text.includes('at most two'))).toBe(true)
  })

  it('warns about a track nothing leads to', () => {
    const w = world()
    w.tracks.push({ ...straight(1200), id: 'orphan', name: 'Orphan', next: [] })
    expect(checkWorld(w).some((p) => p.level === 'warn' && p.text.includes('Orphan'))).toBe(true)
  })

  it('a fresh world is drivable as it stands', () => {
    expect(checkWorld(emptyWorld())).toEqual([])
  })
})

describe('driving an authored world', () => {
  const w: WorldData = {
    v: 1,
    name: 'Two stages',
    start: 'a',
    tracks: [
      { ...straight(1200), id: 'a', name: 'One', next: ['b'], scenes: [{ at: 0, scene: 'coast' }], vibes: [{ at: 0, vibe: 'day' }, { at: 0.7, vibe: 'night' }] },
      { ...straight(1200), id: 'b', name: 'Two', next: [] },
    ],
  }

  it('runs the sim through a checkpoint and on to the finish', () => {
    const sim = new Sim(3, 'a', new WorldRoute(w, 3))
    const snap = new Snapshot()
    const input = makeInputFrame()
    input.throttle = 1
    const seen: string[] = []
    // Straight into the traffic with no steering: it may well crash, and a crash is
    // survivable — what matters is that the route runs on through the checkpoint.
    for (let i = 0; i < 120 * 90 && snap.phase !== 'finished' && snap.phase !== 'timeout'; i++) {
      sim.tick(SIM_DT, input, snap)
      sim.events.drain((e) => seen.push(e.type))
    }
    expect(seen).toContain('checkpoint')
    expect(snap.phase).toBe('finished')
    expect(sim.route).toEqual(['a', 'b'])
    expect(snap.hud.stagesTotal).toBe(2)
  })

  it('brings night on part-way along the first track', () => {
    const sim = new Sim(3, 'a', new WorldRoute(w, 3))
    const snap = new Snapshot()
    const input = makeInputFrame()
    input.throttle = 1
    expect(snap.night).toBe(0)
    let lateNight = 0
    for (let i = 0; i < 120 * 60; i++) {
      sim.tick(SIM_DT, input, snap)
      if (snap.stageId === 'a') lateNight = Math.max(lateNight, snap.night)
      if (snap.stageId !== 'a') break
    }
    expect(lateNight).toBeGreaterThan(0.9)
  })

  it('falls back to the built-in route when the world is empty', () => {
    const sim = new Sim(1, 'zzz', new WorldRoute({ v: 1, name: 'x', start: 'a', tracks: [{ ...straight(1200), id: 'a', name: 'One', next: [] }] }, 1))
    expect(sim.startId).toBe('a')
  })
})

describe('forking the built-in route', () => {
  it('traces every stage into waypoints that drive about the same road', () => {
    const w = builtinAsWorld()
    expect(w.tracks.length).toBe(STAGES.length)
    expect(checkWorld(w).filter((p) => p.level === 'error')).toEqual([])
    for (const desc of STAGES) {
      const original = new Stage(desc, THEMES[desc.theme], 7)
      const traced = w.tracks.find((t) => t.id === desc.id)!
      const { stage } = compileTrack(traced, 7)
      // Within a few per cent of the original's length, and the same shape of route.
      const ratio = stage.metres / original.metres
      expect(ratio, `${desc.id} length ${ratio.toFixed(2)}×`).toBeGreaterThan(0.9)
      expect(ratio, `${desc.id} length ${ratio.toFixed(2)}×`).toBeLessThan(1.1)
      expect(stage.desc.next).toEqual(desc.next)
      expect(traced.nodes.length).toBeGreaterThan(4)
    }
  })

  it('keeps the tunnels and the shoreline it found', () => {
    const w = builtinAsWorld()
    const cliff = w.tracks.find((t) => t.id === 'B2')!
    expect(cliff.spans.some((s) => s.kind === 'tunnel')).toBe(true)
    const coast = w.tracks.find((t) => t.id === 'A')!
    expect(coast.spans.some((s) => s.kind === 'shore')).toBe(true)
  })

  it('reads the theme flags back as a vibe', () => {
    const w = builtinAsWorld()
    expect(w.tracks.find((t) => t.id === 'B1')!.vibes[0].vibe).toBe('sunset')
    expect(w.tracks.find((t) => t.id === 'E2')!.vibes[0].vibe).toBe('neon')
    expect(w.tracks.find((t) => t.id === 'C2')!.vibes[0].vibe).toBe('day')
  })

  it('traces one stage on its own too', () => {
    const desc = STAGES[0]
    const t = trackFromStage(new Stage(desc, THEMES[desc.theme], 1), THEMES[desc.theme])
    expect(t.id).toBe('A')
    expect(t.nodes[0].x).toBe(0)
    expect(Math.abs(t.nodes[t.nodes.length - 1].y)).toBeLessThan(1)
  })
})

describe('curve scale', () => {
  it('agrees with the hand-authored stages about what curve 3 means', () => {
    // The renderer accumulates curve × CURVE_UNIT per segment as a heading change.
    expect(curveToRadius(3)).toBeCloseTo((SEG_LENGTH * SEG_LENGTH) / (3 * CURVE_UNIT), 3)
    expect(radiusToCurve(curveToRadius(4.5))).toBeCloseTo(4.5, 6)
    // Everything the built-in stages ask for is inside what the editor allows.
    for (const s of STAGES) for (const sec of s.sections) if ('curve' in sec && sec.curve) expect(Math.abs(sec.curve)).toBeLessThan(MAX_CURVE)
  })
})
