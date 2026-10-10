// THE HALF OF THE REVERSED-DEPTH POLYGON OFFSET THREE DOES ITSELF.
//
// render/depth.ts `setPolygonOffset` turns only the UNITS round under a reversed depth buffer,
// because three r185's WebGLState.setPolygonOffset already negates the FACTOR (and not the units).
// If a three upgrade changes that — negates both, or neither — every reversed-depth offset in every
// game silently points the wrong way. This reads three's own source and fails loudly when it does.
// (Reads node:fs, so it is excluded from the engine's tsc like pyrprobe.test.ts.)
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('three: reversed-depth polygon offset', () => {
  it('negates the factor and not the units', () => {
    const require = createRequire(import.meta.url)
    // three's own entry lives in its build/ directory; the module build sits beside it (neither the
    // manifest nor the build files are in the package's exports map)
    const build = dirname(require.resolve('three'))
    const src = readFileSync(join(build, 'three.module.js'), 'utf8')
    const start = src.indexOf('function setPolygonOffset(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('function setScissorTest(', start))
    expect(body).toMatch(/getReversed\(\)/)
    expect(body).toMatch(/factor\s*=\s*-\s*factor/)
    expect(body).not.toMatch(/units\s*=\s*-\s*units/)
  })
})
