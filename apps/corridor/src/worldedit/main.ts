// The world editor: find a place, draw its extent, bake it, watch it, place an asset, publish it.
//
// One page, three modes, one docked inspector — the same shell, tokens and controls as the viewer
// and the editor, because they are one product. The map is a canvas; everything else is the
// design system (`src/ui/`).
//
//   EXPLORE   pan, zoom, search. The roads on screen are the ways the bake would chain, from our
//             own Overpass, cached beside the bake's own cache.
//   DEFINE    draw a boundary, see what it costs, name it, save it as a site definition.
//   BAKE      start the bake, watch its log, open the result, publish it to the bucket.
//
// WHERE THE DATA LIVES. Nothing in this page holds state that matters. Worlds, runs, logs, the
// authored files and the placement catalog are all on the service's volume, so closing the tab,
// reloading, or the pod restarting loses a scroll position and nothing else.
import { Drawer, button, el, installShellKeys, status, clearStatus, toast, typing } from '../ui/shell'
import { bodyOf, empty, group, readout, segmented, select, textField } from '../ui/controls'
import { icon } from '../ui/icons'
import { AssetCatalog } from '../ui/assets'
import { api, type Config, type IndexedPlace, type Way, type World } from './api'
import { MapView, type LonLat } from './map'
import { DefinePanel, zoomFor } from './define'
import { LogView, RunsPanel } from './runs'
import { AdoptDialog } from './adopt'

type Mode = 'explore' | 'index' | 'define' | 'bake'

const canvas = document.getElementById('map') as HTMLCanvasElement
const inspector = document.getElementById('panel') as HTMLElement
const readoutEl = document.getElementById('readout') as HTMLElement

let config: Config | null = null
let worlds: World[] = []
let selected: string | null = new URLSearchParams(location.search).get('world')
let mode: Mode = 'explore'
let dirty = false

/* ---- the map ------------------------------------------------------------------------------- */

type Box = { south: number; west: number; north: number; east: number }

const map = new MapView({
  canvas,
  onViewport: (bbox, zoom) => void loadRoads(bbox, zoom),
  onBoundary: (ring, closed) => define.onBoundary(ring, closed),
  onPick: (way, additive) => define.onPick(way, additive),
  onHover: (p, mpp) => {
    readoutEl.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}  ·  ${mpp < 1 ? `${(mpp * 100).toFixed(0)} cm` : mpp < 1000 ? `${mpp.toFixed(1)} m` : `${(mpp / 1000).toFixed(1)} km`}/px`
  },
})

/**
 * THE LAYER LOADER.
 *
 * What replaced a single "fetch every drivable way in this box" is a stack the SERVER decides:
 * `/api/osm/plan` says which layers apply at this zoom and which tiles of each cover the view, and
 * this fetches them one at a time, newest-view-first, drawing as they land. Zoom numbers live in
 * `tools/worldeditor/layers.mjs` beside the queries they select, because a client that hard-coded
 * them would drift from the questions they stand for.
 *
 * WHY TILES. The old cache was viewport-shaped, so every pan was a box nobody had ever asked for
 * and therefore a miss. Tiles are a fixed grid — the same geographic quadtree as the rest of the
 * project — so panning re-uses whole cells and the cache is bounded and shareable.
 *
 * WHY ONE AT A TIME. A screenful can be nine tiles and Overpass is a shared service. Nine at once
 * is how a public mirror decides it has heard enough from you; and the tiles nearest the middle of
 * the screen are fetched first, so what you are looking at fills in before its corners.
 */
let planReq: AbortController | null = null
let loading = 0
let roadsOff: string | null = null
/** What the last tile fetch did, for the Explore panel to report. */
let lastRoads: { count: number; cache: string; upstream: string | null; layer: string } | null = null
/** Tiles already held or in flight, so a re-plan after a small pan asks for nothing new. */
const tileState = new Map<string, 'live' | 'done'>()

const tileKey = (layer: string, t: { z: number; x: number; y: number }) => `${layer}/${t.z}/${t.x}/${t.y}`

/**
 * Drop tiles that are far outside the view.
 *
 * Without this, an afternoon of panning across Europe is every tile ever fetched held in memory and
 * re-drawn every frame. Keeps what intersects a box three times the viewport, which is generous
 * enough that a pan back does not re-fetch.
 */
function pruneTiles(bbox: Box) {
  const padLat = (bbox.north - bbox.south) * 1.5
  const padLon = (bbox.east - bbox.west) * 1.5
  const keep = { south: bbox.south - padLat, north: bbox.north + padLat, west: bbox.west - padLon, east: bbox.east + padLon }
  for (const [key, t] of map.tiles) {
    const b = t.bounds
    if (b.south > keep.north || b.north < keep.south || b.west > keep.east || b.east < keep.west) {
      map.tiles.delete(key)
      tileState.delete(key)
    }
  }
}

/** The basemap: fetched once, then local for ever. Borders and world cities. */
let basemapDone = false
async function ensureBasemap() {
  if (basemapDone) return
  basemapDone = true
  const [borders, cities] = await Promise.allSettled([api.borders(), api.cities()])
  if (borders.status === 'fulfilled') {
    map.borders = borders.value.features
    if (!borders.value.features.length && borders.value.note) toast(borders.value.note, 'warn', 6000)
  }
  if (cities.status === 'fulfilled') map.worldCities = cities.value.cities
  map.draw()
}

async function loadLayers(bbox: Box, zoom: number) {
  void ensureBasemap()
  pruneTiles(bbox)
  planReq?.abort()
  const mine = new AbortController()
  planReq = mine
  let plan
  try {
    plan = (await api.plan(bbox, zoom, mine.signal)).plan
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      roadsOff = (e as Error).message
      if (mode === 'explore') renderExplore()
    }
    return
  }
  roadsOff = plan.length ? null : 'nothing to fetch at this zoom — the country outlines and world cities are the whole picture out here'
  // Always, even when the plan is empty: at world zoom nothing loads, and without this the panel
  // kept whatever numbers it had when the last tile landed — it read "zoom 15" over Europe.
  if (mode === 'explore') renderExplore()
  const wanted = new Set<string>()
  for (const layer of plan) for (const t of layer.tiles) wanted.add(tileKey(layer.layer, t))

  for (const layer of plan) {
    for (const t of layer.tiles) {
      const key = tileKey(layer.layer, t)
      if (tileState.has(key)) continue
      tileState.set(key, 'live')
      loading++
      if (mode === 'explore') renderExplore()
      try {
        const doc = await api.tile(layer.layer, t, zoom)
        // The view may have moved on while this was in flight; keep it anyway if it is still
        // near, drop it if not. Cheaper than cancelling and re-asking for it a second later.
        map.tiles.set(key, doc)
        tileState.set(key, 'done')
        lastRoads = { count: doc.items.length, cache: doc.cache, upstream: doc.upstream, layer: layer.layer }
        if (doc.provisional && doc.note) toast(doc.note, 'warn', 8000)
        if (layer.layer === 'roads') syncDetail()
        map.draw()
      } catch (e) {
        tileState.delete(key)
        if ((e as Error).name !== 'AbortError') roadsOff = (e as Error).message
      } finally {
        loading--
        if (mode === 'explore') renderExplore()
      }
      // A newer viewport has superseded this plan; stop working through a stale one.
      if (planReq !== mine) return
    }
  }
  void wanted
}

/**
 * The detail layer, in the shape the Define panel needs.
 *
 * `roads` tiles carry the same records the old single-box fetch produced, so everything downstream
 * — picking a road, counting what a boundary holds — reads one array and does not know it is now
 * assembled from tiles.
 */
function detailWays(): Way[] {
  // Out of the detail band there is nothing to hand the rest of the app: the Define panel counts
  // what a boundary holds, and counting tiles left over from three zoom levels ago is worse than
  // counting nothing.
  if (!map.inBand('roads')) return []
  const seen = new Set<number>()
  const out: Way[] = []
  for (const t of map.tiles.values()) {
    if (t.layer !== 'roads') continue
    for (const w of t.items as Way[]) {
      // A way crossing a tile edge is in both tiles; the bake dedupes by id and so must this.
      if (seen.has(w.id)) continue
      seen.add(w.id)
      out.push(w)
    }
  }
  return out
}

/**
 * Keep `map.ways` — the detail layer everything downstream reads — in step with the tiles.
 *
 * Called BEFORE the load as well as after each tile, and that is the point: at zoom 10 the plan
 * contains `places` and `major`, whose tiles can take a minute each against a public mirror, and
 * the detail band is long gone. Updating only after the whole load resolved meant the map went on
 * drawing 59 474 street segments from three zoom levels ago for as long as the fetch took.
 */
function syncDetail() {
  const next = detailWays()
  if (next.length !== map.ways.length) {
    map.ways = next
    map.draw()
  }
}

async function loadRoads(bbox: Box, zoom: number) {
  syncDetail()
  await loadLayers(bbox, zoom)
  syncDetail()
}

/* ---- panels -------------------------------------------------------------------------------- */

const logs = new LogView()
const assets = new AssetCatalog()
const adopt = new AdoptDialog()

const define = new DefinePanel({
  map,
  host: inspector,
  onSaved: async (w) => {
    selected = w.slug
    await refreshWorlds()
    setMode('bake')
  },
  onDirty: (d) => {
    dirty = d
    dirtyEl.classList.toggle('on', d)
    dirtyEl.textContent = d ? 'unsaved boundary' : ''
  },
})

const runsPanel = new RunsPanel({
  host: inspector,
  logs,
  worlds: () => worlds,
  selected: () => selected,
  onFinished: () => void refreshWorlds(),
})

/* ---- chrome -------------------------------------------------------------------------------- */

const bar = el('header', 'topbar')
const drawer = new Drawer('world editor', 'OSM in, a baked world out')
const dirtyEl = el('span', 'dirty')
const worldSel = el('div', 'topbar-site')
const searchBox = el('div', 'search')
const searchInput = el('input', 'input wide')
const searchResults = el('div', 'search-results')

function buildBar() {
  bar.append(
    button({ icon: 'bars-3', variant: 'ghost', title: 'menu', onClick: () => drawer.toggle() }),
    worldSel,
    segmented<Mode>({
      value: mode,
      options: [
        { value: 'explore', label: 'Explore', icon: 'map', key: '1' },
        { value: 'index', label: 'Index', icon: 'map-pin', key: '2' },
        { value: 'define', label: 'Define', icon: 'pencil-square', key: '3' },
        { value: 'bake', label: 'Bake', icon: 'play', key: '4' },
      ],
      onChange: (m) => setMode(m),
    }),
    searchBox,
    el('div', 'topbar-spacer'),
    dirtyEl,
    button({ icon: 'cube', title: 'place generated assets', onClick: () => void adopt.open() }),
    button({ icon: 'sparkles', title: 'generate an asset', onClick: () => void assets.open() }),
    button({ icon: 'information-circle', title: 'what this is pointed at', onClick: () => void showConfig() }),
  )
  document.body.append(bar)
  measureBar()

  searchInput.type = 'search'
  searchInput.placeholder = 'a place, or “lat, lon”'
  searchInput.setAttribute('aria-label', 'find a place')
  const wrap = el('label', 'search-field')
  wrap.append(icon('magnifying-glass', 15), searchInput)
  searchBox.append(wrap, searchResults)
  let t = 0
  searchInput.addEventListener('input', () => {
    clearTimeout(t)
    t = window.setTimeout(() => void search(searchInput.value), 300)
  })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchResults.replaceChildren()
      searchInput.blur()
    }
  })
}

/**
 * Publish the bar's REAL height as `--we-bar-h`, and keep it published.
 *
 * `--bar-h` is a 50px token and tokens.css itself says the bar's height is content-driven — it was
 * raised from 46 to 50 once already for exactly this reason. This bar carries a search field and a
 * two-line world button and measures 63, so the map, sized off the token, spent its first thirteen
 * pixels underneath the bar. A ResizeObserver rather than a one-off read: the world button grows a
 * second line when a world is selected, and the bar is shorter at phone width.
 */
function measureBar() {
  const apply = () => document.documentElement.style.setProperty('--we-bar-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`)
  apply()
  new ResizeObserver(() => {
    apply()
    map.draw()
  }).observe(bar)
}

/**
 * Search: a coordinate if it looks like one, otherwise a place name in our own extract.
 *
 * The coordinate case first, and not as a fallback, because "39.004, -76.683" is how anyone with a
 * fix in their hand arrives here and it must never go to Overpass to be told there is no town of
 * that name. Nominatim is deliberately not used: a third-party geocoder has a usage policy, may
 * have no route from this pod, and our extract already knows every `place` node in the region it
 * covers — which is the only region a bake can succeed in anyway.
 */
async function search(q: string) {
  searchResults.replaceChildren()
  const text = q.trim()
  if (!text) return
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text)
  if (m) {
    const lat = Number(m[1])
    const lon = Number(m[2])
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      map.flyTo({ lat, lon }, Math.max(map.zoom, 15))
      return
    }
  }
  searchResults.append(el('p', 'search-empty', 'searching…'))
  try {
    const { places, cache } = await api.search(text)
    searchResults.replaceChildren()
    if (!places.length) {
      searchResults.append(el('p', 'search-empty', 'nothing found'))
      return
    }
    for (const p of places.slice(0, 10)) {
      const b = el('button', 'search-row')
      const t = el('span', 'search-text')
      t.append(el('span', 'search-name', p.short), el('span', 'search-where', p.name.split(',').slice(1, 4).join(',').trim()))
      b.append(t, el('span', 'search-kind', p.kind))
      b.onclick = () => {
        frame(p)
        searchResults.replaceChildren()
        searchInput.value = p.short
      }
      // Keeping a place is one click from finding it — that is the whole point of an index.
      const keep = button({
        icon: 'plus',
        variant: 'ghost',
        title: `keep ${p.short} in the index`,
        onClick: (ev) => {
          ev.stopPropagation()
          void keepPlace({ name: p.short, lat: p.lat, lon: p.lon, bbox: p.bbox, kind: p.kind, source: 'search', note: p.name })
        },
      })
      const row = el('div', 'search-row-wrap')
      row.append(b, keep)
      searchResults.append(row)
    }
    if (cache === 'hit') searchResults.append(el('p', 'search-empty', 'from the cache'))
  } catch (e) {
    searchResults.replaceChildren(el('p', 'search-empty', (e as Error).message))
  }
}

/**
 * Put a search result on screen at the size of the thing it is.
 *
 * A country, a region and a mountain pass are all "a place", and dropping a pin at street zoom for
 * all three is why the old search was useless for exploring: you asked for Italy and got a car
 * park in Rome. Nominatim returns the extent, so this frames it and lets the zoom fall out of how
 * big the thing actually is.
 */
function frame(p: { lat: number; lon: number; bbox: { south: number; west: number; north: number; east: number } | null }) {
  if (!p.bbox) return map.flyTo({ lat: p.lat, lon: p.lon }, Math.max(map.zoom, 13))
  const spanLat = Math.max(1e-4, p.bbox.north - p.bbox.south)
  const spanLon = Math.max(1e-4, p.bbox.east - p.bbox.west)
  const r = map.canvasSize
  // The zoom at which the extent fills the canvas, minus a margin, clamped to the map's range.
  const zLat = Math.log2((r.h * 180) / (spanLat * 256))
  const zLon = Math.log2((r.w * 360) / (spanLon * 256))
  const zoom = Math.max(2, Math.min(17, Math.min(zLat, zLon) - 0.25))
  map.flyTo({ lat: (p.bbox.north + p.bbox.south) / 2, lon: (p.bbox.east + p.bbox.west) / 2 }, zoom)
}

/* ---- the index: places worth coming back to ------------------------------------------------- */

let indexed: IndexedPlace[] = []

async function refreshPlaces() {
  indexed = (await api.places().catch(() => ({ places: [] }))).places
  map.pins = indexed.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, world: !!p.world }))
  map.draw()
  if (mode === 'explore') renderExplore()
}

async function keepPlace(p: Partial<IndexedPlace>) {
  try {
    const { place } = await api.addPlace(p)
    toast(`kept “${place.name}”`, 'ok')
    await refreshPlaces()
  } catch (e) {
    toast((e as Error).message, 'danger', 6000)
  }
}

/** The index, as a panel: what you have found, and what to do with it. */
function renderIndex(host: HTMLElement) {
  host.replaceChildren()
  const hint = el('p', 'panel-hint')
  hint.append(
    icon('information-circle', 14),
    el(
      'span',
      '',
      'Places worth coming back to. Finding somewhere is a different job from deciding what to bake, so this is cheap — a search result, or a click on the map — and a world is promoted from one when it earns it.',
    ),
  )
  host.append(hint)

  const acts = el('div', 'panel-actions')
  acts.append(
    button({
      label: 'Keep this view',
      icon: 'map-pin',
      title: 'index the middle of the screen',
      onClick: () => {
        const b = map.bbox()
        void keepPlace({ name: `${map.centre.lat.toFixed(4)}, ${map.centre.lon.toFixed(4)}`, lat: map.centre.lat, lon: map.centre.lon, bbox: b, source: 'view' })
      },
    }),
  )
  host.append(acts)

  if (!indexed.length) {
    host.append(empty('nothing indexed yet — search for somewhere, or keep this view'))
    return
  }
  for (const p of indexed) {
    const g = group(p.name, { collapsed: true })
    const b = bodyOf(g)
    b.append(readout('where', `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`))
    if (p.kind) b.append(readout('kind', p.kind))
    if (p.world) b.append(readout('world', p.world))
    if (p.note) b.append(el('p', 'panel-hint', p.note))
    b.append(
      textField({
        label: 'note',
        value: p.note ?? '',
        onChange: (v) => void api.updatePlace(p.id, { note: v }).then(refreshPlaces),
      }),
    )
    const row = el('div', 'panel-actions')
    row.append(
      button({ label: 'Go', icon: 'viewfinder-circle', onClick: () => frame({ lat: p.lat, lon: p.lon, bbox: p.bbox ?? null }) }),
      button({
        label: 'Make a world here',
        icon: 'plus',
        variant: 'primary',
        onClick: () => {
          frame({ lat: p.lat, lon: p.lon, bbox: p.bbox ?? null })
          newWorld()
          toast(`draw the extent for “${p.name}”`, 'info', 5000)
        },
      }),
      button({
        icon: 'trash',
        variant: 'danger',
        title: `forget ${p.name}`,
        onClick: () => void api.deletePlace(p.id).then(refreshPlaces),
      }),
    )
    b.append(row)
    host.append(g)
  }
}

function buildDrawer() {
  const nav = drawer.section('')
  drawer.item(nav, { id: 'new', label: 'New world', icon: 'plus', hint: 'draw a boundary on the map', key: 'N', onClick: () => newWorld() })
  drawer.item(nav, { id: 'assets', label: 'Assets', icon: 'sparkles', hint: 'describe a prop and generate it', onClick: () => void assets.open() })
  drawer.item(nav, { id: 'place', label: 'Place assets', icon: 'cube', hint: 'make a finished mesh placeable', onClick: () => void adopt.open() })
  drawer.item(nav, { id: 'viewer', label: 'Viewer', icon: 'globe-alt', hint: 'drive a baked world', onClick: () => window.open(selected ? `/index.html?site=${selected}` : '/index.html', '_blank') })
  drawer.item(nav, { id: 'editor', label: 'Site editor', icon: 'pencil-square', hint: 'areas, placements, structures', onClick: () => window.open(selected ? `/editor.html?site=${selected}` : '/editor.html', '_blank') })

  const look = drawer.section('Appearance')
  drawer.custom(
    look,
    select({
      label: 'Theme',
      value: (localStorage.getItem('corridor.theme') as 'dark' | 'light') ?? 'dark',
      options: [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
      onChange: (v) => {
        document.documentElement.dataset.theme = v
        try {
          localStorage.setItem('corridor.theme', v)
        } catch {
          /* a private window has no storage; the theme still applies for this session */
        }
        map.draw()
      },
    }),
  )
}

/** The world picker, and what it says about each one. */
function renderWorldSelect() {
  worldSel.replaceChildren()
  const b = el('button', 'site-button')
  const w = worlds.find((x) => x.slug === selected)
  b.append(icon('map-pin', 15))
  const t = el('span', 'site-text')
  t.append(el('span', 'site-name', w?.slug ?? 'no world'))
  t.append(el('span', 'site-meta', w ? `${w.radius_m.toLocaleString()} m · ${w.baked ? 'baked' : 'not baked'}` : `${worlds.length} defined`))
  b.append(t, icon('chevron-down', 14))
  b.onclick = () => openWorldMenu(b)
  worldSel.append(b)
}

function openWorldMenu(anchor: HTMLElement) {
  const menu = el('div', 'world-menu')
  const list = [...worlds].sort((a, b) => Number(!!b.baked) - Number(!!a.baked) || a.slug.localeCompare(b.slug))
  for (const w of list) {
    const row = el('button', `world-row${w.slug === selected ? ' on' : ''}`)
    row.append(icon(w.baked ? 'check' : 'clock', 13), el('span', 'world-slug', w.slug), el('span', 'world-meta', `${w.radius_m?.toLocaleString() ?? '?'} m`))
    row.onclick = () => {
      selected = w.slug
      menu.remove()
      renderWorldSelect()
      if (Number.isFinite(w.lat)) map.flyTo({ lat: w.lat, lon: w.lon }, zoomFor(w.radius_m))
      map.extent = Number.isFinite(w.lat) ? { centre: { lat: w.lat, lon: w.lon }, radius_m: w.radius_m } : null
      map.draw()
      renderPanel()
    }
    menu.append(row)
  }
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${r.left}px`
  menu.style.top = `${r.bottom + 6}px`
  document.body.append(menu)
  setTimeout(() => addEventListener('pointerdown', function off(e) {
    if (!menu.contains(e.target as Node)) {
      menu.remove()
      removeEventListener('pointerdown', off)
    }
  }), 0)
}

/* ---- modes --------------------------------------------------------------------------------- */

function setMode(m: Mode) {
  if (mode === 'bake') runsPanel.stop()
  mode = m
  for (const b of bar.querySelectorAll<HTMLButtonElement>('.seg')) b.classList.toggle('on', b.dataset.value === m)
  // Define puts the map in draw mode; the panel switches it to `pick` itself when the world is a
  // named-roads one, because then clicking is choosing a road rather than dropping a vertex.
  map.mode = m === 'define' ? 'draw' : 'pan'
  renderPanel()
}

function renderPanel() {
  if (mode === 'index') {
    renderIndex(inspector)
  } else if (mode === 'define') {
    const w = worlds.find((x) => x.slug === selected)
    if (w && w.source !== 'bake-only' && !define.preview) define.load(w)
    else define.render()
  } else if (mode === 'bake') {
    runsPanel.render()
    runsPanel.start()
  } else {
    renderExplore()
  }
}

/**
 * Explore: what is on screen, where it came from, and — when there is nothing — why.
 *
 * The "why" is the part that matters. An empty map used to look identical whether the view was too
 * wide to query, the request had failed, or Overpass was down, and there was nowhere to look but
 * the network tab. Each of those now says which it is, in the panel, in words.
 */
function renderExplore() {
  inspector.replaceChildren()
  const wrap = el('div', 'explore')
  const intro = el('p', 'panel-hint')
  intro.append(
    icon('information-circle', 14),
    el(
      'span',
      '',
      'Country outlines and world cities are loaded once and kept. Towns arrive at zoom 6, motorways at 7, and every drivable street — the ways the bake will chain — at 11. Zoom in to go deeper.',
    ),
  )
  wrap.append(intro)

  if (roadsOff) {
    const p = el('p', 'panel-hint warn')
    p.append(icon('exclamation-triangle', 14), el('span', '', roadsOff))
    wrap.append(p)
  }

  const mpp = map.metresPerPixel
  const b = map.bbox()
  const kmW = (b.east - b.west) * 111.1 * Math.cos((map.centre.lat * Math.PI) / 180)
  const kmH = (b.north - b.south) * 111.1
  const km = (v: number) => (v > 999 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))
  const rows: [string, string][] = [
    ['Zoom', map.zoom.toFixed(1)],
    ['Scale', mpp > 1000 ? `${(mpp / 1000).toFixed(1)} km/px` : `${mpp.toFixed(1)} m/px`],
    ['View', `${km(kmW)} x ${km(kmH)} km`],
  ]

  // WHAT IS ON SCREEN, layer by layer — and ONLY the layers that are actually being drawn.
  // "The map is empty" has several very different causes (too far out for this layer, nothing
  // fetched yet, the fetch failed, there is genuinely nothing there) and this is where they stop
  // looking the same. Tiles outside their zoom band are still held — so coming back is instant —
  // but listing them would say "28 720 roads" over the Atlantic.
  const held = new Map<string, number>()
  for (const t of map.tiles.values()) if (map.inBand(t.layer)) held.set(t.layer, (held.get(t.layer) ?? 0) + t.items.length)
  rows.push(['borders', map.borders.length ? `${map.borders.length} countries` : 'not loaded'])
  if (!held.has('places')) rows.push(['cities', `${map.worldCities.length} world (basemap)`])
  for (const l of config?.layers ?? []) {
    const n = held.get(l.id)
    if (n != null) rows.push([l.id, `${n.toLocaleString()} items`])
    else if (map.zoom >= l.minZoom && map.zoom < l.maxZoom) rows.push([l.id, loading ? 'loading…' : 'none here'])
  }
  if (loading) rows.push(['', `${loading} tile${loading === 1 ? '' : 's'} in flight`])
  if (lastRoads) {
    // WHERE THE DATA CAME FROM. Rich's first question was "does it fall back to the public
    // Overpass" and the honest place to answer it is beside the map itself.
    rows.push(['last tile', `${lastRoads.layer} · ${lastRoads.cache === 'hit' ? 'cache' : (lastRoads.upstream ?? 'overpass')}`])
  }
  rows.push(['Worlds defined', `${worlds.length}`], ['Baked', `${worlds.filter((w) => w.baked).length}`])
  for (const [k, v] of rows) {
    const row = el('div', 'readout')
    row.append(el('span', 'field-label', k), el('span', `field-value mono${k === '' ? ' warn' : ''}`, v))
    wrap.append(row)
  }

  const acts = el('div', 'panel-actions')
  acts.append(
    button({ label: 'New world here', icon: 'plus', variant: 'primary', onClick: () => newWorld() }),
    button({
      label: 'Reload roads',
      icon: 'arrow-path',
      title: 'drop what is held and ask again for this view',
      onClick: () => {
        map.tiles.clear()
        tileState.clear()
        map.ways = []
        void loadRoads(map.bbox(), map.zoom)
      },
    }),
    button({ label: 'Overpass status', icon: 'server-stack', onClick: () => void showOverpass() }),
  )
  wrap.append(acts)
  inspector.append(wrap)
}

/**
 * Every upstream, in the order they are tried, and what each just answered.
 *
 * This is the answer to "is it using ours, or did it fall back?" without opening a terminal.
 */
async function showOverpass() {
  status('probing every Overpass upstream…')
  try {
    const s = await api.overpassStatus()
    const lines = s.upstreams.map((u) => `${u.ok ? '  up  ' : ' DOWN '} ${u.host.padEnd(44)} ${u.ok ? `${u.ms} ms` : (u.detail ?? '').slice(0, 60)}`)
    const using = s.using ? `using ${s.using}${s.using !== new URL(s.ours ?? 'http://x').host ? '  (FELL BACK — ours is not answering)' : '  (ours)'}` : 'nothing is answering'
    console.log(`overpass\n${using}\n${lines.join('\n')}`)
    toast(using, s.using ? (s.using === new URL(s.ours ?? 'http://x').host ? 'ok' : 'warn') : 'danger', 8000)
  } catch (e) {
    toast((e as Error).message, 'danger', 6000)
  } finally {
    clearStatus()
  }
}

function newWorld() {
  selected = null
  renderWorldSelect()
  define.fresh()
  setMode('define')
  toast('click on the map to drop boundary points; click the first one again to close the ring', 'info', 6000)
}

async function showConfig() {
  const ready = await api.ready().catch(() => null)
  const lines = [
    `data       ${config?.data ?? '?'}`,
    `runner     ${config?.runs.runner ?? '?'}${config?.runs.runner === 'kubernetes' ? ` · ${config?.runs.namespace} · ${config?.runs.image}` : ''}`,
    `overpass   ${ready?.overpass.ok ? `up (${ready.overpass.ms} ms)` : `DOWN — ${ready?.overpass.detail?.slice(0, 80) ?? '?'}`}`,
    `kubernetes ${ready?.kubernetes.ok ? `ok (${ready.kubernetes.namespace})` : ready?.kubernetes.detail ?? '?'}`,
    `assetsvc   ${config?.assetsvc ?? 'not configured'}`,
    `bucket     ${config?.bucket ? `${config.bucket.bucket}/${config.bucket.prefix}` : 'not configured'}`,
  ]
  toast(lines.join('   '), ready?.overpass.ok ? 'info' : 'warn', 9000)
  console.log(lines.join('\n'))
}

/* ---- boot ---------------------------------------------------------------------------------- */

async function refreshWorlds() {
  worlds = (await api.worlds()).worlds
  map.others = worlds
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.radius_m))
    .map((w) => ({ slug: w.slug, centre: { lat: w.lat, lon: w.lon }, radius_m: w.radius_m, baked: !!w.baked }))
  map.draw()
  renderWorldSelect()
}

async function boot() {
  document.documentElement.dataset.theme = localStorage.getItem('corridor.theme') ?? 'dark'
  buildBar()
  buildDrawer()
  installShellKeys(() => drawer)

  addEventListener('keydown', (e) => {
    if (typing(e)) return
    if (e.key === '1') setMode('explore')
    else if (e.key === '2') setMode('index')
    else if (e.key === '3') setMode('define')
    else if (e.key === '4') setMode('bake')
    else if (e.key.toLowerCase() === 'n') newWorld()
    else if (e.key === 'Enter' && mode === 'define') map.closeRing()
    else if (e.key === '/') {
      e.preventDefault()
      searchInput.focus()
    }
  })

  // A drawn-but-unsaved boundary is the only thing on this page that is not already on the volume.
  addEventListener('beforeunload', (e) => {
    if (!dirty) return
    e.preventDefault()
    e.returnValue = ''
  })

  try {
    config = await api.config()
    for (const l of config.layers ?? []) map.bands.set(l.id, { minZoom: l.minZoom, maxZoom: l.maxZoom })
    runsPanel.bucket = config.bucket
    runsPanel.runner = config.runs.runner
    if (config.adoptedRuns.length) toast(`picked ${config.adoptedRuns.length} run(s) back up after a restart`, 'info', 5000)
  } catch (e) {
    toast(`the world editor service is not answering: ${(e as Error).message}`, 'danger', 0)
  }
  await refreshWorlds().catch(() => {})
  await refreshPlaces().catch(() => {})

  const start = worlds.find((w) => w.slug === selected) ?? worlds.find((w) => w.baked)
  if (start && Number.isFinite(start.lat)) {
    selected = start.slug
    // Only if nobody has moved the map while the world list was loading — see `MapView.moved`.
    if (!map.moved) map.flyTo({ lat: start.lat, lon: start.lon }, zoomFor(start.radius_m), { user: false })
  }
  renderWorldSelect()
  setMode((new URLSearchParams(location.search).get('mode') as Mode) ?? 'explore')
}

/**
 * The handle a probe or a console session drives this page by: `window.__we`.
 *
 * NOT `window.__apex`, and not `window.corridor`. Those two both exist on the viewer and the
 * editor and both carry `site`/`scene`/`camera`, which is how someone probes the wrong one and
 * gets true answers about the wrong object for an afternoon. This page has no three.js scene and
 * no renderer, so it gets its own name and holds only what it really has.
 *
 * It is exported in the build as well as in development, deliberately: this is the surface the
 * probe asserts against in a POD, where there is no Vite and no dev bridge.
 */
declare global {
  interface Window {
    __we: {
      map: MapView
      define: DefinePanel
      runs: RunsPanel
      setMode: (m: Mode) => void
      worlds: () => World[]
      selected: () => string | null
      config: () => Config | null
      refreshWorlds: () => Promise<void>
      /** The layer stack's state. A probe that cannot see this can only see symptoms. */
      roads: () => {
        off: string | null
        ways: number
        last: typeof lastRoads
        loading: number
        tiles: { layer: string; z: number; x: number; y: number; items: number }[]
        borders: number
        worldCities: number
      }
      loadRoads: (bbox: Box, zoom: number) => Promise<void>
    }
  }
}

window.__we = {
  map,
  define,
  runs: runsPanel,
  setMode,
  worlds: () => worlds,
  selected: () => selected,
  config: () => config,
  refreshWorlds,
  roads: () => ({
    off: roadsOff,
    ways: map.ways.length,
    last: lastRoads,
    loading,
    tiles: [...map.tiles.values()].map((t) => ({ layer: t.layer, z: t.z, x: t.x, y: t.y, items: t.items.length })),
    borders: map.borders.length,
    worldCities: map.worldCities.length,
  }),
  loadRoads,
}

void boot()

// `LonLat` is re-exported so a console session can build one without importing the map module.
export type { LonLat }
