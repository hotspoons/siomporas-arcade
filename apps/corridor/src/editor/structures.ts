// Authored structures: what the road does where the lidar could not tell.
//
// Bowie's horse bridge is the case that made this mode: a covered bridleway crosses Race Track
// Road at s≈2351, the 2014 lidar under it is junk, and OSM knows only that something crosses.
// Nothing measured will ever produce a dark timber box over the road there — a human has to say
// "a bridge, here, this high" — so this mode authors INTERVALS on the spine, not polygons: an
// along-track [s_start, s_end] and a kind. Along-track metres survive a re-bake that moves the
// centreline sideways; an x/y footprint would leave the bridge beside the road.
//
// Everything drawn here goes through the viewer's own `buildBridges` (src/structures.ts), so the
// bridge the editor shows is the bridge the game shows — same fit, same abutments, same slab
// stand-in when the asset has no model yet. `flatten` cannot be previewed live: the viewer applies
// it to the spline before the scene is built, so its ribbon marks the interval and the grade
// changes on the next reload.
import * as THREE from 'three'
import { pavedWidth } from '../props'
import type { Site } from '../scene'
import { buildBridges } from '../structures'
import type { CatalogEntry as ViewerCatalogEntry } from '../placements'
import type { Catalog, CatalogEntry } from './catalog'
import { handleMesh } from './drape'
import { loadStructures, nextId, saveStructures, STRUCTURE_KINDS, type StructureItem, type StructureKind, type Structures } from './schema'
import { el } from './ui'

const COLOR: Record<StructureKind, number> = { bridge_over: 0xd98c3f, flatten: 0xffdc00, suppress: 0xe2564f }
const SELECT = 0x2ee6c0
const PICK = 0xff8a2b
const STEP = 2 // m between spine samples, for the station table and the ribbons
const DEFAULT_CLEARANCE = 4.5
const SPAN_MARGIN = 6 // m added to the paved width for a default span: verge and abutment each side

export class StructureMode {
  group = new THREE.Group()
  doc: Structures = { version: 1, items: [] }
  dirty = false
  selected: string | null = null
  catalog: Catalog = { assets: [] }

  private slug = ''
  private site: Site | null = null
  /** spine samples every STEP m, world frame — the click snaps to the nearest of these */
  private table: { s: number; x: number; z: number }[] = []
  private ribbons = new Map<string, THREE.Mesh>()
  private bridges = new Map<string, THREE.Group>()
  /** build serial per bridge: a slow model load must not land on top of a newer rebuild */
  private builds = new Map<string, number>()
  private handles = new THREE.Group()
  private pickGroup = new THREE.Group()
  /** picking an interval: null = not picking, `{ s0: null }` = waiting for the first click */
  private pick: { s0: number | null } | null = null
  private grabbed: 'start' | 'end' | null = null
  /** `false` = only a value changed; the panel must not be rebuilt under the pointer. */
  private onChange: (structural?: boolean) => void
  /** the panel's live readout while picking: "s 2351.5 · paved 9.1 m" */
  private hover: HTMLElement | null = null

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'authored-structures'
    this.group.add(this.handles, this.pickGroup)
    this.onChange = onChange
  }

  async load(slug: string, site: Site, catalog: Catalog) {
    this.slug = slug
    this.site = site
    this.catalog = catalog
    this.pick = null
    this.selected = null
    this.grabbed = null
    this.table = []
    const len = site.manifest.spine.length_m
    for (let s = 0; s <= len + 1e-6; s += STEP) {
      const p = site.spineAt(Math.min(s, len)).pos
      this.table.push({ s: Math.min(s, len), x: p.x, z: p.z })
    }
    this.doc = await loadStructures(slug)
    this.dirty = false
    await this.rebuild()
  }

  get picking() {
    return this.pick !== null
  }

  // --- the spine -------------------------------------------------------------------------------
  /**
   * Snap a ground point to the spine: the along-track s of the nearest point on it, and how far
   * the click was from the centreline (signed, left of travel positive — the manifest's convention).
   * Nearest sample first, then the exact foot on the segment either side of it.
   */
  nearest(x: number, y: number): { s: number; lateral: number } {
    const z = -y
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < this.table.length; i++) {
      const t = this.table[i]
      const d = (t.x - x) ** 2 + (t.z - z) ** 2
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    let best = { s: this.table[bi]?.s ?? 0, lateral: Math.sqrt(bd) }
    for (const j of [bi - 1, bi + 1]) {
      const a = this.table[bi], b = this.table[j]
      if (!a || !b) continue
      const dx = b.x - a.x, dz = b.z - a.z
      const L2 = dx * dx + dz * dz
      if (L2 < 1e-9) continue
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2))
      const fx = a.x + dx * u, fz = a.z + dz * u
      const d = Math.hypot(x - fx, z - fz)
      if (d < best.lateral) {
        // sign: which side of the travel direction the click is on (left positive)
        const cross = dx * (z - fz) - dz * (x - fx)
        best = { s: a.s + (b.s - a.s) * u, lateral: d * (cross > 0 ? 1 : -1) }
      }
    }
    return { s: Math.round(best.s * 10) / 10, lateral: best.lateral }
  }

  /**
   * Paved width at station s, from the same OSM tags the viewer paves from (scene.ts::lanesAt /
   * twoWayAt — replicated, because `Site` does not expose them). A two-way road carries an outer
   * shoulder each side; a one-way carriageway an inner one on the median side.
   */
  pavedWidthAt(s: number): number {
    const segs = this.site?.manifest.spine.segments ?? []
    const tg = segs.find((g) => g.s_start - 0.5 <= s && s <= g.s_end + 0.5)?.tags ?? {}
    const n = Number(tg.lanes)
    const lanes = Number.isFinite(n) && n > 0 ? n : 2
    let twoWay = !['motorway', 'motorway_link', 'trunk_link', 'primary_link'].includes(tg.highway ?? '')
    if (tg.oneway === 'yes' || tg.oneway === '-1') twoWay = false
    if (tg.oneway === 'no') twoWay = true
    return pavedWidth(lanes, twoWay)
  }

  /** The brief's default: the pavement plus a verge and an abutment each side. */
  defaultSpan(s: number): number {
    return Math.round((this.pavedWidthAt(s) + SPAN_MARGIN) * 10) / 10
  }

  private roadY(s: number): number {
    return this.site?.spineAt(s).pos.y ?? 0
  }

  // --- geometry ----------------------------------------------------------------------------------
  private colorFor(it: StructureItem) {
    return it.id === this.selected ? SELECT : COLOR[it.kind]
  }

  /** A translucent strip lying on the pavement between the two ends, as wide as the road. */
  private ribbonMesh(it: StructureItem): THREE.Mesh {
    const site = this.site!
    const a = Math.min(it.s_start, it.s_end), b = Math.max(it.s_start, it.s_end)
    const pos: number[] = []
    const idx: number[] = []
    const n = Math.max(1, Math.ceil((b - a) / STEP))
    for (let i = 0; i <= n; i++) {
      const s = a + ((b - a) * i) / n
      const { pos: p, dir } = site.spineAt(s)
      const half = this.pavedWidthAt(s) / 2 + 0.6
      const sx = -dir.z, sz = dir.x
      const k = 1 / (Math.hypot(sx, sz) || 1)
      // spineAt already floats a hand above the pavement; a little more keeps the strip off it
      pos.push(p.x - sx * k * half, p.y + 0.25, p.z - sz * k * half, p.x + sx * k * half, p.y + 0.25, p.z + sz * k * half)
      if (i < n) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: this.colorFor(it), transparent: true, opacity: it.id === this.selected ? 0.4 : 0.22, side: THREE.DoubleSide, depthWrite: false }))
    m.renderOrder = 10
    m.userData.structureId = it.id
    return m
  }

  private async rebuild() {
    for (const m of this.ribbons.values()) {
      m.geometry.dispose()
      this.group.remove(m)
    }
    this.ribbons.clear()
    for (const b of this.bridges.values()) this.group.remove(b)
    this.bridges.clear()
    this.builds.clear()
    await Promise.all(this.doc.items.map((it) => this.remesh(it.id)))
    this.refreshHandles()
    this.refreshPick()
  }

  /** Rebuild one item's ribbon and (for a bridge) its model. Async only because a model may load. */
  private async remesh(id: string) {
    const old = this.ribbons.get(id)
    if (old) {
      old.geometry.dispose()
      this.group.remove(old)
      this.ribbons.delete(id)
    }
    const ob = this.bridges.get(id)
    if (ob) {
      this.group.remove(ob)
      this.bridges.delete(id)
    }
    const it = this.doc.items.find((x) => x.id === id)
    if (!it || !this.site) return
    const ribbon = this.ribbonMesh(it)
    this.group.add(ribbon)
    this.ribbons.set(id, ribbon)
    if (it.kind !== 'bridge_over') return
    const serial = (this.builds.get(id) ?? 0) + 1
    this.builds.set(id, serial)
    const site = this.site
    // The viewer's builder, so the editor never shows a bridge the game would draw differently.
    const cat = new Map<string, ViewerCatalogEntry>()
    for (const a of this.catalog.assets) cat.set(a.id, a)
    const g = await buildBridges([it], cat, (s) => site.spineAt(s), (x, z) => site.groundAt(x, z) ?? site.heightAt(x, -z), (s) => this.pavedWidthAt(s))
    if (this.builds.get(id) !== serial || !this.doc.items.includes(it)) return // superseded meanwhile
    g.traverse((o) => (o.userData.structureId = id))
    this.group.add(g)
    this.bridges.set(id, g)
  }

  private refreshColors() {
    for (const it of this.doc.items) {
      const m = this.ribbons.get(it.id)
      if (!m) continue
      const mat = m.material as THREE.MeshBasicMaterial
      mat.color.setHex(this.colorFor(it))
      mat.opacity = it.id === this.selected ? 0.4 : 0.22
    }
  }

  /** Two draggable spheres on the spine at the selected interval's ends. */
  private refreshHandles() {
    this.handles.clear()
    const it = this.doc.items.find((x) => x.id === this.selected)
    if (!it || !this.site) return
    for (const end of ['start', 'end'] as const) {
      const s = end === 'start' ? it.s_start : it.s_end
      const p = this.site.spineAt(s).pos
      const m = handleMesh(SELECT)
      m.position.set(p.x, p.y + 0.8, p.z)
      m.userData = { end }
      this.handles.add(m)
    }
  }

  private refreshPick() {
    this.pickGroup.clear()
    if (!this.pick || this.pick.s0 === null || !this.site) return
    const p = this.site.spineAt(this.pick.s0).pos
    const m = handleMesh(PICK, 1.8)
    m.position.set(p.x, p.y + 0.8, p.z)
    this.pickGroup.add(m)
  }

  // --- editing -------------------------------------------------------------------------------------
  startPick() {
    this.pick = { s0: null }
    this.select(null)
    this.refreshPick()
    this.onChange()
  }

  cancelPick() {
    this.pick = null
    this.refreshPick()
    this.onChange()
  }

  /** A crossing OSM knows about inside the interval names the new structure, when there is one. */
  private nameFor(a: number, b: number, kind: StructureKind): string {
    const c = this.site?.manifest.crossings.find((x) => x.relation === 'over' && x.s >= a - 5 && x.s <= b + 5)
    if (c) return `${c.name ?? c.kind ?? 'crossing'} over`
    return kind === 'bridge_over' ? 'new bridge' : STRUCTURE_KINDS.find((k) => k.kind === kind)?.label ?? kind
  }

  private bridgeDefaults(it: StructureItem) {
    const mid = (it.s_start + it.s_end) / 2
    it.clearance_m ??= DEFAULT_CLEARANCE
    it.asset ??= this.bridgeAssets()[0]?.id
    it.span_m ??= this.defaultSpan(mid)
    it.yaw_offset_deg ??= 0
  }

  bridgeAssets(): CatalogEntry[] {
    return this.catalog.assets.filter((a) => a.category === 'bridge')
  }

  private async add(s0: number, s1: number) {
    const a = Math.min(s0, s1), b = Math.max(s0, s1)
    if (b - a < 0.5) return
    const it: StructureItem = { id: nextId('st', this.doc.items.map((i) => i.id)), name: this.nameFor(a, b, 'bridge_over'), kind: 'bridge_over', s_start: a, s_end: b }
    this.bridgeDefaults(it)
    this.doc.items.push(it)
    this.dirty = true
    await this.remesh(it.id)
    this.select(it.id)
  }

  select(id: string | null) {
    this.selected = id
    this.refreshColors()
    this.refreshHandles()
    this.onChange()
  }

  remove(id: string) {
    this.doc.items = this.doc.items.filter((i) => i.id !== id)
    void this.remesh(id) // with the item gone this only takes the meshes down
    this.dirty = true
    if (this.selected === id) this.select(null)
    else this.onChange()
  }

  /** Change the selected item and redraw it; `structural` when the panel's shape changes too. */
  private mutate(fn: (it: StructureItem) => void, structural = false) {
    const it = this.doc.items.find((x) => x.id === this.selected)
    if (!it) return
    fn(it)
    if (it.s_end < it.s_start) [it.s_start, it.s_end] = [it.s_end, it.s_start]
    this.dirty = true
    void this.remesh(it.id).then(() => this.refreshColors())
    this.refreshHandles()
    this.onChange(structural)
  }

  setKind(kind: StructureKind) {
    this.mutate((it) => {
      it.kind = kind
      if (kind === 'bridge_over') this.bridgeDefaults(it)
      else {
        delete it.clearance_m
        delete it.asset
        delete it.span_m
        delete it.yaw_offset_deg
      }
    }, true)
  }

  // --- input, delegated from main -------------------------------------------------------------------
  /** A click on the ground: an interval end while picking, else select the interval under it. */
  click(pt: { x: number; y: number } | null) {
    if (this.pick) {
      if (!pt) return
      const { s } = this.nearest(pt.x, pt.y)
      if (this.pick.s0 === null) {
        this.pick.s0 = s
        this.refreshPick()
        this.onChange()
        return
      }
      const s0 = this.pick.s0
      this.pick = null
      this.refreshPick()
      void this.add(s0, s)
      return
    }
    if (!pt) return this.select(null)
    const { s, lateral } = this.nearest(pt.x, pt.y)
    if (Math.abs(lateral) > this.pavedWidthAt(s) / 2 + 4) return this.select(null)
    // shortest interval wins, so a bridge inside a long flatten is still reachable
    const hits = this.doc.items.filter((i) => s >= i.s_start - 1 && s <= i.s_end + 1).sort((p, q) => p.s_end - p.s_start - (q.s_end - q.s_start))
    this.select(hits[0]?.id ?? null)
  }

  /** Track the pointer while picking so the panel can show where the click would land. */
  hoverAt(pt: { x: number; y: number } | null) {
    if (!this.hover) return
    if (!pt) {
      this.hover.textContent = ''
      return
    }
    const { s } = this.nearest(pt.x, pt.y)
    this.hover.textContent = `s ${s.toFixed(1)} · paved ${this.pavedWidthAt(s).toFixed(1)} m · road z ${(this.roadY(s) - 0.4).toFixed(2)}`
  }

  /** Did the pointer land on an end handle? Then the drag is ours and orbit stands down. */
  grab(ray: THREE.Raycaster): boolean {
    if (this.pick) return false
    const hit = ray.intersectObjects(this.handles.children, false)[0]
    this.grabbed = hit ? (hit.object.userData.end as 'start' | 'end') : null
    return this.grabbed !== null
  }

  dragTo(pt: { x: number; y: number } | null) {
    if (!this.grabbed || !pt) return
    const { s } = this.nearest(pt.x, pt.y)
    const end = this.grabbed
    const it = this.doc.items.find((x) => x.id === this.selected)
    if (!it) return
    if (end === 'start') it.s_start = s
    else it.s_end = s
    this.dirty = true
    // move the sphere now; the ribbon and bridge rebuild on drop — a model load per pointer move is not authoring
    const m = this.handles.children.find((h) => h.userData.end === end)
    const p = this.site?.spineAt(s).pos
    if (m && p) m.position.set(p.x, p.y + 0.8, p.z)
    this.onChange(false)
  }

  drop() {
    if (!this.grabbed) return
    this.grabbed = null
    this.mutate(() => {}, true)
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.pick) {
      this.cancelPick()
      return true
    }
    if (!this.selected) return false
    switch (e.key) {
      case 'Delete': case 'Backspace': this.remove(this.selected); return true
      case 'Escape': this.select(null); return true
      case 'q': case 'Q': this.spin(e.shiftKey ? -15 : -1); return true
      case 'e': case 'E': this.spin(e.shiftKey ? 15 : 1); return true
    }
    return false
  }

  private spin(d: number) {
    this.mutate((it) => {
      if (it.kind === 'bridge_over') it.yaw_offset_deg = ((it.yaw_offset_deg ?? 0) + d + 540) % 360 - 180
    })
  }

  /** Points along the selected interval, for main's flyTo. */
  flyToSelected(fly: (pts: [number, number][]) => void) {
    const it = this.doc.items.find((x) => x.id === this.selected)
    if (!it || !this.site) return
    const pts: [number, number][] = []
    const pad = Math.max(20, (it.span_m ?? 0) / 2)
    for (const s of [it.s_start - pad, (it.s_start + it.s_end) / 2, it.s_end + pad]) {
      const p = this.site.spineAt(Math.max(0, s)).pos
      pts.push([p.x - pad, -p.z - pad], [p.x + pad, -p.z + pad])
    }
    fly(pts)
  }

  async save(): Promise<string> {
    const bytes = await saveStructures(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.items.length} structures (${bytes} bytes) to ${this.slug}/structures.json — reload the viewer to see a flatten`
  }

  // --- panel ------------------------------------------------------------------------------------------
  panel(root: HTMLElement, fly: (pts: [number, number][]) => void) {
    root.replaceChildren()
    const tools = el('div', 'row')
    const pickBtn = el('button')
    if (!this.pick) pickBtn.textContent = 'pick interval (N)'
    else if (this.pick.s0 === null) pickBtn.textContent = 'click the road where the interval STARTS (Esc cancels)'
    else pickBtn.textContent = `start s ${this.pick.s0.toFixed(1)} — click where it ENDS`
    pickBtn.onclick = () => (this.pick ? this.cancelPick() : this.startPick())
    tools.append(pickBtn)
    root.append(tools)
    this.hover = el('p', 'dim mono')
    this.hover.style.minHeight = '1.2em'
    root.append(this.hover)

    const list = el('div', 'list')
    for (const it of this.doc.items) {
      const row = el('div', `item${it.id === this.selected ? ' sel' : ''}`)
      const tag = el('span', 'tag', STRUCTURE_KINDS.find((k) => k.kind === it.kind)?.label ?? it.kind)
      tag.style.color = `#${new THREE.Color(COLOR[it.kind]).getHexString()}`
      row.append(tag, el('span', 'nm', it.name), el('span', 'mono', `s ${it.s_start.toFixed(0)}–${it.s_end.toFixed(0)}`))
      row.onclick = () => this.select(it.id)
      row.ondblclick = () => {
        this.select(it.id)
        this.flyToSelected(fly)
      }
      list.append(row)
    }
    if (!this.doc.items.length) list.append(el('p', 'dim', 'Nothing authored yet. Pick an interval: two clicks on the road, start then end.'))
    root.append(list)

    const it = this.doc.items.find((x) => x.id === this.selected)
    if (!it) return
    const det = el('div', 'detail')
    const mid = (it.s_start + it.s_end) / 2
    det.append(el('h2', '', `${it.id} · ${(it.s_end - it.s_start).toFixed(1)} m along the road · paved ${this.pavedWidthAt(mid).toFixed(1)} m here`))
    const name = document.createElement('input')
    name.type = 'text'
    name.value = it.name
    name.oninput = () => {
      it.name = name.value
      this.dirty = true
      for (const row of list.querySelectorAll('.item.sel .nm')) row.textContent = name.value
      this.onChange(false)
    }
    det.append(name)

    const kind = el('label', 'field')
    kind.append(el('span', '', 'kind'))
    const sel = document.createElement('select')
    for (const k of STRUCTURE_KINDS) {
      const o = document.createElement('option')
      o.value = k.kind
      o.textContent = k.label
      o.title = k.note
      sel.append(o)
    }
    sel.value = it.kind
    sel.title = STRUCTURE_KINDS.find((k) => k.kind === it.kind)?.note ?? ''
    sel.onchange = () => this.setKind(sel.value as StructureKind)
    kind.append(sel)
    det.append(kind)

    det.append(this.num('s start (m)', it.s_start, 0.5, (v) => this.mutate((q) => (q.s_start = v))))
    det.append(this.num('s end (m)', it.s_end, 0.5, (v) => this.mutate((q) => (q.s_end = v))))

    if (it.kind === 'bridge_over') {
      det.append(this.num('clearance (m above road)', it.clearance_m ?? DEFAULT_CLEARANCE, 0.1, (v) => this.mutate((q) => (q.clearance_m = v))))
      const asset = el('label', 'field')
      asset.append(el('span', '', 'asset'))
      const as = document.createElement('select')
      for (const a of this.bridgeAssets()) {
        const o = document.createElement('option')
        o.value = a.id
        o.textContent = `${a.name}${a.glb ? '' : ' · slab stand-in'}`
        as.append(o)
      }
      if (!this.bridgeAssets().length) {
        const o = document.createElement('option')
        o.value = ''
        o.textContent = '(no catalog entry has category "bridge")'
        as.append(o)
      }
      as.value = it.asset ?? ''
      as.onchange = () => this.mutate((q) => (q.asset = as.value || undefined))
      asset.append(as)
      det.append(asset)

      const span = this.num('span (m, long axis)', it.span_m ?? this.defaultSpan(mid), 0.5, (v) => this.mutate((q) => (q.span_m = v)))
      const dflt = el('button')
      dflt.textContent = `= paved + ${SPAN_MARGIN} (${this.defaultSpan(mid)})`
      dflt.title = 'the paved width at the middle of the interval plus a verge and an abutment each side'
      dflt.onclick = () => this.mutate((q) => (q.span_m = this.defaultSpan(mid)), true)
      span.append(dflt)
      det.append(span)
      det.append(this.num('yaw offset° (Q/E)', it.yaw_offset_deg ?? 0, 1, (v) => this.mutate((q) => (q.yaw_offset_deg = v))))
      const road = this.roadY(mid) - 0.4
      det.append(el('p', 'dim', `road z ${road.toFixed(2)} at s ${mid.toFixed(1)} → deck underside z ${(road + (it.clearance_m ?? DEFAULT_CLEARANCE)).toFixed(2)}`))
    } else if (it.kind === 'flatten') {
      const z0 = this.roadY(it.s_start) - 0.4, z1 = this.roadY(it.s_end) - 0.4
      det.append(el('p', 'dim', `grade will run straight from z ${z0.toFixed(2)} to z ${z1.toFixed(2)} (${(((z1 - z0) / Math.max(1, it.s_end - it.s_start)) * 100).toFixed(1)} %). The viewer applies it on reload; this page still shows the measured grade.`))
    } else {
      const n = this.site?.manifest.structures.filter((st) => st.s_start >= it.s_start - 1 && st.s_end <= it.s_end + 1).length ?? 0
      det.append(el('p', 'dim', `${n} detected structure${n === 1 ? '' : 's'} inside this interval will be ignored on reload.`))
    }

    const acts = el('div', 'row')
    const go = el('button')
    go.textContent = 'fly to (F)'
    go.onclick = () => this.flyToSelected(fly)
    const del = el('button', 'danger')
    del.textContent = 'delete (Del)'
    del.onclick = () => this.remove(it.id)
    acts.append(go, del)
    det.append(acts)
    root.append(det)
  }

  private num(label: string, value: number, step: number, set: (v: number) => void) {
    const wrap = el('label', 'field')
    wrap.append(el('span', '', label))
    const i = document.createElement('input')
    i.type = 'number'
    i.step = String(step)
    i.value = String(Math.round(value * 100) / 100)
    i.onchange = () => {
      const v = Number(i.value)
      if (Number.isFinite(v)) set(v)
    }
    wrap.append(i)
    return wrap
  }
}
