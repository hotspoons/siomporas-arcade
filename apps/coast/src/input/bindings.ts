import type { KeyBindings, PadBindings } from '@apex/engine/input/bindings'

export type Action = 'steerLeft' | 'steerRight' | 'throttle' | 'brake' | 'gear' | 'turbo' | 'wipers' | 'lights' | 'view' | 'pause' | 'confirm'
export const ACTIONS: Action[] = ['steerLeft', 'steerRight', 'throttle', 'brake', 'gear', 'turbo', 'wipers', 'lights', 'view', 'pause', 'confirm']
export const ACTION_LABELS: Record<Action, string> = {
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  throttle: 'Accelerate',
  brake: 'Brake',
  gear: 'Gear hi / lo',
  turbo: 'Turbo',
  wipers: 'Wipers',
  lights: 'Headlights',
  view: 'View (chase / cockpit)',
  pause: 'Pause',
  confirm: 'Confirm',
}
export const DEFAULT_KEYS: KeyBindings = {
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  gear: ['ShiftLeft', 'ShiftRight'],
  turbo: ['Space'],
  wipers: ['KeyR'],
  lights: ['KeyL'],
  view: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space'],
}
export const DEFAULT_PAD: PadBindings = {
  steerLeft: ['a0-'],
  steerRight: ['a0+'],
  throttle: ['b7'],
  brake: ['b6'],
  gear: ['b0'],
  turbo: ['b1'],
  wipers: ['b2'],
  lights: ['b8'],
  view: ['b3'],
  pause: ['b9'],
  confirm: ['b0', 'b9'],
}
