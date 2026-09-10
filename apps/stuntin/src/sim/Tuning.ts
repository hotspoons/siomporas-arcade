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
/**
 * The rocket jump — Stunts' "jump bug 3", where gravity went insane and threw the car so high that
 * buildings looked like holes in the ground. In the original it fired unpredictably when a car at the
 * top of its rev range crossed a seam between differently-sloped pieces (a ramp, a loop, a corkscrew),
 * out of the same slope-and-transition handling that gives power gear its speed. Ours needs the same
 * three things: near top speed (or speedlocked), a seam where the surface tilts by at least
 * ROCKET_SLOPE, and luck — ROCKET_CHANCE of those crossings. Then the car leaves at ROCKET_SPEED
 * upward and, like the original, can fall a very long way without wrecking.
 */
export let ROCKET_CHANCE = 0.2
export let ROCKET_SPEED = 75
export let ROCKET_MIN_SPEED = 0.94
export let ROCKET_SLOPE = 0.01
export let LAND_TOLERANCE = 1.2
/** Land only if the car's up and the surface normal roughly agree. */
export let LAND_MIN_ALIGN = 0.35
/** Impact speed into a surface (m/s) that wrecks the car. */
export let CRASH_IMPACT_SPEED = 30
/**
 * A step up onto a road that the car simply drives up rather than hits. Ground is graded to meet the
 * roads, but a join is never exact — a banked deck's edge, a ramp's lip, the last few centimetres of
 * a slope — and treating those centimetres as a wall is what turns a smooth transition into a place
 * you get stuck against nothing.
 */
export let CLIMB_STEP = 0.7
/**
 * How steeply the wheels may ride up onto something, as metres of rise per metre travelled. It is
 * only here to stop a kerb sweeping under the car from popping it upwards in a single frame — so it
 * has to be generous enough never to lag behind a slope the car is actually driving up. Lag and the
 * car ends up under the deck it is climbing, which the structure test rightly calls a wall.
 */
export let CLIMB_SLOPE = 1.5
/**
 * What a bank is worth, per unit of its own steepness — grip goes up with the tangent of the angle
 * the surface stands at.
 *
 * Taking the real thing at face value does not work here. A car in this game holds better than two g
 * on the flat, and at that much grip the physics says a fifty-four degree bowl carries any speed at
 * all: the friction cone covers the corner and the answer comes out infinite. So this is fitted to
 * where the corner should run out rather than derived — at 0.15 the big bowl's deck gives up
 * around two hundred and the top of its wall holds three hundred, which is the shape of the thing:
 * to go faster, climb.
 */
export let BANK_GRIP = 0.17
/** A ceiling on it, so the top of a near-vertical wall is not flypaper. */
export let LOAD_MAX = 4
/** Above this much clearance overhead, a flat deck is something to drive under rather than into. */
export let DECK_CLEARANCE = 1.4
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
/** Seconds added for skipping a crash replay with the reset key (you restart from before the incident). */
export let RESET_PENALTY = 5
/** Metres the manual recover backs you up, each press: enough to get out from under a building. */
export let RECOVER_BACK = 9
/** Metres further along the road you resume for each consecutive crash on the same spot (~50 ft). */
export let RESUME_ADVANCE = 15

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
    tune('BANK_GRIP', () => BANK_GRIP, (v) => (BANK_GRIP = v), [0, 1.5], 0.05, 'how much of a bank\u2019s load becomes grip'),
    tune('LOAD_MAX', () => LOAD_MAX, (v) => (LOAD_MAX = v), [1, 12], 0.5, 'most a bank may multiply grip by'),
    tune('CLIMB_SLOPE', () => CLIMB_SLOPE, (v) => (CLIMB_SLOPE = v), [0.25, 6], 0.25, 'how steeply the wheels may ride up onto a kerb'),
    tune('CLIMB_STEP', () => CLIMB_STEP, (v) => (CLIMB_STEP = v), [0, 2], 0.05, 'step up onto a road the car drives up instead of hitting'),
    tune('DECK_CLEARANCE', () => DECK_CLEARANCE, (v) => (DECK_CLEARANCE = v), [0.5, 4], 0.1, 'headroom above which a deck is something to drive under'),
    tune('REPLAY_PLAY_SECONDS', () => REPLAY_PLAY_SECONDS, (v) => (REPLAY_PLAY_SECONDS = v)),
    tune('SEGMENT_PENALTY', () => SEGMENT_PENALTY, (v) => (SEGMENT_PENALTY = v)),
    tune('RESET_PENALTY', () => RESET_PENALTY, (v) => (RESET_PENALTY = v), [0, 20], 1),
    tune('RECOVER_BACK', () => RECOVER_BACK, (v) => (RECOVER_BACK = v), [0, 40], 1, 'metres the recover key backs you up'),
    tune('AIR_GLITCH_THRESHOLD', () => AIR_GLITCH_THRESHOLD, (v) => (AIR_GLITCH_THRESHOLD = v)),
    tune('AIR_GLITCH_ACCEL', () => AIR_GLITCH_ACCEL, (v) => (AIR_GLITCH_ACCEL = v)),
    tune('ROCKET_CHANCE', () => ROCKET_CHANCE, (v) => (ROCKET_CHANCE = v), [0, 1], 0.05, 'share of qualifying seams that fire'),
    tune('ROCKET_SPEED', () => ROCKET_SPEED, (v) => (ROCKET_SPEED = v), [20, 400], 10, 'launch speed straight up, m/s'),
    tune('ROCKET_MIN_SPEED', () => ROCKET_MIN_SPEED, (v) => (ROCKET_MIN_SPEED = v), [0.5, 1], 0.02, 'share of top speed needed'),
    tune('ROCKET_SLOPE', () => ROCKET_SLOPE, (v) => (ROCKET_SLOPE = v), [0, 0.3], 0.01, 'surface tilt across the seam needed'),
    tune('AIR_REV_RATE', () => AIR_REV_RATE, (v) => (AIR_REV_RATE = v)),
  ],
}
