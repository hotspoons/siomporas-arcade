// M1 vertical-slice course: ~3 km of closed tube with one long banked curve.
// Exists to answer "does driving feel good" before anything else is built.

import type { CourseDesc } from '../SegmentDesc'

export const TEST_COURSE: CourseDesc = {
  id: 'test',
  name: 'Proving Run',
  seed: 1,
  palette: 0.55,
  segments: [
    { type: 'TUBE', length: 600, radius: 14 },
    { type: 'TUBE', length: 300, curve: { yaw: 15 } },
    { type: 'GATE', length: 20 },
    { type: 'TUBE', length: 900, curve: { yaw: 110 }, roll: 35 },
    { type: 'TUBE', length: 300, curve: { pitch: -12 } },
    { type: 'TUBE', length: 300, curve: { pitch: 12 }, radius: 18 },
    { type: 'GATE', length: 20 },
    { type: 'TUBE', length: 600, curve: { yaw: -40 }, radius: 14 },
  ],
}
