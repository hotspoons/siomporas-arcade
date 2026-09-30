// Are the actor and weapon presets actually a dozen different things, and do they all validate?
//
// The same test as `vehiclepresets.test.ts` and for the same reason: a preset library is a set of
// claims about a spread, and a library where eleven of the twelve are near-copies is worse than
// three honest ones. The interesting assertions are the SPANS.
import { describe, expect, it } from 'vitest'
import { ACTOR_PRESETS, actorPresetDoc, actorPresetsFor } from '../src/actorpresets'
import { dps, hitsToKill, jumpHeight, validateActor } from '../src/actorspecs'
import { WEAPON_PRESETS, weaponPresetDoc, weaponPresetsFor } from '../src/weaponpresets'
import { sustainedDps, validateWeapon } from '../src/weapons'

describe('the actor presets', () => {
  it('are a dozen, all valid, and none of them share an id', () => {
    expect(ACTOR_PRESETS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(ACTOR_PRESETS.map((p) => p.id)).size).toBe(ACTOR_PRESETS.length)
    for (const p of ACTOR_PRESETS) {
      const r = validateActor(p.doc)
      expect(r.errors, `${p.id}: ${r.errors.join('; ')}`).toEqual([])
    }
  })

  it('hand out copies, so editing one build cannot change the library', () => {
    const a = actorPresetDoc('dog')!
    a.body.health = 9999
    expect(actorPresetDoc('dog')!.body.health).toBe(40)
  })

  it('span a real range of mass, speed and how hard they are to drop', () => {
    const mass = ACTOR_PRESETS.map((p) => p.doc.body.mass)
    expect(Math.min(...mass)).toBeLessThan(1)        // the bird
    expect(Math.max(...mass)).toBeGreaterThan(150)   // the brute
    const run = ACTOR_PRESETS.map((p) => p.doc.move.run_ms)
    expect(Math.max(...run)).toBeGreaterThan(12)     // the deer outruns everything
    // a brute takes several times as long to drop as a passer-by
    const brute = ACTOR_PRESETS.find((p) => p.id === 'brute')!.doc
    const passer = ACTOR_PRESETS.find((p) => p.id === 'passer-by')!.doc
    expect(hitsToKill(passer, brute).hits).toBeGreaterThan(hitsToKill(passer, passer).hits * 4)
    expect(dps(brute)).toBeGreaterThan(dps(passer))
    // and one of them flies, one climbs, one does not ragdoll — the spread that matters
    expect(ACTOR_PRESETS.some((p) => p.doc.move.fly_ms > 0)).toBe(true)
    expect(ACTOR_PRESETS.some((p) => p.doc.move.climb_ms > 0)).toBe(true)
    expect(ACTOR_PRESETS.some((p) => !p.doc.body.ragdoll)).toBe(true)
  })

  it('jump heights are reachable numbers, not velocities in disguise', () => {
    const player = ACTOR_PRESETS.find((p) => p.id === 'player-character')!.doc
    const h = jumpHeight(player)
    expect(h).toBeGreaterThan(0.6)
    expect(h).toBeLessThan(1.6)
  })

  it('sort the ones that suit a class first without hiding the rest', () => {
    const forAnimals = actorPresetsFor('animal')
    expect(forAnimals.length).toBe(ACTOR_PRESETS.length)
    expect(forAnimals[0].suits).toContain('animal')
    expect(forAnimals.some((p) => p.id === 'thug')).toBe(true)
  })
})

describe('the weapon presets', () => {
  it('are a dozen, all valid, and none of them share an id', () => {
    expect(WEAPON_PRESETS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(WEAPON_PRESETS.map((p) => p.id)).size).toBe(WEAPON_PRESETS.length)
    for (const p of WEAPON_PRESETS) {
      const r = validateWeapon(p.doc)
      expect(r.errors, `${p.id}: ${r.errors.join('; ')}`).toEqual([])
    }
  })

  it('hand out copies', () => {
    const w = weaponPresetDoc('pistol')!
    w.damage = 9999
    expect(weaponPresetDoc('pistol')!.damage).toBe(24)
  })

  /*
   * THE COMBINATIONS, which is where a weapon document goes wrong. `muzzle_ms: 0` means hitscan, so
   * a rifle left at zero is a laser shaped like a rifle and nothing says so.
   */
  it('only the melee and beam presets are hitscan, and only they never reload', () => {
    for (const p of WEAPON_PRESETS) {
      const hitscan = p.doc.muzzle_ms === 0
      expect(hitscan, `${p.id} muzzle_ms`).toBe(p.doc.kind === 'melee' || p.doc.kind === 'beam')
      if (p.doc.kind === 'melee' || p.doc.kind === 'beam') expect(p.doc.magazine, p.id).toBe(0)
    }
    // the minigun is the deliberate exception: belt fed, so no magazine, but it is not hitscan
    const mini = WEAPON_PRESETS.find((p) => p.id === 'minigun')!.doc
    expect(mini.magazine).toBe(0)
    expect(mini.muzzle_ms).toBeGreaterThan(0)
  })

  it('span from a pistol to a rocket in damage, reach and what they do to the physics', () => {
    const dmg = WEAPON_PRESETS.map((p) => p.doc.damage)
    expect(Math.max(...dmg)).toBeGreaterThan(200)
    const range = WEAPON_PRESETS.map((p) => p.doc.range_m)
    expect(Math.min(...range)).toBeLessThan(2)       // the crowbar
    expect(Math.max(...range)).toBeGreaterThan(500)  // the sniper
    // the impulse is the seam with Rapier: something here must be able to shift a car
    expect(Math.max(...WEAPON_PRESETS.map((p) => p.doc.impulse))).toBeGreaterThan(4000)
    // sustained dps orders the way somebody would guess: minigun over pistol over crowbar
    const at = (id: string) => sustainedDps(WEAPON_PRESETS.find((p) => p.id === id)!.doc)
    expect(at('minigun')).toBeGreaterThan(at('pistol'))
    expect(at('pistol')).toBeGreaterThan(at('crowbar'))
  })

  it('offers every preset whatever class is asked for — weapons are one class', () => {
    expect(weaponPresetsFor('weapon').length).toBe(WEAPON_PRESETS.length)
    expect(weaponPresetsFor(null).length).toBe(WEAPON_PRESETS.length)
  })
})
