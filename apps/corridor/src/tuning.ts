// Every live-tunable knob in the viewer, in one place, with the F6 panel's sections.
//
// Same contract as the other games (see apps/stuntin/src/sim/Tuning.ts and the engine's
// TunePanel): `export let` defaults here, sliders change them live, values persist per browser,
// Copy JSON hands the numbers back to whoever edits this file. Rich drives, pastes JSON, I edit
// the defaults — never type numbers from a screenshot.
//
// Tabs are the top-level groups below; each tab's sections are the panel's sub-groups.
import { tune, type TuneSection } from '@apex/engine/app/TunePanel'

// --- grass ------------------------------------------------------------------------------------
/** blades per square metre in the mown strip beside the shoulder, and in the rough beyond */
export let GRASS_MOWN_PER_M2 = 120
export let GRASS_ROUGH_PER_M2 = 59
/** the ring around the eye that carries blades at all (m), and the LOD rings inside it */
export let GRASS_RADIUS = 106
export let GRASS_LOD_NEAR = 12
export let GRASS_LOD_MID = 39
export let GRASS_LOD_MID_DENSITY = 0.55
export let GRASS_LOD_FAR_DENSITY = 0.45
/** blade size multipliers over the season palette */
export let GRASS_HEIGHT_SCALE = 1.5
export let GRASS_WIDTH_SCALE = 0.55
/** how far from the pavement edge the mow line runs, and where grass stops entirely */
export let GRASS_MOW_LINE = 13
export let GRASS_MAX_FROM_ROAD = 24
/** blade heights (m): mown turf, and the rough before the season multiplier */
export let GRASS_MOWN_HEIGHT = 0.22
export let GRASS_ROUGH_HEIGHT = 1.8
/** how far a blade's tip leans from its root (fraction of height), and how hard the wind blows */
export let GRASS_LEAN = 0.45
export let GRASS_WIND = 1.0
/** bare patches: the share of patch cells left bare, and the patch size (m) */
export let GRASS_PATCHINESS = 0.12
export let GRASS_PATCH_SIZE = 6
/** how far blades scatter around their clump centre (m), and the steepest turf slope (m/m) */
export let GRASS_SCATTER = 0.7
export let GRASS_SLOPE_MAX = 0.7
/** sprite clumps: from the mid ring out to this radius (m), cards per m², size multiplier */
export let GRASS_SPRITE_RADIUS = 300
export let GRASS_SPRITE_PER_M2 = 0.8
export let GRASS_SPRITE_SCALE = 1.0
/** sprite look: card width multiplier, lean (shear of the top), and the density kept at the far rim */
export let GRASS_SPRITE_WIDTH = 1.2
export let GRASS_SPRITE_LEAN = 0.25
export let GRASS_SPRITE_FAR_DENSITY = 0.25
/** colour over the season palette: hue shift (deg), saturation, lightness, and extra straw/dryness
 *  (September verge grass is not April grass: default +0.3 dryness) */
export let GRASS_HUE = 0
export let GRASS_SAT = 0.9
export let GRASS_LIGHT = 1.0
export let GRASS_DRY_ADD = 0
/** blades stop swaying above this eye speed (m/s): nobody sees wind from a moving car */
export let GRASS_WIND_STILL_BELOW = 4
/**
 * Which grass grows here: -1 reads it off the bake (latitude, longitude and OSM land use, see
 * groundcover.ts), 0…3 forces common / wheat / bermuda / coastal.
 */
export let GRASS_TYPE = -1
/**
 * The season, as a number, because the engine's TunePanel takes numbers: -1 leaves the season
 * selector alone, 0…3 is winter / spring / summer / autumn. Driving with F6 open, this is how
 * Rich watches a verge go from September to bare in one drag.
 */
export let SEASON = -1
/** how many 8 m tiles may be generated per frame while the ring fills */
export let GRASS_TILES_PER_FRAME = 48
/** and no longer than this per frame generating them: the real budget, since tile cost varies 30× */
export let GRASS_MS_PER_FRAME = 4
/** evict cached tiles once the map holds this multiple of what the ring needs */
export let GRASS_CACHE_SLACK = 1.4

// --- trees --------------------------------------------------------------------------------------
/** near-field radius (procedural models) — beyond it, impostors */
export let TREE_NEAR_RADIUS = 240
/** the band just outside that radius over which the impostor card dissolves away, so a tree does
 *  not pop from card to model in one frame. 0 disables the fade (the old hard switch). */
export let TREE_FADE_M = 30
/** instanced models per variant in the near field (5 variants) */
export let TREE_NEAR_CAPACITY = 140
/** impostor cards lie flat above this view pitch (rad) */
export let IMPOSTOR_FLAT_PITCH = 0.62

// --- LOD shape ----------------------------------------------------------------------------------
/** how much farther a thing BEHIND the view counts than one ahead (0 = circle, 1 = behind counts double) */
export let LOD_BEHIND_PENALTY = 0.9
/** above this camera pitch (rad, 0 = level, 1.57 = straight down) the LOD footprint becomes a circle */
export let LOD_TOPDOWN_PITCH = 0.9

// --- road ---------------------------------------------------------------------------------------
export let LANE_WIDTH = 3.66
/** a street that dead-ends gets a turning bulb unless the bake or the editor says otherwise;
 *  radius to the pavement edge (9 m ≈ the 18 m bulb US subdivisions are built to). 0 = off. */
export let CULDESAC_RADIUS = 9
export let SHOULDER_OUT = 3.0
export let SHOULDER_IN = 1.2
/** m: width of the transition strip where the surface class changes. 0 = the old hard joint. */
export let ROAD_BLEND_M = 0.15
/** m: length a lane-count change is ramped over, so an auxiliary lane tapers instead of appearing
 *  sideways in one quad. 0 = the old step. */
export let ROAD_TAPER_M = 60
/** 0 = a one-way carriageway's TRAVEL LANES are centred on the spine (OSM draws the way down the
 *  lanes, so this is the truthful one); 1 = the asphalt is centred instead, as it was before. */
export let ROAD_ONEWAY_CENTRE = 0

// --- car (stuntin's Tuning.ts defaults and the Kestrel S9 spec; see apps/stuntin/src/sim) -------
// engine (CarSpec 'kestrel' + longitudinal)
export let CAR_TOP_SPEED = 82
export let CAR_ACCEL = 11
export let CAR_BRAKE = 24
/** reverse: share of accel the brake pedal gives you once stopped; handbrake: share of the brake force */
export let CAR_REVERSE_ACCEL = 0.6
export let CAR_HANDBRAKE_BRAKE = 0.6
export let CAR_DRAG_ROLLING = 0.5
export let CAR_DRAG_AERO = 0.0006
export let CAR_GRAVITY = 9.81
// handling (the track regime's lateral model: steering asks for a yaw rate, the tyres deliver what grip allows)
export let CAR_STEER_RATE = 2.4
/** speed below which steering authority is at its maximum (m/s), and the multiplier left at top speed */
export let CAR_STEER_FULL_SPEED = 12
export let CAR_STEER_HIGH_SPEED_FACTOR = 0.35
/** CarSpec multipliers: agility on steering authority, grip on CAR_GRIP_LATERAL */
export let CAR_AGILITY = 1
export let CAR_GRIP_MULT = 1
export let CAR_GRIP_LATERAL = 22
/** handbrake: grip left, how much of the refused yaw the rear lets through, and how much of it becomes outward slide */
export let CAR_HANDBRAKE_GRIP = 0.55
export let CAR_HANDBRAKE_ROTATE = 0.7
export let CAR_HANDBRAKE_SLIDE = 0.35
export let CAR_HANDBRAKE_MIN_SPEED = 3
export let CAR_SLIDE_DECAY = 2
/** cross-slope: share of the sideways gravity the tyres hold (the rest slides you downhill), and what a bank is worth in grip */
export let CAR_BANK_HOLD = 0.3
export let CAR_BANK_GRIP = 0.17
export let CAR_LOAD_MAX = 4
/** how fast the drawn front wheels follow the stick (1/s) */
export let CAR_STEER_VISUAL_RATE = 12
// surface (grass = off the pavement)
export let CAR_GRASS_DRAG = 0.4
export let CAR_GRASS_GRIP_SCALE = 0.7
export let CAR_GRASS_TRACTION = 0.85
export let CAR_GRASS_STEER = 0.9
/** metres past the paved edge before the tyres count as on grass (corridor: the edge is a hard line) */
export let CAR_GRASS_EDGE = 0.3
export let CAR_BUMP_BOUNCE = 0.25
// ride
export let CAR_RIDE = 0.35
export let CAR_CLIMB_SLOPE = 1.5
// jumps (Stunts homages; the mechanics are stuntin's, the switches default off here)
/** below this speed the car follows the ground down instead of leaving it (m/s) */
export let CAR_LAUNCH_MIN_SPEED = 20
/** the ground must fall this far away from under the wheels (m) before the car is airborne (corridor: hysteresis over stuntin's one-tick test, which a faceted lidar strip would trip every station) */
export let CAR_LAUNCH_GAP = 0.9
/** m/s: the most vertical speed a crest can impart. A suspension cannot throw a car harder than
 *  this however steep the height data pretends to be; 8 m/s is a 3.3 m jump. */
export let CAR_LAUNCH_MAX_RISE = 8
/** Arcade: how much more willingly a crest throws the car than physics says. 1 = measured reality;
 *  above 1 the car holds its line over a brow longer than gravity allows. Rich dials it. */
export let CAR_CREST_GAIN = 1
/** vertical impact speed that wrecks the car (m/s) */
export let CAR_CRASH_IMPACT_SPEED = 30
/** how fast the nose follows the arc in the air, and the roll settles (1/s) */
export let CAR_AIR_NOSE_RATE = 2.5
export let CAR_AIR_ROLL_SETTLE = 1.2
/** speedlock (the vmax glitch): 1 = on; leave the ground above this share of top speed with the throttle down and you are pinned back to top speed */
export let CAR_AIR_GLITCH = 0
export let CAR_AIR_GLITCH_THRESHOLD = 0.6
export let CAR_AIR_GLITCH_ACCEL = 400
/** rocket jumps (jump bug 3): 1 = on; a launch near top speed fires straight up with this chance */
export let CAR_ROCKETS = 0
export let CAR_ROCKET_CHANCE = 0.2
export let CAR_ROCKET_SPEED = 75
export let CAR_ROCKET_MIN_SPEED = 0.94

// --- terrain features (terrain-and-data agent): rock on cut faces, water --------------------------
/** boulders per metre of cut face (scaled by face height and steepness), and per m² of outcrop */
export let ROCK_PER_M = 0.6
export let ROCK_OUTCROP_PER_M2 = 0.04
/** boulder size multiplier (m at scale 1), and how far off any pavement edge a rock must stay (m) */
export let ROCK_SIZE = 1.1
export let ROCK_PAVEMENT_CLEAR = 1.5
/** density multiplier where the geology says the face is sand or gravel rather than rock.
 *  DEFAULT 0, decided by looking: on Chesterfield Road's sand cut the boulders read as debris
 *  scattered on a lawn, and with the layer off the same bank reads correctly as the grassy
 *  coastal-plain cut it is. The day-one design note said the same thing before I guessed
 *  otherwise — "coastal-plain sands and gravels: no rock cuts; sand faces, riprap only". Raise it
 *  if a sand face should carry riprap; the rock kit has no sand set, so these are the procedural
 *  shapes and they read as boulders whatever colour they are. */
export let ROCK_SAND_DENSITY = 0
/** water surface above the channel bottom (m), ribbon width multiplier, ripple speed, opacity */
export let WATER_DEPTH = 0.25
export let WATER_WIDTH_SCALE = 1.0
export let WATER_SPEED = 1.0
export let WATER_OPACITY = 0.82
/**
 * The still-water line, metres NAVD88 — the sea at 0, and the flood control.
 *
 * One plane over the whole site at this height. Inland it sits under the terrain and nothing is
 * drawn; on a coast it IS the ocean; raised, it floods the valleys from the bottom up, which is
 * the mechanic Rich wants ported from trailworks. `WATER_LEVEL_SPAN` is how far it reaches
 * (m from the site centre) — 30 km by default so the ocean meets the horizon.
 */
export let WATER_LEVEL_M = 0
export let WATER_LEVEL_SPAN = 30000

// --- power lines ---------------------------------------------------------------------------
/** support heights as a multiple of OSM's (or the default for the kind) */
export let POWER_HEIGHT_SCALE = 1.0
/** conductor sag as a fraction of the span, and a cap in metres — the sag is what reads as a wire */
export let POWER_SAG = 0.035
export let POWER_SAG_MAX = 6

// --- camera -------------------------------------------------------------------------------------
/** the fly camera may not go below the ground under it by less than this (m) */
export let CAM_MIN_HEIGHT = 0.4
/** m: eye height for the "sit on the road" key (G). Below ~0.25 m the 0.5 m near plane starts
 *  clipping the surface out of the bottom of the frame. */
export let CAM_SIT_HEIGHT = 1.5
/** cockpit (C while driving): eye height above the car's origin, forward of it, and a little look-up */
export let COCKPIT_EYE_UP = 1.15
export let COCKPIT_EYE_FWD = 0.35
/** m: the driver's seat is left of centre in the US, so the eye is too (negative = left) */
export let COCKPIT_EYE_SIDE = -0.38
export let COCKPIT_LOOK_UP = 0.6
/** how much of the car's roll the cockpit view takes on: 0 = head stays level, 1 = bolted to the body */
export let COCKPIT_ROLL = 0.6
export let CHASE_BACK = 7.5
export let CHASE_UP = 2.6
export let CHASE_LOOK_AHEAD = 6
export let CHASE_LAG = 8

// --- street furniture ---------------------------------------------------------------------------
/** the mast pole's height (m); the arm hangs its heads a little under the top */
export let FURNITURE_SIGNAL_HEIGHT = 6.4
/** the mast arm's reach over the carriageway, × what the road's lane count asks for */
export let FURNITURE_SIGNAL_ARM_SCALE = 1
/**
 * 1 lights one lens. Left at 0 by default and deliberately: nothing in the bake or the viewer
 * knows what phase a junction is in, and a signal cycling to a timer that has no relationship to
 * the junction is worse than an unlit one, because it invites you to obey it.
 */
export let FURNITURE_SIGNAL_LIT = 0
/** a stop or give-way sign's post height (m) */
export let FURNITURE_SIGN_HEIGHT = 2.2
/** how far clear of the asphalt a post has to stand before it is left alone (m) */
export let FURNITURE_KERB_CLEAR = 0.6
/** and how far it may be walked sideways looking for that clearance (m) */
export let FURNITURE_KERB_MAX = 26
/**
 * Furniture further than this from a drawn carriageway edge is not placed (m). The bake reads the
 * whole OSM extract; the viewer draws a fraction of the roads in it, and a signal for a road that
 * is not there stands in a field with its arm over grass.
 */
export let FURNITURE_MAX_FROM_ROAD = 20
/** how far back along its own approach a post may be walked to get out of the junction box (m) */
export let FURNITURE_SETBACK_MAX = 16
/** past this reach it is not a mast arm any more, and the signal is not placed (m) */
export let FURNITURE_ARM_MAX = 14

/** a stall bay, in metres: the American standard is 8'6" × 18' */
export let PARKING_STALL_W = 2.6
export let PARKING_STALL_D = 5.4
/** the drive aisle between two facing rows, for lots with no aisle mapped (m) */
export let PARKING_AISLE_W = 6.5
/** the painted line's width (m), and how far the paint floats over the asphalt (m) */
export let PARKING_PAINT_W = 0.12
export let PARKING_PAINT_LIFT = 0.02
/** how far the asphalt floats over the ground (m) */
export let PARKING_LIFT = 0.04
/** a lot with more than this share of its interior over a carriageway is not paved, 0…1 */
export let PARKING_ROAD_OVERLAP = 0.35
/** below this area a lot with no aisle mapped gets no stalls at all (m²) */
export let PARKING_MIN_GRID_M2 = 400
/** extra clearance past the aisle's own edge before a bay starts (m) */
export let PARKING_AISLE_GAP = 0.3
/** a lot with fewer than one stall per this many m² gets the squared grid as well (m²) */
export let PARKING_FILL_M2 = 45
/** every barrier's height × this */
export let BARRIER_HEIGHT_SCALE = 1

export interface TuneTab {
  name: string
  sections: TuneSection[]
}

export const TUNE_TABS: TuneTab[] = [
  {
    name: 'grass',
    sections: [
      {
        title: 'density',
        keys: [
          tune('GRASS_MOWN_PER_M2', () => GRASS_MOWN_PER_M2, (v) => (GRASS_MOWN_PER_M2 = v), [0, 120], 1, 'blades/m² inside the mow line'),
          tune('GRASS_ROUGH_PER_M2', () => GRASS_ROUGH_PER_M2, (v) => (GRASS_ROUGH_PER_M2 = v), [0, 80], 1, 'blades/m² beyond it'),
          tune('GRASS_HEIGHT_SCALE', () => GRASS_HEIGHT_SCALE, (v) => (GRASS_HEIGHT_SCALE = v), [0.2, 3], 0.05),
          tune('GRASS_WIDTH_SCALE', () => GRASS_WIDTH_SCALE, (v) => (GRASS_WIDTH_SCALE = v), [0.3, 3], 0.05),
        ],
      },
      {
        title: 'LOD cutoffs',
        keys: [
          tune('GRASS_RADIUS', () => GRASS_RADIUS, (v) => (GRASS_RADIUS = v), [10, 120], 1, 'no blades beyond this (m)'),
          tune('GRASS_LOD_NEAR', () => GRASS_LOD_NEAR, (v) => (GRASS_LOD_NEAR = v), [2, 60], 1, 'full density inside (m)'),
          tune('GRASS_LOD_MID', () => GRASS_LOD_MID, (v) => (GRASS_LOD_MID = v), [4, 100], 1, 'mid density inside (m)'),
          tune('GRASS_LOD_MID_DENSITY', () => GRASS_LOD_MID_DENSITY, (v) => (GRASS_LOD_MID_DENSITY = v), [0, 1], 0.05),
          tune('GRASS_LOD_FAR_DENSITY', () => GRASS_LOD_FAR_DENSITY, (v) => (GRASS_LOD_FAR_DENSITY = v), [0, 1], 0.05),
        ],
      },
      {
        title: 'placement',
        keys: [
          tune('GRASS_MOW_LINE', () => GRASS_MOW_LINE, (v) => (GRASS_MOW_LINE = v), [0, 30], 0.5, 'mown strip width from the pavement edge (m)'),
          tune('GRASS_MAX_FROM_ROAD', () => GRASS_MAX_FROM_ROAD, (v) => (GRASS_MAX_FROM_ROAD = v), [10, 200], 1),
          tune('GRASS_PATCHINESS', () => GRASS_PATCHINESS, (v) => (GRASS_PATCHINESS = v), [0, 0.7], 0.01, 'share of patches left bare'),
          tune('GRASS_PATCH_SIZE', () => GRASS_PATCH_SIZE, (v) => (GRASS_PATCH_SIZE = v), [1, 30], 1, 'bare patch size (m)'),
          tune('GRASS_SCATTER', () => GRASS_SCATTER, (v) => (GRASS_SCATTER = v), [0.1, 2], 0.05, 'blade scatter around the clump (m)'),
          tune('GRASS_SLOPE_MAX', () => GRASS_SLOPE_MAX, (v) => (GRASS_SLOPE_MAX = v), [0.1, 3], 0.05, 'no turf steeper than this (m/m)'),
        ],
      },
      {
        title: 'blades',
        keys: [
          tune('GRASS_MOWN_HEIGHT', () => GRASS_MOWN_HEIGHT, (v) => (GRASS_MOWN_HEIGHT = v), [0.05, 1], 0.01, 'm'),
          tune('GRASS_ROUGH_HEIGHT', () => GRASS_ROUGH_HEIGHT, (v) => (GRASS_ROUGH_HEIGHT = v), [0.2, 4], 0.05, 'm before the season multiplier'),
          tune('GRASS_LEAN', () => GRASS_LEAN, (v) => (GRASS_LEAN = v), [0, 1.5], 0.05),
          tune('GRASS_WIND', () => GRASS_WIND, (v) => (GRASS_WIND = v), [0, 3], 0.05),
        ],
      },
      {
        title: 'sprites (beyond the mid ring)',
        keys: [
          tune('GRASS_SPRITE_RADIUS', () => GRASS_SPRITE_RADIUS, (v) => (GRASS_SPRITE_RADIUS = v), [20, 1500], 10, 'clump cards out to here (m)'),
          tune('GRASS_SPRITE_PER_M2', () => GRASS_SPRITE_PER_M2, (v) => (GRASS_SPRITE_PER_M2 = v), [0, 4], 0.05),
          tune('GRASS_SPRITE_FAR_DENSITY', () => GRASS_SPRITE_FAR_DENSITY, (v) => (GRASS_SPRITE_FAR_DENSITY = v), [0, 1], 0.05, 'share of cards kept at the far rim'),
          tune('GRASS_SPRITE_SCALE', () => GRASS_SPRITE_SCALE, (v) => (GRASS_SPRITE_SCALE = v), [0.3, 3], 0.05, 'height'),
          tune('GRASS_SPRITE_WIDTH', () => GRASS_SPRITE_WIDTH, (v) => (GRASS_SPRITE_WIDTH = v), [0.3, 3], 0.05, 'thickness'),
          tune('GRASS_SPRITE_LEAN', () => GRASS_SPRITE_LEAN, (v) => (GRASS_SPRITE_LEAN = v), [0, 1], 0.02),
          tune('GRASS_TILES_PER_FRAME', () => GRASS_TILES_PER_FRAME, (v) => (GRASS_TILES_PER_FRAME = v), [1, 64], 1, 'ceiling on tiles generated per frame'),
          tune('GRASS_MS_PER_FRAME', () => GRASS_MS_PER_FRAME, (v) => (GRASS_MS_PER_FRAME = v), [0.2, 12], 0.1, 'ms per frame spent generating them'),
          tune('GRASS_CACHE_SLACK', () => GRASS_CACHE_SLACK, (v) => (GRASS_CACHE_SLACK = v), [1, 4], 0.1, 'cached tiles as a multiple of the ring'),
        ],
      },
      {
        title: 'colour (over the season)',
        keys: [
          tune('GRASS_HUE', () => GRASS_HUE, (v) => (GRASS_HUE = v), [-60, 60], 1, 'degrees'),
          tune('GRASS_SAT', () => GRASS_SAT, (v) => (GRASS_SAT = v), [0, 2], 0.02),
          tune('GRASS_LIGHT', () => GRASS_LIGHT, (v) => (GRASS_LIGHT = v), [0.3, 2], 0.02),
          tune('GRASS_DRY_ADD', () => GRASS_DRY_ADD, (v) => (GRASS_DRY_ADD = v), [-1, 1], 0.02, 'straw on top of the season'),
          tune('GRASS_WIND_STILL_BELOW', () => GRASS_WIND_STILL_BELOW, (v) => (GRASS_WIND_STILL_BELOW = v), [0, 40], 0.5, 'no sway above this speed (m/s)'),
          tune('GRASS_TYPE', () => GRASS_TYPE, (v) => (GRASS_TYPE = v), [-1, 3], 1, '-1 from the bake; 0 common 1 wheat 2 bermuda 3 coastal'),
          tune('SEASON', () => SEASON, (v) => (SEASON = v), [-1, 3], 1, '-1 use the selector; 0 winter 1 spring 2 summer 3 autumn'),
        ],
      },
    ],
  },
  {
    name: 'trees',
    sections: [
      {
        title: 'LOD',
        keys: [
          tune('TREE_NEAR_RADIUS', () => TREE_NEAR_RADIUS, (v) => (TREE_NEAR_RADIUS = v), [30, 600], 5, 'procedural models inside, impostors beyond (m)'),
          tune('TREE_FADE_M', () => TREE_FADE_M, (v) => (TREE_FADE_M = v), [0, 120], 1, 'band outside that radius where the card dissolves; 0 = hard switch'),
          tune('TREE_NEAR_CAPACITY', () => TREE_NEAR_CAPACITY, (v) => (TREE_NEAR_CAPACITY = v), [10, 500], 5, 'models per species variant'),
          tune('IMPOSTOR_FLAT_PITCH', () => IMPOSTOR_FLAT_PITCH, (v) => (IMPOSTOR_FLAT_PITCH = v), [0.2, 1.5], 0.02, 'cards lie flat above this view pitch (rad)'),
        ],
      },
    ],
  },
  {
    name: 'LOD shape',
    sections: [
      {
        title: 'footprint',
        keys: [
          tune('LOD_BEHIND_PENALTY', () => LOD_BEHIND_PENALTY, (v) => (LOD_BEHIND_PENALTY = v), [0, 2], 0.05, '0 = circle; 1 = a thing behind you counts twice as far'),
          tune('LOD_TOPDOWN_PITCH', () => LOD_TOPDOWN_PITCH, (v) => (LOD_TOPDOWN_PITCH = v), [0.2, 1.5], 0.02, 'steeper than this and the footprint is a circle again'),
        ],
      },
    ],
  },
  {
    name: 'road',
    sections: [
      {
        title: 'cross-section (road and strip rebuild live)',
        keys: [
          tune('LANE_WIDTH', () => LANE_WIDTH, (v) => (LANE_WIDTH = v), [2.5, 4.5], 0.01),
          tune('CULDESAC_RADIUS', () => CULDESAC_RADIUS, (v) => (CULDESAC_RADIUS = v), [0, 20], 0.5, 'turning bulb at a dead end (m); 0 = none'),
          tune('SHOULDER_OUT', () => SHOULDER_OUT, (v) => (SHOULDER_OUT = v), [0, 5], 0.1),
          tune('SHOULDER_IN', () => SHOULDER_IN, (v) => (SHOULDER_IN = v), [0, 5], 0.1),
          tune('ROAD_BLEND_M', () => ROAD_BLEND_M, (v) => (ROAD_BLEND_M = v), [0, 2], 0.05, 'transition strip where the surface class changes (m); 0 = hard joint'),
          tune('ROAD_TAPER_M', () => ROAD_TAPER_M, (v) => (ROAD_TAPER_M = v), [0, 200], 5, 'length a lane-count change is ramped over (m); 0 = a step'),
          tune('ROAD_ONEWAY_CENTRE', () => ROAD_ONEWAY_CENTRE, (v) => (ROAD_ONEWAY_CENTRE = v), [0, 1], 1, '0 = lanes centred on the spine (OSM truth), 1 = asphalt centred (old)'),
        ],
      },
    ],
  },
  {
    name: 'car',
    sections: [
      {
        title: 'engine',
        keys: [
          tune('CAR_TOP_SPEED', () => CAR_TOP_SPEED, (v) => (CAR_TOP_SPEED = v), [10, 150], 1, 'm/s'),
          tune('CAR_ACCEL', () => CAR_ACCEL, (v) => (CAR_ACCEL = v), [1, 40], 0.5, 'm/s² at low speed'),
          tune('CAR_BRAKE', () => CAR_BRAKE, (v) => (CAR_BRAKE = v), [2, 60], 0.5, 'm/s²'),
          tune('CAR_REVERSE_ACCEL', () => CAR_REVERSE_ACCEL, (v) => (CAR_REVERSE_ACCEL = v), [0, 1], 0.05, 'share of accel when backing up'),
          tune('CAR_HANDBRAKE_BRAKE', () => CAR_HANDBRAKE_BRAKE, (v) => (CAR_HANDBRAKE_BRAKE = v), [0, 1], 0.05, 'share of the brake force the handbrake has'),
          tune('CAR_DRAG_ROLLING', () => CAR_DRAG_ROLLING, (v) => (CAR_DRAG_ROLLING = v), [0, 3], 0.05, 'm/s²'),
          tune('CAR_DRAG_AERO', () => CAR_DRAG_AERO, (v) => (CAR_DRAG_AERO = v), [0, 0.003], 0.0001, 'm/s² per (m/s)²'),
          tune('CAR_GRAVITY', () => CAR_GRAVITY, (v) => (CAR_GRAVITY = v), [1, 30], 0.1),
        ],
      },
      {
        title: 'handling (the tyres deliver what grip allows)',
        keys: [
          tune('CAR_STEER_RATE', () => CAR_STEER_RATE, (v) => (CAR_STEER_RATE = v), [0.5, 6], 0.1, 'rad/s of yaw asked for at full lock'),
          tune('CAR_STEER_FULL_SPEED', () => CAR_STEER_FULL_SPEED, (v) => (CAR_STEER_FULL_SPEED = v), [2, 40], 0.5, 'full authority below this (m/s); demand ramps up to it'),
          tune('CAR_STEER_HIGH_SPEED_FACTOR', () => CAR_STEER_HIGH_SPEED_FACTOR, (v) => (CAR_STEER_HIGH_SPEED_FACTOR = v), [0.05, 1], 0.05, 'authority left at top speed'),
          tune('CAR_AGILITY', () => CAR_AGILITY, (v) => (CAR_AGILITY = v), [0.3, 2], 0.05, 'CarSpec multiplier on authority'),
          tune('CAR_GRIP_LATERAL', () => CAR_GRIP_LATERAL, (v) => (CAR_GRIP_LATERAL = v), [4, 60], 0.5, 'm/s² the tyres hold; radius above it is v²/grip'),
          tune('CAR_GRIP_MULT', () => CAR_GRIP_MULT, (v) => (CAR_GRIP_MULT = v), [0.3, 2], 0.05, 'CarSpec multiplier on grip'),
          tune('CAR_HANDBRAKE_GRIP', () => CAR_HANDBRAKE_GRIP, (v) => (CAR_HANDBRAKE_GRIP = v), [0.1, 1], 0.05, 'grip left with the handbrake on'),
          tune('CAR_HANDBRAKE_ROTATE', () => CAR_HANDBRAKE_ROTATE, (v) => (CAR_HANDBRAKE_ROTATE = v), [0, 1.5], 0.05, 'share of the refused yaw the rear lets through'),
          tune('CAR_HANDBRAKE_SLIDE', () => CAR_HANDBRAKE_SLIDE, (v) => (CAR_HANDBRAKE_SLIDE = v), [0, 1], 0.05, 'how much of it slides you outward'),
          tune('CAR_HANDBRAKE_MIN_SPEED', () => CAR_HANDBRAKE_MIN_SPEED, (v) => (CAR_HANDBRAKE_MIN_SPEED = v), [0, 15], 0.5, 'm/s'),
          tune('CAR_SLIDE_DECAY', () => CAR_SLIDE_DECAY, (v) => (CAR_SLIDE_DECAY = v), [0.2, 8], 0.1, '1/s the slide bleeds off at'),
          tune('CAR_BANK_HOLD', () => CAR_BANK_HOLD, (v) => (CAR_BANK_HOLD = v), [0, 1], 0.05, 'cross-slope gravity the tyres hold; the rest you steer against'),
          tune('CAR_BANK_GRIP', () => CAR_BANK_GRIP, (v) => (CAR_BANK_GRIP = v), [0, 1.5], 0.05, 'how much of a bank’s load becomes grip'),
          tune('CAR_LOAD_MAX', () => CAR_LOAD_MAX, (v) => (CAR_LOAD_MAX = v), [1, 12], 0.5, 'most a bank may multiply grip by'),
          tune('CAR_STEER_VISUAL_RATE', () => CAR_STEER_VISUAL_RATE, (v) => (CAR_STEER_VISUAL_RATE = v), [1, 40], 1, 'drawn front wheels, 1/s'),
        ],
      },
      {
        title: 'surface (grass = off the pavement)',
        keys: [
          tune('CAR_GRASS_DRAG', () => CAR_GRASS_DRAG, (v) => (CAR_GRASS_DRAG = v), [0, 4], 0.05, 'extra m/s² of drag'),
          tune('CAR_GRASS_GRIP_SCALE', () => CAR_GRASS_GRIP_SCALE, (v) => (CAR_GRASS_GRIP_SCALE = v), [0.05, 1], 0.05, 'grip left on grass'),
          tune('CAR_GRASS_TRACTION', () => CAR_GRASS_TRACTION, (v) => (CAR_GRASS_TRACTION = v), [0.1, 1], 0.05, 'throttle / brake force the tyres put down'),
          tune('CAR_GRASS_STEER', () => CAR_GRASS_STEER, (v) => (CAR_GRASS_STEER = v), [0.1, 1], 0.05, 'steering bite kept'),
          tune('CAR_GRASS_EDGE', () => CAR_GRASS_EDGE, (v) => (CAR_GRASS_EDGE = v), [0, 2], 0.05, 'm past the paved edge before it counts'),
          tune('CAR_BUMP_BOUNCE', () => CAR_BUMP_BOUNCE, (v) => (CAR_BUMP_BOUNCE = v), [0, 1], 0.05, 'speed kept (reversed) off a tree'),
        ],
      },
      {
        title: 'ride',
        keys: [
          tune('CAR_RIDE', () => CAR_RIDE, (v) => (CAR_RIDE = v), [0.1, 1], 0.01, 'reference point above the surface (m)'),
          tune('CAR_CLIMB_SLOPE', () => CAR_CLIMB_SLOPE, (v) => (CAR_CLIMB_SLOPE = v), [0.25, 6], 0.25, 'how steeply the wheels may ride up onto a kerb'),
        ],
      },
      {
        title: 'jumps (switches default off)',
        keys: [
          tune('CAR_LAUNCH_MIN_SPEED', () => CAR_LAUNCH_MIN_SPEED, (v) => (CAR_LAUNCH_MIN_SPEED = v), [0, 40], 1, 'slower than this and a crest is just followed (m/s)'),
          tune('CAR_LAUNCH_GAP', () => CAR_LAUNCH_GAP, (v) => (CAR_LAUNCH_GAP = v), [0.02, 2], 0.02, 'ground must fall this far away before you are airborne (m)'),
          tune('CAR_LAUNCH_MAX_RISE', () => CAR_LAUNCH_MAX_RISE, (v) => (CAR_LAUNCH_MAX_RISE = v), [0, 30], 0.5, 'most vertical speed a crest can impart (m/s); 8 ≈ a 3.3 m jump'),
          tune('CAR_CREST_GAIN', () => CAR_CREST_GAIN, (v) => (CAR_CREST_GAIN = v), [0.5, 6], 0.1, '1 = real physics; higher makes a crest throw the car sooner'),
          tune('CAR_CRASH_IMPACT_SPEED', () => CAR_CRASH_IMPACT_SPEED, (v) => (CAR_CRASH_IMPACT_SPEED = v), [5, 80], 1, 'vertical m/s that wrecks the car'),
          tune('CAR_AIR_NOSE_RATE', () => CAR_AIR_NOSE_RATE, (v) => (CAR_AIR_NOSE_RATE = v), [0.2, 10], 0.1, 'nose follows the arc, 1/s'),
          tune('CAR_AIR_ROLL_SETTLE', () => CAR_AIR_ROLL_SETTLE, (v) => (CAR_AIR_ROLL_SETTLE = v), [0.2, 10], 0.1, 'roll levels out, 1/s'),
          tune('CAR_AIR_GLITCH', () => CAR_AIR_GLITCH, (v) => (CAR_AIR_GLITCH = v), [0, 1], 1, 'speedlock: 1 = on'),
          tune('CAR_AIR_GLITCH_THRESHOLD', () => CAR_AIR_GLITCH_THRESHOLD, (v) => (CAR_AIR_GLITCH_THRESHOLD = v), [0.2, 1], 0.05, 'share of top speed to arm it'),
          tune('CAR_AIR_GLITCH_ACCEL', () => CAR_AIR_GLITCH_ACCEL, (v) => (CAR_AIR_GLITCH_ACCEL = v), [10, 1000], 10, 'm/s² back to top speed'),
          tune('CAR_ROCKETS', () => CAR_ROCKETS, (v) => (CAR_ROCKETS = v), [0, 1], 1, 'rocket jumps: 1 = on'),
          tune('CAR_ROCKET_CHANCE', () => CAR_ROCKET_CHANCE, (v) => (CAR_ROCKET_CHANCE = v), [0, 1], 0.05, 'share of qualifying launches that fire'),
          tune('CAR_ROCKET_SPEED', () => CAR_ROCKET_SPEED, (v) => (CAR_ROCKET_SPEED = v), [20, 400], 10, 'straight up, m/s'),
          tune('CAR_ROCKET_MIN_SPEED', () => CAR_ROCKET_MIN_SPEED, (v) => (CAR_ROCKET_MIN_SPEED = v), [0.5, 1], 0.02, 'share of top speed needed'),
        ],
      },
    ],
  },
  {
    name: 'terrain',
    sections: [
      {
        title: 'rock (cut faces and outcrops; reload to rebuild)',
        keys: [
          tune('ROCK_PER_M', () => ROCK_PER_M, (v) => (ROCK_PER_M = v), [0, 4], 0.05, 'boulders per metre of face'),
          tune('ROCK_OUTCROP_PER_M2', () => ROCK_OUTCROP_PER_M2, (v) => (ROCK_OUTCROP_PER_M2 = v), [0, 0.5], 0.01, 'per m² of exposed rock'),
          tune('ROCK_SIZE', () => ROCK_SIZE, (v) => (ROCK_SIZE = v), [0.2, 4], 0.05, 'm'),
          tune('ROCK_PAVEMENT_CLEAR', () => ROCK_PAVEMENT_CLEAR, (v) => (ROCK_PAVEMENT_CLEAR = v), [0, 10], 0.1, 'no rock nearer the pavement than this (m)'),
          tune('ROCK_SAND_DENSITY', () => ROCK_SAND_DENSITY, (v) => (ROCK_SAND_DENSITY = v), [0, 1], 0.05, 'density on sand/gravel faces (coastal plain)'),
        ],
      },
      {
        title: 'water',
        keys: [
          tune('WATER_DEPTH', () => WATER_DEPTH, (v) => (WATER_DEPTH = v), [0, 2], 0.05, 'surface above the channel bottom (m)'),
          tune('WATER_WIDTH_SCALE', () => WATER_WIDTH_SCALE, (v) => (WATER_WIDTH_SCALE = v), [0.3, 3], 0.05),
          tune('WATER_SPEED', () => WATER_SPEED, (v) => (WATER_SPEED = v), [0, 4], 0.05, 'ripple speed'),
          tune('WATER_OPACITY', () => WATER_OPACITY, (v) => (WATER_OPACITY = v), [0.2, 1], 0.02),
          tune('WATER_LEVEL_M', () => WATER_LEVEL_M, (v) => (WATER_LEVEL_M = v), [-20, 300], 0.5, 'still water / sea level (m); raise it to flood'),
          tune('WATER_LEVEL_SPAN', () => WATER_LEVEL_SPAN, (v) => (WATER_LEVEL_SPAN = v), [200, 60000], 100, 'how far the water plane reaches (m)'),
          tune('POWER_HEIGHT_SCALE', () => POWER_HEIGHT_SCALE, (v) => (POWER_HEIGHT_SCALE = v), [0.3, 2], 0.05, 'pole and tower height'),
          tune('POWER_SAG', () => POWER_SAG, (v) => (POWER_SAG = v), [0, 0.12], 0.005, 'conductor sag as a fraction of the span'),
          tune('POWER_SAG_MAX', () => POWER_SAG_MAX, (v) => (POWER_SAG_MAX = v), [0, 20], 0.5, 'm'),
        ],
      },
    ],
  },
  {
    name: 'furniture',
    sections: [
      {
        title: 'signals and signs',
        keys: [
          tune('FURNITURE_SIGNAL_HEIGHT', () => FURNITURE_SIGNAL_HEIGHT, (v) => (FURNITURE_SIGNAL_HEIGHT = v), [3, 12], 0.1, 'mast pole height (m)'),
          tune('FURNITURE_SIGNAL_ARM_SCALE', () => FURNITURE_SIGNAL_ARM_SCALE, (v) => (FURNITURE_SIGNAL_ARM_SCALE = v), [0.4, 2.5], 0.05, 'arm reach ×'),
          tune('FURNITURE_SIGNAL_LIT', () => FURNITURE_SIGNAL_LIT, (v) => (FURNITURE_SIGNAL_LIT = v), [0, 1], 1, '1 lights a lens; there is no controller'),
          tune('FURNITURE_SIGN_HEIGHT', () => FURNITURE_SIGN_HEIGHT, (v) => (FURNITURE_SIGN_HEIGHT = v), [1, 4], 0.05, 'sign post height (m)'),
          tune('FURNITURE_KERB_CLEAR', () => FURNITURE_KERB_CLEAR, (v) => (FURNITURE_KERB_CLEAR = v), [0, 4], 0.1, 'm clear of the asphalt a post needs'),
          tune('FURNITURE_KERB_MAX', () => FURNITURE_KERB_MAX, (v) => (FURNITURE_KERB_MAX = v), [2, 40], 1, 'm it may be walked sideways to find it'),
          tune('FURNITURE_MAX_FROM_ROAD', () => FURNITURE_MAX_FROM_ROAD, (v) => (FURNITURE_MAX_FROM_ROAD = v), [2, 400], 2, 'm from a drawn road, or it is not placed'),
          tune('FURNITURE_SETBACK_MAX', () => FURNITURE_SETBACK_MAX, (v) => (FURNITURE_SETBACK_MAX = v), [0, 40], 1, 'm back along the approach, out of the junction box'),
          tune('FURNITURE_ARM_MAX', () => FURNITURE_ARM_MAX, (v) => (FURNITURE_ARM_MAX = v), [4, 30], 0.5, 'm of arm before the mast is dropped instead'),
        ],
      },
      {
        title: 'parking',
        keys: [
          tune('PARKING_STALL_W', () => PARKING_STALL_W, (v) => (PARKING_STALL_W = v), [2, 4], 0.05, 'bay width (m)'),
          tune('PARKING_STALL_D', () => PARKING_STALL_D, (v) => (PARKING_STALL_D = v), [3.5, 8], 0.1, 'bay depth (m)'),
          tune('PARKING_AISLE_W', () => PARKING_AISLE_W, (v) => (PARKING_AISLE_W = v), [3, 12], 0.25, 'drive aisle, where none is mapped (m)'),
          tune('PARKING_PAINT_W', () => PARKING_PAINT_W, (v) => (PARKING_PAINT_W = v), [0.04, 0.5], 0.01, 'painted line width (m)'),
          tune('PARKING_PAINT_LIFT', () => PARKING_PAINT_LIFT, (v) => (PARKING_PAINT_LIFT = v), [0.005, 0.2], 0.005, 'paint over asphalt (m)'),
          tune('PARKING_LIFT', () => PARKING_LIFT, (v) => (PARKING_LIFT = v), [0, 0.4], 0.01, 'asphalt over ground (m)'),
          tune('PARKING_ROAD_OVERLAP', () => PARKING_ROAD_OVERLAP, (v) => (PARKING_ROAD_OVERLAP = v), [0, 1], 0.05, 'share over a carriageway before a lot is skipped'),
          tune('PARKING_MIN_GRID_M2', () => PARKING_MIN_GRID_M2, (v) => (PARKING_MIN_GRID_M2 = v), [50, 5000], 50, 'no fallback grid below this area (m²)'),
          tune('PARKING_AISLE_GAP', () => PARKING_AISLE_GAP, (v) => (PARKING_AISLE_GAP = v), [0, 3], 0.05, 'clearance past the aisle edge (m)'),
          tune('PARKING_FILL_M2', () => PARKING_FILL_M2, (v) => (PARKING_FILL_M2 = v), [10, 300], 5, 'm² per stall below which the grid fills in too'),
          tune('BARRIER_HEIGHT_SCALE', () => BARRIER_HEIGHT_SCALE, (v) => (BARRIER_HEIGHT_SCALE = v), [0.3, 3], 0.05, 'guard rail, fence, wall and hedge height ×'),
        ],
      },
    ],
  },
  {
    name: 'camera',
    sections: [
      {
        title: 'chase',
        keys: [
          tune('CHASE_BACK', () => CHASE_BACK, (v) => (CHASE_BACK = v), [2, 30], 0.5),
          tune('CHASE_UP', () => CHASE_UP, (v) => (CHASE_UP = v), [0.5, 15], 0.1),
          tune('CHASE_LOOK_AHEAD', () => CHASE_LOOK_AHEAD, (v) => (CHASE_LOOK_AHEAD = v), [0, 40], 0.5),
          tune('CHASE_LAG', () => CHASE_LAG, (v) => (CHASE_LAG = v), [1, 30], 0.5, 'higher = stiffer'),
          tune('CAM_SIT_HEIGHT', () => CAM_SIT_HEIGHT, (v) => (CAM_SIT_HEIGHT = v), [0.25, 5], 0.05, 'eye height for G, sit on the road (m)'),
          tune('CAM_MIN_HEIGHT', () => CAM_MIN_HEIGHT, (v) => (CAM_MIN_HEIGHT = v), [0.05, 5], 0.05, 'fly camera floor above ground (m)'),
          tune('COCKPIT_EYE_UP', () => COCKPIT_EYE_UP, (v) => (COCKPIT_EYE_UP = v), [0.3, 3], 0.05),
          tune('COCKPIT_EYE_FWD', () => COCKPIT_EYE_FWD, (v) => (COCKPIT_EYE_FWD = v), [-2, 3], 0.05),
          tune('COCKPIT_EYE_SIDE', () => COCKPIT_EYE_SIDE, (v) => (COCKPIT_EYE_SIDE = v), [-0.9, 0.9], 0.02, 'driver seat offset, - = left'),
          tune('COCKPIT_ROLL', () => COCKPIT_ROLL, (v) => (COCKPIT_ROLL = v), [0, 1], 0.05, 'share of the body roll the head takes on'),
          tune('COCKPIT_LOOK_UP', () => COCKPIT_LOOK_UP, (v) => (COCKPIT_LOOK_UP = v), [-3, 3], 0.1),
        ],
      },
    ],
  },
]

/**
 * The LOD footprint. Distance from the eye, stretched behind the view: a thing directly behind
 * counts (1 + LOD_BEHIND_PENALTY) times as far, ahead counts as is, so the budget goes where the
 * driver and the flyer look. When the camera pitches down past LOD_TOPDOWN_PITCH the stretch
 * fades out and the footprint is a circle, which is what a map view wants.
 */
export function lodDistance(dx: number, dz: number, fwdX: number, fwdZ: number, pitch: number): number {
  const d = Math.hypot(dx, dz)
  if (d < 1e-6 || LOD_BEHIND_PENALTY <= 0) return d
  const cos = (dx * fwdX + dz * fwdZ) / d // 1 ahead, -1 behind
  const behind = (1 - cos) * 0.5 // 0 ahead … 1 behind
  const topdown = Math.min(1, Math.max(0, (pitch - LOD_TOPDOWN_PITCH * 0.7) / (LOD_TOPDOWN_PITCH * 0.3)))
  return d * (1 + LOD_BEHIND_PENALTY * behind * (1 - topdown))
}
