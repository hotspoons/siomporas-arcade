// Tuning constants for the run. Everything the feel depends on lives here so
// balance passes are one file, not a scavenger hunt through the sim.

// --- conduit geometry -------------------------------------------------------

/** Base inner radius of the conduit. `Track.radiusAt` breathes around this. */
export const RADIUS_BASE = 26
/** Facets around the tube. 18 reads as "vector graphics" without shimmering. */
export const RADIAL_SEGMENTS = 18
/** Distance between wireframe rings — the primary speed cue. */
export const RING_SPACING = 20
/** Rings per recycled geometry chunk. */
export const CHUNK_RINGS = 12
/**
 * Chunks live in a pool: one behind the craft, the rest ahead. 9 × 12 × 20 =
 * 2160 units of tube, comfortably past where the fog closes in (~900).
 */
export const CHUNK_COUNT = 9
export const CHUNK_LEN = CHUNK_RINGS * RING_SPACING

/** How far in from the wall the craft's belly rides. */
export const SHIP_INSET = 1.9

// --- craft physics ----------------------------------------------------------

/** Cruise speeds (units/s) for brake / coast / thrust, before boost. */
export const SPEED_BRAKE = 130
export const SPEED_COAST = 250
export const SPEED_THRUST = 345
export const SPEED_BOOST_BONUS = 185
/** How hard the craft chases its cruise speed. Higher = twitchier. */
export const SPEED_LERP = 1.6
export const SPEED_MAX = 580

/** Roll around the tube: angular accel, cap, and damping (rad/s²·s⁻¹). */
export const TURN_ACCEL = 11
export const TURN_MAX = 3.1
export const TURN_DAMP = 5.5

/** Hop off the wall: initial inward velocity and the pull back out. */
export const JUMP_VEL = 27
export const GRAVITY = 66
/** Ceiling on the hop so you can't fly up the middle of the tube forever. */
export const LIFT_MAX = 14

// --- run rules --------------------------------------------------------------

export const SHIELD_MAX = 3
export const START_TIME = 45
/** Time added at each checkpoint arch. */
export const CHECKPOINT_BONUS = 20
export const CHECKPOINT_SPACING = 1700

export const BOOST_MAX = 100
/** Boost drained per second while held, and returned by a wall pad. */
export const BOOST_DRAIN = 34
export const BOOST_PAD_GAIN = 30

/** Speed kept after clipping an obstacle, and the grace period after a hit. */
export const HIT_SPEED_KEEP = 0.5
export const HIT_INVULN = 1.2

// --- collision envelopes ----------------------------------------------------

/** Angular half-width of a block, plus the craft's own half-width. */
export const BLOCK_HALF_ANGLE = 0.3
export const BLOCK_HALF_LEN = 8
export const BLOCK_HEIGHT = 6
export const PAD_HALF_ANGLE = 0.36

// --- camera -----------------------------------------------------------------

export const CAM_BACK = 17
export const CAM_AHEAD = 46
/** Camera rides a little further from the wall than the craft. */
export const CAM_INSET = 6.5
/** Camera roll lags the craft's, which is what sells a hard turn. */
export const CAM_THETA_LAG = 7
export const FOV_BASE = 74
export const FOV_SPEED_GAIN = 16

// --- look -------------------------------------------------------------------

export const FOG_DENSITY = 0.0023
export const BG_COLOR = 0x05030f
export const STREAK_COUNT = 220
