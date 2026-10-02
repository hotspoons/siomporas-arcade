// The weapon document: is the arithmetic the thing somebody would balance a fight with?
//
// The assertions that earn their place are the COMBINATION checks — every field in a weapon is
// individually plausible and it is the pairs that are nonsense — and `sustainedDps`, which is the
// number that makes a shotgun and a rifle comparable at all.

import { describe, expect, it } from 'vitest'
import { KINDS } from '../src/assets/classes'
import {
  burstDps, defaultWeapon, describeWeapon, dropAt, flightTime, magazineSeconds, shotsToKill,
  spreadRadiusAt, sustainedDps, validateWeapon, WEAPON_CLASS, WEAPON_KINDS, WEAPON_TEMPLATE_IDS,
} from '../src/game/combat/weapons'

describe('the templates', () => {
  it('has one per kind and every one validates clean', () => {
    expect(WEAPON_TEMPLATE_IDS.length).toBeGreaterThanOrEqual(WEAPON_KINDS.length)
    for (const id of WEAPON_TEMPLATE_IDS) {
      const r = validateWeapon(defaultWeapon(id))
      expect(r.errors, `${id} errors`).toEqual([])
      expect(r.warnings, `${id} warnings`).toEqual([])
    }
    expect(new Set(WEAPON_TEMPLATE_IDS.map((id) => defaultWeapon(id).kind))).toEqual(new Set(WEAPON_KINDS))
  })

  it('hands back a copy', () => {
    const a = defaultWeapon('rifle')
    a.damage = 999
    expect(defaultWeapon('rifle').damage).not.toBe(999)
  })

  it('is a class the library offers, so the first weapon does not need its class typed by hand', () => {
    // It was deliberately absent while the tab was being built — the library merges in classes
    // already in use, so one made by hand worked. Now that an armoury is a real part of the pane,
    // an empty library has to offer the word or nobody finds it.
    expect(KINDS).toContain(WEAPON_CLASS)
  })
})

describe('validation catches the combinations, which is where the mistakes are', () => {
  it('refuses a melee weapon with a magazine or a muzzle velocity', () => {
    const w = defaultWeapon('crowbar')
    expect(validateWeapon(w).errors).toEqual([])
    w.magazine = 6
    w.muzzle_ms = 300
    const r = validateWeapon(w)
    expect(r.errors.join(' ')).toMatch(/melee weapon has no magazine/)
    expect(r.errors.join(' ')).toMatch(/no muzzle velocity/)
  })

  it('says when a ballistic weapon has quietly become hitscan', () => {
    const w = defaultWeapon('rifle')
    expect(validateWeapon(w).warnings.join(' ')).not.toMatch(/HITSCAN/)
    w.muzzle_ms = 0
    expect(validateWeapon(w).warnings.join(' ')).toMatch(/HITSCAN/)
  })

  it('says when the cone is wider than anything it could hit', () => {
    const w = defaultWeapon('shotgun')
    expect(validateWeapon(w).warnings.join(' ')).not.toMatch(/nothing can be hit/)
    w.range_m = 200 // a 7° cone at 200 m is 24 m across
    expect(validateWeapon(w).warnings.join(' ')).toMatch(/nothing can be hit at that range/)
  })

  it('says when a shot would take longer to arrive than anything stands still for', () => {
    const w = defaultWeapon('grenade') // 18 m/s, 30 m — 1.7 s, fine
    expect(validateWeapon(w).warnings.join(' ')).not.toMatch(/still be there/)
    w.range_m = 200 // 11 s
    expect(validateWeapon(w).warnings.join(' ')).toMatch(/still be there/)
  })

  it('notices a reload that costs nothing and a reload with nothing to reload', () => {
    const w = defaultWeapon('pistol')
    w.reload_s = 0
    expect(validateWeapon(w).warnings.join(' ')).toMatch(/costs nothing/)
    const m = defaultWeapon('laser')
    m.reload_s = 2
    expect(validateWeapon(m).warnings.join(' ')).toMatch(/does nothing without a magazine/)
  })

  it('checks the attach bone against the holder when it is given one', () => {
    const w = defaultWeapon('pistol')
    expect(validateWeapon(w, { rigRoles: ['hand_r', 'head'] }).warnings.join(' ')).not.toMatch(/not a bone role/)
    expect(validateWeapon(w, { rigRoles: ['head'] }).warnings.join(' ')).toMatch(/not a bone role/)
    // no rig given: nothing is claimed, because the editor may not have one to hand
    expect(validateWeapon(w).warnings.join(' ')).not.toMatch(/not a bone role/)
  })

  it('reports every problem at once', () => {
    const w = defaultWeapon('pistol')
    w.damage = -1
    w.recoil = 4
    w.rate_per_s = 0
    w.range_m = 0
    expect(validateWeapon(w).errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('the arithmetic', () => {
  it('makes a shotgun and a rifle comparable, which burst DPS does not', () => {
    const rifle = defaultWeapon('rifle')
    const shotgun = defaultWeapon('shotgun')
    // On burst alone the shotgun looks respectable…
    expect(burstDps(shotgun)).toBeGreaterThan(0)
    // …but once the 3.2 s reload on a six-round magazine is counted it is a different weapon.
    expect(sustainedDps(shotgun)).toBeLessThan(burstDps(shotgun))
    expect(sustainedDps(rifle)).toBeGreaterThan(sustainedDps(shotgun))
  })

  it('sustains the burst rate for ever when there is no magazine', () => {
    const laser = defaultWeapon('laser')
    expect(laser.magazine).toBe(0)
    expect(sustainedDps(laser)).toBe(burstDps(laser))
    expect(magazineSeconds(laser)).toBe(Infinity)
    expect(magazineSeconds(defaultWeapon('pistol'))).toBeCloseTo(15 / 4, 6)
  })

  it('turns a spread half-angle into metres at a range', () => {
    const w = defaultWeapon('shotgun') // 7°
    expect(spreadRadiusAt(w, 25)).toBeCloseTo(25 * Math.tan((7 * Math.PI) / 180), 6)
    expect(spreadRadiusAt(w, 25)).toBeGreaterThan(3) // a real spread at its own range
    expect(spreadRadiusAt(defaultWeapon('laser'), 100)).toBe(0)
  })

  it('drops a projectile and does not drop a hitscan shot', () => {
    const pistol = defaultWeapon('pistol') // 380 m/s
    const t = flightTime(pistol, 60)
    expect(t).toBeCloseTo(60 / 380, 6)
    expect(dropAt(pistol, 60)).toBeCloseTo(0.5 * 9.81 * t * t, 6)
    expect(dropAt(pistol, 60)).toBeGreaterThan(0.1) // enough to have to aim for
    expect(dropAt(pistol, 60)).toBeLessThan(0.5)

    const laser = defaultWeapon('laser')
    expect(flightTime(laser, 150)).toBe(0)
    expect(dropAt(laser, 150)).toBe(0)
  })

  it('counts shots to kill including the reloads along the way', () => {
    const shotgun = defaultWeapon('shotgun') // 68 damage, 6 rounds, 3.2 s reload
    const tough = shotsToKill(shotgun, 1000)
    expect(tough.hits).toBe(Math.ceil(1000 / 68)) // 15 hits
    // 15 hits is two full magazines and a bit, so at least two reloads are in the time
    expect(tough.seconds).toBeGreaterThan(2 * 3.2)

    // armour makes it take longer, and total armour makes it never
    expect(shotsToKill(shotgun, 100, 0.5).hits).toBeGreaterThan(shotsToKill(shotgun, 100, 0).hits)
    expect(shotsToKill(shotgun, 100, 1).hits).toBe(Infinity)
  })

  it('never divides by zero on a weapon that does nothing', () => {
    const w = defaultWeapon('pistol')
    w.damage = 0
    expect(shotsToKill(w, 100).hits).toBe(Infinity)
    expect(Number.isFinite(sustainedDps(w))).toBe(true)
  })
})

describe('the summary line', () => {
  it('says hitscan when it is hitscan and a speed when it is not', () => {
    expect(describeWeapon(defaultWeapon('laser'))).toMatch(/hitscan/)
    expect(describeWeapon(defaultWeapon('rifle'))).toMatch(/880 m\/s/)
    expect(describeWeapon(defaultWeapon('grenade'))).toMatch(/N·s/)
  })
})
