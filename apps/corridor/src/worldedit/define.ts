// Define a world: what a drawn boundary becomes, and the numbers that make that honest.
//
// The panel exists to answer three questions before anybody spends an hour of USGS bandwidth:
//   1. WHERE — the smallest circle that contains what you drew, and the square the bake takes.
//   2. HOW MUCH — ways and kilometres of centreline, inside the boundary AND inside the square,
//      side by side, because the second is what actually gets baked and is routinely twice the
//      first. A boundary drawn around the Crofton triangle holds 62 ways / 25.1 km; the square the
//      bake takes holds 163 / 46.8 km.
//   3. WHICH ROAD IS THE SPINE — `primary` is not decoration: it becomes the spine, and the
//      profile, the structures and every branch's `s_on_primary` are measured along it.
import { button, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout, segmented, select, slider, textField, toggle } from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type Preview, type Way, type World } from './api'
import { importBakeGroup } from './transfer'
import type { LonLat, MapView } from './map'

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)

export interface DefineOpts {
  map: MapView
  host: HTMLElement
  onSaved: (w: World) => void
  onDirty: (dirty: boolean) => void
  /** the world list, for the import step */
  worlds: () => World[]
  /** a baked world arrived by upload: re-read the list and show it */
  onImported: () => Promise<void>
}

export class DefinePanel {
  /** null until a boundary or a centre+radius exists */
  preview: Preview | null = null
  private o: DefineOpts
  private draft: Partial<World> = { all_streets: true }
  private editing: string | null = null
  private previewing = false
  private pending = 0
  private roads = new Set<string>()

  constructor(o: DefineOpts) {
    this.o = o
  }

  /** Start a new world from scratch, with the map in draw mode. */
  fresh() {
    this.editing = null
    this.draft = { all_streets: true }
    this.roads.clear()
    this.preview = null
    this.o.map.clearRing()
    this.o.map.picked = this.roads
    this.o.map.extent = null
    this.o.map.mode = 'draw'
    this.render()
  }

  /** Load an existing definition back onto the map for editing. */
  load(w: World) {
    this.editing = w.slug
    this.draft = { ...w }
    this.roads = new Set(w.roads ?? [])
    this.o.map.picked = this.roads
    this.o.map.ring = (w.boundary ?? []).map(([lon, lat]) => ({ lon, lat }))
    this.o.map.ringClosed = this.o.map.ring.length >= 3
    this.o.map.extent = { centre: { lon: w.lon, lat: w.lat }, radius_m: w.radius_m }
    this.o.map.flyTo({ lon: w.lon, lat: w.lat }, zoomFor(w.radius_m))
    this.o.map.mode = 'draw'
    this.refresh()
  }

  /** The map's ring changed. Debounced, because every vertex would otherwise be an Overpass query. */
  onBoundary(ring: LonLat[], closed: boolean) {
    this.o.onDirty(ring.length > 0)
    if (!closed || ring.length < 3) {
      this.render()
      return
    }
    this.schedule()
  }

  /** A road was clicked in pick mode. Shift adds; a plain click replaces the primary. */
  onPick(way: Way, additive: boolean) {
    if (this.draft.all_streets) {
      this.draft.primary = way.ident
      toast(`primary: ${way.ident}`, 'ok')
    } else if (additive || !this.roads.size) {
      if (this.roads.has(way.ident)) this.roads.delete(way.ident)
      else this.roads.add(way.ident)
      if (!this.draft.primary || !this.roads.has(this.draft.primary)) this.draft.primary = [...this.roads][0] ?? null
    } else {
      this.draft.primary = way.ident
      this.roads.add(way.ident)
    }
    this.o.map.draw()
    this.render()
  }

  private schedule() {
    clearTimeout(this.pending)
    // setTimeout, not a frame callback — a preview asked for before the tab lost focus must still
    // arrive. rAF would simply never fire.
    this.pending = window.setTimeout(() => void this.refresh(), 250)
  }

  async refresh() {
    const ring = this.o.map.ring
    const body =
      ring.length >= 3 && this.o.map.ringClosed
        ? { boundary: ring.map((p) => [p.lon, p.lat] as [number, number]) }
        : this.draft.lat != null && this.draft.radius_m
          ? { centre: { lat: this.draft.lat, lon: this.draft.lon! }, radius_m: this.draft.radius_m }
          : null
    if (!body) {
      this.preview = null
      this.render()
      return
    }
    this.previewing = true
    this.render()
    try {
      this.preview = await api.preview(body)
      this.draft.lat = this.preview.circle.lat
      this.draft.lon = this.preview.circle.lon
      this.draft.radius_m = this.preview.circle.radius_m
      if (!this.draft.primary) this.draft.primary = this.preview.primary
      this.o.map.extent = { centre: { lat: this.preview.circle.lat, lon: this.preview.circle.lon }, radius_m: this.preview.circle.radius_m }
      this.o.map.draw()
    } catch (e) {
      toast((e as Error).message, 'danger')
      this.preview = null
    } finally {
      this.previewing = false
      this.render()
    }
  }

  /* ---- the panel --------------------------------------------------------------------------- */

  render() {
    const host = this.o.host
    host.replaceChildren()
    const ring = this.o.map.ring

    if (!this.preview && !this.o.map.ring.length) {
      host.append(hint('Drag a box on the map. Drag its corners or edges to adjust.'))
    }

    /* Name first. It used to be the last group on the form, below the extent, the contents, the
       roads and the look — so the two fields you have to fill in to save anything were the two
       furthest from the button (Rich, 2026-09-28: "you should be able to edit the slug and
       description before submitting"). */
    const name = group('Name')
    const nb = bodyOf(name)
    const slugField = textField({
      label: 'slug',
      value: this.draft.slug ?? '',
      placeholder: 'lower-case-with-hyphens',
      onChange: (v) => {
        this.draft.slug = v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
        this.render()
      },
    })
    nb.append(
      slugField,
      textField({
        label: 'description',
        value: this.draft.note ?? '',
        placeholder: 'what this place is',
        onChange: (v) => {
          this.draft.note = v
        },
      }),
    )
    host.append(name)

    /* where */
    const where = group('Extent')
    const wb = bodyOf(where)
    if (!this.preview) {
      wb.append(empty(ring.length ? 'measuring…' : 'No area drawn'))
      wb.append(
        button({
          label: 'Use the current view',
          icon: 'viewfinder-circle',
          title: 'use the current view',
          onClick: () => {
            const b = this.o.map.bbox()
            this.draft.lat = (b.north + b.south) / 2
            this.draft.lon = (b.east + b.west) / 2
            this.draft.radius_m = Math.round(((b.north - b.south) / 2) * 111132)
            this.o.map.clearRing()
            void this.refresh()
          },
        }),
      )
    } else {
      const c = this.preview.circle
      wb.append(
        readout('centre', `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`),
        slider({
          label: 'half-width',
          value: c.radius_m,
          min: 150,
          max: 12000,
          step: 50,
          neutral: c.radius_m,
          unit: 'm',
          note: 'half the side of the square the bake takes',
          onInput: (v) => {
            this.draft.radius_m = v
            this.o.map.extent = { centre: { lat: c.lat, lon: c.lon }, radius_m: v }
            this.o.map.draw()
            clearTimeout(this.pending)
            this.pending = window.setTimeout(() => {
              this.o.map.clearRing()
              void this.refresh()
            }, 500)
          },
        }),
        readout('bake area', `${(c.radius_m * 2).toLocaleString()} m square · ${((c.radius_m * 2 / 1000) ** 2).toFixed(1)} km²`),
      )
      for (const w of this.preview.warnings) wb.append(warn(w))
    }
    host.append(where)
    // The other way to get a world: import one somebody else baked. Only when making a new one —
    // on an existing world it would read as "replace this", which is not what it does.
    if (!this.editing) {
      host.append(importBakeGroup({
        selected: () => this.draft.slug ?? null,
        worlds: () => this.o.worlds(),
        reload: () => this.o.onImported(),
      }))
    }

    /* how much */
    if (this.preview) {
      const s = this.preview.selection
      const size = group('Contents')
      const sb = bodyOf(size)
      sb.append(readout('baked', `${s.square.ways.toLocaleString()} ways · ${km(s.square.metres)}`))
      if (s.boundary) {
        sb.append(readout('inside boundary', `${s.boundary.ways.toLocaleString()} ways · ${km(s.boundary.metres)}`))
        const extra = s.square.metres - s.boundary.metres
        // Actionable, and only when it is: the bake squares off your shape, and past a sixth of
        // the total that is enough road to be worth tightening.
        if (extra > s.boundary.metres * 0.15) sb.append(hint(`+${km(extra)} outside your boundary — the bake squares it off`))
      }
      if (this.previewing) sb.append(hint('measuring…'))
      host.append(size)
    }

    /* which roads */
    const roads = group('Roads')
    const rb = bodyOf(roads)
    rb.append(
      segmented<'all' | 'named'>({
        value: this.draft.all_streets ? 'all' : 'named',
        options: [
          { value: 'all', label: 'Every street' },
          { value: 'named', label: 'Named roads' },
        ],
        onChange: (v) => {
          this.draft.all_streets = v === 'all'
          if (v === 'all') delete this.draft.roads
          this.o.map.mode = v === 'all' ? 'draw' : 'pick'
          this.render()
        },
      }),
    )
    if (!this.draft.all_streets) {
      rb.append(hint('Click roads to add · shift-click toggles'))
      if (!this.roads.size) rb.append(empty('nothing picked'))
      for (const r of this.roads) {
        const row = el('div', 'road-row')
        row.append(el('span', 'road-name', r))
        row.append(
          button({
            icon: 'x-mark',
            variant: 'ghost',
            title: `remove ${r}`,
            onClick: () => {
              this.roads.delete(r)
              if (this.draft.primary === r) this.draft.primary = [...this.roads][0] ?? null
              this.o.map.draw()
              this.render()
            },
          }),
        )
        rb.append(row)
      }
    }

    const idents = this.preview?.selection.idents ?? []
    rb.append(
      select({
        label: 'Spine',
        value: this.draft.primary ?? '',
        options: [
          { value: '', label: '— pick one —' },
          ...(this.draft.all_streets ? idents.slice(0, 60) : [...this.roads].map((i) => ({ ident: i, metres: 0 })))
            .filter((i) => i.ident && i.ident !== '«unnamed»')
            .map((i) => ({ value: i.ident, label: i.metres ? `${i.ident} — ${km(i.metres)}` : i.ident })),
        ],
        onChange: (v) => {
          this.draft.primary = v || null
        },
      }),
    )
    host.append(roads)

    /* how it looks: the palette, the season and the water the world opens with */
    const lookG = group('Look', { note: 'Defaults; ?style and ?season in a viewer link override them.' })
    const lb = bodyOf(lookG)
    const look = (this.draft.look ??= {})
    lb.append(
      select<'realistic' | 'fantasy'>({
        label: 'style',
        value: (look.style as 'realistic' | 'fantasy') ?? 'realistic',
        options: [
          { value: 'realistic', label: 'Realistic' },
          { value: 'fantasy', label: 'Fantasy' },
        ],
        onChange: (v) => {
          look.style = v
          this.o.onDirty(true)
        },
      }),
      select<'winter' | 'spring' | 'summer' | 'autumn'>({
        label: 'season',
        value: (look.season as 'winter' | 'spring' | 'summer' | 'autumn') ?? 'summer',
        options: [
          { value: 'spring', label: 'Spring' },
          { value: 'summer', label: 'Summer' },
          { value: 'autumn', label: 'Autumn' },
          { value: 'winter', label: 'Winter' },
        ],
        onChange: (v) => {
          look.season = v
          this.o.onDirty(true)
        },
      }),
      slider({
        label: 'terrain relief',
        value: look.relief ?? 1,
        min: 0.25,
        max: 5,
        step: 0.25,
        neutral: 1,
        unit: '×',
        note: '1 = as measured',
        onInput: (v) => {
          if (v === 1) delete look.relief
          else look.relief = v
          this.o.onDirty(true)
        },
      }),
      toggle({
        label: 'set the water level',
        value: look.water_level_m != null,
        note: 'Off = the site’s own water',
        onChange: (on) => {
          if (on) look.water_level_m = look.water_level_m ?? 0
          else delete look.water_level_m
          this.o.onDirty(true)
          this.render()
        },
      }),
    )
    if (look.water_level_m != null) {
      lb.append(
        slider({
          label: 'water level',
          value: look.water_level_m,
          min: -100,
          max: 1000,
          step: 1,
          unit: 'm',
          note: 'NAVD88',
          onInput: (v) => {
            look.water_level_m = v
            this.o.onDirty(true)
          },
        }),
      )
    }
    host.append(lookG)

    /* naming and saving */

    const acts = el('div', 'panel-actions')
    acts.append(
      button({
        label: this.editing ? 'Save changes' : 'Create world',
        icon: 'document-arrow-down',
        variant: 'primary',
        title: !this.draft.slug ? 'give it a slug first'
          : !this.draft.radius_m ? 'draw an area first' : '',
        onClick: () => void this.save(),
      }),
      button({ label: 'Clear', icon: 'arrow-uturn-left', onClick: () => this.fresh() }),
    )
    host.append(acts)
  }

  private async save() {
    const d = this.draft
    if (!d.slug) return toast('give it a slug first', 'warn')
    if (!d.lat || !d.radius_m) return toast('draw a boundary, or use the current view', 'warn')
    const body: Record<string, unknown> = {
      slug: d.slug,
      centre: { lat: d.lat, lon: d.lon },
      radius_m: d.radius_m,
      primary: d.primary,
      all_streets: !!d.all_streets,
      roads: [...this.roads],
      note: d.note,
      boundary: this.o.map.ring.map((p) => [p.lon, p.lat]),
      look: d.look && Object.keys(d.look).length ? d.look : undefined,
    }
    try {
      const res = this.editing
        ? await api.saveWorld(this.editing, {
            ...body,
            lat: d.lat,
            lon: d.lon,
            kind: 'network',
            boundary: this.o.map.ring.map((p) => [p.lon, p.lat]),
          })
        : await api.createWorld(body)
      for (const w of res.warnings ?? []) toast(w, 'warn', 6000)
      toast(`${res.world.slug} saved`, 'ok')
      this.editing = res.world.slug
      this.o.onDirty(false)
      this.o.onSaved(res.world)
    } catch (e) {
      toast((e as Error).message, 'danger', 8000)
    }
  }
}

function hint(text: string): HTMLElement {
  const p = el('p', 'panel-hint')
  p.append(icon('information-circle', 14), el('span', '', text))
  return p
}

function warn(text: string): HTMLElement {
  const p = el('p', 'panel-hint warn')
  p.append(icon('exclamation-triangle', 14), el('span', '', text))
  return p
}

/** A zoom that puts a world of this radius comfortably on screen. */
export function zoomFor(radius_m: number): number {
  return Math.max(9, Math.min(17, Math.round(Math.log2(40075017 / (radius_m * 5)))))
}
