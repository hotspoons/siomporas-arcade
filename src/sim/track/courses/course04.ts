// Course 4 — "Cloverleaf": an homage to the shape-named courses of the 1989
// arcade original (clover-leafs, coat-hangers, roller-coasters) — inspired by
// their vocabulary, not copied from any layout. Four banked lobes of tube
// linked by narrow flats, tunnel "under construction" (short gaps in an
// otherwise closed tube), a split, a transit line and light-cycles.

import type { CourseDesc, SegmentDesc } from '../SegmentDesc'

const LOBE = { DRONE: 4, BLOCKER: 2, MINE: 3, LIGHTBIKE: 2, SPINNER: 1, HAULER: 1 }
const FLAT = { MINE: 4, SWARM: 3, TURRET: 2, DRONE: 2 }
const TRANSIT = { DRONE: 3, TRAIN: 2, HAULER: 2, ARMORED: 1 }

/** One clover lobe: a 270° banked sweep with a boost line on the outside wall. */
function lobe(sign: 1 | -1, difficulty: number, radius = 13): SegmentDesc[] {
  return [
    { type: 'TUBE', length: 250, radius, curve: { yaw: sign * 30 }, roll: sign * 20, difficulty: difficulty * 0.6, mix: LOBE },
    {
      type: 'TUBE',
      length: 800,
      curve: { yaw: sign * 210 },
      roll: sign * 55,
      difficulty,
      mix: LOBE,
      features: [{ kind: 'BOOST', theta: sign * 1.25, halfWidth: 0.2, sStart: 80, sEnd: 720 }],
    },
    { type: 'TUBE', length: 250, curve: { yaw: sign * 30 }, roll: sign * 20, difficulty: difficulty * 0.6, mix: LOBE },
  ]
}

/** Tunnel under construction: a level tube with the floor missing for a stretch. */
function construction(gap: number): SegmentDesc[] {
  return [
    { type: 'TUBE', length: 120 },
    { type: 'GAP', length: gap, features: [{ kind: 'RING', s: gap / 2, right: 0, up: 3 }] },
    { type: 'TUBE', length: 120 },
  ]
}

const segments: SegmentDesc[] = [
  { type: 'TUBE', length: 400, radius: 13, difficulty: 0.3, mix: TRANSIT },
  ...lobe(1, 0.5),
  { type: 'GATE', length: 20 },
  ...construction(90),
  { type: 'BERM_OUT', length: 200 },
  { type: 'OPEN', length: 600, curve: { yaw: -20 }, difficulty: 0.5, mix: FLAT, features: [{ kind: 'BOOST', theta: 0, halfWidth: 0.16, sStart: 80, sEnd: 520 }] },
  { type: 'BERM_IN', length: 200 },
  ...lobe(-1, 0.6),
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 500, radius: 15, difficulty: 0.55, mix: TRANSIT },
  ...construction(120),
  { type: 'SPLIT', length: 800, radius: 8, separation: 26, curve: { yaw: 20 }, difficulty: 0.6, mix: { DRONE: 4, MINE: 4, LIGHTBIKE: 2 } },
  { type: 'GATE', length: 20 },
  ...lobe(1, 0.7, 12),
  { type: 'TUBE', length: 300, curve: { pitch: -14 }, difficulty: 0.5, mix: TRANSIT },
  { type: 'TUBE', length: 300, curve: { pitch: 14 }, radius: 11, difficulty: 0.7, mix: { SPINNER: 3, DRONE: 3, MINE: 2 } },
  { type: 'GATE', length: 20 },
  { type: 'BERM_OUT', length: 200 },
  { type: 'OPEN', length: 500, difficulty: 0.6, mix: FLAT },
  { type: 'OPEN', length: 120, curve: { pitch: 3 } },
  { type: 'GAP', length: 300, features: [{ kind: 'RING', s: 100, right: 0, up: 3 }, { kind: 'RING', s: 200, right: 0, up: 5 }] },
  { type: 'OPEN', length: 460, levelOut: true, difficulty: 0.4, mix: { SWARM: 4 } },
  { type: 'BERM_IN', length: 220 },
  ...lobe(-1, 0.8),
  { type: 'TUBE', length: 300, difficulty: 0.3, mix: TRANSIT, features: [{ kind: 'BOSS', s: 40 }] },
  { type: 'GATE', length: 20 },
  ...construction(150),
  { type: 'TUBE', length: 500, radius: 14, difficulty: 0.75, mix: { LIGHTBIKE: 3, DRONE: 3, HAULER: 2, TRAIN: 1 } },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 300 },
]

export const COURSE_04: CourseDesc = {
  id: 'cloverleaf',
  name: 'Cloverleaf',
  seed: 404,
  palette: 0.33,
  segments,
}
