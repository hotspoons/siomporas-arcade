// Generic binding vocabulary shared by every game: key codes and gamepad
// binding strings (`b<index>` button, `a<index>±` axis half), stick shaping,
// and human labels. Games own their action lists and defaults.

export interface KeyBindings {
  [action: string]: string[]
}

export interface PadBindings {
  [action: string]: string[]
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

/**
 * Merge in any default key an action is missing, keeping whatever the player has bound. Games call
 * this once when their stored bindings predate a new alias (P for pause, say): bindings live in the
 * browser, so a key added to the defaults never reaches anyone who has already played.
 *
 * Returns how many keys were added. The version this ran for MUST be read from the stored blob, not
 * from merged settings, where a missing version field arrives from the defaults looking current.
 */
export function mergeMissingKeys(keys: KeyBindings, defaults: KeyBindings): number {
  let added = 0
  for (const [action, want] of Object.entries(defaults)) {
    const mine = keys[action]
    if (!mine) {
      keys[action] = [...want]
      added += want.length
      continue
    }
    for (const k of want)
      if (!mine.includes(k)) {
        mine.push(k)
        added++
      }
  }
  return added
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Arrow')) return code.slice(5)
  if (code === 'Mouse0') return 'LMB'
  if (code === 'Mouse2') return 'RMB'
  return code.replace('Left', ' L').replace('Right', ' R')
}
