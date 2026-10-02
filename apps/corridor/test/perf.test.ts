// The performance panel's arithmetic: does it report the tail, and does it keep its own cost down?
//
// Rich, 2026-09-29: *"a performance stats display that includes FPS, memory, p95/p99 info, cpu
// time"*. The reason p95 and p99 are on that list is that the average hides exactly the thing you
// feel — so the tests that matter are the ones about a run that is mostly fine.
import { describe, expect, it } from 'vitest'
import {
  BUDGET_MS, frameColour, perfLines, percentile, PerfMeter, short, STALL_MS, summarize,
} from '../src/game/session/perf'

describe('percentiles', () => {
  it('reports a value that really happened, rather than interpolating one', () => {
    const ms = [10, 11, 12, 13, 100]
    // nearest rank: no frame took 41 ms, so no percentile may claim 41 ms
    expect(percentile(ms, 0.5)).toBe(12)
    expect(percentile(ms, 0.95)).toBe(100)
    expect(ms).toEqual([10, 11, 12, 13, 100]) // and the caller's array is untouched
  })

  it('is empty-safe, because a panel opens before a frame has been drawn', () => {
    expect(percentile([], 0.99)).toBe(0)
    expect(summarize([])).toMatchObject({ frames: 0, fps: 0, p99: 0 })
  })
})

describe('a summary of a window of frames', () => {
  /*
   * THE CASE THE WHOLE PANEL EXISTS FOR. Ninety-nine frames at 60 fps and one frame of 500 ms
   * averages to 21 ms — which reads as "47 fps, a bit slow" and feels like a hitch you would file a
   * bug about. The p99 and the stall counter are what tell the truth.
   */
  it('shows a hitch that the average hides', () => {
    const ms = [...Array(99).fill(16.7), 500]
    const s = summarize(ms)
    expect(s.p50).toBeCloseTo(16.7, 1)
    expect(s.p99).toBeCloseTo(16.7, 1) // the 99th of 100 is still a good frame
    expect(s.max).toBe(500)
    expect(s.stalls).toBe(1)
    // time lost is measured against the budget, not against zero: the frame owed us 16.7 ms anyway
    expect(s.stallMs).toBeCloseTo(500 - BUDGET_MS, 1)
    // and the average alone would have said this was merely slow
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length
    expect(1000 / mean).toBeGreaterThan(40)
  })

  it('counts fps as frames over the time they took, not as 1000 / mean', () => {
    // ten frames covering exactly one second is ten frames a second, however uneven they were
    const s = summarize([...Array(9).fill(50), 550])
    expect(s.sec).toBeCloseTo(1, 3)
    expect(s.fps).toBeCloseTo(10, 3)
  })

  it('calls a frame a stall only at the threshold', () => {
    expect(summarize([STALL_MS - 0.1]).stalls).toBe(0)
    expect(summarize([STALL_MS]).stalls).toBe(1)
  })
})

describe('the meter', () => {
  it('keeps a fixed window rather than growing for as long as the panel is open', () => {
    const m = new PerfMeter(8)
    for (let i = 0; i < 100; i++) m.frame(16 + i)
    const w = m.window()
    expect(w.length).toBe(8)
    // and it is the LAST eight, oldest first
    expect(w[0]).toBe(16 + 92)
    expect(w[7]).toBe(16 + 99)
  })

  it('fills in order before it wraps', () => {
    const m = new PerfMeter(8)
    m.frame(10)
    m.frame(20)
    expect(m.window()).toEqual([10, 20])
  })

  it('ignores a frame time that is not one', () => {
    const m = new PerfMeter(4)
    m.frame(NaN)
    m.frame(0)
    m.frame(-5)
    m.frame(Infinity)
    expect(m.window()).toEqual([])
  })

  it('averages the cpu time the caller measured', () => {
    const m = new PerfMeter(4)
    m.frame(16, 4)
    m.frame(16, 6)
    expect(m.read().cpuMs).toBeCloseTo(5, 6)
  })

  it('reads a whole panel out of one window', () => {
    const m = new PerfMeter(200)
    for (let i = 0; i < 120; i++) m.frame(16.7)
    m.frame(80)
    m.counts = { calls: 412, triangles: 2_400_000, lines: 0, points: 0, geometries: 900, textures: 60, programs: 21 }
    const r = m.read()
    expect(r.frames).toBe(121)
    expect(r.stalls).toBe(1)
    const lines = perfLines(r)
    expect(lines[0]).toMatch(/fps/)
    expect(lines[1]).toMatch(/p95/)
    expect(lines[2]).toMatch(/2.40M tris/)
    expect(lines.join(' ')).toMatch(/1 stalls/)
  })

  /*
   * A PANEL WITH NOTHING TO SAY SAYS NOTHING. A "0 stalls" line on every frame of a clean run is a
   * line you stop reading, and then you do not notice when it says 3.
   */
  it('leaves the stall line out of a clean run', () => {
    const m = new PerfMeter(100)
    for (let i = 0; i < 60; i++) m.frame(16.7)
    expect(perfLines(m.read()).join(' ')).not.toMatch(/stall/)
  })

  it('starts again when asked', () => {
    const m = new PerfMeter(10)
    for (let i = 0; i < 5; i++) m.frame(16)
    m.longTasks = 3
    m.reset()
    expect(m.window()).toEqual([])
    expect(m.read().longTasks).toBe(0)
  })
})

describe('reading it at a glance', () => {
  it('shortens big counters', () => {
    expect(short(412)).toBe('412')
    expect(short(2400)).toBe('2.4k')
    expect(short(2_400_000)).toBe('2.40M')
  })

  it('colours a frame against 60 and 30 fps, not against the average', () => {
    expect(frameColour(16.7)).toBe(frameColour(10))
    expect(frameColour(25)).not.toBe(frameColour(10))
    expect(frameColour(60)).not.toBe(frameColour(25))
  })
})

/* ---- when the splat order has to be rebuilt -------------------------------------------------- */

/*
 * Rich, 2026-09-29, from the panel: *"the splats sorting frequency seems to be driving the stalls…
 * I don't understand why the sort needs to be run at all, or at least as often as it is."*
 *
 * It has to run because gaussians are alpha-blended and the blend is order-dependent. It does NOT
 * have to run every frame: a radial order changes only when the camera moves, and how far it may
 * move before the order is wrong is a fraction of the distance to the content.
 */
describe('how often a capture has to be re-sorted', () => {
  it('scales with how far away the capture is', async () => {
    const { resortAfter } = await import('../src/visuals/splatsort')
    // parked inside it: centimetres. A street away: metres.
    expect(resortAfter(5, { parallax: 0.02, min: 0.25, max: 8 })).toBeCloseTo(0.25, 6)
    expect(resortAfter(100, { parallax: 0.02, min: 0.25, max: 8 })).toBeCloseTo(2, 6)
    expect(resortAfter(1000, { parallax: 0.02, min: 0.25, max: 8 })).toBeCloseTo(8, 6)
  })

  it('still re-sorts eventually when nothing is loaded near you', async () => {
    const { resortAfter } = await import('../src/visuals/splatsort')
    expect(resortAfter(Infinity, { parallax: 0.02, min: 0.25, max: 8 })).toBe(8)
  })
})

describe('when a re-sort is actually asked for', () => {
  const opts = { minMs: 500, parallax: 0.02, min: 0.25, max: 8, turnDeg: 90 }

  /*
   * THE CASE RICH CAUGHT. At 180 mph — 80 m/s — a distance rule alone fires forty times a second,
   * which is the opposite of what a fast game wants. The timer has to be the floor.
   */
  it('never sorts more often than the timer, however fast you are going', async () => {
    const { shouldResort } = await import('../src/visuals/splatsort')
    const perFrame = 80 / 60 // metres covered in one frame at 180 mph
    expect(shouldResort(16, perFrame, 0, 100, opts)).toBe(false)
    expect(shouldResort(499, perFrame * 30, 0, 100, opts)).toBe(false)
    expect(shouldResort(500, perFrame * 30, 0, 100, opts)).toBe(true)
  })

  it('and does not sort at all when the camera has not moved', async () => {
    const { shouldResort } = await import('../src/visuals/splatsort')
    // an hour parked, a centimetre of drift: a radial order has not changed
    expect(shouldResort(3_600_000, 0.01, 0, 100, opts)).toBe(false)
    expect(shouldResort(3_600_000, 0, 0, 5, opts)).toBe(false)
  })

  it('lets a slow crawl through a capture re-sort, because that is where parallax is', async () => {
    const { shouldResort } = await import('../src/visuals/splatsort')
    // half a metre at walking pace, with the capture right there
    expect(shouldResort(600, 0.5, 0, 5, opts)).toBe(true)
  })
})

/*
 * TURNING ROUND. Rich, 2026-09-29, with the floor set high: *"traveling in one direction, then
 * turning around and having trees in the distance z sorted above trees in the foreground."* A
 * radial order does not depend on which way you face, but the SET that gets sorted does — the
 * generate pass is frustum-bound — so a half turn shows you gaussians that were in no ordering.
 */
describe('turning round', () => {
  const opts = { minMs: 500, parallax: 0.02, min: 0.25, max: 4000, turnDeg: 90 }

  it('forces a sort even with the distance gate turned off entirely', async () => {
    const { shouldResort } = await import('../src/visuals/splatsort')
    // four kilometres of ceiling: distance will never ask. A U-turn still must.
    expect(shouldResort(600, 1, 5, 100, opts)).toBe(false)
    expect(shouldResort(600, 1, 95, 100, opts)).toBe(true)
    expect(shouldResort(600, 1, 180, 100, opts)).toBe(true)
  })

  it('but cannot beat the timer, or a spin at the wheel is a stall per frame', async () => {
    const { shouldResort } = await import('../src/visuals/splatsort')
    expect(shouldResort(100, 1, 180, 100, opts)).toBe(false)
  })

  it('measures the turn as the angle between two headings', async () => {
    const { angleBetween } = await import('../src/visuals/splatsort')
    expect(angleBetween({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(0, 6)
    expect(angleBetween({ x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(90, 4)
    expect(angleBetween({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(180, 3)
  })
})

/*
 * THE ASSIST'S EXTRA GRAVITY. Rich's loop, measured: with 25 m/s² of pull applied on the FLAT the
 * car stopped at the mouth of the approach with all four wheels down and its body resting on the
 * road — three and a half g through the suspension, no weight on the tyres, no drive.
 */
describe('how much extra gravity a stunt surface needs', () => {
  it('asks for none of it on the flat, where ordinary gravity already does the job', async () => {
    const { pullScale } = await import('../src/game/stunt/stuntassist')
    expect(pullScale({ x: 0, y: 1, z: 0 })).toBe(0)
  })

  it('all of it on a wall, and twice as much upside down', async () => {
    const { pullScale } = await import('../src/game/stunt/stuntassist')
    expect(pullScale({ x: 1, y: 0, z: 0 })).toBeCloseTo(1, 6)
    expect(pullScale({ x: 0, y: -1, z: 0 })).toBeCloseTo(2, 6)
    // and part way up a loop, part of it
    expect(pullScale({ x: 0.71, y: 0.71, z: 0 })).toBeCloseTo(0.29, 2)
  })
})

describe('how hard the assist may press', () => {
  it('owes nothing on the flat, one gravity on a wall, two upside down', async () => {
    const { pullFor, G } = await import('../src/game/stunt/stuntassist')
    expect(pullFor({ x: 0, y: 1, z: 0 }, G)).toBeCloseTo(0, 6)
    expect(pullFor({ x: 1, y: 0, z: 0 }, G)).toBeCloseTo(G, 6)
    expect(pullFor({ x: 0, y: -1, z: 0 }, G)).toBeCloseTo(2 * G, 6)
  })

  /*
   * AND IT IS CAPPED. Pressing harder than the suspension can absorb puts the body on the track,
   * and then the solver is pushing the car out of a surface the assist is pushing it into — which
   * is what "the loop was deformable" felt like.
   */
  it('never presses harder than a suspension can take', async () => {
    const { pullFor, G } = await import('../src/game/stunt/stuntassist')
    expect(pullFor({ x: 0, y: -1, z: 0 }, 100)).toBeLessThanOrEqual(G * 2.5)
  })
})
