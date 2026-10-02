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
export let GRASS_LOD_FAR_DENSITY = 0.6
/** blade size multipliers over the season palette */
export let GRASS_HEIGHT_SCALE = 1.5
export let GRASS_WIDTH_SCALE = 0.55
/** how far from the pavement edge the mow line runs, and where grass stops entirely */
export let GRASS_MOW_LINE = 13
// zoning (zoning.ts): in a RURAL zone only this much beside the pavement is mown, the rest grows
// GRASS_RURAL_TALL times the rough height; a KEPT zone is mown everywhere
// how far a blade's ROOT stands back from the pavement edge, before its own lean is allowed for
/**
 * Half the along-track band of a road station, metres.
 *
 * Stations are 5 m apart. Inside this band the distance field measures laterally from the
 * station's tangent; outside it, radially from the station. It must be more than half the spacing
 * or consecutive bands leave a wedge on the outside of a bend where the field over-reports by
 * about 0.85 m — which is how grass came to stand on the asphalt (2026-09-27). It is also what
 * gives a lone station (a cul-de-sac bulb) its shape, so raising it stretches a bulb's disc into
 * a stadium.
 */
export let EDGE_BAND_M = 3.5
export let GRASS_ROAD_CLEAR = 0.3
/**
 * How near a road a blade has to be before its own position is checked against the MASKS
 * (parking, walks, bare ground, paved imagery) rather than extrapolated from its cell.
 *
 * The masks have hard edges and no gradient, so a step along the geometry's gradient cannot see
 * them. It was 10 m, which covered the kerb but not the middle of a car park: 262 of 971 blades
 * at one of Rich's stances stood on ground a mask calls bare or paved (2026-09-27). A raster
 * lookup is cheaper than the station walk, so it now covers the whole verge band.
 */
export let GRASS_MASK_CHECK_M = 60
/**
 * Within this of pavement, every blade asks the distance field for its OWN position instead of
 * stepping there along the gradient from its cell.
 *
 * The step is exact along a road and wrong beside a driveway, where a handful of short, sharply
 * curved stations make the field bend faster than a straight line can follow. Raising this buys
 * accuracy with a grid walk per blade; lowering it puts grass back on the apron.
 */
export let GRASS_EXACT_M = 3
export let GRASS_RURAL_MOW_LINE = 3
export let GRASS_RURAL_TALL = 1.3
// a new grass tile grows in over this many seconds instead of appearing at full height
export let GRASS_GROW_S = 0.8
export let GRASS_MAX_FROM_ROAD = 24
/** blade heights (m): mown turf, and the rough before the season multiplier */
export let GRASS_MOWN_HEIGHT = 0.22
export let GRASS_ROUGH_HEIGHT = 1.8
/** how far a blade's tip leans from its root (fraction of height), and how hard the wind blows */
export let GRASS_LEAN = 0.45
export let GRASS_WIND = 0.45 // was 1.0: "way too much emphasis on its motion" (Rich, 2026-09-26)
/** bare patches: the share of patch cells left bare, and the patch size (m) */
export let GRASS_PATCHINESS = 0.12
export let GRASS_PATCH_SIZE = 6
/** how far blades scatter around their clump centre (m), and the steepest turf slope (m/m) */
export let GRASS_SCATTER = 0.7
export let GRASS_SLOPE_MAX = 0.7
/** past the strip's blend band, no grass where the ground stands this far above the bare DEM (m): that is a shelf, not ground. 0 = off */
export let GRASS_MAX_SHELF = 1.0

// --- crops --------------------------------------------------------------------------------------
/** 1 = grow crops on every OSM farmland ring as well as on authored areas */
export let CROP_AUTO_FARMLAND = 1
/** row spacing × this: the whole field coarsens or tightens together */
export let CROP_ROW_SCALE = 1
/** metres of row per ribbon segment: shorter follows the ground better and costs more */
export let CROP_SEGMENT_M = 4
/** metres of row per repeat of the plant texture */
export let CROP_TEXTURE_M = 2
/** no crop closer than this to a pavement edge (m) */
export let CROP_MIN_FROM_ROAD = 2
export let CROP_WIND = 1
/**
 * 1 = a field stays at full brightness after dark (the glow). 0 = it takes the same day and night
 * light as the grass and the trees.
 */
export let CROP_GLOW = 0

// --- weather ------------------------------------------------------------------------------------
/** -1 = clear; 0 clear, 1 rain, 2 sleet, 3 snow, 4 ice (weather.ts) */
export let WEATHER = 0
/** the box of falling particles that follows the camera, × the weather's own size */
export let WEATHER_BOX = 1
/** particle density × this */
export let WEATHER_RATE = 1
export let WEATHER_OPACITY = 1
/** sideways drift × this; the same gust direction the grass leans with */
export let WEATHER_WIND = 1
/** how much settles, × the weather's own figure */
export let WEATHER_ACCUM = 1
/** how fast the settled layer builds and melts, per second */
// how fast a surface wets (per second) and how slowly it dries after the rain stops
export let WEATHER_WET_RATE = 0.5
export let WEATHER_DRY_RATE = 0.006
/** a soaked road's roughness: low is a mirror for the sky and the headlights */
export let WET_ROUGHNESS = 0.18
/** how much water darkens what it soaks */
export let WET_DARKEN = 0.45
/** how hard a wet surface reflects the sky */
export let WET_REFLECT = 1.8
export let WEATHER_SETTLE_RATE = 0.012
export let WEATHER_MELT_RATE = 0.06
/**
 * What a tyre keeps on this surface, 0…1. Weather sets it; `car.ts` (road-and-car's) multiplies
 * its grip by it. 1 until they wire it up, and harmless until then.
 */
export let WEATHER_GRIP_SCALE = 1
/** sprite clumps: from the mid ring out to this radius (m), cards per m², size multiplier */
export let GRASS_SPRITE_RADIUS = 300
export let GRASS_SPRITE_PER_M2 = 0.8
export let GRASS_SPRITE_SCALE = 1.0
/** sprite look: card width multiplier, lean (shear of the top), and the density kept at the far rim */
export let GRASS_SPRITE_WIDTH = 1.2
export let GRASS_SPRITE_LEAN = 0.25
export let GRASS_SPRITE_FAR_DENSITY = 0.5 // was 0.25: the far rim was a quarter as dense as the near, and read as bare
/** colour over the season palette: hue shift (deg), saturation, lightness, and extra straw/dryness
 *  (September verge grass is not April grass: default +0.3 dryness) */
export let GRASS_HUE = 0
export let GRASS_SAT = 0.9
export let GRASS_LIGHT = 1.0
export let GRASS_DRY_ADD = 0
/**
 * 1: the distance cards are the grass at every range, and nothing is generated as blades.
 * 0: dynamic blades up close, cards only in the distance. GRASS_WIND_STILL_BELOW can still swap a
 * moving eye over to cards while this is 0; 0 on that knob keeps the blades on at any speed.
 */
export let GRASS_CARDS = 1
/**
 * Above this eye speed (m/s) the grass is static cards and nothing is generated as blades.
 * Below it, the blades come back and the wind with them. 0 keeps the blades on at any speed.
 * Ignored while GRASS_CARDS is on.
 */
export let GRASS_WIND_STILL_BELOW = 0
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

// --- traffic ------------------------------------------------------------------------------------
/** never more traffic cars than this, whatever the zones and the level ask for */
export let TRAFFIC_MAX = 600
/** traffic cars further than this from the eye are simulated but not drawn (m) */
export let TRAFFIC_DRAW_M = 700
/** m from the player a car that ran off its road may come back at. Closer is a car from thin air */
export let TRAFFIC_RESPAWN_M = 260
/** m from the player within which a traffic car has a body in the solver; further, it is a mesh */
export let TRAFFIC_PHYS_M = 220
/**
 * Loose wrecks at once. Past this the OLDEST is straightened out, put back on rails and respawned
 * out of sight — Rich wanted the pile-up to go on for ever in a blind-drivers game, and a wreck is
 * a dynamic body plus a 130k-vertex mesh drawn at full detail, so a pile of hundreds was 13 fps.
 */
export let TRAFFIC_WRECKS_MAX = 40
/** a traffic car hit harder than this (N·s) stops being driven and becomes a loose body */
export let TRAFFIC_WAKE_NS = 8000
/** the missile: how fast it leaves, how far its blast reaches, and how hard (m/s given to a car at the centre) */
export let MISSILE_SPEED = 120
export let MISSILE_RADIUS = 11
/** m/s a car at the centre of the blast is given. 30 is ridiculous, which is the brief (Rich, 2026-09-30) */
export let MISSILE_IMPULSE = 30
/** how much of the throw points up: 1 sends a car over the one beside it */
export let MISSILE_LIFT = 1.1
// --- the machine gun (weaponfx.ts) --------------------------------------------------------------
/** rounds per second, both guns together */
export let GUN_RATE = 14
/** how far a round is looked for, m */
export let GUN_RANGE = 180
/** m/s the car a round lands on is given, along the shot */
export let GUN_IMPULSE = 7
/** spread, as a fraction of the aim: 0.015 is a hand-span at 50 m */
export let GUN_SPREAD = 0.015

// --- trees --------------------------------------------------------------------------------------
/**
 * near-field radius (procedural models) — beyond it, impostors.
 *
 * WAS 240, WITH 140 MODELS A SPECIES: seven hundred full trees, which Rich (2026-09-29) called
 * *"pretty insane, definitely the main thing that kills frame rate"*. Measured in dense woods on
 * arrowhead at 2560 × 1323, stopped at the roadside, after the leaves went Lambert:
 *
 *     radius 240 × 140    700 trees   24.6 ms
 *     radius 150 × 90     450 trees   21.2 ms
 *     radius 120 × 100    285 trees   19.9 ms
 *     radius 100 × 140    184 trees   18.0 ms
 *     radius  90 × 60     140 trees   16.6 ms   (the display's 60 Hz floor)
 *
 * The cost is leaf FILL — the nearest trees' canopies over the whole screen — so it scales with
 * how many trees are close, not with how many are drawn. These defaults sit just above the floor
 * in the worst case that was found; the F6 trees tab has all of it.
 */
export let TREE_NEAR_RADIUS = 110
/** the band just outside that radius over which the impostor card dissolves away, so a tree does
 *  not pop from card to model in one frame. 0 disables the fade (the old hard switch). */
export let TREE_FADE_M = 30
/** instanced models per variant in the near field (5 variants) */
export let TREE_NEAR_CAPACITY = 90
/**
 * Beyond this distance a near tree wears its far canopy: a few big leaves rather than many small.
 *
 * Measured on Rich's machine, 2026-09-29: the full canopies of 700 near trees were the difference
 * between 44 fps and the display's 60, and the branches were not (see `trees.ts` buildVariant).
 */
// OFF BY DEFAULT (past any near radius). Measured on Rich's machine the same night it was built:
// leaf LOD at 1000, 90 and 0 m gave the same frame time, because a far tree is small on screen
// and fill is what costs — and the few big leaves read as lollipops beside the real trees
// (Rich, 2026-09-30: "I am still seeing both lollipop and regular trees"). The knob stays for
// experiments; the look does not.
export let TREE_LEAF_LOD_M = 400
/** the far canopy's share of the leaves, and how much bigger each one is */
export let TREE_FAR_LEAF_SHARE = 0.3
export let TREE_FAR_LEAF_SIZE = 1.9
/**
 * The near set is a CONE in front of the camera, not a circle around it.
 *
 * Rich, 2026-09-29: *"It would be good to be able to render the trees in a projected cone covering
 * the FOV off the camera instead of a circle like it does now."* A tree outside this half-angle
 * counts `TREE_CONE_PENALTY` times further away than it is, so the near budget goes to what is on
 * screen and the trees behind you are impostors until you turn round. 180 is the old circle. The
 * default is wider than the widest view (a 2560-wide window at the 60° vertical FOV sees about
 * 48° either side) by enough that a turn smaller than `TREE_REFRESH_TURN` cannot show the edge.
 */
export let TREE_CONE_DEG = 80
/** how much further a tree outside the cone counts, as a multiple of its distance (0 = no cone) */
export let TREE_CONE_PENALTY = 3
/** the near set is refilled once the camera has turned this far (rad) */
export let TREE_REFRESH_TURN = 0.22
/**
 * 1 = every tree is the far LOD lollipop, and the procedural models are never built.
 *
 * Rich, 2026-09-29: *"I kind of like the dumb preview trees, can we add an option for the tree
 * renderer in the main game to be the preview trees instead of the procgen trees?"* The "preview
 * trees" are this renderer's FAR level of detail — one instanced lollipop per canopy cell, tens of
 * thousands of them, each at its measured lidar height. They read as a stylised wood rather than as
 * a cheap one, and they cost almost nothing.
 *
 * It is not the same as setting `TREE_NEAR_RADIUS` to zero, although that has the same picture: the
 * near set is skipped entirely rather than computed and found empty, and — more to the point —
 * "trees ×" is a thing somebody has to be told to zero out, while this is a thing the panel offers.
 */
export let TREE_SIMPLE = 0
/**
 * 1 = the EDITOR's trees in the game: one faceted crown and a trunk per tree, the lollipops the
 * site editor draws because it has no renderer to bake impostors with.
 *
 * Rich, 2026-09-30: *"the option to include the lollipop trees from the editor instead of realistic
 * trees or basic trees in the settings."* `TREE_SIMPLE` was meant to be this and is not: with a
 * renderer the far field is impostor cards, so it gives cards everywhere, not lollipops. This one
 * shows the crown meshes and hides the cards and the models. Settings → Display → Trees sets both.
 */
export let TREE_LOLLIPOP = 0
/** impostor cards lie flat above this view pitch (rad) */
export let IMPOSTOR_FLAT_PITCH = 0.62
/**
 * Far tree cards are baked under a dimmer sun than the live models, so the same tree reads dark
 * once it swaps to a card. This is that gap, and only the cards see it.
 */
export let IMPOSTOR_LIGHT = 1.65
/** hue shift of a far card, degrees. 0 keeps the bake. */
export let IMPOSTOR_HUE = 0
/** colour gain of a far card. 1 is the bake, 0 is grey, above 1 pushes the green. */
export let IMPOSTOR_COLOR = 1
/**
 * Half-size of the shadow map around the camera, in metres, and how far past the eye an extra
 * tree caster is allowed. The near models cast inside it; cards or an invisible canopy take the
 * trees the models never drew.
 */
export let SHADOW_REACH = 180
/** 1 = impostor cards beyond the modelled trees cast a shadow. */
export let SHADOW_CARDS = 1
/** 1 = an invisible crown casts instead of the card, for the same trees. It wins over the cards. */
export let SHADOW_CANOPY = 0
/**
 * How far the canopy shadows reach, in metres, measured from the eye. Casters start where the
 * high-resolution trees stop, so the two shadows do not stack. While the canopy is on, the shadow
 * map grows to this distance.
 */
export let SHADOW_CANOPY_REACH = 400
/** invisible crown size as a fraction of the tree's height. */
export let SHADOW_CANOPY_SCALE = 0.75

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
/** paint stops this far from the centre of a junction; nothing is painted through one */
export let JUNCTION_CLEAR = 9
export let SHOULDER_OUT = 3.0
/** a KERBED street has no shoulder: the asphalt ends this far past the lane at the gutter (m) */
export let KERB_GUTTER = 0.3
export let SHOULDER_IN = 1.2
/** m: width of the transition strip where the surface class changes. 0 = the old hard joint. */
export let ROAD_BLEND_M = 0.15
/** m: length a lane-count change is ramped over, so an auxiliary lane tapers instead of appearing
 *  sideways in one quad. 0 = the old step. */
export let ROAD_TAPER_M = 60
/** 0 = a one-way carriageway's TRAVEL LANES are centred on the spine (OSM draws the way down the
 *  lanes, so this is the truthful one); 1 = the asphalt is centred instead, as it was before. */
export let ROAD_ONEWAY_CENTRE = 0


// --- engine sound (packages/enginesim) ---------------------------------------------------------
//
// The car you hear. `enginesound.ts` runs Ange Yaghi's combustion simulator in an audio worklet;
// these are the knobs for the car you are driving RIGHT NOW, as opposed to the bench
// (`npm run bench -w @apex/enginesim`), which is for voicing an engine as an asset.
//
// Two groups, and they are not the same kind of thing. The DRIVETRAIN is ours — corridor's car has
// a speed and no crankshaft, so a gearbox turns one into the other, and these numbers are the only
// description of it anywhere. The VOICING belongs to the engine script, which ships its own; the
// panel's copies are what you get when ENGINE_VOICE_OVERRIDE is on, and their defaults below are
// the GM LS's own values so that turning it on changes nothing until you move something.

/**
 * Which engine, as an index into the generated catalog (packages/enginesim/wasm/engines.json,
 * sorted by path). 14 is the GM LS. An index rather than a name because this panel is sliders and
 * numbers all the way down — and being able to walk through twenty engines with an arrow key while
 * driving is most of the point.
 *
 * `enginesound.ts` resolves the DEFAULT by path, not by this number, so if the catalog gains an
 * engine and the indices shift the car still starts on the right one and only the saved value in
 * someone's browser points somewhere new.
 */
export let ENGINE_INDEX = 14
/** Master gain for the whole engine, after everything else. 0 is silence. */
export let ENGINE_MASTER = 0.9
/*
 * WHERE THE ENGINE IS. These are the inverse distance model Web Audio itself uses, spelled out so
 * the unspatialised interior bus can share the curve (see @apex/enginesim `inverseGain`).
 *
 *     gain = ref / (ref + rolloff * (clamp(d, ref, max) - ref))
 */
/** Full volume inside this radius. A car is about this big, so sitting in it is never quiet. */
export let ENGINE_REF_M = 2.5
/** Beyond this the attenuation stops getting worse — the floor, not silence. */
export let ENGINE_MAX_M = 400
/** How fast it falls off between the two. 1 is the physical inverse law; less is more generous. */
export let ENGINE_ROLLOFF = 0.9
/**
 * Inside this many metres you are in the cabin and the sound stops being panned; beyond
 * ENGINE_EXTERIOR_M it is fully a point source out in the world. Between them it crossfades, so
 * cockpit↔chase is a short blend rather than a click.
 */
export let ENGINE_INTERIOR_M = 1.6
export let ENGINE_EXTERIOR_M = 4.0
/** A cabin is a lowpass. The corner applied when you are fully inside. */
export let ENGINE_MUFFLE_HZ = 900
/**
 * 1 = HRTF panning, a measured head model. OFF by default, and the reason is measured: Chromium's
 * HRTF gain swings 5.25× across frequency and azimuth (+3.8 dB at 220 Hz ahead, −10.6 dB at
 * 12 kHz behind), so it re-colours the engine every time you turn the wheel — and the timbre being
 * the real resonance of the real cylinders is the entire point of simulating one. Equal-power is
 * flat to four decimals at every angle. Turn this on to hear the difference.
 */
export let ENGINE_HRTF = 0

/*
 * THE FREE CAMERA. Rich, 2026-09-27: "can we make flying speed adjustable? Right now it feels too
 * fast, I'd like to be able to crank it down in the tuning panel."
 *
 * Flying speed is not one number, and the one people reach for first is not the one that matters.
 * The camera moves at `max(distanceToTarget, FLY_SPEED_FLOOR_M) × FLY_SPEED` metres a second: the
 * distance term is what lets a view from two kilometres up cross two kilometres, and the FLOOR is
 * what governs how it feels down at street level. At the floor's old fixed 40 m it was 32 m/s —
 * 72 mph — a foot off the kerb. Turn FLY_SPEED_FLOOR_M down to walk-ish, or FLY_SPEED down to
 * scale everything at once.
 */
/** Metres per second per metre of camera-to-target distance. The overall pace. */
export let FLY_SPEED = 0.8
/**
 * Below this distance the scaling stops, so this sets the speed near the ground.
 *
 * WAS 40, WHICH IS WHY IT FELT TOO FAST: 40 x 0.8 = 32 m/s, or 72 mph, a metre off the kerb
 * whatever the zoom said. At 12 it is 9.6 m/s near the ground and — measured, not assumed — it
 * changes nothing at all above 12 m, because the floor only binds when the camera is closer in
 * than this (probes/corridor-flyspeed.mjs asserts both halves).
 */
export let FLY_SPEED_FLOOR_M = 12
/** What Shift multiplies movement, lift, zoom and Q/E look by. */
export let FLY_SPRINT_X = 3
/** T/G, as a fraction of distance per second, with its own floor. */
export let FLY_LIFT = 0.6
export let FLY_LIFT_FLOOR_M = 60
/** R/F dolly, exponential: e^(FLY_ZOOM·dt) per second. */
export let FLY_ZOOM = 0.9
/** Q/E yaw about the camera, radians per second. */
export let FLY_LOOK = 1.2
/** On foot (B): metres per second, and what Shift does to it. */
export let WALK_SPEED = 3.2
export let WALK_SPRINT_X = 2

/** Gearbox. Ratios are first through sixth; a ratio of 0 takes that gear out of the box. */
export let ENGINE_GEAR_1 = 3.9
export let ENGINE_GEAR_2 = 2.35
export let ENGINE_GEAR_3 = 1.62
export let ENGINE_GEAR_4 = 1.24
export let ENGINE_GEAR_5 = 1.0
export let ENGINE_GEAR_6 = 0.82
export let ENGINE_FINAL_DRIVE = 3.45
/** Rolling radius, metres. car.ts spins the wheel meshes at 0.34, so they agree by default. */
export let ENGINE_TYRE_RADIUS = 0.34
export let ENGINE_IDLE_RPM = 850
export let ENGINE_REDLINE_RPM = 7000
export let ENGINE_SHIFT_UP_RPM = 6500
export let ENGINE_SHIFT_DOWN_RPM = 2200
/** How long the clutch is out. Too short and a gearchange is a blip; too long and it is a lull. */
export let ENGINE_SHIFT_SECONDS = 0.18

/** 1 = the knobs below drive the synthesizer; 0 = whatever the engine script asked for. */
export let ENGINE_VOICE_OVERRIDE = 0
export let ENGINE_VOLUME = 0.25
export let ENGINE_CONVOLUTION = 1
export let ENGINE_HF_GAIN = 0.01
export let ENGINE_HF_NOISE = 0.6
export let ENGINE_HF_CUTOFF = 10000
export let ENGINE_LF_NOISE = 1
export let ENGINE_LF_CUTOFF = 2000
export let ENGINE_LEVELER_TARGET = 30000
export let ENGINE_LEVELER_MAX_GAIN = 1.9
export let ENGINE_LEVELER_MIN_GAIN = 0.00001
/**
 * Physics steps per second. The first thing to turn down if the audio crackles — it costs more than
 * the exhaust convolution does. 0 leaves whatever the engine script asked for, which is usually
 * 10000 and sometimes 40000.
 */
export let ENGINE_SIM_HZ = 0

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
export let CAR_RECOVER_BACK = 9
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
// --- lazy grading (scene.ts gradeNear): how far around the eye the strips and buildings are built,
// how much of a frame each build may take, and how long a chunk of the primary strip is
export let STREAM_BUILD_M = 1500
export let STREAM_BUDGET_MS = 6
export let STREAM_CHUNK_M = 250
// trees (props.treesFromCanopy): a FIXED cell so density does not depend on how big the site is,
// the budget spent within TREE_PLANT_RADIUS_M of the eye, replanted when the eye leaves that
// centre by TREE_REPLANT_M
export let TREE_CELL_M = 6
/** canopy height that counts as a tree (m): the CHM's own threshold for "this is a crown" */
export let TREE_MIN_H = 3
/** multiplies every measured canopy height — the wood as it is, taller, or scrub */
export let TREE_HEIGHT_SCALE = 1
/** 1 = every candidate cell gets its tree; below that a stable hash thins them */
export let TREE_DENSITY = 1
// --- shape: multipliers over the ez-tree preset each archetype starts from (species.ts
// optionsFor). A change regrows the variants, which is ~100 ms, so the panel debounces it.
export let TREE_LEAF_COUNT = 1
export let TREE_LEAF_SIZE = 1
export let TREE_CROWN_SPREAD = 1
export let TREE_BRANCH_COUNT = 1
export let TREE_GNARLINESS = 1
export let TREE_TAPER = 1
export let TREE_TRUNK_RADIUS = 1
/**
 * Sections and segments per branch. 0 hides the models and leaves every tree as an impostor
 * card; it does not regrow or rebake. Above 0 it is the cost knob, and how round a trunk looks.
 */
export let TREE_DETAIL = 1
/** -1 = the site's own species mix; 0..n forces one archetype everywhere (see species.ts ARCHETYPES) */
export let TREE_SPECIES = -1
/** how many variants the palette may hold */
export let TREE_SPECIES_LIMIT = 6
export let TREE_PLANT_RADIUS_M = 1400
export let TREE_REPLANT_M = 350
/**
 * Milliseconds of crescent fill per frame. New trees are past the draw radius, so this can stay
 * small; the hitch it removes is the one that used to measure the whole ring in one frame.
 */
export let TREE_PLANT_BUDGET_MS = 3
/**
 * 1 = a replant keeps each tree in its slot and uploads only the cells that entered or left.
 * 0 = the old path: throw the list away and rewrite every impostor.
 */
export let TREE_PATCH = 1
/**
 * Metres past the plant radius to keep on the GPU but not draw. 0 = off.
 * A tree farther than plant + spare is evicted and its slot freed.
 */
export let TREE_SPARE_M = 600
/** impostor budget on a phone. The desktop budget stays 120k; this is what a coarse pointer gets. Reload to apply. */
export let MOBILE_TREE_BUDGET = 8000
// grass grows only where the tile photo reads as vegetation (vegmask.ts): how far around the eye
// the tile photos are classified, and the excess-green threshold (2G - R - B on 0..1 channels)
export let VEG_RADIUS_M = 700
export let VEG_EXG_MIN = 0.04
// an inferior road is re-graded to meet the superior one at a junction, fading out over this many metres
export let JUNCTION_MEET_M = 40
// --- time of day (sun.ts + main.ts applySky) ------------------------------------------------
/** simulated seconds per real second: 1 is a real day, 600 puts a whole day in four minutes, 0 stops the sun */
export let TIME_RATE = 1
/** stretches the sun's elevation about the horizon; 1 is the sky over this site as it really is */
export let SUN_ARC = 1
/** how many stars on a clear night, 0 … 1 */
/**
 * How a catalogue star is drawn. The sprite is only big enough for the core and its halo — a star
 * is an unresolvable point, and a wide sprite over a coarse profile is what makes stars read as
 * fuzzy squares rather than as points.
 */
export let STAR_PIXELS = 2.2
export let STAR_SIZE = 1
/** faintest magnitude drawn. 6.5 is the naked-eye limit on a dark night; 4 is a city. */
export let STAR_MAG_LIMIT = 6.5
export let SKY_STARS = 0.8
/** the Milky Way, 0 … 1. Dimmer than it looks in a photograph, because so is the real one. */
export let SKY_MILKYWAY = 0.5
/** the wispy high layer, 0 … 1; the cumulus layer is the weather's own cover */
export let SKY_CIRRUS = 0.3
/** moonlight at full moon, as a fraction of the sun's intensity */
export let MOON_LIGHT = 0.06
/** how hard the low sun paints the sky: 1 is what the air really does, higher is a postcard */
export let SUNSET_BOLD = 1
/** the light left at night with no moon, against the season's daytime ambient */
/**
 * The light left at night with no moon, against full day.
 *
 * It was 0.38, set when Rich reported the road and the car were pitch black. That was the wrong
 * remedy: 38 per cent of daylight at midnight makes the grass and the verge read as lit, which
 * is what he then saw glowing (2026-09-27). The right remedy is that the things you actually
 * navigate by at night are RETROREFLECTIVE and answer your headlights — see retro.ts — so the
 * ambient floor can go back down to something like a night.
 */
export let NIGHT_AMBIENT = 0.12
/** how hard the sky itself lights the world (scene.environment, built from the dome) */
export let SKY_LIGHT = 1
/** everything ambient, multiplied: the one knob for "I cannot see" */
export let AMBIENT_GAIN = 1
/**
 * A second sun, held at a low elevation on the real sun's bearing. A high sun on a flat road has
 * almost the same brightness everywhere, which is why the albedo and the height map only show up
 * at sunset and under the headlights. This one stays oblique, and it fades out once the real sun
 * is already low enough to do that job.
 */
export let RAKE = 1
/** how hard a normal map's tilt is added back on top of the ordinary lighting, on the road and the water */
export let RELIEF = 1.6
/**
 * How dark the sun's shadows are. 0 skips the shadow pass. 1 already pulls the unshadowed fill
 * down so a tree reads on the road; the range goes on up from there for a harder shade.
 */
export let SHADOW = 1
/** clearcoat on the cars: a view-dependent sheen and a tight sun highlight */
export let CAR_SHINE = 1
/**
 * Environment-map reflections on shiny surfaces (paint, glass, water). The sky is already an
 * environment map; this is how hard those surfaces mirror it. Rough roads stay diffuse.
 */
export let REFLECT = 1.8
/**
 * Screen-space reflections on the same shiny surfaces: a short march through the previous frame,
 * so a panel can pick up whatever is actually on screen. 0 leaves only the environment map.
 */
export let SSR = 1
/**
 * Screen height below which a reflection is ignored (0 is the bottom of the frame, 1 the top).
 * The march starts on this line and walks upward, so a roof picks up trees and sky instead of
 * the asphalt in front of the camera. Raise it until the road drops out of the reflection.
 */
export let SSR_BELT = 0.62
/** how much a closed canopy takes out of the sky light under it; 0 = the wood is as bright as the field */
export let CANOPY_SHADE = 0.75
/**
 * Headlights and tail lights at night, on the hero car and on traffic.
 *
 * The same numbers for every car. Tail lights are on this scale too, aimed back along the road
 * for `TAILLIGHT_RANGE` metres. `TAILLIGHT_ANGLE` is the half-angle of that wash; wide, so the
 * red light spreads across the lane instead of two tight cones.
 */
export let HEADLIGHT = 2.7
export let TAILLIGHT = 0.025
/** how far behind the car the red light reaches (m). Short, and aimed down, so it does not climb */
export let TAILLIGHT_RANGE = 2.5
/** tail-light half-angle, radians. Near π/2 the wash covers the whole road behind the bumper. */
export let TAILLIGHT_ANGLE = 1.4
export let HEADLIGHT_RANGE = 110
/** the beam's half-angle, radians — the retro cone is this widened, so the two stay linked */
export let HEADLIGHT_ANGLE = 0.46
/**
 * Retroreflection: how hard paint and sheeting throw your own headlights back at you.
 *
 * These are what make a dark road legible. Before them the markings were unlit and simply glowed
 * (Rich, 2026-09-27), which read as cyberpunk rather than as night.
 */
export let RETRO_MARKINGS = 2.6
export let RETRO_SIGNS = 2.6
/** the retro cone as a multiple of the beam's own angle: > 1 means the EDGE of the light answers */
export let RETRO_SPREAD = 1.4
/**
 * How hard the headlamps light things that draw through their OWN shaders — grass and the tree
 * impostor cards. Those never see three.js's lights, so before this the beam swept over the verge
 * and nothing happened (Rich, 2026-09-27).
 */
export let HEADLIGHT_BOUNCE = 1.8
// --- splat corridors (splats.ts, docs/corridor/PLAN-SPLAT-CORRIDORS.md) -----------------------
/** 0 turns the captured world off entirely and leaves the built one */
/** show the name of the road you are on while driving; 0 hides it */
export let HUD_ROAD_NAME = 1
/** ground elevation and compass heading alongside the speed and surface */
export let HUD_TELEMETRY = 1
export let SPLAT_ENABLED = 1
/**
 * How hard the BUILT world yields where a capture has taken over. 0 draws both on top of each
 * other; 1 hands the ground to the capture and dissolves the bake away across its edge.
 */
/*
 * How hard the BUILT world yields where a capture has taken over. 0 draws both on top of each
 * other; 1 hands the ground to the capture and dissolves the bake away across its edge.
 *
 * This was off by default for a while, because it appeared to break the site and I could not
 * reproduce it. Both halves of that turned out to be something else: the break was a backtick in
 * a GLSL comment taking the whole module down, and the crashes I kept hitting while investigating
 * were a 112 km2 lidar bake saturating the machine. `probes/corridor-splatseam.mjs` measures it
 * now -- inside a capture envelope it dissolves 83.6% of the frame at full strength and 41.9% at
 * half, and away from one it changes 0.0% -- so it is a crossfade rather than a switch, and it is
 * back on.
 */
export let SPLAT_WORLD_FADE = 1
/**
 * The seam raster's cell, metres.
 *
 * The envelope is a 25 m tube around a driven path with an 18 m fade on it, so 4 m resolves the
 * fade to about a fifth of its width and the bilinear read smooths what is left. Changing it
 * rebuilds the raster, which happens when a site loads.
 */
export let SPLAT_MASK_CELL_M = 4
/** load a tile once it is this close to the eye, drop it beyond SPLAT_KEEP_M */
export let SPLAT_LOAD_M = 400
export let SPLAT_KEEP_M = 700
/** how many megabytes of gaussians may be resident */
export let SPLAT_BUDGET_MB = 512
/**
 * Floor on how often Spark re-sorts its gaussians, in ms.
 *
 * Spark's default is 0 -- sort whenever it likes -- and on a real GPU with
 * ~2-3M gaussians resident that is a 60-80 ms stall every ~8 frames, with the
 * car stationary. Measured on Rich's machine at the Gosheff stance: the MEDIAN
 * frame time is identical with the capture on and off (16.6 vs 16.7 ms), so
 * drawing the gaussians is free; the whole cost is the periodic re-sort.
 *
 *   sort interval   p50     p90     p99
 *   0 (default)     16.6    59.1    81.5
 *   250 ms          16.8    23.0   100.2
 *
 * The visible cost of sorting less often is blend-order error while turning
 * quickly, which is much cheaper than a stutter you can feel.
 */
/* ---- stunt fixtures: holding a car to a loop ------------------------------------------------- */

/**
 * The assist that lets a car drive a loop at all, and the numbers behind it.
 *
 * A ray-cast vehicle feels the road along its own down axis, so it cannot climb a surface that has
 * stood up in front of it — it needs to be TURNED to face the track before it gets there, and
 * PULLED onto it once it is. Rich, 2026-09-29, through several rounds of this: the car stopped
 * dead, then drove through, then stopped dead again.
 *
 * These are knobs because the right values are a matter of feel at a given speed and I would rather
 * Rich swept them than took my guess. 0 on `STUNT_ASSIST` turns the whole thing off.
 */
export let STUNT_ASSIST = 1
/**
 * How hard the car is turned to match the track ahead, per kilogram.
 *
 * THE SCALE IT HAS TO WORK AT: a loop stands the road up in about twenty metres, which at 50 m/s is
 * four tenths of a second to rotate a quarter turn — four radians a second. A gentle correction
 * measured on a level car looks fine and turns it six degrees.
 */
export let STUNT_ALIGN = 40
/**
 * Extra gravity toward the track's surface, m/s² — what keeps the wheels loaded upside down.
 *
 * THE RIGHT VALUE IS ONE GRAVITY, and the arithmetic says so. What the assist has to supply is
 * whatever ordinary gravity is NOT pressing into the surface: on the flat, gravity does all of it
 * and the assist owes nothing; on a vertical wall gravity presses along the surface rather than
 * into it, so the assist owes a full g; upside down gravity is pulling the car OFF at a g, so the
 * assist owes two just to break even. `pullScale` is exactly that (1 − up.y), so this number is the
 * net press it buys — and one g of net press is a car sitting on a road.
 *
 * It was 25, which is two and a half g of press everywhere but the flat. The suspension bottoms
 * out, the body meets the track, and the solver spends every step shoving the car back out of a
 * surface the assist is shoving it into. Rich, 2026-09-29, halfway up the loop: *"weird friction
 * and the car got stuck partially pushed through the loop, like the loop was deformable."* It was
 * not deformable; it was being leant on.
 */
export let STUNT_PULL = 11
/** how many seconds ahead along the lane the car aims. More is earlier, and earlier is smoother */
export let STUNT_AHEAD_S = 1.1
/** full strength within this far of the lane, metres */
export let STUNT_HOLD_M = 6
/** and nothing at all beyond this */
export let STUNT_RELEASE_M = 14

export let SPLAT_SORT_MS = 500

/**
 * How far the camera may move, as a fraction of the distance to the nearest capture, before the
 * gaussian order is rebuilt.
 *
 * Rich, 2026-09-29, reading the performance panel: *"the splats sorting frequency seems to be
 * driving the stalls… I don't understand why the sort needs to be run at all, or at least as often
 * as it is."* Spark's own test for a changed view is a MILLIMETRE of movement or 2.6° of turn, so
 * in a car it re-sorted every frame and the interval was the only brake. Turning cannot change a
 * radial order at all.
 *
 * 0.02 means two metres of travel with the capture a hundred metres off, twenty centimetres when
 * you are parked in the middle of it.
 */
export let SPLAT_SORT_PARALLAX = 0.02
/** never re-sort more often than this much travel, metres */
export let SPLAT_SORT_MIN_M = 0.25
/** always re-sort at least this often, metres of travel, however far away the capture is */
export let SPLAT_SORT_MAX_M = 11
/**
 * How far the camera may TURN before the gaussians are re-sorted, degrees.
 *
 * A radial order does not depend on which way you face — but the set of splats that gets sorted
 * does, because the generate pass is frustum-bound. Turn round and the screen fills with gaussians
 * that were never in any ordering, which reads as distant trees drawn over near ones. Rich found it
 * with the timer set high, which is exactly when it shows.
 */
export let SPLAT_SORT_TURN_DEG = 90
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
/**
 * How much of the car's own up the chase camera takes on, 0…1.
 *
 * 1 rolls all the way round a loop with the car; 0 is the horizon-locked camera, which through a
 * loop leaves you looking at an upside-down car and steering the wrong way (Rich, 2026-09-29).
 */
export let CHASE_ROLL = 1
/** how quickly the camera's up follows the car's (1/s) — lower is a lazier, calmer roll */
export let CHASE_ROLL_LAG = 6

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
export let FURNITURE_SIGN_SCALE = 1.8 // the STOP / YIELD face, over MUTCD's 30"; "about twice as big" (Rich, 2026-09-26)
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
/**
 * How far to the RIGHT a sign post will look before it will accept the left (m).
 *
 * A stop sign belongs on the right of travel. 0 restores the old behaviour, where the nearest
 * clear spot on either side won and 31 % of Crofton's stop signs stood on the left.
 */
export let FURNITURE_SIGN_RIGHT_M = 12
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
/** the kerb lip's height (m) — a US kerb is about 150 mm */
export let SIDEWALK_KERB_H = 0.15
/** sidewalk width × this, and how far the concrete floats over the ground (m) */
export let SIDEWALK_WIDTH_SCALE = 1
export let SIDEWALK_LIFT = 0.02
/** how far either side to look for the asphalt, to decide which side the kerb goes on (m) */
export let SIDEWALK_KERB_PROBE = 2.5
/** no kerb where the nearest carriageway is further than this — that is a path, not a sidewalk (m) */
export let SIDEWALK_KERB_MAX_FROM_ROAD = 8
/** the lip ramps to nothing over this distance before a crossing: a dropped kerb (m) */
/**
 * How far a sidewalk may stray onto a carriageway before its concrete is dropped.
 *
 * Not zero: a walk beside a road the bake does not treat as kerbed already sits a metre or so
 * inside the drawn asphalt along its whole length, and dropping those too would lose real
 * pavement. This removes the indefensible part — concrete out over another road's travel lane.
 */
export let SIDEWALK_ROAD_CLEAR_M = 1.5
/** the same, for the walk's OWN road — wide, because a walk legitimately hugs its own shoulder */
export let SIDEWALK_OWN_CLEAR_M = 3
/**
 * Station spacing along a walk, metres.
 *
 * Also the granularity at which a piece of walk can be dropped, which is what actually sets it:
 * OSM's own vertices average about 9.5 m apart and sometimes 50, and removing a whole 50 m span to
 * take out a 12 m junction crossing costs far more pavement than it saves.
 */
export let SIDEWALK_STATION_M = 4
export let SIDEWALK_DROP_M = 3
/** a painted crossing bar's width and spacing along the crossing (m), and its float (m) */
export let SIDEWALK_BAR_W = 0.5
export let SIDEWALK_BAR_PITCH = 1.2
export let SIDEWALK_PAINT_LIFT = 0.025
/** the painted band's width across the crossing × this */
export let SIDEWALK_CROSSING_W = 1
/**
 * Linear furniture is cut into chunks this many metres across so frustum culling can fire. One
 * merged mesh per kind has a site-sized bounding sphere and is submitted in full from anywhere.
 */
export let FURNITURE_CHUNK_M = 900
/**
 * Signal timing, in seconds of green (Rich, 2026-09-22: "set the superior road with a 2 minute
 * interval and the inferior road with a 20 second interval. More than 4 way intersections should
 * just round robin").
 *
 * These override the bake's numbers at load, so the whole site retimes from the panel without a
 * re-export. SIGNAL_RATE multiplies wall-clock time: at 1 you wait the real two minutes, which is
 * correct and tedious to test against, so turn it up to watch a cycle.
 */
export let SIGNAL_GREEN_MAJOR = 120
export let SIGNAL_GREEN_MINOR = 20
/** every phase's green at a junction with more than two phase groups — the round robin */
export let SIGNAL_GREEN_RR = 25
export let SIGNAL_AMBER = 4
export let SIGNAL_ALL_RED = 2
export let SIGNAL_RATE = 1
/** the lit lens disc's radius (m); the dark lens it covers is 0.12 */
export let SIGNAL_LENS_R = 0.125
/** a stop bar's depth along the lane and its float over the asphalt (m) */
export let STOPBAR_DEPTH = 0.6
export let STOPBAR_LIFT = 0.05 // above the lane paint (asphalt +0.02, paint +0.04): at 0.025 the bars were under it and invisible from above
/** a bar further than this from a carriageway is not painted (m) */
export let STOPBAR_MAX_FROM_ROAD = 12
/** street name blades: post height, blade height, and the clear ground a corner post needs (m) */
export let BLADE_POST_H = 2.9
export let BLADE_H = 0.26
export let BLADE_CLEAR = 0.5
/** how far outward from the nominal corner a blade post may be walked to find clear ground (m) */
export let BLADE_WALK_M = 14
/**
 * The verge a BRANCH road's strip carries, each side (m). The primary gets 40 m; a residential
 * street in a subdivision whose neighbours are a hundred metres away does not, and giving it the
 * same both paved the grid twice over and cost 21.7 s of a 427-branch build.
 */
export let BRANCH_VERGE = 14

/**
 * The building dressing: the windows, doors, gutters and trim `buildings.ts` puts on the massing.
 *
 * DRESS_WINDOW_WALLS is the cost knob and it is not a small one. Glazing all four elevations of
 * crofton-triangle's 7506 footprints plans 138,532 windows; most of them are on the back of a
 * house with another house behind it. 3 spends the budget on the street and the two long
 * elevations. 0 on BUILDING_DRESSING gives the bare massing back. Both take effect on the cells
 * built after they change, so reload to redress the whole site.
 */
export let BUILDING_DRESSING = 1
export let DRESS_WINDOW_WALLS = 3

// --- physics (docs/corridor/PLAN-PHYSICS.md) ------------------------------------------------------
/**
 * Rapier, on or off.
 *
 * OFF BY DEFAULT and `machine` scope, for two reasons. Rapier's compat build inlines its wasm as
 * base64 — 4.3 MB — so turning it on is a download, not a flag; and while the car still runs on
 * `car.ts` there is nothing for the physics world to do but build ground. It becomes a `world` knob
 * when a level can legitimately require it.
 *
 * Changing it reloads nothing: the world is built with the site, so toggle it and reload.
 */
export let PHYS_ENABLED = 0
/** fixed steps per second. 120 matches what the hand-written car already ran at */
export let PHYS_HZ = 120
/** most steps one frame may run before the rest of the backlog is DROPPED rather than banked */
export let PHYS_MAX_STEPS = 12
/**
 * ms of a frame the fixed steps may take before the rest of the backlog is dropped.
 *
 * The cap on steps alone made SLOW MOTION: four 120 Hz steps are 33 ms of world per frame, and
 * at 12 fps (an 83 ms frame) the world ran at 40% speed — Rich straightened his car "in slow
 * motion". Now the steps run until the backlog is paid or this much of the frame has gone,
 * whichever first: a slow RENDER costs no world time, and a slow SOLVE degrades to slow motion
 * instead of a spiral where more steps make a slower frame make more steps.
 */
export let PHYS_STEP_BUDGET_MS = 10
/** Rapier's constraint solver iterations. 4 is its default; a vehicle likes more */
export let PHYS_ITERATIONS = 8
/** newtons: a contact pair quieter than this never reports an impact. A parked car rests silently */
export let PHYS_IMPACT_N = 30000
/**
 * A breakable that breaks under this (N·s) is SOFT: not solid until it breaks, so it gives way
 * to a car instead of stopping it. Rich, 2026-09-30, on the stop sign at the spawn: *"instead of
 * yeeting the sign, your car flies hundreds of feet through the air going end over end."* A
 * rigid post met the raked nose, the contact normal tilted up, and the solver put the whole of a
 * 40 m/s stop into the car before the post got the chance to break. Signs and posts are soft;
 * a signal mast (breaks at ~4000 N·s × its mass) is not.
 */
export let PHYS_SOFT_BREAK_NS = 5000
/** metres across one heightfield tile, and samples along its edge — TILE_M/CELLS is what a wheel feels */
export let PHYS_TILE_M = 64
export let PHYS_TILE_CELLS = 64
/** how many tiles may be BUILT in one frame. Each is CELLS² calls into the site's height function */
export let PHYS_TILE_BUDGET = 1
/** tiles are kept within this many metres of the eye */
export let PHYS_RADIUS_M = 180
/** the ground's friction coefficient before a profile's own grip is applied */
export let PHYS_GROUND_FRICTION = 1
/**
 * How high `groundUnder` starts its ray, metres.
 *
 * Absolute, because world Y here IS height above NAVD88 — the bake anchors the frame at h = 0. It
 * has to clear the highest site in `sites.json` with room to spare; South Mountain is the tall one.
 */
export let PHYS_RAY_FROM_M = 3000
/**
 * Which handling profile a car spawned by `physics.ts` starts on, as an INDEX into the engine's
 * five: 0 stunts, 1 taxi, 2 street, 3 rush, 4 sim.
 *
 * An index rather than a name because the tuning panel is numbers all the way down — `TuneKey` is a
 * number with a range, and a string knob would be the only one of its kind for the sake of one
 * field. `PHYS_PROFILE_ID` turns it back into a name.
 */
export let PHYS_PROFILE = 2
/**
 * Which model drives the player's car: 0 the hand-written one (`car.ts`), 1 Rapier (`rapiercar.ts`).
 *
 * Only has a choice when there is a physics world at all, so it needs `?phys=1` as well. Read when
 * drive mode is first entered, like `PHYS_ENABLED` and for the same reason — see `physProfileId`.
 */
export let PHYS_CAR = 0
/** 1 = trunks you can hit. The hand-written car has always collided with trees; so should this one */
export let PHYS_TREES = 1
/** how far from the player static props get colliders. Smaller than the ground's radius: trunks are dense */
export let PHYS_PROP_RADIUS_M = 90
/** the most trunks that may stand at once. Nearest first, so the budget goes where it can be hit */
export let PHYS_TREE_BUDGET = 300
/** 1 = signs, masts, poles, fences and houses are solid */
export let PHYS_PROPS = 1
/** the most prop colliders that may stand at once. Nearest first */
export let PHYS_PROP_BUDGET = 400
/** ceiling on the catalogue itself — memory, not a per-frame budget */
export let PHYS_PROP_CATALOGUE = 20000

export interface TuneTab {
  name: string
  sections: TuneSection[]
}

export const TUNE_TABS: TuneTab[] = [
  {
    name: 'environment',
    sections: [
      {
        title: 'season',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('SEASON', () => SEASON, (v) => (SEASON = v), [-1, 3], 1, '-1 use the selector; 0 winter 1 spring 2 summer 3 autumn'),
        ],
      },
      {
        title: 'stunt fixtures',
        collapsed: false,
        keys: [
          tune('STUNT_ASSIST', () => STUNT_ASSIST, (v) => (STUNT_ASSIST = v), [0, 1], 1, 'hold the car to a loop at all', { scope: 'world' }),
          tune('STUNT_ALIGN', () => STUNT_ALIGN, (v) => (STUNT_ALIGN = v), [0, 120], 5, 'how hard the car is turned to face the track ahead \u2014 a loop needs a quarter turn in about four tenths of a second'),
          tune('STUNT_PULL', () => STUNT_PULL, (v) => (STUNT_PULL = v), [0, 80], 2.5, 'extra gravity toward the track surface (m/s\u00b2). 9.81 is one g of net press \u2014 what a car on a road feels. Much more than that bottoms the suspension and pushes the body into the track'),
          tune('STUNT_AHEAD_S', () => STUNT_AHEAD_S, (v) => (STUNT_AHEAD_S = v), [0, 1.5], 0.05, 'how far along the lane the car reads the surface, in seconds of travel \u2014 a loop runs flat for forty metres before it stands up, so this has to be long enough to see past that'),
          tune('STUNT_HOLD_M', () => STUNT_HOLD_M, (v) => (STUNT_HOLD_M = v), [1, 30], 1, 'full assist within this far of the lane (m)'),
          tune('STUNT_RELEASE_M', () => STUNT_RELEASE_M, (v) => (STUNT_RELEASE_M = v), [2, 60], 1, 'no assist at all beyond this (m) \u2014 the fade between the two is what stops it snatching'),
        ],
      },
      {
        title: 'weather',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('WEATHER', () => WEATHER, (v) => (WEATHER = v), [0, 4], 1, '0 clear 1 rain 2 sleet 3 snow 4 ice'),
          tune('WEATHER_RATE', () => WEATHER_RATE, (v) => (WEATHER_RATE = v), [0, 4], 0.05, 'how much is falling'),
          tune('WEATHER_OPACITY', () => WEATHER_OPACITY, (v) => (WEATHER_OPACITY = v), [0, 2], 0.05),
          tune('WEATHER_WIND', () => WEATHER_WIND, (v) => (WEATHER_WIND = v), [0, 4], 0.05, 'sideways drift ×'),
          tune('WEATHER_BOX', () => WEATHER_BOX, (v) => (WEATHER_BOX = v), [0.3, 3], 0.05, 'the camera-following box ×'),
          tune('WEATHER_ACCUM', () => WEATHER_ACCUM, (v) => (WEATHER_ACCUM = v), [0, 1], 0.02, 'how much settles'),
          tune('WEATHER_SETTLE_RATE', () => WEATHER_SETTLE_RATE, (v) => (WEATHER_SETTLE_RATE = v), [0.005, 1], 0.005, 'settled per second'),
          tune('WEATHER_WET_RATE', () => WEATHER_WET_RATE, (v) => (WEATHER_WET_RATE = v), [0.05, 2], 0.05, 'how fast a surface soaks, per second'),
          tune('WEATHER_DRY_RATE', () => WEATHER_DRY_RATE, (v) => (WEATHER_DRY_RATE = v), [0.001, 0.2], 0.001, 'how slowly it dries after the rain stops — 0.006 is about three minutes'),
          tune('WET_ROUGHNESS', () => WET_ROUGHNESS, (v) => (WET_ROUGHNESS = v), [0.02, 1], 0.02, 'a soaked road\'s roughness: low is a mirror for the sky and the headlights'),
          tune('WET_DARKEN', () => WET_DARKEN, (v) => (WET_DARKEN = v), [0, 0.9], 0.05, 'how much water darkens what it soaks'),
          tune('WET_REFLECT', () => WET_REFLECT, (v) => (WET_REFLECT = v), [0, 4], 0.1, 'how hard a wet surface reflects the sky'),
          tune('WEATHER_MELT_RATE', () => WEATHER_MELT_RATE, (v) => (WEATHER_MELT_RATE = v), [0.01, 2], 0.01, 'melted per second'),
          tune('WEATHER_GRIP_SCALE', () => WEATHER_GRIP_SCALE, (v) => (WEATHER_GRIP_SCALE = v), [0.05, 1], 0.01, 'grip left — car.ts reads this'),
        ],
      },
      {
        title: 'time of day',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('TIME_RATE', () => TIME_RATE, (v) => (TIME_RATE = v), [0, 3600], 1, 'simulated seconds per real second: 1 real time, 600 a day in four minutes, 0 stops the sun'),
          tune('SUN_ARC', () => SUN_ARC, (v) => (SUN_ARC = v), [0.2, 3], 0.05, 'stretches the sun\'s arc about the horizon; 1 is this latitude as it really is'),
          tune('STAR_PIXELS', () => STAR_PIXELS, (v) => (STAR_PIXELS = v), [0.5, 8], 0.1, 'a star\u2019s sprite, in pixels at 900p', { scope: 'machine' }),
          tune('STAR_SIZE', () => STAR_SIZE, (v) => (STAR_SIZE = v), [0.3, 3], 0.05, 'all of them, scaled'),
          tune('STAR_MAG_LIMIT', () => STAR_MAG_LIMIT, (v) => (STAR_MAG_LIMIT = v), [1, 8], 0.1, 'faintest magnitude drawn \u2014 6.5 is a dark sky, 4 is a city'),
          tune('SKY_STARS', () => SKY_STARS, (v) => (SKY_STARS = v), [0, 1], 0.05, 'how many stars on a clear night'),
          tune('SKY_MILKYWAY', () => SKY_MILKYWAY, (v) => (SKY_MILKYWAY = v), [0, 2], 0.05, 'the Milky Way \u2014 the real isophotes, on the same sphere as the stars'),
          tune('SKY_CIRRUS', () => SKY_CIRRUS, (v) => (SKY_CIRRUS = v), [0, 1], 0.05, 'the wispy high layer'),
          tune('MOON_LIGHT', () => MOON_LIGHT, (v) => (MOON_LIGHT = v), [0, 0.3], 0.01, 'moonlight at full moon, against the sun'),
          tune('SUNSET_BOLD', () => SUNSET_BOLD, (v) => (SUNSET_BOLD = v), [0, 3], 0.05, 'how hard a low sun paints the sky; 1 is what the air really does'),
          tune('NIGHT_AMBIENT', () => NIGHT_AMBIENT, (v) => (NIGHT_AMBIENT = v), [0, 1], 0.02, 'the light left at night with no moon'),
          tune('SKY_LIGHT', () => SKY_LIGHT, (v) => (SKY_LIGHT = v), [0, 3], 0.05, 'how hard the sky itself lights the world (the dome, as an environment map)'),
          tune('AMBIENT_GAIN', () => AMBIENT_GAIN, (v) => (AMBIENT_GAIN = v), [0.1, 5], 0.05, 'everything ambient, multiplied — the one knob for "I cannot see"'),
        ],
      },
    ],
  },
  {
    name: 'visuals',
    sections: [
      {
        title: 'lighting',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('RAKE', () => RAKE, (v) => (RAKE = v), [0, 2], 0.05, 'a low fill on the sun\'s bearing, so road grain and water still read when the sun is overhead'),
          tune('RELIEF', () => RELIEF, (v) => (RELIEF = v), [0, 4], 0.05, 'how hard a normal map shows on the road and the water'),
          tune('CANOPY_SHADE', () => CANOPY_SHADE, (v) => (CANOPY_SHADE = v), [0, 1], 0.05, 'how much a closed canopy takes out of the sky light under it, allowing for leaf-off and evergreens'),
          tune('SHADOW', () => SHADOW, (v) => (SHADOW = v), [0, 4], 0.05, 'how dark sun shadows are, including on the road; 0 turns the shadow pass off'),
          tune('SHADOW_REACH', () => SHADOW_REACH, (v) => (SHADOW_REACH = v), [40, 280], 5, 'metres of shadow around the camera, and how far the card shadows reach. Larger softens the map'),
          tune('SHADOW_CARDS', () => SHADOW_CARDS, (v) => (SHADOW_CARDS = v), [0, 1], 1, 'impostor cards past the high-resolution trees cast a shadow. They do not cover the models'),
          tune('SHADOW_CANOPY', () => SHADOW_CANOPY, (v) => (SHADOW_CANOPY = v), [0, 1], 1, 'an invisible crown casts instead of the card, past the high-resolution trees. On, this replaces the cards'),
          tune('SHADOW_CANOPY_REACH', () => SHADOW_CANOPY_REACH, (v) => (SHADOW_CANOPY_REACH = v), [40, 1200], 10, 'how far the canopy shadows reach (m), starting where the high-resolution trees stop. Longer covers more of the road and softens the map while the canopy is on'),
          tune('SHADOW_CANOPY_SCALE', () => SHADOW_CANOPY_SCALE, (v) => (SHADOW_CANOPY_SCALE = v), [0.3, 1.8], 0.05, 'invisible crown size, as a fraction of the tree height'),
          tune('REFLECT', () => REFLECT, (v) => (REFLECT = v), [0, 4], 0.05, 'environment-map reflections on paint, glass and water'),
          tune('SSR', () => SSR, (v) => (SSR = v), [0, 2], 0.05, 'screen-space reflections on those same surfaces; 0 is the sky map only'),
          tune('SSR_BELT', () => SSR_BELT, (v) => (SSR_BELT = v), [0, 1], 0.01, 'reflection belt, as a fraction of the screen height; samples below it are ignored so a roof mirrors trees and sky instead of the road'),
          tune('CAR_SHINE', () => CAR_SHINE, (v) => (CAR_SHINE = v), [0, 3], 0.05, 'clearcoat on the cars'),
        ],
      },
      {
        title: 'headlights',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('HEADLIGHT', () => HEADLIGHT, (v) => (HEADLIGHT = v), [0, 8], 0.1, 'headlights at night, yours and the traffic'),
          tune('TAILLIGHT', () => TAILLIGHT, (v) => (TAILLIGHT = v), [0, 0.075], 0.001, 'tail lights. The mark is half the old setting; the top of the slider is three times that'),
          tune('TAILLIGHT_RANGE', () => TAILLIGHT_RANGE, (v) => (TAILLIGHT_RANGE = v), [1, 12], 0.5, 'how far the red light reaches behind the car (m). Aimed at the road, so it stays low'),
          tune('TAILLIGHT_ANGLE', () => TAILLIGHT_ANGLE, (v) => (TAILLIGHT_ANGLE = v), [0.15, 1.57], 0.02, 'tail-light half-angle (rad). 1.57 is a flat 180° wash out the back; the old cones were 0.22'),
          tune('HEADLIGHT_RANGE', () => HEADLIGHT_RANGE, (v) => (HEADLIGHT_RANGE = v), [10, 200], 5, 'how far down the road they reach (m)'),
          tune('HEADLIGHT_ANGLE', () => HEADLIGHT_ANGLE, (v) => (HEADLIGHT_ANGLE = v), [0.1, 1.2], 0.02, 'the beam\u2019s half-angle (rad); the retro cone is this widened'),
          tune('RETRO_MARKINGS', () => RETRO_MARKINGS, (v) => (RETRO_MARKINGS = v), [0, 6], 0.1, 'how hard road paint throws your headlights back'),
          tune('RETRO_SIGNS', () => RETRO_SIGNS, (v) => (RETRO_SIGNS = v), [0, 6], 0.1, 'how hard sign sheeting throws your headlights back'),
          tune('RETRO_SPREAD', () => RETRO_SPREAD, (v) => (RETRO_SPREAD = v), [1, 3], 0.05, 'retro cone as a multiple of the beam angle \u2014 above 1, the edge of the light lights things up'),
          tune('HEADLIGHT_BOUNCE', () => HEADLIGHT_BOUNCE, (v) => (HEADLIGHT_BOUNCE = v), [0, 4], 0.1, 'how hard the beam lights grass and tree cards'),
        ],
      },
      {
        title: 'captures (gaussian splats)',
        collapsed: false,
        keys: [
          tune('SPLAT_ENABLED', () => SPLAT_ENABLED, (v) => (SPLAT_ENABLED = v), [0, 1], 1, 'draw the captured world at all', { scope: 'world' }),
          tune('SPLAT_WORLD_FADE', () => SPLAT_WORLD_FADE, (v) => (SPLAT_WORLD_FADE = v), [0, 1], 0.05, 'how hard the BUILT world dissolves where a capture takes over', { scope: 'world' }),
          tune('SPLAT_MASK_CELL_M', () => SPLAT_MASK_CELL_M, (v) => (SPLAT_MASK_CELL_M = v), [1, 20], 1, 'the seam raster\u2019s cell (m) \u2014 reload to rebuild'),
          tune('SPLAT_LOAD_M', () => SPLAT_LOAD_M, (v) => (SPLAT_LOAD_M = v), [50, 2000], 25, 'load a tile once it is this close (m)'),
          tune('SPLAT_KEEP_M', () => SPLAT_KEEP_M, (v) => (SPLAT_KEEP_M = v), [100, 4000], 25, 'drop it beyond this (m)'),
          tune('SPLAT_BUDGET_MB', () => SPLAT_BUDGET_MB, (v) => (SPLAT_BUDGET_MB = v), [64, 2048], 32, 'megabytes of gaussians that may be resident'),
          tune('SPLAT_SORT_MS', () => SPLAT_SORT_MS, (v) => (SPLAT_SORT_MS = v), [0, 5000], 50, 'the least time between re-sorts of the gaussians (ms). At speed this is the only thing deciding, so it is the knob to reach for when it stutters \u2014 0 is Spark\u2019s own default and stalls constantly'),
          /*
           * THE THREE THAT DECIDE WHEN A RE-SORT IS ASKED FOR AT ALL. The timer above is only a
           * floor; these are the rule. A sort costs a GPU depth pass, a ~10 MB readback and a
           * ~10 MB texture upload, so the question "does the order actually need rebuilding" is
           * worth asking properly — see `splatsort.ts`.
           */
          tune('SPLAT_SORT_PARALLAX', () => SPLAT_SORT_PARALLAX, (v) => (SPLAT_SORT_PARALLAX = v), [0.002, 1], 0.002, 'how far the camera may move before the gaussians are re-sorted, as a fraction of the distance to the nearest capture'),
          tune('SPLAT_SORT_MIN_M', () => SPLAT_SORT_MIN_M, (v) => (SPLAT_SORT_MIN_M = v), [0.05, 200], 0.05, 'never re-sort more often than this much travel (m) \u2014 the floor for a capture you are standing in'),
          /*
           * THE CEILING IS IN THE THOUSANDS, and it has to be. A 60 m cap was never reached: at
           * 180 mph you cover 400 m between sorts on a 5 s timer, so the distance gate was always
           * satisfied and could never skip anything. To be a brake at speed at all it has to be
           * settable well past how far the car travels between sorts. Rich, 2026-09-29: *"max m
           * needs to have the range cranked way up too."*
           */
          tune('SPLAT_SORT_TURN_DEG', () => SPLAT_SORT_TURN_DEG, (v) => (SPLAT_SORT_TURN_DEG = v), [10, 180], 5, 'turn this far and the gaussians are re-sorted, whatever the distance rule says \u2014 what was behind you was never in the ordering'),
          tune('SPLAT_SORT_MAX_M', () => SPLAT_SORT_MAX_M, (v) => (SPLAT_SORT_MAX_M = v), [1, 4000], 10, 'always re-sort at least this often (m of travel), however far away the capture is \u2014 push it up to stop re-sorting on distance at all'),
        ],
      },
    ],
  },
  {
    name: 'ground',
    sections: [
      {
        title: 'density',
        scope: 'world',
        keys: [
          tune('GRASS_MOWN_PER_M2', () => GRASS_MOWN_PER_M2, (v) => (GRASS_MOWN_PER_M2 = v), [0, 120], 1, 'blades/m² inside the mow line'),
          tune('GRASS_ROUGH_PER_M2', () => GRASS_ROUGH_PER_M2, (v) => (GRASS_ROUGH_PER_M2 = v), [0, 80], 1, 'blades/m² beyond it'),
          tune('GRASS_HEIGHT_SCALE', () => GRASS_HEIGHT_SCALE, (v) => (GRASS_HEIGHT_SCALE = v), [0.2, 3], 0.05),
          tune('GRASS_WIDTH_SCALE', () => GRASS_WIDTH_SCALE, (v) => (GRASS_WIDTH_SCALE = v), [0.3, 3], 0.05),
        ],
      },
      {
        title: 'placement',
        scope: 'world',
        keys: [
          tune('GRASS_MOW_LINE', () => GRASS_MOW_LINE, (v) => (GRASS_MOW_LINE = v), [0, 30], 0.5, 'mown strip width from the pavement edge (m)'),
          tune('GRASS_MAX_FROM_ROAD', () => GRASS_MAX_FROM_ROAD, (v) => (GRASS_MAX_FROM_ROAD = v), [10, 200], 1),
          tune('GRASS_PATCHINESS', () => GRASS_PATCHINESS, (v) => (GRASS_PATCHINESS = v), [0, 0.7], 0.01, 'share of patches left bare'),
          tune('GRASS_PATCH_SIZE', () => GRASS_PATCH_SIZE, (v) => (GRASS_PATCH_SIZE = v), [1, 30], 1, 'bare patch size (m)'),
          tune('GRASS_SCATTER', () => GRASS_SCATTER, (v) => (GRASS_SCATTER = v), [0.1, 2], 0.05, 'blade scatter around the clump (m)'),
          tune('EDGE_BAND_M', () => EDGE_BAND_M, (v) => (EDGE_BAND_M = v), [2.5, 8], 0.1, 'half the along-track band of a road station (m); must exceed half the 5 m spacing'),
          tune('GRASS_EXACT_M', () => GRASS_EXACT_M, (v) => (GRASS_EXACT_M = v), [0, 12], 0.5, 'within this of pavement a blade asks the field directly instead of stepping along the gradient (m)'),
          tune('GRASS_MASK_CHECK_M', () => GRASS_MASK_CHECK_M, (v) => (GRASS_MASK_CHECK_M = v), [0, 40], 1, 'check each blade against the parking/walk/paving masks within this of a road (m)'),
          tune('GRASS_SLOPE_MAX', () => GRASS_SLOPE_MAX, (v) => (GRASS_SLOPE_MAX = v), [0.1, 3], 0.05, 'no turf steeper than this (m/m)'),
          tune('GRASS_MAX_SHELF', () => GRASS_MAX_SHELF, (v) => (GRASS_MAX_SHELF = v), [0, 8], 0.1, 'no turf this far above the bare DEM (m); 0 = off'),
        ],
      },
      {
        title: 'blades',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('GRASS_CARDS', () => GRASS_CARDS, (v) => (GRASS_CARDS = v), [0, 1], 1, '0 = dynamic blades up close, 1 = the static cards at every distance'),
          tune('GRASS_MOWN_HEIGHT', () => GRASS_MOWN_HEIGHT, (v) => (GRASS_MOWN_HEIGHT = v), [0.05, 1], 0.01, 'm'),
          tune('GRASS_ROUGH_HEIGHT', () => GRASS_ROUGH_HEIGHT, (v) => (GRASS_ROUGH_HEIGHT = v), [0.2, 4], 0.05, 'm before the season multiplier'),
          tune('GRASS_LEAN', () => GRASS_LEAN, (v) => (GRASS_LEAN = v), [0, 1.5], 0.05),
          tune('GRASS_WIND', () => GRASS_WIND, (v) => (GRASS_WIND = v), [0, 3], 0.05),
        ],
      },
      {
        title: 'colour (over the season)',
        scope: 'world',
        keys: [
          tune('GRASS_HUE', () => GRASS_HUE, (v) => (GRASS_HUE = v), [-60, 60], 1, 'degrees'),
          tune('GRASS_SAT', () => GRASS_SAT, (v) => (GRASS_SAT = v), [0, 2], 0.02),
          tune('GRASS_LIGHT', () => GRASS_LIGHT, (v) => (GRASS_LIGHT = v), [0.3, 2], 0.02),
          tune('GRASS_DRY_ADD', () => GRASS_DRY_ADD, (v) => (GRASS_DRY_ADD = v), [-1, 1], 0.02, 'straw on top of the season'),
          tune('GRASS_WIND_STILL_BELOW', () => GRASS_WIND_STILL_BELOW, (v) => (GRASS_WIND_STILL_BELOW = v), [0, 40], 0.5, 'with blades on: above this speed (m/s) the cards replace them. 0 keeps the blades on'),
          tune('GRASS_TYPE', () => GRASS_TYPE, (v) => (GRASS_TYPE = v), [-1, 6], 1, '-1 from the bake (LANDFIRE ground class); 0 common 1 wheat 2 bermuda 3 coastal 4 annual 5 meadow 6 heath'),
        ],
      },
      {
        title: 'cards',
        keys: [
          tune('GRASS_SPRITE_RADIUS', () => GRASS_SPRITE_RADIUS, (v) => (GRASS_SPRITE_RADIUS = v), [20, 1500], 10, 'clump cards out to here (m). The blades/cards switch is GRASS_CARDS, in blades'),
          tune('GRASS_SPRITE_PER_M2', () => GRASS_SPRITE_PER_M2, (v) => (GRASS_SPRITE_PER_M2 = v), [0, 4], 0.05, 'cards/m² at 40 blades/m² and a ~0.6 m clump; the mown and rough density knobs, and a shorter clump, scale this up'),
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
        title: 'crops',
        scope: 'world',
        keys: [
          tune('CROP_AUTO_FARMLAND', () => CROP_AUTO_FARMLAND, (v) => (CROP_AUTO_FARMLAND = v), [0, 1], 1, 'grow crops on OSM farmland too, not only authored areas'),
          tune('CROP_ROW_SCALE', () => CROP_ROW_SCALE, (v) => (CROP_ROW_SCALE = v), [0.3, 4], 0.05, 'row spacing ×'),
          tune('CROP_SEGMENT_M', () => CROP_SEGMENT_M, (v) => (CROP_SEGMENT_M = v), [1, 20], 0.5, 'm of row per segment'),
          tune('CROP_TEXTURE_M', () => CROP_TEXTURE_M, (v) => (CROP_TEXTURE_M = v), [0.5, 8], 0.1, 'm of row per texture repeat'),
          tune('CROP_MIN_FROM_ROAD', () => CROP_MIN_FROM_ROAD, (v) => (CROP_MIN_FROM_ROAD = v), [0, 20], 0.5, 'm clear of the pavement'),
          tune('CROP_WIND', () => CROP_WIND, (v) => (CROP_WIND = v), [0, 3], 0.05),
          tune('CROP_GLOW', () => CROP_GLOW, (v) => (CROP_GLOW = v), [0, 1], 1, '1 = fields stay bright at night; 0 = the same day and night light as the grass'),
        ],
      },
    ],
  },
  {
    name: 'trees',
    sections: [
      {
        title: 'near field (models in front, cards beyond)',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('TREE_NEAR_RADIUS', () => TREE_NEAR_RADIUS, (v) => (TREE_NEAR_RADIUS = v), [30, 600], 5, 'the impostor line, in metres. High-resolution trees inside it, cards past it'),
          tune('TREE_FADE_M', () => TREE_FADE_M, (v) => (TREE_FADE_M = v), [0, 120], 1, 'metres where the card dissolves off the model. 0 is a hard line'),
          tune('TREE_CONE_DEG', () => TREE_CONE_DEG, (v) => (TREE_CONE_DEG = v), [20, 180], 5, 'cone angle: degrees either side of the view that stay high resolution. 180 is a full circle'),
          tune('TREE_CONE_PENALTY', () => TREE_CONE_PENALTY, (v) => (TREE_CONE_PENALTY = v), [0, 10], 0.25, 'how hard that cone cuts. Higher sends trees outside the angle back to cards'),
          tune('TREE_NEAR_CAPACITY', () => TREE_NEAR_CAPACITY, (v) => (TREE_NEAR_CAPACITY = v), [10, 500], 5, 'models per species. In a thick wood this, not the radius, is what ends the high-res line'),
          tune('IMPOSTOR_LIGHT', () => IMPOSTOR_LIGHT, (v) => (IMPOSTOR_LIGHT = v), [0, 6], 0.05, 'brightness of the far tree cards'),
          tune('IMPOSTOR_COLOR', () => IMPOSTOR_COLOR, (v) => (IMPOSTOR_COLOR = v), [0, 3], 0.05, 'saturation of the far tree cards. 1 is the bake, 0 is grey, above 1 pushes the colour'),
          tune('IMPOSTOR_HUE', () => IMPOSTOR_HUE, (v) => (IMPOSTOR_HUE = v), [-60, 60], 1, 'hue of the far tree cards, degrees'),
        ],
      },
      {
        title: 'planting (replants around the eye)',
        scope: 'world',
        keys: [
          tune('TREE_CELL_M', () => TREE_CELL_M, (v) => (TREE_CELL_M = v), [3, 24], 0.5, 'metres between candidate trees — the density, and it no longer depends on how big the site is'),
          tune('TREE_MIN_H', () => TREE_MIN_H, (v) => (TREE_MIN_H = v), [1, 14], 0.5, 'canopy height (m) that counts as a tree; lower plants the scrub the CHM sees'),
          tune('TREE_HEIGHT_SCALE', () => TREE_HEIGHT_SCALE, (v) => (TREE_HEIGHT_SCALE = v), [0.3, 2.5], 0.05, 'multiplies every measured height'),
          tune('TREE_DENSITY', () => TREE_DENSITY, (v) => (TREE_DENSITY = v), [0.05, 1], 0.05, '1 = every candidate; below that a stable hash thins them'),
          tune('TREE_PLANT_RADIUS_M', () => TREE_PLANT_RADIUS_M, (v) => (TREE_PLANT_RADIUS_M = v), [200, 3000], 50, 'how far around the eye cards are drawn'),
          tune('TREE_REPLANT_M', () => TREE_REPLANT_M, (v) => (TREE_REPLANT_M = v), [50, 1200], 25, 'replant once the eye is this far from where it last planted'),
          tune('TREE_PLANT_BUDGET_MS', () => TREE_PLANT_BUDGET_MS, (v) => (TREE_PLANT_BUDGET_MS = v), [0.5, 12], 0.5, 'ms per frame spent measuring trees that just entered the ring'),
          tune('TREE_PATCH', () => TREE_PATCH, (v) => (TREE_PATCH = v), [0, 1], 1, '1 = upload only the trees that entered or left; 0 = rewrite every card'),
          tune('TREE_SPARE_M', () => TREE_SPARE_M, (v) => (TREE_SPARE_M = v), [0, 2000], 50, 'metres past the plant radius kept on the GPU but not drawn. 0 = off. Farther than this, the slot is freed'),
          tune('MOBILE_TREE_BUDGET', () => MOBILE_TREE_BUDGET, (v) => (MOBILE_TREE_BUDGET = v), [400, 40000], 200, 'how many trees a phone plants. Reload to apply — the buffer is sized once'),
        ],
      },
      {
        title: 'shape (regrows the species models)',
        scope: 'world',
        keys: [
          tune('TREE_LEAF_COUNT', () => TREE_LEAF_COUNT, (v) => (TREE_LEAF_COUNT = v), [0.15, 3], 0.05, 'leaves per tree, over the preset'),
          tune('TREE_LEAF_SIZE', () => TREE_LEAF_SIZE, (v) => (TREE_LEAF_SIZE = v), [0.3, 3], 0.05, 'leaf billboard size'),
          tune('TREE_CROWN_SPREAD', () => TREE_CROWN_SPREAD, (v) => (TREE_CROWN_SPREAD = v), [0.3, 2.5], 0.05, 'branch length away from the trunk — a columnar tree or a spreading one'),
          tune('TREE_BRANCH_COUNT', () => TREE_BRANCH_COUNT, (v) => (TREE_BRANCH_COUNT = v), [0.2, 3], 0.05, 'children per branch level'),
          tune('TREE_GNARLINESS', () => TREE_GNARLINESS, (v) => (TREE_GNARLINESS = v), [0, 4], 0.05, 'how much a branch wanders as it grows'),
          tune('TREE_TAPER', () => TREE_TAPER, (v) => (TREE_TAPER = v), [0.3, 1.4], 0.02, 'how fast a branch thins along its length'),
          tune('TREE_TRUNK_RADIUS', () => TREE_TRUNK_RADIUS, (v) => (TREE_TRUNK_RADIUS = v), [0.3, 3], 0.05, 'trunk thickness'),
          tune('TREE_DETAIL', () => TREE_DETAIL, (v) => (TREE_DETAIL = v), [0, 2], 0.05, '0 = impostor cards only, no 3D trees. Above that, sections and segments per branch'),
        ],
      },
      {
        title: 'palette',
        scope: 'world',
        keys: [
          tune('TREE_SPECIES', () => TREE_SPECIES, (v) => (TREE_SPECIES = v), [-1, 20], 1, '-1 the site\'s own mix; 0+ forces one archetype everywhere (species.ts ARCHETYPES, in order)'),
          tune('TREE_SPECIES_LIMIT', () => TREE_SPECIES_LIMIT, (v) => (TREE_SPECIES_LIMIT = v), [1, 8], 1, 'how many species models the palette may hold'),
        ],
      },
    ],
  },
  {
    name: 'lod',
    sections: [
      {
        title: 'grass',
        keys: [
          tune('GRASS_RADIUS', () => GRASS_RADIUS, (v) => (GRASS_RADIUS = v), [10, 120], 1, 'no blades beyond this (m)'),
          tune('GRASS_LOD_NEAR', () => GRASS_LOD_NEAR, (v) => (GRASS_LOD_NEAR = v), [2, 60], 1, 'full density inside (m)'),
          tune('GRASS_LOD_MID', () => GRASS_LOD_MID, (v) => (GRASS_LOD_MID = v), [4, 100], 1, 'mid density inside (m)'),
          tune('GRASS_LOD_MID_DENSITY', () => GRASS_LOD_MID_DENSITY, (v) => (GRASS_LOD_MID_DENSITY = v), [0, 1], 0.05),
          tune('GRASS_LOD_FAR_DENSITY', () => GRASS_LOD_FAR_DENSITY, (v) => (GRASS_LOD_FAR_DENSITY = v), [0, 1], 0.05),
        ],
      },
      {
        title: 'trees',
        keys: [
          tune('TREE_LEAF_LOD_M', () => TREE_LEAF_LOD_M, (v) => (TREE_LEAF_LOD_M = v), [0, 400], 5, 'beyond this a near tree wears the cheap far canopy (m)'),
          tune('TREE_FAR_LEAF_SHARE', () => TREE_FAR_LEAF_SHARE, (v) => (TREE_FAR_LEAF_SHARE = v), [0.05, 1], 0.05, 'far canopy: share of the leaves (rebuild)'),
          tune('TREE_FAR_LEAF_SIZE', () => TREE_FAR_LEAF_SIZE, (v) => (TREE_FAR_LEAF_SIZE = v), [1, 4], 0.1, 'far canopy: leaf size multiplier (rebuild)'),
          tune('TREE_REFRESH_TURN', () => TREE_REFRESH_TURN, (v) => (TREE_REFRESH_TURN = v), [0.05, 1.5], 0.01, 'refill the near set after turning this far (rad)'),
          tune('TREE_SIMPLE', () => TREE_SIMPLE, (v) => (TREE_SIMPLE = v), [0, 1], 1, '1 = impostor cards everywhere — no procedural models at all'),
          tune('TREE_LOLLIPOP', () => TREE_LOLLIPOP, (v) => (TREE_LOLLIPOP = v), [0, 1], 1, '1 = the editor’s lollipop trees instead of models and cards'),
          tune('IMPOSTOR_FLAT_PITCH', () => IMPOSTOR_FLAT_PITCH, (v) => (IMPOSTOR_FLAT_PITCH = v), [0.2, 1.5], 0.02, 'cards lie flat above this view pitch (rad)'),
        ],
      },
    ],
  },
  {
    name: 'world',
    sections: [
      {
        title: 'traffic',
        keys: [
          tune('TRAFFIC_MAX', () => TRAFFIC_MAX, (v) => (TRAFFIC_MAX = v), [0, 2000], 10, 'cap on traffic cars (reload the level)'),
          tune('TRAFFIC_WAKE_NS', () => TRAFFIC_WAKE_NS, (v) => (TRAFFIC_WAKE_NS = v), [200, 20000], 100, 'a hit harder than this (N·s) knocks a traffic car loose'),
          tune('MISSILE_SPEED', () => MISSILE_SPEED, (v) => (MISSILE_SPEED = v), [20, 300], 5, 'm/s, plus the car’s own'),
          tune('MISSILE_RADIUS', () => MISSILE_RADIUS, (v) => (MISSILE_RADIUS = v), [2, 30], 0.5, 'blast radius, m'),
          tune('MISSILE_IMPULSE', () => MISSILE_IMPULSE, (v) => (MISSILE_IMPULSE = v), [1, 80], 1, 'm/s a car at the centre of the blast is given'),
          tune('MISSILE_LIFT', () => MISSILE_LIFT, (v) => (MISSILE_LIFT = v), [0, 3], 0.05, 'how much of the throw points up'),
          tune('GUN_RATE', () => GUN_RATE, (v) => (GUN_RATE = v), [2, 40], 1, 'rounds per second'),
          tune('GUN_RANGE', () => GUN_RANGE, (v) => (GUN_RANGE = v), [30, 400], 10, 'm'),
          tune('GUN_IMPULSE', () => GUN_IMPULSE, (v) => (GUN_IMPULSE = v), [0.5, 30], 0.5, 'm/s a car is given per round'),
          tune('GUN_SPREAD', () => GUN_SPREAD, (v) => (GUN_SPREAD = v), [0, 0.1], 0.005),
          tune('TRAFFIC_DRAW_M', () => TRAFFIC_DRAW_M, (v) => (TRAFFIC_DRAW_M = v), [100, 3000], 50, 'traffic further than this is simulated, not drawn'),
          tune('TRAFFIC_PHYS_M', () => TRAFFIC_PHYS_M, (v) => (TRAFFIC_PHYS_M = v), [50, 1000], 10, 'traffic further than this has no body in the solver'),
          tune('TRAFFIC_RESPAWN_M', () => TRAFFIC_RESPAWN_M, (v) => (TRAFFIC_RESPAWN_M = v), [50, 1000], 10, 'a car that ran off its road comes back at least this far away'),
          tune('TRAFFIC_WRECKS_MAX', () => TRAFFIC_WRECKS_MAX, (v) => (TRAFFIC_WRECKS_MAX = v), [1, 400], 1, 'loose wrecks at once; the oldest is recycled into traffic'),
        ],
      },
      {
        title: 'buildings (reload to redress)',
        scope: 'world',
        keys: [
          tune('BUILDING_DRESSING', () => BUILDING_DRESSING, (v) => (BUILDING_DRESSING = v), [0, 1], 1, 'windows, doors, gutters and trim on the generated massing'),
          tune('DRESS_WINDOW_WALLS', () => DRESS_WINDOW_WALLS, (v) => (DRESS_WINDOW_WALLS = v), [1, 4], 1, 'how many elevations get glass: the street\u2019s first, then the longest'),
        ],
      },
      {
        title: 'cross-section (road and strip rebuild live)',
        scope: 'world',
        keys: [
          tune('LANE_WIDTH', () => LANE_WIDTH, (v) => (LANE_WIDTH = v), [2.5, 4.5], 0.01),
          tune('CULDESAC_RADIUS', () => CULDESAC_RADIUS, (v) => (CULDESAC_RADIUS = v), [0, 20], 0.5, 'turning bulb at a dead end (m); 0 = none'),
          tune('JUNCTION_CLEAR', () => JUNCTION_CLEAR, (v) => (JUNCTION_CLEAR = v), [0, 30], 0.5, 'bare asphalt radius at a junction (m)'),
          tune('SHOULDER_OUT', () => SHOULDER_OUT, (v) => (SHOULDER_OUT = v), [0, 5], 0.1),
          tune('KERB_GUTTER', () => KERB_GUTTER, (v) => (KERB_GUTTER = v), [0, 1.5], 0.05, 'a kerbed street: gutter past the lane instead of a shoulder (m)'),
          tune('SHOULDER_IN', () => SHOULDER_IN, (v) => (SHOULDER_IN = v), [0, 5], 0.1),
          tune('ROAD_BLEND_M', () => ROAD_BLEND_M, (v) => (ROAD_BLEND_M = v), [0, 2], 0.05, 'transition strip where the surface class changes (m); 0 = hard joint'),
          tune('ROAD_TAPER_M', () => ROAD_TAPER_M, (v) => (ROAD_TAPER_M = v), [0, 200], 5, 'length a lane-count change is ramped over (m); 0 = a step'),
          tune('ROAD_ONEWAY_CENTRE', () => ROAD_ONEWAY_CENTRE, (v) => (ROAD_ONEWAY_CENTRE = v), [0, 1], 1, '0 = lanes centred on the spine (OSM truth), 1 = asphalt centred (old)'),
        ],
      },
      {
        title: 'rock (cut faces and outcrops; reload to rebuild)',
        scope: 'world',
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
        scope: 'world',
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
        scope: 'world',
        keys: [
          tune('FURNITURE_SIGNAL_HEIGHT', () => FURNITURE_SIGNAL_HEIGHT, (v) => (FURNITURE_SIGNAL_HEIGHT = v), [3, 12], 0.1, 'mast pole height (m)'),
          tune('FURNITURE_SIGNAL_ARM_SCALE', () => FURNITURE_SIGNAL_ARM_SCALE, (v) => (FURNITURE_SIGNAL_ARM_SCALE = v), [0.4, 2.5], 0.05, 'arm reach ×'),
          tune('FURNITURE_SIGNAL_LIT', () => FURNITURE_SIGNAL_LIT, (v) => (FURNITURE_SIGNAL_LIT = v), [0, 1], 1, '1 lights a lens; there is no controller'),
          tune('FURNITURE_SIGN_HEIGHT', () => FURNITURE_SIGN_HEIGHT, (v) => (FURNITURE_SIGN_HEIGHT = v), [1, 4], 0.05, 'sign post height (m)'),
          tune('FURNITURE_KERB_CLEAR', () => FURNITURE_KERB_CLEAR, (v) => (FURNITURE_KERB_CLEAR = v), [0, 4], 0.1, 'm clear of the asphalt a post needs'),
          tune('FURNITURE_KERB_MAX', () => FURNITURE_KERB_MAX, (v) => (FURNITURE_KERB_MAX = v), [2, 40], 1, 'm it may be walked sideways to find it'),
          tune('FURNITURE_MAX_FROM_ROAD', () => FURNITURE_MAX_FROM_ROAD, (v) => (FURNITURE_MAX_FROM_ROAD = v), [2, 400], 2, 'm from a drawn road, or it is not placed'),
          tune('FURNITURE_SETBACK_MAX', () => FURNITURE_SETBACK_MAX, (v) => (FURNITURE_SETBACK_MAX = v), [0, 40], 1, 'm back along the approach, out of the junction box'),
          tune('FURNITURE_SIGN_RIGHT_M', () => FURNITURE_SIGN_RIGHT_M, (v) => (FURNITURE_SIGN_RIGHT_M = v), [0, 30], 1, 'm right a sign looks before accepting the left'),
          tune('FURNITURE_ARM_MAX', () => FURNITURE_ARM_MAX, (v) => (FURNITURE_ARM_MAX = v), [4, 30], 0.5, 'm of arm before the mast is dropped instead'),
        ],
      },
      {
        title: 'parking',
        scope: 'world',
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
      {
        title: 'sidewalks',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('SIDEWALK_KERB_H', () => SIDEWALK_KERB_H, (v) => (SIDEWALK_KERB_H = v), [0, 0.5], 0.01, 'kerb lip (m)'),
          tune('SIDEWALK_WIDTH_SCALE', () => SIDEWALK_WIDTH_SCALE, (v) => (SIDEWALK_WIDTH_SCALE = v), [0.4, 3], 0.05, 'width ×'),
          tune('SIDEWALK_LIFT', () => SIDEWALK_LIFT, (v) => (SIDEWALK_LIFT = v), [0, 0.3], 0.005, 'concrete over ground (m)'),
          tune('SIDEWALK_KERB_PROBE', () => SIDEWALK_KERB_PROBE, (v) => (SIDEWALK_KERB_PROBE = v), [0.5, 8], 0.25, 'm either side, to find which side the road is'),
          tune('SIDEWALK_KERB_MAX_FROM_ROAD', () => SIDEWALK_KERB_MAX_FROM_ROAD, (v) => (SIDEWALK_KERB_MAX_FROM_ROAD = v), [1, 40], 1, 'past this it is a path and has no kerb (m)'),
          tune('SIDEWALK_ROAD_CLEAR_M', () => SIDEWALK_ROAD_CLEAR_M, (v) => (SIDEWALK_ROAD_CLEAR_M = v), [0, 6], 0.1, 'drop the walk where it strays this far onto ANOTHER road (m)'),
          tune('SIDEWALK_STATION_M', () => SIDEWALK_STATION_M, (v) => (SIDEWALK_STATION_M = v), [1, 20], 0.5, 'station spacing along a walk, and the granularity of a cut (m)'),
          tune('SIDEWALK_OWN_CLEAR_M', () => SIDEWALK_OWN_CLEAR_M, (v) => (SIDEWALK_OWN_CLEAR_M = v), [0, 12], 0.1, 'the same for its own road \u2014 wide, a walk hugs its own shoulder (m)'),
          tune('SIDEWALK_DROP_M', () => SIDEWALK_DROP_M, (v) => (SIDEWALK_DROP_M = v), [0, 12], 0.5, 'dropped-kerb ramp before a crossing (m)'),
          tune('SIDEWALK_BAR_W', () => SIDEWALK_BAR_W, (v) => (SIDEWALK_BAR_W = v), [0.1, 1.5], 0.05, 'crossing bar width (m)'),
          tune('SIDEWALK_BAR_PITCH', () => SIDEWALK_BAR_PITCH, (v) => (SIDEWALK_BAR_PITCH = v), [0.4, 4], 0.1, 'crossing bar spacing (m)'),
          tune('SIDEWALK_PAINT_LIFT', () => SIDEWALK_PAINT_LIFT, (v) => (SIDEWALK_PAINT_LIFT = v), [0.005, 0.2], 0.005, 'paint over ground (m)'),
          tune('SIDEWALK_CROSSING_W', () => SIDEWALK_CROSSING_W, (v) => (SIDEWALK_CROSSING_W = v), [0.4, 3], 0.05, 'painted band width ×'),
          tune('FURNITURE_CHUNK_M', () => FURNITURE_CHUNK_M, (v) => (FURNITURE_CHUNK_M = v), [50, 2000], 25, 'm per cull chunk for linear furniture'),
          tune('BRANCH_VERGE', () => BRANCH_VERGE, (v) => (BRANCH_VERGE = v), [4, 40], 1, 'm of verge on a branch road strip'),
        ],
      },
      {
        title: 'intersections',
        scope: 'world',
        collapsed: false,
        keys: [
          tune('SIGNAL_GREEN_MAJOR', () => SIGNAL_GREEN_MAJOR, (v) => (SIGNAL_GREEN_MAJOR = v), [5, 300], 5, 'green on the superior road (s)'),
          tune('SIGNAL_GREEN_MINOR', () => SIGNAL_GREEN_MINOR, (v) => (SIGNAL_GREEN_MINOR = v), [5, 120], 1, 'green on the inferior road (s)'),
          tune('SIGNAL_GREEN_RR', () => SIGNAL_GREEN_RR, (v) => (SIGNAL_GREEN_RR = v), [5, 120], 1, 'green per phase when round-robining (s)'),
          tune('SIGNAL_AMBER', () => SIGNAL_AMBER, (v) => (SIGNAL_AMBER = v), [1, 10], 0.5, 'amber (s)'),
          tune('SIGNAL_ALL_RED', () => SIGNAL_ALL_RED, (v) => (SIGNAL_ALL_RED = v), [0, 6], 0.5, 'all-red between phases (s)'),
          tune('SIGNAL_RATE', () => SIGNAL_RATE, (v) => (SIGNAL_RATE = v), [0, 30], 0.5, 'clock × — turn up to watch a cycle'),
          tune('SIGNAL_LENS_R', () => SIGNAL_LENS_R, (v) => (SIGNAL_LENS_R = v), [0.05, 0.4], 0.005, 'lit lens radius (m)'),
          tune('STOPBAR_DEPTH', () => STOPBAR_DEPTH, (v) => (STOPBAR_DEPTH = v), [0.1, 2], 0.05, 'stop bar depth along the lane (m)'),
          tune('STOPBAR_LIFT', () => STOPBAR_LIFT, (v) => (STOPBAR_LIFT = v), [0.005, 0.2], 0.005, 'paint over asphalt (m)'),
          tune('STOPBAR_MAX_FROM_ROAD', () => STOPBAR_MAX_FROM_ROAD, (v) => (STOPBAR_MAX_FROM_ROAD = v), [2, 60], 1, 'm from a drawn road, or no bar'),
          tune('BLADE_POST_H', () => BLADE_POST_H, (v) => (BLADE_POST_H = v), [1.5, 6], 0.1, 'street sign post height (m)'),
          tune('BLADE_H', () => BLADE_H, (v) => (BLADE_H = v), [0.1, 0.6], 0.01, 'blade height (m)'),
          tune('BLADE_CLEAR', () => BLADE_CLEAR, (v) => (BLADE_CLEAR = v), [0, 4], 0.1, 'm clear of asphalt a corner post needs'),
          tune('BLADE_WALK_M', () => BLADE_WALK_M, (v) => (BLADE_WALK_M = v), [0, 40], 1, 'm outward it may walk to find it'),
        ],
      },
    ],
  },
  {
    name: 'car',
    sections: [
      {
        title: 'engine',
        scope: 'world',
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
        scope: 'world',
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
        scope: 'world',
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
        scope: 'world',
        keys: [
          tune('CAR_RIDE', () => CAR_RIDE, (v) => (CAR_RIDE = v), [0.1, 1], 0.01, 'reference point above the surface (m)'),
          tune('CAR_RECOVER_BACK', () => CAR_RECOVER_BACK, (v) => (CAR_RECOVER_BACK = v), [0, 40], 1, 'metres R backs you out'),
          tune('CAR_CLIMB_SLOPE', () => CAR_CLIMB_SLOPE, (v) => (CAR_CLIMB_SLOPE = v), [0.25, 6], 0.25, 'how steeply the wheels may ride up onto a kerb'),
        ],
      },
      {
        title: 'jumps (switches default off)',
        scope: 'world',
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
    name: 'engine',
    sections: [
      {
        title: 'which engine',
        scope: 'world',
        keys: [
          tune('ENGINE_INDEX', () => ENGINE_INDEX, (v) => (ENGINE_INDEX = v), [0, 19], 1, 'index into the catalog; 14 is the GM LS'),
          tune('ENGINE_MASTER', () => ENGINE_MASTER, (v) => (ENGINE_MASTER = v), [0, 1], 0.05, 'master gain'),
          tune('ENGINE_SIM_HZ', () => ENGINE_SIM_HZ, (v) => (ENGINE_SIM_HZ = v), [0, 48000], 500, 'physics steps/s; 0 = whatever the script asked for', { scope: 'machine' }),
        ],
      },
      {
        title: 'where it is (3D position and attenuation)',
        scope: 'world',
        keys: [
          tune('ENGINE_REF_M', () => ENGINE_REF_M, (v) => (ENGINE_REF_M = v), [0.5, 20], 0.1, 'full volume inside this radius'),
          tune('ENGINE_MAX_M', () => ENGINE_MAX_M, (v) => (ENGINE_MAX_M = v), [10, 2000], 10, 'attenuation stops getting worse past this'),
          tune('ENGINE_ROLLOFF', () => ENGINE_ROLLOFF, (v) => (ENGINE_ROLLOFF = v), [0, 3], 0.05, '1 = the physical inverse law'),
          tune('ENGINE_INTERIOR_M', () => ENGINE_INTERIOR_M, (v) => (ENGINE_INTERIOR_M = v), [0, 10], 0.1, 'inside this, stop panning: you are in the cabin'),
          tune('ENGINE_EXTERIOR_M', () => ENGINE_EXTERIOR_M, (v) => (ENGINE_EXTERIOR_M = v), [0, 20], 0.1, 'beyond this, fully a point source out in the world'),
          tune('ENGINE_MUFFLE_HZ', () => ENGINE_MUFFLE_HZ, (v) => (ENGINE_MUFFLE_HZ = v), [200, 20000], 50, 'cabin lowpass corner at interior = 1'),
          tune('ENGINE_HRTF', () => ENGINE_HRTF, (v) => (ENGINE_HRTF = v), [0, 1], 1, '1 = HRTF head model (colours the engine), 0 = flat equal-power pan'),
        ],
      },
      {
        title: 'gearbox (ours: the car has a speed, not a crankshaft)',
        scope: 'world',
        keys: [
          tune('ENGINE_GEAR_1', () => ENGINE_GEAR_1, (v) => (ENGINE_GEAR_1 = v), [0, 6], 0.01),
          tune('ENGINE_GEAR_2', () => ENGINE_GEAR_2, (v) => (ENGINE_GEAR_2 = v), [0, 6], 0.01),
          tune('ENGINE_GEAR_3', () => ENGINE_GEAR_3, (v) => (ENGINE_GEAR_3 = v), [0, 6], 0.01),
          tune('ENGINE_GEAR_4', () => ENGINE_GEAR_4, (v) => (ENGINE_GEAR_4 = v), [0, 6], 0.01),
          tune('ENGINE_GEAR_5', () => ENGINE_GEAR_5, (v) => (ENGINE_GEAR_5 = v), [0, 6], 0.01),
          tune('ENGINE_GEAR_6', () => ENGINE_GEAR_6, (v) => (ENGINE_GEAR_6 = v), [0, 6], 0.01, '0 takes the gear out of the box'),
          tune('ENGINE_FINAL_DRIVE', () => ENGINE_FINAL_DRIVE, (v) => (ENGINE_FINAL_DRIVE = v), [1, 6], 0.01),
          tune('ENGINE_TYRE_RADIUS', () => ENGINE_TYRE_RADIUS, (v) => (ENGINE_TYRE_RADIUS = v), [0.2, 0.6], 0.005, 'm'),
          tune('ENGINE_IDLE_RPM', () => ENGINE_IDLE_RPM, (v) => (ENGINE_IDLE_RPM = v), [400, 2000], 10, 'the floor; a car held at 0 rpm has stalled'),
          tune('ENGINE_REDLINE_RPM', () => ENGINE_REDLINE_RPM, (v) => (ENGINE_REDLINE_RPM = v), [3000, 20000], 100),
          tune('ENGINE_SHIFT_UP_RPM', () => ENGINE_SHIFT_UP_RPM, (v) => (ENGINE_SHIFT_UP_RPM = v), [2000, 20000], 100),
          tune('ENGINE_SHIFT_DOWN_RPM', () => ENGINE_SHIFT_DOWN_RPM, (v) => (ENGINE_SHIFT_DOWN_RPM = v), [800, 8000], 50, 'keep well below the upshift or it hunts'),
          tune('ENGINE_SHIFT_SECONDS', () => ENGINE_SHIFT_SECONDS, (v) => (ENGINE_SHIFT_SECONDS = v), [0.05, 1], 0.01, 'clutch out'),
        ],
      },
      {
        title: 'voicing (the script ships its own; override to use these)',
        scope: 'world',
        collapsed: true,
        keys: [
          tune('ENGINE_VOICE_OVERRIDE', () => ENGINE_VOICE_OVERRIDE, (v) => (ENGINE_VOICE_OVERRIDE = v), [0, 1], 1, '1 = these knobs win'),
          tune('ENGINE_VOLUME', () => ENGINE_VOLUME, (v) => (ENGINE_VOLUME = v), [0, 1], 0.01, 'above ~0.3 the synthesizer clips in 16-bit'),
          tune('ENGINE_CONVOLUTION', () => ENGINE_CONVOLUTION, (v) => (ENGINE_CONVOLUTION = v), [0, 1], 0.01, 'exhaust dry/wet; 0 skips the filter entirely'),
          tune('ENGINE_HF_GAIN', () => ENGINE_HF_GAIN, (v) => (ENGINE_HF_GAIN = v), [0, 0.5], 0.001, 'edge and rasp; past ~0.1 it is hiss'),
          tune('ENGINE_HF_NOISE', () => ENGINE_HF_NOISE, (v) => (ENGINE_HF_NOISE = v), [0, 2], 0.01, 'jitter: mechanical rather than synthetic'),
          tune('ENGINE_HF_CUTOFF', () => ENGINE_HF_CUTOFF, (v) => (ENGINE_HF_CUTOFF = v), [100, 20000], 100, 'Hz'),
          tune('ENGINE_LF_NOISE', () => ENGINE_LF_NOISE, (v) => (ENGINE_LF_NOISE = v), [0, 2], 0.01, 'intake and turbulence'),
          tune('ENGINE_LF_CUTOFF', () => ENGINE_LF_CUTOFF, (v) => (ENGINE_LF_CUTOFF = v), [20, 8000], 20, 'Hz'),
          tune('ENGINE_LEVELER_TARGET', () => ENGINE_LEVELER_TARGET, (v) => (ENGINE_LEVELER_TARGET = v), [1000, 32767], 100, 'automatic gain target, 16-bit counts'),
          tune('ENGINE_LEVELER_MAX_GAIN', () => ENGINE_LEVELER_MAX_GAIN, (v) => (ENGINE_LEVELER_MAX_GAIN = v), [0.01, 8], 0.01, 'lower it to stop idle being pumped up to match full throttle'),
          tune('ENGINE_LEVELER_MIN_GAIN', () => ENGINE_LEVELER_MIN_GAIN, (v) => (ENGINE_LEVELER_MIN_GAIN = v), [0.000001, 1], 0.000001),
        ],
      },
    ],
  },
  {
    name: 'view',
    sections: [
      {
        title: 'flying and walking (the free camera)',
        keys: [
          tune('FLY_SPEED', () => FLY_SPEED, (v) => (FLY_SPEED = v), [0.05, 3], 0.05, 'overall pace: m/s per metre of camera-to-target distance'),
          tune('FLY_SPEED_FLOOR_M', () => FLY_SPEED_FLOOR_M, (v) => (FLY_SPEED_FLOOR_M = v), [1, 200], 1, 'THE ONE FOR "too fast": speed near the ground stops scaling below this'),
          tune('FLY_SPRINT_X', () => FLY_SPRINT_X, (v) => (FLY_SPRINT_X = v), [1, 10], 0.1, 'what Shift multiplies everything by'),
          tune('FLY_LIFT', () => FLY_LIFT, (v) => (FLY_LIFT = v), [0, 3], 0.05, 'T/G rise and fall'),
          tune('FLY_LIFT_FLOOR_M', () => FLY_LIFT_FLOOR_M, (v) => (FLY_LIFT_FLOOR_M = v), [1, 300], 1),
          tune('FLY_ZOOM', () => FLY_ZOOM, (v) => (FLY_ZOOM = v), [0.05, 4], 0.05, 'R/F dolly, exponential'),
          tune('FLY_LOOK', () => FLY_LOOK, (v) => (FLY_LOOK = v), [0.1, 5], 0.05, 'Q/E yaw, rad/s'),
          tune('WALK_SPEED', () => WALK_SPEED, (v) => (WALK_SPEED = v), [0.5, 12], 0.1, 'on foot (B), m/s — 3.2 is a brisk walk'),
          tune('WALK_SPRINT_X', () => WALK_SPRINT_X, (v) => (WALK_SPRINT_X = v), [1, 5], 0.1),
        ],
      },
      {
        title: 'chase',
        keys: [
          tune('CHASE_BACK', () => CHASE_BACK, (v) => (CHASE_BACK = v), [2, 30], 0.5),
          tune('CHASE_UP', () => CHASE_UP, (v) => (CHASE_UP = v), [0.5, 15], 0.1),
          tune('CHASE_LOOK_AHEAD', () => CHASE_LOOK_AHEAD, (v) => (CHASE_LOOK_AHEAD = v), [0, 40], 0.5),
          tune('CHASE_LAG', () => CHASE_LAG, (v) => (CHASE_LAG = v), [1, 30], 0.5, 'higher = stiffer'),
          tune('CHASE_ROLL', () => CHASE_ROLL, (v) => (CHASE_ROLL = v), [0, 1], 0.05, 'camera up follows the car (1) or the horizon (0) — loops'),
          tune('CHASE_ROLL_LAG', () => CHASE_ROLL_LAG, (v) => (CHASE_ROLL_LAG = v), [0.5, 30], 0.5, 'how fast the roll follows; lower = calmer'),
          tune('CAM_SIT_HEIGHT', () => CAM_SIT_HEIGHT, (v) => (CAM_SIT_HEIGHT = v), [0.25, 5], 0.05, 'eye height for G, sit on the road (m)'),
          tune('CAM_MIN_HEIGHT', () => CAM_MIN_HEIGHT, (v) => (CAM_MIN_HEIGHT = v), [0.05, 5], 0.05, 'fly camera floor above ground (m)'),
          tune('COCKPIT_EYE_UP', () => COCKPIT_EYE_UP, (v) => (COCKPIT_EYE_UP = v), [0.3, 3], 0.05),
          tune('COCKPIT_EYE_FWD', () => COCKPIT_EYE_FWD, (v) => (COCKPIT_EYE_FWD = v), [-2, 3], 0.05),
          tune('COCKPIT_EYE_SIDE', () => COCKPIT_EYE_SIDE, (v) => (COCKPIT_EYE_SIDE = v), [-0.9, 0.9], 0.02, 'driver seat offset, - = left'),
          tune('COCKPIT_ROLL', () => COCKPIT_ROLL, (v) => (COCKPIT_ROLL = v), [0, 1], 0.05, 'share of the body roll the head takes on'),
          tune('COCKPIT_LOOK_UP', () => COCKPIT_LOOK_UP, (v) => (COCKPIT_LOOK_UP = v), [-3, 3], 0.1),
        ],
      },
      {
        title: 'what the readout says',
        keys: [
          tune('HUD_ROAD_NAME', () => HUD_ROAD_NAME, (v) => (HUD_ROAD_NAME = v), [0, 1], 1, 'show the name of the road you are on while driving'),
          tune('HUD_TELEMETRY', () => HUD_TELEMETRY, (v) => (HUD_TELEMETRY = v), [0, 1], 1, 'show ground elevation and compass heading while driving'),
        ],
      },
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
    name: 'physics',
    sections: [
      {
        title: 'the world (reload after changing any of these)',
        keys: [
          tune('PHYS_ENABLED', () => PHYS_ENABLED, (v) => (PHYS_ENABLED = v), [0, 1], 1, 'Rapier at all. Read once, when the site builds \u2014 use ?phys=1 in the URL, this slider needs a reload and does not persist'),
          tune('PHYS_HZ', () => PHYS_HZ, (v) => (PHYS_HZ = v), [30, 240], 10, 'fixed steps per second'),
          tune('PHYS_MAX_STEPS', () => PHYS_MAX_STEPS, (v) => (PHYS_MAX_STEPS = v), [1, 24], 1, 'a stall past this is dropped, never paid back'),
          tune('PHYS_STEP_BUDGET_MS', () => PHYS_STEP_BUDGET_MS, (v) => (PHYS_STEP_BUDGET_MS = v), [2, 30], 1, 'ms of a frame the steps may take; past it the backlog is dropped'),
          tune('PHYS_ITERATIONS', () => PHYS_ITERATIONS, (v) => (PHYS_ITERATIONS = v), [1, 32], 1, 'solver iterations; higher is stiffer and dearer'),
          tune('PHYS_SOFT_BREAK_NS', () => PHYS_SOFT_BREAK_NS, (v) => (PHYS_SOFT_BREAK_NS = v), [0, 50000], 250, 'a breakable under this gives way to a car instead of stopping it (reload)'),
          tune('PHYS_IMPACT_N', () => PHYS_IMPACT_N, (v) => (PHYS_IMPACT_N = v), [1000, 200000], 1000, 'quieter contacts than this report nothing'),
        ],
      },
      {
        title: 'the ground under the car',
        keys: [
          tune('PHYS_TILE_M', () => PHYS_TILE_M, (v) => (PHYS_TILE_M = v), [16, 256], 8, 'metres across one heightfield tile'),
          tune('PHYS_TILE_CELLS', () => PHYS_TILE_CELLS, (v) => (PHYS_TILE_CELLS = v), [8, 128], 8, 'samples per edge \u2014 TILE_M/CELLS is the resolution a wheel feels'),
          tune('PHYS_TILE_BUDGET', () => PHYS_TILE_BUDGET, (v) => (PHYS_TILE_BUDGET = v), [1, 8], 1, 'tiles built per frame. THE HITCH KNOB'),
          tune('PHYS_RADIUS_M', () => PHYS_RADIUS_M, (v) => (PHYS_RADIUS_M = v), [64, 600], 10, 'how far the solid ground reaches'),
          tune('PHYS_GROUND_FRICTION', () => PHYS_GROUND_FRICTION, (v) => (PHYS_GROUND_FRICTION = v), [0, 2], 0.05),
        ],
      },
      {
        title: 'the car',
        keys: [
          tune('PHYS_TREES', () => PHYS_TREES, (v) => (PHYS_TREES = v), [0, 1], 1, 'trunks you can hit', { scope: 'world', lerp: 'step' }),
          tune('PHYS_PROP_RADIUS_M', () => PHYS_PROP_RADIUS_M, (v) => (PHYS_PROP_RADIUS_M = v), [20, 300], 10),
          tune('PHYS_PROPS', () => PHYS_PROPS, (v) => (PHYS_PROPS = v), [0, 1], 1, 'signs, masts, poles, fences and houses are solid', { scope: 'world', lerp: 'step' }),
          tune('PHYS_PROP_BUDGET', () => PHYS_PROP_BUDGET, (v) => (PHYS_PROP_BUDGET = v), [0, 3000], 25, 'nearest first'),
          tune('PHYS_TREE_BUDGET', () => PHYS_TREE_BUDGET, (v) => (PHYS_TREE_BUDGET = v), [0, 2000], 25, 'nearest first'),
          tune('PHYS_CAR', () => PHYS_CAR, (v) => (PHYS_CAR = v), [0, 1], 1, '0 = the hand-written car, 1 = Rapier. Needs ?phys=1 and a fresh press of Tab', { scope: 'world', lerp: 'step' }),
          tune('PHYS_PROFILE', () => PHYS_PROFILE, (v) => (PHYS_PROFILE = v), [0, 4], 1, '0 stunts \u00b7 1 taxi \u00b7 2 street \u00b7 3 rush \u00b7 4 sim', { scope: 'world', lerp: 'step' }),
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
  if (d < 1e-6 || (LOD_BEHIND_PENALTY <= 0 && TREE_CONE_PENALTY <= 0)) return d
  const cos = (dx * fwdX + dz * fwdZ) / d // 1 ahead, -1 behind
  const behind = (1 - cos) * 0.5 // 0 ahead … 1 behind
  const topdown = Math.min(1, Math.max(0, (pitch - LOD_TOPDOWN_PITCH * 0.7) / (LOD_TOPDOWN_PITCH * 0.3)))
  // the view cone: nothing inside it, a ramp over 12° at its edge, the full penalty beyond
  let outside = 0
  if (TREE_CONE_PENALTY > 0 && TREE_CONE_DEG < 180) {
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
    outside = Math.min(1, Math.max(0, (angle - TREE_CONE_DEG) / 12))
  }
  return d * (1 + (LOD_BEHIND_PENALTY * behind + TREE_CONE_PENALTY * outside) * (1 - topdown))
}

/** The drive profile `PHYS_PROFILE` names. The order is the engine's own `PROFILES` order. */
export const PHYS_PROFILE_NAMES = ['stunts', 'taxi', 'street', 'rush', 'sim']
export function physProfileId(): string {
  return PHYS_PROFILE_NAMES[Math.round(PHYS_PROFILE)] ?? 'street'
}
