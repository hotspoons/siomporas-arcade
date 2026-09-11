// The two scripts that prepare artwork live outside the app, because they run at install time and
// never ship. Each therefore keeps its own copy of a shape it has to agree with the cabinet about:
// the bezel fitter, the face it nine-slices a frame onto; the template drawer, the outline of a
// side board. Nothing at runtime would notice either drifting — the artwork would simply stop
// lining up with the machine, months later and one panel at a time — so it is checked here.
//
// Both are read as text rather than imported: they are plain node scripts that shell out to
// ImageMagick, and none of that belongs in a unit test.

import { describe, expect, it } from 'vitest'
import bezelScript from '../../../scripts/lib/bezel.mjs?raw'
import flankScript from '../../../scripts/lib/flank.mjs?raw'
import { BEZEL_FIT, FLANK_FIT } from '../src/lobby/Cabinet'

/** The `export const FACE = {...}` literal out of the script, as data. */
function scriptFace(): typeof BEZEL_FIT {
  const m = /export const FACE = (\{.*\})/.exec(bezelScript)
  if (!m) throw new Error('scripts/lib/bezel.mjs no longer declares FACE on one line')
  return JSON.parse(m[1].replace(/([{,]\s*)([A-Za-z]\w*):/g, '$1"$2":')) as typeof BEZEL_FIT
}

/** A `const NAME = <literal>` out of a script, as data. */
function constant(src: string, name: string): unknown {
  const m = new RegExp(`const ${name} = (\\[[^=]*?\\]|\\{.*\\}|[\\d.]+)\n`, 's').exec(src.replace(/export /g, ''))
  if (!m) throw new Error(`${name} is no longer declared the way this test reads it`)
  return JSON.parse(m[1].replace(/([{,]\s*)([A-Za-z]\w*):/g, '$1"$2":').replace(/,(\s*[\]}])/g, '$1'))
}

describe('bezel fit', () => {
  it('matches what scripts/lib/bezel.mjs nine-slices artwork onto', () => {
    const face = scriptFace()
    expect(face.aspect).toBeCloseTo(BEZEL_FIT.aspect, 4)
    expect(face.hole.x0).toBeCloseTo(BEZEL_FIT.hole.x0, 4)
    expect(face.hole.y0).toBeCloseTo(BEZEL_FIT.hole.y0, 4)
    expect(face.hole.x1).toBeCloseTo(BEZEL_FIT.hole.x1, 4)
    expect(face.hole.y1).toBeCloseTo(BEZEL_FIT.hole.y1, 4)
  })

  it('draws side templates in the shape of a side board', () => {
    const outline = constant(flankScript, 'OUTLINE') as Array<[number, number]>
    const aspect = constant(flankScript, 'ASPECT') as number
    expect(aspect).toBeCloseTo(FLANK_FIT.aspect, 5)
    expect(outline).toHaveLength(FLANK_FIT.outline.length)
    outline.forEach(([u, v], i) => {
      expect(u).toBeCloseTo(FLANK_FIT.outline[i][0], 5)
      expect(v).toBeCloseTo(FLANK_FIT.outline[i][1], 5)
    })
  })

  it('puts the hole inside the face, right way up and symmetric', () => {
    const h = BEZEL_FIT.hole
    expect(h.x0).toBeGreaterThan(0)
    expect(h.x1).toBeLessThan(1)
    expect(h.y1).toBeGreaterThan(h.y0)
    expect(h.x0 + h.x1).toBeCloseTo(1, 6)
    expect(h.y0 + h.y1).toBeCloseTo(1, 6)
  })
})
