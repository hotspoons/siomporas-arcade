// Adjustment areas: draw a polygon on the ground, then say what the data got wrong inside it.
//
// The viewer infers everything from measurement — canopy height from lidar returns, surface class
// from a vote over reflectance, ground from the DEM — and measurement is wrong in stretches. An
// area is a local override with a neutral default, so "the trees along here came out as stubs"
// is a polygon and one slider rather than a special case in the bake.
//
// What is authored here is x/y only. Height is never stored: the polygon is draped at draw time
// and re-draped whenever the terrain under it changes, so a re-bake cannot leave an area floating.
import * as THREE from 'three'
import { fillMesh, handleMesh, outlineMesh, type HeightAt } from './drape'
import { areaOf, frameMismatch, frameOf, inside, loadAdjustments, nextId, saveAdjustments, CROP_FIELDS, NEUTRAL, PICKERS, SLIDERS, type Adjust, type Adjustments, type Area } from './schema'
import type { Site } from '../scene'
import { bearingOf, nearestStation, normDeg } from './corridor'
import { el, frameBanner, slider } from './ui'

const COLOR = { idle: 0x5c93c4, edited: 0xffdc00, selected: 0x2ee6c0, draw: 0xff8a2b }
const MIN_VERTS = 3

const isNeutral = (a: Adjust) => (Object.keys(NEUTRAL) as (keyof Adjust)[]).every((k) => a[k] === NEUTRAL[k])

export class AreaMode {
  group = new THREE.Group()
  doc: Adjustments = { version: 1, areas: [] }
  dirty = false
  selected: string | null = null

  private slug = ''
  private h: HeightAt = () => 0
  /** only for corridor-frame defaults (the crop-row heading); areas themselves are site-frame */
  private site: Site | null = null
  private meshes = new Map<string, { fill: THREE.Mesh; outline: THREE.LineLoop }>()
  private handles = new THREE.Group()
  private draw: [number, number][] | null = null
  private drawGroup = new THREE.Group()
  private grabbed = -1
  /** set when the file's coordinates were authored in a different frame from the bake's */
  frameWarning: string | null = null
  /** `false` = only a value changed; the panel must not be rebuilt under the pointer. */
  private onChange: (structural?: boolean) => void

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'areas'
    this.group.add(this.handles, this.drawGroup)
    this.onChange = onChange
  }

  async load(slug: string, h: HeightAt, site: Site | null = null) {
    this.slug = slug
    this.h = h
    this.site = site
    this.doc = await loadAdjustments(slug)
    this.frameWarning = site ? frameMismatch(this.doc.frame, site.manifest) : null
    this.dirty = false
    this.selected = null
    this.draw = null
    this.rebuild()
  }

  get drawing() {
    return this.draw !== null
  }

  // --- geometry ------------------------------------------------------------------------------
  private colorFor(a: Area) {
    if (a.id === this.selected) return COLOR.selected
    return isNeutral(a.adjust) ? COLOR.idle : COLOR.edited
  }

  private rebuild() {
    for (const { fill, outline } of this.meshes.values()) {
      fill.geometry.dispose()
      outline.geometry.dispose()
      this.group.remove(fill, outline)
    }
    this.meshes.clear()
    for (const a of this.doc.areas) this.addMesh(a)
    this.refreshHandles()
  }

  private addMesh(a: Area) {
    if (a.polygon.length < MIN_VERTS) return
    const c = this.colorFor(a)
    const fill = fillMesh(a.polygon, this.h, c, a.id === this.selected ? 0.3 : 0.16)
    const outline = outlineMesh(a.polygon, this.h, c)
    fill.userData.areaId = a.id
    this.group.add(fill, outline)
    this.meshes.set(a.id, { fill, outline })
  }

  private remesh(id: string) {
    const got = this.meshes.get(id)
    if (got) {
      got.fill.geometry.dispose()
      got.outline.geometry.dispose()
      this.group.remove(got.fill, got.outline)
      this.meshes.delete(id)
    }
    const a = this.doc.areas.find((x) => x.id === id)
    if (a) this.addMesh(a)
  }

  /** Colour only — a slider move must not rebuild a 4 km band's triangles. */
  private refreshColors() {
    for (const a of this.doc.areas) {
      const got = this.meshes.get(a.id)
      if (!got) continue
      const c = this.colorFor(a)
      ;(got.fill.material as THREE.MeshBasicMaterial).color.setHex(c)
      ;(got.fill.material as THREE.MeshBasicMaterial).opacity = a.id === this.selected ? 0.3 : 0.16
      ;(got.outline.material as THREE.LineBasicMaterial).color.setHex(c)
    }
  }

  private refreshHandles() {
    this.handles.clear()
    const a = this.doc.areas.find((x) => x.id === this.selected)
    if (!a) return
    // a 4 km seeded band has 128 vertices; grabbing one of those is authoring, grabbing a hundred
    // is a mess — so handles only appear on polygons small enough to be worth nudging by hand
    if (a.polygon.length > 40) return
    a.polygon.forEach(([x, y], i) => {
      const m = handleMesh(COLOR.selected)
      m.position.set(x, this.h(x, y) + 0.8, -y)
      m.userData = { vertex: i }
      this.handles.add(m)
    })
  }

  private refreshDraw() {
    this.drawGroup.clear()
    if (!this.draw?.length) return
    for (const [x, y] of this.draw) {
      const m = handleMesh(COLOR.draw, 1.8)
      m.position.set(x, this.h(x, y) + 0.8, -y)
      this.drawGroup.add(m)
    }
    if (this.draw.length >= 2) {
      const pts = this.draw.map(([x, y]) => new THREE.Vector3(x, this.h(x, y) + 0.6, -y))
      const g = new THREE.BufferGeometry().setFromPoints(this.draw.length >= MIN_VERTS ? [...pts, pts[0]] : pts)
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLOR.draw, depthTest: false }))
      line.renderOrder = 11
      this.drawGroup.add(line)
    }
  }

  // --- editing -------------------------------------------------------------------------------
  startDraw() {
    this.draw = []
    this.select(null)
    this.refreshDraw()
    this.onChange()
  }

  cancelDraw() {
    this.draw = null
    this.refreshDraw()
    this.onChange()
  }

  closeDraw() {
    if (!this.draw || this.draw.length < MIN_VERTS) return this.cancelDraw()
    const id = nextId('a', this.doc.areas.map((a) => a.id))
    const area: Area = { id, name: 'new area', polygon: this.draw, adjust: { ...NEUTRAL } }
    this.doc.areas.push(area)
    this.draw = null
    this.dirty = true
    this.refreshDraw()
    this.addMesh(area)
    this.select(id)
  }

  select(id: string | null) {
    this.selected = id
    this.refreshColors()
    this.refreshHandles()
    this.onChange()
  }

  remove(id: string) {
    this.doc.areas = this.doc.areas.filter((a) => a.id !== id)
    const got = this.meshes.get(id)
    if (got) {
      got.fill.geometry.dispose()
      got.outline.geometry.dispose()
      this.group.remove(got.fill, got.outline)
      this.meshes.delete(id)
    }
    this.dirty = true
    if (this.selected === id) this.select(null)
    else this.onChange()
  }

  // --- input, delegated from main -------------------------------------------------------------
  /** A click on the ground: add a draw vertex, or select whatever polygon is under it. */
  click(pt: { x: number; y: number } | null) {
    if (this.draw) {
      if (!pt) return
      // clicking the first vertex again closes the ring, like every polygon tool ever
      const first = this.draw[0]
      if (this.draw.length >= MIN_VERTS && first && Math.hypot(pt.x - first[0], pt.y - first[1]) < 8) return this.closeDraw()
      this.draw.push([Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10])
      this.refreshDraw()
      this.onChange()
      return
    }
    if (!pt) return this.select(null)
    // smallest area wins, so a structure handle inside a long surface band is still reachable
    const hits = this.doc.areas.filter((a) => inside(a.polygon, pt.x, pt.y)).sort((p, q) => areaOf(p.polygon) - areaOf(q.polygon))
    this.select(hits[0]?.id ?? null)
  }

  /** Did the pointer land on a vertex handle? If so we take the drag and orbit stands down. */
  grab(ray: THREE.Raycaster): boolean {
    if (this.draw) return false
    const hit = ray.intersectObjects(this.handles.children, false)[0]
    this.grabbed = hit ? (hit.object.userData.vertex as number) : -1
    return this.grabbed >= 0
  }

  dragTo(pt: { x: number; y: number } | null) {
    if (this.grabbed < 0 || !pt) return
    const a = this.doc.areas.find((x) => x.id === this.selected)
    if (!a) return
    a.polygon[this.grabbed] = [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10]
    const m = this.handles.children[this.grabbed]
    if (m) m.position.set(pt.x, this.h(pt.x, pt.y) + 0.8, -pt.y)
    this.dirty = true
    this.onChange(false)
  }

  drop() {
    if (this.grabbed < 0) return
    this.grabbed = -1
    if (this.selected) this.remesh(this.selected)
    this.onChange()
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.draw) {
      this.cancelDraw()
      return true
    }
    if (e.key === 'Enter' && this.draw) {
      this.closeDraw()
      return true
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this.remove(this.selected)
      return true
    }
    return false
  }

  async save(): Promise<string> {
    // stamp the frame we authored in, so the next frame change is loud rather than silent
    if (this.site) this.doc.frame = frameOf(this.site.manifest)
    const bytes = await saveAdjustments(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.areas.length} areas (${bytes} bytes) to ${this.slug}/adjustments.json`
  }

  // --- panel ------------------------------------------------------------------------------------
  panel(root: HTMLElement, go: (a: Area) => void) {
    root.replaceChildren()
    if (this.frameWarning) root.append(frameBanner('adjustments.json', this.frameWarning))
    const tools = el('div', 'row')
    const drawBtn = el('button')
    drawBtn.textContent = this.draw ? `drawing… ${this.draw.length} pts (Enter close, Esc cancel)` : 'draw area (N)'
    drawBtn.onclick = () => (this.draw ? this.closeDraw() : this.startDraw())
    tools.append(drawBtn)
    root.append(tools)

    const list = el('div', 'list')
    for (const a of this.doc.areas) {
      const row = el('div', `item${a.id === this.selected ? ' sel' : ''}${isNeutral(a.adjust) ? '' : ' edited'}`)
      row.append(el('span', 'tag', a.source ?? 'drawn'), el('span', 'nm', a.name), el('span', 'mono', `${(areaOf(a.polygon) / 1e4).toFixed(2)} ha`))
      row.onclick = () => this.select(a.id)
      row.ondblclick = () => go(a)
      list.append(row)
    }
    if (!this.doc.areas.length) list.append(el('p', 'dim', 'No areas yet. Draw one, or seed this site with `python -m corridor areas <slug>`.'))
    root.append(list)

    const a = this.doc.areas.find((x) => x.id === this.selected)
    if (!a) return

    const det = el('div', 'detail')
    det.append(el('h2', '', `${a.id} · ${a.polygon.length} vertices`))
    const name = document.createElement('input')
    name.type = 'text'
    name.value = a.name
    name.oninput = () => {
      a.name = name.value
      this.dirty = true
      for (const row of list.querySelectorAll('.item.sel .nm')) row.textContent = name.value
      this.onChange(false)
    }
    det.append(name)

    for (const s of SLIDERS) {
      det.append(slider(s.label, a.adjust[s.key] as number, s.min, s.max, s.step, NEUTRAL[s.key] as number, s.note, (v) => {
        ;(a.adjust[s.key] as number) = v
        this.dirty = true
        this.refreshColors()
        this.onChange(false)
      }))
    }
    for (const pk of PICKERS) {
      // the crop dropdown is noise until something is growing there
      if (pk.key === 'crop' && a.adjust.cover !== 'crop') continue
      det.append(this.picker(pk.label, pk.options, a.adjust[pk.key] as string | null, pk.note, (v) => {
        ;(a.adjust[pk.key] as string | null) = v
        // Picking a crop lines the rows up with the road by default. A field's rows are never
        // random and almost never due north; the road is the one direction we know, and it is a
        // better starting guess than zero for the same reason a building's own rectangle beats
        // the road normal — except here there is no rectangle to measure.
        if (pk.key === 'cover' && v === 'crop' && a.adjust.row_heading_deg === 0) {
          a.adjust.row_heading_deg = this.roadHeadingAt(a)
        }
        if (pk.key === 'cover' && v !== 'crop') a.adjust.crop = null
        this.onChange()
      }))
    }
    if (a.adjust.cover === 'crop') {
      for (const f of CROP_FIELDS) {
        det.append(this.number(f.label, a.adjust[f.key] as number, f.step, f.note, (v) => {
          ;(a.adjust[f.key] as number) = v
          this.dirty = true
          this.refreshColors()
          this.onChange(false)
        }))
      }
    }

    const acts = el('div', 'row')
    const goBtn = el('button')
    goBtn.textContent = 'fly to'
    goBtn.onclick = () => go(a)
    const reset = el('button')
    reset.textContent = 'reset knobs'
    reset.onclick = () => {
      a.adjust = { ...NEUTRAL }
      this.dirty = true
      this.refreshColors()
      this.onChange()
    }
    const del = el('button', 'danger')
    del.textContent = 'delete (Del)'
    del.onclick = () => this.remove(a.id)
    acts.append(goBtn, reset, del)
    det.append(acts)
    root.append(det)
  }

  /** The compass bearing of the road nearest this area's centroid — the crop-row default. */
  private roadHeadingAt(a: Area): number {
    if (!this.site) return 0
    let x = 0, y = 0
    for (const [px, py] of a.polygon) { x += px; y += py }
    const st = nearestStation(this.site, x / a.polygon.length, y / a.polygon.length)
    return Math.round(normDeg(bearingOf(st.dir)))
  }

  private number(label: string, value: number, step: number, note: string, set: (v: number) => void) {
    const wrap = el('label', 'field')
    wrap.title = note
    wrap.append(el('span', '', label))
    const i = document.createElement('input')
    i.type = 'number'
    i.step = String(step)
    i.value = String(value)
    i.onchange = () => {
      const v = Number(i.value)
      if (Number.isFinite(v)) set(v)
    }
    wrap.append(i)
    return wrap
  }

  private picker(label: string, options: string[], value: string | null, note: string, set: (v: string | null) => void) {
    const wrap = el('label', 'field')
    wrap.title = note
    wrap.append(el('span', '', label))
    const sel = document.createElement('select')
    for (const o of ['(as measured)', ...options]) {
      const opt = document.createElement('option')
      opt.value = o
      opt.textContent = o
      sel.append(opt)
    }
    sel.value = value ?? '(as measured)'
    sel.onchange = () => {
      set(sel.value === '(as measured)' ? null : sel.value)
      this.dirty = true
      this.refreshColors()
      this.onChange(false)
    }
    wrap.append(sel)
    return wrap
  }
}
