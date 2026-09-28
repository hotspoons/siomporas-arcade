// Does a write in the shell land on the right document?
//
// That is the one thing about the projection that can go quietly wrong. A program saved as a level
// does not throw — the service takes the PUT, validates something that is not a level, and the
// person finds out when the level will not open. So these tests are about the mapping, in both
// directions, including the paths that must map to NOTHING.
import { describe, expect, it } from 'vitest'
import { ROOT, SITE_DOCS, bodyFor, checkBody, endpointFor, pathsFor, readme } from '../src/agent/projection'

describe('endpointFor', () => {
  it('maps each kind of document to its own endpoint', () => {
    expect(endpointFor(`${ROOT}/worlds/crofton-triangle.json`)).toMatchObject({ url: '/api/worlds/crofton-triangle', body: 'json' })
    expect(endpointFor(`${ROOT}/levels/rooftop.json`)).toMatchObject({ url: '/api/levels/rooftop', body: 'json' })
    expect(endpointFor(`${ROOT}/programs/rooftop.ts`)).toMatchObject({ url: '/api/programs/rooftop', body: 'source' })
    expect(endpointFor(`${ROOT}/sites/crofton-triangle/presets.json`)).toMatchObject({ url: '/sites/crofton-triangle/presets.json', body: 'json' })
  })

  it('sends a program as `{ source }` and everything else as itself', () => {
    const prog = endpointFor(`${ROOT}/programs/a.ts`)!
    expect(JSON.parse(bodyFor(prog, 'export default 1'))).toEqual({ source: 'export default 1' })
    const level = endpointFor(`${ROOT}/levels/a.json`)!
    expect(bodyFor(level, '{"id":"a"}')).toBe('{"id":"a"}')
  })

  it('maps the shell’s own files nowhere, which is not a failure', () => {
    // a shell you cannot keep a scratch file in is not a shell
    for (const p of [`${ROOT}/out/notes.md`, `${ROOT}/scratch.py`, `${ROOT}/README.md`, `${ROOT}/out/plot.png`]) {
      expect(endpointFor(p), p).toBeNull()
    }
  })

  it('refuses a path that would write outside the documents', () => {
    for (const p of [
      '/etc/passwd',
      `${ROOT}/../etc/passwd`,
      `${ROOT}/worlds/../../api/git/credential`,
      `${ROOT}/worlds/..%2f..%2fsecret.json`,
      `${ROOT}/programs/a/b.ts`,
      `${ROOT}/sites/crofton/dem_1m.tif`,
      `${ROOT}/sites/crofton/tiles/0_0.ktx2`,
      `${ROOT}/worlds/Crofton.json`,
      `${ROOT}/worlds/.json`,
    ]) {
      expect(endpointFor(p), p).toBeNull()
    }
  })

  it('never projects the bake, whatever it is called', () => {
    // the rasters are gigabytes and reproducible; a shell that mirrors them is a tab out of memory
    for (const f of ['dem_1m.tif', 'naip_overview.jpg', 'manifest.json', 'branches.json', 'flora.json']) {
      expect(endpointFor(`${ROOT}/sites/crofton/${f}`), f).toBeNull()
    }
    // and the ones it does project are exactly the ones git commits
    for (const f of SITE_DOCS) expect(endpointFor(`${ROOT}/sites/crofton/${f}`), f).toBeTruthy()
  })
})

describe('pathsFor', () => {
  it('projects what the service says exists', () => {
    const paths = pathsFor({
      worlds: [{ slug: 'crofton-triangle' }, { slug: 'arrowhead-farms' }],
      levels: [{ id: 'rooftop' }],
      programs: [{ id: 'rooftop' }],
      sites: [{ slug: 'crofton-triangle', docs: ['tuning.json', 'presets.json', 'dem_1m.tif'] }],
    })
    expect(paths).toEqual([
      `${ROOT}/worlds/crofton-triangle.json`,
      `${ROOT}/worlds/arrowhead-farms.json`,
      `${ROOT}/levels/rooftop.json`,
      `${ROOT}/programs/rooftop.ts`,
      `${ROOT}/sites/crofton-triangle/tuning.json`,
      `${ROOT}/sites/crofton-triangle/presets.json`,
    ])
  })

  it('drops a slug it would not accept back', () => {
    // a name that cannot be written to is a file that looks editable and is not
    const paths = pathsFor({ worlds: [{ slug: '../evil' }, { slug: 'Fine' }, { slug: 'fine' }] })
    expect(paths).toEqual([`${ROOT}/worlds/fine.json`])
  })

  it('projects nothing from nothing', () => {
    expect(pathsFor({})).toEqual([])
  })

  it('round-trips: every path it makes has an endpoint', () => {
    const docs = {
      worlds: [{ slug: 'a' }],
      levels: [{ id: 'b' }],
      programs: [{ id: 'c' }],
      sites: [{ slug: 'd', docs: SITE_DOCS }],
    }
    for (const p of pathsFor(docs)) expect(endpointFor(p), p).toBeTruthy()
  })
})

describe('checkBody', () => {
  it('catches JSON a sed went through before the service has to', () => {
    const e = endpointFor(`${ROOT}/levels/a.json`)!
    expect(checkBody(e, '{"id":"a"}')).toBeNull()
    expect(checkBody(e, '{"id":"a",}')).toContain('not valid JSON')
    expect(checkBody(e, '[1,2]')).toBeNull() // an array IS an object to typeof; the service judges the shape
    expect(checkBody(e, '"just a string"')).toContain('JSON object')
    expect(checkBody(e, '')).toContain('not valid JSON')
  })

  it('lets any text be a program but caps the size', () => {
    const e = endpointFor(`${ROOT}/programs/a.ts`)!
    expect(checkBody(e, 'not json at all')).toBeNull()
    expect(checkBody(e, 'x'.repeat(600 * 1024))).toContain('512 kB')
  })
})

describe('readme', () => {
  it('says what saving does, because an agent will find out by doing it otherwise', () => {
    const text = readme({ worlds: [{ slug: 'a' }], levels: [], programs: [], sites: [] })
    expect(text).toContain('SAVING IS IMMEDIATE')
    expect(text).toContain('out/')
    expect(text).toContain('1 world')
    expect(text).toContain('The bake is NOT here')
  })
})
