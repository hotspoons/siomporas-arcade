// A baked course: the trunk spline, the per-segment metadata that gameplay
// queries, split branches, and every authored feature resolved to absolute
// arc length. Built once by TrackBuilder; read-only afterwards.

import { VEHICLE_HALF_WIDTH } from '../Tuning'
import { Vec3 } from '../math/Vec3'
import type { CourseDesc, PickupKind, SegmentType, TrafficKind } from './SegmentDesc'
import { makeFrame, TrackSpline, type Frame, type TrackPoint } from './TrackSpline'
import { playerClamp } from './TrackProfile'

export interface Segment {
  index: number
  type: SegmentType
  sStart: number
  sEnd: number
  length: number
  difficulty: number
  mix: Partial<Record<TrafficKind, number>> | null
  /** SPLIT only: the second branch, parameterised over its own [0, length]. */
  branch: TrackSpline | null
}

export interface BoostStrip {
  sStart: number
  sEnd: number
  theta: number
  halfWidth: number
}

export interface Ring {
  s: number
  pos: Vec3
  /** Ring radius in metres. */
  radius: number
}

export interface PlacedPickup {
  s: number
  theta: number
  pickup: PickupKind
}

export class Track {
  readonly course: CourseDesc
  readonly spline: TrackSpline
  readonly segments: Segment[]
  readonly length: number
  /** Arc lengths of every checkpoint gate, ascending. */
  readonly gates: number[]
  /** Sorted by sStart. */
  readonly boosts: BoostStrip[]
  readonly rings: Ring[]
  readonly pickups: PlacedPickup[]
  readonly bosses: number[]

  private readonly fr = makeFrame()
  private readonly vA = new Vec3()

  constructor(
    course: CourseDesc,
    spline: TrackSpline,
    segments: Segment[],
    gates: number[],
    boosts: BoostStrip[],
    rings: Ring[],
    pickups: PlacedPickup[],
    bosses: number[],
  ) {
    this.course = course
    this.spline = spline
    this.segments = segments
    this.length = spline.length
    this.gates = gates
    this.boosts = boosts
    this.rings = rings
    this.pickups = pickups
    this.bosses = bosses
  }

  /** Segment containing s (clamped to the first/last). Binary search. */
  segmentAt(s: number): Segment {
    const segs = this.segments
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].sStart <= s) lo = mid
      else hi = mid - 1
    }
    return segs[lo]
  }

  /** The SPLIT segment covering s, if any. */
  splitAt(s: number): Segment | null {
    const seg = this.segmentAt(s)
    return seg.type === 'SPLIT' && seg.branch && s >= seg.sStart && s < seg.sEnd ? seg : null
  }

  /** Map trunk arc length to the branch spline's own parameter. */
  branchS(seg: Segment, s: number): number {
    const u = (s - seg.sStart) / seg.length
    return u * seg.branch!.length
  }

  /** Frame at s on the given branch (branch 1 only exists inside a SPLIT). */
  frameAt(s: number, branch: number, out: Frame): Frame {
    if (branch === 1) {
      const seg = this.splitAt(s)
      if (seg) return seg.branch!.frameAt(this.branchS(seg, s), out)
    }
    return this.spline.frameAt(s, out)
  }

  /** Unit vector from the centreline toward the wall at theta. */
  static radial(frame: Frame, theta: number, out: Vec3): Vec3 {
    const c = Math.cos(theta)
    const sn = Math.sin(theta)
    out.x = frame.nor.x * c + frame.bin.x * sn
    out.y = frame.nor.y * c + frame.bin.y * sn
    out.z = frame.nor.z * c + frame.bin.z * sn
    return out
  }

  /** World position of a point `lift` metres off the wall at (s, theta). */
  surfacePoint(s: number, theta: number, lift: number, branch: number, out: Vec3): Vec3 {
    const f = this.frameAt(s, branch, this.fr)
    Track.radial(f, theta, this.vA)
    return out.copy(f.pos).addScaled(this.vA, f.radius - lift)
  }

  /** Same, but from an already-fetched frame. */
  static surfaceFromFrame(f: Frame, theta: number, lift: number, out: Vec3, scratch: Vec3): Vec3 {
    Track.radial(f, theta, scratch)
    return out.copy(f.pos).addScaled(scratch, f.radius - lift)
  }

  /** Player theta limit at s (Infinity in a closed tube). */
  clampAt(s: number, branch: number): number {
    const f = this.frameAt(s, branch, this.fr)
    return playerClamp(f.arc, f.radius)
  }

  project(p: Vec3, sGuess: number, range: number, branch: number, scratch: Frame, out: TrackPoint): TrackPoint {
    if (branch === 1) {
      const seg = this.splitAt(sGuess)
      if (seg) {
        const bs = seg.branch!
        bs.project(p, this.branchS(seg, sGuess), range, scratch, out)
        out.s = seg.sStart + (out.s / bs.length) * seg.length
        return out
      }
    }
    return this.spline.project(p, sGuess, range, scratch, out)
  }

  /** Which branch a craft at `theta` commits to when a split begins. */
  static branchFor(theta: number): number {
    return Math.sin(theta) > 0 ? 1 : 0
  }

  /** Angular half-width of the craft at this radius. */
  static halfWidthAngle(radius: number): number {
    return VEHICLE_HALF_WIDTH / radius
  }
}
