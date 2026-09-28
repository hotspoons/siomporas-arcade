// The two path rules in the editor that are easy to get subtly wrong.
//
// Rich, 2026-09-28: "Its okay to auto-name things with a .ts extension but don't always add it on
// files especially on renames/moves. We might want json too." Appending `.ts` to anything it did
// not recognise turned a rename to `test.xyz` into `test.xyz.ts` — a file with a name nobody
// typed, which is how you end up with two of everything.
import { describe, expect, it } from 'vitest'
import { extOf, withExt } from '../src/ui/programpanel'
import { relativeSpecifier } from '../src/ui/codeeditor'

describe('the extension a typed path ends up with', () => {
  it('a NEW file with no extension gets .ts, because most of them are', () => {
    expect(withExt('levels/rooftop')).toBe('levels/rooftop.ts')
    expect(withExt('intro')).toBe('intro.ts')
  })

  it('a RENAME with no extension keeps the one the file already had', () => {
    // renaming `chase.json` to `pursuit` means `pursuit.json`; turning it into TypeScript behind
    // somebody's back would be an odd thing to do
    expect(withExt('pursuit', 'lib/chase.json')).toBe('pursuit.json')
    expect(withExt('lib/pursuit', 'lib/chase.ts')).toBe('lib/pursuit.ts')
  })

  it('an extension that IS typed is taken as typed — that is how you change one', () => {
    expect(withExt('data.json', 'data.ts')).toBe('data.json')
    expect(withExt('notes.md', 'notes.ts')).toBe('notes.md')
    // including one that will then be refused, rather than quietly becoming `.xyz.ts`
    expect(withExt('test.xyz', 'test.ts')).toBe('test.xyz')
  })

  it('a trailing dot is not an extension', () => {
    expect(withExt('thing.')).toBe('thing.ts')
  })

  it('a dot in a FOLDER is not the file extension', () => {
    expect(extOf('v1.2/thing')).toBe('')
    expect(withExt('v1.2/thing')).toBe('v1.2/thing.ts')
    expect(extOf('v1.2/thing.json')).toBe('.json')
  })
})

describe('the specifier that gets you from one file to another', () => {
  const at = (from: string, to: string) => relativeSpecifier(`programs/${from}`, `programs/${to}`)

  it('a sibling is ./name', () => {
    expect(at('levels/a.ts', 'levels/b.ts')).toBe('./b')
  })

  it('goes up as far as it has to', () => {
    expect(at('levels/deep/a.ts', 'lib/helpers.ts')).toBe('../../lib/helpers')
    expect(at('a.ts', 'lib/helpers.ts')).toBe('./lib/helpers')
  })

  it('drops .ts, which TypeScript resolves, and KEEPS .json, which it does not', () => {
    expect(at('a.ts', 'lib/tuning.json')).toBe('./lib/tuning.json')
    expect(at('a.ts', 'lib/helpers.ts')).toBe('./lib/helpers')
  })

  it('is always explicitly relative', () => {
    // a bare `lib/thing` is a PACKAGE name to a module resolver, so a suggestion without the `./`
    // resolves to nothing and reads as a broken import
    for (const to of ['lib/a.ts', 'b.ts', 'deep/c/d.ts']) {
      expect(at('top.ts', to)!.startsWith('.')).toBe(true)
    }
  })

  it('offers nothing for a file that cannot be imported', () => {
    expect(at('a.ts', 'notes.md')).toBe(null)
    expect(at('a.ts', 'shader.glsl')).toBe(null)
  })
})
