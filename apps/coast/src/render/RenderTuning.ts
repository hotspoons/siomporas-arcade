// Presentation constants. The game is designed on a 224-line logical screen
// (the classic arcade height); width follows the window's aspect.

export const LOGICAL_HEIGHT = 224
/** Vertical field of view for the pseudo-3D projection. */
export const FOV_DEG = 72
/** Camera height (m) and how far ahead of the camera the player car sits, per view. */
export const VIEWS = {
  chase: { camHeight: 5.6, playerAhead: 9.5, drawPlayer: true },
  cockpit: { camHeight: 1.35, playerAhead: 2.2, drawPlayer: false },
}
/** Exponential fog per metre of depth, modern / retro. */
export const FOG_MODERN = 0.0032
export const FOG_RETRO = 0.0045
/** Lane marker width (m) and dash length in segments. */
export const LANE_WIDTH = 0.28
export const RUMBLE_WIDTH = 1.6
export const ATLAS_SIZE = 2048
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
}

export const PALETTES: Record<string, Palette> = {
  coast: { skyTop: 0x1a4a9a, skyBottom: 0x8fd0ff, sun: 0xfff1b0, fog: 0x9fd8ff, grassA: 0x3f9a3a, grassB: 0x3a8e35, roadA: 0x66666e, roadB: 0x6a6a72, rumbleA: 0xf5f5f5, rumbleB: 0xd93838, lane: 0xf4f4f4, far: 0x2e6aa8, near: 0x2f7fbf },
  canyon: { skyTop: 0x5a1f4a, skyBottom: 0xffa060, sun: 0xffe0a0, fog: 0xffb070, grassA: 0xb0703a, grassB: 0xa66835, roadA: 0x5c5a5a, roadB: 0x605e5e, rumbleA: 0xf0e0c0, rumbleB: 0xb03030, lane: 0xf0e8d8, far: 0x8a3a3a, near: 0xa8503c },
  forest: { skyTop: 0x2a5aa0, skyBottom: 0xb0e0ff, sun: 0xffffe0, fog: 0xb8dcc8, grassA: 0x2f7a2c, grassB: 0x2a6f28, roadA: 0x585c60, roadB: 0x5c6064, rumbleA: 0xeeeeee, rumbleB: 0xc83030, lane: 0xf0f0f0, far: 0x1f4f6a, near: 0x1f5a3a },
  desert: { skyTop: 0x3a6ab0, skyBottom: 0xf8e8c0, sun: 0xffffff, fog: 0xf0e0b8, grassA: 0xd8b878, grassB: 0xd0b070, roadA: 0x6a6660, roadB: 0x6e6a64, rumbleA: 0xf8f0e0, rumbleB: 0xc84040, lane: 0xf8f0e0, far: 0xb08a5a, near: 0xc8a068 },
  night: { skyTop: 0x050515, skyBottom: 0x2a1a5a, sun: 0xffffff, fog: 0x1a1030, grassA: 0x142018, grassB: 0x101c14, roadA: 0x2a2c34, roadB: 0x2e3038, rumbleA: 0xc0c0d0, rumbleB: 0xa02838, lane: 0xe0e0ff, far: 0x18103a, near: 0x2a1a4a },
  alpine: { skyTop: 0x244a80, skyBottom: 0xc8dcf0, sun: 0xffffff, fog: 0xc0d0e0, grassA: 0x5a8a4a, grassB: 0x548246, roadA: 0x505458, roadB: 0x54585c, rumbleA: 0xf0f0f0, rumbleB: 0xd03838, lane: 0xf0f0f0, far: 0x8a9ab0, near: 0x4a6a5a },
}
