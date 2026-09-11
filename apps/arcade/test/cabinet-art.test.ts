// The contract between the cabinet and the scripts that prepare artwork for it.
//
// Those scripts run over images at install time, shell out to ImageMagick, and never ship, so none
// of them can import the app's TypeScript — they keep their own copy of the machine's measurements
// in scripts/lib/fit.mjs. Nothing at runtime would notice the two drifting apart: the templates
// would simply start describing a machine we no longer build, and artwork drawn to them would stop
// lining up, months later and one panel at a time.
//
// So it is checked here. This is the contract; whether the *artwork* fits it is a different question
// and a different tool — `just art-check`, which measures every installed panel against these same
// numbers. See apps/arcade/ART.md.
//
// The script is read as text rather than imported, because importing it runs a module whose whole
// purpose is shelling out to a binary that has no business in a unit test.

import { describe, expect, it } from 'vitest'
import fitScript from '../../../scripts/lib/fit.mjs?raw'
import { ART_FIT } from '../src/lobby/Cabinet'

/** A `const NAME = <literal>` out of the script, as data. */
function constant(src: string, name: string): unknown {
  const m = new RegExp(`const ${name} = (\\[[^=]*?\\]|\\{[^=]*?\\}|[\\d.]+)\\n`, 's').exec(src.replace(/export /g, ''))
  if (!m) throw new Error(`${name} is no longer declared the way this test reads it`)
  return JSON.parse(m[1].replace(/([{,[]\s*)([A-Za-z]\w*):/g, '$1"$2":').replace(/,(\s*[\]}])/g, '$1'))
}

describe('what artwork has to fit', () => {
  it('agrees with scripts/lib/fit.mjs about every face of the machine', () => {
    expect(constant(fitScript, 'MARQUEE')).toBeCloseTo(ART_FIT.marquee, 4)
    expect(constant(fitScript, 'DECK')).toBeCloseTo(ART_FIT.deck, 4)
    expect(constant(fitScript, 'SCREEN')).toBeCloseTo(ART_FIT.screen, 4)

    const bezel = constant(fitScript, 'BEZEL') as typeof ART_FIT.bezel
    expect(bezel.aspect).toBeCloseTo(ART_FIT.bezel.aspect, 4)
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(bezel.hole[k]).toBeCloseTo(ART_FIT.bezel.hole[k], 4)

    const flank = constant(fitScript, 'FLANK') as typeof ART_FIT.flank
    expect(flank.aspect).toBeCloseTo(ART_FIT.flank.aspect, 4)
    expect(flank.outline).toHaveLength(ART_FIT.flank.outline.length)
    flank.outline.forEach(([u, v], i) => {
      expect(u).toBeCloseTo(ART_FIT.flank.outline[i][0], 4)
      expect(v).toBeCloseTo(ART_FIT.flank.outline[i][1], 4)
    })
  })

  it('puts the glass inside the bezel, right way up and centred', () => {
    const h = ART_FIT.bezel.hole
    expect(h.x0).toBeGreaterThan(0)
    expect(h.x1).toBeLessThan(1)
    expect(h.y1).toBeGreaterThan(h.y0)
    expect(h.x0 + h.x1).toBeCloseTo(1, 6)
    expect(h.y0 + h.y1).toBeCloseTo(1, 6)
    // The hole is the glass, so it has the glass's shape.
    expect(((h.x1 - h.x0) * ART_FIT.bezel.aspect) / (h.y1 - h.y0)).toBeCloseTo(ART_FIT.screen, 3)
  })

  it('describes a flank that is a closed outline filling its own bounding box', () => {
    const xs = ART_FIT.flank.outline.map(([u]) => u)
    const ys = ART_FIT.flank.outline.map(([, v]) => v)
    expect(Math.min(...xs)).toBeCloseTo(0, 6)
    expect(Math.max(...xs)).toBeCloseTo(1, 6)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(Math.max(...ys)).toBeCloseTo(1, 6)
    // The notch is the whole point of the shape: somewhere up the front there is a lot less machine
    // than there is at the bottom. Without it this is a wardrobe.
    const widthAt = (v: number): number => {
      const hits: number[] = []
      const poly = ART_FIT.flank.outline
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        if (yi > v === yj > v) continue
        hits.push(xi + ((xj - xi) * (v - yi)) / (yj - yi))
      }
      return Math.max(...hits) - Math.min(...hits)
    }
    const narrowest = Array.from({ length: 40 }, (_, i) => widthAt(0.1 + (i / 39) * 0.35)).reduce((a, b) => Math.min(a, b))
    expect(narrowest).toBeLessThan(0.8 * widthAt(0.8))
  })
})
