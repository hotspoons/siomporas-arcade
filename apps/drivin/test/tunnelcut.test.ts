import { describe, expect, it } from 'vitest'
import { Track, type TrackData } from '../src/sim/Track'
import { brushTerrain, flatTerrain } from '../src/sim/terrain'
import { CELL } from '../src/sim/Tuning'

/** A straight run west to east with tunnel pieces in the middle, driven into the side of a hill. */
function hillTunnel(hill: number): TrackData {
  const size = 14
  const terrain = flatTerrain(size)
  brushTerrain(terrain, size, 7, 6, 4, hill)
  const pieces = [
    { type: 'start', x: 2, z: 6, rot: 0, level: 0 },
    { type: 'straight', x: 3, z: 6, rot: 0, level: 0 },
    { type: 'straight', x: 4, z: 6, rot: 0, level: 0 },
    { type: 'tunnel1', x: 5, z: 6, rot: 0, level: 0 },
    { type: 'tunnel', x: 6, z: 6, rot: 0, level: 0 },
    { type: 'tunnel1', x: 8, z: 6, rot: 0, level: 0 },
    { type: 'straight', x: 9, z: 6, rot: 0, level: 0 },
    { type: 'straight', x: 10, z: 6, rot: 0, level: 0 },
  ]
  return { name: 'Hill tunnel', size, pieces, terrain }
}

/** The worst amount by which ground stands above the tarmac, over every lane of a track. */
function groundOverRoad(t: Track): number {
  let worst = -Infinity
  for (const lane of t.lanes) {
    const table = lane.table
    for (let i = 0; i < table.pos.length; i += 3) worst = Math.max(worst, t.groundHeight(table.pos[i], table.pos[i + 2]) - table.pos[i + 1])
  }
  return worst
}

describe('roads dug into a hillside', () => {
  it('never leaves ground standing above the tarmac', () => {
    for (const hill of [12, 26, 60]) expect(groundOverRoad(new Track(hillTunnel(hill)))).toBeLessThan(0.05)
  })

  it('does not dig a trench where the road is already on the flat', () => {
    // The cut only takes ground that stands above the tarmac: level land is left where it is, so a
    // road on the flat still meets the grass at the shoulder.
    const t = new Track(hillTunnel(0))
    for (const lane of t.lanes) {
      const table = lane.table
      for (let i = 0; i < table.pos.length; i += 3) expect(Math.abs(t.groundHeight(table.pos[i], table.pos[i + 2]) - table.pos[i + 1])).toBeLessThan(0.05)
    }
  })

  it('banks the cutting instead of walling it', () => {
    // A cell out from the road the land may stand higher, so a dip has sides rather than a slot.
    const t = new Track(hillTunnel(60))
    expect(t.groundHeight(7 * CELL, 4.4 * CELL)).toBeGreaterThan(5)
  })
})
