// A dozen cars to start from, so nobody types forty numbers to make one.
//
// Rich, 2026-09-29: *"The catalog is for visuals, a vehicle is a visual plus the dynamics, layout,
// physics, configuration... we need a workflow to create a new vehicle -> choose from vehicle assets
// with filtering and search -> attach dynamics (maybe come up with a dozen presets we can chose from
// and also we need a presets manager)."*
//
// THE CORRECTION THIS FILE IS PART OF. The Vehicles screen used to be the catalog filtered to
// vehicle classes, which meant 120 unconfigured prop cars presented as if they were vehicles. They
// are not: a **vehicle** is a crafted thing — a chosen visual plus dynamics, layout and
// configuration — and there will be a dozen of them, not a hundred and twenty. These are the
// starting points for making one.
//
// WHAT A PRESET IS HERE, AND HOW IT DIFFERS FROM `presets.ts`. The world-look presets are a flat map
// of TUNING KNOBS captured off the live panel, because a look is "whatever the renderer is doing
// right now". A vehicle preset is a whole `VehicleDoc`: a chassis, a handling profile, a drivetrain
// and an engine voice, which is a description rather than a capture. Same envelope shape (`kind`,
// `version`, a list), deliberately, so the two read as siblings and an export of either is
// recognisable.
//
// THE NUMBERS ARE REAL CARS, ROUNDED. Every row is a recognisable thing — a hot hatch, a muscle car,
// a box truck — with the mass, power, gearing and final drive that class actually has, so a person
// picking "muscle" gets something that behaves like one before they touch a slider. They are NOT
// measurements of any particular car and they are not meant to be; they are a believable middle of
// their class, and the editor exists for the rest.
//
// The handling PROFILE on each is a default, not a claim: `street` for almost everything, because
// the profile is a fact about the GAME and a level overrides it. A rally car gets `rush` because a
// loose, jumpable car is what the preset is for.

import type { VehicleDoc } from './vehicles'

export interface VehiclePreset {
  id: string
  name: string
  /** one line for the picker: what this is and when to reach for it */
  note: string
  /** which catalog classes it suits, for sorting the picker when a visual is already chosen */
  suits: string[]
  doc: VehicleDoc
}

function make(
  spec: VehicleDoc['spec'],
  base: string,
  engine: VehicleDoc['engine'],
  setup: string,
  steerMaxDeg = 34,
): VehicleDoc {
  return {
    spec,
    profile: { base, overrides: {} },
    engine,
    audio: { setup, gain: 0.8, lowpass_hz: 9000, cabin_mix: 0.35 },
    wheels: { from_rig: false, steer_max_deg: steerMaxDeg },
  }
}

/**
 * The dozen. Ordered light to heavy, which is how somebody scanning them thinks.
 *
 * `cgHeight` is the number that decides rollover and it is the one most worth getting roughly right
 * per class: a hot hatch sits at about 0.55 m, a pickup at 0.72, a box truck at 1.25. The stability
 * factor (half the track over the CG height) falls from about 1.4 to about 0.8 across this list,
 * which is exactly the range where a vehicle stops sliding and starts tipping.
 */
export const VEHICLE_PRESETS: VehiclePreset[] = [
  {
    id: 'motorcycle',
    name: 'Motorcycle',
    note: 'One headlight and one tail light, on the centreline.',
    suits: ['motorcycle', 'traffic'],
    doc: make(
      { mass: 190, wheelbase: 1.4, track: 0.18, cgHeight: 0.55, wheelRadius: 0.31, drive: 'rwd', length: 2.15, width: 0.75, height: 1.15, rideHeight: 0.14, headlights: 1, taillights: 1 },
      'street',
      { power_kw: 55, redline_rpm: 11000, idle_rpm: 1200, gears: [2.8, 2.0, 1.55, 1.25, 1.05, 0.9], final_drive: 3.2, brake_torque_nm: 800, brake_bias: 0.7 },
      'engines/atg-video-1/02_kohler_ch750.mr', 32,
    ),
  },
  {
    id: 'kei',
    name: 'Kei car',
    note: 'Tiny, light, barely any power. Everything feels fast at 30 mph.',
    suits: ['traffic', 'hero-car'],
    doc: make(
      { mass: 720, wheelbase: 2.4, track: 1.3, cgHeight: 0.52, wheelRadius: 0.28, drive: 'fwd', length: 3.4, width: 1.48, height: 1.5, rideHeight: 0.15 },
      'street',
      { power_kw: 47, redline_rpm: 7000, idle_rpm: 800, gears: [3.55, 1.9, 1.24, 0.9, 0.73], final_drive: 4.4, brake_torque_nm: 1200, brake_bias: 0.66 },
      'engines/atg-video-1/02_kohler_ch750.mr', 36,
    ),
  },
  {
    id: 'hot-hatch',
    name: 'Hot hatch',
    note: 'Light, front drive, eager. Lifts a rear wheel if you provoke it.',
    suits: ['hero-car', 'traffic'],
    doc: make(
      { mass: 1240, wheelbase: 2.6, track: 1.52, cgHeight: 0.55, wheelRadius: 0.31, drive: 'fwd', length: 4.1, width: 1.79, height: 1.44, rideHeight: 0.14 },
      'street',
      { power_kw: 147, redline_rpm: 6800, idle_rpm: 850, gears: [3.36, 2.09, 1.47, 1.1, 0.87, 0.72], final_drive: 3.94, brake_torque_nm: 2100, brake_bias: 0.65 },
      'engines/atg-video-1/05_honda_vtec.mr', 35,
    ),
  },
  {
    id: 'classic-roadster',
    name: 'Classic roadster',
    note: 'Light, rear drive, not much power and not much grip. Slides at sensible speeds.',
    suits: ['hero-car'],
    doc: make(
      { mass: 960, wheelbase: 2.3, track: 1.42, cgHeight: 0.46, wheelRadius: 0.3, drive: 'rwd', length: 3.9, width: 1.6, height: 1.22, rideHeight: 0.13 },
      'street',
      { power_kw: 96, redline_rpm: 7000, idle_rpm: 900, gears: [3.14, 1.89, 1.33, 1.0, 0.81], final_drive: 4.1, brake_torque_nm: 1600, brake_bias: 0.6 },
      'engines/atg-video-1/07_audi_i5.mr', 36,
    ),
  },
  {
    id: 'sports-saloon',
    name: 'Sports saloon',
    note: 'The default fast car. Rear drive, six speeds, balanced.',
    suits: ['hero-car', 'traffic'],
    doc: make(
      { mass: 1520, wheelbase: 2.76, track: 1.58, cgHeight: 0.52, wheelRadius: 0.33, drive: 'rwd', length: 4.62, width: 1.85, height: 1.42, rideHeight: 0.14 },
      'street',
      { power_kw: 210, redline_rpm: 7000, idle_rpm: 800, gears: [4.17, 2.34, 1.52, 1.14, 0.87, 0.69], final_drive: 3.46, brake_torque_nm: 2600, brake_bias: 0.63 },
      'engines/atg-video-2/03_2jz.mr',
    ),
  },
  {
    id: 'muscle',
    name: 'Muscle car',
    note: 'Heavy, rear drive, enormous torque and not enough tyre. Lights them up in three gears.',
    suits: ['hero-car'],
    doc: make(
      { mass: 1740, wheelbase: 2.9, track: 1.62, cgHeight: 0.54, wheelRadius: 0.34, drive: 'rwd', length: 4.9, width: 1.92, height: 1.38, rideHeight: 0.14 },
      'street',
      { power_kw: 336, torque_nm: 630, redline_rpm: 6200, idle_rpm: 700, gears: [2.97, 2.07, 1.43, 1.0, 0.71, 0.57], final_drive: 3.73, brake_torque_nm: 3000, brake_bias: 0.62 },
      'engines/atg-video-2/07_gm_ls.mr', 32,
    ),
  },
  {
    id: 'supercar',
    name: 'Supercar',
    note: 'All-wheel drive, enormous power, glued down. The one that makes a straight feel short.',
    suits: ['hero-car'],
    doc: make(
      { mass: 1480, wheelbase: 2.65, track: 1.68, cgHeight: 0.44, wheelRadius: 0.35, drive: 'awd', length: 4.5, width: 1.99, height: 1.16, rideHeight: 0.1 },
      'street',
      { power_kw: 449, torque_nm: 700, redline_rpm: 8500, idle_rpm: 950, gears: [3.13, 2.05, 1.52, 1.18, 0.94, 0.76, 0.62], final_drive: 3.08, brake_torque_nm: 4200, brake_bias: 0.6 },
      'engines/atg-video-2/10_lfa_v10.mr', 32,
    ),
  },
  {
    id: 'rally',
    name: 'Rally car',
    note: 'All-wheel drive, long travel, built to be thrown at things. Uses the Rush profile.',
    suits: ['hero-car'],
    doc: make(
      { mass: 1290, wheelbase: 2.5, track: 1.6, cgHeight: 0.55, wheelRadius: 0.33, drive: 'awd', length: 4.2, width: 1.82, height: 1.47, rideHeight: 0.22 },
      'rush',
      { power_kw: 224, torque_nm: 450, redline_rpm: 7500, idle_rpm: 1100, gears: [3.9, 2.4, 1.72, 1.3, 1.0], final_drive: 4.3, brake_torque_nm: 3000, brake_bias: 0.58 },
      'engines/atg-video-1/06_subaru_ej25.mr', 40,
    ),
  },
  {
    id: 'taxi',
    name: 'Taxi',
    note: 'A tired saloon with soft springs and a lot of miles on it.',
    suits: ['traffic', 'hero-car'],
    doc: make(
      { mass: 1680, wheelbase: 2.86, track: 1.56, cgHeight: 0.58, wheelRadius: 0.33, drive: 'fwd', length: 4.85, width: 1.82, height: 1.5, rideHeight: 0.16 },
      'street',
      { power_kw: 112, redline_rpm: 6000, idle_rpm: 700, gears: [3.3, 1.9, 1.24, 0.94, 0.75], final_drive: 3.8, brake_torque_nm: 2000, brake_bias: 0.66 },
      'engines/atg-video-2/04_60_degree_v6.mr',
    ),
  },
  {
    id: 'interceptor',
    name: 'Police interceptor',
    note: 'A heavy saloon with the suspension and brakes it should have had. Chases well.',
    suits: ['emergency', 'hero-car'],
    doc: make(
      { mass: 1950, wheelbase: 2.85, track: 1.62, cgHeight: 0.56, wheelRadius: 0.34, drive: 'awd', length: 5.0, width: 1.93, height: 1.5, rideHeight: 0.15 },
      'street',
      { power_kw: 269, redline_rpm: 6500, idle_rpm: 750, gears: [4.48, 2.87, 1.84, 1.41, 1.0, 0.74], final_drive: 3.39, brake_torque_nm: 3400, brake_bias: 0.64 },
      'engines/atg-video-2/06_even_fire_v6.mr',
    ),
  },
  {
    id: 'pickup',
    name: 'Pickup',
    note: 'Tall, rear drive, light over the back axle. Steps out on a wet roundabout.',
    suits: ['commercial-vehicle', 'hero-car'],
    doc: make(
      { mass: 2240, wheelbase: 3.65, track: 1.72, cgHeight: 0.72, wheelRadius: 0.38, drive: 'rwd', length: 5.9, width: 2.03, height: 1.95, rideHeight: 0.24 },
      'street',
      { power_kw: 291, torque_nm: 610, redline_rpm: 5800, idle_rpm: 650, gears: [4.7, 2.99, 2.15, 1.77, 1.45, 1.0, 0.85, 0.69], final_drive: 3.55, brake_torque_nm: 3600, brake_bias: 0.6 },
      'engines/atg-video-2/07_gm_ls.mr', 32,
    ),
  },
  {
    id: 'van',
    name: 'Panel van',
    note: 'Tall, empty, and rolls like it. The stability factor is the whole character.',
    suits: ['commercial-vehicle', 'emergency'],
    doc: make(
      { mass: 2350, wheelbase: 3.3, track: 1.74, cgHeight: 0.88, wheelRadius: 0.36, drive: 'rwd', length: 5.5, width: 2.03, height: 2.45, rideHeight: 0.24 },
      'street',
      { power_kw: 125, torque_nm: 405, redline_rpm: 4600, idle_rpm: 700, gears: [4.23, 2.36, 1.48, 1.0, 0.8, 0.67], final_drive: 3.9, brake_torque_nm: 2800, brake_bias: 0.6 },
      'engines/atg-video-2/05_odd_fire_v6.mr', 38,
    ),
  },
  {
    id: 'box-truck',
    name: 'Box truck',
    note: 'Eight tonnes, eight gears and a long stopping distance. Not a car.',
    suits: ['commercial-vehicle'],
    doc: make(
      { mass: 8200, wheelbase: 4.8, track: 2.0, cgHeight: 1.25, wheelRadius: 0.52, drive: 'rwd', length: 9.0, width: 2.5, height: 3.4, rideHeight: 0.32 },
      'street',
      { power_kw: 180, torque_nm: 900, redline_rpm: 2600, idle_rpm: 600, gears: [7.2, 4.2, 2.6, 1.7, 1.24, 1.0, 0.86, 0.78], final_drive: 4.3, brake_torque_nm: 9000, brake_bias: 0.55 },
      'engines/atg-video-2/07_gm_ls.mr', 40,
    ),
  },
  {
    id: 'bus',
    name: 'City bus',
    note: 'Twelve tonnes on a long wheelbase. Turns like a building.',
    suits: ['commercial-vehicle'],
    doc: make(
      { mass: 12400, wheelbase: 5.9, track: 2.1, cgHeight: 1.4, wheelRadius: 0.55, drive: 'rwd', length: 12.0, width: 2.55, height: 3.2, rideHeight: 0.3 },
      'street',
      { power_kw: 213, torque_nm: 1200, redline_rpm: 2400, idle_rpm: 600, gears: [6.7, 3.8, 2.3, 1.5, 1.0], final_drive: 4.6, brake_torque_nm: 13000, brake_bias: 0.5 },
      'engines/atg-video-2/07_gm_ls.mr', 44,
    ),
  },
]

export const VEHICLE_PRESET_IDS = VEHICLE_PRESETS.map((p) => p.id)

/** A preset by id, deep-copied so editing the vehicle you made does not edit the preset. */
export function presetDoc(id: string): VehicleDoc | null {
  const p = VEHICLE_PRESETS.find((x) => x.id === id)
  return p ? structuredClone(p.doc) : null
}

/** A preset by id. */
export function vehiclePreset(id: string): VehiclePreset | null {
  return VEHICLE_PRESETS.find((x) => x.id === id) ?? null
}

/**
 * The presets that suit a catalog class, best first, then the rest.
 *
 * For the picker AFTER a visual has been chosen: somebody who picked an ambulance should be offered
 * the van and the interceptor before the kei car — but still offered the kei car, because a preset
 * is a starting point and somebody may be making something odd on purpose.
 */
export function presetsFor(kind: string | null | undefined): VehiclePreset[] {
  if (!kind) return VEHICLE_PRESETS
  const fits = VEHICLE_PRESETS.filter((p) => p.suits.includes(kind))
  const rest = VEHICLE_PRESETS.filter((p) => !p.suits.includes(kind))
  return [...fits, ...rest]
}

/** The export envelope, the same shape `presets.ts` uses for the world-look library. */
export interface VehiclePresetDoc {
  kind: 'corridor-vehicle-presets'
  version: 1
  exported?: string
  presets: VehiclePreset[]
}
