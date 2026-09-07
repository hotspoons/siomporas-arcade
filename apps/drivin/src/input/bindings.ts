import type { KeyBindings, PadBindings } from '@apex/engine/input/bindings'

export type Action = 'steerLeft' | 'steerRight' | 'throttle' | 'brake' | 'handbrake' | 'reset' | 'camera' | 'pause' | 'confirm'

export const ACTIONS: Action[] = ['steerLeft', 'steerRight', 'throttle', 'brake', 'handbrake', 'reset', 'camera', 'pause', 'confirm']

export const ACTION_LABELS: Record<Action, string> = {
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  throttle: 'Throttle',
  brake: 'Brake / reverse',
  handbrake: 'Handbrake',
  reset: 'Recover (right the car in place)',
  camera: 'Camera',
  pause: 'Pause',
  confirm: 'Confirm',
}

export const DEFAULT_KEYS: KeyBindings = {
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  handbrake: ['Space'],
  reset: ['KeyR'],
  camera: ['KeyC'],
  pause: ['Escape'],
  confirm: ['Enter', 'Space'],
}

export const DEFAULT_PAD: PadBindings = {
  steerLeft: ['a0-'],
  steerRight: ['a0+'],
  throttle: ['b7'],
  brake: ['b6'],
  handbrake: ['b0'],
  reset: ['b3'],
  camera: ['b2'],
  pause: ['b9'],
  confirm: ['b0', 'b9'],
}
