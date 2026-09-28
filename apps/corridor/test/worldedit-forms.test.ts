// Two small things that are wrong in a way nobody reports as a bug.
//
// THE SLUG the form shows has to be the slug the service creates. If they differ, the form says
// `crofton-triangle` and the world is stored as something else — and nothing anywhere fails, the
// world is simply not where you look for it. The browser cannot call the service's slugify, so
// there are two copies of the rule, and the only honest way to keep them the same is to run both
// over a corpus.
//
// THE ELAPSED TIME is easier to get wrong than it looks: a bake runs for hours, and `72m` and
// `4320s` are both technically the answer to a question nobody asked.
import { describe, expect, it } from 'vitest'
// the service's own rule, imported straight out of the service
import { slugify } from '../../../tools/worldeditor/geo.mjs'
import { slugFromName } from '../src/worldedit/slug'
import { elapsed } from '../src/worldedit/runs'

describe('slugFromName', () => {
  it('turns a name into a slug the way a person would expect', () => {
    expect(slugFromName('Crofton Triangle')).toBe('crofton-triangle')
    expect(slugFromName("Rich's Big Hill")).toBe('rich-s-big-hill')
    expect(slugFromName('  spaces   everywhere  ')).toBe('spaces-everywhere')
    expect(slugFromName('Route 3 / MD-450')).toBe('route-3-md-450')
    expect(slugFromName('')).toBe('')
  })

  it('agrees with the service, character for character, over a corpus', () => {
    // the two copies of the rule cannot be made into one — one runs in a browser and one in the
    // service — so they are compared instead
    const corpus = [
      'Crofton Triangle', 'crofton-triangle', 'CROFTON', 'Ecola OR', 'Bixby Bridge, CA-1',
      "Rich's Big Hill", 'Route 3 / MD-450', 'Sideling Hill I-68', '  padded  ', '---', '',
      'Ünïcödé Plåce', 'ß', 'emoji 🚗 here', 'a'.repeat(80), 'tabs\tand\nnewlines',
      '42', 'x'.repeat(48), 'x'.repeat(49), 'trailing-hyphen-', '-leading', 'double--hyphen',
      'Ægir', 'naïve café', 'Москва', '東京', 'a.b.c', 'a_b_c', 'a+b', 'a&b', '100%',
    ]
    for (const s of corpus) expect(slugFromName(s), JSON.stringify(s)).toBe(slugify(s))
  })

  it('caps the length the same way, so a long name does not diverge at the end', () => {
    const long = 'The Very Long Name Of A Place Somebody Typed In Full Without Stopping'
    expect(slugFromName(long)).toBe(slugify(long))
    expect(slugFromName(long).length).toBeLessThanOrEqual(48)
  })
})

describe('elapsed', () => {
  it('reads in the largest unit that still says something', () => {
    expect(elapsed(0)).toBe('0s')
    expect(elapsed(9)).toBe('9s')
    expect(elapsed(59)).toBe('59s')
    expect(elapsed(60)).toBe('1m 0s')
    expect(elapsed(125)).toBe('2m 5s')
    expect(elapsed(3599)).toBe('59m 59s')
    // a bake runs for hours, and the question is whether it has been ten minutes or all afternoon
    expect(elapsed(3600)).toBe('1h 0m')
    expect(elapsed(4320)).toBe('1h 12m')
    expect(elapsed(3600 * 9 + 60 * 5)).toBe('9h 5m')
  })

  it('does not go backwards for a clock that disagrees with the server', () => {
    // a `started` in the future is a client and a server a few seconds apart, not a negative bake
    expect(elapsed(-5)).toBe('0s')
  })
})
