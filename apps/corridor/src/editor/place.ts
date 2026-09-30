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
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { instanceOf, loadCatalog, tintOf, type Catalog, type CatalogEntry } from './catalog'
import { frameMismatch, frameOf, isGenerated, loadPlacements, nextId, savePlacements, type Placement, type Placements } from './schema'
import { yawFacingRoad } from './corridor'
import { el, frameBanner, paneTabs } from './ui'
import { MeshView } from '../ui/meshview'
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
  /** set when the file's coordinates were authored in a different frame from the bake's */
  frameWarning: string | null = null
  private grabbed: string | null = null
  /**
   * The move/rotate handles on the selected object.
   *
   * Rich, 2026-09-28: "We can't move or rotate the item after we place it, we need handles so we
   * can do this." You could, in fact — press and drag moved it, Q and E spun it — but neither of
   * those is visible, and an editor whose capabilities are only discoverable by trying things is
   * an editor that does not have them.
   *
   * Created lazily in `attach`, because it needs the camera and the canvas and this class is
   * constructed before either exists.
   */
  private gizmo: TransformControls | null = null
  private gizmoMode: 'translate' | 'rotate' = 'translate'
  /**
   * True from the moment a press lands on a gizmo handle until it is released.
   *
   * The editor's own `pointerdown` sets `orbit.enabled = !grabbing`, which would undo the hold this
   * put on the camera; it reads this instead. See the note in `useGizmo`.
   */
  onGizmo = false
  /** set while a handle is being dragged, so the ordinary pointer handling keeps out of the way */
  dragging = false
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
    this.frameWarning = frameMismatch(this.doc.frame, site.manifest, this.doc.items.length)
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
    o.rotation.y = -((p.yaw_deg + (this.entry(p.asset)?.yaw_offset_deg ?? 0)) * Math.PI) / 180
    o.scale.setScalar(p.scale)
  }

  /**
   * A stand-in for a placement whose asset this catalog has never heard of.
   *
   * WITHOUT ONE THE PLACEMENT DOES NOT EXIST IN THE EDITOR. `spawn` used to return early, so there
   * was no object: nothing drawn, nothing to click, nothing for the gizmo to attach to — and no
   * message either. Rich, 2026-09-29: *"drag and rotate handles (gizmo) for placed assets don't do
   * anything"*. They were working perfectly on every placement that had a model; the ones without
   * one were invisible to the whole tool, and the only symptom was a gizmo that never appeared.
   *
   * The viewer already draws a box in the same situation (`placements.ts`). This is the same
   * admission, made selectable: you can still move it, turn it, delete it, and — the point — see
   * that it is there at all while the asset service is sorted out.
   */
  private proxy(p: Placement): THREE.Object3D {
    const g = new THREE.Group()
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshBasicMaterial({ color: 0xff8a2b, wireframe: true, depthTest: false }),
    )
    box.renderOrder = 10
    g.add(box)
    g.userData.proxyFor = p.asset
    return g
  }

  /** Placements whose asset is missing from this catalog, for the panel to name. */
  missingAssets(): { id: string; asset: string }[] {
    return this.doc.items
      .filter((p) => !this.entry(p.asset))
      .map((p) => ({ id: p.id, asset: p.asset }))
  }

  private async spawn(p: Placement) {
    const e = this.entry(p.asset)
    if (!e) {
      const proxy = this.proxy(p)
      proxy.userData.placeId = p.id
      proxy.traverse((c) => (c.userData.placeId = p.id))
      this.place(proxy, p)
      this.objects.set(p.id, proxy)
      this.group.add(proxy)
      return
    }
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
    this.attachGizmo()
    this.onChange()
  }

  /**
   * Give the editor a camera and a canvas, so the handles can exist.
   *
   * `onOrbit(false)` has to turn the camera controls off while a handle is being dragged, or the
   * same pointer both drags the object and orbits the world, and the object runs away.
   */
  useGizmo(camera: THREE.Camera, dom: HTMLElement, onOrbit: (enabled: boolean) => void): void {
    if (this.gizmo) return
    const g = new TransformControls(camera, dom)
    g.setSpace('world')
    this.snapOn()
    g.addEventListener('dragging-changed', (e) => {
      this.dragging = !!(e as unknown as { value: boolean }).value
      onOrbit(!this.dragging)
      // the panel is rebuilt only when the drag ENDS: doing it per frame tears the field you are
      // dragging out from under the pointer
      if (!this.dragging) this.onChange()
    })

    /*
     * THE CAMERA MUST LET GO BEFORE THE HANDLE IS GRABBED, not after.
     *
     * `dragging-changed` fires from TransformControls' own pointerdown — by which time
     * OrbitControls has already seen the same event and begun a rotate, because it captured the
     * pointer and only consults `enabled` when the gesture STARTS. So dragging a handle also spun
     * the world (Rich, 2026-09-28: "Clicking and dragging the gizmo also rotates the map").
     *
     * A capture-phase listener runs before either of them. `axis` is non-null whenever the pointer
     * is over a handle, which is exactly the condition for "this press belongs to the gizmo".
     *
     * AND IT MUST NOT CALL `stopPropagation`, which is what it did.
     *
     * Stopping propagation from a CAPTURE listener ON THE TARGET cancels that target's BUBBLE phase
     * as well — the two phases are separate visits to the same node, and the stop flag is checked
     * between them. TransformControls registers its own `pointerdown` without a capture flag, so it
     * is a bubble listener on this very element, and it never ran. The gizmo highlighted on hover,
     * because `pointermove` was untouched, and did nothing at all on press (Rich, 2026-09-29:
     * "clicking and dragging does nothing. It highlights like it is going to do something but
     * nothing happens").
     *
     * So the press is allowed through and the camera is held off by a FLAG instead: `onGizmo` is
     * read by the editor's own pointerdown, which would otherwise re-enable the orbit a moment
     * later. Three listeners on one event, and only one of them may own the gesture.
     */
    dom.addEventListener('pointerdown', () => {
      if (g.axis === null) return
      this.onGizmo = true
      onOrbit(false)
    }, true)
    addEventListener('pointerup', () => {
      this.onGizmo = false
      if (!this.dragging) onOrbit(true)
    })

    /*
     * SNAPPED BY DEFAULT, FREE WHILE SHIFT IS DOWN.
     *
     * Rich, 2026-09-28: "I'd want autorotation that snaps and then manual rotation." A dropped
     * asset already takes the road's bearing; from there every nudge lands on five degrees, which
     * is how a row of fence posts ends up actually aligned rather than nearly. Shift is the
     * escape hatch for the one that has to sit at 37°.
     *
     * three's TransformControls has no modifier of its own — the snap values are simply on or
     * off — so the modifier is wired here.
     */
    addEventListener('keydown', (e) => { if (e.key === 'Shift') this.snapOff() })
    addEventListener('keyup', (e) => { if (e.key === 'Shift') this.snapOn() })
    g.addEventListener('objectChange', () => this.readGizmo())
    this.gizmo = g
    const helper = g.getHelper()
    helper.name = 'place-gizmo'
    this.group.add(helper)
    this.attachGizmo()
  }

  /** Which handles, if any, are on screen. */
  private attachGizmo(): void {
    const g = this.gizmo
    if (!g) return
    const o = this.selected ? this.objects.get(this.selected) : null
    if (!o) { g.detach(); return }
    g.setMode(this.gizmoMode)
    // SIZED AGAINST THE THING. The default gizmo is one unit across, which on a 40 m barn is a
    // dot in the middle of it and on a 0.3 m bollard swallows the model — and a rotate ring you
    // cannot see is a rotate ring you cannot drag.
    const e = this.entry(this.doc.items.find((x) => x.id === this.selected)?.asset ?? '')
    const span = e ? Math.max(e.footprint_m[0], e.footprint_m[1], e.height_m) : 4
    g.setSize(Math.max(0.6, Math.min(3, 12 / Math.max(2, span))))
    // ROTATION IS YAW ONLY. A building tilted off the vertical is never what somebody meant, and
    // the document has one angle in it — pitch and roll would be edits with nowhere to be saved.
    g.showX = this.gizmoMode === 'translate'
    g.showZ = this.gizmoMode === 'translate'
    g.showY = this.gizmoMode === 'rotate'
    g.attach(o)
  }

  /** Half a metre and five degrees: free dragging gives 4.37 m and 22.6°. */
  private snapOn(): void {
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
   * The handle moved the OBJECT; write that back to the document.
   *
   * The object is the thing three is dragging, so it is the truth for this instant — and the
   * placement is the truth that gets saved. Converting back uses the same conventions `place()`
   * uses in the other direction: y is −z, and the compass bearing is the negative of the rotation.
   */
  private readGizmo(): void {
    const id = this.selected
    const o = id ? this.objects.get(id) : null
    const p = this.doc.items.find((x) => x.id === id)
    if (!o || !p) return
    p.x = Math.round(o.position.x * 10) / 10
    p.y = Math.round(-o.position.z * 10) / 10
    const offset = this.entry(p.asset)?.yaw_offset_deg ?? 0
    p.yaw_deg = Math.round((((-o.rotation.y * 180) / Math.PI - offset) % 360 + 360) % 360)
    // snapped to the ground as it moves, unless somebody asked for a height
    if (p.snap !== 'free') p.z = null
    o.position.set(p.x, this.zOf(p), -p.y)
    if (isGenerated(p)) p.locked = true
    this.dirty = true
    this.markSelected()
    this.onChange(false)
  }

  /**
   * Put one down at a point, without arming first.
   *
   * For a DRAG from the roster: arming is a mode ("pick an asset, then click the ground") and a
   * drag is not — the asset and the place arrive together, in one gesture, and toggling `armed`
   * to fake it would leave the editor in a mode nobody asked for if the drop failed.
   */
  async addAt(assetId: string, x: number, y: number): Promise<boolean> {
    if (!this.entry(assetId)) return false
    await this.add(assetId, x, y)
    return true
  }

  /** Arm this one specifically, rather than toggling it. */
  set arming(assetId: string | null) {
    this.armed = assetId
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
    // straight to the half of the panel that has its pose in it: you just put it down, and the
    // next thing anybody does is nudge it
    this.panelTab = 'placed'
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
  /** A single click SELECTS — or clears the selection. It never puts anything down. */
  /**
   * The placement nearest a ground point, within its own footprint — see `areas.pick`.
   *
   * By FOOTPRINT rather than by a fixed radius, because these range from a bollard to a barn and a
   * radius that finds the barn also finds everything within ten metres of the bollard.
   */
  pick(pt: { x: number; y: number }): { id: string; size: number } | null {
    let best: { id: string; size: number } | null = null
    for (const p of this.doc.items) {
      const e = this.entry(p.asset)
      const w = e ? Math.max(e.footprint_m[0], e.footprint_m[1]) : 3
      const reach = Math.max(1.5, w / 2)
      const d = Math.hypot(pt.x - p.x, pt.y - p.y)
      if (d > reach) continue
      const size = w * w
      if (!best || size < best.size) best = { id: p.id, size }
    }
    return best
  }

  get busy(): boolean {
    return !!this.armed || this.dragging
  }

  click(pt: { x: number; y: number } | null) {
    if (this.dragging) return
    /*
     * A CLICK ON A PLACEMENT SELECTS IT. This used to deselect whatever the point was, because
     * selection came only from clicking the OBJECT (the gizmo's own raycast) — so clicking the
     * ground beside a thing you had selected threw the selection away, and clicking the thing's
     * footprint did nothing at all. Rich, 2026-09-29: *"would love to be able to click anything
     * from the editor and have it highlighted in the place editor on the right."*
     */
    const hit = pt ? this.pick(pt) : null
    this.select(hit?.id ?? null)
  }

  /** A double click on the ground puts the armed asset there. */
  async placeAt(pt: { x: number; y: number }): Promise<void> {
    const what = this.armed ?? this.picked
    if (!what) return
    await this.add(what, pt.x, pt.y)
  }

  /** Press on an object to select and drag it in one gesture, the way every level editor does. */
  grab(ray: THREE.Raycaster): boolean {
    // a press that started on a handle belongs to the handle
    if (this.armed || this.dragging) return false
    const hit = ray.intersectObjects([...this.objects.values()], true)[0]
    if (hit?.object.userData.isGizmo) return false
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
      /*
       * Z AND X TURN A PLACEMENT, not Q and E.
       *
       * Rich, 2026-09-29, asking for a flying camera: *"at least wasd + qe to translate and rotate
       * the camera"* — and Q/E were taken by this. Z and X are the next pair everybody reaches for
       * on a rotate, they are beside each other under the same hand, and they free the flight keys
       * for the camera in every mode rather than only in the ones that do not rotate anything.
       */
      case 'z': case 'Z': spin(e.shiftKey ? -45 : -5); return true
      case 'x': case 'X': spin(e.shiftKey ? 45 : 5); return true
      case '[': zoom(1 / 1.1); return true
      case ']': zoom(1.1); return true
      case 'Delete': case 'Backspace': this.remove(this.selected); return true
      /*
       * ONE KEY, TOGGLING. It was G for move and R for rotate — and R is now the flying camera's
       * "drop", so the rotate handles were unreachable from the keyboard while the camera sank.
       * `place.key` never even saw it: flight is claimed first, deliberately, so that W/A/S/D mean
       * the same thing in every mode. G toggles between the two sets, which is one key to remember
       * instead of two and cannot collide with the camera.
       */
      case 'g': case 'G':
        this.setGizmoMode(this.gizmoMode === 'translate' ? 'rotate' : 'translate')
        return true
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
    // stamp the frame we authored in, so the next frame change is loud rather than silent
    if (this.site) this.doc.frame = frameOf(this.site.manifest)
    const bytes = await savePlacements(this.slug, this.doc)
    this.dirty = false
    this.onChange()
    return `saved ${this.doc.items.length} placements (${bytes} bytes) to ${this.slug}/placements.json`
  }

  // --- panel ---------------------------------------------------------------------------------------
  /** what the palette is showing a preview of */
  private picked: string | null = null
  private palFind = ''
  private palView: MeshView | null = null

  panel(root: HTMLElement, fly: (pts: [number, number][]) => void) {
    root.replaceChildren()

    /*
     * SAY WHEN A PLACEMENT'S MODEL IS NOT HERE.
     *
     * It is drawn as an orange wireframe box and is fully editable, but the box is not the asset and
     * nothing else on this screen would say so. The usual cause in development is the frozen
     * placeable catalog — `/assets/catalog.json` is a static file under `public/` unless the dev
     * server proxies it — so an asset ticked as placeable in the library is one the editor has
     * never heard of.
     */
    const missing = this.missingAssets()
    if (missing.length) {
      const warn = el('div', 'framewarn')
      warn.append(el('strong', '', `${missing.length} placement${missing.length === 1 ? '' : 's'} with no model in this catalog`))
      warn.append(el('span', '', missing.slice(0, 6).map((m) => m.asset).join(', ') + (missing.length > 6 ? '…' : '')))
      warn.append(el('span', 'dim', 'They are drawn as orange boxes and can still be moved, turned and deleted. Check that the asset service is reachable and that the catalog is not the frozen one under public/.'))
      root.append(warn)
    }

    /*
     * TWO TABS, because they are two activities.
     *
     * Rich, 2026-09-28: "the assset listing and palette should be two tabs, the form jumps all
     * around in its current iteration." It was one column — a preview, a search, forty chips,
     * then the placed list, then the detail of whatever was selected — so choosing an asset moved
     * the list, and selecting something in the world moved everything under it. Picking what to
     * place and adjusting what you have placed are separate jobs; each gets the panel.
     */
    // THE SAME TABS THE ASSET LIBRARY USES. Rich, 2026-09-28: "Tabs from assets should be used in
    // the place things editor tabs, not what ever this is." `tab-strip` / `tab` are what `Tabs`
    // in ui/shell.ts emits, so these are the same control by class rather than by resemblance.
    paneTabs(root, [{ id: 'assets', label: 'Assets' }, { id: 'placed', label: `Placed (${this.doc.items.length})` }], this.panelTab, (id) => {
      this.panelTab = id as 'assets' | 'placed'
      this.onChange()
    })
    // THE WARNING IS NOT THE FIRST THING. It was appended here, above the tab content, which put
    // it back on top of the preview the moment a world actually had a frame mismatch — so the
    // panel read exactly as it did before (Rich, 2026-09-28: "it should show a little preview at
    // the top instead of the awful placements.json warning") on every world where the warning was
    // true, which is the only case anybody sees it. Each tab now places it under its own heading.
    if (this.panelTab === 'assets') this.assetsTab(root)
    else this.placedTab(root, fly)
  }

  /** which half of the panel is showing */
  private panelTab: 'assets' | 'placed' = 'assets'

  private assetsTab(root: HTMLElement) {

    /*
     * THE PREVIEW GOES AT THE TOP, where the warning used to be.
     *
     * Rich, 2026-09-28: "if you click something it should show a little preview at the top
     * instead of the awful placements.json warning, and you should be able to click and drag
     * either the preview or from the palette directly to the world preview."
     *
     * The warning is still here — a document authored in another frame really does put things in
     * the wrong place — but it is one line under the thing you are actually doing, with the
     * explanation on it rather than in front of it.
     */
    const picked = this.picked ? this.entry(this.picked) : null
    if (picked) {
      const box = el('div', 'palette-preview')
      if (picked.glb) {
        this.palView ??= new MeshView({ remember: 'palette' })
        const view = this.palView
        ;(window as unknown as { __paletteview?: MeshView }).__paletteview = view
        if (view.root.dataset.asset !== picked.id) {
          view.root.dataset.asset = picked.id
          void view.load(`/${picked.glb.replace(/^\/+/, '')}`)
        }
        view.start()
        box.append(view.root)
      } else {
        box.append(el('p', 'dim', 'No model — it places as a box of the right size.'))
      }
      const cap = el('div', 'palette-caption')
      cap.append(
        el('span', 'nm', picked.name),
        el('span', 'mono', `${picked.footprint_m[0]}×${picked.footprint_m[1]} m · ${picked.height_m} m`),
      )
      // CLOSABLE, because a preview you cannot dismiss is a preview that has taken a third of the
      // panel for good (Rich, 2026-09-28: "the preview should be fixed and closable, then the
      // palette should scroll").
      const shut = el('button', 'palette-close')
      shut.textContent = '×'
      shut.title = 'close the preview'
      shut.onclick = (e) => {
        e.stopPropagation()
        this.picked = null
        this.palView?.stop()
        this.onChange()
      }
      cap.append(shut)
      box.append(cap)
      // the preview drags too, which is the nearest thing to hand once you are looking at it
      box.draggable = true
      box.ondragstart = (e) => {
        e.dataTransfer?.setData('text/apex-asset', picked.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
      }
      box.title = `${picked.id} — drag it onto the world, or click the ground`
      root.append(box)
    }
    // under the preview, not in front of it — still unmissable, since nothing else in this editor
    // gets a banner, but no longer standing between you and the thing you came here to do
    if (this.frameWarning) root.append(frameBanner('placements.json', this.frameWarning))

    root.append(el('h2', '', this.armed ? 'double-click the ground to place it' : 'drag one in, or pick it and double-click the ground'))

    const pal = el('div', 'palette')
    if (this.catalog.assets.length > 12) {
      const find = el('div', 'palette-find')
      const i = el('input') as HTMLInputElement
      i.type = 'search'
      i.placeholder = `find one of ${this.catalog.assets.length}`
      i.value = this.palFind
      // ONLY THE CHIPS ARE REDRAWN. Rebuilding the panel on every keystroke — which is what
      // `onChange` does — destroys this input as you type into it: the first letter lands, the
      // box is replaced, and the rest go nowhere.
      i.oninput = () => { this.palFind = i.value; fillPalette() }
      find.append(i)
      root.append(find)
    }

    const fillPalette = () => {
    pal.replaceChildren()
    const q = this.palFind.trim().toLowerCase()
    const shown = this.catalog.assets.filter((a) => !q || `${a.id} ${a.name} ${a.category}`.toLowerCase().includes(q))
    for (const a of shown) {
      const b = el('button', `chip${this.armed === a.id ? ' on' : ''}${this.picked === a.id ? ' picked' : ''}`)
      b.style.borderLeft = `4px solid #${new THREE.Color(tintOf(a.category)).getHexString()}`
      b.append(el('span', 'nm', a.name), el('span', 'mono', `${a.footprint_m[0]}×${a.footprint_m[1]} m${a.glb ? '' : ' · box'}`))
      // DRAG FROM THE PALETTE ITSELF. The canvas reads `text/apex-asset` on drop — the same
      // protocol the asset library used, so there is one way in rather than two.
      b.draggable = true
      b.ondragstart = (e) => {
        e.dataTransfer?.setData('text/apex-asset', a.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
        this.picked = a.id
      }
      b.title = `${a.id} — drag it onto the world, or click to arm it`
      b.onclick = () => {
        this.picked = a.id
        this.arm(a.id)
      }
      pal.append(b)
    }
    if (!shown.length) pal.append(el('p', 'dim', this.catalog.assets.length ? `Nothing matching “${this.palFind.trim()}”.` : 'No catalog. Expected public/assets/catalog.json.'))
    }
    fillPalette()
    root.append(pal)
  }

  private placedTab(root: HTMLElement, fly: (pts: [number, number][]) => void) {
    // here it IS the first thing: every row below it is a coordinate the warning says is displaced
    if (this.frameWarning) root.append(frameBanner('placements.json', this.frameWarning))
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
    /*
     * THE HANDLES, AND WHICH ONES.
     *
     * Dragging and Q/E have always worked and nothing on screen said so. Two buttons that say
     * which handles are showing is the whole fix — the numbers below stay, because a person
     * placing a row of posts wants to type 12 rather than nudge towards it.
     */
    const handles = el('div', 'row')
    for (const [mode, label] of [['translate', 'move'], ['rotate', 'turn']] as const) {
      const btn = el('button', this.gizmoModeNow === mode ? 'on' : '')
      btn.textContent = `${label} (G)`
      btn.onclick = () => this.setGizmoMode(mode)
      handles.append(btn)
    }
    handles.append(el('span', 'dim', 'drag the handles; hold shift for fine'))
    det.append(handles)
    det.append(this.num('x (m east)', p.x, 0.5, (v) => this.mutate((q) => (q.x = v))))
    det.append(this.num('y (m north)', p.y, 0.5, (v) => this.mutate((q) => (q.y = v))))
    det.append(this.num('yaw°  (Z/X, shift+wheel)', p.yaw_deg, 1, (v) => this.mutate((q) => (q.yaw_deg = v))))
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
