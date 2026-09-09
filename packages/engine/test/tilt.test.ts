import { describe, expect, it } from 'vitest'
import { TiltSensor } from '../src/input/TiltSensor'

/**
 * Gravity as devicemotion reports it (pointing along the device's "up" axis), for a phone rotated
 * `spin` degrees clockwise as the user sees it. Portrait upright is spin 0; on its side is 90.
 */
function gravityAt(spin: number): { x: number; y: number; z: number } {
  const a = ((90 + spin) * Math.PI) / 180
  return { x: 9.81 * Math.cos(a), y: 9.81 * Math.sin(a), z: 0 }
}

function sensorHeldAt(spin: number): TiltSensor {
  const s = new TiltSensor()
  feed(s, spin)
  s.calibrate()
  return s
}

// The sensor low-passes against the clock, so the readings have to arrive at plausible intervals.
let clock = 0
performance.now = () => clock

function feed(s: TiltSensor, spin: number): void {
  const g = gravityAt(spin)
  for (let i = 0; i < 200; i++) {
    clock += 16
    ;(s as unknown as { onMotion(e: unknown): void }).onMotion({ accelerationIncludingGravity: g })
  }
}

describe('tilt steering', () => {
  it('reads the same tilt however the phone is being held', () => {
    // The page's idea of its orientation never comes into it: what matters is the turn away from the
    // hold the player calibrated on, and that has to read the same in portrait or on either side.
    for (const held of [0, 90, 180, 270]) {
      const s = sensorHeldAt(held)
      expect(s.tiltDeg(), `held at ${held}, no turn`).toBeCloseTo(0, 4)
      feed(s, held + 15)
      const right = s.tiltDeg()
      feed(s, held - 15)
      const left = s.tiltDeg()
      expect(Math.abs(right), `held at ${held}, turned right`).toBeCloseTo(15, 1)
      expect(Math.abs(left), `held at ${held}, turned left`).toBeCloseTo(15, 1)
      expect(Math.sign(right), `held at ${held}: the two ways apart`).toBe(-Math.sign(left))
    }
  })

  it('gives a steady, symmetric steer from the same gesture in any hold', () => {
    const steers = [0, 90, 180, 270].map((held) => {
      const s = sensorHeldAt(held)
      s.sign = -1
      feed(s, held + 20)
      return s.steer(25, 3)
    })
    for (const v of steers) expect(v).toBeCloseTo(steers[0], 3)
    expect(Math.abs(steers[0])).toBeGreaterThan(0.4)
  })

  it('does not lock over when the phone is held on its side', () => {
    // The bug: a page that thinks it is upright while the phone is not read the axis gravity was
    // pointing down, and the steering sat at full lock.
    const s = sensorHeldAt(90)
    expect(Math.abs(s.steer(25, 3))).toBeLessThan(0.01)
  })
})

/** Play for a while at a fixed hold, reading the steering the way a game does each frame. */
function play(s: TiltSensor, spin: number, seconds: number, deadzone: number): number {
  const g = gravityAt(spin)
  let steer = 0
  for (let i = 0; i < seconds * 60; i++) {
    clock += 16
    ;(s as unknown as { onMotion(e: unknown): void }).onMotion({ accelerationIncludingGravity: g })
    steer = s.steer(25, deadzone)
  }
  return steer
}

describe('learning the hold', () => {
  it('settles on however the phone is being held, without being told', () => {
    // Pick the phone up a few degrees off and the game absorbs it: no recentre button, no drift.
    const s = sensorHeldAt(0)
    play(s, 7, 0.2, 9)
    expect(Math.abs(s.steer(25, 3)), 'the new hold pulls at first').toBeGreaterThan(0.02)
    play(s, 7, 4, 9)
    expect(Math.abs(s.steer(25, 3)), 'and is the new straight ahead a moment later').toBeLessThan(0.02)
  })

  it('does not quietly recentre a corner being held', () => {
    // A long corner is a real input, not a new hold: it has to still be there four seconds later.
    const s = sensorHeldAt(0)
    s.sign = -1
    const early = play(s, 18, 1, 3)
    const late = play(s, 18, 4, 3)
    expect(Math.abs(late)).toBeGreaterThan(0.5)
    expect(late).toBeCloseTo(early, 2)
  })
})
