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
import { Dialog, Drawer, Tabs, button, el, type Tab } from './shell'
import { icon } from './icons'
import { empty, group, bodyOf, layerToggle, readout, select, toggle } from './controls'
import type { IndexEntry, Manifest } from '../site'
import { SEASONS, type Season } from '../season'
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
      { id: 'canopy', label: 'Canopy blanket', on: false },
    ],
  },
  {
    title: 'Nature',
    layers: [
      { id: 'trees', label: 'Trees', on: true },
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
  const rows = [readout('Frame', kind, false), readout('Bake EPSG', String(f.epsg))]
  if (f.anchor) rows.push(readout('Anchor', `${f.anchor.lat.toFixed(6)}, ${f.anchor.lon.toFixed(6)}`))
  if (typeof f.utm_convergence_deg === 'number') {
    rows.push(readout('Convergence', `${f.utm_convergence_deg.toFixed(4)}° grid→true`))
  }
  return rows
}

/** Keyboard reference, shown in Settings → Controls instead of as six lines of footer text. */
const KEYS: { group: string; rows: [string, string][] }[] = [
  {
    group: 'Fly',
    rows: [
      ['W A S D', 'move'],
      ['Q E', 'turn'],
      ['R F', 'zoom'],
      ['T G', 'up / down'],
      ['Shift', 'faster'],
      ['drag', 'orbit · right-drag looks'],
    ],
  },
  {
    group: 'Drive',
    rows: [
      ['Tab', 'enter / leave the car'],
      ['W S', 'throttle / brake'],
      ['A D', 'steer'],
      ['Space', 'handbrake'],
      ['R', 'reset the car'],
      ['drag', 'look around'],
    ],
  },
  {
    group: 'View',
    rows: [
      ['P', 'to the photo'],
      ['H', 'top down'],
      ['X', 'copy a link to this exact view'],
      ['F6', 'tuning'],
      ['M', 'hide the interface'],
      ['Esc', 'close what is open'],
    ],
  },
]

export interface ViewerUIOpts {
  onSite: (slug: string) => void
  onSeason: (s: Season) => void
  onWeather: (w: Weather) => void
  onLayers: (layers: Record<string, boolean>) => void
  onDrive: () => void
  onPhoto: () => void
  onTop: () => void
  onStance: () => void
  onTune: () => void
  onStructure: (index: number) => void
}

export class ViewerUI {
  bar = el('header', 'topbar')
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
      el('div', 'topbar-spacer'),
      this.posEl,
      this.driveBtn,
      button({ icon: 'camera', title: 'to the photo', key: 'P', onClick: () => this.o.onPhoto() }),
      button({ icon: 'map', title: 'top down', key: 'H', onClick: () => this.o.onTop() }),
      button({ icon: 'link', title: 'copy a link to this view', key: 'X', onClick: () => this.o.onStance() }),
      button({ icon: 'adjustments-horizontal', title: 'tuning', key: 'F6', onClick: () => this.o.onTune() }),
      button({ icon: 'cog-6-tooth', title: 'settings', onClick: () => this.settings.open() }),
    )
    document.body.append(this.bar)

    // ---- settings dialog
    const tabs: Tab[] = [
      { id: 'layers', label: 'Layers', icon: 'squares-2x2', build: (h) => this.buildLayers(h) },
      { id: 'display', label: 'Display', icon: 'swatch', build: (h) => this.buildDisplay(h) },
      { id: 'site', label: 'Site', icon: 'map-pin', build: (h) => this.buildSite(h) },
      { id: 'controls', label: 'Controls', icon: 'information-circle', build: (h) => this.buildControls(h) },
    ]
    this.settingsTabs = new Tabs(tabs)
    this.settings = new Dialog({ title: 'Settings', icon: 'cog-6-tooth', size: 'md' })
    this.settings.body.append(this.settingsTabs.root)

    this.buildDrawer()
  }

  // ---- drawer ------------------------------------------------------------------------------
  private buildDrawer() {
    const nav = this.drawer.section('')
    this.drawer.item(nav, { id: 'settings', label: 'Settings', icon: 'cog-6-tooth', hint: 'layers, display, site, controls', onClick: () => this.settings.open() })
    this.drawer.item(nav, { id: 'tune', label: 'Tuning', icon: 'adjustments-horizontal', hint: 'live knobs over the world', key: 'F6', onClick: () => this.o.onTune() })
    this.drawer.item(nav, { id: 'editor', label: 'Editor', icon: 'pencil-square', hint: 'areas, placements, structures', onClick: () => (location.href = '/editor.html') })

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
  private buildLayers(host: HTMLElement) {
    for (const g of LAYER_GROUPS) {
      const sec = group(g.title)
      const body = bodyOf(sec)
      body.classList.add('layer-list')
      for (const l of g.layers) {
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
    const g = group('Conditions')
    const body = bodyOf(g)
    body.append(
      select<Season>({
        label: 'Season',
        value: 'summer',
        options: SEASONS.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
        onChange: (v) => this.o.onSeason(v),
      }),
      select<Weather>({
        label: 'Weather',
        value: WEATHERS[0],
        options: WEATHERS.map((w) => ({ value: w, label: w[0].toUpperCase() + w.slice(1) })),
        onChange: (v) => this.o.onWeather(v),
      }),
    )
    host.append(g)

    const t = group('Interface')
    bodyOf(t).append(
      select({
        label: 'Theme',
        value: (localStorage.getItem('corridor.theme') as 'dark' | 'light') ?? 'dark',
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
        onChange: (v) => setTheme(v as 'dark' | 'light'),
      }),
      toggle({
        label: 'Hide the interface',
        value: document.body.classList.contains('chrome-off'),
        note: 'M — everything but the canvas',
        onChange: (v) => document.body.classList.toggle('chrome-off', v),
      }),
    )
    host.append(t)
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
