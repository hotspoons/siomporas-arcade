// The dozen cars you can start from: are they valid, and are they actually different?
//
// A preset library where every row validates but they all behave the same is a library of one
// preset with twelve names — so the assertions here are as much about SPREAD as about correctness.

import { describe, expect, it } from 'vitest'
import { KINDS } from '../src/assets/classes'
import { VEHICLE_TEMPLATES, describeVehicle, effectiveTopSpeed, toDriveProfile, toVehicleSpec, validateVehicle, gearedTopSpeed } from '../src/game/vehicle/vehicles'
import { presetDoc, presetsFor, vehiclePreset, VEHICLE_PRESETS, VEHICLE_PRESET_IDS } from '../src/game/vehicle/vehiclepresets'

describe('the library', () => {
  it('has a dozen or so, with unique ids', () => {
    expect(VEHICLE_PRESETS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(VEHICLE_PRESET_IDS).size).toBe(VEHICLE_PRESETS.length)
  })

  it('validates every one — and warns about exactly the ones that should be warned about', () => {
    /*
     * NO ERRORS ANYWHERE. Warnings are a different matter and this test used to demand none of
     * those either, which was wrong: a tall empty panel van has a static stability factor of 0.99
     * and genuinely DOES roll over before it slides. The validator saying so is the validator
     * working, and the right assertion is that it fires on the tall ones and stays quiet on the
     * low ones — not that it never fires.
     */
    const tippy = new Set(['van', 'box-truck', 'bus', 'motorcycle'])
    for (const p of VEHICLE_PRESETS) {
      const r = validateVehicle(p.doc)
      expect(r.errors, `${p.id} errors`).toEqual([])
      const rollover = r.warnings.filter((w) => /roll over before it slides/.test(w))
      const other = r.warnings.filter((w) => !/roll over before it slides/.test(w))
      expect(other, `${p.id} unexpected warnings`).toEqual([])
      if (tippy.has(p.id)) expect(rollover.length, `${p.id} should warn about rollover`).toBe(1)
      else expect(rollover, `${p.id} should not warn about rollover`).toEqual([])
    }
  })

  it('names classes the asset library really has', () => {
    for (const p of VEHICLE_PRESETS) {
      for (const k of p.suits) expect(KINDS, `${p.id} suits ${k}`).toContain(k)
    }
  })

  it('hands back a copy, so editing a vehicle does not edit the preset', () => {
    const a = presetDoc('muscle')!
    a.spec.mass = 1
    expect(presetDoc('muscle')!.spec.mass).not.toBe(1)
    expect(vehiclePreset('nonesuch')).toBeNull()
    expect(presetDoc('nonesuch')).toBeNull()
  })
})

describe('they are actually different from each other', () => {
  it('spans a real range of mass, from a kei car to a bus', () => {
    const masses = VEHICLE_PRESETS.map((p) => p.doc.spec.mass)
    expect(Math.min(...masses)).toBeLessThan(1000)
    expect(Math.max(...masses)).toBeGreaterThan(10000)
  })

  it('uses all three drive layouts', () => {
    expect(new Set(VEHICLE_PRESETS.map((p) => p.doc.spec.drive))).toEqual(new Set(['fwd', 'rwd', 'awd']))
  })

  it('spans a real range of gear counts', () => {
    const counts = VEHICLE_PRESETS.map((p) => p.doc.engine.gears.length)
    expect(Math.min(...counts)).toBeLessThanOrEqual(5)
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(7)
  })

  it('accelerates and tops out in an order a person would expect', () => {
    const at = (id: string) => {
      const doc = presetDoc(id)!
      return { p: toDriveProfile(doc), top: gearedTopSpeed(doc.engine, doc.spec.wheelRadius) }
    }
    const supercar = at('supercar')
    const hatch = at('hot-hatch')
    const bus = at('bus')
    expect(supercar.p.powerPerKg).toBeGreaterThan(hatch.p.powerPerKg)
    expect(hatch.p.powerPerKg).toBeGreaterThan(bus.p.powerPerKg)
    expect(supercar.top).toBeGreaterThan(bus.top)
    // and the numbers land where a person would recognise them
    expect(supercar.top * 2.237).toBeGreaterThan(150)
    expect(bus.top * 2.237).toBeLessThan(90)
  })

  /*
   * The card used to read "365 mph geared" next to a road car, because the readout took the top
   * gear at the redline and nothing capped it. A gearset like that is REAL — seventh is not a gear
   * anybody holds to the limiter — so the fix is in what is shown, not in the ratios.
   */
  it('a card says the speed the car reaches, not the speed its top gear allows', () => {
    const doc = presetDoc('supercar')!
    const geared = gearedTopSpeed(doc.engine, doc.spec.wheelRadius)
    const reached = effectiveTopSpeed(doc)
    expect(geared * 2.237).toBeGreaterThan(250)          // the gearbox really does allow that
    expect(reached).toBeLessThan(geared)                 // and drag really does stop it first
    // the cube-root law, restated here so a change to the formula has to be deliberate
    const p = toDriveProfile(doc)
    expect(reached).toBeCloseTo(Math.cbrt((doc.engine.power_kw * 1000) / (p.dragPerKg * doc.spec.mass)), 6)
    // the sentence a person reads must carry the smaller number
    const said = Number(describeVehicle(doc).match(/· (\d+) mph/)![1])
    expect(said).toBe(Math.round(reached * 2.237))
    expect(said).toBeLessThan(200)
  })

  it('makes the tall ones tippy and the low ones not — the stability factor spans the interesting range', () => {
    const ssf = (id: string) => { const d = presetDoc(id)!; return d.spec.track / 2 / d.spec.cgHeight }
    expect(ssf('supercar')).toBeGreaterThan(1.6)
    expect(ssf('van')).toBeLessThan(1.1)
    expect(ssf('bus')).toBeLessThan(0.9)
    // a van really should be tippier than a supercar, which is the whole point of carrying cgHeight
    expect(ssf('van')).toBeLessThan(ssf('supercar'))
  })

  it('builds a usable engine spec for every one of them', () => {
    for (const p of VEHICLE_PRESETS) {
      const prof = toDriveProfile(p.doc)
      const spec = toVehicleSpec(p.doc, prof)
      expect(Number.isFinite(prof.powerPerKg) && prof.powerPerKg > 0, `${p.id} power`).toBe(true)
      expect(Number.isFinite(prof.topSpeed) && prof.topSpeed > 5, `${p.id} top speed`).toBe(true)
      expect(spec.massKg, `${p.id} mass`).toBe(p.doc.spec.mass)
      // the CG has to land inside the body, or the clamp is silently doing the work
      expect(Math.abs(spec.comY!), `${p.id} cg inside the shell`).toBeLessThan(spec.halfHeight)
    }
  })
})

describe('picking one for a visual', () => {
  it('offers what suits the class first, and still offers everything', () => {
    const forVan = presetsFor('commercial-vehicle')
    expect(forVan.length).toBe(VEHICLE_PRESETS.length)
    expect(forVan[0].suits).toContain('commercial-vehicle')
    // a kei car is still on the list, because somebody may be making something odd on purpose
    expect(forVan.map((p) => p.id)).toContain('kei')
    // and with no class named, nothing is reordered
    expect(presetsFor(null).map((p) => p.id)).toEqual(VEHICLE_PRESET_IDS)
  })
})

/*
 * THE ENGINE SOUND IS NAMED BY PATH, AND A WRONG NAME IS SILENT.
 *
 * Every preset shipped with an invented name — `inline-4-turbo`, `v8-na`, `diesel-6` — and the
 * enginesim catalog names scripts by their path inside the wasm. Nothing crashed: the validator
 * warned on the form and the car simply had no engine sound, which is the same failure as the
 * invented class vocabulary in `classes.ts`. Held against the catalog so a new preset cannot
 * reintroduce it.
 */
describe('every preset names an engine this build actually has', () => {
  it('and so does every class template', async () => {
    const { ENGINES } = await import('@apex/enginesim')
    const have = new Set(ENGINES.map((e) => e.path))
    expect(have.size).toBeGreaterThan(10)
    for (const p of VEHICLE_PRESETS) {
      expect(have.has(p.doc.audio.setup), `${p.id} -> ${p.doc.audio.setup}`).toBe(true)
    }
    for (const [kind, doc] of Object.entries(VEHICLE_TEMPLATES)) {
      expect(have.has(doc.audio.setup), `${kind} -> ${doc.audio.setup}`).toBe(true)
    }
    // the check can fail: a name of the old shape is not in the catalog
    expect(have.has('inline-4-turbo')).toBe(false)
  })
})
