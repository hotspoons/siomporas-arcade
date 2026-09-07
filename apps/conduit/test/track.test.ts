import { describe, expect, it } from 'vitest'
import { TRACK_SAMPLE_STEP } from '../src/sim/Tuning'
import { Vec3 } from '@apex/engine/math/Vec3'
import { TEST_COURSE } from '../src/sim/track/courses/testCourse'
import { buildTrack } from '../src/sim/track/TrackBuilder'
import { makeFrame } from '../src/sim/track/TrackSpline'

describe('TrackBuilder', () => {
  const track = buildTrack(TEST_COURSE)
  const sp = track.spline

  it('bakes roughly the authored length', () => {
    const authored = TEST_COURSE.segments.reduce((a, s) => a + s.length, 0)
    expect(track.length).toBeGreaterThan(authored * 0.97)
    expect(track.length).toBeLessThan(authored * 1.03)
  })

  it('is arc-length uniform', () => {
    const a = new Vec3()
    const b = new Vec3()
    for (let i = 1; i < sp.n; i++) {
      a.set(sp.pos[(i - 1) * 3], sp.pos[(i - 1) * 3 + 1], sp.pos[(i - 1) * 3 + 2])
      b.set(sp.pos[i * 3], sp.pos[i * 3 + 1], sp.pos[i * 3 + 2])
      expect(Math.abs(a.distanceTo(b) - TRACK_SAMPLE_STEP)).toBeLessThan(0.05)
    }
  })

  it('has orthonormal frames with no twist between neighbours', () => {
    const f0 = makeFrame()
    const f1 = makeFrame()
    for (let s = 0; s < track.length - TRACK_SAMPLE_STEP; s += TRACK_SAMPLE_STEP) {
      sp.frameAt(s, f0)
      sp.frameAt(s + TRACK_SAMPLE_STEP, f1)
      expect(Math.abs(f0.tan.length() - 1)).toBeLessThan(1e-3)
      expect(Math.abs(f0.nor.length() - 1)).toBeLessThan(1e-3)
      expect(Math.abs(f0.tan.dot(f0.nor))).toBeLessThan(1e-3)
      expect(Math.abs(f0.tan.dot(f0.bin))).toBeLessThan(1e-3)
      // Neighbouring normals must agree closely: a Frenet flip would show as ~-1.
      expect(f0.nor.dot(f1.nor)).toBeGreaterThan(0.995)
    }
  })

  it('places gates inside GATE segments', () => {
    expect(track.gates.length).toBe(2)
    for (const g of track.gates) expect(track.segmentAt(g).type).toBe('GATE')
  })

  it('projects surface points back to their track coordinates', () => {
    const p = new Vec3()
    const fr = makeFrame()
    const out = { s: 0, theta: 0, radial: 0 }
    for (const [s, theta] of [[500, 0.3], [1500, -2.5], [2400, 3.0]] as const) {
      track.surfacePoint(s, theta, 0, 0, p)
      track.project(p, s + 40, 150, 0, fr, out)
      expect(Math.abs(out.s - s)).toBeLessThan(0.5)
      expect(Math.abs(out.theta - theta)).toBeLessThan(0.02)
      expect(Math.abs(out.radial - fr.radius)).toBeLessThan(0.2)
    }
  })
})
