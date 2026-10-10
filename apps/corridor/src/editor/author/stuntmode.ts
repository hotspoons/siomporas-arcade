// Putting a loop on a road: click where you want it, turn it, drag its two ends along the tarmac.
//
// Rich, 2026-09-29: *"It would be so dope to be able to stick a loop-de-loop over a section of
// road… place the stunt and then connect it to a start and finish waypoints."* That is the whole
// interaction, and the reason it is not the polygon tool that Areas and Traffic use is that a
// fixture is not a region: it is a rigid object with a position, a heading and two ends that have
// to meet the road. Drawing a ring around one would say nothing about any of those.
//
// WHAT THE EDITOR DECIDES FOR YOU, and why each one is safe to decide:
//
//   THE HEADING comes from the road under the click. A loop is entered along the road it replaces —
//   that is what it is for — so facing it any other way is a mistake, not a choice. It is still a
//   field you can drag, because a chicane is a real thing.
//
//   THE TWO ENDS start a fixture-length clear of it, up and down the road. Close enough to be a
//   sensible default, far enough that the approach has room to bend; and they are handles, so the
//   moment the default is wrong it is one drag to fix.
//
// AND NONE OF THAT HAPPENS WHEN SNAPPING IS OFF. Rich, 2026-09-29: *"the original ask was to be
// able to drop a stunt piece and place it anywhere, not just on the existing roads… I do like the
// auto-road-snapping feature and that should be the default, but we should have the ability to
// toggle this off and place the pieces freely, then click waypoints to add them back to a section
// of road — or not have them link to roads at all. That way I can build complete stunt tracks in a
// field."* So there are two placement modes and three kinds of end, and the link is something you
// ASK for — click "join it to a road", then click the tarmac you mean — rather than something a
// placement implies.
//
// NOTHING IS GUESSED ABOUT WHICH WAY THE ROAD RUNS. `nearestStation` gives the tangent at the
// click, and the fixture faces along it. A fixture facing backwards produces an approach that
// doubles back on itself, which `connectFixture` reports and the panel shows in red — the one
// mistake that is invisible from above.

import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { handleMesh, type HeightAt } from '../view/drape'
import { nextId } from '../store/schema'
import type { Site } from '../../world/scene'
import { dragChip, el, paneTabs, slider } from './ui'
import {
  connectFixture, defaultPort, describeEnd, describeFixture, DEFAULT_TIGHTNESS, endsOf,
  fixtureFootprint, fixturePorts, fixtureSize, linksTo, pieceOf, resolveEnd, setEnd, Stunts, stuntPieces,
  STUNT_STYLES, validateStunts,
  type Pose, type StuntDoc, type StuntEnd, type StuntFixture, type StuntPort,
} from '../../game/stunt/stunts'
import { buildFixture, type Ribbon } from '../../game/stunt/stuntmesh'
import { loadStunts, saveStunts } from '../store/stuntstore'

const SELECTED = 0x2ee6c0
const FOOTPRINT = 0xff8a2b
const MOVE = 0xffffff
const LINK = 0x7ea6ff
/**
 * How near a road a click has to be for snapping to take it.
 *
 * Far enough that clicking anywhere on or beside a road snaps, near enough that a click in the
 * middle of a field is a click in the middle of a field. Without it, "snap to the nearest road"
 * means "snap to a road you cannot see", which is what a track built in a field runs into first.
 */
const SNAP_M = 150

export class StuntMode {
  group = new THREE.Group()
  doc: StuntDoc = { version: 1, fixtures: [] }
  dirty = false
  selected: string | null = null
  /** the piece the next click will place */
  arming: string | null = null
  /**
   * Whether a placement is pulled onto the nearest road.
   *
   * ON BY DEFAULT because it is right nearly every time — a loop usually replaces a stretch of road
   * — and off is how a track gets built in a field. It is a property of the TOOL, not of a fixture:
   * turning it off does not unjoin anything you have already placed.
   */
  snapToRoad = true
  /** the end waiting for its target, while you pick one */
  linking: { which: StuntPort; what: 'road' | 'fixture' } | null = null

  private slug = ''
  private site: Site | null = null
  private h: HeightAt = () => 0
  private built = new Map<string, Ribbon>()
  private marks = new THREE.Group()
  private onChange: (structural?: boolean) => void
  private grabbed: 'move' | 'yaw' | 'entry' | 'exit' | null = null
  /** the heading the last piece was placed or turned to, so a run of free placements stays aligned */
  private lastYaw = 0
  private gizmo: TransformControls | null = null
  private gizmoMode: 'translate' | 'rotate' = 'translate'
  private dragging = false
  /**
   * True from the moment a press lands on a gizmo handle until it is released.
   *
   * Read by the editor's own pointerdown, which would otherwise hand the camera straight back and
   * let OrbitControls take the drag. See the long note in `useGizmo`.
   */
  onGizmo = false
  /** the object the gizmo is attached to: a fixture's position and heading, as a transform */
  private anchor = new THREE.Object3D()
  /**
   * The gizmo's own helper lives in here, and the group is hidden when nothing is selected.
   *
   * Fixtures stay VISIBLE in every editor mode — they are part of the world, not an overlay — so a
   * detached gizmo parented straight onto that group would leave its handles hanging in the air
   * while somebody drew an area.
   */
  private gizmoHost = new THREE.Group()

  constructor(onChange: (structural?: boolean) => void) {
    this.group.name = 'stunts'
    this.anchor.name = 'stunt-anchor'
    this.gizmoHost.name = 'stunt-gizmo-host'
    this.gizmoHost.visible = false
    this.group.add(this.marks, this.anchor, this.gizmoHost)
    this.onChange = onChange
  }

  /* ---- the gizmo -------------------------------------------------------------------------------- */

  /**
   * Give the tool a camera and a canvas, so a piece can be dragged and turned by its handles.
   *
   * Rich, 2026-09-29: *"Make sure the pieces can be moved and rotated with a gizmo."* The spheres
   * were fine for ends on a road and hopeless for a piece standing in a field, where "put it there,
   * pointing that way" is the whole job and a heading you can only reach by dragging a ball on a
   * circle is a heading you fight for.
   *
   * THE GIZMO MOVES IT FREELY, always — even with snapping on. A handle you drag along X that
   * suddenly jumps onto a road is a handle that does not do what it says. The white ball in the
   * middle still slides the piece along the tarmac, so both gestures exist and each does one thing.
   *
   * THE CAMERA MUST LET GO BEFORE THE HANDLE IS GRABBED, and NOT by calling `stopPropagation`.
   * Stopping propagation from a CAPTURE listener on the target cancels that target's BUBBLE phase
   * as well, and TransformControls listens in the bubble phase — which is the bug that made the
   * placement gizmo highlight on hover and do nothing on press. The press goes through; a flag
   * holds the camera off. The whole story is in `place.ts`.
   */
  useGizmo(camera: THREE.Camera, dom: HTMLElement, onOrbit: (enabled: boolean) => void): void {
    if (this.gizmo) return
    const g = new TransformControls(camera, dom)
    g.setSpace('world')
    this.snapOn()
    g.addEventListener('dragging-changed', (e) => {
      this.dragging = !!(e as unknown as { value: boolean }).value
      onOrbit(!this.dragging)
      if (!this.dragging) {
        // the road is re-holed and the panel redrawn when the drag ENDS: per frame it is a freeze
        this.applyRoadSkip()
        this.onChange()
      }
    })
    dom.addEventListener('pointerdown', () => {
      if (g.axis === null) return
      this.onGizmo = true
      onOrbit(false)
    }, true)
    addEventListener('pointerup', () => {
      this.onGizmo = false
      if (!this.dragging) onOrbit(true)
    })
    // snapped by default, free while shift is down — the same bargain the placement gizmo strikes
    addEventListener('keydown', (e) => { if (e.key === 'Shift') this.snapOff() })
    addEventListener('keyup', (e) => { if (e.key === 'Shift') this.snapOn() })
    g.addEventListener('objectChange', () => this.readGizmo())
    this.gizmo = g
    const helper = g.getHelper()
    helper.name = 'stunt-gizmo'
    // the gizmo drives its own highlight opacities; the emphasis pass leaves it alone (view/emphasis.ts)
    helper.userData.emphasisKeep = true
    this.gizmoHost.add(helper)
    this.attachGizmo()
  }

  private snapOn(): void {
    // half a metre and five degrees: free dragging gives 4.37 m and 22.6°
    this.gizmo?.setTranslationSnap(0.5)
    this.gizmo?.setRotationSnap(THREE.MathUtils.degToRad(5))
  }

  private snapOff(): void {
    this.gizmo?.setTranslationSnap(null)
    this.gizmo?.setRotationSnap(null)
  }

  setGizmoMode(mode: 'translate' | 'rotate'): void {
    this.gizmoMode = mode
    this.attachGizmo()
    this.onChange()
  }

  get gizmoModeNow(): 'translate' | 'rotate' {
    return this.gizmoMode
  }

  /**
   * Put the anchor where the fixture is, and show the handles that apply.
   *
   * SIZED AGAINST THE PIECE. A loop is eighty metres across and the default gizmo is one unit: a
   * dot in the middle of it, and a rotate ring you cannot see is a rotate ring you cannot drag.
   *
   * ROTATION IS YAW ONLY. `lift_m` raises a fixture and the document has one angle in it; pitch and
   * roll would be edits with nowhere to be saved.
   */
  private attachGizmo(): void {
    const g = this.gizmo
    if (!g) return
    const f = this.passive ? undefined : this.doc.fixtures.find((x) => x.id === this.selected)
    this.gizmoHost.visible = !!f
    if (!f) { g.detach(); return }
    this.anchor.position.set(f.at[0], this.ground(f.at[0], f.at[1]) + (f.lift_m ?? 0), -f.at[1])
    /*
     * ONE SIGN, AND IT IS NOT THE PLACEMENTS' ONE. A placement's `yaw_deg` is a compass bearing —
     * clockwise from north — so `place.ts` negates. A fixture's is anticlockwise from east, which
     * is exactly three's rotation about Y: turning +X by θ gives (cos θ, 0, −sin θ), and the site
     * frame's y is −z, so the site heading is θ itself.
     */
    this.anchor.rotation.set(0, (f.yaw_deg * Math.PI) / 180, 0)
    const { w, h } = fixtureSize(f)
    g.setSize(Math.max(0.6, Math.min(3, 240 / Math.max(20, Math.max(w, h)))))
    g.setMode(this.gizmoMode)
    g.showX = this.gizmoMode === 'translate'
    g.showZ = this.gizmoMode === 'translate'
    g.showY = this.gizmoMode === 'rotate'
    g.attach(this.anchor)
  }

  /** The handle moved the anchor; write that back to the fixture. */
  private readGizmo(): void {
    const f = this.doc.fixtures.find((x) => x.id === this.selected)
    if (!f) return
    f.at = [Math.round(this.anchor.position.x * 10) / 10, Math.round(-this.anchor.position.z * 10) / 10]
    f.yaw_deg = Math.round(((this.anchor.rotation.y * 180) / Math.PI) * 10) / 10
    this.lastYaw = f.yaw_deg
    this.dirty = true
    this.remeshWith(f.id)
    this.refreshMarks()
    this.onChange(false)
  }

  async load(slug: string, h: HeightAt, site: Site | null) {
    this.slug = slug
    this.h = h
    this.site = site
    this.doc = await loadStunts(slug)
    this.dirty = false
    this.selected = null
    this.arming = null
    this.rebuild()
    this.applyRoadSkip()
  }

  /* ---- the road, as the stunt code wants it --------------------------------------------------- */

  private ground = (x: number, y: number): number => this.h(x, y)

  /**
   * The nearest point on ANY driveable chain, not just the spine.
   *
   * Rich, 2026-09-29: *"trying to place it on a secondary road in a network, it always goes to the
   * spine road"*. It did: `nearestStation` searches the spine and nothing else, because until now
   * nothing needed to put an object on a branch. `site.chains()` is the fix, and the search is the
   * same two-pass coarse-then-fine walk — over every chain, keeping the best.
   *
   * COARSE FIRST, AND THE STEP MATTERS. A 20 m coarse pass over four hundred branches is eighty
   * thousand samples per click, which is fine; a 1 m pass would be a second and a half of frozen
   * editor. The fine pass only runs near the winner.
   */
  private nearestOnAnyChain(x: number, y: number): { chain: number; s: number; pos: THREE.Vector3; dir: THREE.Vector3; dist: number } | null {
    const site = this.site
    if (!site) return null
    const wz = -y
    let best: { chain: number; s: number; pos: THREE.Vector3; dir: THREE.Vector3; dist: number } | null = null
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
        best = { chain: c.index, s: bs, pos: at.pos, dir: at.dir, dist }
      }
    }
    return best
  }

  /**
   * Any chain as a `Pose` sampler, which is what `stunts.ts` speaks.
   *
   * PER END, not per fixture: the two ends of a fixture no longer have to be on the same road, so
   * a jump can leave a driveway and land on the highway it crosses.
   */
  private roads = (s: number, chain: number): Pose | null => {
    const site = this.site
    if (!site) return null
    const chains = site.chains()
    const c = chains.find((x) => x.index === chain) ?? chains[0]
    if (!c || s < 0 || s > c.length_m) return null
    const at = c.at(s)
    return { x: at.pos.x, y: -at.pos.z, z: at.pos.y, dx: at.dir.x, dy: -at.dir.z }
  }

  /** The other pieces, so a fixture can be joined to one instead of to a road. */
  private other = (id: string): StuntFixture | null => this.doc.fixtures.find((f) => f.id === id) ?? null

  private links() {
    return { groundAt: this.ground, fixture: this.other }
  }

  /**
   * Tell the road not to draw itself where a fixture stands.
   *
   * Rich: *"don't render the openstreet map road underneath the stunt"*. The fixture IS the road
   * there, and drawing both puts a strip of tarmac through the middle of a loop.
   *
   * BY STATION, not by point, because that is the question the road builder can answer — it emits
   * quads along the spine and knows the `s` of each. So a footprint is turned into the run of
   * stations it covers, once, when the fixtures change: sampling the spine per quad per frame to
   * ask a polygon would be the same answer computed a thousand times.
   */
  private applyRoadSkip() {
    const site = this.site
    if (!site) return
    /*
     * EVERY CHAIN, NOT JUST THE SPINE. A fixture on a branch used to be listed with "the baked
     * road under a branch is not hidden yet" — Rich, 2026-09-30, with his loop on Patuxent River
     * Road and the tarmac drawn straight through it. Each chain's fixtures are looked up on that
     * chain alone, so a loop over a crossroads holes both roads and nothing else.
     */
    const chains = site.chains()
    const byChain = new Map<number, [number, number][]>()
    const STEP = 4
    for (const c of chains) {
      const here = this.doc.fixtures.filter((f) => (f.chain ?? 0) === c.index)
      if (!here.length) continue
      const lookup = new Stunts()
      lookup.set(here)
      const covered: [number, number][] = []
      let from: number | null = null
      for (let s = 0; s <= c.length_m; s += STEP) {
        const p = c.at(s).pos
        const hit = lookup.coversRoad(p.x, -p.z)
        if (hit && from === null) from = s
        else if (!hit && from !== null) { covered.push([from, s]); from = null }
      }
      if (from !== null) covered.push([from, c.length_m])
      if (covered.length) byChain.set(c.index, covered)
    }
    site.setRoadSkip(byChain.size
      ? (chain: number, s: number) => (byChain.get(chain)?.some(([a, b]) => s >= a && s <= b) ?? false)
      : null)
  }

  /* ---- geometry ------------------------------------------------------------------------------- */

  private rebuild() {
    for (const r of this.built.values()) {
      this.group.remove(r.group)
      r.dispose()
    }
    this.built.clear()
    for (const f of this.doc.fixtures) this.remesh(f.id)
    this.refreshMarks()
  }

  /**
   * Rebuild a fixture and whatever is joined to it.
   *
   * ONE LEVEL IS ENOUGH: a piece's own ports depend on its position and yaw alone, never on its
   * links, so moving A changes A's curves and the curves of whoever names A — and stops there.
   */
  private remeshWith(id: string) {
    this.remesh(id)
    for (const f of this.doc.fixtures) if (f.id !== id && linksTo(f, id)) this.remesh(f.id)
  }

  private remesh(id: string) {
    const old = this.built.get(id)
    if (old) {
      this.group.remove(old.group)
      old.dispose()
      this.built.delete(id)
    }
    const f = this.doc.fixtures.find((x) => x.id === id)
    if (!f || !pieceOf(f.piece)) return
    const parts = connectFixture(f, this.roads, this.links())
    if (!parts) return
    const r = buildFixture(f, parts, {
      colour: f.id === this.selected ? 0x3b4250 : 0x2b2f36,
      // the fixture's own surfacing — plain tarmac, or STUNTIN's red-and-white kerbs
      kerbs: f.style === 'stuntin',
    })
    this.built.set(id, r)
    // the fixture is road, not a mark: solid in every mode (view/emphasis.ts)
    r.group.userData.emphasisKeep = true
    this.group.add(r.group)
  }

  /**
   * The handles: one to turn it, two on the road for the ends.
   *
   * They are spheres on the ground rather than a gizmo because every other tool in this editor
   * drags spheres on the ground, and a fixture is the only thing here that has a heading — one new
   * interaction is enough.
   */
  private refreshMarks() {
    this.marks.clear()
    const f = this.doc.fixtures.find((x) => x.id === this.selected)
    // NOT WHILE IT IS BEING DRAGGED: re-seating the anchor mid-gesture fights the handle
    if (!this.dragging) this.attachGizmo()
    if (!f) return

    // the footprint, so you can see what road it is standing on
    const poly = fixtureFootprint(f)
    const pts = [...poly, poly[0]].map(([x, y]) => new THREE.Vector3(x, this.ground(x, y) + 0.5, -y))
    const g = new THREE.BufferGeometry().setFromPoints(pts)
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: FOOTPRINT, depthTest: false }))
    line.renderOrder = 11
    this.marks.add(line)

    // MOVE, in the middle of it. Rich, 2026-09-29: "there doesn't seem to be a way to move the
    // whole fixture after you place it. You can move the ends and the heading, but not the whole
    // thing up and down a road."
    this.marks.add(this.handle(f.at[0], f.at[1], 'move', MOVE))

    const { w } = fixtureSize(f)
    const a = (f.yaw_deg * Math.PI) / 180
    const yawAt = { x: f.at[0] + Math.cos(a) * (w / 2 + 14), y: f.at[1] + Math.sin(a) * (w / 2 + 14) }
    this.marks.add(this.handle(yawAt.x, yawAt.y, 'yaw', SELECTED))

    /*
     * THE ENDS, WHEREVER THEY ARE. A road end is a handle on the tarmac you can drag along it; a
     * fixture end is a handle on the piece it is joined to, drawn in a different colour and not
     * draggable — dragging it would mean dragging the OTHER piece, which is a different gesture.
     * An open end has no handle at all, because there is nothing to point at.
     */
    const ends = endsOf(f)
    for (const which of ['entry', 'exit'] as const) {
      const end = ends[which]
      if (end.kind === 'none') continue
      const p = resolveEnd(end, which, this.roads, this.links()).pose
      if (!p) continue
      const h = this.handle(p.x, p.y, which, end.kind === 'road' ? FOOTPRINT : LINK)
      // a link's handle is a marker, not a grab point
      if (end.kind !== 'road') h.userData = {}
      this.marks.add(h)
    }
  }

  private handle(x: number, y: number, what: 'move' | 'yaw' | 'entry' | 'exit', colour: number): THREE.Mesh {
    const m = handleMesh(colour, 3)
    m.position.set(x, this.ground(x, y) + 1.2, -y)
    m.userData = { stuntHandle: what }
    return m
  }

  /* ---- editing --------------------------------------------------------------------------------- */

  /** Arm a piece: the next click on the ground places one. */
  arm(piece: string | null) {
    this.arming = piece
    if (piece) this.panelTab = 'pieces'
    this.onChange()
  }

  /** which of the panel's two tabs is up: what you can add, or what is placed */
  panelTab: 'pieces' | 'placed' = 'pieces'

  /** A piece dragged from the palette and let go on the world: placed there, once. */
  dropAt(pt: { x: number; y: number }, piece: string): boolean {
    const was = this.arming
    this.arming = piece
    const id = this.placeAt(pt)
    this.arming = id ? null : was
    if (id) this.select(id)
    else this.onChange()
    return !!id
  }

  select(id: string | null) {
    if (id) this.panelTab = 'placed'
    const was = this.selected
    this.selected = id
    if (was) this.remesh(was)
    if (id) this.remesh(id)
    this.refreshMarks()
    this.attachGizmo()
    this.onChange()
  }

  remove(id: string) {
    /*
     * AND ANY JOIN TO IT. A link to a piece that is gone is a warning on somebody else's panel and
     * a curve to nowhere — the kind of dangling reference you only find a week later.
     */
    const orphaned = this.doc.fixtures.filter((f) => f.id !== id && linksTo(f, id))
    for (const f of orphaned) {
      for (const which of ['entry', 'exit'] as const) {
        const e = endsOf(f)[which]
        if (e.kind === 'fixture' && e.id === id) setEnd(f, which, { kind: 'none' })
      }
    }
    this.doc.fixtures = this.doc.fixtures.filter((f) => f.id !== id)
    const r = this.built.get(id)
    if (r) {
      this.group.remove(r.group)
      r.dispose()
      this.built.delete(id)
    }
    for (const f of orphaned) this.remesh(f.id)
    this.dirty = true
    this.applyRoadSkip()
    if (this.selected === id) this.select(null)
    else this.onChange()
  }

  /**
   * Place one where the pointer is.
   *
   * TWO BEHAVIOURS, AND THE TOGGLE PICKS ONE. Snapped — the default — the fixture is centred on the
   * nearest road, faces along it, and both ends are joined to that road a clear distance either
   * side: the loop-over-Route-450 case, one click. Free, it goes exactly where you clicked with
   * both ends open, which is how a track gets built somewhere there is no road at all.
   *
   * SNAPPING IS RANGE-LIMITED even when it is on. Clicking the middle of a field with snapping left
   * on used to drag the piece half a kilometre to whatever road happened to be nearest; now a click
   * further than `SNAP_M` from any tarmac is taken at its word.
   *
   * A FREE PLACEMENT INHERITS THE SELECTED PIECE'S HEADING AND JOINS ONTO IT when that piece's exit
   * is open. Laying a track is laying one piece after another, and having each new piece arrive
   * pointing the right way and already joined to the last is the difference between building a
   * track and assembling one.
   */
  placeAt(pt: { x: number; y: number }): string | null {
    const piece = this.arming
    if (!piece || !pieceOf(piece)) return null
    const st = this.snapToRoad ? this.nearestOnAnyChain(pt.x, pt.y) : null
    const onRoad = st && st.dist <= SNAP_M ? st : null

    const id = nextId('sx', this.doc.fixtures.map((x) => x.id))
    const f: StuntFixture = {
      id,
      name: pieceOf(piece)!.label,
      piece,
      at: [pt.x, pt.y],
      yaw_deg: this.lastYaw,
      tightness: DEFAULT_TIGHTNESS,
    }

    if (onRoad) {
      const { w } = fixtureSize(f)
      const clear = w / 2 + 60
      const len = this.site?.chains().find((c) => c.index === onRoad.chain)?.length_m ?? 0
      // ON THE ROAD, not on the click: a fixture that replaces a stretch of road has to be centred
      // on it, and a click is never more accurate than the road already is.
      f.at = [onRoad.pos.x, -onRoad.pos.z]
      f.yaw_deg = (Math.atan2(-onRoad.dir.z, onRoad.dir.x) * 180) / Math.PI
      f.chain = onRoad.chain
      setEnd(f, 'entry', { kind: 'road', chain: onRoad.chain, s: Math.max(0, onRoad.s - clear) })
      setEnd(f, 'exit', { kind: 'road', chain: onRoad.chain, s: Math.min(len, onRoad.s + clear) })
    } else {
      const prev = this.doc.fixtures.find((x) => x.id === this.selected)
      const prevExit = prev ? endsOf(prev).exit : null
      const port = prev ? fixturePorts(prev, this.ground(prev.at[0], prev.at[1])) : null
      if (prev && port && prevExit?.kind === 'none') {
        f.yaw_deg = (Math.atan2(port.exit.dy, port.exit.dx) * 180) / Math.PI
        // BOTH SIDES ARE WRITTEN so both panels tell the truth; `connectFixture` draws the curve once
        setEnd(f, 'entry', { kind: 'fixture', id: prev.id, port: 'exit' })
        setEnd(prev, 'exit', { kind: 'fixture', id: f.id, port: 'entry' })
      }
    }

    this.lastYaw = f.yaw_deg
    this.doc.fixtures.push(f)
    this.dirty = true
    this.arming = null
    this.remeshWith(f.id)
    this.applyRoadSkip()
    this.select(f.id)
    return f.id
  }

  /**
   * Join one end of the selected fixture to something you are about to click.
   *
   * Rich: *"then click waypoints to add them back to a section of road"*. Two steps rather than a
   * drag because the thing being picked may be a kilometre away and off screen: arm the end, fly
   * there, click the tarmac.
   */
  link(which: StuntPort, what: 'road' | 'fixture' | null) {
    this.linking = what ? { which, what } : null
    this.arming = null
    this.onChange()
  }

  /** Open an end again. The piece stays where it is; only the curve goes. */
  unlink(which: StuntPort) {
    const f = this.doc.fixtures.find((x) => x.id === this.selected)
    if (!f) return
    const was = endsOf(f)[which]
    setEnd(f, which, { kind: 'none' })
    // and the other side of a mutual join, or it keeps drawing a curve to a piece that has let go
    if (was.kind === 'fixture') {
      const other = this.other(was.id)
      const back = other ? endsOf(other)[was.port ?? defaultPort(which)] : null
      if (other && back?.kind === 'fixture' && back.id === f.id) setEnd(other, was.port ?? defaultPort(which), { kind: 'none' })
    }
    this.dirty = true
    this.remeshWith(f.id)
    this.refreshMarks()
    this.onChange()
  }

  /** Take the pick: the ground point becomes a road station, or names the fixture under it. */
  private takeLink(pt: { x: number; y: number }): boolean {
    const job = this.linking
    const f = this.doc.fixtures.find((x) => x.id === this.selected)
    if (!job || !f) return false
    if (job.what === 'road') {
      const st = this.nearestOnAnyChain(pt.x, pt.y)
      if (!st) return false
      setEnd(f, job.which, { kind: 'road', chain: st.chain, s: st.s })
    } else {
      const hit = this.fixtureAt(pt)
      if (!hit || hit.id === f.id) return false
      const port = defaultPort(job.which)
      setEnd(f, job.which, { kind: 'fixture', id: hit.id, port })
      setEnd(hit, port, { kind: 'fixture', id: f.id, port: job.which })
      this.remesh(hit.id)
    }
    this.linking = null
    this.dirty = true
    this.remeshWith(f.id)
    this.refreshMarks()
    this.applyRoadSkip()
    this.onChange()
    return true
  }

  /** What is here, without taking the click — see `areas.pick`. */
  pick(pt: { x: number; y: number }): { id: string; size: number } | null {
    const f = this.fixtureAt(pt)
    if (!f) return null
    const { w, h } = fixtureSize(f)
    return { id: f.id, size: w * h }
  }

  get busy(): boolean {
    return !!this.arming || !!this.linking
  }

  /**
   * Another mode is the one being worked in: the fixtures stay drawn (they are road), the gizmo
   * comes off — see the same note on `PlaceMode.setPassive`.
   */
  private passive = false
  setPassive(on: boolean) {
    if (this.passive === on) return
    this.passive = on
    this.attachGizmo()
  }

  /** A fixture's footprint, for the editor's hover ring. */
  outline(id: string): [number, number][] | null {
    const f = this.doc.fixtures.find((x) => x.id === id)
    return f ? fixtureFootprint(f) : null
  }

  /** Each fixture's name, for the active mode's labels. */
  labels(): { id: string; text: string; at: [number, number] }[] {
    return this.doc.fixtures.map((f) => ({ id: f.id, text: f.name, at: f.at }))
  }

  /** The smallest footprint under a point, so a jump inside a long banked run is reachable. */
  private fixtureAt(pt: { x: number; y: number }): StuntFixture | null {
    let best: { f: StuntFixture; size: number } | null = null
    for (const f of this.doc.fixtures) {
      const { w, h } = fixtureSize(f)
      const d = Math.hypot(pt.x - f.at[0], pt.y - f.at[1])
      if (d > Math.max(w, h) / 2) continue
      if (!best || w * h < best.size) best = { f, size: w * h }
    }
    return best?.f ?? null
  }

  click(pt: { x: number; y: number } | null) {
    // a pick in progress owns the click: you are answering a question, not selecting
    if (this.linking && pt && this.takeLink(pt)) return
    if (this.arming && pt) {
      this.placeAt(pt)
      return
    }
    if (!pt) return this.select(null)
    this.select(this.fixtureAt(pt)?.id ?? null)
  }

  grab(ray: THREE.Raycaster): boolean {
    const hit = ray.intersectObjects(this.marks.children, false)[0]
    this.grabbed = hit ? ((hit.object.userData.stuntHandle as 'move' | 'yaw' | 'entry' | 'exit') ?? null) : null
    return this.grabbed !== null
  }

  dragTo(pt: { x: number; y: number } | null) {
    const f = this.doc.fixtures.find((x) => x.id === this.selected)
    if (!this.grabbed || !pt || !f) return
    if (this.grabbed === 'yaw') {
      f.yaw_deg = (Math.atan2(pt.y - f.at[1], pt.x - f.at[0]) * 180) / Math.PI
      this.lastYaw = f.yaw_deg
    } else if (this.grabbed === 'move') {
      this.moveTo(f, pt)
    } else if (this.site) {
      /*
       * An end is dragged ONTO THE ROAD UNDER THE POINTER — the nearest station on any chain, not
       * the pointer itself, and not necessarily the chain the other end is on. It used to be locked
       * to the fixture's own chain, which made "leave the driveway, land on the main road" a thing
       * you could author only by editing the JSON.
       */
      const st = this.nearestOnAnyChain(pt.x, pt.y)
      if (st) setEnd(f, this.grabbed, { kind: 'road', chain: st.chain, s: st.s })
    }
    this.dirty = true
    this.remeshWith(f.id)
    this.refreshMarks()
    this.onChange(false)
  }

  /**
   * Slide a fixture to a new place.
   *
   * IT FOLLOWS THE ROAD, because "up and down a road" is what moving one is for: the pointer picks
   * the nearest station on any chain and the fixture is centred on it. Dragged far from every road
   * it goes wherever it is put, which is how you stand a jump in a field.
   *
   * THE HEADING KEEPS ITS OFFSET rather than being reset. A fixture aligned with the road stays
   * aligned as it slides round a bend; one somebody deliberately skewed twenty degrees stays skewed
   * twenty degrees. Re-aiming it would silently undo a deliberate rotation, and leaving it alone
   * would leave a loop sideways across the road after a corner.
   */
  private moveTo(f: StuntFixture, pt: { x: number; y: number }) {
    /*
     * FREE WHEN SNAPPING IS OFF, and free when nothing is near enough either way. A piece standing
     * in a field goes exactly where it is put; one on a road slides along it.
     */
    const st = this.snapToRoad ? this.nearestOnAnyChain(pt.x, pt.y) : null
    if (!st || st.dist > SNAP_M) {
      f.at = [pt.x, pt.y]
      return
    }
    const ends = endsOf(f)
    const road = ends.entry.kind === 'road' && ends.exit.kind === 'road' ? { a: ends.entry, b: ends.exit } : null
    const before = road ? this.roads((road.a.s + road.b.s) / 2, road.a.chain ?? 0) : null
    const oldRoadYaw = before ? (Math.atan2(before.dy, before.dx) * 180) / Math.PI : f.yaw_deg
    const skew = f.yaw_deg - oldRoadYaw

    const span = road ? Math.abs(road.b.s - road.a.s) / 2 : fixtureSize(f).w / 2 + 60
    f.chain = st.chain
    f.at = [st.pos.x, -st.pos.z]
    f.yaw_deg = (Math.atan2(-st.dir.z, st.dir.x) * 180) / Math.PI + skew
    this.lastYaw = f.yaw_deg
    /*
     * THE ENDS COME WITH IT ONLY IF THEY WERE ON A ROAD. A piece joined to another piece keeps that
     * join when it slides; re-pointing it at tarmac would silently undo the track somebody built.
     */
    if (road) {
      const len = this.site?.chains().find((c) => c.index === st.chain)?.length_m ?? 0
      setEnd(f, 'entry', { kind: 'road', chain: st.chain, s: Math.max(0, st.s - span) })
      setEnd(f, 'exit', { kind: 'road', chain: st.chain, s: Math.min(len, st.s + span) })
    }
  }

  drop() {
    if (!this.grabbed) return
    this.grabbed = null
    // ON DROP, NOT ON EVERY MOVE: rebuilding the whole road per pointer event is a freeze.
    this.applyRoadSkip()
    this.onChange()
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'g' && this.selected) {
      this.setGizmoMode(this.gizmoMode === 'translate' ? 'rotate' : 'translate')
      return true
    }
    if (e.key === 'Escape' && this.linking) { this.link(this.linking.which, null); return true }
    if (e.key === 'Escape' && this.arming) { this.arm(null); return true }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.remove(this.selected); return true }
    // Z and X turn it; Q and E fly the camera. See the note in `place.ts`.
    if (this.selected && (e.key === 'z' || e.key === 'x')) {
      const f = this.doc.fixtures.find((x) => x.id === this.selected)!
      f.yaw_deg += e.key === 'z' ? 5 : -5
      this.lastYaw = f.yaw_deg
      this.dirty = true
      this.remeshWith(f.id)
      this.refreshMarks()
      this.onChange(false)
      return true
    }
    return false
  }

  async save(): Promise<string> {
    // each fixture against ITS OWN chain — a branch fixture checked against the spine reads as
    // "the road does not reach that far" for every one of them
    // THE WHOLE DOCUMENT AT ONCE, because a fixture joined to another one cannot be checked alone
    const report = validateStunts(this.doc, this.roads, this.links())
    if (report.errors.length) throw new Error(report.errors[0])
    const bytes = await saveStunts(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.fixtures.length} fixtures (${bytes} bytes) to ${this.slug}/stunts.json`
  }

  /* ---- the panel -------------------------------------------------------------------------------- */

  panel(root: HTMLElement, go: (f: StuntFixture) => void) {
    root.replaceChildren()
    paneTabs(root, [{ id: 'pieces', label: 'Pieces' }, { id: 'placed', label: `Placed (${this.doc.fixtures.length})` }], this.panelTab, (id) => {
      this.panelTab = id as 'pieces' | 'placed'
      this.onChange()
    })
    if (this.panelTab === 'pieces') {
      this.piecesTab(root)
      return
    }
    this.placedTab(root, go)
  }

  private piecesTab(root: HTMLElement) {
    const where = this.snapToRoad ? 'the road' : 'anywhere'
    root.append(el('p', 'dim', this.linking
      ? `click the ${this.linking.what === 'road' ? 'road' : 'piece'} you want the ${this.linking.which} joined to — Esc to stop`
      : this.arming
        ? `click ${where} to place a ${pieceOf(this.arming)?.label ?? this.arming} — Esc to put it back`
        : `drag a piece onto ${where}, or pick it and click`))
    const palette = el('div', 'palette')
    for (const def of stuntPieces()) {
      palette.append(dragChip({
        mode: 'stunts', id: def.type, label: def.label, title: def.desc,
        on: this.arming === def.type,
        onClick: () => this.arm(this.arming === def.type ? null : def.type),
      }))
    }
    root.append(palette)

    const snapRow = el('div', 'row swatches')
    for (const on of [true, false]) {
      const b = el('button', this.snapToRoad === on ? 'chip on' : 'chip')
      b.textContent = on ? 'snap to the road' : 'place it freely'
      b.title = on
        ? 'centre it on the nearest road, face it along it, and join both ends to it'
        : 'put it exactly where you click, with both ends open — then join them up by hand'
      b.onclick = () => { this.snapToRoad = on; this.onChange() }
      snapRow.append(b)
    }
    root.append(snapRow)
  }

  private placedTab(root: HTMLElement, go: (f: StuntFixture) => void) {
    const list = el('div', 'list')
    for (const f of this.doc.fixtures) {
      const row = el('div', `item${f.id === this.selected ? ' sel' : ''}`)
      row.append(el('span', 'tag', f.piece), el('span', 'nm', f.name), el('span', 'mono', `${f.yaw_deg.toFixed(0)}°`))
      row.onclick = () => this.select(f.id)
      row.ondblclick = () => go(f)
      list.append(row)
    }
    if (!this.doc.fixtures.length) list.append(el('p', 'dim', 'Nothing placed yet.'))
    root.append(list)

    const f = this.doc.fixtures.find((x) => x.id === this.selected)
    if (!f) return

    const det = el('div', 'detail')
    const chainName = this.site?.chains().find((c) => c.index === (f.chain ?? 0))?.name ?? 'spine'
    det.append(el('h2', '', `${f.id} · ${describeFixture(f)}`))
    det.append(el('p', 'dim', `on ${chainName}`))

    /*
     * REMOVE AND TURN ROUND, as buttons.
     *
     * Rich, 2026-09-29: *"doesn't seem to be a way to delete stunts after you place them"*. Delete
     * and Backspace worked, and that is not the same as there being a way: a key nobody is told
     * about, on a screen with no control that mentions removing anything, is not discoverable, and
     * the first fixture anybody places is the one they want to take back.
     *
     * "Turn it round" is beside it because a fixture facing backwards is the single most likely
     * thing to be wrong with one, and a hundred and eighty degrees is a tedious drag.
     */
    /*
     * WHICH HANDLES ARE SHOWING, as two buttons. The gizmo has always been draggable and nothing on
     * screen said which mode it was in, which is how a rotate ring nobody could find stayed unfound.
     */
    const handles = el('div', 'row')
    for (const [m, label] of [['translate', 'move'], ['rotate', 'turn']] as const) {
      const btn = el('button', this.gizmoModeNow === m ? 'on' : '')
      btn.textContent = `${label} (G)`
      btn.onclick = () => this.setGizmoMode(m)
      handles.append(btn)
    }
    handles.append(el('span', 'dim', 'drag the handles; hold shift for fine. The white ball slides it along the road'))
    det.append(handles)

    const tools = el('div', 'row')
    const flip = el('button')
    flip.textContent = 'turn it round'
    flip.title = 'rotate 180° — the usual fix when the approach doubles back'
    flip.onclick = () => {
      f.yaw_deg = ((f.yaw_deg + 360) % 360) - 180
      this.lastYaw = f.yaw_deg
      this.dirty = true
      this.remeshWith(f.id)
      this.applyRoadSkip()
      this.refreshMarks()
      this.onChange()
    }
    const swap = el('button')
    swap.textContent = 'swap the ends'
    swap.title = 'drive it the other way: the entry becomes the exit'
    swap.onclick = () => {
      // WHOLE ENDS, whatever they are joined to: a piece can now be turned round mid-track
      const e = endsOf(f)
      setEnd(f, 'entry', e.exit)
      setEnd(f, 'exit', e.entry)
      this.dirty = true
      this.remeshWith(f.id)
      this.refreshMarks()
      this.onChange()
    }
    const del = el('button', 'danger')
    del.textContent = 'remove'
    del.title = 'Delete also does this'
    del.onclick = () => this.remove(f.id)
    tools.append(flip, swap, del)
    det.append(tools)

    const name = document.createElement('input')
    name.type = 'text'
    name.value = f.name
    name.oninput = () => {
      f.name = name.value
      this.dirty = true
      for (const row of list.querySelectorAll('.item.sel .nm')) row.textContent = name.value
      this.onChange(false)
    }
    det.append(name)

    const live = (apply: () => void) => {
      apply()
      this.dirty = true
      this.remeshWith(f.id)
      this.refreshMarks()
      this.onChange(false)
    }
    /*
     * SURFACING. Rich, 2026-09-29: *"It would be great if they could texture the same as our roads
     * in the game, with the option to use the stuntin' styles with the red and white rumble strips
     * on the outsides."* On a loop the kerbs are not decoration — upside down they are the only
     * thing telling you where the surface ends.
     */
    const styles = el('div', 'row swatches')
    for (const st of STUNT_STYLES) {
      const b = el('button', (f.style ?? 'road') === st ? 'chip on' : 'chip')
      b.textContent = st === 'road' ? 'road tarmac' : 'stuntin’ kerbs'
      b.title = st === 'road'
        ? 'the same surface as the road it replaces'
        : 'red and white down both edges, the way the arcade games draw a loop'
      b.onclick = () => {
        f.style = st
        this.dirty = true
        this.remesh(f.id)
        this.onChange()
      }
      styles.append(b)
    }
    det.append(el('h3', '', 'Surface'))
    det.append(styles)

    det.append(slider('heading °', f.yaw_deg, -180, 180, 1, f.yaw_deg, 'which way it is entered — Z and X nudge it', (v) => live(() => { f.yaw_deg = v })))
    det.append(slider('lift m', f.lift_m ?? 0, 0, 30, 0.5, 0, 'float it above the road', (v) => live(() => { f.lift_m = v })))
    det.append(slider('approach tightness', f.tightness ?? DEFAULT_TIGHTNESS, 0.25, 2, 0.05, DEFAULT_TIGHTNESS,
      'small is a direct curve, large is a long sweep', (v) => live(() => { f.tightness = v })))

    /*
     * THE TWO ENDS, each with the three things it can be.
     *
     * Rich: *"then click waypoints to add them back to a section of road — or not have them link to
     * roads at all"*. So an end is a small state machine whose state you can read: what it is joined
     * to now, and one button for each other thing it could be joined to. The station stays a slider
     * as well, because nudging where a loop rejoins the tarmac by ten metres is a real thing to want
     * and dragging a handle that is a kilometre away is not how you do it.
     */
    det.append(el('h3', '', 'Ends'))
    const ends = endsOf(f)
    for (const which of ['entry', 'exit'] as const) {
      const end: StuntEnd = ends[which]
      const block = el('div', 'field')
      block.append(el('label', '', which === 'entry' ? 'comes in from' : 'goes out to'))
      block.append(el('p', 'dim', describeEnd(end, which)))
      const row = el('div', 'row swatches')
      const pick = (what: 'road' | 'fixture') => {
        const armed = this.linking?.which === which && this.linking.what === what
        const b = el('button', armed ? 'chip on' : 'chip')
        b.textContent = what === 'road' ? 'join it to a road…' : 'join it to a piece…'
        b.title = what === 'road'
          ? 'then click the tarmac: the curve leaves along the road’s own tangent'
          : 'then click another fixture: the two are joined by the same kind of curve'
        b.onclick = () => this.link(which, armed ? null : what)
        return b
      }
      row.append(pick('road'), pick('fixture'))
      if (end.kind !== 'none') {
        const off = el('button', 'chip')
        off.textContent = 'leave it open'
        off.title = 'the piece stays where it is; only the curve goes'
        off.onclick = () => this.unlink(which)
        row.append(off)
      }
      block.append(row)
      det.append(block)
      if (end.kind === 'road') {
        const chain = end.chain ?? 0
        const len = this.site?.chains().find((c) => c.index === chain)?.length_m ?? 0
        if (len) {
          det.append(slider(`${which} at m`, end.s, 0, len, 5, end.s,
            which === 'entry' ? 'where it leaves the road' : 'where it rejoins it',
            (v) => live(() => { setEnd(f, which, { kind: 'road', chain, s: v }) })))
        }
      }
    }

    /*
     * WHAT IS WRONG WITH IT, in the panel rather than in the console. The one that matters is a
     * fixture facing the wrong way: the footprint is on the road, the curves are curves, and the
     * only symptom is that it cannot be driven.
     */
    const report = validateStunts({ version: 1, fixtures: [f] }, this.roads, this.links())
    for (const e of report.errors) det.append(el('div', 'field-error', e))
    // drivability problems are warnings — they do not stop a save, and "turn it round" fixes most
    for (const w of report.warnings) det.append(el('div', 'field-error', w))
    root.append(det)
  }
}
