// Presentation constants. Nothing here affects gameplay.

export const CHUNK_LENGTH = 200
export const CHUNKS_AHEAD = 12
export const CHUNKS_BEHIND = 3
/** Metres between vertex rings along the tunnel. */
export const RING_SPACING = 4
export const RING_SEGMENTS_MODERN = 32
export const RING_SEGMENTS_RETRO = 12
/** Where fog fully hides the geometry cut-off. */
export const DRAW_DISTANCE = 1800
export const FOG_DENSITY_MODERN = 0.0011
export const FOG_DENSITY_RETRO = 0.0016

export const FOV_BASE = 75
export const FOV_AT_MAX_SPEED = 96
/** Extra FOV on boost strips. */
export const FOV_BOOST_KICK = 6

/** Chase camera: behind and above the craft, in metres. */
export const CAM_BACK = 13
export const CAM_UP = 4.2
/** Look-ahead point distance along the track. */
export const CAM_LOOK_AHEAD = 42
/** How fast the camera's theta chases the craft's (1/s). Lower = more swing. */
export const CAM_THETA_LAG = 9
/** Fraction of the craft's visual bank the camera adopts. */
export const CAM_BANK_FOLLOW = 0.35
export const CAM_SHAKE_DECAY = 4.5
export const CAM_SHAKE_AMPLITUDE = 0.6

export const SPEED_LINE_COUNT = 260
/** Speed lines only appear above this speed (m/s). */
export const SPEED_LINE_MIN_SPEED = 260

export const MAX_PARTICLES = 1024
export const MAX_IMPACTS = 64
export const GATE_POOL = 6
export const RING_POOL = 24

/** Palette: neon on dark. Hue is shifted per course by CourseDesc.palette. */
export const BG_COLOR = 0x06040f
export const FLOATING_ORIGIN_REBASE = 20000

/** Presentation slow-mo floor so the loop never stalls. */
export const MIN_TIME_SCALE = 0.25
