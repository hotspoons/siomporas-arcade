// Does the land-use reader still answer while its rings stream per cell?
//
// On a tiled world the metes arrive one tile at a time, but the grass asks "kept or rural?" at every
// blade and the verge grass type (`grassTypeFor`) is decided before any tile is fetched. The risk is
// that streaming quietly changes either answer — a missed polygon, a lost tie-break, a grass type
// that flips once the first cell lands. This pins all three.
import { describe, expect, it } from 'vitest'
import type { Manifest } from '../src/world/site'
import { landuseZone } from '../src/world/zoning'
import { grassTypeFor } from '../src/world/groundcover'

type Ring = [number, number][]
const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const lu = (cls: string, ring: Ring) => ({ class: cls, ring })
const manifest = (m: Partial<Manifest>): Manifest => m as unknown as Manifest

describe('streamed land use', () => {
  it('answers from the resident rings, and after cells stream in', () => {
    const whole = landuseZone(manifest({ landuse: [lu('forest', rect(0, 0, 1000, 1000))] }))
    expect(whole.zoneAt(500, 500)).toBe('rural')
    expect(whole.zoneAt(5000, 5000)).toBeNull() // nowhere near a polygon

    const streamed = landuseZone(manifest({ landuse: [] }))
    expect(streamed.zoneAt(500, 500)).toBeNull()
    streamed.add([lu('forest', rect(0, 0, 1000, 1000))])
    expect(streamed.zoneAt(500, 500)).toBe('rural')
    expect(streamed.count()).toBe(1)
  })

  it('keeps the smaller-polygon-first rule when a smaller cell arrives last', () => {
    // a kept lawn inside a big rural field: the more specific polygon must win, whichever tile it came in
    const big = lu('farmland', rect(0, 0, 1000, 1000))
    const small = lu('residential', rect(100, 100, 200, 200))
    const whole = landuseZone(manifest({ landuse: [big, small] }))
    expect(whole.zoneAt(150, 150)).toBe('kept')

    const streamed = landuseZone(manifest({ landuse: [] }))
    streamed.add([big])
    expect(streamed.zoneAt(150, 150)).toBe('rural')
    streamed.add([small])
    expect(streamed.zoneAt(150, 150)).toBe('kept')
  })

  it('treats ground just outside a kept polygon as kept, as it did resident', () => {
    const zone = landuseZone(manifest({ landuse: [lu('residential', rect(0, 0, 100, 100))] }))
    expect(zone.zoneAt(100, 50)).toBe('kept') // on the edge
    expect(zone.zoneAt(120, 50)).toBe('kept') // 20 m out, within the near band
    expect(zone.zoneAt(200, 50)).toBeNull()   // 100 m out, the road decides
  })
})

describe('grass type from the bake summary', () => {
  it('reads the resident class->area summary, with no rings at all', () => {
    const tiled = manifest({ landuse: [], landuse_area: { grass: 100, farmland: 20 } })
    expect(grassTypeFor(tiled)).toBe('common')
    // a beach anywhere is coastal, before any ring has streamed
    expect(grassTypeFor(manifest({ landuse: [], landuse_area: { grass: 100, sand: 100 } }))).toBe('coastal')
    // farmland over 30% is a wheat verge
    expect(grassTypeFor(manifest({ landuse: [], landuse_area: { farmland: 40, meadow: 60 } }))).toBe('wheat')
  })

  it('falls back to the rings for an untiled bake', () => {
    const resident = manifest({ landuse: [lu('sand', rect(0, 0, 100, 100)), lu('grass', rect(100, 0, 110, 10))] })
    expect(grassTypeFor(resident)).toBe('coastal')
  })
})
