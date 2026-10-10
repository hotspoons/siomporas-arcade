// The OSM data dialog's pure parts, held to the real Geofabrik catalogue's quirks.
//
// Two quirks, both found reading index-v1.json on 2026-10-10: the US states are NAMED by their id
// (`"name": "us/virginia"`), and they are filed under `north-america` beside `us`, not inside it.
// A tree built from `parent` alone lists fifty-one states next to Canada.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
// the service's own label, imported straight out of the service, so the run says what the row says
import { regionLabel as serviceLabel } from '../../../tools/worldeditor/coverage.mjs'
import { buildRegionTree, fmtAge, fmtBytes, regionLabel, searchRegions, worldVerdict, type GeofabrikRegion } from '../src/editor/worldedit/osmregions'

const seed = JSON.parse(readFileSync(new URL('../../../tools/worldeditor/geofabrik-seed.json', import.meta.url), 'utf8')) as {
  features: { properties: { id: string; name: string; parent?: string; urls?: { pbf?: string; updates?: string } } }[]
}

// the shape of the real catalogue around the case that matters, with its real parents and names
const CATALOGUE: GeofabrikRegion[] = [
  { id: 'north-america', name: 'North America', parent: null, pbf: 'x', updates: 'x' },
  { id: 'us', name: 'United States of America', parent: 'north-america', pbf: 'x', updates: 'x' },
  { id: 'canada', name: 'Canada', parent: 'north-america', pbf: 'x', updates: 'x' },
  { id: 'us/virginia', name: 'us/virginia', parent: 'north-america', pbf: 'x', updates: 'x' },
  { id: 'us/west-virginia', name: 'us/west-virginia', parent: 'north-america', pbf: 'x', updates: 'x' },
  { id: 'us/district-of-columbia', name: 'us/district-of-columbia', parent: 'north-america', pbf: 'x', updates: 'x' },
  { id: 'europe', name: 'Europe', parent: null, pbf: 'x', updates: 'x' },
  { id: 'italy', name: 'Italy', parent: 'europe', pbf: 'x', updates: 'x' },
  { id: 'nord-ovest', name: 'Nord-Ovest', parent: 'italy', pbf: 'x', updates: 'x' },
]

describe('regionLabel', () => {
  it('turns an id-as-name into a name, and leaves a real name alone', () => {
    expect(regionLabel({ name: 'us/virginia' })).toBe('Virginia')
    expect(regionLabel({ name: 'us/district-of-columbia' })).toBe('District of Columbia')
    expect(regionLabel({ name: 'North America' })).toBe('North America')
  })
  it('says what the service says, so a run is labelled like its row', () => {
    for (const f of seed.features) expect(regionLabel(f.properties)).toBe(serviceLabel(f.properties))
  })
})

describe('buildRegionTree', () => {
  it('puts the US states under the US, not beside Canada', () => {
    const roots = buildRegionTree(CATALOGUE)
    expect(roots.map((r) => r.id)).toEqual(['europe', 'north-america'])
    const na = roots.find((r) => r.id === 'north-america')!
    expect(na.children.map((c) => c.id)).toEqual(['canada', 'us'])
    const us = na.children.find((c) => c.id === 'us')!
    expect(us.children.map((c) => c.label)).toEqual(['District of Columbia', 'Virginia', 'West Virginia'])
  })
  it('keeps parent nesting where the index has it', () => {
    const eu = buildRegionTree(CATALOGUE).find((r) => r.id === 'europe')!
    expect(eu.children[0].id).toBe('italy')
    expect(eu.children[0].children[0].id).toBe('nord-ovest')
  })
})

describe('searchRegions', () => {
  it('ranks a name that starts with the text above one that merely contains it', () => {
    expect(searchRegions(CATALOGUE, 'virginia').map((r) => r.id)).toEqual(['us/virginia', 'us/west-virginia'])
    expect(searchRegions(CATALOGUE, 'colum')[0].id).toBe('us/district-of-columbia')
  })
  it('matches nothing on one letter: the tree is for browsing', () => {
    expect(searchRegions(CATALOGUE, 'v')).toEqual([])
  })
})

describe('worldVerdict', () => {
  const base = { slug: 'dc-metro-take-2', name: 'DC', placed: true }
  it('says which instance serves a world', () => {
    expect(worldVerdict({ ...base, upstream: 'overpass-na', route: ['overpass-na'] })).toEqual({ kind: 'ok', text: 'overpass-na' })
  })
  it('names the dc-metro failure while a fence is still on a URL', () => {
    const v = worldVerdict({ ...base, upstream: 'overpass-na', route: ['overpass-na'], fences: { upstream: 'overpass', outside: 0.353 } })
    expect(v.kind).toBe('misrouted')
    expect(v.text).toMatch(/fences send it to overpass, whose extract leaves 35\.3% of it out — routed to overpass-na instead/)
  })
  it('a world no instance holds goes to the mirrors, and says which came closest', () => {
    const v = worldVerdict({ ...base, upstream: null, route: [], verdicts: [{ name: 'overpass', covered: false, outside: 0.353, exact: true, claims: 'regions' }] })
    expect(v.kind).toBe('mirrors')
    expect(v.text).toMatch(/closest: overpass, 35\.3% outside/)
  })
})

describe('formatting', () => {
  it('sizes and ages read at a glance', () => {
    expect(fmtBytes(428281081)).toBe('408 MiB')
    expect(fmtBytes(19493429182)).toBe('18.2 GiB')
    expect(fmtAge(17.7)).toBe('18 h old')
    expect(fmtAge(72)).toBe('3 d old')
    expect(fmtAge(null)).toBe('unknown')
  })
})
