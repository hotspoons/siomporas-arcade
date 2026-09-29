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
import { Dialog, Drawer, Tabs, button, el, installShellKeys, status, clearStatus, toast, typing } from '../ui/shell'
import { bodyOf, empty, group, readout, segmented, select, textField } from '../ui/controls'
import { icon, type IconName } from '../ui/icons'
import { AssetCatalog } from '../ui/assets'
import { api, type Config, type IndexedPlace, type Way, type World } from './api'
import { MapView, type LonLat } from './map'
import { DefinePanel, zoomFor } from './define'
import { LogView, RunsPanel } from './runs'
import { StagePanel } from './stage'
import { ProgramPanel } from '../ui/programpanel'
import { ShellPanel } from '../ui/shellpanel'
import { AgentPanel } from '../ui/agentpanel'
import { AgentBridge } from '../agent/bridge'
import { McpPanel } from '../ui/mcppanel'
import { fromUrl, load as loadNav, resolve as resolveNav, save as saveNav, toUrl } from './nav'
import { ROOT, SITE_DOCS } from '../agent/projection'
import { SplatsPanel } from './splats'
import { worldMenuTransfer } from './transfer'
import { GitPanel } from './gitpanel'
import { dockWidth } from '../ui/dockwidth'
import { actorExtension } from '../ui/actors'
import { weaponExtension } from '../ui/weapons'
import { vehicleExtension } from '../ui/vehicles'

/**
 * The tabs, as one list.
 *
 * A list and not just a union, because the navigation restore has to be able to ask whether a
 * remembered tab still exists — a stored `'places'` from before a rename would otherwise open a
 * page with no panel and no way to see why.
 */
/*
 * EIGHT PLACES TO BE, not eleven.
 *
 * Rich, 2026-09-29: "Explore, define, and bake need to be collapsed into a single item with a
 * multistage wizard form or something, maybe with tabs to bounce between them. Total mess right
 * now. Index doesn't make any sense."
 *
 * Those four were never four things. They are what you do to ONE world, in order: find the place,
 * keep it, draw its boundary, bake it. A row of eleven peers said they were alternatives to each
 * other and to the Assets library, which is a different kind of thing entirely — so the top bar
 * read as a pile rather than as a pipeline, and there was nothing anywhere to say what to press
 * first. They are steps inside `world` now, and `index` — which named itself after a data
 * structure — is "Places", which is what it holds.
 */
const MODES = ['world', 'place', 'stage', 'assets', 'program', 'shell', 'agent', 'splats'] as const
type Mode = (typeof MODES)[number]

/** The stages of making a world, in the order you do them. */
const STEPS = ['explore', 'places', 'define', 'bake'] as const
type Step = (typeof STEPS)[number]

/*
 * THE SITE EDITOR IS A MODE, not another page.
 *
 * It used to be a link that opened a new tab (Rich, 2026-09-27: "why are we just linking to a
 * place editor — I thought the world editor was the place editor ... it isn't dumping you into
 * new tabs, very amateurish"). It is loaded on first use rather than up front, because it brings
 * three.js and the whole scene builder with it and most sessions here never open it.
 */
type SiteEditor = typeof import('../editor/main')
let siteEditor: SiteEditor | null = null
let siteEditorLoading: Promise<SiteEditor> | null = null

async function siteEditorFor(slug: string): Promise<SiteEditor> {
  siteEditorLoading ??= import('../editor/main')
  siteEditor = await siteEditorLoading
  await siteEditor.openSite(slug)
  return siteEditor
}

const canvas = document.getElementById('map') as HTMLCanvasElement
const inspector = document.getElementById('panel') as HTMLElement
// the panel is draggable by its left edge and remembers the width (ui/dockwidth.ts); the map
// sizes itself from the same custom property, so there is nothing to keep in step
const aside = inspector.closest('aside') as HTMLElement | null
if (aside) dockWidth(aside)

/**
 * The Stage panel: a baked world, dressed and given something to do.
 *
 * `bakedWorlds` is what is ACTUALLY on the volume, not every world definition — a level for a
 * world that was drawn but never baked cannot open, and the server refuses it, so the panel
 * should not offer it either.
 */
const stagePanel = new StagePanel({
  host: inspector,
  bakedWorlds: () => worlds.filter((w) => w.baked).map((w) => w.slug),
  play: (level) => {
    // the viewer, on that world, with the level applied — `?level=` in main.ts
    window.open(`/?level=${encodeURIComponent(level.id)}#${level.world}`, '_blank', 'noopener')
  },
  onDirty: (d) => setDirty(d, 'level'),
})

/** Footage in, a captured world out: uploads, then the training run (splats.ts). */
const splatsPanel = new SplatsPanel({ host: inspector, worlds: () => worlds.filter((w) => w.baked).map((w) => w.slug) })
const readoutEl = document.getElementById('readout') as HTMLElement

let config: Config | null = null
let worlds: World[] = []
let selected: string | null = fromUrl(location.search).world ?? loadNav().world
/**
 * The Program panel: stage 6, the code half of a level.
 *
 * It renders into `#code` — the whole main area — rather than the inspector, because Monaco in a
 * 340 px dock is a code editor nobody writes anything in. Its diagnostics go in the inspector
 * beside it, where a row is a jump to the line.
 */
/**
 * ONE PANE, THREE PANELS, A DIV EACH.
 *
 * Program, Shell and Agent share `#code`, and each of them opened by calling
 * `host.replaceChildren()` — so visiting the Shell destroyed the program editor's DOM, taking
 * with it every open tab, its undo history and anything typed but not saved (Rich, 2026-09-28:
 * "it does not store state and what ever was typed is wiped when you move away"). They get a
 * child each, and `showCode` shows one.
 */
const codePane = document.getElementById('code')!
function pane(name: string): HTMLElement {
  const found = codePane.querySelector<HTMLElement>(`:scope > [data-pane="${name}"]`)
  if (found) return found
  const p = document.createElement('div')
  p.className = 'code-pane'
  p.dataset.pane = name
  p.hidden = true
  codePane.append(p)
  return p
}

const programPanel = new ProgramPanel({
  host: pane('program'),
  reportHost: inspector,
  list: () => api.programs(),
  load: async (id) => (await api.program(id).catch(() => null))?.source ?? null,
  save: async (id, source) => { await api.saveProgram(id, source) },
  remove: async (id) => { await api.deleteProgram(id) },
  move: async (id, to) => { await api.moveProgram(id, to) },
  /*
   * WHAT IS IN THE WORLD, for the list beside the code.
   *
   * Read straight from the document the Place editor saves, rather than through the scene — the
   * scene only exists while Place is open, and the ids a program refers to are a property of the
   * world, not of what happens to be loaded.
   */
  instances: async () => {
    if (!selected) return { world: null, items: [] }
    try {
      const r = await fetch(`/sites/${selected}/placements.json`, { cache: 'no-cache' })
      if (!r.ok) return { world: selected, items: [] }
      const doc = (await r.json()) as { items?: { id: string; asset: string; tags?: string[] }[] }
      return { world: selected, items: (doc.items ?? []).map((i) => ({ id: i.id, asset: i.asset, tags: i.tags ?? [] })) }
    } catch {
      return { world: selected, items: [] }
    }
  },
  makeDir: async (id) => { await api.makeProgramDir(id) },
  removeDir: async (id) => { await api.deleteProgramDir(id) },
  refresh: () => { if (mode === 'program') void programPanel.render() },
})

/**
 * The Shell panel: a prompt over the editor's own documents.
 *
 * `docs` asks the service what exists and `read` fetches one document's text; the shell projects
 * both into an in-browser filesystem and saves a write back. The reads happen HERE rather than in
 * the worker because the worker has no network at all by design — see src/agent/shell.ts.
 */
const shellPanel = new ShellPanel({
  host: pane('shell'),
  sidebarHost: inspector,
  docs: async () => {
    const [w, l, p] = await Promise.all([
      api.worlds().then((r) => r.worlds).catch(() => []),
      api.levels().then((r) => r.levels).catch(() => []),
      api.programs().then((r) => r.programs).catch(() => []),
    ])
    // a site's authored documents: offered for every baked world, and the ones that do not exist
    // simply come back empty and are not projected
    const sites = w.filter((x) => x.baked).map((x) => ({ slug: x.slug, docs: SITE_DOCS }))
    return { worlds: w.map((x) => ({ slug: x.slug })), levels: l.map((x) => ({ id: x.id })), programs: p, sites }
  },
  read: async (path) => {
    const rel = path.slice(`${ROOT}/`.length)
    try {
      if (rel.startsWith('worlds/')) {
        const w = (await api.worlds()).worlds.find((x) => `worlds/${x.slug}.json` === rel)
        return w ? JSON.stringify(w, null, 1) : null
      }
      if (rel.startsWith('levels/')) return JSON.stringify((await api.level(rel.slice(7, -5))).level, null, 1)
      if (rel.startsWith('programs/')) return (await api.program(rel.slice(9))).source
      if (rel.startsWith('sites/')) {
        // static files beside the bake; a missing optional document is a 404, not an error
        const r = await fetch(`/${rel}`, { cache: 'no-cache' })
        if (!r.ok) return null
        const text = await r.text()
        return text.trimStart().startsWith('{') ? text : null
      }
    } catch {
      return null
    }
    return null
  },
})

/**
 * The Agent panel: the picker, the session and the transcript.
 *
 * Its FILES are the Shell's — an agent's read of `worlds/x.json` is the projection's read and its
 * write is a live edit — so it asks for the live machine rather than making a second one. Two
 * filesystems over the same documents is two answers to "what does this file say".
 */
/*
 * THE MCP BRIDGE (agentmcp lane, 2026-09-29).
 *
 * This page dials the service and offers the tools that cannot live on it: the wasm shell and
 * Monaco's TypeScript service. Everything else an outside agent can reach — worlds, levels,
 * programs, the catalog, the runs, the splats — is a server-side tool and works with this tab shut
 * (tools/worldeditor/mcptools.mjs). So this is not "the agent's access"; it is the part of it that
 * needs a browser.
 */
const mcpSection = el('div', 'mcp-section')
const bridge = new AgentBridge({
  shell: () => shellPanel.machine,
  programs: async () => {
    const list = await api.programs().then((r) => r.programs).catch(() => [])
    const out: { path: string; text: string }[] = []
    // Sources one at a time rather than one bulk endpoint, because there is no bulk endpoint and
    // a program list is tens of files, not thousands.
    for (const p of list) {
      const src = await api.program(p.id).then((r) => r.source).catch(() => null)
      if (src !== null) out.push({ path: p.id, text: src })
    }
    return out
  },
  // `step` as well as `mode` since main split them: an agent asking what is on screen wants
  // the stage, not just that we are in world mode.
  state: () => ({ mode, step, world: selected, dirty }),
  token: () => mcpToken,
  label: 'world editor',
  onStatus: (st) => {
    mcpPanel.onBridge(st)
    // WHICH WINDOW THIS IS, for a probe and for a console session. Two editors attached are
    // indistinguishable from outside without it, and the whole point of ownership is that they
    // are not the same window.
    ;(window as unknown as { __mcpown?: unknown }).__mcpown = st.own ?? null
  },
})
const mcpPanel = new McpPanel(mcpSection, () => bridge)

const agentPanel = new AgentPanel({
  host: pane('agent'),
  transcriptHost: inspector,
  shell: () => shellPanel.machine,
  extraSections: (host) => {
    host.append(mcpSection)
    void mcpPanel.load()
  },
})

/*
 * The token the bridge needs, fetched once. A browser's WebSocket cannot send an Authorization
 * header, so the socket carries it in the query — same-origin, to our own service — and that means
 * the page has to know it before it dials. See agent/bridge.ts.
 */
let mcpToken: string | null = null
void api
  .mcpConfig()
  .then((c) => {
    mcpToken = c.auth.token
    bridge.start()
  })
  .catch(() => {
    // An older service with no MCP config still runs the editor; the Agent tab says so.
  })

let mode: Mode = 'world'
let step: Step = 'explore'
let dirty = false

/** Showing that stage right now? Two facts, asked together everywhere, so asked once here. */
const at = (s: Step) => mode === 'world' && step === s

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

/**
 * A tile's identity includes the QUESTION it answered, not just where it is.
 *
 * `major` is motorway+trunk below zoom 9 and adds primary above it, and the server's cache file
 * has always keyed on that. The client's key did not, so a tile fetched at zoom 9 stayed in the
 * map, was drawn unchanged at zoom 8 beside neighbours that had answered a different question, and
 * `tileState.has(key)` stopped it ever being re-asked at the right one. That is why primary road
 * numbers appeared on a motorways-only view of Northern Italy and why road density jumped from
 * tile to tile (Rich, 2026-09-27).
 */
const tileKey = (layer: string, t: { z: number; x: number; y: number }, variant = '') => `${layer}/${variant}/${t.z}/${t.x}/${t.y}`

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
      if (at('explore')) renderExplore()
    }
    return
  }
  roadsOff = plan.length ? null : 'nothing to fetch at this zoom — the country outlines and world cities are the whole picture out here'
  // Always, even when the plan is empty: at world zoom nothing loads, and without this the panel
  // kept whatever numbers it had when the last tile landed — it read "zoom 15" over Europe.
  if (at('explore')) renderExplore()
  const wanted = new Set<string>()
  for (const layer of plan) for (const t of layer.tiles) wanted.add(tileKey(layer.layer, t))

  /*
   * A LAYER'S TILES GO TOGETHER, NOT ONE AFTER ANOTHER.
   *
   * This awaited each tile in turn, and the server ran one at a time per layer on top of that. A
   * Northern Italy view is six motorway tiles at fifteen seconds each, so the two serialisations
   * multiplied into a minute and a half of a browser waiting on a server that was idle for most
   * of it. The server has lanes now; this stops holding them shut.
   *
   * Layers still go in order, because the plan is ordered by what matters — a road layer arriving
   * before the place names is the right way round, and a screen that fills in that order reads as
   * progress rather than as a flicker.
   */
  for (const layer of plan) {
    const want = layer.tiles.filter((t) => !tileState.has(tileKey(layer.layer, t, layer.variant)))
    if (!want.length) continue
    await Promise.all(
      want.map(async (t) => {
        const key = tileKey(layer.layer, t, layer.variant)
        tileState.set(key, 'live')
        loading++
        if (at('explore')) renderExplore()
        try {
          // the plan's own signal, so a pan ABORTS the tiles it superseded instead of leaving
          // them to finish into a view nobody is looking at any more
          const doc = await api.tile(layer.layer, t, zoom, mine?.signal)
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
          if (at('explore')) renderExplore()
        }
      }),
    )
    // A newer viewport has superseded this plan; stop working through a stale one.
    if (planReq !== mine) return
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
/**
 * THE ASSET LIBRARY IS A TAB, not a dialog over the map.
 *
 * Rich, 2026-09-28: "No reason to have the map visible, no reason to have place buttons - this
 * should really just be the catalog and materials and service form taking up the whole area in
 * tabs... The assets area really needs to focus on the assets and materials."
 *
 * So it takes `#assets`, the same full-width box the code editor takes, and the Place mode is
 * where placing happens — its palette is the roster now.
 */
const assets = new AssetCatalog({
  host: document.getElementById('assets')!,
  world: () => selected,
  // the physics lane's Dynamics group, on the items that are vehicles (src/ui/vehicles.ts)
  extensions: [vehicleExtension(), actorExtension(), weaponExtension()],
  /*
   * PLACEABLE IS A TICK BOX, not a second screen.
   *
   * The world's placeable catalog is this volume's (`/api/catalog`), which is why this is wired
   * here and not inside the library: the viewer has a library too and no catalog to add to.
   */
  placeable: {
    listed: async () => new Set((await api.catalog()).assets.map((a) => a.id)),
    add: async (entry) => { await api.mergeCatalog([entry]) },
    remove: async (id) => { await api.unlistAsset(id) },
  },
})

const define = new DefinePanel({
  map,
  host: inspector,
  onSaved: async (w) => {
    selected = w.slug
    await refreshWorlds()
    setStep('bake')
  },
  onDirty: (d) => setDirty(d, 'boundary'),
  worlds: () => worlds,
  onImported: async () => {
    await refreshWorlds()
    renderWorldSelect()
    renderPanel()
  },
})

/** One unsaved mark for the whole bar, naming what is unsaved — two panels can both be editing. */
function setDirty(d: boolean, what = 'changes') {
  dirty = d
  dirtyEl.classList.toggle('on', d)
  dirtyEl.textContent = d ? `unsaved ${what}` : ''
}

const runsPanel = new RunsPanel({
  host: inspector,
  logs,
  worlds: () => worlds,
  selected: () => selected,
  onFinished: () => void refreshWorlds(),
  refreshWorlds,
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
      /*
       * THE ORDER IS THE PIPELINE, left to right: make a world, dress it, turn it into a level,
       * and the library of things all three draw on. Then the three surfaces that are about
       * writing rather than building, and the capture rig at the end.
       */
      options: [
        { value: 'world', label: 'World', icon: 'map', key: '1' },
        { value: 'place', label: 'Place', icon: 'pencil-square', key: '2' },
        { value: 'stage', label: 'Stage', icon: 'flag', key: '3' },
        { value: 'assets', label: 'Assets', icon: 'cube', key: '4' },
        { value: 'program', label: 'Program', icon: 'beaker', key: '5' },
        { value: 'shell', label: 'Shell', icon: 'server-stack', key: '6' },
        { value: 'agent', label: 'Agent', icon: 'sparkles', key: '7' },
        { value: 'splats', label: 'Splats', icon: 'camera', key: '8' },
      ],
      onChange: (m) => setMode(m),
    }),
    searchBox,
    el('div', 'topbar-spacer'),
    dirtyEl,
    // NO ASSET BUTTONS HERE. "Assets" existed three times — this pair of icons, the mode below,
    // and two more items in the drawer, two of which opened a DIFFERENT dialog from the mode
    // (Rich, 2026-09-27: "this whole thing needs a once over for UX, it is a mess"). The rule
    // now: the bar is the pipeline, the drawer is the app, and nothing appears in both.
    //
    // "What this is pointed at" used to be an icon here that fired a nine-second toast. It is a
    // readout in Settings → Services now, where it can be read twice.
    button({ icon: 'cog-6-tooth', title: 'settings', variant: 'ghost', onClick: () => openSettings() }),
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
  if (at('explore')) renderExplore()
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
      'Places you have kept. Make a world from one when you want to bake it.',
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

/*
 * THE DRAWER IS THE APPLICATION; THE BAR IS THE WORK.
 *
 * Rich, 2026-09-29: "the hamburger menu and main menu need a rethink for what goes where. 'drive
 * it' won't make any sense from that menu, new world is already in that explore tab, and we need a
 * settings tab."
 *
 * Both of those were the same mistake — a menu of everything rather than a menu of one kind of
 * thing. Two rules now, and they decide every row:
 *
 *   the BAR is where you work: eight surfaces, and the one you are on is the one you see.
 *   the DRAWER is what is true of this installation: settings, and what it is pointed at.
 *
 * So `New world` is gone, because it is the Define stage and the Explore stage both offer it, and
 * a third door to the same room is just somewhere else to look for it. `Drive it` is gone from
 * here because it is not a property of the installation — it is an action on ONE world, which is
 * why it now sits next to that world in the picker, where it can be disabled when the world is
 * not baked. It could never be disabled here; it just took you to an empty viewer.
 */
function buildDrawer() {
  const nav = drawer.section('')
  drawer.item(nav, {
    id: 'settings',
    label: 'Settings',
    icon: 'cog-6-tooth',
    hint: 'git and LFS, the agent, appearance, and what this is pointed at',
    onClick: () => openSettings(),
  })
}

/**
 * Settings: everything that is true of this installation rather than of a world.
 *
 * A dialog and not a ninth mode, because none of it is a place you work — you come, change a
 * thing, and go back to what you were doing. A mode would have thrown your panel away to show you
 * a remote URL.
 */
let settingsDialog: Dialog | null = null
let gitPanel: GitPanel | null = null
function openSettings() {
  drawer.set(false)
  if (!settingsDialog) {
    settingsDialog = new Dialog({ title: 'Settings', icon: 'cog-6-tooth', size: 'lg', movable: true })
    settingsDialog.body.append(
      new Tabs([
        {
          id: 'git',
          label: 'Git and LFS',
          icon: 'cloud-arrow-up',
          build: (h) => {
            gitPanel = new GitPanel({ host: h, refresh: () => void gitPanel?.load() })
            void gitPanel.load()
          },
        },
        { id: 'agent', label: 'Agent', icon: 'sparkles', build: (h) => buildAgentSettings(h) },
        { id: 'look', label: 'Appearance', icon: 'eye', build: (h) => buildAppearance(h) },
        { id: 'services', label: 'Services', icon: 'server-stack', build: (h) => void buildServices(h) },
      ]).root,
    )
  }
  settingsDialog.open()
  void gitPanel?.load()
}

/**
 * The agent's configuration — which is NOT here yet, on purpose.
 *
 * The `agentmcp` lane is inside `ui/agentpanel.ts` right now, adding an MCP section: a server URL,
 * a minted token, a status and the config JSON to paste into a client. Copying today's fields into
 * this tab would fork that work the day before it lands, and the copy would be the one that went
 * stale. They are adding `mountAgentSettings(host)` to their own file; this calls it the moment it
 * exists, and until then says where the settings are rather than pretending to be them.
 */
function buildAgentSettings(host: HTMLElement) {
  const p = el('p', 'panel-hint')
  p.append(icon('information-circle', 14), el('span', '', 'The agent’s connection and MCP settings are in the Agent surface while that work lands.'))
  host.append(p)
  host.append(el('p', 'dim', 'Bar → Agent (7).'))
}

function buildAppearance(host: HTMLElement) {
  host.append(
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

/**
 * What this editor is pointed at.
 *
 * This was a toast — six lines of configuration fired at the corner of the screen for nine seconds,
 * which is long enough to read none of it and no way to get it back except pressing the button
 * again. It is a readout, and it belongs where the rest of the installation's truth is.
 */
async function buildServices(host: HTMLElement) {
  host.append(el('p', 'dim', 'reading…'))
  const ready = await api.ready().catch(() => null)
  host.replaceChildren()
  host.append(readout('data', config?.data ?? '?'))
  host.append(readout('runner', `${config?.runs.runner ?? '?'}${config?.runs.runner === 'kubernetes' ? ` · ${config?.runs.namespace}` : ''}`))
  if (config?.runs.runner === 'kubernetes') host.append(readout('image', config?.runs.image ?? '?'))
  host.append(readout('overpass', ready?.overpass.ok ? `up (${ready.overpass.ms} ms)` : `DOWN — ${ready?.overpass.detail?.slice(0, 120) ?? 'no answer'}`))
  host.append(readout('kubernetes', ready?.kubernetes.ok ? `ok (${ready.kubernetes.namespace})` : ready?.kubernetes.detail ?? '?'))
  host.append(readout('assetsvc', config?.assetsvc ?? 'not configured'))
  host.append(readout('bucket', config?.bucket ? `${config.bucket.bucket}/${config.bucket.prefix}` : 'not configured'))
  host.append(button({ label: 'Check again', icon: 'arrow-path', variant: 'ghost', onClick: () => void buildServices(host) }))
}


/** The world picker, and what it says about each one. */
function renderWorldSelect() {
  worldSel.replaceChildren()
  const b = el('button', 'site-button')
  const w = worlds.find((x) => x.slug === selected)
  b.append(icon('map-pin', 15))
  const t = el('span', 'site-text')
  t.append(el('span', 'site-name', w?.slug ?? 'no world'))
  // `radius_m` IS OPTIONAL HERE. A world the store materialised from a bake it found on the
  // volume has a slug and a bake and need not have a definition at all, so this threw the moment
  // one of those was picked — and the picker is the first thing anyone touches.
  t.append(el('span', 'site-meta', w
    ? `${Number.isFinite(w.radius_m) ? `${w.radius_m.toLocaleString()} m · ` : ''}${w.baked ? 'baked' : 'not baked'}`
    : `${worlds.length} defined`))
  b.append(t, icon('chevron-down', 14))
  b.onclick = () => openWorldMenu(b)
  worldSel.append(b)
  /*
   * DRIVE IT, beside the world it drives.
   *
   * It was in the hamburger, where it could not be disabled and so happily sent you to an empty
   * viewer (Rich, 2026-09-29: "'drive it' won't make any sense from that menu"). It is an action
   * on ONE world, and here it knows which world and whether that world has anything to stand on.
   * It navigates in place, carrying the slug, so the browser's own back button returns you here.
   */
  worldSel.append(button({
    icon: 'globe-alt',
    variant: 'ghost',
    title: w?.baked ? `drive ${w.slug}` : w ? `${w.slug} is not baked yet` : 'no world selected',
    disabled: !w?.baked,
    onClick: () => { if (w?.baked) location.href = `/index.html?site=${w.slug}` },
  }))
}

/**
 * Point the whole page at a world: the map, the panel, and whichever mode is showing.
 *
 * One function, called by the picker and by `__we.select`, because "choose a world" now means
 * four things at once — fly the map there, draw its extent, re-render the panel, and tell the
 * Place mode to load that bake. Two code paths for that is how the picker and the 3D scene end up
 * looking at different places.
 */
function selectWorld(slug: string) {
  const w = worlds.find((x) => x.slug === slug)
  if (!w) return
  selected = slug
  rememberNav()
  renderWorldSelect()
  if (Number.isFinite(w.lat)) {
    map.flyTo({ lat: w.lat, lon: w.lon }, zoomFor(w.radius_m))
    map.extent = { centre: { lat: w.lat, lon: w.lon }, radius_m: w.radius_m }
  } else {
    map.extent = null
  }
  map.draw()
  renderPanel()
}

function openWorldMenu(anchor: HTMLElement) {
  const menu = el('div', 'world-menu')
  const list = [...worlds].sort((a, b) => Number(!!b.baked) - Number(!!a.baked) || a.slug.localeCompare(b.slug))
  for (const w of list) {
    const row = el('button', `world-row${w.slug === selected ? ' on' : ''}`)
    row.append(icon(w.baked ? 'check' : 'clock', 13), el('span', 'world-slug', w.slug), el('span', 'world-meta', `${w.radius_m?.toLocaleString() ?? '?'} m`))
    row.onclick = () => {
      menu.remove()
      selectWorld(w.slug)
    }
    menu.append(row)
  }
  /*
   * IMPORT LIVES HERE, at the bottom of the picker, because of what this menu looks like on a
   * fresh install: empty. The image ships with no worlds now (Rich, 2026-09-27) and an empty menu
   * with no way out of it is a dead end — so the way IN is on the thing everyone clicks first.
   */
  menu.append(el('div', 'world-sep'), ...worldMenuTransfer({
    selected: () => selected,
    worlds: () => worlds,
    reload: async () => { await refreshWorlds(); renderWorldSelect(); renderPanel() },
  }, () => menu.remove()))
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
  if (mode === 'world' && step === 'bake') runsPanel.stop()
  if (mode === 'assets') assets.stop() // a preview spinning for nobody
  // NOT shellPanel.stop(): a machine with a Pyodide in it takes fifteen seconds to come back, and
  // leaving the tab to look something up must not cost that
  // NOT splatsPanel.stop(): leaving the tab must not abort a forty-gigabyte upload
  if (mode === 'place' && m !== 'place') siteEditor?.setActive(false)
  mode = m
  rememberNav()
  for (const b of bar.querySelectorAll<HTMLButtonElement>('.seg')) b.classList.toggle('on', b.dataset.value === m)
  showSiteEditor(m === 'place')
  // one pane, three things that want it: the map, the Place scene, and the code surface the
  // Program and Shell modes share
  showCode(m === 'program' || m === 'shell' || m === 'agent')
  showAssets(m === 'assets')
  // Define puts the map in draw mode; the panel switches it to `pick` itself when the world is a
  // named-roads one, because then clicking is choosing a road rather than dropping a vertex.
  map.mode = m === 'world' && step === 'define' ? 'draw' : 'pan'
  renderSteps()
  renderPanel()
}

/**
 * Move between the stages of making a world.
 *
 * Separate from `setMode` because they are separate questions — "what am I working on" and "how
 * far along am I" — and because the panels have per-stage teardown that a mode switch does not
 * want to repeat. A stage switch is cheap; it must stay cheap, since the point of putting them in
 * one place is that you bounce between them.
 */
function setStep(s: Step) {
  if (step === 'bake' && s !== 'bake') runsPanel.stop()
  step = s
  rememberNav()
  map.mode = s === 'define' ? 'draw' : 'pan'
  renderSteps()
  renderPanel()
}

/* ---- the world wizard ------------------------------------------------------------------------
   Four stages of one job, with their state on them.

   A plain tab strip would have been the smaller change, but it would not have answered the
   question the old top bar could not answer either: WHICH ONE FIRST. So each stage says whether
   it is done for the world you have selected — a tick on Define when there is a boundary, a tick
   on Bake when there is a bake — and the strip reads as progress rather than as four alternatives.

   Every stage stays clickable regardless. Rich asked to "bounce between them", and a wizard that
   refuses to show you the next screen until you have finished this one is the reason people hate
   wizards; the state is information, not a gate. */

const STEP_LABEL: Record<Step, { label: string; icon: IconName; hint: string }> = {
  explore: { label: 'Explore', icon: 'map', hint: 'find somewhere' },
  places: { label: 'Places', icon: 'map-pin', hint: 'the ones you kept' },
  define: { label: 'Define', icon: 'pencil-square', hint: 'draw its boundary' },
  bake: { label: 'Bake', icon: 'play', hint: 'turn it into a world' },
}

/** Done, for the world in the picker. Unknowable without one, which is itself worth showing. */
function stepDone(s: Step): boolean {
  const w = worlds.find((x) => x.slug === selected)
  if (!w) return false
  if (s === 'define') return !!w.boundary?.length || w.source === 'bake-only'
  if (s === 'bake') return !!w.baked
  return false
}

function renderSteps() {
  const host = document.getElementById('steps')
  if (!host) return
  host.hidden = mode !== 'world'
  if (mode !== 'world') return
  host.replaceChildren()
  const strip = el('div', 'tab-strip steps')
  for (const s of STEPS) {
    const b = el('button', `tab${step === s ? ' on' : ''}${stepDone(s) ? ' done' : ''}`)
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(step === s))
    b.append(icon(stepDone(s) ? 'check' : STEP_LABEL[s].icon, 16), el('span', '', STEP_LABEL[s].label))
    b.title = STEP_LABEL[s].hint
    b.onclick = () => setStep(s)
    strip.append(b)
  }
  host.append(strip)
}

/**
 * Keep where you are, in the URL and in this browser.
 *
 * `replaceState`, not `pushState`: switching tabs is not navigating, and forty tab switches should
 * not be forty presses of the back button to leave the page. Guarded on `booted` so the restore
 * itself does not immediately write back a half-built state.
 */
function rememberNav() {
  if (!booted) return
  // the step only travels with the mode that has steps, so a link to the Assets library does not
  // carry an opinion about which stage of world-building the sender happened to be on
  const nav = { mode, step: mode === 'world' ? step : null, world: selected }
  saveNav(nav)
  history.replaceState(null, '', toUrl(location.search, nav))
}

/** Swap the program editor in and out. Same pane as the map and the Place scene, one at a time. */
function showAssets(on: boolean) {
  const pane = document.getElementById('assets')
  if (pane) pane.hidden = !on
  const mapCanvas = document.querySelector<HTMLCanvasElement>('#map')
  if (mapCanvas && (on || mode !== 'place')) mapCanvas.hidden = on
  // the inspector too: nothing in the world panel helps while you are working on a texture
  const aside = document.querySelector<HTMLElement>('.inspector')
  if (aside) aside.hidden = on
  const readout = document.getElementById('readout')
  if (readout && on) readout.hidden = true
}

function showCode(on: boolean) {
  const code = document.getElementById('code')
  const mapCanvas = document.querySelector<HTMLCanvasElement>('#map')
  if (code) code.hidden = !on
  // and which of the three panes inside it. Hidden rather than removed, so a panel keeps its DOM
  // — see `pane`.
  for (const p of codePane.querySelectorAll<HTMLElement>(':scope > [data-pane]')) p.hidden = !on || p.dataset.pane !== mode
  // only the Place mode may hide the map as well; this must not un-hide it on the way out of a
  // mode that was never showing it
  if (mapCanvas && (on || mode !== 'place')) mapCanvas.hidden = on
  const title = document.getElementById('panel-title')
  if (title && on) title.textContent = mode === 'shell' ? 'Shell' : mode === 'agent' ? 'Agent' : 'Program'
  const readout = document.getElementById('readout')
  if (readout) readout.hidden = on || readout.hidden
}

/** Swap the 3D scene and its chrome in and out. The map keeps its own canvas either way. */
function showSiteEditor(on: boolean) {
  const gl = document.querySelector<HTMLCanvasElement>('#gl')
  const mapCanvas = document.querySelector<HTMLCanvasElement>('#map')
  if (gl) gl.hidden = !on
  if (mapCanvas) mapCanvas.hidden = on
  for (const id of ['se-rail', 'se-inspector', 'se-actions']) {
    const n = document.getElementById(id)
    if (n) n.hidden = !on
  }
  const panel = document.getElementById('panel')
  if (panel) panel.hidden = on
  const title = document.getElementById('panel-title')
  if (title) title.textContent = on ? 'Place' : 'World'
  const readout = document.getElementById('readout')
  if (readout) readout.hidden = on
}

function renderPanel() {
  if (mode === 'place') {
    // Needs a BAKED world: there is nothing to stand on otherwise.
    const w = worlds.find((x) => x.slug === selected)
    if (!w?.baked) {
      showSiteEditor(false)
      inspector.replaceChildren()
      inspector.append(empty(selected ? `${selected} is not baked yet.` : 'No world selected.'))
      if (selected) inspector.append(empty('Bake it first — Place edits what the bake produced.'))
      return
    }
    void siteEditorFor(w.slug)
      .then((se) => se.setActive(true))
      .catch((e) => {
        showSiteEditor(false)
        toast(`place editor: ${(e as Error).message}`, 'danger', 8000)
      })
    return
  }
  if (mode === 'program') {
    void programPanel.render()
    return
  }
  if (mode === 'shell') {
    void shellPanel.render()
    return
  }
  if (mode === 'agent') {
    void agentPanel.render()
    return
  }
  if (mode === 'stage') {
    void stagePanel.load()
  } else if (mode === 'assets') {
    void assets.open()
  } else if (mode === 'splats') {
    void splatsPanel.load()
  } else if (at('places')) {
    renderIndex(inspector)
  } else if (at('define')) {
    // the texture library, for the per-world surface picker. Fire and forget: it re-renders when
    // it lands, and the form works without it.
    void define.loadSurfaces().then(() => { if (at('define')) define.render() })
    const w = worlds.find((x) => x.slug === selected)
    if (w && w.source !== 'bake-only' && !define.preview) define.load(w)
    else define.render()
  } else if (at('bake')) {
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
  setMode('world')
  setStep('define')
  toast('click on the map to drop boundary points; click the first one again to close the ring', 'info', 6000)
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
    // the number keys are the top bar, in the order it is drawn; the steps are not on keys,
    // because a wizard you bounce between with the mouse does not need eight shortcuts
    const nth = '12345678'.indexOf(e.key)
    if (nth >= 0 && nth < MODES.length) setMode(MODES[nth])
    /*
     * NOT WHILE THE SITE EDITOR HAS THE KEYBOARD.
     *
     * `n` is "new world" here and "new area" in the site editor, and both handlers are on
     * `window` — so pressing it in Place mode started a polygon AND threw you out of Place into
     * the Define stage, which looked like the draw tool doing nothing. The site editor is a whole
     * application inside this one; while it is showing, its shortcuts win.
     */
    else if (e.key.toLowerCase() === 'n' && mode !== 'place') newWorld()
    else if (e.key === 'Enter' && at('define')) map.closeRing()
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

  /*
   * WHERE YOU WERE. The URL wins over this browser's memory, per field — a link that names a world
   * and no tab opens that world where you left off rather than throwing your tab away because the
   * link was silent about it.
   */
  const want = resolveNav(fromUrl(location.search), loadNav(), {
    modes: [...MODES], steps: [...STEPS], worlds: worlds.map((w) => w.slug),
  })
  const start = worlds.find((w) => w.slug === want.world) ?? worlds.find((w) => w.baked)
  if (start && Number.isFinite(start.lat)) {
    selected = start.slug
    // Only if nobody has moved the map while the world list was loading — see `MapView.moved`.
    if (!map.moved) map.flyTo({ lat: start.lat, lon: start.lon }, zoomFor(start.radius_m), { user: false })
  }
  renderWorldSelect()
  step = (want.step as Step) ?? 'explore'
  setMode((want.mode as Mode) ?? 'world')
  // LAST LINE OF BOOT, and it exists because `window.__we` is assigned when the module finishes
  // evaluating — long before this runs. A probe that waited for the handle and then set a mode
  // had it silently undone by the setMode above, and the failure was intermittent because it
  // depended on how fast the world list came back.
  booted = true
  // and write where we landed into the URL, so the address bar is copyable the moment the page is
  // up rather than only after the next click
  rememberNav()
}
let booted = false

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
      ready: () => boolean
      mode: () => Mode
      /** which stage of `world`; meaningless in any other mode, and reported anyway rather than
       *  hidden, because a probe that cannot see stale state cannot tell you it is stale */
      step: () => Step
      map: MapView
      define: DefinePanel
      runs: RunsPanel
      setMode: (m: Mode) => void
      setStep: (s: Step) => void
      worlds: () => World[]
      selected: () => string | null
      select: (slug: string) => void
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
  /** false until boot() has finished; see the note where it is set */
  ready: () => booted,
  /** which panel is showing */
  mode: () => mode,
  step: () => step,
  map,
  define,
  runs: runsPanel,
  setMode,
  setStep,
  worlds: () => worlds,
  selected: () => selected,
  /** point the page at a world, exactly as clicking it in the picker does */
  select: selectWorld,
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
