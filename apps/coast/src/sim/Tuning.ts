// Pseudo-3D racer constants. Metres, seconds, radians; x across the road is
// normalised so ±1 is the road edge.

export const SIM_HZ = 120
export const SIM_DT = 1 / SIM_HZ
export const MAX_SUBSTEPS = 8

/** Length of one road segment along z. */
export const SEG_LENGTH = 6
/** Half road width, metres. Lanes are drawn at thirds. */
export const ROAD_HALF_WIDTH = 8.5
/** Segments drawn ahead. */
export const DRAW_SEGMENTS = 260
/** Extra straight segments appended after a stage so the horizon never runs out during a fork. */
export const RUNWAY_SEGMENTS = 120
/** Segments at the end of a forking stage where the road splits. */
export const FORK_SEGMENTS = 70
/** Lateral separation of the two fork roads at the end, in road widths. */
export const FORK_SPREAD = 1.6
/** Multiplier on authored section lengths (stages are authored long, then scaled to ~a minute). */
export const STAGE_SCALE = 0.7
/** Alternate road bands every N segments (shorter = faster strobe = more speed). */
export const BAND_SEGMENTS = 2
/** Metres of gentle swell layered over every stage's hills. */
export const ROLL_AMPLITUDE = 3.2

// --- player ---
export const MAX_SPEED_HI = 84
export const MAX_SPEED_LO = 56
export const ACCEL_HI = 9
export const ACCEL_LO = 16
export const BRAKE_DECEL = 34
export const COAST_DECEL = 5
export const OFFROAD_MAX_SPEED = 26
export const OFFROAD_DECEL = 40
/** Steering: road widths per second at max speed, full lock. */
export const STEER_RATE = 1.9
/** Centrifugal push per unit curve per (speed/max)², road widths per second. */
export const CENTRIFUGAL = 0.36
export const CAR_HALF_WIDTH_ROAD = 0.11 // in road widths (~1.9 m)
/** Turbo: extra acceleration, extra top speed, duration, recharge. */
export const TURBO_ACCEL = 28
export const TURBO_TOP = 14
export const TURBO_TIME = 2.2
export const TURBO_RECHARGE = 14
/** Crash tumble duration and the speed you keep after a car bump. */
export const CRASH_TIME = 1.8
export const BUMP_KEEP = 0.85
/** Speed above which hitting a roadside object is a tumble instead of a scrape. */
export const CRASH_MIN_SPEED = 20

// --- traffic ---
export const TRAFFIC_COUNT = 14
export const TRAFFIC_MIN_SPEED = 22
export const TRAFFIC_MAX_SPEED = 48
export const TRAFFIC_SPAWN_AHEAD = 300 // segments
export const TRAFFIC_SPAWN_MIN = 90 // segments
export const TRAFFIC_DESPAWN_BEHIND = 40

// --- run ---
export const TIME_START = 75
export const TIME_CHECKPOINT = 62
export const SCORE_PER_METRE = 2
export const SCORE_PER_PASS = 120
export const SCORE_TIME_BONUS = 400
