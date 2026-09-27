// The arithmetic a baked engine rests on. Every one of these is a click or a wrong note if it
// is off by a little, and none of them needs a browser to check.
import { describe, expect, it } from 'vitest'
import { bakeRpm, bakeRpmAtMost, bracket, cycleSamples, loopCycles, playbackRate, rpmLadder,
  type PackLayer } from '../src/pack'

const SR = 48000

describe('the loop length', () => {
  it('makes one engine cycle a whole number of samples, always', () => {
    for (let rpm = 600; rpm <= 9000; rpm += 7) {
      const k = cycleSamples(rpm, SR)
      expect(Number.isInteger(k)).toBe(true)
      // and the rpm we bake at really does have that cycle
      expect(bakeRpm(rpm, SR) * k).toBeCloseTo(120 * SR, 6)
    }
  })

  // The bound is RELATIVE and it is 0.5·rpm/(120·sampleRate) — so the ABSOLUTE error grows with
  // the square of the rev (0.04 rpm at idle, 7 rpm at 9000) while the ratio stays tiny. Two
  // earlier versions of the comment in pack.ts got this wrong in different directions and this
  // test is what caught both. Cents, because that is the unit the ear works in.
  const cents = (ratio: number) => 1200 * Math.log2(1 + ratio)

  it('moves the rpm by under two cents at every rev — the ear needs about five', () => {
    let worstRelative = 0, worstAbsolute = 0, worstAt = 0
    for (let rpm = 600; rpm <= 9000; rpm += 1) {
      const rel = Math.abs(bakeRpm(rpm, SR) - rpm) / rpm
      worstAbsolute = Math.max(worstAbsolute, Math.abs(bakeRpm(rpm, SR) - rpm))
      if (rel > worstRelative) { worstRelative = rel; worstAt = rpm }
    }
    expect(cents(worstRelative)).toBeLessThan(2)
    // the closed form, so the bound is understood and not just observed
    expect(worstRelative).toBeLessThanOrEqual(0.5 * 9000 / (120 * SR) + 1e-9)
    // and say out loud that the ABSOLUTE error is not small, so nobody re-asserts that by mistake
    expect(worstAbsolute).toBeGreaterThan(1)
    expect(worstAt).toBeGreaterThan(5000)
  })

  it('is exact at the round numbers that divide cleanly', () => {
    for (const rpm of [600, 750, 800, 900, 1000, 1200, 1500, 1600, 1800, 2000, 2400, 3000, 6000]) {
      expect(bakeRpm(rpm, SR)).toBeCloseTo(rpm, 9)
    }
  })

  it('holds at 44.1 kHz too, where the divisors are worse', () => {
    let worst = 0
    for (let rpm = 600; rpm <= 9000; rpm += 1) {
      worst = Math.max(worst, Math.abs(bakeRpm(rpm, 44100) - rpm) / rpm)
    }
    expect(cents(worst)).toBeLessThan(2)
  })

  it('targets a duration rather than a cycle count, so the top end is not a 0.14 s loop', () => {
    // At idle a cycle is long, so few cycles fill the target; at redline it takes many.
    expect(loopCycles(800)).toBe(Math.round((0.5 * 800) / 120))
    expect(loopCycles(6000)).toBe(Math.round((0.5 * 6000) / 120))
    expect(loopCycles(6000)).toBeGreaterThan(loopCycles(800))
    // every layer is close to the target duration, which is the point
    for (const rpm of [700, 1200, 2500, 4000, 6500]) {
      const seconds = (loopCycles(rpm) * 120) / rpm
      expect(seconds).toBeGreaterThan(0.35)
      expect(seconds).toBeLessThan(0.65)
    }
  })

  // One cycle loops at the firing rate, which the ear hears as a buzz rather than an engine.
  it('never emits a one-cycle loop, however slowly the thing turns', () => {
    for (let rpm = 60; rpm <= 500; rpm += 10) expect(loopCycles(rpm)).toBeGreaterThanOrEqual(2)
  })
})

describe('the top of the ladder, where the limiter is', () => {
  // The bug this exists for: bakeRpm(6500) is 6501.13, follow mode gives 6500 because that IS the
  // GM LS's limiter, and the loop is then cut for a speed the engine never reached. A click on the
  // top layer of every engine whose redline rounds up, audible forever, invisible without a seam
  // check. Found by the baker refusing to write it.
  it('never rounds a redline UP past the limiter', () => {
    for (const redline of [3000, 3600, 5000, 5500, 6000, 6500, 8400, 9000, 11000, 18000]) {
      expect(bakeRpmAtMost(redline, SR)).toBeLessThanOrEqual(redline)
      expect(bakeRpm(6500, SR)).toBeGreaterThan(6500) // the trap itself, so it cannot quietly go away
    }
  })

  it('still lands on a whole number of samples per cycle', () => {
    for (let rpm = 600; rpm <= 18000; rpm += 13) {
      const r = bakeRpmAtMost(rpm, SR)
      expect(Number.isInteger(Math.round((120 * SR) / r))).toBe(true)
      expect((120 * SR) / r).toBeCloseTo(Math.round((120 * SR) / r), 9)
    }
  })

  // Always rounding down costs a whole sample of cycle rather than half, so the worst case is
  // twice bakeRpm's: rpm/(120·sampleRate), which is 5.3 cents at 18000 rpm on a 48 kHz bake.
  //
  // THAT IS NOT A PITCH ERROR. The layer is played at rate = wanted/baked, so wherever the bake
  // landed is corrected exactly at playback. All this number says is how far the layer sits from
  // the rev it nominally represents, which costs a hair more resampling at its neighbours and
  // nothing else — so the bound is here to stay understood, not because anyone could hear it.
  it('sits within about five cents of the rev it represents, and playbackRate erases even that', () => {
    let worst = 0
    for (let rpm = 600; rpm <= 18000; rpm += 1) {
      worst = Math.max(worst, (rpm - bakeRpmAtMost(rpm, SR)) / rpm)
    }
    expect(1200 * Math.log2(1 + worst)).toBeLessThan(6)
    expect(worst).toBeLessThanOrEqual(18000 / (120 * SR) + 1e-9)
    // and playback puts it exactly back
    const baked = bakeRpmAtMost(18000, SR)
    expect(baked * playbackRate(baked, 18000)).toBeCloseTo(18000, 9)
  })
})

describe('the rev ladder', () => {
  it('spans idle to redline inclusive', () => {
    const l = rpmLadder(800, 6500)
    expect(l[0]).toBeCloseTo(800, 6)
    expect(l[l.length - 1]).toBeCloseTo(6500, 6)
  })

  it('steps by a constant INTERVAL, not a constant rpm', () => {
    const l = rpmLadder(800, 6500)
    const ratios = l.slice(1).map((v, i) => v / l[i])
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0], 9)
    // which means the rpm steps get bigger as it climbs — the thing a linear ladder gets wrong
    expect(l[l.length - 1] - l[l.length - 2]).toBeGreaterThan(l[1] - l[0])
  })

  it('never asks a layer to stretch more than the cap', () => {
    for (const [idle, red] of [[700, 7000], [800, 6500], [500, 9000], [1000, 2000]] as const) {
      const l = rpmLadder(idle, red)
      for (let i = 1; i < l.length; i += 1) expect(l[i] / l[i - 1]).toBeLessThanOrEqual(1.26 + 1e-9)
    }
  })

  it('survives a redline at or below idle rather than looping forever', () => {
    expect(rpmLadder(800, 800)).toEqual([800])
    expect(rpmLadder(800, 400)).toEqual([800])
  })
})

const layers = (rpms: number[]): PackLayer[] => rpms.map((rpm) => ({
  rpm, pedal: 0, file: '', loopStart: 0, loopEnd: 0,
  loopStartSamples: 0, loopEndSamples: 0, cycles: 1, peak: 1, rms: 0.5,
}))

describe('picking the two layers to blend', () => {
  const l = layers([800, 1200, 1800, 2700, 4000])

  it('clamps below the bottom and above the top instead of extrapolating', () => {
    expect(bracket(l, 400)).toEqual({ lo: 0, hi: 0, t: 0 })
    expect(bracket(l, 9000)).toEqual({ lo: 4, hi: 4, t: 0 })
  })

  it('lands on the right pair', () => {
    const b = bracket(l, 1500)
    expect([b.lo, b.hi]).toEqual([1, 2])
  })

  it('puts the halfway point at the geometric mean, not the arithmetic one', () => {
    // 1200 and 1800: arithmetic middle is 1500, geometric is 1469.7. The ear tracks the interval.
    expect(bracket(l, Math.sqrt(1200 * 1800)).t).toBeCloseTo(0.5, 6)
    expect(bracket(l, 1500).t).toBeGreaterThan(0.5)
  })

  it('is continuous across every boundary — a jump here is a click', () => {
    let prev = 0
    for (let rpm = 800; rpm <= 4000; rpm += 1) {
      const b = bracket(l, rpm)
      const position = b.lo + b.t // a single monotone coordinate along the ladder
      expect(position).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(position - prev).toBeLessThan(0.05)
      prev = position
    }
  })

  it('handles a one-layer pack without dividing by zero', () => {
    const one = layers([900])
    expect(bracket(one, 3000)).toEqual({ lo: 0, hi: 0, t: 0 })
    expect(bracket([], 3000)).toEqual({ lo: -1, hi: -1, t: 0 })
  })
})

describe('playback rate', () => {
  it('is the rpm ratio, so a layer asked for its own rpm plays untouched', () => {
    expect(playbackRate(1699.88, 1699.88)).toBe(1)
    expect(playbackRate(1700, 1830)).toBeCloseTo(1.0765, 4)
  })
})
