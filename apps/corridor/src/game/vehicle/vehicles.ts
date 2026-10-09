// What a vehicle IS, as a document — and the arithmetic that turns it into something the engine can
// drive.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md, from Rich: "Vehicles should be a combination of a vehicle
// model, a rig (if we defined it), and vehicle physics dynamics that will impact each game type
// differently, but roll stiffness, grip front/rear/side to side, other things like this - plus we
// want to be able to assign an engine simulator setup and local config for the audio, as well as
// set things like engine power, gearing, braking."
//
// THREE THINGS ARE SEPARATE AND STAY SEPARATE, and the whole file follows from it:
//
//   the MODEL      a mesh in the catalog. Two cars may share one.
//   the RIG        which bone is the near-side front wheel. A fact about the model (`AssetItem.rig`).
//   the VEHICLE    mass, grip, gearing, what it sounds like. A fact about the CAR.
//
// So a vehicle document lives beside the asset, the way `rig` already does, and two assets can share
// a model and handle nothing alike.
//
// NO DOM, NO THREE, NO RAPIER. This file is types, defaults, validation and arithmetic, so the
// mapping from "205 kW through a 3.7 final drive" to "this much force at the contact patch" can be
// checked in a test rather than discovered by driving. `src/ui/vehicles.ts` is the form over it.
//
// THE PROFILE IS A REFERENCE, NEVER A COPY. `{ base: 'street', overrides: { gripRear: 1.08 } }` is
// how a car says "street, but grippier" and keeps tracking `street` when somebody improves it. A
// flattened copy of all forty numbers is forty numbers that silently stop tracking, and nothing ever
// says so.
import { DRIVE_PROFILE_NUMBER_KEYS, PROFILES, profile, type DriveProfile } from '@apex/engine/physics/profiles'
import type { VehicleSpec } from '@apex/engine/physics/vehicle'

/* ---- the document ---------------------------------------------------------------------------- */

/** The chassis, in metres and kilograms. What the car IS, before any game gets an opinion. */
export interface VehicleChassis {
  /** kg, dry */
  mass: number
  /** m, front axle to rear axle */
  wheelbase: number
  /** m, left wheel to right wheel */
  track: number
  /**
   * m, the centre of gravity ABOVE THE GROUND.
   *
   * The number people get wrong, and the one that decides whether a car rolls over. It is measured
   * from the road, not from the model's origin, because that is the only definition somebody
   * reading a spec sheet will recognise — `toVehicleSpec` does the conversion into the engine's
   * body-relative frame, and `cgHeightOf` measures it back out of a settled car so the two can be
   * held against each other.
   */
  cgHeight: number
  /** m */
  wheelRadius: number
  /**
   * Which wheels are driven.
   *
   * ON THE CHASSIS, NOT ON THE PROFILE, although the engine's `DriveProfile` also carries one. A
   * Mustang is rear-wheel drive in an arcade racer and in a simulator alike — it is a fact about the
   * car, not about the game — so the chassis wins and `toDriveProfile` overrides the profile's. The
   * engine keeping its own is right for the five presets, which describe cars nobody has modelled.
   */
  drive: 'rwd' | 'fwd' | 'awd'
  /**
   * Which end of the model is the front, once its length has been laid along the nose axis.
   *
   * A reconstruction has no idea which way it faces; the fitter guesses from the roofline (the
   * tail rises more steeply than the windscreen on nearly everything). `keep` and `flip` override
   * the guess for the ones it gets wrong. Absent means `auto`.
   */
  nose?: 'auto' | 'keep' | 'flip'
  /** m, overall length and width of the body. Defaulted from the class when the model has not said */
  length?: number
  width?: number
  height?: number
  /**
   * m, the gap between the road and the bottom of the body at rest. Default 0.16.
   *
   * It is here because it is what POSITIONS the body, and positioning it any other way produces a
   * car whose sills are at knee height — see `originHeight`.
   */
  rideHeight?: number
  /**
   * The share of the car's weight on the FRONT axle, 0…1. Default 0.5.
   *
   * Rich, 2026-09-29: *"one thing notably missing is front/rear weight distribution, that will
   * impact handling significantly"*. It does, and in two separate ways that this file keeps
   * separate on purpose:
   *
   *   1. WHERE THE MASS IS. It becomes `comX` on the physics body, so a nose-heavy car pitches,
   *      brakes and rotates differently for reasons Rapier works out rather than reasons we impose.
   *   2. WHAT EACH AXLE CAN HOLD. A tyre's grip falls as the load on it rises — load sensitivity —
   *      so the heavy axle has LESS grip per kilogram, which is why a front-engined car understeers
   *      and why weight transfer under braking works at all. See `axleGrip`.
   *
   * A real front-engined saloon is about 0.55, a mid-engined car 0.42, a rear-engined 911 about
   * 0.38, a loaded van 0.45, a cabover truck 0.62.
   */
  weightFront?: number
  /**
   * Tyre section width, mm, per axle. Default 225 both ends.
   *
   * Rich asked for "255f/305r" to mean something, and it does: a wider tyre carries the same load
   * over more rubber, so the load per millimetre falls and the grip coefficient rises. It is the
   * SAME calculation as the weight distribution, from the other side, which is why one function
   * does both.
   */
  tyreFront_mm?: number
  tyreRear_mm?: number
  /**
   * How many lamps across the front, and how many across the tail.
   *
   * Absent means two on anything as wide as a car, and one when the body is as narrow as a
   * motorcycle. A saved number wins, so a bike can be given two and a car can be given one.
   */
  headlights?: number
  taillights?: number
}

/** A handling profile by reference, plus the handful of numbers this car differs by. */
export interface VehicleHandling {
  /** a `DriveProfile` id: stunts | taxi | street | rush | sim */
  base: string
  /** partial `DriveProfile`, by key. Validated against the real keys, so a typo is an error */
  overrides?: Record<string, number>
  /**
   * Blend toward a second profile, 0…1. `blendProfiles` exists so somebody can sit a car between
   * Rush and the simulator rather than being made to pick a side.
   */
  blendWith?: string
  blend?: number
}

/** The drivetrain, as a spec sheet gives it. */
export interface VehicleEngine {
  power_kw: number
  /**
   * N·m at the crank. Optional: when it is missing it is estimated from power and redline, which is
   * a HEURISTIC and says so — see `peakTorque`.
   */
  torque_nm?: number
  redline_rpm: number
  idle_rpm: number
  /** gear ratios, first to top */
  gears: number[]
  final_drive: number
  /** N·m of braking torque at the wheels, both axles together */
  brake_torque_nm: number
  /** 0…1, the share of it on the front axle */
  brake_bias: number
}

/** enginesim, per vehicle. */
export interface VehicleAudio {
  /** which enginesim configuration */
  setup: string
  gain: number
  lowpass_hz: number
  /** how much of it is heard from inside the cabin, 0…1 */
  cabin_mix: number
}

export interface VehicleWheels {
  /**
   * Take the wheels from `AssetItem.rig.roles.wheel`, in FL, FR, RL, RR order.
   *
   * **Defaults to FALSE, because nothing in the library has a skeleton.** Measured by the editor
   * lane, 2026-09-29: 125 items, 121 with a mesh, `rig` set on zero of them — and that is the
   * FILES, not missing metadata. TRELLIS reconstructs a surface and nothing in the chain rigs it.
   *
   * With it off the engine drives four proxy wheels off `wheelbase` and `track`, which needs no
   * bones and is what a traffic car should do anyway. Turning it on for a car that has been rigged
   * is the opt-in, and then the validator's "binds N wheel bones" warning means something — which
   * is why the check stays and only the default moved.
   */
  from_rig: boolean
  steer_max_deg: number
}

/** Which file the world draws. Absent means the finished mesh when that file exists. */
export type VehicleMesh = 'finished' | 'raw'

/**
 * What the paint is made of. This is the MATERIAL, not a gain on it — the F6 `CAR_SHINE` slider
 * scales the whole fleet's clearcoat, and this is how one car differs from the fleet.
 *
 * The problem this exists for (Rich, 2026-10-05): every car was forced to `roughness ≤ 0.28`,
 * `metalness ≥ 0.5`, so a "shine" dial could only make the coat brighter, never change the surface
 * — the reflections stayed soft and matte and no setting reached a genuinely mirror-like paint.
 * These four numbers are that surface, and `chrome` is the one-click mirror they can also add up to. `roughness` and `metalness` are absolute facts about the
 * paint; `reflect` and `shine` MULTIPLY the global dials so raising REFLECT or CAR_SHINE still
 * moves every car at once.
 *
 * Absent is the old default (glossy paint: roughness 0.28 floor, metalness 0.5 floor, no scaling),
 * so a document that says nothing keeps looking exactly as it did.
 */
export interface VehicleFinish {
  /** 0 is a mirror, 1 is flat matte. Absent: the model's own roughness, floored at 0.28. */
  roughness?: number
  /** 0 is plastic/dielectric, 1 is chrome. Absent: the model's own metalness, floored at 0.5. */
  metalness?: number
  /** environment reflection strength, times the global `REFLECT`. Absent: 1 */
  reflect?: number
  /** clearcoat strength, times the global `CAR_SHINE`. Absent: 1 */
  shine?: number
  /**
   * A chrome finish: mirror-smooth and fully metallic, so the paint reflects the world like polished
   * metal. This is the one-click version of roughness ≈ 0 and metalness 1, and it wins over those two
   * when set. `reflect` and `shine` still multiply the fleet dials on top, and the global F6
   * `CAR_CHROME` can push any car this way live.
   */
  chrome?: boolean
}

export interface VehicleDoc {
  spec: VehicleChassis
  profile: VehicleHandling
  engine: VehicleEngine
  audio: VehicleAudio
  wheels: VehicleWheels
  /**
   * How the paint looks: the material the car's surfaces are put into. Optional — absent is the
   * old glossy default — so the world editor can set it per vehicle while every existing document
   * keeps its look.
   */
  finish?: VehicleFinish
  /**
   * Weapons bolted to the car, each at a named place on the chassis. Optional and usually absent:
   * most cars are not armed, and an empty array on every document is noise in every file.
   */
  mounts?: MountedWeapon[]
  /**
   * How far the mounted weapons may turn to follow the camera, degrees each way: yaw across, pitch
   * up and down. 0 fixes a weapon along its mount; absent defers to the tuning panel's
   * GUN_TURRET_* / MISSILE_TURRET_* knobs, which also cap whatever a document says.
   */
  turret?: { gun_yaw_deg?: number; gun_pitch_deg?: number; missile_yaw_deg?: number; missile_pitch_deg?: number }
  /**
   * Finished is the simplified mesh. Raw is the reconstruction, with many more triangles.
   * Absent, the world draws finished when that file exists.
   */
  mesh?: VehicleMesh
}

/* ---- defaults, per class --------------------------------------------------------------------- */

/**
 * The hero car's handling overrides, on the `street` base.
 *
 * Rich's own drive, pasted back from the F6 panel on 2026-10-05 — the F6 physics sliders are seeded
 * from these (`adoptPhysCar`), so this is the one place the hero car's numbers live. Everything not
 * named here keeps `street`.
 */
const HERO_HANDLING: Record<string, number> = {
  powerPerKg: 31.7,
  topSpeed: 180,
  brakePerKg: 37,
  reverse: 0.6,
  gripFront: 2.76,
  gripRear: 2.68,
  sideStiffness: 3.1,
  offroadGrip: 1.15,
  suspensionRest: 0.13,
  suspensionTravel: 0.05,
  suspensionStiffness: 176,
  compression: 5.8,
  relaxation: 3.4,
  rollingPerKg: 0,
  dragPerKg: 0.0001,
  downforcePerKg: 0.0009,
  fanPerKg: 8.5,
  antiRollPerKg: 10.5,
  rollResist: 0.68,
  driveShare: 0.4,
}

/**
 * Sensible numbers per vehicle class.
 *
 * NOT because guessing is good, but because a form full of zeroes is a form nobody fills in, and
 * `mass` and `cgHeight` left at zero fail invisibly and late. The UI's job is to say these are
 * defaults; this table's job is to make them defensible ones.
 *
 * The `hero-car` row is the Kestrel-ish body the corridor already draws (4.4 × 1.9 m) with the
 * mass and CG of an ordinary saloon.
 */
export const VEHICLE_TEMPLATES: Record<string, VehicleDoc> = {
  'hero-car': doc({ mass: 1420, wheelbase: 2.65, track: 1.55, cgHeight: 0.52, wheelRadius: 0.32, drive: 'rwd', length: 4.4, width: 1.9, height: 1.35 }, 'street', { power_kw: 205, redline_rpm: 7200, idle_rpm: 850, gears: [3.42, 2.05, 1.42, 1.0, 0.82, 0.68], final_drive: 3.7, brake_torque_nm: 2400, brake_bias: 0.62 }, 'engines/atg-video-2/03_2jz.mr', HERO_HANDLING),
  traffic: doc({ mass: 1500, wheelbase: 2.7, track: 1.56, cgHeight: 0.58, wheelRadius: 0.33, drive: 'fwd', length: 4.5, width: 1.82, height: 1.48 }, 'street', { power_kw: 110, redline_rpm: 6200, idle_rpm: 750, gears: [3.55, 1.95, 1.3, 0.95, 0.74], final_drive: 4.05, brake_torque_nm: 1900, brake_bias: 0.65 }, 'engines/atg-video-1/05_honda_vtec.mr'),
  van: doc({ mass: 2300, rideHeight: 0.24, wheelbase: 3.2, track: 1.7, cgHeight: 0.85, wheelRadius: 0.36, drive: 'rwd', length: 5.5, width: 2.0, height: 2.4 }, 'street', { power_kw: 96, redline_rpm: 4600, idle_rpm: 700, gears: [4.2, 2.3, 1.45, 1.0, 0.8, 0.66], final_drive: 3.9, brake_torque_nm: 2600, brake_bias: 0.6 }, 'engines/atg-video-2/05_odd_fire_v6.mr'),
  truck: doc({ mass: 8000, rideHeight: 0.32, wheelbase: 4.8, track: 2.0, cgHeight: 1.25, wheelRadius: 0.52, drive: 'rwd', length: 9.0, width: 2.5, height: 3.4 }, 'street', { power_kw: 180, redline_rpm: 2600, idle_rpm: 600, gears: [7.2, 4.2, 2.6, 1.7, 1.0, 0.78], final_drive: 4.3, brake_torque_nm: 9000, brake_bias: 0.55 }, 'engines/atg-video-2/07_gm_ls.mr'),
  bus: doc({ mass: 12000, rideHeight: 0.3, wheelbase: 5.9, track: 2.1, cgHeight: 1.4, wheelRadius: 0.55, drive: 'rwd', length: 12.0, width: 2.55, height: 3.2 }, 'street', { power_kw: 210, redline_rpm: 2400, idle_rpm: 600, gears: [6.7, 3.8, 2.3, 1.5, 1.0], final_drive: 4.6, brake_torque_nm: 13000, brake_bias: 0.5 }, 'engines/atg-video-2/07_gm_ls.mr'),
  motorcycle: doc({ mass: 190, rideHeight: 0.14, wheelbase: 1.4, track: 0.18, cgHeight: 0.55, wheelRadius: 0.31, drive: 'rwd', length: 2.15, width: 0.75, height: 1.15, headlights: 1, taillights: 1 }, 'street', { power_kw: 55, redline_rpm: 11000, idle_rpm: 1200, gears: [2.8, 2.0, 1.55, 1.25, 1.05, 0.9], final_drive: 3.2, brake_torque_nm: 800, brake_bias: 0.7 }, 'engines/atg-video-1/02_kohler_ch750.mr'),
}

function doc(spec: VehicleChassis, base: string, engine: VehicleEngine, setup: string, overrides: Record<string, number> = {}): VehicleDoc {
  return {
    spec,
    profile: { base, overrides: { ...overrides } },
    engine,
    audio: { setup, gain: 0.8, lowpass_hz: 9000, cabin_mix: 0.35 },
    wheels: { from_rig: false, steer_max_deg: 34 },
  }
}

/** The starting points on offer, for a "begin from" picker. Keys of `VEHICLE_TEMPLATES`. */
export const VEHICLE_TEMPLATE_IDS = Object.keys(VEHICLE_TEMPLATES)

/**
 * The CATALOG CLASSES that get a vehicle document at all. Everything else is scenery.
 *
 * THESE ARE THE ASSET LIBRARY'S OWN WORDS, not ours — `KINDS` in `src/ui/assets.ts`. That is the
 * whole point of the list and it is worth saying because getting it wrong fails quietly: a class
 * vocabulary invented here would simply match nothing, and the Vehicles tab would sit there
 * reporting an empty fleet while the library was full of cars.
 */
export const VEHICLE_CLASSES = ['hero-car', 'traffic', 'emergency', 'commercial-vehicle', 'motorcycle']

/**
 * Which template a catalog class starts from.
 *
 * Separate from the class list because they are different questions: "does this thing have
 * dynamics" is about the library's vocabulary, and "what numbers should it start at" is about what
 * the thing physically is. A `commercial-vehicle` may be a van or a lorry, so the mapping is a
 * STARTING POINT the form says is a default and somebody changes — not a claim.
 */
const CLASS_TEMPLATE: Record<string, string> = {
  'hero-car': 'hero-car',
  traffic: 'traffic',
  emergency: 'van',
  'commercial-vehicle': 'truck',
  motorcycle: 'motorcycle',
}

/** A fresh document for a class or a template id, deep-copied so editing one does not edit the table. */
export function defaultVehicle(kind: string): VehicleDoc {
  const id = CLASS_TEMPLATE[kind] ?? kind
  return structuredClone(VEHICLE_TEMPLATES[id] ?? VEHICLE_TEMPLATES['hero-car'])
}

/** Narrower than this, and an unset lamp count is a motorcycle's single lamp rather than a car's pair. */
const MOTORCYCLE_WIDTH_M = 1

/**
 * How many headlights and tail lights this chassis shows.
 *
 * A number on the document wins. Otherwise a car is a pair and anything under a metre wide — a
 * motorcycle — is one, on the centreline.
 */
export function lampCounts(spec: Pick<VehicleChassis, 'headlights' | 'taillights' | 'width'>): { headlights: number; taillights: number } {
  const bike = (spec.width ?? 2) < MOTORCYCLE_WIDTH_M
  const n = (v: number | undefined, fallback: number) => {
    if (v == null || !Number.isFinite(v)) return fallback
    return Math.max(0, Math.min(6, Math.round(v)))
  }
  return {
    headlights: n(spec.headlights, bike ? 1 : 2),
    taillights: n(spec.taillights, bike ? 1 : 2),
  }
}

/**
 * Where across the body those lamps sit, metres left and right of the centreline.
 *
 * One lamp is on the centre. Two or more share the width, inset so they sit on the corners of
 * the body rather than past it.
 */
export function lampOffsets(count: number, width: number): number[] {
  const n = Math.max(0, Math.min(6, Math.round(count)))
  if (n === 0) return []
  if (n === 1) return [0]
  const half = Math.max(0.15, Math.max(0.4, width) * 0.36)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(-half + (2 * half * i) / (n - 1))
  return out
}

/* ---- validation ------------------------------------------------------------------------------- */

export interface VehicleReport {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Check a document. Reports EVERY problem, not the first.
 *
 * Same contract as `validateEcs` and the service's level validator, for the same reason: somebody
 * authoring wants to see everything that is wrong at once, and a car that saves cleanly and then
 * has no wheels is a worse outcome than a form with four red fields.
 *
 * `rigWheels` is how many bones the asset's rig binds to the `wheel` role. Passing it is what turns
 * "your wheels will not turn" from something discovered while driving into a warning on the form.
 */
export function validateVehicle(v: VehicleDoc | null | undefined, opts: { rigWheels?: number; audioSetups?: string[]; weapons?: string[] } = {}): VehicleReport {
  const errors: string[] = []
  const warnings: string[] = []
  if (!v) return { ok: true, errors, warnings }

  const s = v.spec
  const pos = (n: number, name: string, max: number) => {
    if (!Number.isFinite(n) || n <= 0) errors.push(`spec.${name} must be a positive number`)
    else if (n > max) warnings.push(`spec.${name} is ${n}, which is past anything real`)
  }
  pos(s?.mass, 'mass', 40000)
  pos(s?.wheelbase, 'wheelbase', 12)
  pos(s?.track, 'track', 4)
  pos(s?.cgHeight, 'cgHeight', 3)
  pos(s?.wheelRadius, 'wheelRadius', 1.2)
  if (s && !['rwd', 'fwd', 'awd'].includes(s.drive)) errors.push(`spec.drive is ${JSON.stringify(s?.drive)}; it must be rwd, fwd or awd`)
  // The rollover check, and the reason `cgHeight` is in metres above the ground rather than
  // relative to a model origin nobody can picture. Half the track over the CG height is the static
  // stability factor; under about 1.0 a car tips before it slides, which is a monster truck.
  if (s?.track > 0 && s?.cgHeight > 0) {
    const ssf = s.track / 2 / s.cgHeight
    if (ssf < 1.0) warnings.push(`static stability factor ${ssf.toFixed(2)}: this will roll over before it slides — cgHeight ${s.cgHeight} m is high for a ${s.track} m track`)
    if (ssf > 2.5) warnings.push(`static stability factor ${ssf.toFixed(2)}: this cannot be made to roll at all`)
  }
  if (s?.wheelbase > 0 && s?.length && s.length < s.wheelbase) errors.push(`spec.length ${s.length} m is shorter than the wheelbase ${s.wheelbase} m`)
  const lamps = (v: number | undefined, name: string) => {
    if (v == null) return
    if (!Number.isFinite(v) || v < 0 || v > 6) errors.push(`spec.${name} must be between 0 and 6`)
  }
  lamps(s?.headlights, 'headlights')
  lamps(s?.taillights, 'taillights')

  // the finish. roughness and metalness are 0…1 material facts; reflect and shine are multipliers
  // and only have to be positive. A NaN here would silently poison a material, so it is an error.
  const fin = v.finish
  if (fin) {
    const unit = (n: number | undefined, name: string) => {
      if (n === undefined) return
      if (!Number.isFinite(n) || n < 0 || n > 1) errors.push(`finish.${name} must be between 0 and 1`)
    }
    unit(fin.roughness, 'roughness')
    unit(fin.metalness, 'metalness')
    if (fin.chrome !== undefined && typeof fin.chrome !== 'boolean') errors.push('finish.chrome must be true or false')
    for (const [name, n] of [['reflect', fin.reflect], ['shine', fin.shine]] as const) {
      if (n === undefined) continue
      if (!Number.isFinite(n) || n < 0) errors.push(`finish.${name} must be a non-negative number`)
    }
  }

  // the profile
  if (!v.profile?.base) errors.push('profile.base is required — name one of ' + Object.keys(PROFILES).join(', '))
  else if (!PROFILES[v.profile.base]) errors.push(`profile.base ${JSON.stringify(v.profile.base)} is not a drive profile (have ${Object.keys(PROFILES).join(', ')})`)
  if (v.profile?.blendWith && !PROFILES[v.profile.blendWith]) errors.push(`profile.blendWith ${JSON.stringify(v.profile.blendWith)} is not a drive profile`)
  // Overrides are checked against the REAL keys, so `rollStiffness` — a plausible name that does not
  // exist — is an error here rather than a number that is silently ignored for ever. The key set is
  // the engine's own numeric-key list, not `Object.keys(PROFILES.street)`: the optional keys
  // (`driveShare`, `tractionFloor`, `chassisFriction`) are `undefined` on a concrete profile and a
  // legitimate override of one would otherwise be rejected.
  for (const [k, val] of Object.entries(v.profile?.overrides ?? {})) {
    if (!DRIVE_PROFILE_NUMBER_KEYS.has(k)) errors.push(`profile.overrides.${k} is not a DriveProfile key`)
    else if (!Number.isFinite(val)) errors.push(`profile.overrides.${k} must be a number`)
  }

  // the engine
  const e = v.engine
  if (!e) errors.push('engine is required')
  else {
    if (!Number.isFinite(e.power_kw) || e.power_kw <= 0) errors.push('engine.power_kw must be a positive number')
    if (!Array.isArray(e.gears) || !e.gears.length) errors.push('engine.gears must have at least one ratio')
    else {
      if (e.gears.some((g) => !Number.isFinite(g) || g <= 0)) errors.push('engine.gears must all be positive')
      for (let i = 1; i < e.gears.length; i++) if (e.gears[i] >= e.gears[i - 1]) warnings.push(`engine.gears[${i}] (${e.gears[i]}) is not lower than the gear before it — the box will not shift up`)
    }
    if (!Number.isFinite(e.final_drive) || e.final_drive <= 0) errors.push('engine.final_drive must be a positive number')
    if (!Number.isFinite(e.redline_rpm) || e.redline_rpm <= 0) errors.push('engine.redline_rpm must be a positive number')
    else if (e.idle_rpm >= e.redline_rpm) errors.push(`engine.idle_rpm ${e.idle_rpm} is not below the redline ${e.redline_rpm}`)
    if (!Number.isFinite(e.brake_bias) || e.brake_bias < 0 || e.brake_bias > 1) errors.push('engine.brake_bias must be between 0 and 1')
  }

  // the wheels
  if (v.wheels?.from_rig && opts.rigWheels !== undefined && opts.rigWheels < 4) {
    warnings.push(`the rig binds ${opts.rigWheels} wheel bone${opts.rigWheels === 1 ? '' : 's'}; this car needs four (FL, FR, RL, RR) or its wheels will not turn and nothing else will say so`)
  }
  if (!Number.isFinite(v.wheels?.steer_max_deg) || v.wheels.steer_max_deg <= 0) errors.push('wheels.steer_max_deg must be a positive number')
  else if (v.wheels.steer_max_deg > 60) warnings.push(`wheels.steer_max_deg ${v.wheels.steer_max_deg}° is past what a road car's rack reaches`)

  if (opts.audioSetups && v.audio?.setup && !opts.audioSetups.includes(v.audio.setup)) {
    warnings.push(`audio.setup ${JSON.stringify(v.audio.setup)} is not an enginesim configuration this build has`)
  }

  if (e && Number.isFinite(e.final_drive)) {
    if (e.final_drive < FINAL_DRIVE_MIN || e.final_drive > FINAL_DRIVE_MAX) {
      errors.push(`engine.final_drive ${e.final_drive.toFixed(2)} is outside ${FINAL_DRIVE_MIN}…${FINAL_DRIVE_MAX} — no differential is geared like that, so the top speed it came from is not reachable`)
    }
  }

  if (s && Number.isFinite(s.weightFront) && (s.weightFront! < 0.2 || s.weightFront! > 0.8)) {
    errors.push(`spec.weightFront ${s.weightFront} is outside 0.2…0.8 — that is past anything with four wheels on the ground`)
  }
  for (const [name, mm] of [['tyreFront_mm', s?.tyreFront_mm], ['tyreRear_mm', s?.tyreRear_mm]] as const) {
    if (mm === undefined) continue
    if (!Number.isFinite(mm) || mm <= 0) errors.push(`spec.${name} must be a positive number of millimetres`)
    else if (mm < 80 || mm > 600) warnings.push(`spec.${name} is ${mm} mm, which is not a tyre anybody fits`)
  }

  /*
   * MOUNTED WEAPONS. An empty id is a picker somebody opened and did not fill in, which is an
   * error; a name this build has never heard of is a weapon that silently does nothing, which is
   * worse and is only checkable when the caller passes the armoury.
   */
  for (const [i, m] of (v.mounts ?? []).entries()) {
    if (!m.weapon) errors.push(`mounts[${i}] has no weapon chosen`)
    else if (opts.weapons && !opts.weapons.includes(m.weapon)) errors.push(`mounts[${i}] names ${JSON.stringify(m.weapon)}, which is not a built weapon`)
    if (!(VEHICLE_MOUNTS as readonly string[]).includes(m.at)) errors.push(`mounts[${i}].at is ${JSON.stringify(m.at)}; it must be one of ${VEHICLE_MOUNTS.join(', ')}`)
    if (m.yaw_deg !== undefined && !Number.isFinite(m.yaw_deg)) errors.push(`mounts[${i}].yaw_deg must be a number`)
  }
  for (const k of ['gun_yaw_deg', 'gun_pitch_deg', 'missile_yaw_deg', 'missile_pitch_deg'] as const) {
    const val = v.turret?.[k]
    if (val !== undefined && !(Number.isFinite(val) && val >= 0 && val <= 180)) errors.push(`turret.${k} must be a number from 0 (fixed) to 180`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/* ---- the arithmetic: a document becomes something the engine can drive ------------------------ */

/**
 * Peak crank torque, N·m.
 *
 * Exact when the document states it. Otherwise ESTIMATED, and the estimate is stated rather than
 * hidden: peak torque on a naturally-aspirated engine usually lands near 70–80% of the rev range, so
 * `T = P / ω` evaluated there. It is within about 10% for most road engines and it is wrong for a
 * turbo diesel, which is exactly why `torque_nm` is a field somebody can fill in.
 */
export function peakTorque(e: VehicleEngine): { nm: number; estimated: boolean } {
  if (Number.isFinite(e.torque_nm) && (e.torque_nm as number) > 0) return { nm: e.torque_nm as number, estimated: false }
  const rpm = Math.max(1, e.redline_rpm * 0.75)
  return { nm: (e.power_kw * 1000) / ((rpm * 2 * Math.PI) / 60), estimated: true }
}

/**
 * The force the tyres could push with in first gear, N. Exact, given the torque.
 *
 * `T × gear × final / r` is the whole of it, and it is the number that decides whether a car pulls
 * away or bogs down. Note it says nothing about whether the tyres can HOLD that force — the engine's
 * vehicle spends a friction circle and refuses what is past it, which is where wheelspin comes from.
 */
export function tractiveForce(e: VehicleEngine, wheelRadius: number, gear = 0): number {
  const g = e.gears[Math.min(gear, e.gears.length - 1)] ?? 1
  return (peakTorque(e).nm * g * e.final_drive) / Math.max(0.05, wheelRadius)
}

/**
 * Top speed from the gearing, m/s. Exact.
 *
 * Redline in top gear, which is what the gearbox actually permits — so changing the final drive
 * changes the top speed, instead of the gearing being decoration beside a number somebody typed.
 * The car may not REACH it: the engine's model tapers drive against speed and drag, so top speed in
 * play is where those balance, and this is the ceiling the gearbox puts above that.
 */
export function gearedTopSpeed(e: VehicleEngine, wheelRadius: number): number {
  const top = e.gears[e.gears.length - 1] ?? 1
  const wheelRps = e.redline_rpm / 60 / (top * e.final_drive)
  return wheelRps * 2 * Math.PI * wheelRadius
}

/**
 * How far the suspension gives under the car's own weight at rest, m.
 *
 * Rapier's raycast vehicle is Bullet's, and Bullet's suspension force is
 * `stiffness × compression × chassisMass`. At rest each of four wheels carries `mass × g / 4`, so
 *
 *     stiffness × δ × mass = mass × g / 4      →      δ = g / (4 × stiffness)
 *
 * and the MASS CANCELS: a bus and a hatchback on the same springs sag the same, which is wrong about
 * real cars and is what Bullet does. Checked against a built car rather than taken on trust — the
 * closed form and the settled body agree to about 5 mm (test/vehicles.test.ts).
 *
 * This matters because it is the difference between a car sitting where the document said and a car
 * sitting several centimetres into the road with nothing saying so.
 */
export function suspensionSag(p: DriveProfile): number {
  return 9.81 / (4 * Math.max(1e-3, p.suspensionStiffness))
}

/**
 * Where the chassis' origin sits above the road at rest, m.
 *
 * THE BODY IS POSITIONED BY ITS RIDE HEIGHT, NOT BY ITS SUSPENSION. That is the whole of this
 * function and getting it the other way round is a real bug that this code had: pinning the axle
 * mounts to the bottom of the chassis box (`axleY = -halfHeight`) and letting the spring's rest
 * length set the body's height puts a 1.35 m car's floor 0.66 m above the road — sills at knee
 * height — and then drags the centre of gravity out of the shell, where `toVehicleSpec` has to clamp
 * it. Measured: a hero-car asking for a 0.52 m CG settled at 0.67 m.
 *
 * So the body sits at `rideHeight + halfHeight`, which is a fact about how the car LOOKS, and
 * `axleYOf` then works out where the suspension has to hang to put the wheels on the road.
 */
export function originHeight(spec: VehicleChassis, _p: DriveProfile, halfHeight: number): number {
  return (spec.rideHeight ?? 0.16) + halfHeight
}

/**
 * Where the suspension mounts sit, relative to the body origin, m.
 *
 * Chosen so that at rest — with the spring already given up its `suspensionSag` — the wheel centres
 * are exactly `wheelRadius` above the road and the contact patches are on it. Everything else
 * follows: get this wrong and the car either floats or starts the simulation with its springs
 * fully compressed, and both look like a physics bug rather than an arithmetic one.
 */
export function axleYOf(spec: VehicleChassis, p: DriveProfile, halfHeight: number): number {
  return spec.wheelRadius + p.suspensionRest - suspensionSag(p) - originHeight(spec, p, halfHeight)
}

/**
 * The document, as the engine's `VehicleSpec`.
 *
 * The conversions worth knowing about:
 *
 *   `mass`       → `massKg`, unchanged.
 *   `length/width/height` → half-extents. Defaulted from the class when the model has not said, and
 *                  `height` is the BODY, not the roofline over the wheels.
 *   `cgHeight`   → `comY`, which is body-RELATIVE. This is the conversion, and it is clamped into
 *                  the box: a CG outside the shell it belongs to is a car that behaves like a
 *                  pendulum, and a typo of 5.2 for 0.52 would otherwise do exactly that silently.
 *   `wheelRadius`, `wheelbase`, `track` pass through.
 */
export function toVehicleSpec(v: VehicleDoc, p: DriveProfile = toDriveProfile(v)): VehicleSpec {
  const s = v.spec
  const halfLength = (s.length ?? s.wheelbase * 1.6) / 2
  const halfWidth = (s.width ?? s.track * 1.2) / 2
  const halfHeight = (s.height ?? 1.4) / 2
  const origin = originHeight(s, p, halfHeight)
  // CG above the road, minus where the origin is: the CG in the body's own frame.
  const comY = Math.max(-halfHeight, Math.min(halfHeight, s.cgHeight - origin))
  return {
    massKg: s.mass,
    halfLength,
    halfHeight,
    halfWidth,
    // WHERE THE MASS SITS ALONG THE CAR. Forward is +X, the axles are half a wheelbase either side
    // of the middle, so a car with `f` of its weight on the front has its centre of mass at
    // `wheelbase × (f − ½)`. 50/50 gives zero, which is what this was before and why nothing about
    // a nose-heavy car behaved like one.
    comX: s.wheelbase * (frontShare(s) - 0.5),
    comY,
    wheelbase: s.wheelbase,
    track: s.track,
    wheelRadius: s.wheelRadius,
    axleY: axleYOf(s, p, halfHeight),
  }
}

/**
 * The document, as a `DriveProfile`.
 *
 * Base, then blend, then this car's own overrides, then the things the chassis and the engine are
 * entitled to decide — in that order, because an override somebody typed must beat a number derived
 * from a spec sheet, and both must beat the preset.
 */
export function toDriveProfile(v: VehicleDoc): DriveProfile {
  let p = profile(v.profile.base)
  if (v.profile.blendWith && PROFILES[v.profile.blendWith] && Number.isFinite(v.profile.blend)) {
    // imported lazily at the top; kept as a separate step so the order above reads as written
    p = blend(p, PROFILES[v.profile.blendWith], Math.max(0, Math.min(1, v.profile.blend as number)))
  }
  const derived: Partial<DriveProfile> = {}
  if (v.spec?.drive) derived.drive = v.spec.drive
  if (v.engine && v.spec?.wheelRadius > 0 && v.spec?.mass > 0) {
    // Force per kilogram, which is what the profile speaks: the profile's `powerPerKg` is an
    // acceleration in m/s², and first-gear tractive force over mass is exactly that.
    derived.powerPerKg = tractiveForce(v.engine, v.spec.wheelRadius) / v.spec.mass
    derived.topSpeed = gearedTopSpeed(v.engine, v.spec.wheelRadius)
    // The spec's brake torque, as an acceleration. Rapier then quarters it across the wheels.
    // Taken raw, a road car comes out around 4 m/s² against an accel near 11 — the pedal goes
    // to the floor and the car barely slows. Three times the spec matches the accel the same
    // sheet implies, and it is still THIS car's number, not the profile's.
    derived.brakePerKg = 3 * v.engine.brake_torque_nm / Math.max(0.05, v.spec.wheelRadius) / v.spec.mass
  }
  /*
   * GRIP PER AXLE, from the weight it carries and the rubber under it.
   *
   * The profile's `gripFront`/`gripRear` say what the GAME is like — Crazy Taxi at 2.8, the
   * simulator at 1.35 — and this scales them by what the CAR is like. A 60/40 saloon on equal
   * tyres comes out with about 10% less grip at the front than the rear, which is understeer
   * arriving from the spec sheet rather than from somebody typing a handling opinion.
   *
   * The profile still sets the LEVEL — every scale here is against this car on ordinary tyres with
   * its weight in the middle, so a 12-tonne bus is not punished for being a bus.
   */
  const g = axleGrip(v.spec)
  derived.gripFront = (p.gripFront ?? 1) * g.front
  derived.gripRear = (p.gripRear ?? 1) * g.rear
  if (v.wheels?.steer_max_deg > 0) derived.steerMax = (v.wheels.steer_max_deg * Math.PI) / 180
  return { ...p, ...derived, ...(v.profile.overrides as Partial<DriveProfile>), id: `${v.profile.base}:vehicle` }
}

/** `blendProfiles`, re-exported through a local name so the order of operations above reads clean. */
function blend(a: DriveProfile, b: DriveProfile, t: number): DriveProfile {
  const out = { ...(t < 0.5 ? a : b) }
  for (const k of Object.keys(a) as (keyof DriveProfile)[]) {
    const av = a[k]
    const bv = b[k]
    if (typeof av === 'number' && typeof bv === 'number') (out[k] as number) = av + (bv - av) * t
  }
  return out
}

/**
 * What the drivetrain means for the corridor's engine-sound knobs.
 *
 * `enginesound.ts` drives a voice from `rpm` and `pedal` alone, and works out rpm from road speed
 * through ENGINE_GEAR_* and ENGINE_FINAL_DRIVE. This is the same numbers, per vehicle, so a bus
 * does not sound like a hot hatch because both read one global gearbox.
 */
export function toEngineTuning(v: VehicleDoc): Record<string, number> {
  const e = v.engine
  const out: Record<string, number> = {
    ENGINE_FINAL_DRIVE: e.final_drive,
    ENGINE_TYRE_RADIUS: v.spec.wheelRadius,
    ENGINE_IDLE_RPM: e.idle_rpm,
    ENGINE_REDLINE_RPM: e.redline_rpm,
    // Shift points as fractions of the range rather than absolutes, so a 2400 rpm diesel and a 7200
    // rpm petrol both shift where they should instead of one of them never shifting at all.
    ENGINE_SHIFT_UP_RPM: e.idle_rpm + (e.redline_rpm - e.idle_rpm) * 0.85,
    ENGINE_SHIFT_DOWN_RPM: e.idle_rpm + (e.redline_rpm - e.idle_rpm) * 0.35,
    ENGINE_VOLUME: v.audio.gain,
    ENGINE_HF_CUTOFF: v.audio.lowpass_hz,
  }
  for (let i = 0; i < 6; i++) out[`ENGINE_GEAR_${i + 1}`] = e.gears[i] ?? 0
  return out
}

/**
 * The CG height a BUILT car actually settled at, m above its own contact patches.
 *
 * The other half of `toVehicleSpec`'s stated assumption: ask the car rather than the arithmetic. The
 * editor shows this beside the number somebody typed, and a probe asserts they agree — which is the
 * only way a unit mistake in `cgHeight` fails early instead of as "it rolls over too easily" three
 * weeks later.
 */
export function cgHeightOf(body: { translation(): { y: number } }, spec: VehicleSpec, groundY: number): number {
  return body.translation().y + (spec.comY ?? 0) - groundY
}

/** A one-line summary for the list: what this car is, in the words a person would use. */
export function describeVehicle(v: VehicleDoc): string {
  const hp = Math.round(v.engine.power_kw * 1.341)
  /*
   * THE SPEED IT REACHES, not the speed its top gear allows.
   *
   * These are not close. A supercar's seventh is geared for 365 mph at the redline — real gearsets
   * are, because nobody holds seventh to the limiter — while the profile's drag and `topSpeed` stop
   * it at 139. Showing the geared figure on a card put "365 mph" beside a road car, which is the
   * kind of number that makes somebody distrust every other number next to it.
   */
  const mph = Math.round(effectiveTopSpeed(v) * 2.237)
  return `${v.spec.mass} kg · ${hp} hp · ${v.spec.drive.toUpperCase()} · ${v.engine.gears.length}-speed · ${mph} mph · ${v.profile.base}`
}

/**
 * The speed it actually reaches, m/s: the lower of what the gearbox allows and what the power can
 * push through the air.
 *
 * NOT `toDriveProfile(v).topSpeed` — that field is DERIVED from the gearbox (see above), so it is
 * the same 365 mph and asking it cannot catch this. The limit that bites is drag: at a steady speed
 * all the power goes into it, so `P = drag·m·v³` and the top speed is the cube root. That is one
 * line of physics with no fudge in it, and it puts the presets where a person would expect — a
 * supercar at 178, a kei at 87, a bus at 71.
 */
export function effectiveTopSpeed(v: VehicleDoc): number {
  const geared = gearedTopSpeed(v.engine, v.spec.wheelRadius)
  const p = toDriveProfile(v)
  const dragged = p.dragPerKg > 0 && v.spec.mass > 0
    ? Math.cbrt((v.engine.power_kw * 1000) / (p.dragPerKg * v.spec.mass))
    : geared
  return Math.min(geared, dragged)
}

/**
 * Where a car really runs out of speed, m/s — the balance the SIMULATION solves, not the card's
 * constant-power cube root.
 *
 * `effectiveTopSpeed` above is the honest "all the power goes into the air" law, `P = drag·m·v³`, but
 * it leaves out the two things that bind in play. The engine force does not fade to nothing at the
 * profile's `topSpeed` — it floors at 15% of `powerPerKg` — and the tyres cap what can be put down:
 * each driven wheel passes at most `frictionSlip × load`, and downforce raises that load with speed.
 * On a car whose tyres are the limiter the wall is
 *
 *     grip · axleShare · (m·g + downforce·m·v²) = drag·m·v²
 *
 * which has no power in it at all — which is exactly why "max power" stops mattering past a point.
 *
 * So this solves `min(engine, traction) = drag` and returns the speed. It is an ESTIMATE: weight
 * transfer, the friction circle's side share and the road's own grip are left out, and the sim's
 * per-wheel suspension load is approximated by the static axle share. But it is the number to gear
 * top gear for, so the engine is at the redline at the speed the car actually reaches.
 */
export function estimateVmax(v: VehicleDoc): number {
  // A malformed document has no speed to give: the arithmetic below does not read mass or wheel
  // radius (both cancel), so the guard for them lives here rather than in the profile maths.
  if (!(v.spec.mass > 0) || !(v.spec.wheelRadius > 0)) return 0
  return vmaxFromProfile(toDriveProfile(v), frontShare(v.spec))
}

/** The memo for `vmaxFromProfile`. One entry is the whole cache: a live caller asks about the car it
 *  is driving right now, and asks again only when a knob moves. */
let vmaxKey = ''
let vmaxVal = 0

/**
 * `estimateVmax`'s arithmetic, over a `DriveProfile` rather than a document, and MEMOISED.
 *
 * The F6 auto-gear switch calls this on every tuning change (a probe may call it every frame), and
 * it is a handful of `Math.sqrt`s over the same numbers until a knob moves. The key is every number
 * the arithmetic reads, so any knob that can move the wall misses the cache and the rest return the
 * last answer without solving anything.
 */
export function vmaxFromProfile(p: DriveProfile, front: number): number {
  const key = `${p.drive}|${p.powerPerKg}|${p.topSpeed}|${p.gripFront}|${p.gripRear}|${p.dragPerKg}|${p.downforcePerKg}|${front}`
  if (key === vmaxKey) return vmaxVal
  vmaxKey = key
  vmaxVal = computeVmax(p, front)
  return vmaxVal
}

function computeVmax(p: DriveProfile, front: number): number {
  if (!(p.topSpeed > 0) || !(p.powerPerKg > 0)) return 0
  // No drag is a legitimate tune (the F6 slider's floor), and with nothing slowing the car the wall
  // is the limiter itself — `topSpeed` is exactly what that field means.
  if (!(p.dragPerKg > 0)) return p.topSpeed
  const g = 9.81
  const share = p.drive === 'fwd' ? front : p.drive === 'awd' ? 1 : 1 - front
  const grip = p.drive === 'fwd'
    ? p.gripFront
    : p.drive === 'awd'
      ? p.gripFront * front + p.gripRear * (1 - front)
      : p.gripRear
  const down = p.downforcePerKg ?? 0

  // the tyres: where drag catches the grip-and-downforce cap on the driven axle
  const capDen = p.dragPerKg - grip * share * down
  const vCap = capDen > 0 ? Math.sqrt((grip * share * g) / capDen) : Infinity

  // the engine: the taper balance, or its 15% floor when that balance would sit below the floor
  const taper2 = p.powerPerKg / (p.dragPerKg + p.powerPerKg / (p.topSpeed * p.topSpeed))
  const vEng = taper2 <= 0.85 * p.topSpeed * p.topSpeed
    ? Math.sqrt(taper2)
    : Math.sqrt((0.15 * p.powerPerKg) / p.dragPerKg)

  const vmax = Math.min(vCap, vEng)
  return Number.isFinite(vmax) ? vmax : 0
}

/* ---- decisions the form makes, extracted so they can be tested without a browser --------------- */

/**
 * How many bones drive the wheels, from the two things that can answer — and they are NOT the same
 * kind of answer.
 *
 * `bound` is `AssetItem.rig.roles.wheel`, a `string[]`: the bones somebody SAID are the wheels, in
 * the rig editor. Authoritative, stored with the asset, and present whether or not a preview is up.
 *
 * `guessed` is `MeshView.rig().roles.wheel`, a `number`: how many bones the viewer recognised from
 * their NAMES. A count, not names, and only while a preview is open.
 *
 * Mixing the two up is a real bug and it happened here: reading `.length` off the guess gives
 * `undefined` on every asset, so the four-wheel warning silently never fires. Hence this function
 * and the test beside it.
 *
 * `undefined` — neither answered — is NOT zero. "We cannot tell" reported as "this car has no
 * wheels" would put a red warning on every asset whose preview happens to be shut.
 */
export function wheelBoneCount(bound: string[] | undefined | null, guessed: number | undefined | null): { count: number | undefined; guessed: boolean } {
  if (bound) return { count: bound.length, guessed: false }
  if (typeof guessed === 'number') return { count: guessed, guessed: true }
  return { count: undefined, guessed: false }
}

/**
 * The range a generated override slider should span, around the profile's own value.
 *
 * The engine declares no bounds for these forty numbers and inventing forty pairs by hand is forty
 * more things to get wrong, so the range is derived: symmetric about zero for a value that can go
 * negative, zero-based otherwise, and always wide enough to be worth dragging even when the default
 * is zero (`airPitch` on the ground profiles is 0, and a slider from 0 to 0 is a dead control).
 */
export function overrideRange(def: number): { min: number; max: number; step: number } {
  const span = Math.max(Math.abs(def) * 2, 1)
  return { min: def >= 0 ? 0 : -span, max: span, step: span / 200 }
}

/* ---- the gearbox as a thing you set by its RESULT ---------------------------------------------- */

/** The final drive that would make this gearbox reach `topSpeed` m/s at the redline in top. */
export function finalDriveFor(e: VehicleEngine, wheelRadius: number, topSpeed: number): number {
  const top = e.gears[e.gears.length - 1]
  if (!(top > 0) || !(wheelRadius > 0) || !(topSpeed > 0) || !(e.redline_rpm > 0)) return e.final_drive
  return ((e.redline_rpm / 60) * 2 * Math.PI * wheelRadius) / (top * topSpeed)
}

/**
 * What a final drive may be before it is a mistake rather than a choice.
 *
 * Rich, 2026-09-29: *"if you edit it will change the final drive ratio to match, and bound it as an
 * error condition if it is out of bounds"*. The bounds are real gearsets: a long-legged GT sits
 * near 2.6, an ordinary car 3.5 to 4.1, a hot hatch 4.4, a truck's differential 5 to 7. Outside
 * 1.5…12 the number is not a car any more — usually because a top speed was typed with the wrong
 * unit — so it is an error, not a warning.
 */
export const FINAL_DRIVE_MIN = 1.5
export const FINAL_DRIVE_MAX = 12

/**
 * Lay out `count` gears between the lowest and the highest, keeping both ends.
 *
 * Rich: *"when adding gears rebalance the other gears between the low and high gear. Removing gears
 * do the same."* A GEOMETRIC progression, because that is what a real gearbox is: each shift is the
 * same PROPORTIONAL drop in ratio, so the engine falls to the same rpm every time you change up.
 * Spacing them arithmetically instead gives a box that drops 2000 rpm on the 1–2 shift and 400 on
 * the 5–6, which is the thing everybody notices and nobody can name.
 */
export function rebalanceGears(gears: number[], count: number): number[] {
  const n = Math.max(1, Math.round(count))
  const first = gears[0]
  const last = gears[gears.length - 1]
  if (!(first > 0) || !(last > 0)) return gears.slice(0, n)
  if (n === 1) return [+first.toFixed(3)]
  if (n === 2) return [+first.toFixed(3), +last.toFixed(3)]
  const step = (last / first) ** (1 / (n - 1))
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(+(first * step ** i).toFixed(3))
  // the ends are the ones somebody chose, so they are not left to rounding
  out[0] = +first.toFixed(3)
  out[n - 1] = +last.toFixed(3)
  return out
}

/* ---- weight, rubber and what each axle can hold ------------------------------------------------ */

/** The share on the front axle, defaulted and clamped to something a car could be. */
export function frontShare(s: VehicleChassis): number {
  const f = s.weightFront
  if (!Number.isFinite(f)) return 0.5
  return Math.max(0.2, Math.min(0.8, f as number))
}

/** The tyre everything is measured against: an ordinary 225-section road tyre. */
export const TYRE_REFERENCE_MM = 225

/**
 * The grip multiplier for each axle, from load sensitivity.
 *
 * A tyre's coefficient of friction FALLS as the load on it rises — doubling the load on a tyre does
 * not double the grip it returns — so the axle carrying more of the car has less grip per kilogram
 * of it. That single fact is where understeer, weight transfer under braking and the point of a
 * staggered tyre set all come from, so it is worth having the real shape of it rather than a table
 * of handling adjectives.
 *
 * `μ ∝ (load per mm of tread)^−¼`. The quarter power is a fit, not a law — published tyre data puts
 * the exponent between about 0.15 and 0.35 depending on construction — and it is clamped either
 * side, because the honest range of this model is ordinary cars and nothing stops somebody typing a
 * 10 mm tyre on a bus.
 *
 * THE REFERENCE IS THIS CAR ON 225s, 50/50 — not a fixed 1400 kg car. That matters: measured
 * against a fixed car a bus would come out at the bottom clamp on both axles and slide everywhere,
 * which is a statement about the game's grip level, and the game's grip level is the profile's job.
 * Measured against itself, a heavier car is not punished for being heavy, a 60/40 split moves grip
 * to the light end, and fitting wider rubber all round is worth a real but modest gain — 305s
 * everywhere come out about 8% up, which is roughly what they are worth.
 */
export function axleGrip(s: VehicleChassis): { front: number; rear: number } {
  const f = frontShare(s)
  const mass = Number.isFinite(s.mass) && s.mass > 0 ? s.mass : 1400
  const reference = mass / (4 * TYRE_REFERENCE_MM)
  const scale = (share: number, widthMm: number | undefined) => {
    const w = Number.isFinite(widthMm) && (widthMm as number) > 0 ? (widthMm as number) : TYRE_REFERENCE_MM
    const perMm = (mass * share) / (2 * w)
    return Math.max(0.7, Math.min(1.35, (reference / perMm) ** 0.25))
  }
  return { front: scale(f, s.tyreFront_mm), rear: scale(1 - f, s.tyreRear_mm) }
}

/* ---- mounted weapons --------------------------------------------------------------------------- */

/**
 * WHERE A WEAPON GOES ON A CAR.
 *
 * Rich, 2026-09-29: *"we will be attaching weapons to both actors and cars"*. An actor already has
 * somewhere to put one — a bone role on its rig, which is what `WeaponDoc.attach` names. A car has
 * no rig, and almost none of the library's cars have a skeleton at all, so the answer cannot be a
 * bone.
 *
 * It is also not a typed-in offset. Three numbers per mount, per car, in metres, in a frame most
 * people would have to be told about (forward +X, up +Y, right +Z, origin at the middle of the
 * body) is four chances to put a minigun inside the engine bay, and it is exactly the mistake the
 * hand-typed width tables were. So a mount is a NAMED PLACE and the offset is derived from the
 * chassis the document already carries: change the car's length and the nose gun moves with it.
 */
export const VEHICLE_MOUNTS = ['nose', 'bonnet', 'roof', 'boot', 'tail', 'left', 'right', 'underbody'] as const
export type VehicleMount = (typeof VEHICLE_MOUNTS)[number]

export interface MountedWeapon {
  /** the id of a built weapon — `builds('weapons')`, not a catalog row */
  weapon: string
  at: VehicleMount
  /** degrees clockwise from straight ahead, for a gun that does not point forward */
  yaw_deg?: number
}

/**
 * The offset of a named mount in the chassis frame, metres.
 *
 * Forward +X, up +Y, right +Z, origin at the centre of the collider — the same frame
 * `toVehicleSpec` builds, so this lands where the physics body actually is rather than where the
 * model happens to have been exported.
 */
export function mountPoint(v: VehicleChassis, at: VehicleMount): { x: number; y: number; z: number } {
  const hl = (v.length ?? v.wheelbase * 1.6) / 2
  const hw = (v.width ?? v.track * 1.2) / 2
  const hh = (v.height ?? 1.4) / 2
  switch (at) {
    case 'nose': return { x: hl, y: 0, z: 0 }
    case 'bonnet': return { x: hl * 0.55, y: hh, z: 0 }
    case 'roof': return { x: 0, y: hh, z: 0 }
    case 'boot': return { x: -hl * 0.6, y: hh, z: 0 }
    case 'tail': return { x: -hl, y: 0, z: 0 }
    case 'left': return { x: 0, y: 0, z: -hw }
    case 'right': return { x: 0, y: 0, z: hw }
    case 'underbody': return { x: 0, y: -hh, z: 0 }
  }
}

/** Which way a mounted weapon points, as a yaw in radians in the chassis frame. */
export function mountYaw(m: MountedWeapon): number {
  const deg = m.yaw_deg ?? (m.at === 'left' ? -90 : m.at === 'right' ? 90 : m.at === 'tail' ? 180 : 0)
  return (deg * Math.PI) / 180
}
