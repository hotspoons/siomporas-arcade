// Does the water builder stream without changing what it draws?
//
// A tiled world hands `buildWater` no channels at all and feeds them in per cell with `add`, merging
// the geometry into one mesh per look on `flush`. The risk this pins is that streaming quietly
// changes the DRAW — duplicate meshes, a dropped body, a lost fall — which no arithmetic check in a
// render-free test would otherwise catch.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildWater, type WaterArea, type WaterLayer, type WaterLine } from '../src/world/water'

function line(id: string, fall = false): WaterLine {
  return {
    id, kind: 'stream', name: id, width_m: 4, culvert: false, length_m: 120, fall_m: fall ? 2 : 0,
    pts: [[0, 0, 10], [30, 0, 10.5], [60, 0, 11]],
    falls: fall ? [{ i0: 0, i1: 2, drop_m: 2, length_m: 60, grade: 0.03, kind: 'falls' }] : [],
  }
}
function area(id: string): WaterArea {
  return { id, kind: 'pond', name: id, area_m2: 900, z: 9, ring: [[100, 0], [130, 0], [130, 30], [100, 30]] }
}
function cell(lines: WaterLine[], areas: WaterArea[]): WaterLayer {
  return { lines, areas }
}

const namesOf = (water: { group: THREE.Group }) => water.group.children.map((c) => c.name).sort()
const countNamed = (water: { group: THREE.Group }, prefix: string) =>
  water.group.children.filter((c) => c.name.startsWith(prefix)).length

describe('streamed water', () => {
  it('builds one mesh per look and one for the sea, whether the bodies come whole or per cell', () => {
    const whole = buildWater(cell([line('a'), line('b')], [area('p')]), () => null)
    expect(whole.lines).toBe(2)
    expect(whole.areas).toBe(1)
    expect(countNamed(whole, 'water:streams:')).toBe(1)
    expect(countNamed(whole, 'water:areas:')).toBe(1)
    expect(namesOf(whole)).toContain('water:level')

    // the same bodies, streamed: one cell first, then the second
    const streamed = buildWater(null, () => null)
    expect(streamed.lines).toBe(0)
    streamed.add(cell([line('a')], [area('p')]))
    streamed.flush()
    expect(streamed.lines).toBe(1)
    expect(streamed.areas).toBe(1)
    streamed.add(cell([line('b')], []))
    streamed.flush()
    expect(streamed.lines).toBe(2)
    // the merge replaces the mesh's geometry in place: still one streams mesh, not two
    expect(countNamed(streamed, 'water:streams:')).toBe(1)
    expect(countNamed(streamed, 'water:areas:')).toBe(1)
    expect(namesOf(streamed)).toEqual(namesOf(whole))
  })

  it('carries a fall into a foam mesh and keeps it once, streamed like the rest', () => {
    const streamed = buildWater(null, () => null)
    streamed.add(cell([line('a', true)], []))
    streamed.flush()
    expect(streamed.falls).toBe(1)
    expect(countNamed(streamed, 'water:foam')).toBe(1)
  })

  it('does nothing on flush when no cell has arrived', () => {
    const streamed = buildWater(null, () => null)
    const before = namesOf(streamed)
    streamed.flush()
    expect(namesOf(streamed)).toEqual(before)
  })
})
