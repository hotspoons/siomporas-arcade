// Drawing a race: gates across the road, in order, gathered into circuits and stages.
//
// Rich, 2026-09-29: *"where are the waypoints and start and finish fixtures for races?"* — they are
// here. `races.ts` has had the model and the tracker since earlier today (gates as oriented lines,
// penalties, laps, wrong-way detection) with nothing to place them; this is the placing.
//
// A GATE IS DRAWN BY CLICKING THE ROAD, NOT BY DRAGGING A LINE.
//
// A start line is perpendicular to the road and as wide as the road plus a margin, every single
// time — so asking somebody to draw both ends is asking them to do by hand, twice per gate, a
// thing the centreline already knows. One click gives the position, the road gives the bearing, and
// the two posts are placed either side. The ends are still draggable for the one gate that has to
// be off-square.
//
// AND THE DIRECTION IS SHOWN, ALWAYS. `races.ts` says you cross a gate correctly going from the
// right of `a→b` to its left; that is a convention, and a convention nobody can see is a start line
// that will be backwards half the time and will not look wrong until somebody drives it. So every
// gate draws an arrow, and the panel has a button to turn one round.

import * as THREE from 'three'
import { handleMesh, type HeightAt } from '../view/drape'
import { nextId } from '../store/schema'
import type { Site } from '../../world/scene'
import { dragChip, el, paneTabs, slider } from './ui'
import {
  clock, DEFAULT_ENTRY_R, describeCourse, finishGate, gateForward, gateWidth, midpoint,
  orderedGates, startGate, validateCourse,
  type Course, type CourseDoc, type Gate, type GateRole,
} from '../../game/race/races'
import { loadCourses, saveCourses } from '../store/coursestore'

const COLOUR: Record<GateRole, number> = {
  start: 0x3ddc84,
  finish: 0xff4d4d,
  startfinish: 0xffd400,
  checkpoint: 0x4aa3ff,
  split: 0x9b7bff,
}
const SELECTED = 0x2ee6c0
const ENTRY = 0x3ddc84
/** how far past the road's edge each post stands, so nobody drives round a gate */
const MARGIN_M = 6
const POST_H = 7

export class CourseMode {
  group = new THREE.Group()
  doc: CourseDoc = { version: 1, courses: [] }
  dirty = false
  /** which course is being edited */
  selected: string | null = null
  /** the role the next click on the road will place; 'entry' places the throbber */
  arming: GateRole | 'entry' | null = null
  selectedGate: string | null = null

  private slug = ''
  private site: Site | null = null
  private h: HeightAt = () => 0
  private marks = new THREE.Group()
  private onChange: (structural?: boolean) => void
  private grabbed: { gate: string; end: 'a' | 'b' } | { entry: string } | null = null

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'courses'
    this.group.add(this.marks)
    this.onChange = onChange
  }

  async load(slug: string, h: HeightAt, site: Site | null) {
    this.slug = slug
    this.h = h
    this.site = site
    this.doc = await loadCourses(slug)
    this.dirty = false
    this.selected = this.doc.courses[0]?.id ?? null
    this.selectedGate = null
    this.arming = null
    this.rebuild()
  }

  get course(): Course | null {
    return this.doc.courses.find((c) => c.id === this.selected) ?? null
  }

  /* ---- geometry -------------------------------------------------------------------------------- */

  private rebuild() {
    this.marks.clear()
    const c = this.course
    if (!c) return
    for (const g of c.gates) this.drawGate(g)
    if (c.entry) this.drawEntry(c)
  }

  /**
   * The throbber: where you drive in to commit to this race.
   *
   * A RING ON THE GROUND, drawn the same way the game draws it, so what you place is what a player
   * sees. Its handle is at the centre, so dragging moves the whole marker; the radius is a slider,
   * because a radius is not a thing anybody drags accurately.
   */
  private drawEntry(c: Course) {
    const e = c.entry!
    const r = e.r || DEFAULT_ENTRY_R
    const z = this.h(e.x, e.y)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.72, r, 48),
      new THREE.MeshBasicMaterial({ color: ENTRY, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(e.x, z + 0.15, -e.y)
    ring.renderOrder = 10
    this.marks.add(ring)
    const hm = handleMesh(ENTRY, 3)
    hm.position.set(e.x, z + 1.4, -e.y)
    hm.userData = { entryFor: c.id }
    this.marks.add(hm)
  }

  /**
   * One gate: two posts, a banner between them, and an arrow through the middle.
   *
   * The arrow is the important part. Without it the only way to discover that a gate faces the
   * wrong way is to drive at it and not be counted.
   */
  private drawGate(g: Gate) {
    const on = g.id === this.selectedGate
    const colour = on ? SELECTED : COLOUR[g.role]
    const za = this.h(g.a[0], g.a[1])
    const zb = this.h(g.b[0], g.b[1])

    for (const [p, z] of [[g.a, za], [g.b, zb]] as const) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, POST_H, 8),
        new THREE.MeshBasicMaterial({ color: colour }),
      )
      post.position.set(p[0], z + POST_H / 2, -p[1])
      post.userData = { gateId: g.id }
      this.marks.add(post)
    }

    const banner = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(g.a[0], za + POST_H, -g.a[1]),
        new THREE.Vector3(g.b[0], zb + POST_H, -g.b[1]),
      ]),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }),
    )
    banner.renderOrder = 11
    this.marks.add(banner)

    const m = midpoint(g)
    const f = gateForward(g)
    const zm = this.h(m.x, m.y)
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(f.x, 0, -f.y).normalize(),
      new THREE.Vector3(m.x, zm + 1.2, -m.y),
      12, colour, 4, 2.5,
    )
    this.marks.add(arrow)

    if (on) {
      for (const [p, z] of [[g.a, za], [g.b, zb]] as const) {
        const hm = handleMesh(SELECTED, 2.4)
        hm.position.set(p[0], z + 1, -p[1])
        hm.userData = { gateId: g.id, end: p === g.a ? 'a' : 'b' }
        this.marks.add(hm)
      }
    }
  }

  /* ---- editing --------------------------------------------------------------------------------- */

  arm(role: GateRole | 'entry' | null) {
    this.arming = role
    this.onChange()
  }

  newCourse(kind: 'circuit' | 'stage') {
    const id = nextId(kind === 'circuit' ? 'ci' : 'st', this.doc.courses.map((c) => c.id))
    this.doc.courses.push({
      id,
      name: kind === 'circuit' ? 'new circuit' : 'new stage',
      kind,
      laps: kind === 'circuit' ? 3 : undefined,
      penalty_s: 10,
      gates: [],
    })
    this.dirty = true
    this.selected = id
    this.selectedGate = null
    this.rebuild()
    this.onChange()
  }

  removeCourse(id: string) {
    this.doc.courses = this.doc.courses.filter((c) => c.id !== id)
    if (this.selected === id) this.selected = this.doc.courses[0]?.id ?? null
    this.dirty = true
    this.rebuild()
    this.onChange()
  }

  /**
   * Put a gate across the road under the pointer.
   *
   * ACROSS, not along: the two posts are placed on the road's own normal, half a gate either side,
   * so the line is square to the traffic without anybody aiming it. The width is the road plus a
   * margin, because a gate you can drive round is a gate that does nothing.
   *
   * The DIRECTION is the road's direction of travel: `races.ts` counts a crossing as forward when
   * you pass from the right of `a→b` to its left, so `a` goes on the LEFT of the road and `b` on
   * the right. Getting that backwards is the one mistake that looks correct from above.
   */
  placeAt(pt: { x: number; y: number }): string | null {
    const c = this.course
    const site = this.site
    if (!c || !site || !this.arming) return null

    /*
     * THE ENTRY GOES WHERE YOU CLICKED, not on the nearest road. A throbber beside the road, in a
     * lay-by or on a forecourt, is a perfectly good place to start a race from — and snapping it to
     * the centreline would make that impossible to author.
     */
    if (this.arming === 'entry') {
      c.entry = { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10, r: c.entry?.r || DEFAULT_ENTRY_R }
      this.dirty = true
      this.arming = null
      this.rebuild()
      this.onChange()
      return null
    }
    const near = this.nearestOnAnyChain(pt.x, pt.y)
    if (!near) return null

    const dirX = near.dir.x
    const dirY = -near.dir.z
    const len = Math.hypot(dirX, dirY) || 1
    // the road's LEFT normal, which is a→b's own direction: forward becomes right-to-left
    const lx = -dirY / len
    const ly = dirX / len
    const half = (near.half ?? 6) + MARGIN_M

    const id = nextId('g', c.gates.map((g) => g.id))
    const role = this.arming
    const order = role === 'checkpoint' || role === 'split'
      ? Math.max(0, ...orderedGates(c).map((g) => g.order ?? 0)) + 1
      : undefined
    const gate: Gate = {
      id,
      name: role,
      role,
      a: [near.pos.x + lx * half, -near.pos.z + ly * half],
      b: [near.pos.x - lx * half, -near.pos.z - ly * half],
      ...(order === undefined ? {} : { order }),
    }
    c.gates.push(gate)
    this.dirty = true
    this.arming = null
    this.selectedGate = id
    this.rebuild()
    this.onChange()
    return id
  }

  /** The nearest point on any driveable chain, with the road's half-width where it is known. */
  private nearestOnAnyChain(x: number, y: number) {
    const site = this.site
    if (!site) return null
    const wz = -y
    let best: { s: number; pos: THREE.Vector3; dir: THREE.Vector3; dist: number; half?: number } | null = null
    for (const c of site.chains()) {
      if (!(c.length_m > 1)) continue
      const coarse = Math.max(10, Math.min(40, c.length_m / 40))
      let bs = 0
      let bd = Infinity
      for (let s = 0; s <= c.length_m; s += coarse) {
        const p = c.at(s).pos
        const d = (p.x - x) ** 2 + (p.z - wz) ** 2
        if (d < bd) { bd = d; bs = s }
      }
      for (let s = Math.max(0, bs - coarse); s <= Math.min(c.length_m, bs + coarse); s += coarse / 8) {
        const p = c.at(s).pos
        const d = (p.x - x) ** 2 + (p.z - wz) ** 2
        if (d < bd) { bd = d; bs = s }
      }
      const dist = Math.sqrt(bd)
      if (!best || dist < best.dist) {
        const at = c.at(bs)
        best = { s: bs, pos: at.pos, dir: at.dir, dist }
      }
    }
    return best
  }

  selectGate(id: string | null) {
    this.selectedGate = id
    this.rebuild()
    this.onChange()
  }

  removeGate(id: string) {
    const c = this.course
    if (!c) return
    c.gates = c.gates.filter((g) => g.id !== id)
    if (this.selectedGate === id) this.selectedGate = null
    this.dirty = true
    this.rebuild()
    this.onChange()
  }

  /** Turn a gate round — the fix for the one mistake that is invisible from above. */
  flipGate(id: string) {
    const g = this.course?.gates.find((x) => x.id === id)
    if (!g) return
    const a = g.a
    g.a = g.b
    g.b = a
    this.dirty = true
    this.rebuild()
    this.onChange()
  }

  /* ---- input ----------------------------------------------------------------------------------- */

  click(pt: { x: number; y: number } | null) {
    if (this.arming && pt) return void this.placeAt(pt)
    if (!pt) return this.selectGate(null)
    const c = this.course
    if (!c) return
    // the nearest gate MIDPOINT, which is where somebody aims
    let best: { id: string; d: number } | null = null
    for (const g of c.gates) {
      const m = midpoint(g)
      const d = Math.hypot(pt.x - m.x, pt.y - m.y)
      if (d < gateWidth(g) && (!best || d < best.d)) best = { id: g.id, d }
    }
    this.selectGate(best?.id ?? null)
  }

  grab(ray: THREE.Raycaster): boolean {
    const hit = ray.intersectObjects(this.marks.children, false)[0]
    const d = hit?.object.userData as { gateId?: string; end?: 'a' | 'b'; entryFor?: string } | undefined
    this.grabbed = d?.entryFor ? { entry: d.entryFor }
      : d?.gateId && d.end ? { gate: d.gateId, end: d.end }
      : null
    return this.grabbed !== null
  }

  dragTo(pt: { x: number; y: number } | null) {
    if (!this.grabbed || !pt) return
    if ('entry' in this.grabbed) {
      const c = this.doc.courses.find((x) => x.id === (this.grabbed as { entry: string }).entry)
      if (!c?.entry) return
      c.entry.x = Math.round(pt.x * 10) / 10
      c.entry.y = Math.round(pt.y * 10) / 10
      this.dirty = true
      this.rebuild()
      this.onChange(false)
      return
    }
    const g = this.course?.gates.find((x) => x.id === (this.grabbed as { gate: string }).gate)
    if (!g) return
    g[(this.grabbed as { end: 'a' | 'b' }).end] = [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10]
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedGate) {
      this.removeGate(this.selectedGate)
      return true
    }
    return false
  }

  async save(): Promise<string> {
    const bytes = await saveCourses(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.courses.length} course${this.doc.courses.length === 1 ? '' : 's'} (${bytes} bytes) to ${this.slug}/courses.json`
  }

  /* ---- the panel --------------------------------------------------------------------------------- */

  panel(root: HTMLElement, go: (g: Gate) => void) {
    root.replaceChildren()
    paneTabs(root, [{ id: 'gates', label: 'Gates' }, { id: 'placed', label: `Races (${this.doc.courses.length})` }], this.panelTab, (id) => {
      this.panelTab = id as 'gates' | 'placed'
      this.onChange()
    })
    if (this.panelTab === 'gates') {
      this.gatesTab(root)
      return
    }
    this.placedTab(root, go)
  }

  /** which of the panel's two tabs is up */
  panelTab: 'gates' | 'placed' = 'gates'

  /**
   * A gate kind dragged from the palette onto the road: laid square across it there, in the race
   * that is selected — or in a new one of the right kind when none is.
   */
  dropAt(pt: { x: number; y: number }, role: string): boolean {
    if (!this.course) this.newCourse(role === 'startfinish' || role === 'split' ? 'circuit' : 'stage')
    const was = this.arming
    this.arming = role as GateRole | 'entry'
    const id = this.placeAt(pt)
    this.arming = id ? null : was
    if (id) this.panelTab = 'placed'
    this.onChange()
    return !!id
  }

  /** The gate nearest a point, for the cross-mode click: any race's, within a post's reach. */
  pick(pt: { x: number; y: number }): { id: string; size: number } | null {
    let best: { id: string; size: number; d: number } | null = null
    for (const c of this.doc.courses) {
      for (const g of c.gates) {
        const mx = (g.a[0] + g.b[0]) / 2, my = (g.a[1] + g.b[1]) / 2
        const w = gateWidth(g)
        const d = Math.hypot(pt.x - mx, pt.y - my)
        if (d <= w / 2 + 4 && (!best || d < best.d)) best = { id: g.id, size: w * 8, d }
      }
      if (c.entry && Math.hypot(pt.x - c.entry.x, pt.y - c.entry.y) <= (c.entry.r || DEFAULT_ENTRY_R)) {
        const r = c.entry.r || DEFAULT_ENTRY_R
        if (!best) best = { id: `entry:${c.id}`, size: Math.PI * r * r, d: 0 }
      }
    }
    return best ? { id: best.id, size: best.size } : null
  }

  /** Select a gate (or an entry ring) by the id `pick` gave, switching to its race. */
  select(id: string | null) {
    if (!id) { this.selectedGate = null; this.rebuild(); this.onChange(); return }
    const entry = id.startsWith('entry:') ? id.slice(6) : null
    const c = entry ? this.doc.courses.find((x) => x.id === entry) : this.doc.courses.find((x) => x.gates.some((g) => g.id === id))
    if (!c) return
    this.selected = c.id
    this.selectedGate = entry ? null : id
    this.panelTab = 'placed'
    this.rebuild()
    this.onChange()
  }

  private gatesTab(root: HTMLElement) {
    const add = el('div', 'row')
    const circuit = el('button')
    circuit.textContent = 'new circuit'
    circuit.title = 'one start/finish line you cross N times, with splits in between'
    circuit.onclick = () => { this.newCourse('circuit'); this.panelTab = 'placed'; this.onChange() }
    const stage = el('button')
    stage.textContent = 'new stage'
    stage.title = 'a start, a finish, and checkpoints in order — a missed one is a penalty'
    stage.onclick = () => { this.newCourse('stage'); this.panelTab = 'placed'; this.onChange() }
    add.append(circuit, stage)
    root.append(add)
    const c = this.course
    root.append(el('p', 'dim', c
      ? (this.arming
        ? this.arming === 'entry' ? 'click anywhere to put the entry ring there' : `click the road to place the ${this.arming} in ${c.name}`
        : `drag a gate onto the road, or pick one and click — it goes in ${c.name}, laid square across the road`)
      : 'drag a gate onto the road to start a race with it, or make one first'))
    const palette = el('div', 'palette')
    const kinds: { id: GateRole | 'entry'; label: string; note: string }[] = [
      { id: 'entry', label: 'entry ring', note: 'drive in to commit' },
      { id: 'start', label: 'start', note: 'stage: the clock starts' },
      { id: 'checkpoint', label: 'checkpoint', note: 'stage: in order, or a penalty' },
      { id: 'finish', label: 'finish', note: 'stage: the clock stops' },
      { id: 'startfinish', label: 'start/finish', note: 'circuit: the lap line' },
      { id: 'split', label: 'split', note: 'circuit: a timing line' },
    ]
    for (const k of kinds) {
      palette.append(dragChip({
        mode: 'races', id: k.id, label: k.label, note: k.note, on: this.arming === k.id,
        onClick: () => this.arm(this.arming === k.id ? null : k.id),
      }))
    }
    root.append(palette)
  }

  private placedTab(root: HTMLElement, go: (g: Gate) => void) {
    const list = el('div', 'list')
    for (const c of this.doc.courses) {
      const row = el('div', `item${c.id === this.selected ? ' sel' : ''}`)
      row.append(el('span', 'tag', c.kind), el('span', 'nm', c.name), el('span', 'mono', `${c.gates.length}`))
      row.onclick = () => { this.selected = c.id; this.selectedGate = null; this.rebuild(); this.onChange() }
      list.append(row)
    }
    if (!this.doc.courses.length) list.append(el('p', 'dim', 'No races yet. A circuit is laps of one line; a stage runs start to finish through checkpoints.'))
    root.append(list)

    const c = this.course
    if (!c) return
    const det = el('div', 'detail')
    det.append(el('h2', '', `${c.id} · ${describeCourse(c)}`))

    const name = document.createElement('input')
    name.type = 'text'
    name.value = c.name
    name.oninput = () => {
      c.name = name.value
      this.dirty = true
      for (const row of list.querySelectorAll('.item.sel .nm')) row.textContent = name.value
      this.onChange(false)
    }
    det.append(name)

    const tools = el('div', 'row')
    const del = el('button', 'danger')
    del.textContent = 'remove race'
    del.onclick = () => this.removeCourse(c.id)
    tools.append(del)
    det.append(tools)

    /* ---- the gate palette ----------------------------------------------------------------------- */
    det.append(el('p', 'dim', `gates come from the Gates tab: drag one onto the road, or pick one and click`))
    if (c.entry) {
      det.append(slider('entry radius m', c.entry.r || DEFAULT_ENTRY_R, 5, 60, 1, DEFAULT_ENTRY_R,
        'how close you have to drive to commit', (v) => {
          c.entry!.r = Math.round(v)
          this.dirty = true
          this.rebuild()
          this.onChange(false)
        }))
    } else {
      det.append(el('div', 'dim', 'without an entry marker this race can only be started from code'))
    }

    if (c.kind === 'circuit') {
      det.append(slider('laps', c.laps ?? 3, 1, 50, 1, 3, 'how many times round', (v) => {
        c.laps = Math.round(v)
        this.dirty = true
        this.onChange(false)
      }))
    }
    det.append(slider('penalty s', c.penalty_s ?? 10, 0, 60, 1, 10, 'seconds added for a checkpoint you missed', (v) => {
      c.penalty_s = Math.round(v)
      this.dirty = true
      this.onChange(false)
    }))

    /* ---- the gates ------------------------------------------------------------------------------ */
    const gates = el('div', 'list')
    const ordered = [startGate(c), ...orderedGates(c), finishGate(c)].filter((g, i, a) => g && a.indexOf(g) === i) as Gate[]
    for (const g of ordered) {
      const row = el('div', `item${g.id === this.selectedGate ? ' sel' : ''}`)
      row.append(el('span', 'tag', g.role), el('span', 'nm', g.name), el('span', 'mono', `${gateWidth(g).toFixed(0)} m`))
      row.onclick = () => this.selectGate(g.id)
      row.ondblclick = () => go(g)
      gates.append(row)
    }
    if (ordered.length) det.append(el('h3', '', 'Gates, in order'))
    det.append(gates)

    const g = c.gates.find((x) => x.id === this.selectedGate)
    if (g) {
      const gt = el('div', 'row')
      const flip = el('button')
      flip.textContent = 'turn it round'
      flip.title = 'swap the posts: the arrow is which way counts'
      flip.onclick = () => this.flipGate(g.id)
      const rm = el('button', 'danger')
      rm.textContent = 'remove gate'
      rm.onclick = () => this.removeGate(g.id)
      gt.append(flip, rm)
      det.append(gt)
      if (g.role === 'checkpoint' || g.role === 'split') {
        det.append(slider('order', g.order ?? 0, 0, 40, 1, 0, 'the sequence they must be taken in', (v) => {
          g.order = Math.round(v)
          this.dirty = true
          this.rebuild()
          this.onChange(false)
        }))
      }
    }

    /*
     * WHAT IS WRONG WITH IT. The one worth the space is a circuit with no split: start and finish
     * are the same line, so without something to take in between, reversing over it counts as laps.
     */
    const report = validateCourse(c)
    for (const e of report.errors) det.append(el('div', 'field-error', e))
    for (const w of report.warnings) det.append(el('div', 'dim', w))
    if (report.ok) det.append(el('p', 'dim', `ready — ${describeCourse(c)}, ${clock(0)} on the clock`))
    root.append(det)
  }
}
