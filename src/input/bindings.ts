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

export interface KeyBindings {
  [action: string]: string[]
}

/** Gamepad binding: `b<index>` for a button, `a<index>±` for an axis half. */
export interface PadBindings {
  [action: string]: string[]
}

export const DEFAULT_KEYS: KeyBindings = {
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  throttle: ['KeyW', 'ShiftLeft', 'ShiftRight', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  fire: ['Space', 'Mouse0'],
  shockwave: ['KeyE', 'Mouse2'],
  pitchUp: ['KeyW', 'ArrowUp'],
  pitchDown: ['KeyS', 'ArrowDown'],
  pause: ['Escape'],
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

/** Stick deadzone and response curve. */
export const STICK_DEADZONE = 0.12
export const STICK_CURVE_POWER = 2

export function shapeAxis(v: number): number {
  const a = Math.abs(v)
  if (a < STICK_DEADZONE) return 0
  const t = (a - STICK_DEADZONE) / (1 - STICK_DEADZONE)
  return Math.sign(v) * Math.pow(Math.min(1, t), STICK_CURVE_POWER)
}

export function padBindingLabel(b: string): string {
  if (b.startsWith('a')) return `Axis ${b.slice(1)}`
  const i = Number(b.slice(1))
  const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right']
  return names[i] ?? `Button ${i}`
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Arrow')) return code.slice(5)
  if (code === 'Mouse0') return 'LMB'
  if (code === 'Mouse2') return 'RMB'
  return code.replace('Left', ' L').replace('Right', ' R')
}
