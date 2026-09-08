// Presentation constants for the driving game. Nothing here affects gameplay.

import { tune, type TuneSection } from '@apex/engine/app/TunePanel'
/** Daylight haze: fog and clear colour. */
export const BG_COLOR = 0xbcd8f2
export const GROUND_SIZE = 2600
export let FOG_DENSITY_MODERN = 0.0011
export let FOG_DENSITY_RETRO = 0.0016

/** Chase camera. */
export let CAM_BACK = 9.5
export let CAM_UP = 3.2
export let CAM_LOOK_AHEAD = 14
/** How fast the camera's up vector follows the car's (loops flip the view). */
export let CAM_UP_RATE = 5
export let CAM_POS_RATE = 14
export let FOV_BASE = 68
export let FOV_AT_TOP_SPEED = 82

export const ROAD_SEGMENTS_ACROSS = 6
export const TUBE_SEGMENTS_MODERN = 20
export const TUBE_SEGMENTS_RETRO = 10
export const MAX_PARTICLES = 512

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
export const RENDER_TUNE: TuneSection = {
  title: 'Render · camera, fog',
  keys: [
    tune('CAM_BACK', () => CAM_BACK, (v) => (CAM_BACK = v)),
    tune('CAM_UP', () => CAM_UP, (v) => (CAM_UP = v)),
    tune('CAM_LOOK_AHEAD', () => CAM_LOOK_AHEAD, (v) => (CAM_LOOK_AHEAD = v)),
    tune('CAM_UP_RATE', () => CAM_UP_RATE, (v) => (CAM_UP_RATE = v)),
    tune('CAM_POS_RATE', () => CAM_POS_RATE, (v) => (CAM_POS_RATE = v)),
    tune('FOV_BASE', () => FOV_BASE, (v) => (FOV_BASE = v)),
    tune('FOV_AT_TOP_SPEED', () => FOV_AT_TOP_SPEED, (v) => (FOV_AT_TOP_SPEED = v)),
    tune('FOG_DENSITY_MODERN', () => FOG_DENSITY_MODERN, (v) => (FOG_DENSITY_MODERN = v)),
    tune('FOG_DENSITY_RETRO', () => FOG_DENSITY_RETRO, (v) => (FOG_DENSITY_RETRO = v)),
  ],
}
