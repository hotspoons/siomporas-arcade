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
/** Metres of beach between the shoulder and the water on shoreline segments. */
export let BEACH_WIDTH = 9
/** Tunnels: half-width of the bore (m), ceiling height (m), and how dark it is inside without headlights. */
export let TUNNEL_HALF_WIDTH = 13.5
export let TUNNEL_HEIGHT = 7.5
export let TUNNEL_DARK = 0.42
/** Banked curves: the road plane tilts about its centreline by this rise per lateral metre at bank 1 (0.4 ≈ 22°). */
export let BANK_SLOPE = 0.24
/** Terraces on the outer side above the tilted plane, each this wide (m) and this much higher (m at bank 1). */
export let BANK_TIER_W = 7
export let BANK_TIER_H = 1.8
export let BANK_TIER_COUNT = 0
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
/** Chase-camera bob amplitude (metres at 84 m/s). */
export let CAM_BOUNCE = 0.022
export let STEER_ROLL = 0.16
/** How much of the bank angle under the car the view rolls by (1 = the road reads level beneath you). */
export let BANK_ROLL = 1
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
  /** Shoreline colours (themes with `shore`). */
  sand?: number
  water?: number
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
  coast: { skyTop: 0x1a4a9a, skyBottom: 0x8fd0ff, sun: 0xfff1b0, fog: 0x9fd8ff, grassA: 0x3f9a3a, grassB: 0x3a8e35, roadA: 0x66666e, roadB: 0x6a6a72, rumbleA: 0xf5f5f5, rumbleB: 0xd93838, lane: 0xf4f4f4, far: 0x2e6aa8, near: 0x2f7fbf, shoulder: 0xd8c89a, rail: 0xd0d4dc, clouds: 0xffffff, sand: 0xe8d8a4, water: 0x2f86c8 },
  canyon: { skyTop: 0x5a1f4a, skyBottom: 0xffa060, sun: 0xffe0a0, fog: 0xffb070, grassA: 0xb0703a, grassB: 0xa66835, roadA: 0x5c5a5a, roadB: 0x605e5e, rumbleA: 0xf0e0c0, rumbleB: 0xb03030, lane: 0xf0e8d8, far: 0x8a3a3a, near: 0xa8503c, shoulder: 0xc08858, rail: 0xb0a090, clouds: 0xffd0a0 },
  forest: { skyTop: 0x2a5aa0, skyBottom: 0xb0e0ff, sun: 0xffffe0, fog: 0xb8dcc8, grassA: 0x2f7a2c, grassB: 0x2a6f28, roadA: 0x585c60, roadB: 0x5c6064, rumbleA: 0xeeeeee, rumbleB: 0xc83030, lane: 0xf0f0f0, far: 0x1f4f6a, near: 0x1f5a3a, shoulder: 0x6a6a5a, rail: 0xa8b0b8, clouds: 0xb8c4cc },
  desert: { skyTop: 0x3a6ab0, skyBottom: 0xf8e8c0, sun: 0xffffff, fog: 0xf0e0b8, grassA: 0xd8b878, grassB: 0xd0b070, roadA: 0x6a6660, roadB: 0x6e6a64, rumbleA: 0xf8f0e0, rumbleB: 0xc84040, lane: 0xf8f0e0, far: 0xb08a5a, near: 0xc8a068, shoulder: 0xe0c890, rail: 0xc0b8a8, clouds: 0xffffff },
  night: { skyTop: 0x050515, skyBottom: 0x2a1a5a, sun: 0xffffff, fog: 0x1a1030, grassA: 0x142018, grassB: 0x101c14, roadA: 0x2a2c34, roadB: 0x2e3038, rumbleA: 0xc0c0d0, rumbleB: 0xa02838, lane: 0xe0e0ff, far: 0x18103a, near: 0x2a1a4a, shoulder: 0x3a3a48, rail: 0x8a90b0, clouds: 0x201838 },
  sunset: { skyTop: 0x5a0a2a, skyBottom: 0xffc020, sun: 0xffe070, fog: 0xffa040, grassA: 0x2a0a18, grassB: 0x24081a, roadA: 0x3a2a34, roadB: 0x3e2e38, rumbleA: 0xffd090, rumbleB: 0x8a1a2a, lane: 0xffe0a0, far: 0x120408, near: 0x1a060c, shoulder: 0x40182a, rail: 0x201018, clouds: 0xff8040, sunPos: [0.5, 0.36], sunSize: 3.4 },
  cliffs: { skyTop: 0x2050a0, skyBottom: 0xa8d8ff, sun: 0xfff4c0, fog: 0xa8d8f8, grassA: 0x6a8a40, grassB: 0x62823c, roadA: 0x606068, roadB: 0x64646c, rumbleA: 0xf0f0f0, rumbleB: 0xd04040, lane: 0xf4f4f4, far: 0x2a5a90, near: 0x3070a8, shoulder: 0x9a8a6a, rail: 0xd0d4dc, clouds: 0xffffff },
  plains: { skyTop: 0x2a70c8, skyBottom: 0xc8e8ff, sun: 0xffffff, fog: 0xd0e4f0, grassA: 0xc8b060, grassB: 0xc0a858, roadA: 0x626266, roadB: 0x66666a, rumbleA: 0xf0f0f0, rumbleB: 0xc84040, lane: 0xf0f0e0, far: 0x7a9a5a, near: 0x9ab060, shoulder: 0xb09860, rail: 0xc0c0c0, clouds: 0xffffff },
  storm: { skyTop: 0x080a14, skyBottom: 0x26303e, sun: 0xffffff, fog: 0x1a2028, grassA: 0x121a14, grassB: 0x0e160f, roadA: 0x2a2e34, roadB: 0x2e3238, rumbleA: 0xb8c0c8, rumbleB: 0x8a2a30, lane: 0xd8e0e8, far: 0x0c1016, near: 0x121a1c, shoulder: 0x2a2e2a, rail: 0x7a8290, clouds: 0x1a2028 },
  ridge: { skyTop: 0x2a5aa8, skyBottom: 0xb8d8f8, sun: 0xfff8e0, fog: 0xb8ccd8, grassA: 0x3a8a3a, grassB: 0x348234, roadA: 0x585c60, roadB: 0x5c6064, rumbleA: 0xeeeeee, rumbleB: 0xc83030, lane: 0xf0f0f0, far: 0x3a5a8a, near: 0x2a6a4a, shoulder: 0x7a7a60, rail: 0xa8b0b8, clouds: 0xe8eef4 },
  city: { skyTop: 0x4a78b8, skyBottom: 0xc8d4dc, sun: 0xffffff, fog: 0xc8ccd4, grassA: 0x8c8e94, grassB: 0x86888e, roadA: 0x585a60, roadB: 0x5c5e64, rumbleA: 0xf0f0f0, rumbleB: 0xe0a020, lane: 0xf0e8c0, far: 0x6a7a90, near: 0x7c8898, shoulder: 0xa0a0a4, rail: 0xc0c0c0, clouds: 0xffffff },
  alpine: { skyTop: 0x244a80, skyBottom: 0xc8dcf0, sun: 0xffffff, fog: 0xc0d0e0, grassA: 0x5a8a4a, grassB: 0x548246, roadA: 0x505458, roadB: 0x54585c, rumbleA: 0xf0f0f0, rumbleB: 0xd03838, lane: 0xf0f0f0, far: 0x8a9ab0, near: 0x4a6a5a, shoulder: 0x8a8a80, rail: 0xc8ccd4, clouds: 0xd8dde4 },
  // Editor scenes (see src/world/scenes.ts): daylight ground colours, graded by whichever vibe the track is wearing.
  suburb: { skyTop: 0x2a68b8, skyBottom: 0xc0e0ff, sun: 0xffffff, fog: 0xc8dcec, grassA: 0x4a9a44, grassB: 0x44923e, roadA: 0x5e6064, roadB: 0x626468, rumbleA: 0xf0f0f0, rumbleB: 0xd8d8d8, lane: 0xf4f4e8, far: 0x7a8a9a, near: 0x5a8a5a, shoulder: 0xa8a8a0, rail: 0xc0c4cc, clouds: 0xffffff },
  industrial: { skyTop: 0x46688a, skyBottom: 0xb8c0c4, sun: 0xffffff, fog: 0xb0b8bc, grassA: 0x7a7c78, grassB: 0x747670, roadA: 0x52545a, roadB: 0x56585e, rumbleA: 0xe8e8e0, rumbleB: 0xc88a20, lane: 0xf0e8c0, far: 0x66707c, near: 0x6a6e70, shoulder: 0x8a8a86, rail: 0xb0b4b8, clouds: 0xdcdcdc },
}

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
/**
 * 1 = paint the HUD inside the low-res buffer, so it is pixels in the same framebuffer as the road
 * (retro style only). On by default: for this game the chunky in-buffer HUD *is* the look — a crisp
 * overlay on top of a 320-line road reads like a debug layer. Set it to 0 to compare.
 */
export let HUD_RETRO = 1

/**
 * 0 = sprites, the way this game is meant to look.
 * 1 = the real meshes in the sprites' places, at the same size and in the same baked pose: sharper,
 *     but a car still steps between sixteen steering angles and a tree is still seen head-on.
 * 2 = a real camera. Every model sits at its actual place in front of it and is seen from wherever
 *     the camera is, so a turn sweeps continuously through the angles and roadside things are seen
 *     from the side. The antithesis of the aesthetic, and worth being able to look at.
 * Either mode loads every model, which the atlas does not keep, so there is a pause the first time.
 */
export let MODELS_3D = 0

export const RENDER_TUNE: TuneSection = {
  title: 'Render · camera, fog, road',
  keys: [
    tune('HUD_RETRO', () => HUD_RETRO, (v) => (HUD_RETRO = v), [0, 1], 1, 'draw the HUD inside the low-res buffer'),
    tune('MODELS_3D', () => MODELS_3D, (v) => (MODELS_3D = v), [0, 2], 1, '0 sprites · 1 meshes in the sprites\u2019 poses · 2 a real camera'),
    tune('FOV_DEG', () => FOV_DEG, (v) => (FOV_DEG = v)),
    tune('FOG_MODERN', () => FOG_MODERN, (v) => (FOG_MODERN = v)),
    tune('FOG_RETRO', () => FOG_RETRO, (v) => (FOG_RETRO = v)),
    tune('LANE_WIDTH', () => LANE_WIDTH, (v) => (LANE_WIDTH = v)),
    tune('BEACH_WIDTH', () => BEACH_WIDTH, (v) => (BEACH_WIDTH = v), [2, 40], 1),
    tune('TUNNEL_HALF_WIDTH', () => TUNNEL_HALF_WIDTH, (v) => (TUNNEL_HALF_WIDTH = v), [9, 30], 0.5),
    tune('TUNNEL_HEIGHT', () => TUNNEL_HEIGHT, (v) => (TUNNEL_HEIGHT = v), [4, 16], 0.5),
    tune('TUNNEL_DARK', () => TUNNEL_DARK, (v) => (TUNNEL_DARK = v), [0.1, 1], 0.02),
    tune('BANK_SLOPE', () => BANK_SLOPE, (v) => (BANK_SLOPE = v), [0, 1], 0.02, 'road tilt per lateral metre'),
    tune('BANK_TIER_W', () => BANK_TIER_W, (v) => (BANK_TIER_W = v), [2, 20], 0.5),
    tune('BANK_TIER_H', () => BANK_TIER_H, (v) => (BANK_TIER_H = v), [0, 8], 0.1),
    tune('BANK_TIER_COUNT', () => BANK_TIER_COUNT, (v) => (BANK_TIER_COUNT = v), [1, 6], 1),
    tune('RUMBLE_WIDTH', () => RUMBLE_WIDTH, (v) => (RUMBLE_WIDTH = v)),
    tune('SHOULDER_WIDTH', () => SHOULDER_WIDTH, (v) => (SHOULDER_WIDTH = v)),
    tune('RAIL_HEIGHT', () => RAIL_HEIGHT, (v) => (RAIL_HEIGHT = v)),
    tune('NIGHT_AMBIENT', () => NIGHT_AMBIENT, (v) => (NIGHT_AMBIENT = v)),
    tune('HEADLIGHT_REACH', () => HEADLIGHT_REACH, (v) => (HEADLIGHT_REACH = v)),
    tune('LIGHTS_OFF_AMBIENT', () => LIGHTS_OFF_AMBIENT, (v) => (LIGHTS_OFF_AMBIENT = v)),
    tune('CAM_BOUNCE', () => CAM_BOUNCE, (v) => (CAM_BOUNCE = v), [0, 0.1], 0.002, 'camera bob'),
    tune('STEER_ROLL', () => STEER_ROLL, (v) => (STEER_ROLL = v)),
    tune('BANK_ROLL', () => BANK_ROLL, (v) => (BANK_ROLL = v), [0, 1.5], 0.05, 'view roll as a share of the bank angle'),
    tune('HORIZON_ROLL_SHARE', () => HORIZON_ROLL_SHARE, (v) => (HORIZON_ROLL_SHARE = v)),
    tune('RAIN_DROPS_PER_SEC', () => RAIN_DROPS_PER_SEC, (v) => (RAIN_DROPS_PER_SEC = v)),
    tune('RAIN_HAZE_PER_SEC', () => RAIN_HAZE_PER_SEC, (v) => (RAIN_HAZE_PER_SEC = v)),
    tune('WIPER_RATE', () => WIPER_RATE, (v) => (WIPER_RATE = v)),
  ],
}
