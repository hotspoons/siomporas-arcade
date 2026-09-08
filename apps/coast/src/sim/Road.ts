// The road as a list of segments — the classic pseudo-3D representation.
// Curve is the change in lateral offset per segment (accumulated by the
// renderer from the camera outward, which is what makes distant road sweep);
// y is the hill height at the segment start. Sprites hang off segments at a
// lateral offset in road widths (|offset| > 1 is off the tarmac).

import { Rng } from '@apex/engine/math/Rng'
import { CROSSING_EVERY, FORK_SEGMENTS, ROLL_AMPLITUDE, RUNWAY_SEGMENTS, SEG_LENGTH, STAGE_SCALE } from './Tuning'

export interface SpriteRef {
  kind: string
  /** Lateral offset in road widths; sprites are anchored at their bottom centre. */
  offset: number
  /** Uniform scale multiplier on the kind's natural size. */
  scale: number
  /** Whether the player can hit it. */
  collide: boolean
}

export interface Segment {
  index: number
  curve: number
  /** Hill height at the start / end of the segment. */
  y0: number
  y1: number
  sprites: SpriteRef[]
  /** 0..1 through the fork zone; -1 outside it. */
  fork: number
  /** First segment of a stage: crossing it is the checkpoint. */
  checkpoint: boolean
  /** Beyond the stage's real end (filler for the horizon). */
  runway: boolean
  /** An intersection: a road crosses here and so does traffic. */
  crossing: boolean
  /** The sea comes right up to the road on this side (-1 left, +1 right, 0 none): a sliver of beach, then water. */
  shore: number
  /** Roadworks: the outer lane on this side (-1/+1) is shut behind a jersey barrier; 0 = open. */
  closed: number
  /** Banking strength 0..1: the outer side of the curve rises in terraces and the cockpit leans. */
  bank: number
  /** Inside a tunnel: walls and a ceiling close in, the sky is gone. `portal` marks the entrance face. */
  tunnel: boolean
  portal: boolean
}

export interface Theme {
  id: string
  /** Sky/ground palette hints for the renderer. */
  palette: string
  /** Roadside sprite kinds, weighted, placed at random offsets. */
  roadside: { kind: string; weight: number; minOffset: number; maxOffset: number; scale?: number; collide?: boolean }[]
  /** Density: probability per segment per side. */
  density: number
  /** Landmark kinds placed every `landmarkEvery` segments, alternating sides. */
  landmarks: string[]
  landmarkEvery: number
  /** Far background layer id. */
  backdrop: string
  /** Drivable lanes drawn (2–4). */
  lanes: number
  /** Continuous guardrail along the road edges. */
  rails: boolean
  night?: boolean
  rain?: boolean
  /** Share of traffic driving toward you (two-lane country roads). */
  oncoming?: number
  /** Intersections with crossing traffic every CROSSING_EVERY segments. */
  crossings?: boolean
  /** Default banking for every curve in this theme (0 = flat, 1 = full Rad Mobile terraces); sections can override with `bank`. */
  bank?: number
  /** Everything roadside and on the horizon is drawn as a black silhouette against the sky (the sunset). */
  silhouette?: boolean
  /** OutRun's first stage: stretches where the ocean touches the road edge past a narrow beach. */
  shore?: boolean
  /** Occasional roadworks: barriers taper the outer lane shut, a jersey barrier runs along it, then it reopens. */
  workZones?: boolean
}

export type Section =
  | { kind: 'straight'; n: number; hill?: number }
  | { kind: 'curve'; n: number; curve: number; hill?: number; bank?: number }
  | { kind: 's'; n: number; curve: number; bank?: number }
  | { kind: 'hills'; n: number; height: number; count: number }
  | { kind: 'tunnel'; n: number; curve?: number }

export interface StageDesc {
  id: string
  name: string
  theme: string
  sections: Section[]
  /** Next stages: two ids = fork (left, right); one = straight on; none = final. */
  next: string[]
}

export class Stage {
  readonly desc: StageDesc
  readonly segments: Segment[] = []
  /** Real (non-runway) length in segments. */
  readonly length: number
  readonly forks: boolean

  constructor(desc: StageDesc, theme: Theme, seed: number) {
    this.desc = desc
    this.forks = desc.next.length === 2
    const rng = new Rng(seed)
    let y = 0
    const segs = this.segments
    const push = (curve: number, y1: number, bank = 0) => {
      segs.push({ index: segs.length, curve, y0: y, y1, sprites: [], fork: -1, checkpoint: false, runway: false, crossing: false, shore: 0, closed: 0, bank, tunnel: false, portal: false })
      y = y1
    }
    const ease = (a: number, b: number, t: number) => a + (b - a) * (0.5 - Math.cos(t * Math.PI) / 2)
    const easeIn = (a: number, b: number, t: number) => a + (b - a) * t * t
    const easeOut = (a: number, b: number, t: number) => a + (b - a) * (1 - (1 - t) * (1 - t))
    const addRoad = (enter: number, hold: number, leave: number, curve: number, hill: number, bank = 0) => {
      const startY = y
      const total = enter + hold + leave
      let n = 0
      // Banking builds with the curve and fades out with it.
      for (let i = 0; i < enter; i++, n++) push(easeIn(0, curve, i / enter), ease(startY, startY + hill, (n + 1) / total), bank * easeIn(0, 1, i / enter))
      for (let i = 0; i < hold; i++, n++) push(curve, ease(startY, startY + hill, (n + 1) / total), bank)
      for (let i = 0; i < leave; i++, n++) push(easeOut(curve, 0, i / leave), ease(startY, startY + hill, (n + 1) / total), bank * easeOut(1, 0, i / leave))
    }
    for (const raw of desc.sections) {
      const s = { ...raw, n: Math.max(12, Math.round(raw.n * STAGE_SCALE)) }
      switch (s.kind) {
        case 'straight':
          addRoad(0, s.n, 0, 0, s.hill ?? 0)
          break
        case 'curve': {
          const e = Math.max(3, Math.floor(s.n * 0.3))
          addRoad(e, s.n - 2 * e, e, s.curve, s.hill ?? 0, s.bank ?? theme.bank ?? 0)
          break
        }
        case 's': {
          const half = Math.floor(s.n / 2)
          const e = Math.max(3, Math.floor(half * 0.3))
          addRoad(e, half - 2 * e, e, s.curve, 0, s.bank ?? theme.bank ?? 0)
          addRoad(e, half - 2 * e, e, -s.curve, 0, s.bank ?? theme.bank ?? 0)
          break
        }
        case 'tunnel': {
          // A bore through the hill: gently curved or straight, level, marked so the renderer closes it in.
          const first = segs.length
          const c = s.curve ?? 0
          const e = Math.max(3, Math.floor(s.n * 0.25))
          addRoad(c ? e : 0, s.n - (c ? 2 * e : 0), c ? e : 0, c, 0)
          for (let i = first; i < segs.length; i++) segs[i].tunnel = true
          segs[first].portal = true
          break
        }
        case 'hills': {
          // Each hump climbs then drops, so a hills section ends where it began.
          const per = Math.floor(s.n / s.count)
          for (let i = 0; i < s.count; i++) {
            addRoad(0, Math.floor(per / 2), 0, 0, s.height)
            addRoad(0, per - Math.floor(per / 2), 0, 0, -s.height)
          }
          break
        }
      }
    }
    // Return to level ground before the end so stages join cleanly.
    if (Math.abs(y) > 0.01) addRoad(0, 40, 0, 0, -y)
    this.length = segs.length
    // Rolling undulation everywhere: a gentle swell that crests every ~50
    // segments and completes whole periods over the stage, so the road is
    // always rising or falling a little — the classic rhythm. Tunnels stay flat.
    const periods = Math.max(1, Math.round(this.length / 52))
    for (let i = 0; i < this.length; i++) {
      const s0 = segs[i]
      if (s0.tunnel) continue
      const a0 = (i / this.length) * Math.PI * 2 * periods
      const a1 = ((i + 1) / this.length) * Math.PI * 2 * periods
      s0.y0 += ROLL_AMPLITUDE * Math.sin(a0)
      s0.y1 += ROLL_AMPLITUDE * Math.sin(a1)
    }
    if (segs.length) segs[0].checkpoint = true
    if (this.forks) {
      for (let i = 0; i < FORK_SEGMENTS && i < segs.length; i++) {
        const s = segs[segs.length - FORK_SEGMENTS + i]
        s.fork = (i + 1) / FORK_SEGMENTS
        s.curve = 0
      }
    }
    // Intersections: on straight-ish road, well clear of the split and the start.
    if (theme.crossings) {
      for (let i = CROSSING_EVERY; i < this.length - FORK_SEGMENTS - 20; i += CROSSING_EVERY) {
        const s = segs[i]
        if (Math.abs(s.curve) > 1.2 || s.tunnel) continue
        // Two segments deep so the crossing road reads as a road, not a stripe.
        s.crossing = true
        segs[i + 1].crossing = true
      }
    }
    // Shoreline: runs of sea against the road, alternating sides, with dry land between.
    if (theme.shore) {
      let i = 30 + rng.int(40)
      let side = rng.next() < 0.5 ? -1 : 1
      while (i < this.length - FORK_SEGMENTS - 10) {
        const run = 40 + rng.int(60)
        for (let k = 0; k < run && i + k < this.length; k++) segs[i + k].shore = side
        i += run + 30 + rng.int(70)
        side = -side
      }
    }
    // Roadworks: a few construction barriers steer you out of the outer lane, then a jersey
    // barrier runs along the lane line for the closed stretch, and the cones taper back out.
    if (theme.workZones) {
      let i = 120 + rng.int(160)
      while (i + 90 < this.length - FORK_SEGMENTS - 30) {
        const side = rng.next() < 0.5 ? -1 : 1
        const len = 40 + rng.int(40)
        const taper = [0.98, 0.84, 0.7, 0.58]
        taper.forEach((o, k) => segs[i + k * 2].sprites.push({ kind: 'barrier', offset: side * o, scale: 0.8, collide: true }))
        for (let k = 8; k < len - 8; k++) segs[i + k].closed = side
        taper.forEach((o, k) => segs[i + len - 1 - k * 2].sprites.push({ kind: 'barrier', offset: side * o, scale: 0.8, collide: true }))
        i += len + 260 + rng.int(220)
      }
    }
    // Scenery.
    for (let i = 8; i < this.length; i++) {
      const seg = segs[i]
      if (seg.fork > 0.15 || seg.tunnel) continue // keep the split clear; nothing grows in a tunnel
      if (segs[Math.max(0, i - 3)].crossing || segs[Math.min(this.length - 1, i + 3)].crossing || seg.crossing) continue // keep intersections open
      for (const side of [-1, 1]) {
        if (seg.shore === side) continue // nothing grows in the sea
        if (rng.next() < theme.density) {
          const total = theme.roadside.reduce((a, r) => a + r.weight, 0)
          let pick = rng.next() * total
          let r = theme.roadside[0]
          for (const cand of theme.roadside) {
            pick -= cand.weight
            if (pick < 0) {
              r = cand
              break
            }
          }
          seg.sprites.push({ kind: r.kind, offset: side * rng.range(r.minOffset, r.maxOffset), scale: (r.scale ?? 1) * rng.range(0.9, 1.15), collide: r.collide ?? true })
        }
      }
      if (theme.landmarks.length && i % theme.landmarkEvery === 0) {
        const k = theme.landmarks[Math.floor(i / theme.landmarkEvery) % theme.landmarks.length]
        const side = Math.floor(i / theme.landmarkEvery) % 2 === 0 ? -1 : 1
        seg.sprites.push({ kind: k, offset: side * 1.9, scale: 1, collide: true })
      }
    }
    // Start gantry on the first segment of the stage.
    if (segs.length > 2) segs[2].sprites.push({ kind: 'gantry', offset: 0, scale: 1, collide: false })
    // Runway for the renderer.
    for (let i = 0; i < RUNWAY_SEGMENTS; i++) {
      segs.push({ index: segs.length, curve: 0, y0: y, y1: y, sprites: [], fork: this.forks ? 1 : -1, checkpoint: false, runway: true, crossing: false, shore: 0, closed: 0, bank: 0, tunnel: false, portal: false })
    }
  }

  /** Metres of real road. */
  get metres(): number {
    return this.length * SEG_LENGTH
  }

  /** Segment indices of the intersections, in order. */
  get crossings(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.length; i++) if (this.segments[i].crossing) out.push(i)
    return out
  }

  segmentAt(z: number): Segment {
    const i = Math.floor(z / SEG_LENGTH)
    return this.segments[Math.max(0, Math.min(this.segments.length - 1, i))]
  }

  /** Hill height at z (interpolated). */
  heightAt(z: number): number {
    const s = this.segmentAt(z)
    const t = (z - s.index * SEG_LENGTH) / SEG_LENGTH
    return s.y0 + (s.y1 - s.y0) * Math.max(0, Math.min(1, t))
  }
}
