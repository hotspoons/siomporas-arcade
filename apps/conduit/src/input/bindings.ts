import { keyLabel, padBindingLabel, shapeAxis, type KeyBindings, type PadBindings } from '@apex/engine/input/bindings'

export { keyLabel, padBindingLabel, shapeAxis }

// Default control bindings and the remap model. Keys are KeyboardEvent.code;
// gamepad entries are standard-mapping button/axis indices. Persisted to
// localStorage by Settings when the player remaps.

export type Action =
  | 'steerLeft'
  | 'steerRight'
  | 'throttle'
  | 'brake'
  | 'fire'
  | 'shockwave'
  | 'pitchUp'
  | 'pitchDown'
  | 'pause'
  | 'confirm'

export const ACTIONS: Action[] = ['steerLeft', 'steerRight', 'throttle', 'brake', 'fire', 'shockwave', 'pitchUp', 'pitchDown', 'pause', 'confirm']

export const ACTION_LABELS: Record<Action, string> = {
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  throttle: 'Throttle',
  brake: 'Brake',
  fire: 'Fire laser',
  shockwave: 'Shockwave',
  pitchUp: 'Air pitch up',
  pitchDown: 'Air pitch down',
  pause: 'Pause',
  confirm: 'Confirm',
}

export type { KeyBindings, PadBindings }

export const DEFAULT_KEYS: KeyBindings = {
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  throttle: ['KeyW', 'ShiftLeft', 'ShiftRight', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  fire: ['Space', 'Mouse0'],
  shockwave: ['KeyE', 'Mouse2'],
  pitchUp: ['KeyW', 'ArrowUp'],
  pitchDown: ['KeyS', 'ArrowDown'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space'],
}

export const DEFAULT_PAD: PadBindings = {
  steerLeft: ['a0-'],
  steerRight: ['a0+'],
  throttle: ['b7'],
  brake: ['b6'],
  fire: ['b0', 'b5'],
  shockwave: ['b1', 'b4'],
  pitchUp: ['a1-'],
  pitchDown: ['a1+'],
  pause: ['b9'],
  confirm: ['b0', 'b9'],
}
