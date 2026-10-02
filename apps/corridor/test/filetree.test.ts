// The only part of a file tree that can be wrong without a browser: the tree.
//
// It is derived from paths on every render, so the bugs it can have are structural — a folder
// that swallows a sibling, a count that stops at one level, a path ending in a slash becoming a
// file with no name.
import { describe, expect, it } from 'vitest'
import { countIn, treeOf } from '../src/editor/program/filetree'

const rows = (...p: string[]) => p.map((path) => ({ path }))

describe('the tree is derived from the paths', () => {
  it('folders come from slashes and nothing else', () => {
    const t = treeOf(rows('a.ts', 'levels/one.ts', 'levels/two.ts', 'levels/deep/three.ts'))
    expect(t.files.map((f) => f.path)).toEqual(['a.ts'])
    expect([...t.dirs.keys()]).toEqual(['levels'])
    const levels = t.dirs.get('levels')!
    expect(levels.files.map((f) => f.path)).toEqual(['levels/one.ts', 'levels/two.ts'])
    expect(levels.dirs.get('deep')!.files.map((f) => f.path)).toEqual(['levels/deep/three.ts'])
  })

  it('a folder knows how many files are under it at ANY depth', () => {
    // the count on a collapsed folder is the only thing that says what is inside it, so a count
    // that stopped at the first level would say "1" about a folder holding thirty files
    const t = treeOf(rows('p/a.ts', 'p/q/b.ts', 'p/q/r/c.ts', 'p/q/r/d.ts'))
    expect(countIn(t)).toBe(4)
    expect(countIn(t.dirs.get('p')!)).toBe(4)
    expect(countIn(t.dirs.get('p')!.dirs.get('q')!)).toBe(3)
    expect(countIn(t.dirs.get('p')!.dirs.get('q')!.dirs.get('r')!)).toBe(2)
  })

  it('a folder path is the whole path, not the segment', () => {
    // it is the localStorage key for "this folder is shut", so two folders called `src` in
    // different places would otherwise collapse together
    const t = treeOf(rows('one/src/a.ts', 'two/src/b.ts'))
    expect(t.dirs.get('one')!.dirs.get('src')!.path).toBe('one/src')
    expect(t.dirs.get('two')!.dirs.get('src')!.path).toBe('two/src')
  })

  it('a path that is only a folder is not a file', () => {
    const t = treeOf(rows('out/', 'out/real.ts'))
    expect(countIn(t)).toBe(1)
    expect(t.dirs.get('out')!.files.map((f) => f.path)).toEqual(['out/real.ts'])
  })

  it('leading and doubled slashes do not make empty folders', () => {
    const t = treeOf(rows('/a/b.ts', 'a//c.ts'))
    expect([...t.dirs.keys()]).toEqual(['a'])
    expect(countIn(t)).toBe(2)
  })
})
