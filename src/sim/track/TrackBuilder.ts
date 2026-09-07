// Bakes a CourseDesc into a Track: sweeps a heading through the segment list
// to lay control points, resamples the Catmull-Rom through them by arc length,
// propagates parallel-transport frames, levels open sections toward world-down,
// applies authored banking, and resolves features to absolute arc length.

import {
  ARC_TUBE,
  G_AIR,
  GAP_DESIGN_SPEED,
  PROFILE_BLEND_LENGTH,
  ROLL_SMOOTH_LENGTH,
  TRACK_SAMPLE_STEP,
  TUNNEL_RADIUS_DEFAULT,
} from '../Tuning'
import { catmullRomPoint } from '../math/catmullRom'
import { clamp, DEG, lerp, smoothstep, wrapAngle } from '../math/scalar'
import { Vec3 } from '../math/Vec3'
import type { CourseDesc, SegmentDesc } from './SegmentDesc'
import { Track, type BoostStrip, type PlacedPickup, type Ring, type Segment } from './Track'
import { arcForType, isLevelType } from './TrackProfile'
import { makeFrame, TrackSpline } from './TrackSpline'

/** Control point spacing along a segment. */
const CP_STEP = 40
/** Catmull-Rom subdivisions per control-point span during resampling. */
const FINE_STEPS = 24
/** Fraction of a SPLIT's length spent separating and rejoining. */
const SPLIT_RAMP = 0.28
const WORLD_DOWN = new Vec3(0, -1, 0)

interface ControlPoint {
  p: Vec3
  seg: number
  /** Horizontal right vector of the heading here (for split offsets). */
  right: Vec3
}

export function buildTrack(course: CourseDesc): Track {
  const descs = course.segments
  const cps: ControlPoint[] = []
  const pos = new Vec3()
  let yaw = 0
  let pitch = 0

  const pushCp = (seg: number) => {
    cps.push({ p: pos.clone(), seg, right: new Vec3(Math.cos(yaw), 0, -Math.sin(yaw)) })
  }

  // --- lay control points ----------------------------------------------------
  for (let si = 0; si < descs.length; si++) {
    const d = descs[si]
    const steps = Math.max(2, Math.ceil(d.length / CP_STEP))
    const step = d.length / steps
    if (d.type === 'GAP') {
      // Ballistic centreline so the flight path and the geometry agree.
      const speed = d.gapSpeed ?? GAP_DESIGN_SPEED
      const v = new Vec3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).scale(speed)
      let travelled = 0
      let acc = 0
      const dt = 1 / 240
      pushCp(si)
      while (travelled < d.length) {
        v.y -= G_AIR * dt
        const ds = v.length() * dt
        pos.addScaled(v, dt)
        travelled += ds
        acc += ds
        if (acc >= step && travelled < d.length) {
          acc = 0
          pushCp(si)
        }
      }
      pitch = Math.asin(clamp(v.y / v.length(), -1, 1))
      continue
    }
    const dYaw = ((d.curve?.yaw ?? 0) * DEG) / steps
    const dPitch = ((d.curve?.pitch ?? 0) * DEG) / steps
    for (let k = 0; k < steps; k++) {
      pushCp(si)
      yaw += dYaw
      pitch += dPitch
      pos.x += Math.sin(yaw) * Math.cos(pitch) * step
      pos.y += Math.sin(pitch) * step
      pos.z += Math.cos(yaw) * Math.cos(pitch) * step
    }
  }
  pushCp(descs.length - 1)

  // --- split offsets: trunk goes left, branch goes right ------------------------
  const branchCps = new Map<number, Vec3[]>()
  for (let si = 0; si < descs.length; si++) {
    const d = descs[si]
    if (d.type !== 'SPLIT') continue
    const idx: number[] = []
    for (let i = 0; i < cps.length; i++) if (cps[i].seg === si) idx.push(i)
    if (idx.length < 2) continue
    const first = idx[0]
    const last = idx[idx.length - 1] + 1 // the CP that starts the next segment
    const half = (d.separation ?? 22) / 2
    const other: Vec3[] = [cps[first - 1]?.p.clone() ?? cps[first].p.clone()]
    for (let i = first; i <= last && i < cps.length; i++) {
      const u = (i - first) / (last - first)
      const w = smoothstep(0, SPLIT_RAMP, u) * (1 - smoothstep(1 - SPLIT_RAMP, 1, u))
      const cp = cps[i]
      other.push(cp.p.clone().addScaled(cp.right, half * w))
      cp.p.addScaled(cp.right, -half * w)
    }
    other.push(cps[Math.min(last + 1, cps.length - 1)].p.clone())
    branchCps.set(si, other)
  }

  // --- resample the trunk by arc length ----------------------------------------
  const points = cps.map((c) => c.p)
  const spanSeg = cps.map((c) => c.seg)
  const { spline, sampleSeg } = resample(points, spanSeg)

  // --- segments -------------------------------------------------------------------
  const segments: Segment[] = []
  for (let si = 0; si < descs.length; si++) {
    let first = -1
    let last = -1
    for (let i = 0; i < sampleSeg.length; i++) {
      if (sampleSeg[i] === si) {
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0) {
      // Degenerate (too short to own a sample): give it a zero-length slot.
      const prevEnd = segments.length ? segments[segments.length - 1].sEnd : 0
      first = Math.round(prevEnd / TRACK_SAMPLE_STEP)
      last = first - 1
    }
    const sStart = first * TRACK_SAMPLE_STEP
    const sEnd = (last + 1) * TRACK_SAMPLE_STEP
    segments.push({
      index: si,
      type: descs[si].type,
      sStart,
      sEnd,
      length: Math.max(sEnd - sStart, 1e-6),
      difficulty: descs[si].difficulty ?? 0,
      mix: descs[si].mix ?? null,
      branch: null,
    })
  }
  segments[segments.length - 1].sEnd = spline.length

  // --- radius, arc ------------------------------------------------------------------
  fillProfile(spline, sampleSeg, descs, segments)

  // --- frames ---------------------------------------------------------------------------
  computeFrames(spline, sampleSeg, descs, segments, null)

  // --- branches ---------------------------------------------------------------------------
  for (const [si, pts] of branchCps) {
    const seg = segments[si]
    const segIds = pts.map(() => si)
    const { spline: bs } = resample(pts, segIds)
    const r = descs[si].radius ?? TUNNEL_RADIUS_DEFAULT
    bs.radius.fill(r)
    bs.arc.fill(ARC_TUBE)
    // Start the branch frame from the trunk's frame at the split entrance so
    // the two tubes share a floor.
    const f0 = makeFrame()
    spline.frameAt(seg.sStart, f0)
    computeFrames(bs, segIds.slice(0, bs.n), descs, segments, f0.nor)
    seg.branch = bs
  }

  // --- features ---------------------------------------------------------------------
  const gates: number[] = []
  const boosts: BoostStrip[] = []
  const rings: Ring[] = []
  const pickups: PlacedPickup[] = []
  const bosses: number[] = []
  const fr = makeFrame()
  for (let si = 0; si < descs.length; si++) {
    const d = descs[si]
    const seg = segments[si]
    if (d.type === 'GATE') gates.push((seg.sStart + seg.sEnd) / 2)
    for (const f of d.features ?? []) {
      switch (f.kind) {
        case 'BOOST':
          boosts.push({
            sStart: seg.sStart + f.sStart,
            sEnd: Math.min(seg.sEnd, seg.sStart + f.sEnd),
            theta: f.theta,
            halfWidth: f.halfWidth,
          })
          break
        case 'RING': {
          const s = seg.sStart + f.s
          spline.frameAt(s, fr)
          const p = fr.pos.clone().addScaled(fr.bin, f.right).addScaled(fr.nor, -f.up)
          rings.push({ s, pos: p, radius: 7 })
          break
        }
        case 'PICKUP':
          pickups.push({ s: seg.sStart + f.s, theta: f.theta, pickup: f.pickup })
          break
        case 'BOSS':
          bosses.push(seg.sStart + f.s)
          break
      }
    }
  }
  boosts.sort((a, b) => a.sStart - b.sStart)
  rings.sort((a, b) => a.s - b.s)
  pickups.sort((a, b) => a.s - b.s)

  return new Track(course, spline, segments, gates, boosts, rings, pickups, bosses)
}

/**
 * Walk the Catmull-Rom through `points` and emit a sample every
 * TRACK_SAMPLE_STEP metres of arc length. `spanSeg[i]` is the segment owning
 * the span that starts at point i.
 */
function resample(points: Vec3[], spanSeg: number[]): { spline: TrackSpline; sampleSeg: number[] } {
  const n = points.length
  const phantom0 = points[0].clone().sub(points[1]).add(points[0])
  const phantomN = points[n - 1].clone().sub(points[n - 2]).add(points[n - 1])
  const P = (i: number) => (i < 0 ? phantom0 : i >= n ? phantomN : points[i])

  const outPos: number[] = []
  const outSeg: number[] = []
  const a = new Vec3()
  const b = new Vec3()
  let sAcc = 0
  let nextS = 0
  a.copy(points[0])
  for (let i = 0; i < n - 1; i++) {
    for (let k = 1; k <= FINE_STEPS; k++) {
      catmullRomPoint(P(i - 1), P(i), P(i + 1), P(i + 2), k / FINE_STEPS, b)
      const segLen = a.distanceTo(b)
      while (nextS <= sAcc + segLen) {
        const t = segLen > 1e-9 ? (nextS - sAcc) / segLen : 0
        outPos.push(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t))
        outSeg.push(spanSeg[i])
        nextS += TRACK_SAMPLE_STEP
      }
      sAcc += segLen
      a.copy(b)
    }
  }
  const count = outPos.length / 3
  const spline = new TrackSpline(count)
  spline.pos.set(outPos)
  // Central-difference tangents.
  for (let i = 0; i < count; i++) {
    const i0 = Math.max(0, i - 1)
    const i1 = Math.min(count - 1, i + 1)
    const x = outPos[i1 * 3] - outPos[i0 * 3]
    const y = outPos[i1 * 3 + 1] - outPos[i0 * 3 + 1]
    const z = outPos[i1 * 3 + 2] - outPos[i0 * 3 + 2]
    const l = Math.hypot(x, y, z) || 1
    spline.tan[i * 3] = x / l
    spline.tan[i * 3 + 1] = y / l
    spline.tan[i * 3 + 2] = z / l
  }
  return { spline, sampleSeg: outSeg }
}

/** Per-sample radius and geometry arc, blending from the previous segment. */
function fillProfile(spline: TrackSpline, sampleSeg: number[], descs: SegmentDesc[], segments: Segment[]): void {
  let prevRadius = descs[0].radius ?? TUNNEL_RADIUS_DEFAULT
  let prevArc = arcForType(descs[0].type, ARC_TUBE)
  const segRadiusStart: number[] = []
  const segArcStart: number[] = []
  for (let si = 0; si < descs.length; si++) {
    segRadiusStart.push(prevRadius)
    segArcStart.push(prevArc)
    const d = descs[si]
    prevRadius = d.radius ?? prevRadius
    if (d.type === 'BERM_IN') prevArc = ARC_TUBE
    else if (d.type === 'BERM_OUT') prevArc = arcForType('OPEN', prevArc)
    else prevArc = arcForType(d.type, prevArc)
  }
  for (let i = 0; i < spline.n; i++) {
    const si = sampleSeg[i] ?? sampleSeg[sampleSeg.length - 1]
    const seg = segments[si]
    const d = descs[si]
    const s = i * TRACK_SAMPLE_STEP
    const u = clamp((s - seg.sStart) / seg.length, 0, 1)
    const blend = smoothstep(0, Math.min(PROFILE_BLEND_LENGTH, seg.length), s - seg.sStart)
    const targetRadius = d.radius ?? segRadiusStart[si]
    spline.radius[i] = lerp(segRadiusStart[si], targetRadius, blend)
    let arc: number
    if (d.type === 'BERM_IN') arc = lerp(segArcStart[si], ARC_TUBE, smoothstep(0, 1, u))
    else if (d.type === 'BERM_OUT') arc = lerp(segArcStart[si], arcForType('OPEN', 0), smoothstep(0, 1, u))
    else if (d.type === 'GAP') arc = 0
    else arc = lerp(segArcStart[si], arcForType(d.type, segArcStart[si]), blend)
    spline.arc[i] = arc
  }
}

/**
 * Parallel-transport frames along the tangent table, then a roll signal on
 * top: open profiles level their floor toward world-down, tubes carry authored
 * banking, and the whole signal is unwrapped and box-filtered so nothing snaps.
 */
function computeFrames(
  spline: TrackSpline,
  sampleSeg: number[],
  descs: SegmentDesc[],
  segments: Segment[],
  initialNor: Vec3 | null,
): void {
  const n = spline.n
  const tan = new Vec3()
  const prevTan = new Vec3()
  const nor = new Vec3()
  const axis = new Vec3()
  const ptNor = new Float32Array(n * 3)

  tan.set(spline.tan[0], spline.tan[1], spline.tan[2])
  if (initialNor) nor.copy(initialNor)
  else nor.copy(WORLD_DOWN)
  nor.projectOntoPlane(tan)
  if (nor.lengthSq() < 1e-6) nor.set(0, 0, -1).projectOntoPlane(tan)
  nor.normalize()
  for (let i = 0; i < n; i++) {
    prevTan.copy(tan)
    tan.set(spline.tan[i * 3], spline.tan[i * 3 + 1], spline.tan[i * 3 + 2])
    if (i > 0) {
      axis.cross(prevTan, tan)
      const sinA = axis.length()
      const cosA = clamp(prevTan.dot(tan), -1, 1)
      if (sinA > 1e-9) {
        axis.scale(1 / sinA)
        nor.rotateAxis(axis, Math.atan2(sinA, cosA))
      }
      nor.projectOntoPlane(tan).normalize()
    }
    ptNor[i * 3] = nor.x
    ptNor[i * 3 + 1] = nor.y
    ptNor[i * 3 + 2] = nor.z
  }

  // Roll signal.
  const raw = new Float32Array(n)
  const down = new Vec3()
  const cr = new Vec3()
  let prevRaw = 0
  const bankStart: number[] = []
  let prevBank = 0
  for (let si = 0; si < descs.length; si++) {
    bankStart.push(prevBank)
    prevBank = descs[si].type === 'TUBE' || descs[si].type === 'GATE' ? (descs[si].roll ?? 0) * DEG : 0
  }
  for (let i = 0; i < n; i++) {
    const si = sampleSeg[i] ?? sampleSeg[sampleSeg.length - 1]
    const seg = segments[si]
    const d = descs[si]
    tan.set(spline.tan[i * 3], spline.tan[i * 3 + 1], spline.tan[i * 3 + 2])
    nor.set(ptNor[i * 3], ptNor[i * 3 + 1], ptNor[i * 3 + 2])
    down.copy(WORLD_DOWN).projectOntoPlane(tan)
    const horiz = down.length()
    // Leveling weight fades out as the track goes vertical, where "down" is meaningless.
    const w = smoothstep(0.15, 0.6, horiz)
    let level = prevRaw
    if (horiz > 1e-4) {
      down.scale(1 / horiz)
      cr.cross(nor, down)
      level = Math.atan2(cr.dot(tan), clamp(nor.dot(down), -1, 1))
      // Keep continuity: pick the unwrapped representative nearest prevRaw.
      level = prevRaw + wrapAngle(level - prevRaw)
    }
    const s = i * TRACK_SAMPLE_STEP
    const blend = smoothstep(0, Math.min(PROFILE_BLEND_LENGTH, seg.length), s - seg.sStart)
    const bank = isLevelType(d.type) ? 0 : lerp(bankStart[si], (d.roll ?? 0) * DEG, blend)
    const target = lerp(prevRaw, level, w) + bank
    raw[i] = target
    prevRaw = target - bank
  }

  // Box filter over ROLL_SMOOTH_LENGTH.
  const half = Math.max(1, Math.round(ROLL_SMOOTH_LENGTH / TRACK_SAMPLE_STEP / 2))
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + raw[i]
  const bin = new Vec3()
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    const roll = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    tan.set(spline.tan[i * 3], spline.tan[i * 3 + 1], spline.tan[i * 3 + 2])
    nor.set(ptNor[i * 3], ptNor[i * 3 + 1], ptNor[i * 3 + 2]).rotateAxis(tan, roll).normalize()
    bin.cross(nor, tan)
    spline.nor[i * 3] = nor.x
    spline.nor[i * 3 + 1] = nor.y
    spline.nor[i * 3 + 2] = nor.z
    spline.bin[i * 3] = bin.x
    spline.bin[i * 3 + 1] = bin.y
    spline.bin[i * 3 + 2] = bin.z
  }
}
