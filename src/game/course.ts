// What's *in* the conduit: wall blocks to dodge, boost pads to graze, and
// checkpoint arches that buy you more clock. Generated once per seed, sorted
// by distance so the renderer and the collision check can both walk a window
// of it with a moving cursor instead of scanning the whole course.

import { CHECKPOINT_SPACING } from './constants'
import type { Track } from './track'

export type ItemKind = 'block' | 'pad' | 'gate'

export interface CourseItem {
  kind: ItemKind
  /** Arc length along the centreline. */
  s: number
  /** Roll angle around the tube. Ignored for gates (they span it). */
  theta: number
  /** Set once the craft has collected/passed it, so it only fires once. */
  taken: boolean
  /** Checkpoint index, for gates only. */
  index: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Blocks/pads start this far in, so you get a moment to read the tunnel. */
const RUN_IN = 500
const CLUSTER_SPACING = 95

export function buildCourse(track: Track, seed: number): CourseItem[] {
  const rnd = mulberry32(seed ^ 0x9e3779b9)
  const items: CourseItem[] = []

  // Checkpoint arches on a fixed cadence — the run's pacing skeleton.
  let index = 0
  for (let s = CHECKPOINT_SPACING; s < track.length - 300; s += CHECKPOINT_SPACING) {
    items.push({ kind: 'gate', s, theta: 0, taken: false, index: index++ })
  }

  // Obstacle clusters. Difficulty ramps with distance: later clusters are
  // wider (more blocks at nearby angles), which is what closes the safe gap.
  for (let s = RUN_IN; s < track.length - 400; s += CLUSTER_SPACING * (0.7 + rnd() * 0.7)) {
    const progress = s / track.length
    const count = 1 + Math.floor(rnd() * (1 + progress * 2.4))
    const base = rnd() * Math.PI * 2
    for (let i = 0; i < count; i++) {
      items.push({
        kind: 'block',
        s: s + (rnd() - 0.5) * 26,
        theta: base + i * (0.62 + rnd() * 0.35),
        taken: false,
        index: -1,
      })
    }
    // A pad roughly opposite the cluster: the line that dodges also rewards.
    if (rnd() < 0.55) {
      items.push({
        kind: 'pad',
        s: s + 60 + rnd() * 40,
        theta: base + Math.PI + (rnd() - 0.5) * 0.8,
        taken: false,
        index: -1,
      })
    }
  }

  items.sort((a, b) => a.s - b.s)
  return items
}
