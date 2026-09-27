// Does the clock hold still when it is told to, and run at the rate it is given?
//
// Both were wrong in ways that took a level to notice. `tick` moved the offset by the FRAME
// delta while `ms` is read against `Date.now()`; those disagree by a millisecond or so a frame,
// so a clock at rate 0 — paused — drifted, and a level that opened at 19:20 read 19:19 a second
// later because `parts()` reports whole minutes and the instant had slipped below the boundary.
//
// These run against a fake `Date.now`, so "a frame" and "an hour in a background tab" are things
// the test can simply say.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { WorldClock } from '../src/sun'

const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms)
afterEach(() => vi.restoreAllMocks())

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0)

describe('WorldClock', () => {
  it('holds exactly still at rate 0, however many frames go by', () => {
    at(T0)
    const c = new WorldClock()
    c.ms = T0
    c.rate = 0
    for (let i = 1; i <= 600; i++) {
      at(T0 + i * 16) // ten seconds of frames
      c.tick(0.016)
    }
    expect(c.ms).toBe(T0) // not "within a few ms": exactly
  })

  /*
   * THE FRAME DELTA AND THE WALL CLOCK DISAGREE, and that is the whole bug.
   *
   * My first version of these tests advanced `Date.now` by exactly the `dt` it passed in, so the
   * old implementation passed them — a test that cannot tell the two apart cannot see a fault
   * that lives in the difference. A rAF delta is measured by a different clock from `Date.now()`
   * and runs a per cent or so fast or slow; here it reports 17 ms while 16 actually elapse.
   */
  it('holds still even when the frame delta lies about how long a frame took', () => {
    at(T0)
    const c = new WorldClock()
    c.ms = T0
    c.rate = 0
    for (let i = 1; i <= 600; i++) {
      at(T0 + i * 16) // sixteen milliseconds really went by
      c.tick(0.017) // the frame says seventeen
    }
    expect(c.ms).toBe(T0)
  })

  it('keeps real time at rate 1 even when the frame delta lies', () => {
    at(T0)
    const c = new WorldClock()
    c.ms = T0
    c.rate = 1
    for (let i = 1; i <= 600; i++) {
      at(T0 + i * 16)
      c.tick(0.017)
    }
    expect(c.ms).toBe(T0 + 600 * 16)
  })

  it('keeps real time at rate 1 across a gap where no frame ran', () => {
    at(T0)
    const c = new WorldClock()
    c.ms = T0
    c.rate = 1
    at(T0 + 3600_000) // an hour in a background tab, one tick on the way back
    c.tick(3600)
    expect(c.ms).toBe(T0 + 3600_000)
  })

  it('runs at the rate it is given', () => {
    at(T0)
    const c = new WorldClock()
    c.ms = T0
    c.rate = 60
    for (let i = 1; i <= 100; i++) {
      at(T0 + i * 100) // ten seconds of wall time, in 100 ms steps
      c.tick(0.1)
    }
    expect(c.ms - T0).toBe(10_000 * 60)
  })

  it('caps one enormous frame when speeding up, and not when slowing down', () => {
    at(T0)
    const fast = new WorldClock()
    fast.ms = T0
    fast.rate = 3600
    at(T0 + 43_000) // the 43-second stall, measured on a software rasteriser
    fast.tick(43)
    // 250 ms of it, not 43 s: a fortnight of sun in one frame is not a clock
    expect(fast.ms - T0).toBe(250 * 3600)

    at(T0)
    const held = new WorldClock()
    held.ms = T0
    held.rate = 0
    at(T0 + 43_000)
    held.tick(43)
    expect(held.ms).toBe(T0) // paused means paused, whatever happened to the tab
  })

  it('setLocal lands on the minute asked for', () => {
    at(T0)
    const c = new WorldClock()
    c.setLocal('Etc/GMT+5', '2026-09-27', '19:20')
    expect(c.parts('Etc/GMT+5').time).toBe('19:20')
    // and it stays there while the clock is held
    c.rate = 0
    for (let i = 1; i <= 120; i++) {
      at(T0 + i * 16)
      c.tick(0.016)
    }
    expect(c.parts('Etc/GMT+5').time).toBe('19:20')
  })
})
