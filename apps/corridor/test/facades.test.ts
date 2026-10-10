import { describe, expect, it } from 'vitest'
import { BUILTIN_FACADES, FACADE_CLASS_IDS, LAYER_STRIDE, buildingKey, classifyFootprint, facadePlan, facadeSources, packLayer, pickWeighted, resolveFacades } from '../src/world/facades'
import { buildMassing } from '../src/world/massing'

const ring = (cx: number, cy: number, w = 10, d = 8): [number, number][] => [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]]

describe('building classes', () => {
  it('the built-in set is the list the vocabulary names, in order', () => {
    expect(BUILTIN_FACADES.map((c) => c.id)).toEqual(FACADE_CLASS_IDS)
  })

  it('classes Rich’s examples the way he named them', () => {
    expect(classifyFootprint({ tags: { building: 'house' }, area_m2: 150, height_m: 7 })).toBe('house')
    expect(classifyFootprint({ tags: { building: 'apartments' }, area_m2: 900, height_m: 15 })).toBe('apartments')
    expect(classifyFootprint({ tags: { building: 'retail' }, area_m2: 1200, height_m: 6 })).toBe('commercial')
    expect(classifyFootprint({ tags: { building: 'office' }, area_m2: 1800, height_m: 80 })).toBe('skyscraper')
  })

  it('a tower is a tower whatever it is tagged; a POI lends its shop; shape decides the rest', () => {
    expect(classifyFootprint({ tags: { building: 'apartments' }, area_m2: 1500, height_m: 45 })).toBe('skyscraper')
    expect(classifyFootprint({ tags: { building: 'yes', shop: 'supermarket' }, area_m2: 4000, height_m: 8 })).toBe('commercial')
    expect(classifyFootprint({ tags: { building: 'yes', amenity: 'school' }, area_m2: 6000, height_m: 9 })).toBe('civic')
    // a POI on a footprint too big for it is a unit inside something bigger, and does not decide
    expect(classifyFootprint({ tags: { building: 'yes', amenity: 'cafe' }, area_m2: 40000, height_m: 9 })).toBe('industrial')
    expect(classifyFootprint({ tags: { building: 'yes' }, area_m2: 20, height_m: 3 })).toBe('shed')
    expect(classifyFootprint({ tags: { building: 'yes' }, area_m2: 160, height_m: 7, rect: { w: 12, d: 10 } })).toBe('house')
    expect(classifyFootprint({ tags: { building: 'yes' }, area_m2: 200, height_m: 9, rect: { w: 40, d: 6 } })).toBe('townhouse')
    expect(classifyFootprint({ tags: { building: 'yes' }, area_m2: 9000, height_m: 9 })).toBe('industrial')
    expect(classifyFootprint({})).toBe('shed')
  })
})

describe('the pick', () => {
  it('a building key is the same for either winding and any starting vertex', () => {
    const r = ring(123.4, -567.8)
    const k = buildingKey(r)
    expect(buildingKey([...r].reverse())).toBe(k)
    expect(buildingKey([...r.slice(2), ...r.slice(0, 2)])).toBe(k)
    expect(buildingKey(ring(123.4, -560))).not.toBe(k)
  })

  it('draws in proportion to the weights, and the same building always draws the same', () => {
    const counts = [0, 0, 0]
    for (let i = 0; i < 30000; i++) counts[pickWeighted([2, 1, 1], buildingKey(ring(i * 13.1, i * 7.7)))]++
    expect(counts[0] / 30000).toBeGreaterThan(0.46)
    expect(counts[0] / 30000).toBeLessThan(0.54)
    expect(counts[1] / 30000).toBeGreaterThan(0.22)
    const k = buildingKey(ring(5, 5))
    expect(pickWeighted([1, 1, 1, 1], k)).toBe(pickWeighted([1, 1, 1, 1], k))
    // the roof is its own draw: a different salt is not the wall's choice again
    let same = 0
    for (let i = 0; i < 2000; i++) { const kk = buildingKey(ring(i * 3.3, 1)); if (pickWeighted([1, 1, 1, 1], kk, 1) === pickWeighted([1, 1, 1, 1], kk, 2)) same++ }
    expect(same / 2000).toBeLessThan(0.4)
    expect(pickWeighted([], k)).toBe(-1)
    expect(pickWeighted([0, 0], k)).toBe(-1)
  })
})

describe('three layers', () => {
  it('built-in, then the shared default, then the world — per field', () => {
    const shared = [{ id: 'apartments', walls: [{ material: 'cmu_bare', weight: 1 }], metalness: 0.2 }]
    const world = { classes: { apartments: { metalness: 0.5 } } }
    const apt = resolveFacades(shared, world).find((c) => c.id === 'apartments')!
    expect(apt.walls).toEqual([{ material: 'cmu_bare', weight: 1 }])
    expect(apt.metalness).toBe(0.5)
    expect(apt.roughness).toBe(BUILTIN_FACADES.find((c) => c.id === 'apartments')!.roughness)
    expect(facadeSources('apartments', shared, world)).toMatchObject({ walls: 'shared', metalness: 'world', roughness: 'built-in' })
  })

  it('the world’s single pool (the World tab) beats the shared default, and loses to its own class pools', () => {
    const world = { walls: ['stucco_cream'], classes: { house: { walls: [{ material: 'fieldstone', weight: 1 }] } } }
    const out = resolveFacades([{ id: 'commercial', walls: [{ material: 'cmu_bare', weight: 1 }] }], world)
    expect(out.find((c) => c.id === 'commercial')!.walls).toEqual([{ material: 'stucco_cream', weight: 1 }])
    expect(out.find((c) => c.id === 'house')!.walls).toEqual([{ material: 'fieldstone', weight: 1 }])
  })

  it('clamps and cleans what a record says', () => {
    const out = resolveFacades([{ id: 'house', metalness: 7, walls: [{ material: '', weight: 1 }, { material: 'x', weight: -1 }, { material: 'y', weight: 2 }] }], null)
    const h = out.find((c) => c.id === 'house')!
    expect(h.metalness).toBe(1)
    expect(h.walls).toEqual([{ material: 'y', weight: 2 }])
  })
})

describe('the plan the massing reads', () => {
  it('one layer per distinct material, shared across classes, and missing materials dropped', () => {
    const avail = new Set(['brick_running_red', 'cmu_bare', 'curtain_wall_glass', 'shingle_arch_charcoal'])
    const p = facadePlan(resolveFacades(null, null), avail)
    expect(new Set(p.layers).size).toBe(p.layers.length)
    expect(p.layers.every((m) => avail.has(m))).toBe(true)
    const house = p.classes.find((c) => c.id === 'house')!
    const apt = p.classes.find((c) => c.id === 'apartments')!
    // brick is in both pools and is ONE layer
    const brick = p.layers.indexOf('brick_running_red')
    expect(house.walls.some((e) => e.layer === brick) && apt.walls.some((e) => e.layer === brick)).toBe(true)
    expect(p.classes.find((c) => c.id === 'skyscraper')!.glass).toBe(true)
  })

  it('the massing writes class × 64 + layer on a pooled building’s faces, the same on a second build', async () => {
    const classes = resolveFacades(null, null)
    const plan = facadePlan(classes, null)
    const slot = plan.classes.findIndex((c) => c.id === 'house')
    const list = [0, 1, 2, 3, 4, 5].map((i) => ({ ring: ring(i * 40, 0), height: 6, area: 80, rect: { yaw_deg: 0, w: 10, d: 8 }, base: 0, fslot: slot }))
    const pool = { wallIds: [], roofIds: [], seed: 1, facades: { classes: plan.classes } }
    const a = await buildMassing(list, pool)
    const b = await buildMassing(list, pool)
    expect([...a.lay]).toEqual([...b.lay])
    const slots = new Set([...a.lay].filter((v) => v >= 0).map((v) => Math.floor(v / LAYER_STRIDE)))
    expect([...slots]).toEqual([slot])
    expect(packLayer(slot, 3)).toBe(slot * 64 + 3)
    // and no facades is the palette: nothing textured
    const none = await buildMassing(list, null)
    expect([...none.lay].every((v) => v < 0)).toBe(true)
  })
})
