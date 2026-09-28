// Is the type bundle the program editor loads still describing the API that exists?
//
// `src/generated/program-types.json` is emitted from the real sources by
// scripts/gen-program-types.mjs and checked in, because running tsc in the browser would mean
// shipping the whole app's source to every page. The cost of checking it in is that it can go
// stale, and a stale bundle is the worst kind of wrong: the editor is confidently green about an
// API that no longer exists, and nothing anywhere says so.
//
// So the bundle carries a hash of every source it was derived from, and this compares them. A
// millisecond, rather than the fifteen seconds a real regeneration takes — a freshness check that
// is slow enough to skip is a freshness check nobody runs.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import bundle from '../src/generated/program-types.json'

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))
const sha = (p: string) => createHash('sha1').update(readFileSync(repo(p))).digest('hex').slice(0, 16)

describe('the program type bundle', () => {
  it('matches the sources it was generated from', () => {
    const stale: string[] = []
    for (const [path, want] of Object.entries(bundle.sources as Record<string, string>)) {
      if (sha(path) !== want) stale.push(path)
    }
    expect(stale, `run: node scripts/gen-program-types.mjs`).toEqual([])
  })

  it('covers every module a program may import', () => {
    for (const name of ['@apex/program', '@apex/actors', '@apex/actorworld', '@apex/ecsconfig', '@apex/traffic']) {
      expect(Object.keys(bundle.alias)).toContain(name)
    }
  })

  it('lays the declarations out as a node_modules tree', () => {
    // the one layout TypeScript's real resolver handles without a `paths` mapping; with anything
    // else the editor resolves the module and then reports that it has no exported members
    const files = Object.keys(bundle.libs)
    for (const name of Object.keys(bundle.alias)) {
      expect(files, name).toContain(`file:///node_modules/${name}/index.d.ts`)
    }
    expect(files).toContain('file:///node_modules/bitecs/package.json')
    expect(files.some((f) => f.startsWith('file:///node_modules/bitecs/dist/'))).toBe(true)
  })

  it('actually declares the API the editor completes against', () => {
    const program = (bundle.libs as Record<string, string>)['file:///corridor/program.d.ts']
    expect(program).toBeTruthy()
    // the three things a program's first line touches
    expect(program).toContain('defineGame')
    expect(program).toContain('GameApi')
    expect(program).toContain('HIDEABLE')
    // and the literal unions that make a typo an error rather than a silent no-op
    expect(program).toContain("'street-names'")
  })
})
