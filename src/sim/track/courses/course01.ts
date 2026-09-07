// Course 1 — "Meridian Line": ~12 km, every segment type, gentle ramp.
// Difficulty numbers are spawn pressure (0..1). Boost strips are authored as
// lines to trace; jumps are shaped for cruise speed with a little in hand.

import type { CourseDesc, SegmentDesc } from '../SegmentDesc'

const EASY = { DRONE: 6, BLOCKER: 2, MINE: 2, INTERCEPTOR: 0, ARMORED: 0 }
const MID = { DRONE: 5, BLOCKER: 3, MINE: 3, INTERCEPTOR: 1, ARMORED: 0 }
const HARD = { DRONE: 4, BLOCKER: 3, MINE: 3, INTERCEPTOR: 2, ARMORED: 1 }

const segments: SegmentDesc[] = [
  { type: 'TUBE', length: 500, radius: 14 },
  { type: 'TUBE', length: 400, curve: { yaw: 25 }, difficulty: 0.3, mix: EASY },
  { type: 'GATE', length: 20 },
  {
    type: 'TUBE',
    length: 600,
    curve: { yaw: -60 },
    roll: 30,
    difficulty: 0.4,
    mix: EASY,
    features: [{ kind: 'BOOST', theta: 0, halfWidth: 0.22, sStart: 80, sEnd: 420 }],
  },
  { type: 'HALFPIPE', length: 700, curve: { yaw: 40 }, difficulty: 0.5, mix: EASY },
  { type: 'GATE', length: 20 },
  { type: 'BERM_OUT', length: 220 },
  { type: 'OPEN', length: 500, curve: { yaw: 10 }, difficulty: 0.35, mix: { DRONE: 4, MINE: 4 } },
  { type: 'OPEN', length: 160, curve: { pitch: 3 } },
  {
    type: 'GAP',
    length: 260,
    features: [
      { kind: 'RING', s: 90, right: 0, up: 3 },
      { kind: 'RING', s: 180, right: 5, up: 3 },
    ],
  },
  { type: 'OPEN', length: 460, levelOut: true },
  { type: 'BERM_IN', length: 240 },
  { type: 'TUBE', length: 500, curve: { yaw: -45 }, radius: 18, difficulty: 0.5, mix: MID },
  { type: 'GATE', length: 20 },
  { type: 'SPLIT', length: 700, radius: 9, separation: 26, curve: { yaw: 15 }, difficulty: 0.5, mix: { DRONE: 5, MINE: 3, BLOCKER: 1 } },
  { type: 'TUBE', length: 300, radius: 14, difficulty: 0.3, mix: MID },
  {
    type: 'TUBE',
    length: 600,
    curve: { yaw: 80 },
    roll: 40,
    difficulty: 0.6,
    mix: MID,
    features: [{ kind: 'BOOST', theta: 1.1, halfWidth: 0.2, sStart: 60, sEnd: 540 }],
  },
  { type: 'TUBE', length: 300, difficulty: 0.2, mix: MID, features: [{ kind: 'BOSS', s: 40 }] },
  { type: 'GATE', length: 20 },
  { type: 'HALFPIPE', length: 800, curve: { yaw: -30, pitch: -8 }, difficulty: 0.7, mix: MID },
  { type: 'TUBE', length: 400, curve: { pitch: 8 }, radius: 12, difficulty: 0.6, mix: { ARMORED: 3, DRONE: 3 } },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 600, curve: { yaw: 50 }, roll: -35, difficulty: 0.7, mix: HARD },
  { type: 'BERM_OUT', length: 220 },
  { type: 'OPEN', length: 400, difficulty: 0.4, mix: { MINE: 5, DRONE: 3 } },
  { type: 'OPEN', length: 140, curve: { pitch: 2 } },
  {
    type: 'GAP',
    length: 320,
    features: [
      { kind: 'RING', s: 110, right: -5, up: 3 },
      { kind: 'RING', s: 220, right: 5, up: 3 },
    ],
  },
  { type: 'OPEN', length: 500, levelOut: true },
  { type: 'BERM_IN', length: 240 },
  { type: 'GATE', length: 20 },
  {
    type: 'TUBE',
    length: 800,
    curve: { yaw: -90 },
    roll: 40,
    difficulty: 0.8,
    mix: HARD,
    features: [{ kind: 'BOOST', theta: -1.0, halfWidth: 0.2, sStart: 100, sEnd: 700 }],
  },
  { type: 'TUBE', length: 400, radius: 16, difficulty: 0.5, mix: HARD },
  { type: 'GATE', length: 20 },
  { type: 'TUBE', length: 300 },
]

export const COURSE_01: CourseDesc = {
  id: 'meridian',
  name: 'Meridian Line',
  seed: 101,
  palette: 0.53,
  segments,
}
