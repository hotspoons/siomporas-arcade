// The Points tab: name a place, say how you are there, and drop it on the world.
//
// Modelled on the race gates (coursemode.ts): a kind is armed from the palette or dragged in, a
// click on the ground places it with the nearest road's heading, a handle on the mark drags it,
// the list edits it. The document is src/points.ts.

import * as THREE from 'three'
import type { Site } from '../../world/scene'
import { el, dragChip, paneTabs } from './ui'
import { nextId, frameOf } from '../store/schema'
import { frameNotice, guardFrame } from '../store/frameguard'
import type { FrameVerdict } from '../store/framecheck'
import { loadPoints, savePoints, validatePoints, POINT_KINDS, POINT_MODES, type Point, type PointKind, type PointMode as PointHow, type PointsDoc } from '../../game/world/points'

type HeightAt = (x: number, y: number) => number

const COLOUR: Record<PointKind, number> = { home: 0xffd54f, start: 0x4fc3f7, finish: 0xff8a65, checkpoint: 0xb39ddb, spot: 0xa5d6a7 }
const LABEL: Record<PointKind, string> = { home: 'Home', start: 'Start', finish: 'Finish', checkpoint: 'Checkpoint', spot: 'Spot' }
const ABOUT: Record<PointKind, string> = {
  home: 'where the world opens when no level says',
  start: 'where a level begins — the Stage panel picks one',
  finish: 'where a level ends',
  checkpoint: 'a place a level passes through',
  spot: 'a named place a program can send you to',
}

export class PointMode {
  group = new THREE.Group()
  doc: PointsDoc = { version: 1, points: [] }
  dirty = false
  selected: string | null = null
  arming: PointKind | null = null
  /** what the roads say about this file's frame — see store/framecheck.ts */
  frame: FrameVerdict | null = null
  panelTab: 'kinds' | 'points' | 'courses' = 'kinds'
  /** the Courses tab's body: the race gates, rendered by whoever owns them (editor/main.ts) */
  coursesTab: ((root: HTMLElement) => void) | null = null

  private slug = ''
  private site: Site | null = null
  private h: HeightAt = () => 0
  private marks = new THREE.Group()
  private onChange: (structural?: boolean) => void
  private grabbed: string | null = null

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'points'
    this.group.add(this.marks)
    this.onChange = onChange
  }

  async load(slug: string, h: HeightAt, site: Site | null) {
    this.slug = slug
    this.h = h
    this.site = site
    this.doc = await loadPoints(slug, '')
    this.frame = site ? guardFrame(this.doc, site, { polygons: [], points: this.doc.points.map((p) => ({ id: p.id, at: p.at })) }, 'points') : null
    this.dirty = false
    this.selected = null
    this.arming = null
    this.rebuild()
  }

  get busy(): boolean {
    return this.arming !== null
  }

  /**
   * Turn every point by the bake's recorded UTM→ENU fit — a frame notice's button. A point's
   * heading is anticlockwise from east, so it gains the turn.
   */
  moveIntoFrame() {
    if (this.frame?.state !== 'old' || !this.site) return
    const { move, turnDeg } = this.frame
    for (const p of this.doc.points) {
      p.at = move(p.at).map((v) => Math.round(v * 10) / 10) as [number, number]
      p.yaw_deg = Math.round((p.yaw_deg + turnDeg) * 10) / 10
    }
    this.doc.frame = frameOf(this.site.manifest)
    this.frame = { state: 'stamped' }
    this.dirty = true
    this.rebuild()
    this.onChange()
  }

  /** A point's reach — the circle `pick` answers inside — for the editor's hover ring. */
  outline(id: string): [number, number][] | null {
    const p = this.doc.points.find((x) => x.id === id)
    return p ? circle(p.at, 4) : null
  }

  /** Name and place of every point, for the active mode's labels. */
  labels(): { id: string; text: string; at: [number, number] }[] {
    return this.doc.points.map((p) => ({ id: p.id, text: p.name, at: p.at }))
  }

  private rebuild() {
    this.marks.clear()
    for (const p of this.doc.points) this.draw(p)
  }

  /** a post with a coloured head and an arrow along the heading; the head is the drag handle */
  private draw(p: Point) {
    const z = this.zOf(p)
    const colour = COLOUR[p.kind]
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 8), new THREE.MeshBasicMaterial({ color: colour, depthTest: false }))
    post.position.set(p.at[0], z + 1.5, -p.at[1])
    post.renderOrder = 11
    this.marks.add(post)
    const head = new THREE.Mesh(new THREE.SphereGeometry(this.selected === p.id ? 1.1 : 0.8, 12, 10), new THREE.MeshBasicMaterial({ color: colour, depthTest: false }))
    head.position.set(p.at[0], z + 3.2, -p.at[1])
    head.renderOrder = 12
    head.userData = { pointId: p.id }
    this.marks.add(head)
    const yaw = (p.yaw_deg * Math.PI) / 180
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.6, 2.4, 10), new THREE.MeshBasicMaterial({ color: colour, depthTest: false }))
    // the cone points +Y; lay it along the heading: x east = cos, z south = -sin
    arrow.position.set(p.at[0] + Math.cos(yaw) * 2.2, z + 0.6, -p.at[1] - Math.sin(yaw) * 2.2)
    arrow.rotation.z = -Math.PI / 2
    arrow.rotation.y = yaw
    arrow.renderOrder = 11
    this.marks.add(arrow)
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.8, 32), new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2
    ring.position.set(p.at[0], z + 0.12, -p.at[1])
    ring.renderOrder = 10
    this.marks.add(ring)
  }

  private zOf(p: Point): number {
    if (typeof p.z === 'number') return p.z
    return this.h(p.at[0], p.at[1]) + (p.lift_m ?? 0)
  }

  arm(kind: PointKind | null) {
    this.arming = kind
    this.onChange()
  }

  /** the heading of the nearest road here, degrees anticlockwise from east; 0 when there is none */
  private roadYaw(x: number, y: number): number {
    const site = this.site
    if (!site) return 0
    const wz = -y
    let best: { d: number; dir: THREE.Vector3 } | null = null
    for (const c of site.chains()) {
      if (!(c.length_m > 1)) continue
      const coarse = Math.max(10, Math.min(40, c.length_m / 40))
      for (let s = 0; s <= c.length_m; s += coarse) {
        const at = c.at(s)
        const d = (at.pos.x - x) ** 2 + (at.pos.z - wz) ** 2
        if (!best || d < best.d) best = { d, dir: at.dir }
      }
    }
    if (!best || best.d > 80 * 80) return 0
    return Math.round((Math.atan2(-best.dir.z, best.dir.x) * 180) / Math.PI)
  }

  placeAt(pt: { x: number; y: number }, kind: PointKind = this.arming ?? 'spot'): string {
    const id = nextId(kind === 'home' ? 'home' : kind === 'start' ? 'start' : 'pt', this.doc.points.map((p) => p.id))
    const p: Point = { id, name: `${LABEL[kind]} ${this.doc.points.filter((q) => q.kind === kind).length + 1}`, kind, at: [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10], yaw_deg: this.roadYaw(pt.x, pt.y) }
    if (kind === 'home' && !this.doc.home) this.doc.home = id
    this.doc.points.push(p)
    if (this.site) this.doc.frame = frameOf(this.site.manifest)
    this.dirty = true
    this.arming = null
    this.selected = id
    this.panelTab = 'points'
    this.rebuild()
    this.onChange()
    return id
  }

  dropAt(pt: { x: number; y: number }, kind: string): boolean {
    if (!(POINT_KINDS as readonly string[]).includes(kind)) return false
    this.placeAt(pt, kind as PointKind)
    return true
  }

  click(pt: { x: number; y: number } | null) {
    if (this.arming && pt) return void this.placeAt(pt)
    if (!pt) return this.select(null)
    const hit = this.pick(pt)
    this.select(hit?.id ?? null)
  }

  pick(pt: { x: number; y: number }): { id: string; size: number } | null {
    let best: { id: string; size: number; d: number } | null = null
    for (const p of this.doc.points) {
      const d = Math.hypot(pt.x - p.at[0], pt.y - p.at[1])
      if (d <= 4 && (!best || d < best.d)) best = { id: p.id, size: 50, d }
    }
    return best ? { id: best.id, size: best.size } : null
  }

  select(id: string | null) {
    this.selected = id
    if (id) this.panelTab = 'points'
    this.rebuild()
    this.onChange()
  }

  grab(ray: THREE.Raycaster): boolean {
    const hit = ray.intersectObjects(this.marks.children, false).find((h) => (h.object.userData as { pointId?: string }).pointId)
    this.grabbed = (hit?.object.userData as { pointId?: string } | undefined)?.pointId ?? null
    if (this.grabbed) this.selected = this.grabbed
    return this.grabbed !== null
  }

  dragTo(pt: { x: number; y: number } | null) {
    if (!this.grabbed || !pt) return
    const p = this.doc.points.find((x) => x.id === this.grabbed)
    if (!p) return
    p.at = [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10]
    this.dirty = true
    this.rebuild()
    this.onChange(false)
  }

  drop() {
    if (!this.grabbed) return
    this.grabbed = null
    this.onChange()
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.arming) { this.arm(null); return true }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.remove(this.selected); return true }
    if ((e.key === 'z' || e.key === 'x') && this.selected) {
      const p = this.doc.points.find((x) => x.id === this.selected)
      if (!p) return false
      p.yaw_deg = ((p.yaw_deg + (e.key === 'z' ? 1 : -1) * (e.shiftKey ? 45 : 5)) % 360 + 360) % 360
      this.dirty = true
      this.rebuild()
      this.onChange()
      return true
    }
    return false
  }

  remove(id: string) {
    this.doc.points = this.doc.points.filter((p) => p.id !== id)
    if (this.doc.home === id) this.doc.home = null
    if (this.selected === id) this.selected = null
    this.dirty = true
    this.rebuild()
    this.onChange()
  }

  async save(): Promise<string> {
    const problems = validatePoints(this.doc)
    if (problems.length) throw new Error(problems.join('; '))
    const bytes = await savePoints(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.points.length} point${this.doc.points.length === 1 ? '' : 's'} (${bytes} bytes) to ${this.slug}/points.json`
  }

  panel(root: HTMLElement, go: (p: Point) => void) {
    root.replaceChildren()
    const tabs = [{ id: 'kinds', label: 'Kinds' }, { id: 'points', label: `Points (${this.doc.points.length})` }, ...(this.coursesTab ? [{ id: 'courses', label: 'Courses' }] : [])]
    paneTabs(root, tabs, this.panelTab, (id) => {
      this.panelTab = id as 'kinds' | 'points' | 'courses'
      this.onChange(true)
    })
    if (this.panelTab === 'courses' && this.coursesTab) {
      const host = el('div', 'courses-tab')
      root.append(host)
      this.coursesTab(host)
      return
    }
    if (this.panelTab === 'kinds') return this.kindsTab(root)
    this.pointsTab(root, go)
  }

  private kindsTab(root: HTMLElement) {
    root.append(el('h2', '', this.arming ? `click the ground to place a ${LABEL[this.arming].toLowerCase()}` : 'drag one in, or pick it and click the ground'))
    const pal = el('div', 'palette')
    for (const k of POINT_KINDS) {
      const chip = dragChip({ mode: 'points', id: k, label: LABEL[k], note: ABOUT[k], on: this.arming === k, onClick: () => this.arm(this.arming === k ? null : k) })
      chip.style.borderLeft = `4px solid #${COLOUR[k].toString(16).padStart(6, '0')}`
      pal.append(chip)
    }
    root.append(pal)
    const home = this.doc.home ? this.doc.points.find((p) => p.id === this.doc.home) : null
    root.append(el('p', 'dim', home ? `the world opens at “${home.name}”` : 'no home yet: the world opens at the bake’s photo station until a home is placed'))
  }

  private pointsTab(root: HTMLElement, go: (p: Point) => void) {
    const notice = frameNotice('points.json', this.frame, () => this.moveIntoFrame())
    if (notice) root.append(notice)
    if (!this.doc.points.length) { root.append(el('p', 'dim', 'nothing placed yet')); return }
    const list = el('div', 'list')
    for (const p of this.doc.points) {
      const row = el('div', `list-row${this.selected === p.id ? ' on' : ''}`)
      const btn = el('button', 'list-main')
      btn.append(el('span', 'nm', `${p.name}${this.doc.home === p.id ? ' · home' : ''}`), el('span', 'mono', `${p.kind} · ${p.mode ?? 'level'} · ${p.yaw_deg}°`))
      btn.onclick = () => { this.select(p.id); go(p) }
      row.append(btn)
      list.append(row)
      if (this.selected !== p.id) continue
      const det = el('div', 'detail')
      const field = (label: string, input: HTMLElement) => { const w = el('label', 'field text'); w.append(el('span', 'field-label', label), input); return w }
      const name = el('input', 'input wide') as HTMLInputElement
      name.value = p.name
      name.onchange = () => { p.name = name.value.trim() || p.id; this.dirty = true; this.onChange() }
      det.append(field('name', name))
      const kind = el('select', 'input') as HTMLSelectElement
      for (const k of POINT_KINDS) kind.append(Object.assign(document.createElement('option'), { value: k, textContent: LABEL[k] }))
      kind.value = p.kind
      kind.onchange = () => { p.kind = kind.value as PointKind; this.dirty = true; this.rebuild(); this.onChange() }
      det.append(field('kind', kind))
      const mode = el('select', 'input') as HTMLSelectElement
      mode.append(Object.assign(document.createElement('option'), { value: '', textContent: 'as the level says' }))
      for (const m of POINT_MODES) mode.append(Object.assign(document.createElement('option'), { value: m, textContent: m }))
      mode.value = p.mode ?? ''
      mode.onchange = () => { if (mode.value) p.mode = mode.value as PointHow; else delete p.mode; this.dirty = true; this.onChange() }
      det.append(field('how you are there', mode))
      const num = (label: string, value: number | null | undefined, step: number, set: (v: number | null) => void) => {
        const i = el('input', 'input') as HTMLInputElement
        i.type = 'number'
        i.step = String(step)
        i.value = value === null || value === undefined ? '' : String(value)
        i.onchange = () => { const v = i.value.trim() === '' ? null : Number(i.value); set(v === null || Number.isFinite(v) ? v : null); this.dirty = true; this.rebuild(); this.onChange() }
        return field(label, i)
      }
      det.append(num('x (m east)', p.at[0], 0.5, (v) => (p.at[0] = v ?? p.at[0])))
      det.append(num('y (m north)', p.at[1], 0.5, (v) => (p.at[1] = v ?? p.at[1])))
      det.append(num('heading° (Z/X)', p.yaw_deg, 1, (v) => (p.yaw_deg = ((v ?? 0) % 360 + 360) % 360)))
      det.append(num('above the ground (m)', p.lift_m, 0.5, (v) => { if (v === null || v <= 0) delete p.lift_m; else p.lift_m = v }))
      det.append(num('absolute height (m), blank = ground', p.z, 0.5, (v) => { if (v === null) delete p.z; else p.z = v }))
      const note = el('input', 'input wide') as HTMLInputElement
      note.value = p.note ?? ''
      note.placeholder = 'what the level says on arrival'
      note.onchange = () => { if (note.value.trim()) p.note = note.value.trim(); else delete p.note; this.dirty = true; this.onChange() }
      det.append(field('note', note))
      const acts = el('div', 'row')
      const homeBtn = el('button', this.doc.home === p.id ? 'on' : '', this.doc.home === p.id ? 'the world’s home' : 'make this the world’s home')
      homeBtn.onclick = () => { this.doc.home = this.doc.home === p.id ? null : p.id; this.dirty = true; this.onChange() }
      const del = el('button', 'danger', 'remove')
      del.onclick = () => this.remove(p.id)
      acts.append(homeBtn, del)
      det.append(acts)
      list.append(det)
    }
    root.append(list)
  }
}

/** A ring of `n` points about a centre, for a hover outline. */
export function circle(c: [number, number], r: number, n = 24): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) out.push([c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)])
  return out
}
