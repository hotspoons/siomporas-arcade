// Every gameplay tuning constant, in one place. World units are metres,
// angles are radians unless the name says DEG, time is seconds. These are the
// spec's starting values; anything changed by feel is logged in MILESTONE.md.

import { tune, type TuneSection } from '@apex/engine/app/TunePanel'
import { DEG } from '@apex/engine/math/scalar'

// --- loop -------------------------------------------------------------------
/** Fixed simulation rate. Never changes with visual mode. */
export const SIM_HZ = 120
export const SIM_DT = 1 / SIM_HZ
/** Clamp on catch-up ticks per frame so a restored tab can't death-spiral. */
export const MAX_SUBSTEPS = 8

// --- speed ------------------------------------------------------------------
/** m/s (~537 mph). The floor: you are never slow. */
export let SPEED_MIN = 240
/** m/s (~700 mph). Where speed settles with no throttle or brake. */
export let SPEED_CRUISE = 313
/** m/s (~1000 mph). Full throttle ceiling. */
export let SPEED_MAX = 447
/** m/s. Only reachable on boost strips. */
export let SPEED_BOOST_MAX = 500
export let ACCEL = 40
export let BRAKE_DECEL = 90
/** m/s² pull toward cruise when neither throttle nor brake is held. */
export let DRAG_TO_CRUISE = 25
/** m/s² while riding a boost strip. Strips should feel like a slingshot. */
export let BOOST_ACCEL = 140
/** m/s² decay from boost speed back toward SPEED_MAX after leaving a strip. */
export const BOOST_DECAY = 30

// --- steering (theta = angle around the tube) --------------------------------
/** rad/s² of theta acceleration at SPEED_CRUISE in a default-radius tube. */
export let THETA_ACCEL = 9.0
export let THETA_DAMP = 6.0
/** Steering authority multiplier at SPEED_MAX. Never 0: still nimble. */
export let THETA_SPEED_FALLOFF = 0.55
/** Hard cap on angular rate so a wide tube can't be lapped in a blink. */
export let THETA_VEL_MAX = 3.4
/** rad of craft roll into a turn, for the chase view. */
export let BANK_VISUAL_MAX = 0.6
/** How fast the visual bank follows theta velocity. */
export const BANK_RATE = 8

// --- track ------------------------------------------------------------------
export const TUNNEL_RADIUS_DEFAULT = 14
export const VEHICLE_HALF_WIDTH = 1.6
export const VEHICLE_HALF_LENGTH = 3.2
/** Height of the craft's belly above the wall it rides. */
export const VEHICLE_HOVER = 0.9
/** Arc-length table resolution of the baked spline. */
export const TRACK_SAMPLE_STEP = 2
/** Half-angle of geometry present for the open-topped profiles. */
export const ARC_HALFPIPE = 120 * DEG
export const ARC_OPEN = 42 * DEG
export const ARC_TUBE = Math.PI
/** Metres over which radius and profile changes blend at a segment start. */
export const PROFILE_BLEND_LENGTH = 80
/** Window (metres) of the moving average that smooths authored roll. */
export const ROLL_SMOOTH_LENGTH = 140
/** Extra clearance between the craft and an open profile's edge. */
export const EDGE_MARGIN = 0.4
/** Wall-slide softness at a clamped edge: theta velocity kept on contact. */
export const EDGE_BOUNCE = -0.25

// --- air ---------------------------------------------------------------------
/** m/s². Heavier than real gravity for an arcade arc. World -Y. */
export const G_AIR = 22
/**
 * Air control is deliberately limited and expressed as accelerations, not as
 * rotation of the velocity: at 400 m/s even a few degrees of nose-up turns a
 * jump into a two-kilometre flight. Pitch input adds/removes m/s² of lift,
 * steer input strafes.
 */
export const AIR_LIFT_AUTHORITY = 0.3
export const AIR_STRAFE_AUTHORITY = 30
/**
 * Air gravity scales with (speed / GAP_DESIGN_SPEED)² so the flight traces the
 * authored arc at any speed — speed changes how fast you cross a gap, never
 * whether you make it. Clamped so a near-stalled or boosted craft stays sane.
 */
export const AIR_G_SCALE_MIN = 0.6
export const AIR_G_SCALE_MAX = 5
/** Lateral (sideways) speed allowed at launch; a spin must not fling you off the line. */
export const LAUNCH_LATERAL_MAX = 6
/** Soft spring pulling an un-steered flight back over the centreline (1/s², 1/s). */
export const AIR_CENTERING_K = 2.5
export const AIR_CENTERING_C = 3.0
/** How far (metres) inside the tube surface counts as touching down. */
export const LAND_TOLERANCE = 3.0
/** Metres below/through the surface that still count as clipping the lip (harsh landing). */
export const LAND_UNDERSHOOT = 9.0
export const LAND_ALIGN_TIME = 0.15
/** Speed kept on landing, at worst angle. */
export const LAND_SPEED_KEEP_MIN = 0.7
/** Depth below/outside the tube after which a fall is a crash. */
export const FALL_DEPTH = 45
/**
 * Ballistic speed the builder assumes when shaping a GAP's centreline. Kept
 * just under SPEED_MIN so the slowest craft still makes the far side; faster
 * craft fly higher and land further down the (long, levelling) receiver.
 */
export const GAP_DESIGN_SPEED = 235
/** Metres searched each side of the last known s when re-acquiring the track. */
export const REACQUIRE_RANGE = 150
/** Metres of straight run-up over which a fall off an OPEN edge is forgiven. */
export const FALL_GRACE = 0.35

// --- combat -------------------------------------------------------------------
export let LASER_DPS = 100
export let LASER_RANGE = 900
/** rad (~8°) auto-aim cone about the vehicle's forward. */
export let LASER_AIM_CONE = 0.14
export let LASER_HEAT_PER_SEC = 55
export const LASER_HEAT_MAX = 100
export let LASER_COOL_PER_SEC = 40
export const LASER_OVERHEAT_LOCK = 1.2
export const SHOCKWAVE_MAX_CHARGES = 3
export const SHOCKWAVE_START_CHARGES = 3
export let SHOCKWAVE_RADIUS = 700
export const SHOCKWAVE_INVULN = 1.0
/** Kills in a row (within KILL_STREAK_WINDOW s) that earn a shockwave charge. */
export const KILL_STREAK_FOR_CHARGE = 8
export const KILL_STREAK_WINDOW = 2.5

// --- survivability -------------------------------------------------------------
export const SHIELD_MAX = 100
export let SHIELD_REGEN_PER_SEC = 2.5
export let SHIELD_GATE_RESTORE = 60
export const SHIELD_POD_RESTORE = 35
/** m/s lost per second of wall contact in HALFPIPE/OPEN. */
export let SCRAPE_SPEED_LOSS = 35
export const SCRAPE_SHIELD_PER_SEC = 6
export let COLLISION_SHIELD_COST = 25
export const ENEMY_SHOT_SHIELD_COST = 12
/** Speed multiplier applied on a traffic collision. Never stops progress. */
export let COLLISION_SPEED_KEEP = 0.72
/** Seconds of the post-collision barrel spin (visual + steering impulse). */
export const COLLISION_SPIN_TIME = 0.7
export const COLLISION_INVULN = 0.8
/** Shield empty + another hit: a spin-out, not a wreck. Speed kept and seconds of lost control. */
export let SPINOUT_SPEED_KEEP = 0.45
export let SPINOUT_TIME = 1.4
/** Seconds docked when you leave the track entirely and get dropped back on it. */
export const OFFTRACK_TIME_PENALTY = 2

// --- timer / score --------------------------------------------------------------
/**
 * Spec started at 60 / +20, but at 313 m/s a 1 km gate spacing is ~3 s, so the
 * clock never threatened. 20 / +8 keeps a clean run comfortable and makes
 * collisions, scrapes and braking actually cost you.
 */
export let TIMER_START = 20
export let TIMER_GATE_BONUS = 8
export const SCORE_PER_KILL: Record<string, number> = {
  DRONE: 100,
  BLOCKER: 150,
  MINE: 120,
  INTERCEPTOR: 300,
  ARMORED: 500,
  GATE_BOSS: 2000,
  HAULER: 250,
  SWARM: 60,
  TURRET: 200,
}
/** Transit train: cars and car length (metres) — one agent, many collision bodies. */
export const TRAIN_CARS = 6
export const TRAIN_CAR_LENGTH = 9
/** Spinner bar half-arc around the tube, radians. */
export const SPINNER_HALF_ARC = 0.5
export const SPINNER_RATE = 0.9
/** Shockwave shoves indestructible light-cycles this far ahead instead of killing them. */
export const SHOCK_BIKE_SHOVE = 260
export const SCORE_RING = 250
export const SCORE_BOOST_PER_SEC = 80
export const SCORE_TIME_LEFT_PER_SEC = 50
/** Multiplier step per consecutive kill within the streak window. */
export const COMBO_STEP = 0.25
export const COMBO_MAX = 4

// --- traffic -----------------------------------------------------------------------
/** Spawns happen this far ahead; must exceed the render draw distance. */
export const SPAWN_LEAD = 2000
export const DESPAWN_BEHIND = 60
/** The course is divided into cells; each cell rolls one spawn decision. */
export const SPAWN_CELL = 45
export const MAX_TRAFFIC = 96
export const MAX_PROJECTILES = 48
/** Metres past which a hostile is out of the fight and recycled. */
export const TRAFFIC_MAX_RANGE = SPAWN_LEAD + 200

// --- world -----------------------------------------------------------------------------
export const FLOATING_ORIGIN_REBASE = 20000

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
export const SIM_TUNE: TuneSection = {
  title: 'Sim · speed, steering, combat, clock',
  keys: [
    tune('SPEED_MIN', () => SPEED_MIN, (v) => (SPEED_MIN = v)),
    tune('SPEED_CRUISE', () => SPEED_CRUISE, (v) => (SPEED_CRUISE = v)),
    tune('SPEED_MAX', () => SPEED_MAX, (v) => (SPEED_MAX = v)),
    tune('SPEED_BOOST_MAX', () => SPEED_BOOST_MAX, (v) => (SPEED_BOOST_MAX = v)),
    tune('ACCEL', () => ACCEL, (v) => (ACCEL = v)),
    tune('BRAKE_DECEL', () => BRAKE_DECEL, (v) => (BRAKE_DECEL = v)),
    tune('DRAG_TO_CRUISE', () => DRAG_TO_CRUISE, (v) => (DRAG_TO_CRUISE = v)),
    tune('BOOST_ACCEL', () => BOOST_ACCEL, (v) => (BOOST_ACCEL = v)),
    tune('THETA_ACCEL', () => THETA_ACCEL, (v) => (THETA_ACCEL = v)),
    tune('THETA_DAMP', () => THETA_DAMP, (v) => (THETA_DAMP = v)),
    tune('THETA_SPEED_FALLOFF', () => THETA_SPEED_FALLOFF, (v) => (THETA_SPEED_FALLOFF = v)),
    tune('THETA_VEL_MAX', () => THETA_VEL_MAX, (v) => (THETA_VEL_MAX = v)),
    tune('BANK_VISUAL_MAX', () => BANK_VISUAL_MAX, (v) => (BANK_VISUAL_MAX = v)),
    tune('LASER_DPS', () => LASER_DPS, (v) => (LASER_DPS = v)),
    tune('LASER_RANGE', () => LASER_RANGE, (v) => (LASER_RANGE = v)),
    tune('LASER_AIM_CONE', () => LASER_AIM_CONE, (v) => (LASER_AIM_CONE = v)),
    tune('LASER_HEAT_PER_SEC', () => LASER_HEAT_PER_SEC, (v) => (LASER_HEAT_PER_SEC = v)),
    tune('LASER_COOL_PER_SEC', () => LASER_COOL_PER_SEC, (v) => (LASER_COOL_PER_SEC = v)),
    tune('SHOCKWAVE_RADIUS', () => SHOCKWAVE_RADIUS, (v) => (SHOCKWAVE_RADIUS = v)),
    tune('SHIELD_REGEN_PER_SEC', () => SHIELD_REGEN_PER_SEC, (v) => (SHIELD_REGEN_PER_SEC = v)),
    tune('SHIELD_GATE_RESTORE', () => SHIELD_GATE_RESTORE, (v) => (SHIELD_GATE_RESTORE = v)),
    tune('COLLISION_SHIELD_COST', () => COLLISION_SHIELD_COST, (v) => (COLLISION_SHIELD_COST = v)),
    tune('COLLISION_SPEED_KEEP', () => COLLISION_SPEED_KEEP, (v) => (COLLISION_SPEED_KEEP = v)),
    tune('SPINOUT_SPEED_KEEP', () => SPINOUT_SPEED_KEEP, (v) => (SPINOUT_SPEED_KEEP = v)),
    tune('SPINOUT_TIME', () => SPINOUT_TIME, (v) => (SPINOUT_TIME = v)),
    tune('TIMER_START', () => TIMER_START, (v) => (TIMER_START = v)),
    tune('TIMER_GATE_BONUS', () => TIMER_GATE_BONUS, (v) => (TIMER_GATE_BONUS = v)),
    tune('SCRAPE_SPEED_LOSS', () => SCRAPE_SPEED_LOSS, (v) => (SCRAPE_SPEED_LOSS = v)),
  ],
}
