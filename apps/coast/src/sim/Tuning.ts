// Pseudo-3D racer constants. Metres, seconds, radians; x across the road is
// normalised so ±1 is the road edge.

import { tune, type TuneSection } from '@apex/engine/app/TunePanel'
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
export let BAND_SEGMENTS = 2
/** Metres of gentle swell layered over every stage's hills. */
export const ROLL_AMPLITUDE = 3.2

// --- player ---
export let MAX_SPEED_HI = 96
export let MAX_SPEED_LO = 62
export let ACCEL_HI = 12
export let ACCEL_LO = 21
export let BRAKE_DECEL = 34
export let COAST_DECEL = 5
export let OFFROAD_MAX_SPEED = 26
export let OFFROAD_DECEL = 40
/** Steering: road widths per second at max speed, full lock. */
export let STEER_RATE = 1.9
/** Centrifugal push per unit curve per (speed/max)², road widths per second. */
export let CENTRIFUGAL = 0.36
export const CAR_HALF_WIDTH_ROAD = 0.11 // in road widths (~1.9 m)
/** Turbo: extra acceleration, extra top speed, duration, recharge. */
export let TURBO_ACCEL = 28
export let TURBO_TOP = 14
export let TURBO_TIME = 2.2
export let TURBO_RECHARGE = 14
/** Crash tumble duration and the speed you keep after a car bump. */
export let CRASH_TIME = 1.8
export let BUMP_KEEP = 0.85
/** Speed above which hitting a roadside object is a tumble instead of a scrape. */
export let CRASH_MIN_SPEED = 20

// --- traffic ---
export const TRAFFIC_COUNT = 14
/** Extra pool of cars that cross the road at intersections (themes with `crossings`). */
export const CROSSER_COUNT = 4
export const TRAFFIC_TOTAL = TRAFFIC_COUNT + CROSSER_COUNT
/** Head-on or side impacts faster than this (closing speed, m/s) are a wreck: a long roll instead of a bump. */
export let WRECK_SPEED = 26
/** Rear-ending same-direction traffic faster than this closing speed is a crash rather than a bump. */
export let REAREND_CRASH_SPEED = 30
/** Seconds lost rolling after a wreck (Rad Mobile took about five). */
export let WRECK_TIME = 3.6
/** Segments between intersections on `crossings` themes, and how fast crossing cars go (road widths / s). */
export const CROSSING_EVERY = 140
export let CROSSER_SPEED = 0.55
/** Banked turns: fraction of the centrifugal push the banking cancels at bank = 1. */
export let BANK_ASSIST = 0.55
export let TRAFFIC_MIN_SPEED = 22
export let TRAFFIC_MAX_SPEED = 48
export const TRAFFIC_SPAWN_AHEAD = 300 // segments
export const TRAFFIC_SPAWN_MIN = 90 // segments
export const TRAFFIC_DESPAWN_BEHIND = 40

// --- run ---
export let TIME_START = 75
export let TIME_CHECKPOINT = 62
export const SCORE_PER_METRE = 2
export const SCORE_PER_PASS = 120
export const SCORE_TIME_BONUS = 400

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
export const SIM_TUNE: TuneSection = {
  title: 'Sim · speed, handling, clock',
  keys: [
    tune('MAX_SPEED_HI', () => MAX_SPEED_HI, (v) => (MAX_SPEED_HI = v)),
    tune('MAX_SPEED_LO', () => MAX_SPEED_LO, (v) => (MAX_SPEED_LO = v)),
    tune('ACCEL_HI', () => ACCEL_HI, (v) => (ACCEL_HI = v)),
    tune('ACCEL_LO', () => ACCEL_LO, (v) => (ACCEL_LO = v)),
    tune('BRAKE_DECEL', () => BRAKE_DECEL, (v) => (BRAKE_DECEL = v)),
    tune('COAST_DECEL', () => COAST_DECEL, (v) => (COAST_DECEL = v)),
    tune('OFFROAD_MAX_SPEED', () => OFFROAD_MAX_SPEED, (v) => (OFFROAD_MAX_SPEED = v)),
    tune('OFFROAD_DECEL', () => OFFROAD_DECEL, (v) => (OFFROAD_DECEL = v)),
    tune('STEER_RATE', () => STEER_RATE, (v) => (STEER_RATE = v)),
    tune('CENTRIFUGAL', () => CENTRIFUGAL, (v) => (CENTRIFUGAL = v)),
    tune('TURBO_ACCEL', () => TURBO_ACCEL, (v) => (TURBO_ACCEL = v)),
    tune('TURBO_TOP', () => TURBO_TOP, (v) => (TURBO_TOP = v)),
    tune('TURBO_TIME', () => TURBO_TIME, (v) => (TURBO_TIME = v)),
    tune('TURBO_RECHARGE', () => TURBO_RECHARGE, (v) => (TURBO_RECHARGE = v)),
    tune('CRASH_TIME', () => CRASH_TIME, (v) => (CRASH_TIME = v)),
    tune('BUMP_KEEP', () => BUMP_KEEP, (v) => (BUMP_KEEP = v)),
    tune('CRASH_MIN_SPEED', () => CRASH_MIN_SPEED, (v) => (CRASH_MIN_SPEED = v)),
    tune('WRECK_SPEED', () => WRECK_SPEED, (v) => (WRECK_SPEED = v)),
    tune('REAREND_CRASH_SPEED', () => REAREND_CRASH_SPEED, (v) => (REAREND_CRASH_SPEED = v)),
    tune('WRECK_TIME', () => WRECK_TIME, (v) => (WRECK_TIME = v)),
    tune('CROSSER_SPEED', () => CROSSER_SPEED, (v) => (CROSSER_SPEED = v)),
    tune('BANK_ASSIST', () => BANK_ASSIST, (v) => (BANK_ASSIST = v)),
    tune('TIME_START', () => TIME_START, (v) => (TIME_START = v)),
    tune('TIME_CHECKPOINT', () => TIME_CHECKPOINT, (v) => (TIME_CHECKPOINT = v)),
    tune('BAND_SEGMENTS', () => BAND_SEGMENTS, (v) => (BAND_SEGMENTS = v)),
    tune('TRAFFIC_MIN_SPEED', () => TRAFFIC_MIN_SPEED, (v) => (TRAFFIC_MIN_SPEED = v)),
    tune('TRAFFIC_MAX_SPEED', () => TRAFFIC_MAX_SPEED, (v) => (TRAFFIC_MAX_SPEED = v)),
  ],
}
