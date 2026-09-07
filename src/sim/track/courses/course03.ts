// Course 3 — "Helix Terminal": ~16 km, the hard one. Long banked corkscrews
// with boost lines on the walls, back-to-back gaps, a split inside a descent,
// two bosses, and a final open-air sprint with no walls at all.

import type { CourseDesc, SegmentDesc } from '../SegmentDesc'

const HARD = { DRONE: 4, BLOCKER: 3, MINE: 4, INTERCEPTOR: 3, ARMORED: 1, LIGHTBIKE: 2, TURRET: 1 }
const BRUTAL = { DRONE: 3, BLOCKER: 3, MINE: 5, INTERCEPTOR: 4, ARMORED: 2, LIGHTBIKE: 3, SPINNER: 2, SWARM: 2, TRAIN: 1 }
const WALL = { BLOCKER: 5, ARMORED: 3, DRONE: 2, HAULER: 2 }

const segments: SegmentDesc[] = [
  { type: 'TUBE', length: 350, radius: 12 },
  { type: 'TUBE', length: 800, curve: { yaw: 150 }, roll: 70, difficulty: 0.6, mix: HARD, features: [{ kind: 'BOOST', theta: 1.4, halfWidth: 0.2, sStart: 80, sEnd: 720 }] },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 800, curve: { yaw: -150 }, roll: -70, difficulty: 0.7, mix: HARD, features: [{ kind: 'BOOST', theta: -1.4, halfWidth: 0.2, sStart: 80, sEnd: 720 }] },
  { type: 'TUBE', length: 300, radius: 10, difficulty: 0.7, mix: WALL },
  { type: 'GATE', length: 20 },
  { type: 'BERM_OUT', length: 200 },
  { type: 'OPEN', length: 300, difficulty: 0.5, mix: { MINE: 6 } },
  { type: 'OPEN', length: 120, curve: { pitch: 3 } },
  { type: 'GAP', length: 300, features: [{ kind: 'RING', s: 100, right: 0, up: 3 }, { kind: 'RING', s: 200, right: 4, up: 3 }] },
  { type: 'OPEN', length: 420, levelOut: true },
  { type: 'OPEN', length: 120, curve: { pitch: 3 } },
  { type: 'GAP', length: 360, features: [{ kind: 'RING', s: 120, right: -4, up: 3 }, { kind: 'RING', s: 240, right: 4, up: 3 }, { kind: 'RING', s: 330, right: 0, up: 4 }] },
  { type: 'OPEN', length: 520, levelOut: true, difficulty: 0.4, mix: { INTERCEPTOR: 4, DRONE: 3 } },
  { type: 'BERM_IN', length: 220 },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 600, curve: { yaw: 60, pitch: -12 }, roll: 40, radius: 13, difficulty: 0.75, mix: BRUTAL },
  { type: 'SPLIT', length: 900, radius: 8, separation: 26, curve: { pitch: -8 }, difficulty: 0.75, mix: { MINE: 5, DRONE: 4, INTERCEPTOR: 2 } },
  { type: 'TUBE', length: 500, curve: { pitch: 20 }, radius: 14, difficulty: 0.5, mix: WALL },
  { type: 'TUBE', length: 300, difficulty: 0.3, mix: HARD, features: [{ kind: 'BOSS', s: 40 }] },
  { type: 'GATE', length: 20 },
  { type: 'HALFPIPE', length: 900, curve: { yaw: -90 }, difficulty: 0.85, mix: BRUTAL, features: [{ kind: 'BOOST', theta: 0, halfWidth: 0.18, sStart: 100, sEnd: 800 }] },
  { type: 'TUBE', length: 700, curve: { yaw: 90 }, roll: 60, radius: 11, difficulty: 0.9, mix: BRUTAL, features: [{ kind: 'BOOST', theta: 1.2, halfWidth: 0.18, sStart: 60, sEnd: 640 }] },
  { type: 'GATE', length: 20 },
  { type: 'SPLIT', length: 800, radius: 7.5, separation: 24, curve: { yaw: -20 }, difficulty: 0.8, mix: { MINE: 6, BLOCKER: 3 } },
  { type: 'TUBE', length: 300, radius: 12, difficulty: 0.4, mix: HARD, features: [{ kind: 'BOSS', s: 40 }] },
  { type: 'GATE', length: 20 },
  { type: 'BERM_OUT', length: 220 },
  { type: 'OPEN', length: 900, curve: { yaw: 35 }, difficulty: 0.9, mix: { MINE: 5, INTERCEPTOR: 4, DRONE: 3 }, features: [{ kind: 'BOOST', theta: 0, halfWidth: 0.16, sStart: 100, sEnd: 800 }] },
  { type: 'OPEN', length: 120, curve: { pitch: 2 } },
  { type: 'GAP', length: 460, features: [{ kind: 'RING', s: 150, right: 0, up: 3 }, { kind: 'RING', s: 300, right: 0, up: 5 }, { kind: 'RING', s: 420, right: 0, up: 3 }] },
  { type: 'OPEN', length: 600, levelOut: true, difficulty: 0.6, mix: { MINE: 6, DRONE: 4 } },
  { type: 'GATE', length: 20 },
  { type: 'OPEN', length: 300 },
]

export const COURSE_03: CourseDesc = {
  id: 'helix',
  name: 'Helix Terminal',
  seed: 303,
  palette: 0.08,
  segments,
}
