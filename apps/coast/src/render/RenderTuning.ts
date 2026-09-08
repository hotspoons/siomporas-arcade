// Presentation constants. The game is designed on a 224-line logical screen
// (the classic arcade height); width follows the window's aspect.

import { tune, type TuneSection } from '@apex/engine/app/TunePanel'
export const LOGICAL_HEIGHT = 224
/** Vertical field of view for the pseudo-3D projection. */
export let FOV_DEG = 78
/** Camera height (m) and how far ahead of the camera the player car sits, per view. */
export const VIEWS = {
  chase: { camHeight: 4.4, playerAhead: 8.5, drawPlayer: true },
  cockpit: { camHeight: 1.35, playerAhead: 2.2, drawPlayer: false },
}
/** Exponential fog per metre of depth, modern / retro. */
export let FOG_MODERN = 0.0042
export let FOG_RETRO = 0.0052
/** Lane marker width (m) and dash length in segments. */
export let LANE_WIDTH = 0.28
export let RUMBLE_WIDTH = 1.6
/** Shoulder width beyond the rumble strip, metres. */
export let SHOULDER_WIDTH = 4.5
/** Guardrail height above the road, metres. */
export let RAIL_HEIGHT = 0.7
/** Night: brightness at the fringe vs in the headlight cone. */
export let NIGHT_AMBIENT = 0.32
export let HEADLIGHT_REACH = 120
/** Night with the headlights off: how much of the ambient remains (the arcade made you find the switch). */
export let LIGHTS_OFF_AMBIENT = 0.45
/** Roll model (Rad Mobile): a transient roll while the wheel is turning, plus a steady roll when you ride
 * up the outer lanes of a banked curve. The cockpit shows the whole roll; the horizon only a fraction. */
export let STEER_ROLL = 0.16
/** Cockpit roll per banked lane tier (radians); Rad Mobile-style stepped berms. */
export let BANK_ROLL = 0.085
/** How many outer lanes step up the bank before it plateaus. */
export let BANK_TIERS = 2
export let HORIZON_ROLL_SHARE = 0.3
/** Cockpit glass: droplets per second of rain, haze build-up per second, and the single wiper's sweep rate (sweeps/s). */
export let RAIN_DROPS_PER_SEC = 26
export let RAIN_HAZE_PER_SEC = 0.06
export let WIPER_RATE = 0.9
export const MAX_SPRITES = 1400
export const PLAYER_FRAMES = 7
/** Curve unit: authored curve values are in the classic 2000-unit road scale. */
export const CURVE_UNIT = 17 / 2000

export interface Palette {
  skyTop: number
  skyBottom: number
  sun: number
  fog: number
  grassA: number
  grassB: number
  roadA: number
  roadB: number
  rumbleA: number
  rumbleB: number
  lane: number
  far: number
  near: number
  /** Shoulder beyond the tarmac (sand, gravel, kerb). */
  shoulder: number
  rail: number
  clouds: number
  /** Sun position on the sky quad (0..1) and size multiplier; defaults to high right, small. */
  sunPos?: [number, number]
  sunSize?: number
}

export const PALETTES: Record<string, Palette> = {
  coast: { skyTop: 0x1a4a9a, skyBottom: 0x8fd0ff, sun: 0xfff1b0, fog: 0x9fd8ff, grassA: 0x3f9a3a, grassB: 0x3a8e35, roadA: 0x66666e, roadB: 0x6a6a72, rumbleA: 0xf5f5f5, rumbleB: 0xd93838, lane: 0xf4f4f4, far: 0x2e6aa8, near: 0x2f7fbf, shoulder: 0xd8c89a, rail: 0xd0d4dc, clouds: 0xffffff },
  canyon: { skyTop: 0x5a1f4a, skyBottom: 0xffa060, sun: 0xffe0a0, fog: 0xffb070, grassA: 0xb0703a, grassB: 0xa66835, roadA: 0x5c5a5a, roadB: 0x605e5e, rumbleA: 0xf0e0c0, rumbleB: 0xb03030, lane: 0xf0e8d8, far: 0x8a3a3a, near: 0xa8503c, shoulder: 0xc08858, rail: 0xb0a090, clouds: 0xffd0a0 },
  forest: { skyTop: 0x2a5aa0, skyBottom: 0xb0e0ff, sun: 0xffffe0, fog: 0xb8dcc8, grassA: 0x2f7a2c, grassB: 0x2a6f28, roadA: 0x585c60, roadB: 0x5c6064, rumbleA: 0xeeeeee, rumbleB: 0xc83030, lane: 0xf0f0f0, far: 0x1f4f6a, near: 0x1f5a3a, shoulder: 0x6a6a5a, rail: 0xa8b0b8, clouds: 0xb8c4cc },
  desert: { skyTop: 0x3a6ab0, skyBottom: 0xf8e8c0, sun: 0xffffff, fog: 0xf0e0b8, grassA: 0xd8b878, grassB: 0xd0b070, roadA: 0x6a6660, roadB: 0x6e6a64, rumbleA: 0xf8f0e0, rumbleB: 0xc84040, lane: 0xf8f0e0, far: 0xb08a5a, near: 0xc8a068, shoulder: 0xe0c890, rail: 0xc0b8a8, clouds: 0xffffff },
  night: { skyTop: 0x050515, skyBottom: 0x2a1a5a, sun: 0xffffff, fog: 0x1a1030, grassA: 0x142018, grassB: 0x101c14, roadA: 0x2a2c34, roadB: 0x2e3038, rumbleA: 0xc0c0d0, rumbleB: 0xa02838, lane: 0xe0e0ff, far: 0x18103a, near: 0x2a1a4a, shoulder: 0x3a3a48, rail: 0x8a90b0, clouds: 0x201838 },
  sunset: { skyTop: 0x5a0a2a, skyBottom: 0xffc020, sun: 0xffe070, fog: 0xffa040, grassA: 0x2a0a18, grassB: 0x24081a, roadA: 0x3a2a34, roadB: 0x3e2e38, rumbleA: 0xffd090, rumbleB: 0x8a1a2a, lane: 0xffe0a0, far: 0x120408, near: 0x1a060c, shoulder: 0x40182a, rail: 0x201018, clouds: 0xff8040, sunPos: [0.5, 0.36], sunSize: 3.4 },
  cliffs: { skyTop: 0x2050a0, skyBottom: 0xa8d8ff, sun: 0xfff4c0, fog: 0xa8d8f8, grassA: 0x6a8a40, grassB: 0x62823c, roadA: 0x606068, roadB: 0x64646c, rumbleA: 0xf0f0f0, rumbleB: 0xd04040, lane: 0xf4f4f4, far: 0x2a5a90, near: 0x3070a8, shoulder: 0x9a8a6a, rail: 0xd0d4dc, clouds: 0xffffff },
  plains: { skyTop: 0x2a70c8, skyBottom: 0xc8e8ff, sun: 0xffffff, fog: 0xd0e4f0, grassA: 0xc8b060, grassB: 0xc0a858, roadA: 0x626266, roadB: 0x66666a, rumbleA: 0xf0f0f0, rumbleB: 0xc84040, lane: 0xf0f0e0, far: 0x7a9a5a, near: 0x9ab060, shoulder: 0xb09860, rail: 0xc0c0c0, clouds: 0xffffff },
  storm: { skyTop: 0x080a14, skyBottom: 0x26303e, sun: 0xffffff, fog: 0x1a2028, grassA: 0x121a14, grassB: 0x0e160f, roadA: 0x2a2e34, roadB: 0x2e3238, rumbleA: 0xb8c0c8, rumbleB: 0x8a2a30, lane: 0xd8e0e8, far: 0x0c1016, near: 0x121a1c, shoulder: 0x2a2e2a, rail: 0x7a8290, clouds: 0x1a2028 },
  ridge: { skyTop: 0x2a5aa8, skyBottom: 0xb8d8f8, sun: 0xfff8e0, fog: 0xb8ccd8, grassA: 0x3a8a3a, grassB: 0x348234, roadA: 0x585c60, roadB: 0x5c6064, rumbleA: 0xeeeeee, rumbleB: 0xc83030, lane: 0xf0f0f0, far: 0x3a5a8a, near: 0x2a6a4a, shoulder: 0x7a7a60, rail: 0xa8b0b8, clouds: 0xe8eef4 },
  alpine: { skyTop: 0x244a80, skyBottom: 0xc8dcf0, sun: 0xffffff, fog: 0xc0d0e0, grassA: 0x5a8a4a, grassB: 0x548246, roadA: 0x505458, roadB: 0x54585c, rumbleA: 0xf0f0f0, rumbleB: 0xd03838, lane: 0xf0f0f0, far: 0x8a9ab0, near: 0x4a6a5a, shoulder: 0x8a8a80, rail: 0xc8ccd4, clouds: 0xd8dde4 },
}

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
export const RENDER_TUNE: TuneSection = {
  title: 'Render · camera, fog, road',
  keys: [
    tune('FOV_DEG', () => FOV_DEG, (v) => (FOV_DEG = v)),
    tune('FOG_MODERN', () => FOG_MODERN, (v) => (FOG_MODERN = v)),
    tune('FOG_RETRO', () => FOG_RETRO, (v) => (FOG_RETRO = v)),
    tune('LANE_WIDTH', () => LANE_WIDTH, (v) => (LANE_WIDTH = v)),
    tune('RUMBLE_WIDTH', () => RUMBLE_WIDTH, (v) => (RUMBLE_WIDTH = v)),
    tune('SHOULDER_WIDTH', () => SHOULDER_WIDTH, (v) => (SHOULDER_WIDTH = v)),
    tune('RAIL_HEIGHT', () => RAIL_HEIGHT, (v) => (RAIL_HEIGHT = v)),
    tune('NIGHT_AMBIENT', () => NIGHT_AMBIENT, (v) => (NIGHT_AMBIENT = v)),
    tune('HEADLIGHT_REACH', () => HEADLIGHT_REACH, (v) => (HEADLIGHT_REACH = v)),
    tune('LIGHTS_OFF_AMBIENT', () => LIGHTS_OFF_AMBIENT, (v) => (LIGHTS_OFF_AMBIENT = v)),
    tune('STEER_ROLL', () => STEER_ROLL, (v) => (STEER_ROLL = v)),
    tune('BANK_ROLL', () => BANK_ROLL, (v) => (BANK_ROLL = v), [0, 0.3], 0.005, 'cockpit roll per bank tier'),
    tune('BANK_TIERS', () => BANK_TIERS, (v) => (BANK_TIERS = v), [1, 4], 1),
    tune('HORIZON_ROLL_SHARE', () => HORIZON_ROLL_SHARE, (v) => (HORIZON_ROLL_SHARE = v)),
    tune('RAIN_DROPS_PER_SEC', () => RAIN_DROPS_PER_SEC, (v) => (RAIN_DROPS_PER_SEC = v)),
    tune('RAIN_HAZE_PER_SEC', () => RAIN_HAZE_PER_SEC, (v) => (RAIN_HAZE_PER_SEC = v)),
    tune('WIPER_RATE', () => WIPER_RATE, (v) => (WIPER_RATE = v)),
  ],
}
