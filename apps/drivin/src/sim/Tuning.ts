// Every gameplay constant for the driving game. Metres, seconds, radians.

// --- loop ---
export const SIM_HZ = 120
export const SIM_DT = 1 / SIM_HZ
export const MAX_SUBSTEPS = 8

// --- grid ---
/** Side of one editor cell, metres. Every piece footprint is whole cells. */
export const CELL = 40
/** Height of one elevation level, metres. Ramps climb exactly one per cell. */
export const LEVEL_H = 8
/** Half the drivable road width. */
export const ROAD_HALF_WIDTH = 5
/** Curb width beyond the road edge (visual + rumble). */
export const CURB_WIDTH = 0.8
/** Metres between baked path samples. */
export const PATH_STEP = 1
/** Radius of vertical loops and corkscrews. */
export const LOOP_RADIUS = 9
/** Round tunnel radius (the road is the floor). */
export const TUBE_RADIUS = 7
/** Lateral shift across a loop so the exit clears the entry, metres. */
export const LOOP_SHIFT = 3
/** How far off the road (grass) you can wander on ground-level pieces before you are simply lost. */
export const GRASS_LIMIT = 60

// --- car (defaults; CarSpec overrides) ---
export const GRAVITY = 9.81
/** Height of the car's reference point above the surface. */
export const CAR_RIDE = 0.35
export const CAR_HALF_LENGTH = 2.2
export const CAR_HALF_WIDTH = 0.95
/** Max heading offset from the path tangent (rad) while gripping. */
export const HEADING_MAX = 1.1
/** Speed below which steering authority is at its maximum (m/s). */
export const STEER_FULL_SPEED = 12
/** Steering authority multiplier at top speed. */
export const STEER_HIGH_SPEED_FACTOR = 0.35
/** Self-aligning torque: how fast the heading returns to the tangent (1/s). */
export const ALIGN_RATE = 3.2
/** Lateral grip: max lateral acceleration the tyres provide, m/s². */
export const GRIP_LATERAL = 22
/** Rolling drag and aero drag. */
export const DRAG_ROLLING = 0.5
export const DRAG_AERO = 0.0006
/** Extra deceleration on grass and the grip left there. */
export const GRASS_DRAG = 6
export const GRASS_GRIP_SCALE = 0.35
/** Speed lost per second while scraping a curb/wall. */
export const CURB_SLOW = 4

// --- air / crash ---
export const LAND_TOLERANCE = 1.2
/** Land only if the car's up and the surface normal roughly agree. */
export const LAND_MIN_ALIGN = 0.35
/** Impact speed into a surface (m/s) that wrecks the car. */
export const CRASH_IMPACT_SPEED = 22
/** Below this world height you are gone. */
export const FALL_LIMIT = -30
/** How many seconds of poses the crash replay keeps. */
export const REPLAY_SECONDS = 6
/** Seconds the crash replay plays before respawn. */
export const REPLAY_PLAY_SECONDS = 4.5

// --- run rules ---
/** Rolling start after a crash so stunts right after the respawn point are makeable. */
export const RESPAWN_SPEED = 20
export const CRASH_TIME_PENALTY = 5
