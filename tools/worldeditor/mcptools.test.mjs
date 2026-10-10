// The server-side tools an agent authors a level with, run against a fake service and a temp
// volume: what each one answers, and what each one refuses.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { serverTools } from './mcptools.mjs'
import { enuProjector } from './geo.mjs'

const ANCHOR = { lon: -76.670706, lat: 39.007758 }

/** a baked world: a manifest with an ENU frame, one road, and a few OSM features */
function volume() {
  const root = mkdtempSync(path.join(tmpdir(), 'we-tools-'))
  const put = (rel, obj) => {
    const p = path.join(root, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj))
  }
  put('sites/crofton/web/manifest.json', {
    slug: 'crofton',
    frame: { kind: 'enu', epsg: 32618, origin: [0, 0], anchor: { ...ANCHOR, h: 0 } },
    spine: { coords: [[0, 0], [100, 0], [200, 0]], length_m: 200, segments: [{ tags: { name: 'Main Street', lanes: 2 } }] },
    branches: [],
  })
  put('sites/crofton/osm.geojson', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { 'addr:housenumber': '2299', 'addr:street': 'Johns Hopkins Road', name: "Grump's Cafe" }, geometry: { type: 'Point', coordinates: [-76.6841597, 39.0288317] } },
      { type: 'Feature', properties: { 'addr:housenumber': '1053', 'addr:street': 'Route 3 North', 'addr:city': 'Gambrills' }, geometry: { type: 'Polygon', coordinates: [[[-76.67, 39.0], [-76.669, 39.0], [-76.669, 39.001], [-76.67, 39.0]]] } },
      { type: 'Feature', properties: { name: 'Mister Pizza', amenity: 'restaurant' }, geometry: { type: 'Point', coordinates: [-76.6843, 39.0287] } },
      { type: 'Feature', properties: { name: 'Crofton Parkway', highway: 'tertiary' }, geometry: { type: 'LineString', coordinates: [[-76.68, 39.0], [-76.681, 39.001]] } },
      { type: 'Feature', properties: { name: 'Crofton Parkway', highway: 'tertiary' }, geometry: { type: 'LineString', coordinates: [[-76.681, 39.001], [-76.682, 39.002]] } },
    ],
  })
  return root
}

function toolsFor(root, extra = {}) {
  const docs = new Map()
  const calls = []
  const siteDoc = {
    read: async (slug, name) => docs.get(`${slug}/${name}`) ?? null,
    write: async (slug, name, doc) => { docs.set(`${slug}/${name}`, doc); return `sites/${slug}/${name}` },
  }
  const apiFetch = async (method, p, body, opts) => {
    calls.push([method, p, opts])
    if (extra.apiFetch) return extra.apiFetch(method, p, body, opts)
    return {}
  }
  const tools = serverTools({ apiFetch, root, siteDoc })
  const tool = (name) => {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, `no tool ${name}`)
    return t
  }
  return { tools, tool, docs, calls }
}

test('the new tools are offered, each with a description that says what it is', () => {
  const { tools } = toolsFor(volume())
  for (const n of ['program_api', 'editor_version', 'level_vocab', 'site_project', 'address_search', 'point_add', 'asset_view']) {
    const t = tools.find((x) => x.name === n)
    assert.ok(t, n)
    assert.ok(t.description.length > 60, `${n} is described`)
  }
})

test('program_api hands back the declarations of @apex/program, and names the other modules', async () => {
  const { tool } = toolsFor(volume())
  const r = await tool('program_api').run({})
  assert.equal(r.module, 'program')
  assert.equal(r.import, '@apex/program')
  assert.match(r.text, /export interface GameApi/)
  assert.match(r.text, /objectives/)
  assert.ok(r.modules.includes('program') && r.modules.includes('actors'))
  await assert.rejects(tool('program_api').run({ module: 'nope' }), /no module "nope"/)
})

test('level_vocab is the engine’s own lists, engine sounds included', async () => {
  const { tool } = toolsFor(volume())
  const v = await tool('level_vocab').run({})
  assert.deepEqual(v.level.weather, ['clear', 'rain', 'sleet', 'snow', 'ice'])
  assert.ok(v.level.profile.includes('stunts'))
  assert.ok(v.vehicle.audio_setup.some((s) => s.endsWith('07_gm_ls.mr')), 'the GM LS is on the list')
  assert.ok(v.program.hud_parts.includes('objectives'))
})

test('site_project projects through the bake’s own frame', async () => {
  const { tool } = toolsFor(volume())
  const r = await tool('site_project').run({ slug: 'crofton', lat: 39.0287, lon: -76.6843 })
  const [x, y] = enuProjector(ANCHOR.lon, ANCHOR.lat, 0)(-76.6843, 39.0287)
  assert.equal(r.points.length, 1)
  assert.ok(Math.abs(r.points[0].x - x) < 0.1 && Math.abs(r.points[0].y - y) < 0.1)
  assert.ok(r.points[0].x < -1100 && r.points[0].y > 2300, 'Mister Pizza is north-west of the anchor')
  await assert.rejects(tool('site_project').run({ slug: 'nowhere', lat: 1, lon: 1 }), /no baked manifest/)
})

test('address_search finds an address, a place and a road, in site metres, nearest-first when asked', async () => {
  const { tool } = toolsFor(volume())
  const a = await tool('address_search').run({ slug: 'crofton', q: '2299 johns hopkins' })
  assert.equal(a.hits[0].kind, 'address')
  assert.equal(a.hits[0].label, '2299 Johns Hopkins Road')
  assert.ok(a.hits[0].x < -1100)
  const p = await tool('address_search').run({ slug: 'crofton', q: 'mister pizza' })
  assert.equal(p.hits[0].kind, 'place')
  assert.equal(p.hits[0].detail, 'restaurant')
  const r = await tool('address_search').run({ slug: 'crofton', q: 'parkway' })
  assert.equal(r.hits.length, 1, 'a road is one entry however many ways it is split into')
  assert.equal(r.hits[0].kind, 'road')
  const near = await tool('address_search').run({ slug: 'crofton', q: 'o', near: [0, 0] })
  assert.ok(near.hits.every((h, i) => i === 0 || h.distance_m >= near.hits[i - 1].distance_m), 'sorted by distance')
  assert.equal(a.indexed.address, 2)
})

test('point_add writes a point through the site document: by road and offset, by lat/lon, by metres; home when asked', async () => {
  const { tool, docs } = toolsFor(volume())
  const r = await tool('point_add').run({ slug: 'crofton', id: 'start', kind: 'start', road: 'spine', at_m: 50, offset_m: 5, mode: 'drive', home: true })
  assert.deepEqual(r.point.at, [50, -5], 'the right of an eastbound road is south')
  assert.equal(r.point.yaw_deg, 0)
  assert.equal(r.home, 'start')
  const doc = docs.get('crofton/points.json')
  assert.equal(doc.points.length, 1)
  const g = await tool('point_add').run({ slug: 'crofton', id: 'shop', kind: 'spot', lat: 39.0287, lon: -76.6843, name: 'Mister Pizza' })
  assert.ok(g.point.at[0] < -1100)
  assert.equal(docs.get('crofton/points.json').points.length, 2)
  const again = await tool('point_add').run({ slug: 'crofton', id: 'shop', kind: 'finish', at: [1, 2], yaw_deg: 90 })
  assert.equal(again.replaced, true)
  assert.equal(docs.get('crofton/points.json').points.length, 2)
  assert.deepEqual(docs.get('crofton/points.json').points[1].at, [1, 2])
  await assert.rejects(tool('point_add').run({ slug: 'crofton', id: 'x', kind: 'nowhere', at: [0, 0] }), /kind is one of/)
  await assert.rejects(tool('point_add').run({ slug: 'crofton', id: 'x', kind: 'spot' }), /say where/)
})

test('point_add and traffic_zone_add stamp the frame the bake serves, so the editor never has to guess', async () => {
  // Rich, 2026-10-10, on a banner over five unstamped Beltway zones MCP had written in the right
  // frame: "This screenshot about zones.json is bullshit."
  const { tool, docs } = toolsFor(volume())
  await tool('traffic_zone_add').run({ slug: 'crofton', density: 0.8, polygon: [[0, -10], [200, -10], [200, 10], [0, 10]] })
  assert.deepEqual(docs.get('crofton/zones.json').frame, { kind: 'enu', epsg: 32618, anchor: { ...ANCHOR, h: 0 } })
  await tool('point_add').run({ slug: 'crofton', id: 'start', kind: 'start', at: [10, 0] })
  assert.deepEqual(docs.get('crofton/points.json').frame, { kind: 'enu', epsg: 32618, anchor: { ...ANCHOR, h: 0 } })
  // no bake, no stamp — and still written
  const r = await tool('traffic_zone_add').run({ slug: 'nobake', density: 0.5, polygon: [[0, 0], [1, 0], [1, 1]] })
  assert.equal(r.zones, 1)
  assert.equal(docs.get('nobake/zones.json').frame, undefined)
})

test('asset_view answers with image content, the chosen view unless another is named', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const { tool, calls } = toolsFor(volume(), {
    apiFetch: async (method, p, body, opts) => {
      if (p === '/assetsvc/catalog/cash') return { id: 'cash', chosen: 'b.png', views: ['a.png', 'b.png'] }
      if (opts?.raw) return { buffer: png, contentType: 'image/png' }
      return {}
    },
  })
  const r = await tool('asset_view').run({ id: 'cash' })
  assert.equal(r.__mcp, 'content')
  assert.equal(r.content[0].type, 'image')
  assert.equal(r.content[0].mimeType, 'image/png')
  assert.equal(r.content[0].data, png.toString('base64'))
  assert.match(r.content[1].text, /b\.png \(chosen\)/)
  assert.ok(calls.some(([, p]) => p === '/assetsvc/catalog/cash/file/views/b.png'))
  await tool('asset_view').run({ id: 'cash', view: 'a.png' })
  assert.ok(calls.some(([, p]) => p === '/assetsvc/catalog/cash/file/views/a.png'))
})

test('asset_describe can say what kind of thing an asset is and how big', () => {
  const { tool } = toolsFor(volume())
  const props = tool('asset_describe').inputSchema.properties
  for (const k of ['kind', 'type', 'size_m', 'notes']) assert.ok(props[k], k)
})

test('export, import and deploy go through the editor routes, and a map export says whether the rasters come along', async () => {
  const seen = []
  const { tool } = toolsFor(volume(), {
    apiFetch: async (method, p, body) => {
      seen.push([method, p, body])
      return { ok: true }
    },
  })
  await tool('world_export').run({ slugs: ['crofton-triangle'], levels: false })
  await tool('world_import').run({ bundle: { worlds: [{ slug: 'crofton-triangle' }] }, replace: true })
  await tool('site_export').run({ slug: 'crofton-triangle' })
  await tool('site_export').run({ slug: 'crofton-triangle', source: true })
  await tool('site_import').run({ url: 'https://example.com/crofton.zip', replace: true })
  await tool('deploy_plan').run({ worlds: ['crofton-triangle'] })
  await tool('deploy_start').run({ worlds: ['crofton-triangle'], account: 'acc', bucket: 'maps', dryRun: true })
  assert.deepEqual(seen.map(([m, p]) => `${m} ${p}`), [
    'GET /api/worlds/export?slug=crofton-triangle&levels=0',
    'POST /api/worlds/import?replace=1',
    'GET /api/sites/crofton-triangle/archive?describe=1&web=1',
    'GET /api/sites/crofton-triangle/archive?describe=1',
    'POST /api/sites/import?replace=1',
    'POST /api/deploy/plan',
    'POST /api/deploy/start',
  ])
  assert.equal(seen[4][2].url, 'https://example.com/crofton.zip')
  assert.equal(seen[6][2].dryRun, true)
})
