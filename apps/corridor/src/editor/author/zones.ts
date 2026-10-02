// Traffic zones: draw a strip of road, then say how busy it is.
//
// Rich, 2026-09-29: *"I imagine just painting a strip of road like google maps and reversing the
// yellow/orange/red/maroon back to varying levels of traffic — we can use the bounding box we use
// for things like canopy or rendering overrides to also draw the box on the road, then apply a
// traffic color. Each area should be able to have a swing too, so either always jammed up, or a
// min and a max and random."*
//
// THE SAME DRAWING, A DIFFERENT DOCUMENT. This is deliberately `AreaMode`'s shape — the same
// polygon tool, the same drape, the same handles, the same Enter-to-close — because a person who
// has drawn a canopy area should not have to learn a second way to draw a box. What is different is
// what the polygon MEANS, and that is the whole reason it is not an extra field on `Adjust`: an
// adjustment says the bake got it wrong and is true for every game played on that ground, while a
// traffic zone belongs to one level. See the note at the top of `src/zones.ts`.
//
// THE COLOUR IS THE VALUE. The fill is `trafficColour(density)` rather than a selection colour, so
// the map reads the way a mapping application reads: you see the jam before you click on it. The
// number is underneath for code and for the ECS, and it is shown, but nobody has to type it.

import * as THREE from 'three'
import { fillMesh, handleMesh, outlineMesh, type HeightAt } from '../view/drape'
import { areaOf, inside } from '../../world/polygon'
import { frameMismatch, frameOf, nextId } from '../store/schema'
import type { Site } from '../../world/scene'
import { dragChip, el, paneTabs, roadStrip, slider } from './ui'
import {
  describeTraffic, TRAFFIC_LEVELS, trafficColour, validateZones,
  type TrafficZone, type Zone, type ZoneDoc,
} from '../../game/world/zones'
import { loadZones, saveZones } from '../store/zonestore'

const MIN_VERTS = 3
const DRAW_COLOUR = 0xff8a2b
const SELECTED_OUTLINE = 0x2ee6c0

/** A new zone starts as an ordinary busy road rather than at zero, which would draw as invisible. */
const DEFAULT_TRAFFIC: TrafficZone = { density: 0.3 }

export class ZoneMode {
  group = new THREE.Group()
  doc: ZoneDoc = { version: 1, zones: [] }
  dirty = false
  selected: string | null = null
  frameWarning: string | null = null

  private slug = ''
  private h: HeightAt = () => 0
  private site: Site | null = null
  private meshes = new Map<string, { fill: THREE.Mesh; outline: THREE.LineLoop }>()
  private handles = new THREE.Group()
  private draw: [number, number][] | null = null
  private drawGroup = new THREE.Group()
  private grabbed = -1
  private onChange: (structural?: boolean) => void

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'zones'
    this.group.add(this.handles, this.drawGroup)
    this.onChange = onChange
  }

  async load(slug: string, h: HeightAt, site: Site | null = null) {
    this.slug = slug
    this.h = h
    this.site = site
    this.doc = await loadZones(slug)
    // only a file with coordinates in it can be in the wrong frame; `frameMismatch` knows (the
    // rule used to live here alone, and areas and placements did not have it)
    this.frameWarning = site ? frameMismatch(this.doc.frame, site.manifest, this.doc.zones.length) : null
    this.dirty = false
    this.selected = null
    this.draw = null
    this.rebuild()
  }

  get drawing() {
    return this.draw !== null
  }

  /** The draw in progress, for a probe that wants to check WHERE a vertex landed. */
  drawPoints(): [number, number][] | null {
    return this.draw ? this.draw.map(([x, y]) => [x, y]) : null
  }

  // --- geometry ---------------------------------------------------------------------------------

  private colourOf(z: Zone): number {
    return parseInt(trafficColour(z.traffic?.density ?? 0).slice(1), 16)
  }

  private rebuild() {
    for (const { fill, outline } of this.meshes.values()) {
      fill.geometry.dispose()
      outline.geometry.dispose()
      this.group.remove(fill, outline)
    }
    this.meshes.clear()
    for (const z of this.doc.zones) this.addMesh(z)
    this.refreshHandles()
  }

  private addMesh(z: Zone) {
    if (z.polygon.length < MIN_VERTS) return
    const c = this.colourOf(z)
    const on = z.id === this.selected
    const fill = fillMesh(z.polygon, this.h, c, on ? 0.45 : 0.3)
    // the OUTLINE carries the selection, not the fill, because the fill's colour is the data
    const outline = outlineMesh(z.polygon, this.h, on ? SELECTED_OUTLINE : c)
    fill.userData.zoneId = z.id
    this.group.add(fill, outline)
    this.meshes.set(z.id, { fill, outline })
  }

  private remesh(id: string) {
    const got = this.meshes.get(id)
    if (got) {
      got.fill.geometry.dispose()
      got.outline.geometry.dispose()
      this.group.remove(got.fill, got.outline)
      this.meshes.delete(id)
    }
    const z = this.doc.zones.find((x) => x.id === id)
    if (z) this.addMesh(z)
  }

  /** Colour only — changing a level must not rebuild a kilometre of triangles. */
  private refreshColours() {
    for (const z of this.doc.zones) {
      const got = this.meshes.get(z.id)
      if (!got) continue
      const c = this.colourOf(z)
      const on = z.id === this.selected
      ;(got.fill.material as THREE.MeshBasicMaterial).color.setHex(c)
      ;(got.fill.material as THREE.MeshBasicMaterial).opacity = on ? 0.45 : 0.3
      ;(got.outline.material as THREE.LineBasicMaterial).color.setHex(on ? SELECTED_OUTLINE : c)
    }
  }

  private refreshHandles() {
    this.handles.clear()
    const z = this.doc.zones.find((x) => x.id === this.selected)
    if (!z || z.polygon.length > 40) return
    z.polygon.forEach(([x, y], i) => {
      const m = handleMesh(SELECTED_OUTLINE)
      m.position.set(x, this.h(x, y) + 0.8, -y)
      m.userData = { vertex: i }
      this.handles.add(m)
    })
  }

  private refreshDraw() {
    this.drawGroup.clear()
    if (!this.draw?.length) return
    for (const [x, y] of this.draw) {
      const m = handleMesh(DRAW_COLOUR, 1.8)
      m.position.set(x, this.h(x, y) + 0.8, -y)
      this.drawGroup.add(m)
    }
    if (this.draw.length >= 2) {
      const pts = this.draw.map(([x, y]) => new THREE.Vector3(x, this.h(x, y) + 0.6, -y))
      const g = new THREE.BufferGeometry().setFromPoints(this.draw.length >= MIN_VERTS ? [...pts, pts[0]] : pts)
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: DRAW_COLOUR, depthTest: false }))
      line.renderOrder = 11
      this.drawGroup.add(line)
    }
  }

  // --- editing ----------------------------------------------------------------------------------

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
    const id = nextId('z', this.doc.zones.map((z) => z.id))
    const zone: Zone = { id, name: 'new zone', kind: 'traffic', polygon: this.draw, traffic: { ...DEFAULT_TRAFFIC, ...(this.drawLevel !== null ? { density: this.drawLevel } : {}) } }
    this.drawLevel = null
    this.doc.zones.push(zone)
    this.draw = null
    this.dirty = true
    this.refreshDraw()
    this.addMesh(zone)
    this.select(id)
  }

  select(id: string | null) {
    if (id) this.panelTab = 'placed'
    this.selected = id
    this.refreshColours()
    this.refreshHandles()
    this.onChange()
  }

  remove(id: string) {
    this.doc.zones = this.doc.zones.filter((z) => z.id !== id)
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

  // --- input, delegated from main ---------------------------------------------------------------

  /** What is here, without taking the click — see `areas.pick`. */
  pick(pt: { x: number; y: number }): { id: string; size: number } | null {
    const hits = this.doc.zones
      .filter((z) => inside(z.polygon, pt.x, pt.y))
      .sort((a, b) => areaOf(a.polygon) - areaOf(b.polygon))
    return hits[0] ? { id: hits[0].id, size: areaOf(hits[0].polygon) } : null
  }

  get busy(): boolean {
    return !!this.draw
  }

  click(pt: { x: number; y: number } | null) {
    if (this.draw) {
      if (!pt) return
      const first = this.draw[0]
      if (this.draw.length >= MIN_VERTS && first && Math.hypot(pt.x - first[0], pt.y - first[1]) < 8) return this.closeDraw()
      this.draw.push([Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10])
      this.refreshDraw()
      this.onChange()
      return
    }
    if (!pt) return this.select(null)
    const hits = this.doc.zones.filter((z) => inside(z.polygon, pt.x, pt.y)).sort((a, b) => areaOf(a.polygon) - areaOf(b.polygon))
    this.select(hits[0]?.id ?? null)
  }

  grab(ray: THREE.Raycaster): boolean {
    if (this.draw) return false
    const hit = ray.intersectObjects(this.handles.children, false)[0]
    this.grabbed = hit ? (hit.object.userData.vertex as number) : -1
    return this.grabbed >= 0
  }

  dragTo(pt: { x: number; y: number } | null) {
    if (this.grabbed < 0 || !pt) return
    const z = this.doc.zones.find((x) => x.id === this.selected)
    if (!z) return
    z.polygon[this.grabbed] = [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10]
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
    if (e.key === 'Escape' && this.draw) { this.cancelDraw(); return true }
    if (e.key === 'Enter' && this.draw) { this.closeDraw(); return true }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.remove(this.selected); return true }
    return false
  }

  async save(): Promise<string> {
    if (this.site) this.doc.frame = frameOf(this.site.manifest)
    const report = validateZones(this.doc)
    if (report.errors.length) throw new Error(report.errors[0])
    const bytes = await saveZones(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.zones.length} zones (${bytes} bytes) to ${this.slug}/zones.json`
  }

  // --- the panel --------------------------------------------------------------------------------

  panel(root: HTMLElement, go: (z: Zone) => void) {
    root.replaceChildren()
    paneTabs(root, [{ id: 'levels', label: 'Levels' }, { id: 'placed', label: `Zones (${this.doc.zones.length})` }], this.panelTab, (id) => {
      this.panelTab = id as 'levels' | 'placed'
      this.onChange()
    })
    if (this.panelTab === 'levels') {
      this.levelsTab(root)
      return
    }
    this.placedTab(root, go)
  }

  panelTab: 'levels' | 'placed' = 'levels'
  /** the level the next drawn zone gets, from the chip that was clicked */
  private drawLevel: number | null = null

  /**
   * A traffic level dropped on a road: a zone hugging that road for two hundred metres either
   * way, at that level. Rich: *"just painting a strip of road like google maps."*
   */
  dropAt(pt: { x: number; y: number }, levelId: string): boolean {
    const level = TRAFFIC_LEVELS.find((l) => l.id === levelId)
    if (!level || !this.site) return false
    const polygon = roadStrip(this.site.chains(), pt, 200)
    if (!polygon) return false
    const id = nextId('z', this.doc.zones.map((z) => z.id))
    const zone: Zone = { id, name: `${level.label} traffic`, kind: 'traffic', polygon, traffic: { ...DEFAULT_TRAFFIC, density: level.density } }
    this.doc.zones.push(zone)
    this.dirty = true
    this.addMesh(zone)
    this.select(id)
    return true
  }

  private levelsTab(root: HTMLElement) {
    root.append(el('p', 'dim', this.draw
      ? `drawing… ${this.draw.length} pts — Enter closes it, Esc cancels`
      : 'drag a level onto a road for a strip of it, or pick one and draw the zone by hand (N)'))
    const palette = el('div', 'palette')
    for (const l of TRAFFIC_LEVELS) {
      const chip = dragChip({
        mode: 'traffic', id: l.id, label: l.label, note: l.note, on: this.drawLevel === l.density && !!this.draw,
        onClick: () => { this.drawLevel = l.density; this.startDraw() },
      })
      chip.style.borderLeft = `4px solid ${l.colour}`
      palette.append(chip)
    }
    root.append(palette)
    const tools = el('div', 'row')
    const drawBtn = el('button')
    drawBtn.textContent = this.draw ? `drawing… ${this.draw.length} pts (Enter close, Esc cancel)` : 'draw a zone (N)'
    drawBtn.onclick = () => (this.draw ? this.closeDraw() : this.startDraw())
    tools.append(drawBtn)
    root.append(tools)
  }

  private placedTab(root: HTMLElement, go: (z: Zone) => void) {
    if (this.frameWarning) {
      const b = el('div', 'framewarn')
      b.append(el('strong', '', 'zones.json was authored in a different frame'), el('span', '', this.frameWarning))
      root.append(b)
    }
    const list = el('div', 'list')
    for (const z of this.doc.zones) {
      const row = el('div', `item${z.id === this.selected ? ' sel' : ''}`)
      const swatch = el('span', 'tag')
      swatch.style.background = trafficColour(z.traffic?.density ?? 0)
      swatch.style.color = 'transparent'
      swatch.textContent = '__'
      row.append(swatch, el('span', 'nm', z.name), el('span', 'mono', `${(areaOf(z.polygon) / 1e4).toFixed(2)} ha`))
      row.onclick = () => this.select(z.id)
      row.ondblclick = () => go(z)
      list.append(row)
    }
    if (!this.doc.zones.length) {
      list.append(el('p', 'dim', 'No traffic anywhere. Draw a zone over a stretch of road and give it a level — a world with no zones has no traffic at all, which is deliberate: traffic is something a level places.'))
    }
    root.append(list)

    const z = this.doc.zones.find((x) => x.id === this.selected)
    if (!z) return
    const t = (z.traffic ??= { ...DEFAULT_TRAFFIC })

    const det = el('div', 'detail')
    det.append(el('h2', '', `${z.id} · ${z.polygon.length} vertices`))

    const name = document.createElement('input')
    name.type = 'text'
    name.value = z.name
    name.oninput = () => {
      z.name = name.value
      this.dirty = true
      for (const row of list.querySelectorAll('.item.sel .nm')) row.textContent = name.value
      this.onChange(false)
    }
    det.append(name)

    /*
     * THE SCALE, AS FIVE SWATCHES. Clear through jammed, in the colours everybody already reads.
     * Clicking one sets the density; the polygon on the map changes colour under the cursor,
     * which is the fastest possible answer to "what does this do".
     */
    det.append(el('h3', '', 'How busy'))
    det.append(this.swatches(t.density, (d) => {
      t.density = d
      if (t.densityMax !== undefined && t.densityMax < d) t.densityMax = d
      this.dirty = true
      this.refreshColours()
      this.onChange()
    }))

    /*
     * THE SWING. Off by default, because "always jammed up" is the simpler thing to author and the
     * one most zones want; on, a second row of swatches picks the ceiling and the level rolls
     * between the two when it loads.
     */
    const swingRow = el('div', 'row')
    const swing = document.createElement('input')
    swing.type = 'checkbox'
    swing.checked = t.densityMax !== undefined
    swing.onchange = () => {
      if (swing.checked) t.densityMax = Math.min(1, Math.max(t.density, t.density + 0.3))
      else delete t.densityMax
      this.dirty = true
      this.onChange()
    }
    const swingLabel = el('label', '', ' varies — roll between two levels each time the level loads')
    swingLabel.prepend(swing)
    swingRow.append(swingLabel)
    det.append(swingRow)

    if (t.densityMax !== undefined) {
      det.append(el('h3', '', 'At its worst'))
      det.append(this.swatches(t.densityMax, (d) => {
        t.densityMax = Math.max(t.density, d)
        this.dirty = true
        this.onChange()
      }))
    }

    det.append(slider('drivers who stop for a red', t.obeyRate ?? 0.97, 0, 1, 0.01, 0.97,
      'the one that makes a junction feel unsafe rather than mechanical', (v) => {
        t.obeyRate = v
        this.dirty = true
        this.onChange(false)
      }))
    det.append(slider('speed, × the limit', t.speedFactor ?? 1, 0.4, 1.6, 0.01, 1,
      'a road nobody obeys, or a crawl', (v) => {
        t.speedFactor = v
        this.dirty = true
        this.onChange(false)
      }))

    // WHAT IT WILL ACTUALLY DO, in a sentence, including the number of cars per kilometre.
    det.append(el('p', 'dim', describeTraffic(t)))
    root.append(det)
  }

  /** The five-level colour scale as clickable swatches. */
  private swatches(value: number, pick: (density: number) => void): HTMLElement {
    const row = el('div', 'row swatches')
    for (const level of TRAFFIC_LEVELS) {
      const b = el('button', Math.abs(level.density - value) < 1e-6 ? 'swatch on' : 'swatch')
      b.style.background = level.colour
      b.title = `${level.label} — ${level.note}`
      b.textContent = level.label
      b.onclick = () => pick(level.density)
      row.append(b)
    }
    return row
  }
}
