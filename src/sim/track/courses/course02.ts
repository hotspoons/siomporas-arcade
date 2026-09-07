// Course 2 — "Vantablack Descent": ~14 km, tighter tubes, longer open air,
// two splits, interceptors from the start, armored mid-course, boss before
// the penultimate gate. Roll is used aggressively: this one corkscrews.

import type { CourseDesc, SegmentDesc } from '../SegmentDesc'

const MID = { DRONE: 5, BLOCKER: 3, MINE: 3, INTERCEPTOR: 2, HAULER: 1, TURRET: 1 }
const HARD = { DRONE: 4, BLOCKER: 3, MINE: 4, INTERCEPTOR: 3, ARMORED: 1, LIGHTBIKE: 2, TRAIN: 1 }
const BRUTAL = { DRONE: 3, BLOCKER: 3, MINE: 4, INTERCEPTOR: 3, ARMORED: 2, LIGHTBIKE: 2, SPINNER: 1, SWARM: 2 }

const segments: SegmentDesc[] = [
  { type: 'TUBE', length: 400, radius: 13 },
  { type: 'TUBE', length: 500, curve: { yaw: -40 }, roll: 35, difficulty: 0.45, mix: MID },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 700, curve: { yaw: 70, pitch: -10 }, roll: 60, difficulty: 0.55, mix: MID, features: [{ kind: 'BOOST', theta: 0.8, halfWidth: 0.2, sStart: 60, sEnd: 640 }] },
  { type: 'TUBE', length: 400, curve: { pitch: 10 }, radius: 11, difficulty: 0.6, mix: MID },
  { type: 'GATE', length: 20 },
  { type: 'SPLIT', length: 800, radius: 8, separation: 24, curve: { yaw: -30 }, difficulty: 0.6, mix: { DRONE: 5, MINE: 4, BLOCKER: 2 } },
  { type: 'TUBE', length: 300, radius: 14, difficulty: 0.4, mix: MID },
  { type: 'BERM_OUT', length: 220 },
  { type: 'OPEN', length: 700, curve: { yaw: 25 }, difficulty: 0.5, mix: { MINE: 5, DRONE: 4, INTERCEPTOR: 1 }, features: [{ kind: 'BOOST', theta: 0, halfWidth: 0.18, sStart: 100, sEnd: 600 }] },
  { type: 'OPEN', length: 140, curve: { pitch: 3 } },
  { type: 'GAP', length: 340, features: [{ kind: 'RING', s: 110, right: 0, up: 3 }, { kind: 'RING', s: 230, right: -5, up: 3 }, { kind: 'RING', s: 300, right: 5, up: 4 }] },
  { type: 'OPEN', length: 520, levelOut: true, difficulty: 0.3, mix: { DRONE: 5 } },
  { type: 'HALFPIPE', length: 600, curve: { yaw: -50 }, difficulty: 0.65, mix: HARD },
  { type: 'GATE', length: 20 },
  { type: 'BERM_IN', length: 220 },
  { type: 'TUBE', length: 900, curve: { yaw: 120 }, roll: 50, radius: 12, difficulty: 0.75, mix: HARD, features: [{ kind: 'BOOST', theta: -1.3, halfWidth: 0.2, sStart: 100, sEnd: 800 }] },
  { type: 'TUBE', length: 300, radius: 16, difficulty: 0.5, mix: { ARMORED: 4, DRONE: 2 } },
  { type: 'GATE', length: 20 },
  { type: 'SPLIT', length: 900, radius: 8, separation: 28, curve: { yaw: 40, pitch: -6 }, difficulty: 0.7, mix: { DRONE: 4, MINE: 5, INTERCEPTOR: 2 } },
  { type: 'TUBE', length: 400, radius: 13, curve: { pitch: 6 }, difficulty: 0.6, mix: HARD },
  { type: 'GATE', length: 20 },
  { type: 'BERM_OUT', length: 220 },
  { type: 'OPEN', length: 500, difficulty: 0.55, mix: { MINE: 6, INTERCEPTOR: 2 } },
  { type: 'OPEN', length: 120, curve: { pitch: 2 } },
  { type: 'GAP', length: 420, features: [{ kind: 'RING', s: 140, right: 0, up: 3 }, { kind: 'RING', s: 280, right: 0, up: 5 }, { kind: 'RING', s: 380, right: 0, up: 3 }] },
  { type: 'OPEN', length: 560, levelOut: true },
  { type: 'BERM_IN', length: 240 },
  { type: 'TUBE', length: 300, difficulty: 0.3, mix: HARD, features: [{ kind: 'BOSS', s: 40 }] },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 800, curve: { yaw: -100 }, roll: -55, radius: 11, difficulty: 0.85, mix: BRUTAL, features: [{ kind: 'BOOST', theta: 1.0, halfWidth: 0.18, sStart: 80, sEnd: 720 }] },
  { type: 'HALFPIPE', length: 600, curve: { yaw: 30, pitch: -6 }, difficulty: 0.8, mix: BRUTAL },
  { type: 'TUBE', length: 400, curve: { pitch: 6 }, radius: 14, difficulty: 0.6, mix: BRUTAL },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 300 },
]

export const COURSE_02: CourseDesc = {
  id: 'vantablack',
  name: 'Vantablack Descent',
  seed: 202,
  palette: 0.78,
  segments,
}
