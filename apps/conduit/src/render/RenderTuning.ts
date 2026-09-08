// Presentation constants. Nothing here affects gameplay.

import { tune, type TuneSection } from '@apex/engine/app/TunePanel'
export const CHUNK_LENGTH = 200
export const CHUNKS_AHEAD = 12
export const CHUNKS_BEHIND = 3
/** Metres between vertex rings along the tunnel. */
export const RING_SPACING = 4
export const RING_SEGMENTS_MODERN = 32
export const RING_SEGMENTS_RETRO = 12
/** Where fog fully hides the geometry cut-off. */
export const DRAW_DISTANCE = 1800
export let FOG_DENSITY_MODERN = 0.0011
export let FOG_DENSITY_RETRO = 0.0016

export let FOV_BASE = 75
export let FOV_AT_MAX_SPEED = 96
/** Extra FOV on boost strips. */
export let FOV_BOOST_KICK = 6

/** Chase camera: behind and above the craft, in metres. */
export let CAM_BACK = 13
export let CAM_UP = 4.2
/** Look-ahead point distance along the track. */
export let CAM_LOOK_AHEAD = 42
/** How fast the camera's theta chases the craft's (1/s). Lower = more swing. */
export let CAM_THETA_LAG = 9
/** Fraction of the craft's visual bank the camera adopts. */
export let CAM_BANK_FOLLOW = 0.35
export const CAM_SHAKE_DECAY = 4.5
export let CAM_SHAKE_AMPLITUDE = 0.6

export const SPEED_LINE_COUNT = 260
/** Speed lines only appear above this speed (m/s). */
export let SPEED_LINE_MIN_SPEED = 260

export const MAX_PARTICLES = 1024
export const MAX_IMPACTS = 64
export const GATE_POOL = 6
export const RING_POOL = 24

/** Palette: neon on dark. Hue is shifted per course by CourseDesc.palette. */
export const BG_COLOR = 0x06040f
export const FLOATING_ORIGIN_REBASE = 20000

/** Presentation slow-mo floor so the loop never stalls. */
export const MIN_TIME_SCALE = 0.25

/** Live-tunable knobs for the tuning panel (F6). Values persist per browser; Copy JSON to ship new defaults. */
export const RENDER_TUNE: TuneSection = {
  title: 'Render · camera, fog, speed lines',
  keys: [
    tune('FOV_BASE', () => FOV_BASE, (v) => (FOV_BASE = v)),
    tune('FOV_AT_MAX_SPEED', () => FOV_AT_MAX_SPEED, (v) => (FOV_AT_MAX_SPEED = v)),
    tune('FOV_BOOST_KICK', () => FOV_BOOST_KICK, (v) => (FOV_BOOST_KICK = v)),
    tune('CAM_BACK', () => CAM_BACK, (v) => (CAM_BACK = v)),
    tune('CAM_UP', () => CAM_UP, (v) => (CAM_UP = v)),
    tune('CAM_LOOK_AHEAD', () => CAM_LOOK_AHEAD, (v) => (CAM_LOOK_AHEAD = v)),
    tune('CAM_THETA_LAG', () => CAM_THETA_LAG, (v) => (CAM_THETA_LAG = v)),
    tune('CAM_BANK_FOLLOW', () => CAM_BANK_FOLLOW, (v) => (CAM_BANK_FOLLOW = v)),
    tune('CAM_SHAKE_AMPLITUDE', () => CAM_SHAKE_AMPLITUDE, (v) => (CAM_SHAKE_AMPLITUDE = v)),
    tune('FOG_DENSITY_MODERN', () => FOG_DENSITY_MODERN, (v) => (FOG_DENSITY_MODERN = v)),
    tune('FOG_DENSITY_RETRO', () => FOG_DENSITY_RETRO, (v) => (FOG_DENSITY_RETRO = v)),
    tune('SPEED_LINE_MIN_SPEED', () => SPEED_LINE_MIN_SPEED, (v) => (SPEED_LINE_MIN_SPEED = v)),
  ],
}
