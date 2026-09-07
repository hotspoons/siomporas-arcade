// Cross-section rules per segment type: how much of the tube exists, and how
// far around it the player may go. Everything is analytic against these
// numbers — the tunnel mesh is a picture of the profile, never a collider.

import { ARC_HALFPIPE, ARC_OPEN, ARC_TUBE, EDGE_MARGIN, VEHICLE_HALF_WIDTH } from '../Tuning'
import type { SegmentType } from './SegmentDesc'

/** Geometry half-angle for a profile that doesn't blend. */
export function arcForType(type: SegmentType, previous: number): number {
  switch (type) {
    case 'TUBE':
    case 'SPLIT':
      return ARC_TUBE
    case 'HALFPIPE':
      return ARC_HALFPIPE
    case 'OPEN':
      return ARC_OPEN
    case 'GAP':
      return 0
    case 'BERM_IN':
      return ARC_TUBE // reached at the END of the segment; start blends from previous
    case 'BERM_OUT':
      return ARC_OPEN
    case 'GATE':
      return previous
  }
}

/** Whether a segment's floor is forced toward world-down (open air, jumps). */
export function isLevelType(type: SegmentType): boolean {
  return type !== 'TUBE' && type !== 'GATE'
}

/** Whether the profile has any surface to ride. */
export function hasSurface(arc: number): boolean {
  return arc > 0.01
}

/**
 * Player theta limit for a profile: the geometry edge minus the craft's half
 * width, in radians at this radius. Infinity when the tube is closed.
 */
export function playerClamp(arc: number, radius: number): number {
  if (arc >= ARC_TUBE - 1e-4) return Infinity
  return Math.max(0.05, arc - (VEHICLE_HALF_WIDTH + EDGE_MARGIN) / radius)
}
