// Define a world: what a drawn boundary becomes, and the numbers that make that honest.
//
// The panel exists to answer three questions before anybody spends an hour of USGS bandwidth:
//   1. WHERE — the shape on the map. A square or a polygon, and the bake takes that shape.
//   2. HOW MUCH — ways and kilometres of centreline inside it.
//   3. WHICH ROAD IS THE SPINE — `primary` is not decoration: it becomes the spine, and the
//      profile, the structures and every branch's `s_on_primary` are measured along it.
import { button, confirm, el, toast } from '../ui/shell'
import { bodyOf, empty, focusField, group, readout, segmented, select, setFieldError, setGroupError, slider, textField, toggle }
  from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type Preview, type Way, type World } from './api'
import { importBakeGroup } from './transfer'
import { assetsvc } from '../assetsvc'
import { type SurfaceRole } from './api'
import { slugFromName } from './slug'

/**
 * Which surface role a material's category fills.
 *
 * The library's categories are what a material IS ("road", "ground_cover"); the roles are what a
 * world DRAWS. They mostly coincide, which is why this is a map and not an inference — the two
 * vocabularies are allowed to diverge, and when they do this is the one place that has to know.
 */
const ROLE_FOR_CATEGORY: Record<string, SurfaceRole> = {
  road: 'road',
  paving: 'paving',
  sidewalk: 'sidewalk',
  shoulder: 'shoulder',
  ground_cover: 'ground_cover',
  verge: 'verge',
}
import type { LonLat, MapView } from './map'


const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)

/** Width and height of a ring, in metres. The bake's box is this, not the circle around it. */
function ringSpan(ring: LonLat[]): { w: number; h: number } {
  let south = 90, north = -90, west = 180, east = -180
  for (const p of ring) {
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
    west = Math.min(west, p.lon)
    east = Math.max(east, p.lon)
  }
  const mid = (south + north) / 2
  return {
    h: (north - south) * 111132,
    w: (east - west) * 111412.84 * Math.max(0.05, Math.cos((mid * Math.PI) / 180)),
  }
}

export interface DefineOpts {
  map: MapView
  host: HTMLElement
  onSaved: (w: World) => void
  onDirty: (dirty: boolean) => void
  /** the world list, for the import step */
  worlds: () => World[]
  /** the world in the picker — the one Delete acts on */
  selected: () => string | null
  /** a baked world arrived by upload: re-read the list and show it */
  onImported: () => Promise<void>
  /** a world was deleted: drop it from the picker and re-read the list */
  onDeleted: (slug: string) => Promise<void>
}

export class DefinePanel {
  /** null until a boundary or a centre+radius exists */
  preview: Preview | null = null
  private o: DefineOpts
  private draft: Partial<World> = { all_streets: true }
  private editing: string | null = null
  /* The fields `save()` can complain about. Held so the complaint can be put ON them rather than
     in a toast that appears somewhere else and then takes itself away. Re-made on every render,
     so they are refs to the live nodes and never to a detached one. */
  private slugField: HTMLElement | null = null
  /** what the texture library has, for the per-world surface picker. Empty if it is not reachable. */
  private surfaces: { id: string; name: string; category: string }[] = []
  private extentGroup: HTMLElement | null = null
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
    this.o.map.select = 'square'
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
    this.o.map.select = this.o.map.ringClosed && !this.o.map.isRect() ? 'polygon' : 'square'
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

  /** What the texture library has. Failure is silent: the picker simply does not appear. */
  async loadSurfaces() {
    this.surfaces = await assetsvc.materials()
      .then((r) => r.materials.filter((m) => ROLE_FOR_CATEGORY[m.category]).map((m) => ({ id: m.id, name: m.name, category: m.category })))
      .catch(() => [])
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
      // A closed ring is the bake. The circle-and-square overlay is only for a radius with no shape.
      const shaped = ring.length >= 3 && this.o.map.ringClosed
      this.o.map.extent = shaped ? null : { centre: { lat: this.preview.circle.lat, lon: this.preview.circle.lon }, radius_m: this.preview.circle.radius_m }
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
    this.slugField = null
    this.extentGroup = null
    const ring = this.o.map.ring

    const sel = group('Selection')
    const sb0 = bodyOf(sel)
    sb0.append(segmented({
      value: this.o.map.select,
      options: [
        { value: 'square', label: 'Square' },
        { value: 'polygon', label: 'Polygon' },
      ],
      onChange: (v) => {
        this.o.map.select = v
        this.o.map.mode = 'draw'
        this.o.map.draw()
        this.render()
      },
    }))
    sb0.append(hint(this.o.map.select === 'polygon'
      ? 'Click to place points. Click the first point to close. Drag a point to move it, click an edge to add one, Backspace removes the selected point. Ctrl-drag, right-drag or middle-drag scrolls.'
      : 'Drag a box. Drag a corner or an edge to resize it, then switch to Polygon to add or remove corners. Ctrl-drag, right-drag or middle-drag scrolls.'))
    host.append(sel)

    /* Name first. It used to be the last group on the form, below the extent, the contents, the
       roads and the look — so the two fields you have to fill in to save anything were the two
       furthest from the button (Rich, 2026-09-28: "you should be able to edit the slug and
       description before submitting"). */
    const name = group('Name')
    const nb = bodyOf(name)
    /*
     * THE FIELD IS THE NAME. The slug is derived from it and shown underneath, so you can see
     * what the files and the URLs will be called without having to type it in that shape.
     *
     * Rich, 2026-09-28: "name should be name, slug should be auto-derived from it." The field was
     * labelled `slug` under a group called `Name`, which asked a person to think in file names
     * while naming a place — and lost the capitals and the spaces of the name they had in mind.
     */
    const slugLine = readout('slug', this.draft.slug || '—', true)
    this.slugField = textField({
      label: 'name',
      value: this.draft.name ?? this.draft.slug ?? '',
      placeholder: 'Crofton Triangle',
      onChange: (v) => {
        this.draft.name = v.trim()
        // derived ONLY while it follows: once a slug has been edited by hand, or the world has
        // been saved under one, renaming must not move the documents out from under it
        if (!this.editing) this.draft.slug = slugFromName(v)
        const cell = slugLine.querySelector('.field-value')
        if (cell) cell.textContent = this.draft.slug || '—'
        this.render()
      },
    })
    nb.append(this.slugField, slugLine)
    if (this.editing) {
      nb.append(el('p', 'panel-hint', `The slug is fixed at ${this.editing}: it names this world\u2019s files, its bake and its URLs.`))
    }
    nb.append(
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
    this.extentGroup = where
    const wb = bodyOf(where)
    // render() runs on every boundary change, so an extent that now exists clears its own
    // complaint without anything having to remember it was made.
    if (this.preview) setGroupError(where, null)
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
      const shaped = ring.length >= 3 && this.o.map.ringClosed
      wb.append(readout('centre', `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`))
      if (shaped) {
        const span = ringSpan(ring)
        wb.append(readout('bake area', `${Math.round(span.w).toLocaleString()} × ${Math.round(span.h).toLocaleString()} m · ${ring.length} points`))
        wb.append(hint('The bake takes this shape. Ground outside it is not fetched.'))
      } else {
        wb.append(
          slider({
            label: 'half-width',
            value: c.radius_m,
            min: 150,
            max: 12000,
            step: 50,
            neutral: c.radius_m,
            unit: 'm',
            note: 'half the side of the square the bake takes, when no shape is drawn',
            onInput: (v) => {
              this.draft.radius_m = v
              this.o.map.extent = { centre: { lat: c.lat, lon: c.lon }, radius_m: v }
              this.o.map.draw()
              clearTimeout(this.pending)
              this.pending = window.setTimeout(() => void this.refresh(), 500)
            },
          }),
          readout('bake area', `${(c.radius_m * 2).toLocaleString()} m square · ${((c.radius_m * 2 / 1000) ** 2).toFixed(1)} km²`),
        )
      }
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
      if (s.boundary && ring.length >= 3) {
        sb.append(readout('baked', `${s.boundary.ways.toLocaleString()} ways · ${km(s.boundary.metres)}`))
      } else {
        sb.append(readout('baked', `${s.square.ways.toLocaleString()} ways · ${km(s.square.metres)}`))
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

    /*
     * WHICH TEXTURES THIS WORLD USES.
     *
     * Only the roles the library actually has something for, and every one defaults to "the
     * viewer's default" rather than to a specific material — a world that says nothing about its
     * road is not misconfigured, it is ordinary. Listing roles the library cannot fill would be
     * offering a choice with one option.
     */
    if (this.surfaces.length) {
      const surf = group('Surfaces', { collapsed: true, note: 'Leave a role on its default unless this world needs a different one.' })
      const sb = bodyOf(surf)
      const chosen = (this.draft.surfaces ??= {})
      const byRole = new Map<string, { id: string; name: string }[]>()
      for (const m of this.surfaces) {
        const role = ROLE_FOR_CATEGORY[m.category] ?? null
        if (role) byRole.set(role, [...(byRole.get(role) ?? []), { id: m.id, name: m.name }])
      }
      for (const [role, options] of byRole) {
        sb.append(select({
          label: role.replace(/_/g, ' '),
          value: chosen[role as SurfaceRole] ?? '',
          options: [{ value: '', label: 'default' }, ...options.map((o) => ({ value: o.id, label: o.name }))],
          onChange: (v) => {
            if (v) chosen[role as SurfaceRole] = v
            else delete chosen[role as SurfaceRole]
            this.o.onDirty(true)
          },
        }))
      }
      host.append(surf)
    }

    /* naming and saving */

    const acts = el('div', 'panel-actions')
    acts.append(
      button({
        label: this.editing ? 'Save changes' : 'Create world',
        icon: 'document-arrow-down',
        variant: 'primary',
        title: !this.draft.slug ? 'give it a name first'
          : !this.draft.radius_m ? 'draw an area first' : '',
        onClick: () => void this.save(),
      }),
      button({ label: 'Clear', icon: 'arrow-uturn-left', onClick: () => this.fresh() }),
    )
    host.append(acts)

    /*
     * DELETE, only for a world that has been baked.
     *
     * An unbaked definition is a drawing. A bake is the thing that fills the picker and the
     * viewer, and it is the one there was no way to remove. It sits under the save row, named
     * for the world, and asks before it does it.
     */
    const slug = this.o.selected()
    const current = slug ? this.o.worlds().find((w) => w.slug === slug) : null
    if (current?.baked) {
      const danger = el('div', 'panel-actions')
      danger.append(
        button({
          label: `Delete ${current.slug}`,
          icon: 'trash',
          variant: 'danger',
          title: `delete ${current.slug} and its bake`,
          onClick: () => void this.remove(current.slug),
        }),
      )
      host.append(danger)
    }
  }

  private async remove(slug: string) {
    const yes = await confirm({
      title: `Delete ${slug}?`,
      message: `This removes ${slug} and its bake. It cannot be undone.`,
      ok: 'Delete world',
      danger: true,
      icon: 'trash',
    })
    if (!yes) return
    try {
      await api.deleteWorld(slug)
      toast(`${slug} deleted`, 'ok')
      await this.o.onDeleted(slug)
    } catch (e) {
      toast((e as Error).message, 'danger', 8000)
    }
  }

  private async save() {
    const d = this.draft
    /*
     * ON THE FORM, NOT IN A TOAST. Both of these used to be `toast(..., 'warn')`: a message about
     * a specific field, shown somewhere else, for four seconds, with no indication of which field
     * and no way to read it again. Now the field is outlined, the message sits under it, the
     * cursor goes there, and it all clears at the first keystroke.
     */
    const problems: { field: HTMLElement; message: string }[] = []
    if (!d.slug && this.slugField) problems.push({ field: this.slugField, message: 'Give it a name' })
    if ((!d.lat || !d.radius_m) && this.extentGroup) {
      // The extent is not a text field — it is the map — so the message goes on the group and the
      // focus moves to the one control in it that CAN be used from the keyboard.
      setGroupError(this.extentGroup, 'Drag an area on the map, or use the current view')
      problems.push({ field: this.extentGroup, message: '' })
    }
    if (problems.length) {
      for (const p of problems) if (p.message) setFieldError(p.field, p.message)
      focusField(problems[0].field)
      return
    }
    const body: Record<string, unknown> = {
      slug: d.slug,
      name: d.name ?? d.slug,
      centre: { lat: d.lat, lon: d.lon },
      radius_m: d.radius_m,
      primary: d.primary,
      all_streets: !!d.all_streets,
      roads: [...this.roads],
      note: d.note,
      surfaces: d.surfaces,
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
