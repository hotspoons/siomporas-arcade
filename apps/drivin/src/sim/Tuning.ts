// Every gameplay constant for the driving game. Metres, seconds, radians.

// --- loop ---
import { tune, type TuneSection } from '@apex/engine/app/TunePanel'
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
export const LOOP_RADIUS = 18
/** Corkscrew helix radius (metres). */
export const CORK_RADIUS = 14
/** Round tunnel radius (the road is the floor). */
export const TUBE_RADIUS = 11
/** Metres over which a tunnel's walls rise from curb height at each mouth (and sink again at the exit). */
export const TUBE_RAMP = 18
/** Lateral shift across a loop so the exit clears the entry, metres. */
export const LOOP_SHIFT = CELL
/** How far off the road (grass) you can wander on ground-level pieces before you are simply lost. */
export const GRASS_LIMIT = 60

// --- car (defaults; CarSpec overrides) ---
export let GRAVITY = 9.81
/** Height of the car's reference point above the surface. */
export const CAR_RIDE = 0.35
/** Pillars under elevated road, one pair every this many metres (sim collides with them, renderer draws them). */
export const PILLAR_SPACING = 12
export const PILLAR_SIDE = 3.2
/** Grass-mode collisions: how much of your speed you keep (reversed) after hitting a structure. */
export const BUMP_BOUNCE = 0.25
export const CAR_HALF_LENGTH = 2.2
export const CAR_HALF_WIDTH = 0.95
/** Heading offset from the path tangent (rad) beyond which a ground-level lane hands the car to the grass (elevated lanes clamp here). */
export let HEADING_MAX = 1.1
/** Speed below which steering authority is at its maximum (m/s). */
export let STEER_FULL_SPEED = 12
/** Steering authority multiplier at top speed. */
export let STEER_HIGH_SPEED_FACTOR = 0.35
/** Airborne, throttle down: engine revs climb this much of the band per second (Stunts-style runaway revs). */
export let AIR_REV_RATE = 1.6
/** Steering rate at full lock, rad/s of heading change at low speed. */
export let STEER_RATE = 2.4
/** Lateral velocity the tyres can correct per second per m/s of mismatch. */
export let TYRE_STIFFNESS = 6
/** How fast a sideways slide bleeds off (1/s): handbrake, and gravity on a bank or corkscrew. */
export let SLIDE_DECAY = 2
/** Share of banking gravity the tyres hold on their own; the rest slides the car and you steer against it (Stunts). */
export let BANK_HOLD = 0.3
/** Lateral grip: max lateral acceleration the tyres provide, m/s². */
export let GRIP_LATERAL = 22
/** Rolling drag and aero drag. */
export let DRAG_ROLLING = 0.5
export let DRAG_AERO = 0.0006
/** Extra deceleration on grass and the grip left there. */
export let GRASS_DRAG = 0.4
export let GRASS_GRIP_SCALE = 0.35
/** Grass: how much throttle / brake force the tyres can put down, and how much steering bite you keep. */
export let GRASS_TRACTION = 0.75
export let GRASS_STEER = 0.6
/** Speed lost per second while scraping a curb/wall. */
export let CURB_SLOW = 4

// --- air / crash ---
/**
 * The happy glitch (a homage to a 1990 stunt-driving sim): leave the ground at
 * or above this fraction of top speed with the throttle held, and while
 * airborne the car accelerates straight back to top speed — even after a
 * corner scrubbed it off. Let go of the accelerator and it stops.
 */
export let AIR_GLITCH_THRESHOLD = 0.6
export let AIR_GLITCH_ACCEL = 400
export let LAND_TOLERANCE = 1.2
/** Land only if the car's up and the surface normal roughly agree. */
export let LAND_MIN_ALIGN = 0.35
/** Impact speed into a surface (m/s) that wrecks the car. */
export let CRASH_IMPACT_SPEED = 30
/** Below this world height you are gone. */
export const FALL_LIMIT = -30
/** How many seconds of poses the crash replay keeps. */
export const REPLAY_SECONDS = 6
/** Seconds the crash replay plays before respawn. */
export let REPLAY_PLAY_SECONDS = 4.5

// --- run rules ---
/** Seconds added to a lap for every required track segment you skipped. */
export let SEGMENT_PENALTY = 5
export const CRASH_TIME_PENALTY = 5

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
export const SIM_TUNE: TuneSection = {
  title: 'Sim · handling, grip, crashes',
  keys: [
    tune('GRAVITY', () => GRAVITY, (v) => (GRAVITY = v)),
    tune('HEADING_MAX', () => HEADING_MAX, (v) => (HEADING_MAX = v)),
    tune('STEER_FULL_SPEED', () => STEER_FULL_SPEED, (v) => (STEER_FULL_SPEED = v)),
    tune('STEER_HIGH_SPEED_FACTOR', () => STEER_HIGH_SPEED_FACTOR, (v) => (STEER_HIGH_SPEED_FACTOR = v)),
    tune('STEER_RATE', () => STEER_RATE, (v) => (STEER_RATE = v)),
    tune('TYRE_STIFFNESS', () => TYRE_STIFFNESS, (v) => (TYRE_STIFFNESS = v)),
    tune('SLIDE_DECAY', () => SLIDE_DECAY, (v) => (SLIDE_DECAY = v)),
    tune('BANK_HOLD', () => BANK_HOLD, (v) => (BANK_HOLD = v), [0, 1], 0.05, 'gravity the tyres hold on banks; the rest you steer against'),
    tune('GRIP_LATERAL', () => GRIP_LATERAL, (v) => (GRIP_LATERAL = v)),
    tune('DRAG_ROLLING', () => DRAG_ROLLING, (v) => (DRAG_ROLLING = v)),
    tune('DRAG_AERO', () => DRAG_AERO, (v) => (DRAG_AERO = v)),
    tune('GRASS_DRAG', () => GRASS_DRAG, (v) => (GRASS_DRAG = v)),
    tune('GRASS_GRIP_SCALE', () => GRASS_GRIP_SCALE, (v) => (GRASS_GRIP_SCALE = v)),
    tune('GRASS_TRACTION', () => GRASS_TRACTION, (v) => (GRASS_TRACTION = v)),
    tune('GRASS_STEER', () => GRASS_STEER, (v) => (GRASS_STEER = v)),
    tune('CURB_SLOW', () => CURB_SLOW, (v) => (CURB_SLOW = v)),
    tune('LAND_TOLERANCE', () => LAND_TOLERANCE, (v) => (LAND_TOLERANCE = v)),
    tune('LAND_MIN_ALIGN', () => LAND_MIN_ALIGN, (v) => (LAND_MIN_ALIGN = v)),
    tune('CRASH_IMPACT_SPEED', () => CRASH_IMPACT_SPEED, (v) => (CRASH_IMPACT_SPEED = v)),
    tune('REPLAY_PLAY_SECONDS', () => REPLAY_PLAY_SECONDS, (v) => (REPLAY_PLAY_SECONDS = v)),
    tune('SEGMENT_PENALTY', () => SEGMENT_PENALTY, (v) => (SEGMENT_PENALTY = v)),
    tune('AIR_GLITCH_THRESHOLD', () => AIR_GLITCH_THRESHOLD, (v) => (AIR_GLITCH_THRESHOLD = v)),
    tune('AIR_GLITCH_ACCEL', () => AIR_GLITCH_ACCEL, (v) => (AIR_GLITCH_ACCEL = v)),
    tune('AIR_REV_RATE', () => AIR_REV_RATE, (v) => (AIR_REV_RATE = v)),
  ],
}
