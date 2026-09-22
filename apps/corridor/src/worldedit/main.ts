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
import { segmented, select } from '../ui/controls'
import { icon } from '../ui/icons'
import { AssetCatalog } from '../ui/assets'
import { api, type Config, type World } from './api'
import { MapView, type LonLat } from './map'
import { DefinePanel, zoomFor } from './define'
import { LogView, RunsPanel } from './runs'
import { AdoptDialog } from './adopt'

type Mode = 'explore' | 'define' | 'bake'

const canvas = document.getElementById('map') as HTMLCanvasElement
const inspector = document.getElementById('panel') as HTMLElement
const readout = document.getElementById('readout') as HTMLElement

let config: Config | null = null
let worlds: World[] = []
let selected: string | null = new URLSearchParams(location.search).get('world')
let mode: Mode = 'explore'
let dirty = false

/* ---- the map ------------------------------------------------------------------------------- */

let roadsReq: AbortController | null = null
let lastBox: { south: number; west: number; north: number; east: number } | null = null

const map = new MapView({
  canvas,
  onViewport: (bbox, zoom) => void loadRoads(bbox, zoom),
  onBoundary: (ring, closed) => define.onBoundary(ring, closed),
  onPick: (way, additive) => define.onPick(way, additive),
  onHover: (p, mpp) => {
    readout.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}  ·  ${mpp < 1 ? `${(mpp * 100).toFixed(0)} cm` : `${mpp.toFixed(1)} m`}/px`
  },
})

/**
 * Fetch the roads for a viewport, unless the last fetch already covers it.
 *
 * Panning inside a box that has already been answered must not re-query: the cache makes a repeat
 * cheap on the server but the round trip and the re-render are not free, and a drag fires this on
 * every settle. The box asked for is padded 25% beyond the screen so a small pan is covered.
 */
async function loadRoads(bbox: { south: number; west: number; north: number; east: number }, zoom: number) {
  if (zoom < 12) {
    map.ways = []
    map.draw()
    clearStatus()
    return
  }
  if (lastBox && bbox.south >= lastBox.south && bbox.north <= lastBox.north && bbox.west >= lastBox.west && bbox.east <= lastBox.east) return
  const padLat = (bbox.north - bbox.south) * 0.25
  const padLon = (bbox.east - bbox.west) * 0.25
  const want = { south: bbox.south - padLat, north: bbox.north + padLat, west: bbox.west - padLon, east: bbox.east + padLon }
  roadsReq?.abort()
  roadsReq = new AbortController()
  status('reading OSM…')
  try {
    const r = await api.roads(want, roadsReq.signal)
    map.ways = r.ways
    lastBox = want
    map.draw()
    toast(`${r.ways.length} drivable ways${r.cache === 'hit' ? ' (cached)' : ''}`, 'info', 1600)
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    lastBox = null
    toast((e as Error).message, 'danger', 6000)
  } finally {
    clearStatus()
  }
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
        { value: 'define', label: 'Define', icon: 'pencil-square', key: '2' },
        { value: 'bake', label: 'Bake', icon: 'play', key: '3' },
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
  try {
    const { places } = await api.search(text)
    if (!places.length) {
      searchResults.append(el('p', 'search-empty', 'nothing in the loaded extract'))
      return
    }
    for (const p of places.slice(0, 12)) {
      const b = el('button', 'search-row')
      b.append(el('span', 'search-name', p.name), el('span', 'search-kind', p.kind))
      b.onclick = () => {
        map.flyTo({ lat: p.lat, lon: p.lon }, 14)
        searchResults.replaceChildren()
        searchInput.value = p.name
      }
      searchResults.append(b)
    }
  } catch (e) {
    searchResults.append(el('p', 'search-empty', (e as Error).message))
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
  if (mode === 'define') {
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

/** Explore: what is on screen, and what the numbers mean. */
function renderExplore() {
  inspector.replaceChildren()
  const wrap = el('div', 'explore')
  wrap.append(
    el('p', 'panel-hint', ''),
    ...[
      ['Roads on screen', `${map.ways.length}`],
      ['Zoom', map.zoom.toFixed(1)],
      ['Scale', `${map.metresPerPixel.toFixed(2)} m/px`],
      ['Worlds defined', `${worlds.length}`],
      ['Baked', `${worlds.filter((w) => w.baked).length}`],
    ].map(([k, v]) => {
      const row = el('div', 'readout')
      row.append(el('span', 'field-label', k), el('span', 'field-value mono', v))
      return row
    }),
  )
  const p = wrap.firstChild as HTMLElement
  p.append(
    icon('information-circle', 14),
    el(
      'span',
      '',
      'These are the drivable ways our own Overpass returns — the same query the bake chains, not a basemap. Zoom past 12 to load them. Existing worlds are outlined faintly.',
    ),
  )
  const acts = el('div', 'panel-actions')
  acts.append(button({ label: 'New world here', icon: 'plus', variant: 'primary', onClick: () => newWorld() }))
  wrap.append(acts)
  inspector.append(wrap)
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
    else if (e.key === '2') setMode('define')
    else if (e.key === '3') setMode('bake')
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
    runsPanel.bucket = config.bucket
    runsPanel.runner = config.runs.runner
    if (config.adoptedRuns.length) toast(`picked ${config.adoptedRuns.length} run(s) back up after a restart`, 'info', 5000)
  } catch (e) {
    toast(`the world editor service is not answering: ${(e as Error).message}`, 'danger', 0)
  }
  await refreshWorlds().catch(() => {})

  const start = worlds.find((w) => w.slug === selected) ?? worlds.find((w) => w.baked)
  if (start && Number.isFinite(start.lat)) {
    selected = start.slug
    map.flyTo({ lat: start.lat, lon: start.lon }, zoomFor(start.radius_m))
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
}

void boot()

// `LonLat` is re-exported so a console session can build one without importing the map module.
export type { LonLat }
