// Settings → OSM data: where the roads come from, and getting more of them.
//
// Rich, 2026-10-10: "How do we fetch the OSM data? Can we add a facility to the world editor, maybe
// a dialogue spawned from the settings menu, where we can see OSM coverage and select and download
// more source OSM data?" — and, of standing up a new Overpass per region: "Why new instances, why
// can't we add the data to existing instances? We could have a job viewer kind of deal like we have
// for bakes."
//
// THE QUESTION THIS ANSWERS FIRST is the one nobody could answer on 2026-10-10: which instance
// does this world's OSM come from, and does that instance actually hold it? dc-metro-take-2 was
// routed by a box to a Maryland extract and baked without Washington or Virginia, and nothing on
// any screen said so. Here every instance's coverage is drawn from its extract's own polygon, every
// world is filled with the colour of the instance that serves it, and a world no instance holds is
// red. While an old `#s/w/n/e` fence is still on a URL, the ground the fence would have baked as
// empty is filled red too (coveragemap.ts).
//
// ADDING A REGION is a run like a bake — `osm-import` — so its log is in the same viewer, it
// survives a reload, and it can be cancelled (tools/worldeditor/runs.mjs).

import { Dialog, button, confirm, el, toast } from '../../ui/shell'
import { bodyOf, empty, group, select } from '../../ui/controls'
import { icon } from '../../ui/icons'
import { api, type CoverageUpstream, type CoverageWorld, type Run, type UpstreamHealth } from './api'
import { CoverageMap } from './coveragemap'
import { buildRegionTree, fmtAge, fmtBytes, regionLabel, searchRegions, upstreamColour, worldVerdict, type GeofabrikRegion, type RegionNode } from './osmregions'
import type { LogView } from './runs'

let dialog: Dialog | null = null
let state: OsmData | null = null

/** Open the dialog (one per page), reading everything fresh. */
export function openOsmData(logs: LogView): void {
  if (!dialog) {
    dialog = new Dialog({ title: 'OSM data', icon: 'globe-alt', size: 'xl', movable: true, onClose: () => state?.stop() })
    state = new OsmData(dialog, logs)
  }
  dialog.open()
  void state!.load()
}

class OsmData {
  private map: CoverageMap
  private side = el('div', 'osm-side')
  private legend = el('div', 'osm-legend')
  private upstreams: CoverageUpstream[] = []
  private worlds: CoverageWorld[] = []
  private health = new Map<string, UpstreamHealth>()
  private regions: GeofabrikRegion[] = []
  private regionSource = ''
  private picked: { id: string; label: string; bytes: number | null; held: string[]; touches: { name: string; outside: number }[] } | null = null
  /** the search box's text, which outlives a re-render */
  private query = ''
  private target = ''
  private imports: Run[] = []
  private timer = 0
  private problems: string[] = []
  private dialog: Dialog
  private logs: LogView

  constructor(dialog: Dialog, logs: LogView) {
    this.dialog = dialog
    this.logs = logs
    const wrap = el('div', 'osm-data')
    const mapBox = el('div', 'osm-map')
    const canvas = el('canvas')
    mapBox.append(canvas, this.legend)
    wrap.append(mapBox, this.side)
    dialog.body.append(wrap)
    dialog.body.classList.add('osm-data-body')
    this.map = new CoverageMap(canvas)
    // the probes read the map and the state from here
    ;(window as unknown as { __osmData?: unknown }).__osmData = this
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = 0
  }

  async load() {
    this.side.replaceChildren(el('p', 'dim', 'reading coverage…'))
    try {
      const [cov, borders] = await Promise.all([api.osmCoverage(), api.borders().catch(() => ({ features: [] }))])
      this.upstreams = cov.upstreams
      this.worlds = cov.worlds
      this.problems = cov.problems
      this.map.borders = borders.features
      this.map.upstreams = this.upstreams
      this.map.worlds = this.worlds
      const placed = this.worlds.filter((w) => w.placed && w.box)
      if (placed.length) {
        this.map.fit({
          south: Math.min(...placed.map((w) => w.box!.south)),
          west: Math.min(...placed.map((w) => w.box!.west)),
          north: Math.max(...placed.map((w) => w.box!.north)),
          east: Math.max(...placed.map((w) => w.box!.east)),
        })
      } else this.map.draw()
      this.target ||= this.upstreams.find((u) => u.claims === 'regions')?.name ?? ''
    } catch (e) {
      this.side.replaceChildren(el('p', 'panel-hint', `Coverage did not load — ${(e as Error).message}`))
      return
    }
    this.render()
    // health is the slow part (one request per instance, ten seconds each at worst); draw first
    void api.osmUpstreams().then((h) => {
      for (const u of h.upstreams) this.health.set(u.name, u)
      this.render()
    }).catch(() => {})
    void api.geofabrik().then((g) => {
      this.regions = g.regions
      this.regionSource = g.source
      this.render()
    }).catch((e) => toast(`Geofabrik catalogue: ${(e as Error).message}`, 'warn'))
    void this.pollImports()
  }

  /** Imports in flight are polled while the dialog is open; a finished one re-reads coverage. */
  private async pollImports() {
    clearTimeout(this.timer)
    const was = new Set(this.imports.filter((r) => r.state !== 'done' && r.state !== 'failed').map((r) => r.id))
    try {
      this.imports = (await api.runs()).runs.filter((r) => r.kind === 'osm-import')
    } catch {
      /* the list stays as it was */
    }
    const live = this.imports.filter((r) => r.state !== 'done' && r.state !== 'failed')
    if ([...was].some((id) => !live.some((r) => r.id === id))) {
      const cov = await api.osmCoverage().catch(() => null)
      if (cov) {
        this.upstreams = cov.upstreams
        this.worlds = cov.worlds
        this.map.upstreams = cov.upstreams
        this.map.worlds = cov.worlds
        this.map.draw()
      }
    }
    this.render()
    if (this.dialog.root.isConnected) this.timer = window.setTimeout(() => void this.pollImports(), live.length ? 5000 : 30000)
  }

  private render() {
    const keepScroll = this.side.scrollTop
    this.side.replaceChildren()
    this.renderLegend()
    if (this.problems.length) {
      const g = group('Coverage problems', { collapsed: false })
      for (const p of this.problems) bodyOf(g).append(warn(p))
      this.side.append(g)
    }
    this.side.append(this.instances(), this.worldList(), this.picker(), this.importList())
    this.side.scrollTop = keepScroll
  }

  private renderLegend() {
    this.legend.replaceChildren()
    this.upstreams.forEach((u, i) => {
      const b = el('button', `osm-key${this.map.hidden.has(u.name) ? ' off' : ''}`)
      b.type = 'button'
      const sw = el('span', 'osm-swatch')
      sw.style.background = upstreamColour(i)
      b.append(sw, el('span', '', u.name))
      b.title = 'show or hide this instance\'s coverage'
      b.onclick = () => {
        if (this.map.hidden.has(u.name)) this.map.hidden.delete(u.name)
        else this.map.hidden.add(u.name)
        this.map.draw()
        this.renderLegend()
      }
      this.legend.append(b)
    })
    const red = el('span', 'osm-key static')
    const sw = el('span', 'osm-swatch danger')
    red.append(sw, el('span', '', 'not held by one instance'))
    this.legend.append(red)
  }

  private instances(): HTMLElement {
    const g = group('Overpass instances', { collapsed: false, note: 'Where each one\'s OSM comes from, whether it answers, and how fresh it is.' })
    const b = bodyOf(g)
    if (!this.upstreams.length) b.append(empty('No Overpass configured — every bake uses the public mirrors.'))
    this.upstreams.forEach((u, i) => {
      const h = this.health.get(u.name)
      const card = el('div', 'osm-up')
      const head = el('div', 'osm-up-head')
      const sw = el('span', 'osm-swatch')
      sw.style.background = upstreamColour(i)
      head.append(sw, el('span', 'osm-up-name', u.name))
      head.append(h ? chip(h.ok ? 'ok' : 'danger', h.ok ? `answers · ${h.ms} ms` : 'DOWN') : chip('info', 'asking…'))
      card.append(head, el('div', 'mono dim osm-url', u.url))
      if (h) {
        card.append(line('data', h.timestamp ? `${fmtAge(h.ageHours)} · ${h.timestamp}` : 'no replication timestamp'))
        if (!h.ok) card.append(warn(h.status || 'no answer'))
      }
      if (u.claims === 'everywhere') card.append(warn('No regions named: routed as if it held the whole planet. If it is regional, name its region under Settings → Services → Overpass regions.'))
      if (u.claims === 'nothing') card.append(warn('Its region could not be outlined, so nothing is routed to it.'))
      const regs = el('div', 'osm-regions')
      for (const r of u.regions) {
        const c = el('span', `osm-region src-${r.source}`, regionLabel(r))
        c.title = `${r.id} · ${r.source === 'deploy' ? 'from the deployment' : r.source === 'import' ? `imported${r.added ? ` ${r.added.slice(0, 10)}` : ''}` : 'a box on the URL — not a real outline'}${r.updates ? `\nfollows ${r.updates}` : ''}`
        regs.append(c)
      }
      card.append(regs)
      // the diff streams: the instance's updater follows the one it was built from; the regions
      // sidecar follows every imported one (tools/overpass/README.md)
      const streams = u.regions.filter((r) => r.updates)
      if (streams.length) card.append(line('diffs', streams.map((r) => r.updates!.replace(/^https:\/\/download\.geofabrik\.de\//, '')).join(', ')))
      b.append(card)
    })
    return g
  }

  private worldList(): HTMLElement {
    const bad = this.worlds.filter((w) => worldVerdict(w).kind !== 'ok').length
    const g = group(`Worlds${bad ? ` — ${bad} not held by one instance` : ''}`, { collapsed: false, note: 'Which instance each world\'s bake reads. Click one to find it on the map.' })
    const b = bodyOf(g)
    if (!this.worlds.length) b.append(empty('No worlds yet'))
    for (const w of this.worlds) {
      const v = worldVerdict(w)
      const row = el('button', `osm-world ${v.kind}`)
      row.type = 'button'
      const ui = w.upstream ? this.upstreams.findIndex((u) => u.name === w.upstream) : -1
      const sw = el('span', `osm-swatch${v.kind === 'ok' ? '' : ' danger'}`)
      if (ui >= 0 && v.kind === 'ok') sw.style.background = upstreamColour(ui)
      row.append(sw, el('span', 'osm-world-slug mono', w.slug), el('span', 'osm-world-why', v.text))
      row.onclick = () => { if (w.box) this.map.fit(w.box) }
      b.append(row)
    }
    return g
  }

  private picker(): HTMLElement {
    const g = group('Add a region to an instance', {
      collapsed: false,
      note: 'Geofabrik\'s extracts. The instance keeps answering while it is added, and follows the region\'s own daily diffs afterwards.',
    })
    const b = bodyOf(g)
    if (!this.regions.length) {
      b.append(el('p', 'dim', 'reading the Geofabrik catalogue…'))
      return g
    }
    const input = el('input', 'osm-search')
    input.type = 'search'
    input.placeholder = 'search: virginia, italy, ontario…'
    input.value = this.query
    const results = el('div', 'osm-results')
    const tree = el('div', 'osm-tree')
    const showResults = () => {
      this.query = input.value
      results.replaceChildren()
      const hits = searchRegions(this.regions, input.value)
      tree.hidden = hits.length > 0
      for (const r of hits) results.append(this.regionRow(r))
    }
    input.oninput = showResults
    for (const n of buildRegionTree(this.regions)) tree.append(this.treeNode(n))
    showResults()
    b.append(input, results, tree, el('p', 'dim osm-source', `catalogue: ${this.regionSource}`))

    if (this.picked) {
      const sel = el('div', 'osm-picked')
      sel.append(el('div', 'osm-picked-name', this.picked.label), el('div', 'mono dim', `${this.picked.id} · ${this.picked.bytes == null ? 'size…' : fmtBytes(this.picked.bytes)}`))
      if (this.picked.held.length) sel.append(el('p', 'dim', `already held in full by ${this.picked.held.join(', ')} — worlds there route to it now`))
      const candidates = this.upstreams.filter((u) => u.claims !== 'everywhere' && !this.picked!.held.includes(u.name))
      if (!candidates.length) sel.append(warn('Every instance of ours already holds it.'))
      else {
        // default to the instance it borders — the one a world straddling the line would need —
        // and otherwise the first that does not hold it
        if (!candidates.some((u) => u.name === this.target)) {
          const near = this.picked.touches.filter((t) => candidates.some((u) => u.name === t.name)).sort((a, b) => a.outside - b.outside)[0]
          this.target = near?.name ?? candidates[0].name
        }
        sel.append(select({ label: 'instance', value: this.target, options: candidates.map((u) => ({ value: u.name, label: u.name })), onChange: (v) => { this.target = v; this.render() } }))
        sel.append(button({
          label: `Add to ${this.target}`,
          icon: 'arrow-down-tray',
          variant: 'primary',
          onClick: () => void this.startImport(),
        }))
      }
      b.append(sel)
    }
    return g
  }

  private treeNode(n: RegionNode): HTMLElement {
    if (!n.children.length) return this.regionRow(n)
    const d = el('details', 'osm-node')
    const s = el('summary')
    s.append(el('span', '', n.label), el('span', 'dim', ` ${n.children.length}`))
    d.append(s)
    // children are built on first open: 554 regions is a lot of rows nobody asked to see
    d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.built) return
      d.dataset.built = '1'
      d.append(this.regionRow(n, `all of ${n.label}`))
      for (const c of n.children) d.append(this.treeNode(c))
    })
    return d
  }

  private regionRow(r: GeofabrikRegion, text?: string): HTMLElement {
    const row = el('button', `osm-pick${this.picked?.id === r.id ? ' on' : ''}`)
    row.type = 'button'
    row.append(el('span', '', text ?? regionLabel(r)), el('span', 'mono dim', r.id))
    row.onclick = () => void this.pick(r)
    return row
  }

  private async pick(r: GeofabrikRegion) {
    this.picked = { id: r.id, label: regionLabel(r), bytes: null, held: [], touches: [] }
    this.target = ''
    this.render()
    try {
      const got = await api.geofabrikRegion(r.id)
      if (this.picked?.id !== r.id) return
      this.picked.bytes = got.pbf?.bytes ?? null
      this.picked.held = got.held
      this.picked.touches = got.touches
      // chosen again now that we know what it borders (the first render guessed without)
      this.target = ''
      this.map.preview = { geometry: got.region.geometry, label: this.picked.label }
      const xs: number[] = []
      const ys: number[] = []
      const polys = got.region.geometry.type === 'Polygon' ? [got.region.geometry.coordinates] : got.region.geometry.coordinates
      for (const p of polys) for (const [x, y] of p[0]) { xs.push(x); ys.push(y) }
      // a region crossing the antimeridian (Alaska, Russia) is framed by its main part instead
      if (Math.max(...xs) - Math.min(...xs) < 300) this.map.fit({ south: Math.min(...ys), west: Math.min(...xs), north: Math.max(...ys), east: Math.max(...xs) })
      else this.map.draw()
      this.render()
      this.side.querySelector('.osm-picked')?.scrollIntoView({ block: 'nearest' })
    } catch (e) {
      toast(`${r.id}: ${(e as Error).message}`, 'danger')
    }
  }

  private async startImport() {
    const p = this.picked
    if (!p || !this.target) return
    const ok = await confirm({
      title: `Add ${p.label} to ${this.target}`,
      message:
        `Downloads ${p.id} (${fmtBytes(p.bytes)}) onto ${this.target}'s volume and applies it through the running instance, which keeps answering throughout. ` +
        `It needs free space of the instance's database size or 150× the download, whichever is more — the write is copy-on-write — and the run stops and says so if there is not. ` +
        `Measured on the instance's image: Washington into Maryland in under a minute, Maryland in about five; this cluster's storage is several times slower. ` +
        `When it finishes, worlds there route to ${this.target}.`,
      ok: 'Start the import',
      icon: 'arrow-down-tray',
    })
    if (!ok) return
    try {
      const { run } = await api.osmImport(this.target, p.id)
      toast(`${run.label}: started`, 'ok')
      void this.logs.open(run.id)
      void this.pollImports()
    } catch (e) {
      toast((e as Error).message, 'danger', 9000)
    }
  }

  private importList(): HTMLElement {
    const g = group('Imports', { collapsed: !this.imports.length })
    const b = bodyOf(g)
    if (!this.imports.length) b.append(empty('Nothing imported from here yet'))
    for (const r of this.imports.slice(0, 12)) {
      const row = el('button', 'run-open')
      row.type = 'button'
      row.append(chip(r.state === 'done' ? 'ok' : r.state === 'failed' ? 'danger' : 'warn', r.state), el('span', 'run-title', r.label))
      row.onclick = () => void this.logs.open(r.id)
      b.append(row)
    }
    return g
  }
}

function chip(kind: 'ok' | 'warn' | 'danger' | 'info', text: string): HTMLElement {
  const c = el('span', `state-chip ${kind}`)
  c.append(el('span', '', text))
  return c
}

function line(label: string, value: string): HTMLElement {
  const r = el('div', 'osm-line')
  r.append(el('span', 'field-label', label), el('span', 'mono', value))
  return r
}

function warn(text: string): HTMLElement {
  const p = el('p', 'panel-hint warn')
  p.append(icon('exclamation-triangle', 14), el('span', '', text))
  return p
}
