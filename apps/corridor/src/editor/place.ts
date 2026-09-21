// Placement: put catalog objects beside the road, free-form.
//
// Unlike the Drivin' editor there is no grid and no snapping to a spline — a real roadside is
// nothing but odd angles and odd setbacks, and the whole reason for shooting these corridors was
// to stop inventing that. So: any position, any yaw, any scale, and the only snap is to the
// ground, which is on by default because nothing beside a road floats.
//
// Height is NOT authored by default: `z: null` means "the viewer resolves it from site.groundAt",
// so a re-bake with a better DEM moves the diner with the hillside instead of burying it.
import * as THREE from 'three'
import { instanceOf, loadCatalog, tintOf, type Catalog, type CatalogEntry } from './catalog'
import { isGenerated, loadPlacements, nextId, savePlacements, type Placement, type Placements } from './schema'
import { yawFacingRoad } from './corridor'
import { el } from './ui'
import type { Site } from '../scene'

const SELECT = 0x2ee6c0

export class PlaceMode {
  group = new THREE.Group()
  doc: Placements = { version: 1, items: [] }
  dirty = false
  selected: string | null = null
  catalog: Catalog = { assets: [] }

  private slug = ''
  private site: Site | null = null
  /** the surface the game stands things on — scene.ts's `groundAt`, not the bare DEM */
  private ground: (x: number, y: number) => number = () => 0
  private objects = new Map<string, THREE.Object3D>()
  private ring = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1, 56), // a hairline annulus: scaled to the footprint it must not become a disc
    new THREE.MeshBasicMaterial({ color: SELECT, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }),
  )
  private nose = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 10, SELECT, 4, 2.4)
  private armed: string | null = null
  private grabbed: string | null = null
  /** `false` = only a value changed; the panel must not be rebuilt under the pointer. */
  private onChange: (structural?: boolean) => void

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'placements'
    this.ring.rotation.x = -Math.PI / 2
    this.ring.renderOrder = 12
    this.ring.visible = false
    this.nose.visible = false
    for (const m of this.nose.children) (m as THREE.Mesh).renderOrder = 12
    this.group.add(this.ring, this.nose)
    this.onChange = onChange
  }

  async load(slug: string, site: Site, ground: (x: number, y: number) => number) {
    this.slug = slug
    this.site = site
    this.ground = ground
    if (!this.catalog.assets.length) this.catalog = await loadCatalog()
    this.doc = await loadPlacements(slug)
    this.dirty = false
    this.selected = null
    for (const o of this.objects.values()) this.group.remove(o)
    this.objects.clear()
    await Promise.all(this.doc.items.map((p) => this.spawn(p)))
    this.markSelected()
  }

  /**
   * Rebuild every object from the document. Autogen rewrites `doc.items` wholesale, and the
   * scene has to follow it — the alternative is a diff, and a diff that is wrong leaves a ghost
   * building in the world with nothing behind it.
   */
  async respawn() {
    for (const o of this.objects.values()) this.group.remove(o)
    this.objects.clear()
    await Promise.all(this.doc.items.map((p) => this.spawn(p)))
    if (this.selected && !this.objects.has(this.selected)) this.selected = null
    this.markSelected()
  }

  /** The catalog, for the modes that generate against it. */
  get assets(): CatalogEntry[] {
    return this.catalog.assets
  }

  private entry(id: string): CatalogEntry | undefined {
    return this.catalog.assets.find((a) => a.id === id)
  }

  /** Ground height under a placement, or its authored z when it has one. */
  private zOf(p: Placement): number {
    return p.z ?? this.ground(p.x, p.y)
  }

  private place(o: THREE.Object3D, p: Placement) {
    o.position.set(p.x, this.zOf(p), -p.y)
    // MINUS. `yaw_deg` is a compass bearing (0 = north = world −Z, 90 = east = +X) and three
    // rotates a local −Z front to (−sinθ, 0, −cosθ), so θ = −yaw. The viewer's placements.ts uses
    // the same sign; with `+` here the editor drew every asymmetric model mirrored against the
    // game, and the selection arrow — built from the compass bearing — disagreed with it.
    o.rotation.y = -(p.yaw_deg * Math.PI) / 180
    o.scale.setScalar(p.scale)
  }

  private async spawn(p: Placement) {
    const e = this.entry(p.asset)
    if (!e) return
    const o = await instanceOf(e)
    o.userData.placeId = p.id
    o.traverse((c) => (c.userData.placeId = p.id))
    this.place(o, p)
    this.objects.set(p.id, o)
    this.group.add(o)
  }

  private markSelected() {
    const p = this.doc.items.find((x) => x.id === this.selected)
    const e = p && this.entry(p.asset)
    this.ring.visible = this.nose.visible = !!p
    if (!p || !e) return
    const r = (Math.max(e.footprint_m[0], e.footprint_m[1]) / 2 + 3) * p.scale
    this.ring.scale.setScalar(r)
    this.ring.position.set(p.x, this.zOf(p) + 0.6, -p.y)
    const yaw = (p.yaw_deg * Math.PI) / 180
    this.nose.position.copy(this.ring.position)
    this.nose.setDirection(new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw)))
    this.nose.setLength(r + 12, 5, 3)
  }

  // --- editing ---------------------------------------------------------------------------------
  arm(assetId: string | null) {
    this.armed = this.armed === assetId ? null : assetId
    this.onChange()
  }

  get arming() {
    return this.armed
  }

  select(id: string | null) {
    this.selected = id
    this.markSelected()
    this.onChange()
  }

  private async add(assetId: string, x: number, y: number) {
    const e = this.entry(assetId)
    if (!e) return
    const p: Placement = {
      id: nextId('p', this.doc.items.map((i) => i.id)),
      asset: assetId,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      z: null,
      yaw_deg: this.yawOfRoad(x, y),
      scale: 1,
      snap: 'ground',
      tags: [e.category],
    }
    this.doc.items.push(p)
    this.dirty = true
    await this.spawn(p)
    this.select(p.id)
  }

  /**
   * A new building faces the road. Finding the nearest station by brute force over the spine is
   * fine at authoring rates, and it beats the alternative — every placement starting at yaw 0 and
   * the human turning each one by hand.
   */
  private yawOfRoad(x: number, y: number): number {
    return this.site ? yawFacingRoad(this.site, x, y) : 0
  }

  remove(id: string) {
    // A deleted generated item is remembered, or the next generate puts it straight back.
    if (id.startsWith('g-')) {
      this.doc.autogen ??= { params: {}, deleted: [] }
      if (!this.doc.autogen.deleted.includes(id)) this.doc.autogen.deleted.push(id)
    }
    const o = this.objects.get(id)
    if (o) this.group.remove(o)
    this.objects.delete(id)
    this.doc.items = this.doc.items.filter((p) => p.id !== id)
    this.dirty = true
    if (this.selected === id) this.select(null)
    else this.onChange()
  }

  private mutate(fn: (p: Placement) => void) {
    const p = this.doc.items.find((x) => x.id === this.selected)
    if (!p) return
    fn(p)
    // A generated item the human has moved is now the human's. Regeneration will skip it.
    if (isGenerated(p)) p.locked = true
    const o = this.objects.get(p.id)
    if (o) this.place(o, p)
    this.dirty = true
    this.markSelected()
  }

  // --- input -------------------------------------------------------------------------------------
  click(pt: { x: number; y: number } | null) {
    if (!pt) return this.select(null)
    if (this.armed) return void this.add(this.armed, pt.x, pt.y)
    this.select(null)
  }

  /** Press on an object to select and drag it in one gesture, the way every level editor does. */
  grab(ray: THREE.Raycaster): boolean {
    if (this.armed) return false
    const hit = ray.intersectObjects([...this.objects.values()], true)[0]
    const id = hit?.object.userData.placeId as string | undefined
    if (!id) return false
    if (id !== this.selected) this.select(id)
    this.grabbed = id
    return true
  }

  dragTo(pt: { x: number; y: number } | null) {
    if (!this.grabbed || !pt) return
    this.selected = this.grabbed
    this.mutate((p) => {
      p.x = Math.round(pt.x * 10) / 10
      p.y = Math.round(pt.y * 10) / 10
    })
    this.onChange(false)
  }

  drop() {
    this.grabbed = null
    this.onChange()
  }

  wheel(e: WheelEvent): boolean {
    if (!this.selected) return false
    this.mutate((p) => (p.yaw_deg = (p.yaw_deg + (e.deltaY > 0 ? 5 : -5) + 360) % 360))
    this.onChange()
    return true
  }

  key(e: KeyboardEvent): boolean {
    if (!this.selected) {
      if (e.key === 'Escape' && this.armed) {
        this.arm(null)
        return true
      }
      return false
    }
    const spin = (d: number) => this.mutate((p) => (p.yaw_deg = (p.yaw_deg + d + 360) % 360))
    const zoom = (k: number) => this.mutate((p) => (p.scale = Math.max(0.1, Math.min(10, Math.round(p.scale * k * 100) / 100))))
    switch (e.key) {
      case 'q': case 'Q': spin(e.shiftKey ? -45 : -5); return true
      case 'e': case 'E': spin(e.shiftKey ? 45 : 5); return true
      case '[': zoom(1 / 1.1); return true
      case ']': zoom(1.1); return true
      case 'Delete': case 'Backspace': this.remove(this.selected); return true
      case 'Escape': this.arm(null); this.select(null); return true
    }
    return false
  }

  flyToSelected(fly: (pts: [number, number][]) => void) {
    const p = this.doc.items.find((x) => x.id === this.selected)
    const e = p && this.entry(p.asset)
    if (!p || !e) return
    const r = (Math.max(...e.footprint_m) * p.scale) / 2 + 20
    fly([[p.x - r, p.y - r], [p.x + r, p.y + r]])
  }

  async save(): Promise<string> {
    const bytes = await savePlacements(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.items.length} placements (${bytes} bytes) to ${this.slug}/placements.json`
  }

  // --- panel ---------------------------------------------------------------------------------------
  panel(root: HTMLElement, fly: (pts: [number, number][]) => void) {
    root.replaceChildren()
    root.append(el('h2', '', this.armed ? 'click the ground to place' : 'pick an asset, then click the ground'))
    const pal = el('div', 'palette')
    for (const a of this.catalog.assets) {
      const b = el('button', `chip${this.armed === a.id ? ' on' : ''}`)
      b.style.borderLeft = `4px solid #${new THREE.Color(tintOf(a.category)).getHexString()}`
      b.append(el('span', 'nm', a.name), el('span', 'mono', `${a.footprint_m[0]}×${a.footprint_m[1]} m${a.glb ? '' : ' · box'}`))
      b.onclick = () => this.arm(a.id)
      pal.append(b)
    }
    if (!this.catalog.assets.length) pal.append(el('p', 'dim', 'No catalog. Expected public/assets/catalog.json.'))
    root.append(pal)

    const list = el('div', 'list')
    for (const p of this.doc.items) {
      const e = this.entry(p.asset)
      const row = el('div', `item${p.id === this.selected ? ' sel' : ''}`)
      row.append(el('span', 'tag', p.id), el('span', 'nm', e?.name ?? p.asset), el('span', 'mono', `${p.yaw_deg}° ×${p.scale}`))
      row.onclick = () => this.select(p.id)
      row.ondblclick = () => {
        this.select(p.id)
        this.flyToSelected(fly)
      }
      list.append(row)
    }
    if (!this.doc.items.length) list.append(el('p', 'dim', 'Nothing placed yet.'))
    root.append(list)

    const p = this.doc.items.find((x) => x.id === this.selected)
    if (!p) return
    const det = el('div', 'detail')
    det.append(el('h2', '', `${p.id} · ${this.entry(p.asset)?.name ?? p.asset}`))
    det.append(this.num('x (m east)', p.x, 0.5, (v) => this.mutate((q) => (q.x = v))))
    det.append(this.num('y (m north)', p.y, 0.5, (v) => this.mutate((q) => (q.y = v))))
    det.append(this.num('yaw°  (Q/E, shift+wheel)', p.yaw_deg, 1, (v) => this.mutate((q) => (q.yaw_deg = v))))
    det.append(this.num('scale  ([ / ])', p.scale, 0.05, (v) => this.mutate((q) => (q.scale = v))))

    const snap = el('label', 'field')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = p.snap === 'ground'
    cb.onchange = () => this.mutate((q) => {
      q.snap = cb.checked ? 'ground' : 'free'
      q.z = cb.checked ? null : this.ground(q.x, q.y)
      this.onChange()
    })
    snap.append(el('span', '', 'snap to ground'), cb)
    det.append(snap)
    if (p.z !== null) det.append(this.num('z (m)', p.z, 0.25, (v) => this.mutate((q) => (q.z = v))))

    const tags = el('label', 'field')
    const ti = document.createElement('input')
    ti.type = 'text'
    ti.value = p.tags.join(', ')
    ti.oninput = () => {
      p.tags = ti.value.split(',').map((t) => t.trim()).filter(Boolean)
      if (isGenerated(p)) p.locked = true
      this.dirty = true
      this.onChange(false)
    }
    tags.append(el('span', '', 'tags'), ti)
    det.append(tags)

    const acts = el('div', 'row')
    const go = el('button')
    go.textContent = 'fly to (F)'
    go.onclick = () => this.flyToSelected(fly)
    const dup = el('button')
    dup.textContent = 'duplicate'
    dup.onclick = () => void this.duplicate(p)
    const del = el('button', 'danger')
    del.textContent = 'delete (Del)'
    del.onclick = () => this.remove(p.id)
    acts.append(go, dup, del)
    det.append(acts)
    root.append(det)
  }

  private async duplicate(p: Placement) {
    const copy: Placement = { ...p, id: nextId('p', this.doc.items.map((i) => i.id)), x: p.x + 30, tags: [...p.tags] }
    this.doc.items.push(copy)
    this.dirty = true
    await this.spawn(copy)
    this.select(copy.id)
  }

  private num(label: string, value: number, step: number, set: (v: number) => void) {
    const wrap = el('label', 'field')
    wrap.append(el('span', '', label))
    const i = document.createElement('input')
    i.type = 'number'
    i.step = String(step)
    i.value = String(value)
    i.onchange = () => {
      const v = Number(i.value)
      if (Number.isFinite(v)) {
        set(v)
        this.onChange()
      }
    }
    wrap.append(i)
    return wrap
  }
}
