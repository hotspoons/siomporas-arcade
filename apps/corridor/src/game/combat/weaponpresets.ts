// A dozen weapons to start from, the third of the same idea as `vehiclepresets.ts`.
//
// WHAT MAKES A WEAPON PRESET DIFFERENT FROM THE OTHER TWO: the fields interact, and the interesting
// ones are pairs. `muzzle_ms: 0` means HITSCAN — instant, no travel, no drop — so a rifle left at
// zero is a laser that happens to be shaped like a rifle, and nothing about the number says so.
// `magazine: 0` means it never reloads, which is right for a crowbar and a beam and wrong for
// everything else. Every preset here is a combination that `validateWeapon` accepts, which is
// checked in a test rather than assumed.
//
// THE IMPULSE FIELD IS THE SEAM WITH THE PHYSICS. It is N·s delivered into the Rapier world on a
// hit, and it is the number that decides whether shooting a parked car moves it. A useful scale:
// the 18 kg stop sign in `physics.ts` detaches at about 720 N·s, a 1.4 tonne car needs a few
// thousand to be shoved noticeably, and a grenade at 4000 throws one. A pistol at 120 nudges a bin.

import type { WeaponDoc } from './weapons'

export interface WeaponPreset {
  id: string
  name: string
  /** one line for the picker: what this is and when to reach for it */
  note: string
  /** which catalog classes it suits. Weapons are one class, so this is here for symmetry */
  suits: string[]
  doc: WeaponDoc
}

function w(doc: WeaponDoc): WeaponDoc {
  return doc
}

/** The dozen, small to large, then the ones that are not guns. */
export const WEAPON_PRESETS: WeaponPreset[] = [
  {
    id: 'pistol',
    name: 'Pistol',
    note: 'The one everybody has. Fifteen rounds, useful to about sixty metres.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 24, rate_per_s: 4, magazine: 15, reload_s: 1.8, muzzle_ms: 380, spread_deg: 1.2, recoil: 0.35, range_m: 60, impulse: 120, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'revolver',
    name: 'Revolver',
    note: 'Six shots, hits like a truck, and you feel every one of them.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 58, rate_per_s: 1.6, magazine: 6, reload_s: 3.0, muzzle_ms: 440, spread_deg: 1.6, recoil: 0.72, range_m: 70, impulse: 340, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'smg',
    name: 'Submachine gun',
    note: 'Fast, inaccurate, and out of ammunition before you meant to be.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 17, rate_per_s: 14, magazine: 32, reload_s: 2.1, muzzle_ms: 360, spread_deg: 2.6, recoil: 0.45, range_m: 45, impulse: 90, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'rifle',
    name: 'Assault rifle',
    note: 'The middle of the range in every sense. Thirty rounds, two hundred metres.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 34, rate_per_s: 9, magazine: 30, reload_s: 2.4, muzzle_ms: 880, spread_deg: 0.6, recoil: 0.5, range_m: 200, impulse: 260, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'battle-rifle',
    name: 'Battle rifle',
    note: 'Slower, heavier rounds. Two hits rather than four, and it kicks.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 52, rate_per_s: 4.5, magazine: 20, reload_s: 2.6, muzzle_ms: 840, spread_deg: 0.4, recoil: 0.68, range_m: 320, impulse: 420, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'shotgun',
    name: 'Shotgun',
    note: 'A seven-degree cone. Devastating at ten metres, pointless at forty.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 68, rate_per_s: 1.2, magazine: 6, reload_s: 3.2, muzzle_ms: 420, spread_deg: 7, recoil: 0.8, range_m: 25, impulse: 900, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'sniper',
    name: 'Sniper rifle',
    note: 'One shot, most of a person, and eight hundred metres of it.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 110, rate_per_s: 0.8, magazine: 5, reload_s: 3.4, muzzle_ms: 930, spread_deg: 0.08, recoil: 0.9, range_m: 800, impulse: 700, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'minigun',
    name: 'Minigun',
    note: 'Belt fed and never reloads. Meant for a mount rather than a hand.',
    suits: ['weapon'],
    doc: w({ kind: 'ballistic', damage: 14, rate_per_s: 33, magazine: 0, reload_s: 0, muzzle_ms: 850, spread_deg: 2.2, recoil: 0.6, range_m: 250, impulse: 180, attach: 'mount', audio: {} }),
  },
  {
    id: 'rocket',
    name: 'Rocket launcher',
    note: 'Slow enough to watch. Four thousand newton-seconds arrives with it.',
    suits: ['weapon'],
    doc: w({ kind: 'thrown', damage: 260, rate_per_s: 0.35, magazine: 1, reload_s: 3.6, muzzle_ms: 120, spread_deg: 0, recoil: 0.5, range_m: 400, impulse: 9000, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'grenade',
    name: 'Grenade',
    note: 'Thrown, not fired. The one that sends traffic into the air.',
    suits: ['weapon'],
    doc: w({ kind: 'thrown', damage: 120, rate_per_s: 0.5, magazine: 4, reload_s: 1.0, muzzle_ms: 18, spread_deg: 0, recoil: 0, range_m: 30, impulse: 4000, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'crowbar',
    name: 'Crowbar',
    note: 'Melee: no magazine, no muzzle speed, a metre and a half of reach.',
    suits: ['weapon'],
    doc: w({ kind: 'melee', damage: 28, rate_per_s: 1.4, magazine: 0, reload_s: 0, muzzle_ms: 0, spread_deg: 0, recoil: 0.1, range_m: 1.6, impulse: 400, attach: 'hand_r', audio: {} }),
  },
  {
    id: 'laser',
    name: 'Laser',
    note: 'A beam: hitscan, no spread, no recoil and nothing to reload. Tickles, constantly.',
    suits: ['weapon'],
    doc: w({ kind: 'beam', damage: 8, rate_per_s: 20, magazine: 0, reload_s: 0, muzzle_ms: 0, spread_deg: 0, recoil: 0, range_m: 150, impulse: 0, attach: 'hand_r', audio: {} }),
  },
]

export const WEAPON_PRESET_IDS = WEAPON_PRESETS.map((p) => p.id)

/** A fresh copy of one, or null. Never hand out the module's own object. */
export function weaponPresetDoc(id: string): WeaponDoc | null {
  const p = WEAPON_PRESETS.find((x) => x.id === id)
  return p ? structuredClone(p.doc) : null
}

export function weaponPreset(id: string): WeaponPreset | null {
  return WEAPON_PRESETS.find((x) => x.id === id) ?? null
}

/** The presets, in order. Weapons are one catalog class, so there is nothing to sort by. */
export function weaponPresetsFor(_kind?: string | null): WeaponPreset[] {
  return WEAPON_PRESETS
}
