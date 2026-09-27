// The gearbox is the one piece of this package written from scratch rather than bound, so it is the
// one piece that can be wrong in a way nothing upstream would catch.
//
// What matters here is not that the ratios are "right" — they are a taste decision — but that the
// RPM CURVE IS PLAYABLE. Engine audio is pitch, and pitch is the most unforgiving thing to get
// subtly wrong: a discontinuity is a click, a glissando between gears is the giveaway of a fake
// engine, and an oscillating shift decision is a machine gun. Each of those is asserted directly.

import { describe, expect, it } from 'vitest'
import { DEFAULT_DRIVETRAIN, Drivetrain } from '../src/Drivetrain'

const STEP = 1 / 120

/** Run a speed profile through the gearbox and keep everything it did. */
function sweep(speedAt: (t: number) => number, seconds: number, throttle = 1) {
  const drivetrain = new Drivetrain()
  const samples: { t: number; speed: number; rpm: number; gear: number; shifting: boolean }[] = []
  for (let t = 0; t < seconds; t += STEP) {
    const speed = speedAt(t)
    drivetrain.update(speed, throttle, STEP)
    samples.push({
      t, speed, rpm: drivetrain.rpm, gear: drivetrain.gear, shifting: drivetrain.shifting,
    })
  }
  return { drivetrain, samples }
}

describe('Drivetrain', () => {
  it('idles rather than stopping when the car is stationary', () => {
    const { drivetrain } = sweep(() => 0, 1, 0)
    // An engine asked to hold 0 rpm is an engine that has stalled, and the audio goes silent. The
    // idle floor is what keeps a parked car running.
    expect(drivetrain.rpm).toBe(DEFAULT_DRIVETRAIN.idleRpm)
    expect(drivetrain.gear).toBe(0)
  })

  it('climbs through every gear under acceleration and never passes the redline', () => {
    const { samples } = sweep((t) => t * 10, 9)
    const gears = [...new Set(samples.map((s) => s.gear))]
    expect(gears).toEqual([0, 1, 2, 3, 4, 5])
    for (const sample of samples) {
      expect(sample.rpm).toBeLessThanOrEqual(DEFAULT_DRIVETRAIN.redlineRpm + 1e-6)
      expect(sample.rpm).toBeGreaterThanOrEqual(DEFAULT_DRIVETRAIN.idleRpm - 1e-6)
      expect(Number.isFinite(sample.rpm)).toBe(true)
    }
  })

  it('spreads a gearchange over time instead of jumping between ratios', () => {
    const { samples } = sweep((t) => t * 10, 9)
    let worst = 0
    for (let i = 1; i < samples.length; i += 1) {
      worst = Math.max(worst, Math.abs(samples[i].rpm - samples[i - 1].rpm))
    }
    // The bug this guards against is a gearchange applied in ONE step: at the 1-2 shift that would
    // be a 2583 rpm discontinuity, and no amount of smoothing downstream recovers a click. The
    // clutch drop is legitimately fast — a few hundred rpm per 1/120 s — so the test is a fraction
    // of the instantaneous jump, not an absolute rate. Measured here: ~307, i.e. 12%.
    const spec = DEFAULT_DRIVETRAIN
    const atShift = (gear: number) => (spec.shiftUpRpm / (60 / (2 * Math.PI)))
      * spec.tyreRadius / (spec.gearRatios[0] * spec.finalDrive)
      / spec.tyreRadius * spec.gearRatios[gear] * spec.finalDrive * (60 / (2 * Math.PI))
    const instantaneousJump = atShift(0) - atShift(1)
    expect(worst).toBeLessThan(instantaneousJump * 0.25)
  })

  it('drops the engine on a gearchange instead of sliding between ratios', () => {
    const { samples } = sweep((t) => t * 10, 9)
    const firstShift = samples.findIndex((s) => s.shifting)
    expect(firstShift).toBeGreaterThan(0)
    const before = samples[firstShift - 1].rpm
    const during = samples.slice(firstShift, firstShift + Math.ceil(0.2 / STEP))
    const lowest = Math.min(...during.map((s) => s.rpm))
    const after = during[during.length - 1].rpm
    // The clutch comes out, so the engine falls well below where it was AND below where the next
    // gear will pick it up. Without this dip the pitch just slides down and it sounds synthesised.
    expect(lowest).toBeLessThan(before * 0.85)
    expect(lowest).toBeLessThan(after * 0.95)
    // And the clutch actually reports itself as out, for anything driving free mode.
    expect(during.some((s) => s.shifting)).toBe(true)
  })

  it('closes the throttle across the shift', () => {
    const drivetrain = new Drivetrain()
    let sawShiftWithPedalDown = false
    for (let t = 0; t < 9; t += STEP) {
      drivetrain.update(t * 10, 1, STEP)
      if (drivetrain.shifting && drivetrain.pedal > 0.3) sawShiftWithPedalDown = true
    }
    // The driver is flat out the whole time; the engine must not be. A gearchange with the throttle
    // still open sounds like the clutch never moved.
    expect(sawShiftWithPedalDown).toBe(false)
  })

  it('does not hunt between two gears at a shift-point speed', () => {
    // Sit exactly where an upshift happens and stay there. Without hysteresis between shiftUpRpm
    // and shiftDownRpm this oscillates every few frames, which is audible as a stutter.
    const spec = DEFAULT_DRIVETRAIN
    const shiftSpeed = (spec.shiftUpRpm / (60 / (2 * Math.PI)))
      * spec.tyreRadius / (spec.gearRatios[0] * spec.finalDrive)
    // Count from the gear it STARTED in, not from the first recorded sample: at this speed the
    // upshift lands on the very first update, so an `i > 0` comparison sees a flat run and would
    // pass whatever the gearbox did.
    const { samples } = sweep(() => shiftSpeed * 1.001, 6)
    let previous = 0
    let changes = 0
    for (const sample of samples) {
      if (sample.gear !== previous) { changes += 1; previous = sample.gear }
    }
    expect(changes).toBe(1)
    expect(samples[samples.length - 1].gear).toBe(1)
  })

  it('downshifts on the way back down and lands at idle', () => {
    const drivetrain = new Drivetrain()
    for (let t = 0; t < 9; t += STEP) drivetrain.update(t * 10, 1, STEP)
    const topGear = drivetrain.gear
    expect(topGear).toBeGreaterThan(0)
    for (let t = 0; t < 12; t += STEP) drivetrain.update(Math.max(0, 90 - t * 10), 0, STEP)
    expect(drivetrain.gear).toBe(0)
    expect(drivetrain.rpm).toBeCloseTo(DEFAULT_DRIVETRAIN.idleRpm, 5)
  })

  it('reset puts it back in first at idle', () => {
    const drivetrain = new Drivetrain()
    for (let t = 0; t < 9; t += STEP) drivetrain.update(t * 10, 1, STEP)
    drivetrain.reset()
    expect(drivetrain.gear).toBe(0)
    expect(drivetrain.rpm).toBe(DEFAULT_DRIVETRAIN.idleRpm)
    expect(drivetrain.shifting).toBe(false)
  })
})
