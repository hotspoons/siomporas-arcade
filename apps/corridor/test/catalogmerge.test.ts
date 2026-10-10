import { describe, expect, it } from 'vitest'
import type { PlaceableEntry } from '../src/assets/catalogmerge'
import type { AssetItem } from '../src/assets/assetsvc'

// assetsvc.ts reads `location.search` at module scope; the stub goes in before the module does —
// a static import would be hoisted above it
;(globalThis as { location?: unknown }).location ??= { search: '' }
const { builtinEntries, libraryEntries, mergeCatalog, shippedEntries } = await import('../src/assets/catalogmerge')

const entry = (id: string, glb: string | null, category = 'prop'): PlaceableEntry => ({ id, name: id, category, glb, footprint_m: [4, 4], height_m: 3 })

describe('builtinEntries — what the Catalog lists beside the library', () => {
  const doc = {
    assets: [
      entry('watertower-01', 'assets/watertower-01.glb', 'utility'),
      entry('horsebridge-01', 'assets/horsebridge-01.glb', 'bridge'),
      entry('house-01', null, 'house'), // a box with a name: the place editor does not offer it
      entry('3000gt-vr4', 'assetsvc/catalog/3000gt-vr4/file/mesh.finished.glb'), // a ticked library item
      entry('diner-01', 'assets/diner-01.glb', 'restaurant'),
    ],
  }

  it('is every placeable entry with a model that is not a library item', () => {
    const ids = builtinEntries(doc, new Set(['diner-01'])).map((e) => e.id)
    expect(ids).toEqual(['watertower-01', 'horsebridge-01'])
  })

  it('leaves out a model served by the asset service even when the item is gone from the library', () => {
    expect(builtinEntries(doc, new Set()).map((e) => e.id)).not.toContain('3000gt-vr4')
  })

  it('together with the library, covers everything the place editor merges', () => {
    const lib = [{ id: 'diner-01', subject: 'diner', kind: 'building', finished: 1, mesh: 1 } as unknown as AssetItem]
    const placeable = mergeCatalog(shippedEntries(doc), libraryEntries(lib)).map((e) => e.id)
    const listed = new Set([...lib.map((x) => x.id), ...builtinEntries(doc, new Set(lib.map((x) => x.id))).map((e) => e.id), '3000gt-vr4'])
    for (const id of placeable) expect(listed.has(id)).toBe(true)
  })

  it('is empty when there is no placeable list at all', () => {
    expect(builtinEntries(null, new Set())).toEqual([])
  })
})
