// The viewer's chrome: top bar, drawer, settings dialog, HUD.
//
// The information architecture, which is the actual point of this file:
//
//   TOP BAR    what you are looking at (site, season) and the four things you do constantly
//              (drive, photo, top, share). Nothing else. It sits over the scene, so every row
//              added here is a row of the world you cannot see.
//   DRAWER     places to go and things to do to the whole app — pick a site, open settings,
//              open tuning, the editor, the keyboard reference.
//   SETTINGS   everything that is a *setting*, in tabs: Layers, Display, Site, Controls.
//   TUNING     its own dialog, because it is two hundred sliders and belongs in front of you
//              while you drive, not buried three levels down. See tune.ts.
//
// The old panel had all four of these in one always-on column, which is why finding anything in it
// meant scrolling past everything else.
import { aaMode, setAAMode, resolvedAA, type AAMode } from '../render'
import { Dialog, Drawer, Tabs, button, el, type Tab } from './shell'
import { icon } from './icons'
import { empty, group, bodyOf, layerToggle, readout, select, slider, toggle } from './controls'
import type { IndexEntry, Manifest } from '../site'
import type { UiMode } from '../gamepolicy'
import { ACTIONS, ACTION_LABELS, type GameSettings } from '../gamesettings'
import { keyLabel, padBindingLabel } from '@apex/engine/input/bindings'
import { SEASONS, type Season } from '../season'
import { STYLES, type Style } from '../style'

/** the exaggerations offered; a URL may carry any value in 0.25–10 and the select grows to show it */
const RELIEFS = [1, 1.5, 2, 3, 5]
const clampReliefParam = () => {
  const k = Number(new URLSearchParams(location.search).get('relief'))
  return Number.isFinite(k) && k > 0 ? Math.min(10, Math.max(0.25, k)) : 1
}
import { WEATHERS, type Weather } from '../weather'

/**
 * Layers, grouped by what they are rather than by the order someone happened to add them.
 * `id` is the key the scene already uses, so nothing downstream changes.
 */
export const LAYER_GROUPS: { title: string; layers: { id: string; label: string; on: boolean }[] }[] = [
  {
    title: 'Ground & sky',
    layers: [
      { id: 'imagery', label: 'Aerial imagery', on: true },
      { id: 'horizon', label: 'Far hills', on: true },
      // OFF on purpose, and not merely because the old HTML had it off: the canopy blanket is
      // built lazily on first toggle — 72 MB and ~1.05 M vertices that almost every session threw
      // away unseen. Defaulting it on here would quietly undo that.
      { id: 'canopy', label: 'Canopy blanket', on: false },
    ],
  },
  {
    title: 'Nature',
    layers: [
      { id: 'trees', label: 'Trees', on: true },
      { id: 'splats', label: 'Captured world (splats)', on: true },
      { id: 'grass', label: 'Grass & ground cover', on: true },
      { id: 'rocks', label: 'Rock faces', on: true },
      { id: 'water', label: 'Water', on: true },
    ],
  },
  {
    title: 'Road',
    layers: [
      { id: 'road', label: 'Carriageway', on: true },
      { id: 'structures', label: 'Bridges & overpasses', on: true },
      { id: 'barriers', label: 'Guard rail & barriers', on: true },
      { id: 'sidewalks', label: 'Sidewalks & kerbs', on: true },
      { id: 'parking', label: 'Parking', on: true },
    ],
  },
  {
    title: 'Built',
    layers: [
      { id: 'buildings', label: 'Buildings', on: true },
      { id: 'power', label: 'Power lines', on: true },
      { id: 'furniture', label: 'Street furniture', on: true },
      // from the street-spice lane: intersection control derived from the drawn network, because
      // a US suburb records almost none of it in OSM (854 drivable ways in the Crofton triangle
      // carry 35 signal nodes and 3 stop nodes). Toggles live here now, not as input[data-layer]
      // in the HTML — that markup is gone.
      { id: 'signals', label: 'Traffic signals', on: true },
      { id: 'stopbars', label: 'Stop signs & bars', on: true },
      { id: 'blades', label: 'Street name blades', on: true },
    ],
  },
  {
    title: 'Analysis',
    layers: [
      { id: 'spine', label: 'Centreline', on: false },
      { id: 'markers', label: 'Distance markers', on: false },
      { id: 'wire', label: 'Wireframe', on: false },
    ],
  },
]

/**
 * How this site's stored metres should be read.
 *
 * Showing `EPSG:32618` alone was actively misleading after the geodetic move: a manifest with
 * `kind: "enu"` holds ENU metres about `frame.anchor`, and the EPSG is only where the bake started
 * from. `frame.kind` is the ONLY field that distinguishes the two, and reading it wrong rotates
 * the world by the grid convergence — about 55 m at 3 km, and it looks plausible. So the panel
 * says which, names the anchor, and gives the convergence that separates the two norths.
 * See docs/corridor/FRAME.md.
 */
function frameReadouts(m: Manifest): HTMLElement[] {
  const f = m.frame
  const kind =
    f.kind === 'enu'
      ? 'ENU about the anchor'
      : f.kind === 'utm'
        ? 'UTM-relative, on a plane'
        : 'UTM-relative (baked before frame.kind existed)'
  // A one-line summary first, because it makes the ROTATION visible — which is the part a human
  // has to see. The numbers follow for anyone who needs them.
  const rows: HTMLElement[] = []
  if (f.kind === 'enu' && f.anchor) {
    const ns = f.anchor.lat >= 0 ? 'N' : 'S'
    const ew = f.anchor.lon >= 0 ? 'E' : 'W'
    const conv = typeof f.utm_convergence_deg === 'number' ? `, grid north ${f.utm_convergence_deg >= 0 ? '+' : ''}${f.utm_convergence_deg.toFixed(2)}°` : ''
    rows.push(readout('Frame', `ENU about ${Math.abs(f.anchor.lat).toFixed(5)}${ns} ${Math.abs(f.anchor.lon).toFixed(5)}${ew} (was EPSG:${f.epsg}${conv})`, false))
  } else {
    rows.push(readout('Frame', kind, false), readout('Bake EPSG', String(f.epsg)))
  }
  if (f.anchor) rows.push(readout('Anchor', `${f.anchor.lat.toFixed(6)}, ${f.anchor.lon.toFixed(6)}`))
  if (typeof f.utm_convergence_deg === 'number') rows.push(readout('Convergence', `${f.utm_convergence_deg.toFixed(4)}° grid→true`))
  if (typeof f.utm_scale === 'number') rows.push(readout('UTM scale', `${((f.utm_scale - 1) * 1e6).toFixed(0)} ppm`))
  return rows
}

/** Keyboard reference, shown in Settings → Controls instead of as six lines of footer text. */
const KEYS: { group: string; rows: [string, string][] }[] = [
  {
    group: 'Fly',
    rows: [
      ['W A S D', 'move'],
      ['Q E', 'turn'],
      ['R F', 'up / down'],
      ['T G', 'zoom (the wheel does it too)'],
      ['Shift', 'faster'],
      ['drag', 'orbit · right-drag looks'],
    ],
  },
  // the driving keys are the BINDINGS now (Settings → Controls lists them from the settings, and
  // the Escape menu rebinds them), so the fixed table only carries what cannot be rebound
  {
    group: 'View',
    rows: [
      ['P', 'to the photo'],
      ['H', 'top down'],
      ['X', 'copy a link to this exact view'],
      ['Shift R', 'the car back to the start'],
      ['F6', 'tuning'],
      ['F7', 'performance stats'],
      ['drag', 'look around the car'],
      ['Esc', 'the game menu — or close what is open'],
    ],
  },
]

const AA_LABEL: Record<Exclude<AAMode, 'auto'>, string> = {
  msaa: 'MSAA (needs reload)',
  fxaa: 'FXAA',
  smaa: 'SMAA',
  off: 'none',
}

/** Settings → Display → Trees */
export type TreeStyle = 'realistic' | 'cards' | 'lollipop'

export interface ViewerUIOpts {
  /** the AA mode changed; MSAA needs a reload, the post-process ones do not */
  onAAChange?: (m: AAMode) => void
  onSite: (slug: string) => void
  onSeason: (s: Season) => void
  onStyle: (s: Style) => void
  /** which trees to draw: models with cards beyond, cards only, or the editor's lollipops */
  onTrees: (t: TreeStyle) => void
  onRelief: (k: number) => void
  onWeather: (w: Weather) => void
  onLayers: (layers: Record<string, boolean>) => void
  onDrive: () => void
  onPhoto: () => void
  onTop: () => void
  onStance: () => void
  onTune: () => void
  /**
   * Open a stage (a level set in this world) by id, or null to go back to free roam. Rich,
   * 2026-09-30: "we need a way to select stages from the viewer interface (currently no facility
   * exists)" — the only way in was `?level=` in the address bar.
   */
  onOpenLevel: (id: string | null) => void
  /** the performance panel was switched on or off */
  onPerf?: (on: boolean) => void
  onStructure: (index: number) => void
  /** an address, place or road was picked from the search box: go there */
  onGoto: (hit: { label: string; x: number; z: number; kind: string }) => void
  /**
   * THE POLICY'S ONE QUESTION (gamepolicy.ts): may this tab or control be shown? A program hides
   * settings by id, and the Escape menu asks the same function, so the two views agree.
   */
  allow?: (id: string) => boolean
  /** the player's settings — volumes, bindings, units — for the Audio and Controls tabs */
  settings?: GameSettings
  /** a volume moved */
  onAudio?: () => void
  /** haptics or the gamepad switch moved */
  onBindings?: () => void
  /** open the Escape menu at its Controls screen, where keys are rebound */
  onRebind?: () => void
  /** the interface: the game's or the developer's */
  uiMode?: { get: () => UiMode; set: (m: UiMode) => void; offered: () => boolean }
}

export class ViewerUI {
  private reliefSel: HTMLElement | null = null
  /** reflect the relief a site loaded with (the URL, the stance or the world's look decided it) */
  setRelief(k: number): void {
    const s = this.reliefSel?.querySelector('select')
    if (!s) return
    const v = String(k)
    if (![...s.options].some((o) => o.value === v)) s.append(Object.assign(document.createElement('option'), { value: v, textContent: `${k}× hills` }))
    s.value = v
  }
  bar = el('header', 'topbar')
  /** the address box and its result list — see `buildSearch` and search.ts */
  private search = el('div', 'topbar-search')
  private searchInput = document.createElement('input')
  private searchList = el('div', 'search-results')
  private searchHits: { label: string; detail: string; x: number; z: number; kind: string }[] = []
  private searchSel = -1
  private searchFind: ((q: string) => { label: string; detail: string; x: number; z: number; kind: string }[]) | null = null
  drawer = new Drawer('corridor', 'a strip of real road, measured')
  settings: Dialog
  private siteSel = el('div', 'topbar-site')
  private posEl = el('span', 'hud-pos mono')
  private driveBtn: HTMLButtonElement
  private layerState: Record<string, boolean> = {}
  private settingsTabs: Tabs
  private manifest: Manifest | null = null
  private extra: Record<string, string> = {}
  private sites: IndexEntry[] = []
  private current = ''

  private o: ViewerUIOpts

  constructor(o: ViewerUIOpts) {
    this.o = o
    for (const g of LAYER_GROUPS) for (const l of g.layers) this.layerState[l.id] = l.on

    // ---- top bar
    const hamburger = button({ icon: 'bars-3', variant: 'ghost', title: 'menu', onClick: () => this.drawer.toggle() })
    this.driveBtn = button({ label: 'Drive', icon: 'play', key: 'Tab', onClick: () => this.o.onDrive() })
    this.bar.append(
      hamburger,
      this.siteSel,
      this.search,
      el('div', 'topbar-spacer'),
      this.posEl,
      this.driveBtn,
      button({ icon: 'camera', title: 'to the photo', key: 'P', onClick: () => this.o.onPhoto() }),
      button({ icon: 'map', title: 'top down', key: 'H', onClick: () => this.o.onTop() }),
      button({ icon: 'link', title: 'copy a link to this view', key: 'X', onClick: () => this.o.onStance() }),
      button({ icon: 'adjustments-horizontal', title: 'tuning', key: 'F6', onClick: () => this.o.onTune() }),
      button({ icon: 'cog-6-tooth', title: 'settings', onClick: () => this.settings.open() }),
    )
    this.buildSearch()
    document.body.append(this.bar)

    // ---- settings dialog
    this.settings = new Dialog({ title: 'Settings', icon: 'cog-6-tooth', size: 'md' })
    this.settingsTabs = this.makeSettingsTabs()
    this.settings.body.append(this.settingsTabs.root)

    this.buildDrawer()
  }

  /** may this tab or control be shown? (the policy's question; everything is allowed without one) */
  private allow(id: string): boolean {
    return this.o.allow ? this.o.allow(id) : true
  }

  private makeSettingsTabs(): Tabs {
    const all: Tab[] = [
      { id: 'layers', label: 'Layers', icon: 'squares-2x2', build: (h) => this.buildLayers(h) },
      { id: 'display', label: 'Display', icon: 'swatch', build: (h) => this.buildDisplay(h) },
      { id: 'audio', label: 'Audio', icon: 'speaker-wave', build: (h) => this.buildAudio(h) },
      { id: 'site', label: 'Site', icon: 'map-pin', build: (h) => this.buildSite(h) },
      { id: 'controls', label: 'Controls', icon: 'information-circle', build: (h) => this.buildControls(h) },
    ]
    return new Tabs(all.filter((t) => this.allow(t.id)))
  }

  /**
   * The policy changed under the dialog: throw the tab strip away and build it again from what is
   * allowed now. Cheap — the panels are built lazily — and the only way a tab can disappear.
   */
  refreshSettings(): void {
    const was = this.settingsTabs.current
    this.settingsTabs.root.remove()
    this.settingsTabs = this.makeSettingsTabs()
    this.settings.body.append(this.settingsTabs.root)
    if (was) this.settingsTabs.show(was)
  }

  private stagesSection: HTMLElement | null = null

  /**
   * The stages (levels) set in the world on screen, as drawer rows: free roam first, then each
   * stage, the open one marked. An empty list says where a stage comes from rather than nothing.
   */
  setStages(levels: { id: string; world: string; name?: string | null }[], current: string | null) {
    const s = this.stagesSection
    if (!s) return
    for (const c of [...s.children]) if (c.tagName !== 'H3') c.remove()
    const mark = (b: HTMLButtonElement, on: boolean) => { b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'true') }
    if (current) mark(this.drawer.item(s, { id: 'stage-free', label: 'Free roam', icon: 'map', hint: 'leave the stage', onClick: () => this.o.onOpenLevel(null) }), false)
    for (const l of levels) {
      mark(this.drawer.item(s, { id: `stage-${l.id}`, label: l.name || l.id, icon: 'flag', hint: l.name ? l.id : 'stage', onClick: () => this.o.onOpenLevel(l.id) }), l.id === current)
    }
    if (!levels.length) s.append(el('div', 'drawer-note', 'No stages set in this world yet — the world editor’s Stage panel makes one.'))
  }

  // ---- drawer ------------------------------------------------------------------------------
  private buildDrawer() {
    const nav = this.drawer.section('')
    this.drawer.item(nav, { id: 'settings', label: 'Settings', icon: 'cog-6-tooth', hint: 'layers, display, site, controls', onClick: () => this.settings.open() })
    this.drawer.item(nav, { id: 'tune', label: 'Tuning', icon: 'adjustments-horizontal', hint: 'live knobs over the world', key: 'F6', onClick: () => this.o.onTune() })
    this.drawer.item(nav, { id: 'editor', label: 'Editor', icon: 'pencil-square', hint: 'areas, placements, structures', onClick: () => (location.href = '/editor.html') })

    // the stages set in this world; filled by `setStages` once the site (and its levels) are known
    this.stagesSection = this.drawer.section('Stages')
    this.setStages([], null)

    const view = this.drawer.section('View')
    this.drawer.item(view, { id: 'photo', label: 'Go to the photo', icon: 'camera', key: 'P', onClick: () => this.o.onPhoto() })
    this.drawer.item(view, { id: 'top', label: 'Top down', icon: 'map', key: 'H', onClick: () => this.o.onTop() })
    this.drawer.item(view, { id: 'stance', label: 'Copy a link to this view', icon: 'link', key: 'X', onClick: () => this.o.onStance() })

    const look = this.drawer.section('Appearance')
    this.drawer.custom(
      look,
      select({
        label: 'Theme',
        value: (localStorage.getItem('corridor.theme') as 'dark' | 'light') ?? 'dark',
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
        onChange: (v) => setTheme(v),
      }),
    )
  }

  // ---- settings tabs -----------------------------------------------------------------------
  /**
   * The address box.
   *
   * Nothing is searched until a site hands over a `find` (see `setSearch`), because the index is
   * built from the site's own OSM extract and there is nothing to look in before one is loaded.
   * Keyboard first: typing filters, up and down move, Enter goes, Escape closes — and the box
   * refuses to eat the driving keys, which is the whole reason it is an input and not a dialog.
   */
  private buildSearch() {
    const i = this.searchInput
    i.type = 'search'
    i.className = 'search-input'
    i.placeholder = 'address, place or road'
    i.autocomplete = 'off'
    i.spellcheck = false
    i.disabled = true
    const close = () => {
      this.searchList.hidden = true
      this.searchSel = -1
    }
    const draw = () => {
      this.searchList.replaceChildren()
      if (!this.searchHits.length) {
        close()
        return
      }
      this.searchHits.forEach((h, n) => {
        const row = el('button', `search-row${n === this.searchSel ? ' on' : ''}`)
        row.append(el('span', 'search-row-label', h.label), el('span', 'search-row-detail', h.detail))
        row.addEventListener('mousedown', (e) => {
          // mousedown, not click: `blur` closes the list and a click would land on nothing
          e.preventDefault()
          this.pickSearch(n)
        })
        this.searchList.append(row)
      })
      this.searchList.hidden = false
    }
    i.addEventListener('input', () => {
      this.searchHits = this.searchFind ? this.searchFind(i.value) : []
      this.searchSel = this.searchHits.length ? 0 : -1
      draw()
    })
    i.addEventListener('keydown', (e) => {
      // the viewer listens for single keys on the window; while this box has focus they are text
      e.stopPropagation()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!this.searchHits.length) return
        this.searchSel = (this.searchSel + (e.key === 'ArrowDown' ? 1 : this.searchHits.length - 1)) % this.searchHits.length
        draw()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (this.searchSel >= 0) this.pickSearch(this.searchSel)
      } else if (e.key === 'Escape') {
        i.value = ''
        this.searchHits = []
        close()
        i.blur()
      }
    })
    i.addEventListener('blur', () => setTimeout(close, 120))
    i.addEventListener('focus', () => {
      if (this.searchHits.length) draw()
    })
    this.searchList.hidden = true
    this.search.append(i, this.searchList)
  }

  private pickSearch(n: number) {
    const h = this.searchHits[n]
    if (!h) return
    this.searchInput.value = h.label
    this.searchList.hidden = true
    this.searchInput.blur()
    this.o.onGoto(h)
  }

  /** a site is loaded: this is how to search it (null while none is) */
  setSearch(find: ((q: string) => { label: string; detail: string; x: number; z: number; kind: string }[]) | null, note = '') {
    this.searchFind = find
    this.searchInput.disabled = !find
    this.searchInput.placeholder = find ? note || 'address, place or road' : 'address, place or road'
    this.searchInput.value = ''
    this.searchHits = []
    this.searchList.hidden = true
  }

  private buildLayers(host: HTMLElement) {
    for (const g of LAYER_GROUPS) {
      const layers = g.layers.filter((l) => this.allow(`layers.${l.id}`))
      if (!layers.length) continue
      const sec = group(g.title)
      const body = bodyOf(sec)
      body.classList.add('layer-list')
      for (const l of layers) {
        body.append(
          layerToggle({
            label: l.label,
            value: this.layerState[l.id],
            onChange: (v) => {
              this.layerState[l.id] = v
              this.o.onLayers({ ...this.layerState })
            },
          }),
        )
      }
      host.append(sec)
    }
  }

  private buildDisplay(host: HTMLElement) {
    // each row asks the policy: a program may take any one of these away (gamepolicy.ts)
    const only = (id: string, make: () => HTMLElement): HTMLElement[] => (this.allow(id) ? [make()] : [])
    const conditions = [
      ...only('display.season', () => select<Season>({
        label: 'Season',
        value: 'summer',
        options: SEASONS.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
        onChange: (v) => this.o.onSeason(v),
      })),
      ...only('display.style', () => select<Style>({
        label: 'Style',
        value: (new URLSearchParams(location.search).get('style') as Style) || 'realistic',
        options: STYLES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
        onChange: (v) => this.o.onStyle(v),
      })),
      ...only('display.relief', () => (this.reliefSel = select<string>({
        label: 'Relief',
        value: String(clampReliefParam()),
        options: RELIEFS.map((k) => ({ value: String(k), label: k === 1 ? '1× as measured' : `${k}× hills` })),
        onChange: (v) => this.o.onRelief(Number(v)),
      }))),
      ...only('display.trees', () => select<TreeStyle>({
        label: 'Trees',
        value: 'realistic',
        options: [
          { value: 'realistic', label: 'Realistic — models, cards beyond' },
          { value: 'cards', label: 'Basic — impostor cards only' },
          { value: 'lollipop', label: 'Lollipops — the editor’s trees' },
        ],
        onChange: (v) => this.o.onTrees(v),
      })),
      ...only('display.weather', () => select<Weather>({
        label: 'Weather',
        value: WEATHERS[0],
        options: WEATHERS.map((w) => ({ value: w, label: w[0].toUpperCase() + w.slice(1) })),
        onChange: (v) => this.o.onWeather(v),
      })),
    ]
    if (conditions.length) {
      const g = group('Conditions')
      bodyOf(g).append(...conditions)
      host.append(g)
    }

    // Rendering, not tuning: MSAA is a WebGL context attribute, so unlike a tuning knob
    // it cannot be nudged while you watch it. The reasoning lives in render.ts; the panel
    // just says what is on.
    /*
     * THE PERFORMANCE PANEL. Rich, 2026-09-29: *"Can we add a setting to show a performance stats
     * display that includes FPS, memory, p95/p99 info, cpu time, etc.?"* Here rather than in the
     * tuning panel because it is a thing you SWITCH ON while you play, not a knob you sweep; and
     * remembered, because the person who wants it wants it every time.
     */
    if (this.allow('display.perf')) {
      const p = group('Performance')
      bodyOf(p).append(
        toggle({
          label: 'Show the stats panel',
          value: perfWanted(),
          note: 'frame rate, p95 and p99, the worst frame, stalls, draw calls and heap — F7',
          onChange: (v) => {
            try { localStorage.setItem(PERF_KEY, v ? '1' : '0') } catch { /* private window */ }
            this.o.onPerf?.(v)
          },
        }),
      )
      host.append(p)
    }

    if (this.allow('display.aa')) {
      const slug = this.manifest?.slug ?? ''
      const r = group('Rendering')
      const now = readout('Now', AA_LABEL[resolvedAA(slug)])
      bodyOf(r).append(
        select<AAMode>({
          label: 'Anti-aliasing',
          value: aaMode(),
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'msaa', label: 'MSAA' },
            { value: 'fxaa', label: 'FXAA' },
            { value: 'smaa', label: 'SMAA' },
            { value: 'off', label: 'Off' },
          ],
          onChange: (v) => {
            setAAMode(v)
            this.o.onAAChange?.(v)
            now.querySelector('.field-value')!.textContent = AA_LABEL[resolvedAA(slug)]
          },
        }),
        now,
      )
      host.append(r)
    }

    const iface = [
      // GAME OR DEVELOPER. The game's interface is the deployment default; this is the way back
      // to it from the developer view, and the Escape menu is the way back from the game.
      ...(this.o.uiMode && this.o.uiMode.offered() && this.allow('game.developer')
        ? [select<UiMode>({
            label: 'Interface',
            value: this.o.uiMode.get(),
            options: [
              { value: 'dev', label: 'Developer — the bar, the picker, the readout' },
              { value: 'game', label: 'Game — the HUD and the Escape menu' },
            ],
            note: 'the game hides this bar; Esc opens its menu, where Developer view brings it back',
            onChange: (v) => this.o.uiMode!.set(v),
          })]
        : []),
      ...(this.o.settings && this.allow('display.units')
        ? [select<'mph' | 'kmh'>({
            label: 'Units',
            value: this.o.settings.data.units,
            options: [
              { value: 'mph', label: 'mph, feet' },
              { value: 'kmh', label: 'km/h, metres' },
            ],
            onChange: (v) => this.o.settings!.update((d) => (d.units = v)),
          })]
        : []),
      ...only('display.theme', () => select({
        label: 'Theme',
        value: (localStorage.getItem('corridor.theme') as 'dark' | 'light') ?? 'dark',
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
        onChange: (v) => setTheme(v as 'dark' | 'light'),
      })),
      ...only('display.interface', () => toggle({
        label: 'Hide the interface',
        value: document.body.classList.contains('chrome-off'),
        note: 'M — everything but the canvas',
        onChange: (v) => document.body.classList.toggle('chrome-off', v),
      })),
    ]
    if (iface.length) {
      const t = group('Interface')
      bodyOf(t).append(...iface)
      host.append(t)
    }
    if (!host.childElementCount) host.append(empty('This level has switched the display settings off.'))
  }

  /**
   * AUDIO. Rich, 2026-09-30: "we badly need audio settings and the ability to mute the game from
   * the game menu as well as the settings menu." The same four fields the Escape menu's Audio
   * screen edits, on the same store; one moves and the other shows it next time it is opened.
   */
  private buildAudio(host: HTMLElement) {
    const st = this.o.settings
    if (!st) {
      host.append(empty('No settings store on this page.'))
      return
    }
    const a = () => st.data.audio
    const set = (fn: (x: ReturnType<typeof a>) => void) => { st.update((d) => fn(d.audio)); this.o.onAudio?.() }
    const vol = (id: string, label: string, get: () => number, put: (v: number) => void, note?: string): HTMLElement[] =>
      this.allow(id) ? [slider({ label, value: get(), min: 0, max: 1, step: 0.05, unit: '%', note, onInput: (v) => set(() => put(v)) })] : []
    const rows = [
      ...(this.allow('audio.mute') ? [toggle({ label: 'Mute', value: a().muted, note: 'silence, whatever the sliders say — the tab going to the background mutes on its own', onChange: (v) => set((x) => (x.muted = v)) })] : []),
      ...vol('audio.master', 'Master', () => a().master, (v) => (a().master = v)),
      ...vol('audio.engine', 'Engine', () => a().engine, (v) => (a().engine = v), 'over the ENGINE_MASTER knob in the tuning panel'),
      ...vol('audio.sfx', 'Interface', () => a().sfx, (v) => (a().sfx = v), 'the menu blips'),
    ]
    if (!rows.length) {
      host.append(empty('This level has switched the audio settings off.'))
      return
    }
    const g = group('Volume')
    bodyOf(g).append(...rows)
    host.append(g)
  }

  private buildSite(host: HTMLElement) {
    const m = this.manifest
    if (!m) {
      host.append(empty('No site loaded yet.'))
      return
    }
    const ident = m.ident ? Object.values(m.ident)[0] : '(unnamed)'
    const lidar = m.lidar.points_in_corridor ? `${m.lidar.dataset}, ${(m.lidar.points_in_corridor / 1e6).toFixed(1)} M points` : 'none'
    const byRel = m.crossings.reduce<Record<string, number>>((a, c) => ((a[c.relation] = (a[c.relation] ?? 0) + 1), a), {})

    const measured = group('Measured')
    bodyOf(measured).append(
      readout('Road', ident, false),
      readout('Spine', `${(m.spine.length_m / 1000).toFixed(2)} km`),
      readout('Photo at', `${m.spine.photo_s.toFixed(0)} m`),
      ...frameReadouts(m),
      readout('Lidar', lidar, false),
      readout('Crossings', Object.entries(byRel).map(([k, v]) => `${v} ${k}`).join(', ') || 'none', false),
      readout('Surface', m.surface ? Object.entries(m.surface.summary).map(([k, v]) => `${k} ${(v * m.surface!.step_m / 1000).toFixed(1)} km`).join(', ') : 'not measured', false),
      ...Object.entries(this.extra).map(([k, v]) => readout(k, v, false)),
    )
    host.append(measured)

    const st = group(`Structures (${m.structures.length})`, { collapsed: m.structures.length > 8 })
    const stBody = bodyOf(st)
    if (!m.structures.length) stBody.append(empty('None along this corridor.'))
    for (const [i, s] of m.structures.entries()) {
      const row = el('button', 'struct-row')
      row.append(icon('rectangle-group', 14), el('span', 'struct-kind', s.kind), el('span', 'struct-desc', this.describe?.(s) ?? ''))
      row.onclick = () => this.o.onStructure(i)
      stBody.append(row)
    }
    host.append(st)

    const geo = group('Geology', { collapsed: true })
    const gBody = bodyOf(geo)
    if (!m.geology.units.length) gBody.append(empty('No named formations.'))
    for (const u of m.geology.units) {
      const p = el('div', 'geo-unit')
      p.append(el('b', '', u.strat_name || '(unnamed)'))
      const bits = [u.lith, u.b_age ? `${u.b_age}–${u.t_age} Ma` : ''].filter(Boolean).join(' · ')
      if (bits) p.append(el('span', 'geo-meta', bits))
      if (u.descrip) p.append(el('p', 'geo-desc', u.descrip))
      gBody.append(p)
    }
    host.append(geo)

    if (m.photos.length) {
      const ph = group(`Photos (${m.photos.length})`, { collapsed: true })
      const strip = el('div', 'photo-strip')
      for (const p of m.photos) {
        const a = el('a', 'photo')
        a.href = `/photos/${p.file}`
        a.target = '_blank'
        const img = el('img')
        img.src = `/photos/${p.file}`
        img.loading = 'lazy'
        img.title = `${p.file} heading ${p.heading_deg ?? '?'}°`
        a.append(img)
        strip.append(a)
      }
      bodyOf(ph).append(strip)
      host.append(ph)
    }
  }

  private buildControls(host: HTMLElement) {
    let pref: string | null = null
    try { pref = localStorage.getItem('corridor.recoverRepairs') } catch { /* no storage */ }
    if (this.allow('controls.recover')) {
      host.append(
        select({
          label: 'R also repairs the car',
          value: (pref === 'on' || pref === 'off' ? pref : 'level') as 'level' | 'on' | 'off',
          options: [
            { value: 'level', label: 'the level decides' },
            { value: 'on', label: 'always' },
            { value: 'off', label: 'never' },
          ],
          note: 'recover straightens the dents out, unless the game wants you to carry them',
          onChange: (v) => { try { localStorage.setItem('corridor.recoverRepairs', v) } catch { /* no storage */ } },
        }),
      )
    }
    const st = this.o.settings
    if (st) {
      const pad = [
        ...(this.allow('controls.gamepad') ? [toggle({ label: 'Gamepad', value: st.data.gamepad, note: 'the first connected pad: triggers are the pedals, the left stick steers, Start pauses', onChange: (v) => { st.update((d) => (d.gamepad = v)); this.o.onBindings?.() } })] : []),
        ...(this.allow('controls.haptics') ? [slider({ label: 'Rumble', value: st.data.haptics, min: 0, max: 1, step: 0.1, unit: '%', note: 'bumps, grass and impacts, on a pad that can', onInput: (v) => { st.update((d) => (d.haptics = v)); this.o.onBindings?.() } })] : []),
      ]
      if (pad.length) {
        const g = group('Gamepad')
        bodyOf(g).append(...pad)
        host.append(g)
      }
      if (this.allow('controls.bindings')) {
        // THE BINDINGS, live from the settings — not a table typed here that goes stale the first
        // time somebody rebinds a key. Rebinding itself happens in the Escape menu, which has the
        // capture (tap to set, hold to add) and is where a player will look for it.
        const g = group('Bindings', {
          actions: this.o.onRebind ? [button({ label: 'Rebind…', icon: 'adjustments-horizontal', onClick: () => this.o.onRebind!() })] : [],
        })
        const body = bodyOf(g)
        body.classList.add('keys')
        for (const a of ACTIONS) {
          const row = el('div', 'key-row')
          const ks = el('span', 'key-keys')
          const keys = (st.data.keys[a] ?? []).map(keyLabel)
          const pads = (st.data.pad[a] ?? []).map(padBindingLabel)
          for (const part of keys) ks.append(el('kbd', '', part))
          for (const part of pads) ks.append(el('kbd', 'pad', part))
          if (!keys.length && !pads.length) ks.append(el('span', 'key-none', '—'))
          row.append(ks, el('span', 'key-what', ACTION_LABELS[a]))
          body.append(row)
        }
        host.append(g)
      }
    }
    for (const k of KEYS) {
      const g = group(k.group)
      const body = bodyOf(g)
      body.classList.add('keys')
      for (const [keys, what] of k.rows) {
        const row = el('div', 'key-row')
        const ks = el('span', 'key-keys')
        for (const part of keys.split(' ')) ks.append(el('kbd', '', part))
        row.append(ks, el('span', 'key-what', what))
        body.append(row)
      }
      host.append(g)
    }
  }

  /** scene.ts's `describe`, injected so this file does not import the scene. */
  describe: ((s: unknown) => string) | null = null

  // ---- public handles ----------------------------------------------------------------------

  setSites(sites: IndexEntry[], current: string) {
    this.sites = sites
    this.current = current
    this.renderSitePicker()
    const sec = this.drawer.section('Sites')
    for (const s of sites) {
      const ident = s.ident ? Object.values(s.ident)[0] : '?'
      this.drawer.item(sec, {
        id: s.slug,
        label: s.slug,
        icon: 'map-pin',
        hint: `${ident} · ${(s.length_m / 1000).toFixed(1)} km · ${s.structures} structures`,
        onClick: () => this.o.onSite(s.slug),
      })
    }
  }

  private renderSitePicker() {
    const s = this.sites.find((x) => x.slug === this.current)
    this.siteSel.replaceChildren()
    const b = el('button', 'site-button')
    b.append(el('span', 'site-name', this.current || 'loading…'))
    if (s) {
      const ident = s.ident ? Object.values(s.ident)[0] : ''
      b.append(el('span', 'site-meta', `${ident} · ${(s.length_m / 1000).toFixed(1)} km`))
    }
    b.append(icon('chevron-down', 14))
    b.onclick = () => this.drawer.set(true)
    this.siteSel.append(b)
  }

  setSite(slug: string) {
    this.current = slug
    this.renderSitePicker()
  }

  setManifest(m: Manifest, extra: Record<string, string> = {}) {
    this.manifest = m
    this.extra = extra
    this.settingsTabs.invalidate('site')
  }

  layers(): Record<string, boolean> {
    return { ...this.layerState }
  }

  /** A stance restore sets layers from a URL; reflect that in the toggles. */
  setLayers(next: Record<string, boolean>) {
    for (const [k, v] of Object.entries(next)) if (k in this.layerState) this.layerState[k] = v
    this.settingsTabs.invalidate('layers')
  }

  setDriveMode(on: boolean) {
    this.driveBtn.replaceChildren(icon(on ? 'globe-alt' : 'play', 16), el('span', 'btn-label', on ? 'Fly' : 'Drive'))
    this.driveBtn.title = on ? 'leave the car (Tab)' : 'get in the car (Tab)'
    document.body.classList.toggle('driving', on)
  }

  setPos(text: string) {
    this.posEl.textContent = text
  }
}

const PERF_KEY = 'corridor.perf'

/** Was the performance panel left on? Read at start-up and by the settings tab. */
export function perfWanted(): boolean {
  try {
    return localStorage.getItem(PERF_KEY) === '1'
  } catch {
    return false
  }
}

/** Remember it, for the key that toggles it as well as for the switch. */
export function setPerfWanted(on: boolean): void {
  try {
    localStorage.setItem(PERF_KEY, on ? '1' : '0')
  } catch { /* private window */ }
}

/** Dark or light, remembered. Called from the drawer, the settings tab, and once at start-up. */
export function setTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem('corridor.theme', theme)
  } catch {
    /* ignore */
  }
}

export function restoreTheme() {
  const t = (localStorage.getItem('corridor.theme') as 'dark' | 'light' | null) ?? 'dark'
  setTheme(t)
}
