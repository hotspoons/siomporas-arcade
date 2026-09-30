// A frame warning is about coordinates. A file with none cannot be in the wrong frame.
//
// Rich, 2026-09-30, on a brand new bake: the editor said adjustments.json "was authored in a
// different frame … authored before frames were stamped" — about a file that did not exist. The
// loader hands back an empty default for a document never written, and the check took "no stamp"
// for "old".
import { describe, expect, it } from 'vitest'
import { frameMismatch } from '../src/editor/schema'
import type { Manifest } from '../src/site'

const enu = { frame: { kind: 'enu', epsg: 32618, anchor: { lon: -76.7, lat: 39.0 } } } as unknown as Manifest

describe('frameMismatch', () => {
  it('says nothing about a file with no coordinates in it, stamped or not', () => {
    expect(frameMismatch(undefined, enu, 0)).toBeNull()
    expect(frameMismatch({ kind: 'utm' }, enu, 0)).toBeNull()
  })
  it('still warns about an unstamped file that has coordinates', () => {
    expect(frameMismatch(undefined, enu, 3)).toMatch(/before frames were stamped/)
    expect(frameMismatch(undefined, enu)).toMatch(/before frames were stamped/)
  })
  it('matches a stamp against the bake', () => {
    expect(frameMismatch({ kind: 'enu', anchor: { lon: -76.7, lat: 39.0 } }, enu, 3)).toBeNull()
    expect(frameMismatch({ kind: 'utm' }, enu, 3)).toMatch(/"utm" but the bake is now "enu"/)
    expect(frameMismatch({ kind: 'enu', anchor: { lon: -76.71, lat: 39.0 } }, enu, 3)).toMatch(/different anchor/)
  })
})
