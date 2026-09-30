// The property that makes this package worth being a package: it depends on NOTHING.
//
// Rich, 2026-09-29, on splitting the repositories: *"I don't do typescript so I don't know if it's
// possible if I keep stuntin on the arcade repo and separate corridor to its own application, how
// I could pull in the stuntin' library."* It is possible, and this is the test that keeps it
// possible — the day somebody reaches for `three` or `@apex/engine` in here, this folder stops
// being liftable into another repository and nothing else would say so until the split was tried.
//
// It reads the source rather than the module graph on purpose: a type-only import vanishes at
// runtime, so a graph check would pass on a file that cannot be compiled anywhere else.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PIECE_BY_TYPE } from '../src/pieces'
import { CELL, LOOP_RADIUS } from '../src/geometry'

const SRC = new URL('../src', import.meta.url).pathname

describe('@apex/stunt-pieces stands alone', () => {
  it('imports nothing outside itself', () => {
    const offenders: string[] = []
    for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(SRC, f), 'utf8')
      for (const m of text.matchAll(/^\s*(?:import|export)\s[^\n]*?from\s+'([^']+)'/gm)) {
        if (!m[1].startsWith('./') && !m[1].startsWith('../')) offenders.push(`${f}: ${m[1]}`)
      }
    }
    expect(offenders, `these would stop the package moving to another repository:\n${offenders.join('\n')}`).toEqual([])
  })

  it('declares no dependencies in its package.json either', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'))
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.peerDependencies ?? {}).toEqual({})
  })

  /*
   * AND IT IS STILL THE REAL VOCABULARY. The check above passes just as happily on an empty folder,
   * so this asserts the thing the package exists to carry.
   */
  it('still carries the pieces both games are built from', () => {
    for (const type of ['loop', 'corkscrew', 'bank6', 'jump', 'straight', 'curve', 'tunnel']) {
      expect(PIECE_BY_TYPE[type], type).toBeTruthy()
      expect(PIECE_BY_TYPE[type].lanes.length).toBeGreaterThan(0)
    }
    expect(CELL).toBe(40)
    expect(LOOP_RADIUS).toBe(18)
  })

  it('every piece can be driven: its lane answers at both ends and in the middle', () => {
    for (const [type, def] of Object.entries(PIECE_BY_TYPE)) {
      for (const lane of def.lanes) {
        for (const t of [0, 0.5, 1]) {
          const o = { x: 0, y: 0, z: 0, ux: 0, uy: 1, uz: 0, roll: 0, surface: true }
          lane.path(t, o)
          expect(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z), `${type} at t=${t}`).toBe(true)
        }
      }
    }
  })
})
