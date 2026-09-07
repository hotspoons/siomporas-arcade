// Authoring vocabulary. A course is an ordered list of these; TrackBuilder
// bakes them into a Track. Values here are design intent, not baked truth —
// baked lengths differ slightly after arc-length resampling.

export type SegmentType =
  | 'TUBE'
  | 'HALFPIPE'
  | 'OPEN'
  | 'BERM_IN'
  | 'BERM_OUT'
  | 'GAP'
  | 'SPLIT'
  | 'GATE'

export type TrafficKind = 'DRONE' | 'BLOCKER' | 'MINE' | 'INTERCEPTOR' | 'ARMORED' | 'GATE_BOSS'

export type PickupKind = 'POD_SHOCK' | 'POD_SHIELD' | 'RING'

export type FeatureDesc =
  | {
      kind: 'BOOST'
      /** Angle around the tube (0 = floor). Strips are centred here. */
      theta: number
      /** Angular half-width of the strip. */
      halfWidth: number
      /** Metres from the segment start. */
      sStart: number
      sEnd: number
    }
  | {
      /** Floating score ring during flight. */
      kind: 'RING'
      /** Metres from the segment start. */
      s: number
      /** Offset from the centreline in the frame's (right, up) axes. */
      right: number
      up: number
    }
  | {
      /** A pickup pod placed by hand rather than by the spawner. */
      kind: 'PICKUP'
      pickup: PickupKind
      s: number
      theta: number
    }
  | {
      /** A gate boss guarding the next gate. */
      kind: 'BOSS'
      s: number
    }

export interface SegmentDesc {
  type: SegmentType
  /** Metres of centreline. */
  length: number
  /** Tube radius; blends from the previous segment. SPLIT: the branch radius. */
  radius?: number
  /** Total degrees turned over the segment. */
  curve?: { yaw?: number; pitch?: number }
  /** Banking in degrees (TUBE only; open profiles always level themselves). */
  roll?: number
  /** Override the profile's player clamp (radians, symmetric about the floor). */
  thetaClamp?: number
  /** Spawn pressure 0..1 for the deterministic spawner. Default 0. */
  difficulty?: number
  /** Relative weights of what spawns here. */
  mix?: Partial<Record<TrafficKind, number>>
  features?: FeatureDesc[]
  /** SPLIT only: lateral separation between the two branch centrelines. */
  separation?: number
  /** GAP only: speed the ballistic centreline is shaped for. */
  gapSpeed?: number
}

export interface CourseDesc {
  id: string
  name: string
  /** Seed for spawn decisions. */
  seed: number
  segments: SegmentDesc[]
  /** Hue shift for the tunnel palette (0..1), purely presentational. */
  palette: number
  timerStart?: number
}
