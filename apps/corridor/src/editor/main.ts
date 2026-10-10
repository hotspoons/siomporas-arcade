// corridor editor: correct what the data inferred, and put things beside the road.
//
// The viewer (index.html) is read-only by design — it shows the bake. This page is the other
// half: the same scene, from above, with two authoring modes over it. AREAS draw polygons that
// locally override what was measured; PLACE puts catalog objects on the ground. Both write JSON
// beside the bake through the dev server, and neither touches anything the bake produced.
//
// The scene itself is built by the viewer's own `buildSite`, read-only — the editor must be
// looking at exactly what the game looks at, or it is correcting something else.
import { fixturesExtension } from './library/fixtures'
import { buildingsExtension } from './library/buildingclasses'
import { createRenderer } from '@apex/engine/render/depth'
import { loadFixtures, saveFixtures } from '../game/world/fixtures'
import { DROP_TYPE } from './author/ui'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildSite, type Site } from '../world/scene'
import { RoadWidth } from './view/roadwidth'
import { TUNE_TABS } from '../tuning'
import { fetchJSON, type IndexEntry, type Manifest } from '../world/site'
import { AreaMode } from './author/areas'
import { PlaceMode } from './author/place'
import { StructureMode } from './author/structures'
import { GrowMode } from './author/grow'
import { Preview, markOverlay } from './view/preview'
import { CAN_SAVE, type Area } from './store/schema'
import { LOOK, type Season } from '../visuals/season'
import { EditorUI } from './chrome/editor'
import { AssetCatalog } from './library/assets'
import { confirm, el, installShellKeys, toast, status } from '../ui/shell'
import { select } from '../ui/controls'
import { assetsvc, type Material } from '../assets/assetsvc'
import { GROUND_CATEGORIES, ROAD_CATEGORIES, ROOF_CATEGORY_RE, WALL_CATEGORY_RE, saveSurfacesDoc } from '../assets/surfacesdoc'
import { restoreTheme } from '../ui/viewer'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

/*
 * WHOSE SHELL IS THIS?
 *
 * This file is loaded two ways now. On editor.html it is the page and builds its own bar, drawer
 * and inspector, exactly as before. Inside the world editor it is a MODE, and the host owns all
 * three — plus the world picker, which used to be duplicated here as a site picker (Rich,
 * 2026-09-27: "I thought the world editor was the place editor ... it isn't dumping you into new
 * tabs, very amateurish").
 *
 * The host says so by putting the three mount points in the document before importing this. No
 * flags, no globals: if they are there, this is a panel; if they are not, it is a page.
 */
const mounts = document.querySelector('#se-rail')
  ? {
      rail: $('#se-rail'),
      inspector: $('#se-inspector'),
      actions: $('#se-actions'),
    }
  : null

const canvas = $<HTMLCanvasElement>('#gl')
// the engine's renderer (@apex/engine/render/depth), on the logarithmic buffer the editor has always had
const { renderer } = createRenderer({ canvas, antialias: true, depthMode: 'log', label: null })
renderer.setPixelRatio(Math.min(2, devicePixelRatio))
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x8fa6c2)
// The scene needs its fog BEFORE the first buildSite, not when the preview opens. Grass and the
// tree impostors are custom shaders and they take their fog at COMPILE time from this object —
// handed `null` they are built with no fog term at all, and no amount of setting `scene.fog`
// later reaches them. This is a correctness fix rather than a visible one: at the season
// densities (1.8e-5 in summer) fog over the impostor range is under a thousandth. It matters if
// those densities ever rise. Colour and density are re-set per season; this only has to exist.
scene.fog = new THREE.FogExp2(0x8fa6c2, LOOK.summer.fog)
const camera = new THREE.PerspectiveCamera(55, 1, 1, 120_000)
const orbit = new OrbitControls(camera, canvas)
orbit.enableDamping = true
orbit.maxPolarAngle = Math.PI / 2 - 0.02
scene.add(new THREE.HemisphereLight(0xe9eef2, 0x7a6a50, 0.9))
const sun = new THREE.DirectionalLight(0xfff0d8, 1.7)
sun.position.set(-3000, 4000, 2500)
scene.add(sun)

let site: Site | null = null
const areas = new AreaMode((structural) => refresh(structural))
const place = new PlaceMode((structural) => refresh(structural))
const grow = new GrowMode(place, (structural) => refresh(structural))
// Grow renders inside Place's third tab; the mode owns it, the tab shows it
place.growTab = (root) => grow.panel(root, site, place.assets, flyTo)
// STRUCTURES: intervals on the spine — a bridge over the road, a grade to flatten, a detection to
// ignore. Its own file (structures.json) and its own pointer/key handling, so below it is always
// a `mode === 'structures'` branch ahead of the areas/place pair, never mixed into them.
const structs = new StructureMode((structural) => refresh(structural))
// Traffic zones: `zones` the document (src/zones.ts), `ZoneMode` the drawing of it.
const traffic = new ZoneMode((structural) => refresh(structural))
// Loops, corkscrews and jumps standing on the road (src/stunts.ts, src/editor/stuntmode.ts).
const stunts = new StuntMode((structural) => refresh(structural))
// Circuits and stages: the gates you cross (src/races.ts, src/editor/coursemode.ts).
const races = new CourseMode((structural) => refresh(structural))
// Where a world opens and a level starts, ends and passes through (src/points.ts). Rich: "replace
// races tab with something more generic" — the courses are its third tab.
const points = new PointMode((structural) => refresh(structural))
points.coursesTab = (root) => races.panel(root, (g) => flyTo([g.a, g.b]))
/** the Courses tab of Points is showing: pointer and keys go to the race gates */
const inCourses = () => mode === 'points' && points.panelTab === 'courses'
import type { Mode } from './chrome/editor'
import { actorExtension } from './library/actors'
import { weaponExtension } from './library/weapons'
import { vehicleExtension } from './library/vehicles'
import { trafficExtension } from './library/trafficsets'
import { soundsExtension } from './library/sounds'
import { ZoneMode } from './author/zones'
import { StuntMode } from './author/stuntmode'
import { CourseMode } from './author/coursemode'
import { PointMode } from './author/pointmode'
import { FlyCam } from './view/flycam'
import { Zones } from '../game/world/zones'
import { fixtureFootprint } from '../game/stunt/stunts'
// every mode's things in every mode, the active one bolder (Rich, 2026-10-10) — see view/emphasis.ts
import { applyEmphasis } from './view/emphasis'
import { Labels, type LabelItem } from './view/labels'
import { ClickCycle, rankHits, type PickHit } from './view/pickorder'
import { outlineMesh } from './view/drape'
import { DocWatch } from './store/docwatch'
// an old link's `:races` and `:grow` are the Points and Place tabs now
const hashMode = location.hash.split(':')[1]
let mode: Mode = (hashMode === 'races' ? 'points' : hashMode === 'grow' ? 'place' : (hashMode as Mode)) || 'areas'

// The interface. Every callback here is a function declared later in this file, which is fine —
// they are declarations, so they are hoisted, and none of them runs before the first event.
restoreTheme()
const assets = new AssetCatalog({
  extensions: [
    vehicleExtension(), actorExtension(), weaponExtension(), trafficExtension(), soundsExtension(),
    fixturesExtension({
      slug: () => site?.manifest.slug ?? null,
      current: () => (site ? loadFixtures(site.manifest.slug) : Promise.resolve({ version: 1 as const, choices: {} })),
      save: async (doc) => { if (!site) throw new Error('no site open'); await saveFixtures(site.manifest.slug, doc) },
    }),
    // building classes' pools (buildingclasses.ts); a save hands the scene the new surfaces.json so
    // the World tab, which writes the same file, starts from it
    buildingsExtension({ world: () => site?.manifest.slug ?? null, onWorldSaved: (doc) => site?.setSurfaces(doc) }),
  ],
})
// A probe needs to open the library without hunting for the toolbar button; this is the one hook.
;(window as unknown as { __apexEditorAssets: () => void }).__apexEditorAssets = () => void assets.open()
const ui = new EditorUI({
  onAssets: () => void assets.open(),
  onSite: (slug) => void loadSite(slug),
  onMode: (m) => setMode(m),
  onLayers: () => applyLayers(),
  onSave: () => void doSave(),
  onPreview: () => void openPreview(),
}, mounts)
if (!mounts) installShellKeys(() => ui.drawer)
let season: Season = 'summer'
// Every group an editing mode puts in the scene is marked, so the preview can stand all of them
// down without knowing which modes exist. A new mode marks its group and needs no other change.
scene.add(markOverlay(areas.group), markOverlay(place.group))
// the move/rotate handles, now that there is a camera and a canvas to hang them on
place.useGizmo(camera, canvas, (on) => { orbit.enabled = on })
// stunt fixtures get the same handles: Rich, 2026-09-29 — "make sure the pieces can be moved and
// rotated with a gizmo"
stunts.useGizmo(camera, canvas, (on) => { orbit.enabled = on })
scene.add(markOverlay(structs.group))
scene.add(markOverlay(traffic.group))
// NOT a mark overlay: a fixture is real road, so it is lit and occluded like the rest of the world
scene.add(stunts.group)
scene.add(markOverlay(races.group))
scene.add(markOverlay(points.group))
// road cross-section preview: its own floating panel and its own overlay group, so it survives the
// panel rebuilds in refresh() and touches nothing else here (road-and-car agent)
const roadWidth = new RoadWidth(scene)
const preview = new Preview(scene, canvas, document.body, () => {
  // back to the editor's own camera and overlays
  orbit.enabled = true
  applyLayers()
  refresh()
})

function resize() {
  // The CANVAS's box, not the window's. As a page those are the same thing; as a panel inside the
  // world editor they are not, and sizing to the window puts the horizon behind the inspector.
  const w = Math.max(1, canvas.clientWidth || innerWidth)
  const h = Math.max(1, canvas.clientHeight || innerHeight)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

// ---------------------------------------------------------------------------------------------
// loading
async function loadIndex() {
  const idx = await fetchJSON<{ sites: IndexEntry[] }>('/sites/index.json')
  const want = location.hash.slice(1).split(':')[0] || idx.sites[0]?.slug
  if (!want) throw new Error('no sites baked')
  ui.setSites(idx.sites, want)
  await loadSite(want)
}

/**
 * `quality: 'preview'` passes the renderer to `buildSite`, which bakes the far-tree impostor
 * atlas. That is what the game draws, but it costs real time at load — so the editor opens
 * without it and only the preview pays, once, the first time it is asked for.
 */
let siteHasImpostors = false

/** the load in flight: a later call supersedes an earlier one, and the earlier one's result is dropped */
let loadGen = 0

function dropSite(s: Site) {
  scene.remove(s.group)
  s.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose()
  })
}

/** Returns the slug on screen afterwards: the one asked for, or the old one if the load was refused. */
async function loadSite(slug: string, quality: 'edit' | 'preview' = 'edit'): Promise<string | null> {
  if (unsaved() && !(await confirm({
    title: 'Unsaved edits',
    message: 'This site has edits that have not been saved. Load another one anyway?',
    ok: 'Discard and load',
    danger: true,
  }))) {
    ui.setSite(site?.manifest.slug ?? slug)
    return site?.manifest.slug ?? null
  }
  /*
   * ONE LOAD AT A TIME, AND THE LAST ONE ASKED FOR WINS. `buildSite` takes seconds; while it ran,
   * `site` was null, so a second switch saw nothing to remove and started a second build, and
   * every finished build added its group to the scene — the old world's tiles stayed under the
   * new one (Rich, 2026-09-30: "switching worlds in the place editor doesn't clear out tiles for
   * the old world"). A generation counter: a build that finishes after a newer one was asked for
   * is dropped, not shown.
   */
  const gen = ++loadGen
  location.hash = `${slug}:${mode}`
  ui.setSite(slug)
  if (site) {
    dropSite(site)
    site = null
  }
  status(`loading ${slug}…`)
  const manifest = await fetchJSON<Manifest>(`/sites/${slug}/web/manifest.json`)
  const built = await buildSite(manifest, status, false, quality === 'preview' ? renderer : undefined, scene.fog as THREE.FogExp2, season, undefined, { plantWhole: true })
  if (gen !== loadGen) {
    dropSite(built)
    return null
  }
  site = built
  siteHasImpostors = quality === 'preview'
  sitePredatesEdits = false
  scene.add(site.group)
  // NOT site.heightAt. `groundAt` is the graded corridor strip near the road and the DEM beyond —
  // the surface the game actually drives on. Beside the pavement the two differ by metres, so
  // draping an area or standing a diner on the raw DEM would author against a surface nobody sees.
  const ground = (x: number, y: number) => site!.groundAt(x, -y) ?? site!.heightAt(x, y)
  groundH = ground
  watch.clear()
  cycle.reset()
  await Promise.all([areas.load(slug, ground, site), place.load(slug, site, ground)])
  await structs.load(slug, site, place.catalog) // after place: it shares the catalog place loaded
  await traffic.load(slug, ground, site)
  await stunts.load(slug, ground, site)
  await races.load(slug, ground, site)
  await points.load(slug, ground, site)
  roadWidth.setSite(site)
  grow.adopt()
  ;(window as unknown as { corridor: unknown }).corridor = {
    site, scene, camera, areas, place, grow, preview, orbitTarget: orbit.target,
    /*
     * FOR PROBES: which tool has the pointer, and where a screen pixel lands on the ground.
     *
     * Both were invisible from outside, and both are the questions you actually have when a click
     * does not do what you expected — "did it go to the tool I think is active" and "did the ray
     * find the ground at all". Without them the only observable is that nothing happened, which is
     * true of half a dozen different causes.
     */
    mode: () => mode,
    setMode: (m: Mode) => setMode(m),
    /**
     * A click on the ground, exactly as the canvas delivers one.
     *
     * For probes: the routing — which tool keeps a click and which one takes it — is the part worth
     * asserting, and it cannot be reached by synthesising a pointer event at a screen pixel without
     * also testing the camera.
     */
    click: (pt: { x: number; y: number } | null) => routeClick(pt),
    orbit,
    groundAtPixel: (clientX: number, clientY: number) =>
      groundAt({ clientX, clientY } as PointerEvent),
  } // probes
  ;(window as unknown as { corridor: { structs: unknown } }).corridor.structs = structs
  /*
   * The traffic mode and the `Zones` class it writes for, so a probe can author a zone and then ask
   * the lookup whether it actually covers the road. "The file was written" is not the question —
   * a polygon drawn beside the road saves perfectly and does nothing.
   */
  ;(window as unknown as { corridor: { traffic: unknown; zonesModule: unknown } }).corridor.traffic = traffic
  ;(window as unknown as { corridor: { zonesModule: unknown } }).corridor.zonesModule = { Zones }
  ;(window as unknown as { corridor: { stunts: unknown } }).corridor.stunts = stunts
  ;(window as unknown as { corridor: { races: unknown } }).corridor.races = races
  ;(window as unknown as { corridor: { points: unknown } }).corridor.points = points
  ;(window as unknown as { corridor: { layers: unknown } }).corridor.layers = {
    /** what a click at a ground point would choose, in order — the active mode's first */
    hitsAt: (pt: { x: number; y: number }) => rankHits(hitsAt(pt), mode),
    /** the names drawn on the map right now */
    labels: () => labels.texts(),
    /** what the hover ring is on */
    hovered: () => hovered,
    /** look at the documents on disk now, rather than at the next tick */
    poll: () => pollDocs(),
  }
  applyLayers()
  toTop()
  refresh()
  status('')
  void watch.prime(docPaths())
  return slug
}

// ---------------------------------------------------------------------------------------------
// view
function applyLayers() {
  if (!site) return
  const state = ui.layers()
  const on = (n: string) => state[n] ?? false
  site.setImagery(on('imagery'))
  if (site.layers.trees) { site.layers.trees.userData.layerOn = on('trees'); site.layers.trees.visible = on('trees') }
  site.layers.structures.visible = on('structures')
  site.layers.spine.visible = on('spine')
  if (site.layers.horizon) site.layers.horizon.visible = on('horizon')
  areas.group.visible = on('areas')
  place.group.visible = on('placements')
  structs.group.visible = on('authored')
  /*
   * EVERY MODE'S THINGS, IN EVERY MODE. Rich, 2026-10-10: "traffic zones will show up when you are
   * in the structures tab … we need all the items visible from this editor all the time." These
   * three were shown only in their own mode — the zones because, painted over every road, they hid
   * the ground in the others. That is answered by weight now, not by absence: the passive modes are
   * drawn at under half strength with no handles (view/emphasis.ts, applied in `refresh`).
   */
  traffic.group.visible = true
  stunts.group.visible = true
  races.group.visible = true
  points.group.visible = true
}

/** Straight down, high enough that the whole baked corridor is in frame — both extents, not just
 *  the long one: some sites are wider than they are long. */
function toTop() {
  if (!site) return
  const [x0, y0, x1, y1] = site.manifest.bbox
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const vfov = (camera.fov * Math.PI) / 180
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
  const h = Math.max(600, 1.08 * Math.max((y1 - y0) / 2 / Math.tan(vfov / 2), (x1 - x0) / 2 / Math.tan(hfov / 2)))
  const z = site.groundAt(cx, -cy) ?? site.heightAt(cx, cy)
  orbit.target.set(cx, z, -cy)
  camera.position.set(cx, z + h, -cy + 1)
  orbit.update()
}

/** Frame a polygon or a point from above, close enough to nudge its vertices. */
function flyTo(pts: [number, number][]) {
  if (!site || !pts.length) return
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const span = Math.max(60, Math.hypot(x1 - x0, y1 - y0))
  const t = new THREE.Vector3(cx, site.groundAt(cx, -cy) ?? site.heightAt(cx, cy), -cy)
  orbit.target.copy(t)
  camera.position.copy(t).add(new THREE.Vector3(0, span * 1.1, span * 0.35))
  orbit.update()
}

// ---------------------------------------------------------------------------------------------
// pointer: one raycast against the ground gives every mode its site-frame point
const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
let down: { x: number; y: number } | null = null
let grabbing = false

/*
 * THE CANVAS, NOT THE WINDOW.
 *
 * Rich, 2026-09-29: "The draw area tool in the place editor for defining special areas for the map
 * drops the points no where near where it was clicked."
 *
 * This read `innerWidth`/`innerHeight` and raw `clientX`/`clientY`, which is only right when the
 * canvas IS the viewport. On `editor.html` it is — `#gl` is `position: fixed; inset: 0` — so this
 * was correct for as long as the site editor was its own page. Inside the world editor it is one
 * pane of two: below the top bar and left of the inspector (`body.worldedit #gl` in world.css). So
 * every ray was off by the bar's height and scaled by the inspector's width, and the error grows
 * across the screen — a click near the left edge lands close, one near the inspector lands far
 * away. Nothing errors; the point simply appears somewhere else.
 *
 * It is not only the area tool. Every pick in this editor goes through here: dropping a prop,
 * grabbing a vertex handle, the structures picker. The handles are 2.2 m spheres, so a ray that
 * misses by tens of metres never hits one — which is why area pins could not be dragged either.
 */
function castRay(e: PointerEvent | WheelEvent) {
  const r = canvas.getBoundingClientRect()
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  ray.setFromCamera(ndc, camera)
  return ray
}

/** Where on the ground is the cursor, in the site frame? null when it is off the terrain. */
function groundAt(e: PointerEvent): { x: number; y: number } | null {
  if (!site) return null
  const targets: THREE.Object3D[] = [site.terrain, site.layers.road]
  const hit = castRay(e).intersectObjects(targets, true)[0]
  return hit ? { x: hit.point.x, y: -hit.point.z } : null
}

/*
 * A DROP FROM THE ROSTER.
 *
 * `dragover` must preventDefault or the browser refuses the drop — that is the whole protocol, and
 * forgetting it is a drag that visibly works and silently ends in nothing. The asset id travels as
 * a string on the dataTransfer rather than through a shared object, so a panel rebuilt mid-gesture
 * cannot break the drag.
 */
canvas.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('text/apex-asset') && !e.dataTransfer?.types.includes(DROP_TYPE)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  canvas.classList.add('drop-target')
})
canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-target'))
canvas.addEventListener('drop', (e) => {
  canvas.classList.remove('drop-target')
  const thing = e.dataTransfer?.getData(DROP_TYPE)
  if (thing) {
    e.preventDefault()
    try {
      const { mode: m, id } = JSON.parse(thing) as { mode: Mode; id: string }
      if (!dropThing(m, id, e.clientX, e.clientY)) status('drop it on the ground — on the road, for a gate, a structure or a traffic level')
    } catch (err) {
      status(`drop: ${(err as Error).message}`)
    }
    return
  }
  const id = e.dataTransfer?.getData('text/apex-asset')
  if (!id) return
  e.preventDefault()
  void dropAsset(id, e.clientX, e.clientY).then((ok) => {
    if (!ok) status('drop it on the ground')
  })
})

/**
 * Something from any mode's palette, let go on the world.
 *
 * Rich, 2026-09-30: *"we can drag out of the 'place' palette but no other palette."* One listener,
 * one protocol (`DROP_TYPE`, a mode and an id), and the mode does what its own click would have
 * done there — a piece lands on the road, a gate is laid square across it, a traffic level paints
 * a strip of it. The editor switches to that mode, so what you dropped is what you are looking at.
 */
function dropThing(m: Mode, id: string, clientX: number, clientY: number): boolean {
  if (!site) return false
  const pt = groundAt({ clientX, clientY } as PointerEvent)
  if (!pt) return false
  if (m !== mode) setMode(m)
  let ok = false
  if (m === 'stunts') ok = stunts.dropAt(pt, id)
  else if (m === 'points') ok = inCourses() ? races.dropAt(pt, id) : points.dropAt(pt, id) || races.dropAt(pt, id)
  else if (m === 'traffic') ok = traffic.dropAt(pt, id)
  else if (m === 'areas') ok = areas.dropAt(pt, id)
  else if (m === 'structures') ok = structs.dropAt(pt, id)
  else if (m === 'place') { void dropAsset(id, clientX, clientY); return true }
  refresh()
  return ok
}

canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY }
  const r = castRay(e)
  if (mode === 'structures') {
    grabbing = structs.grab(r)
    orbit.enabled = !grabbing
    return
  }
  if (mode === 'traffic') {
    grabbing = traffic.grab(r)
    orbit.enabled = !grabbing
    return
  }
  if (mode === 'stunts') {
    grabbing = stunts.grab(r)
    // a press on a gizmo handle belongs to the gizmo, not to the camera — see the note in place.ts
    orbit.enabled = !grabbing && !stunts.onGizmo
    return
  }
  if (mode === 'points') {
    grabbing = inCourses() ? races.grab(r) : points.grab(r)
    orbit.enabled = !grabbing
    return
  }
  grabbing = mode === 'areas' ? areas.grab(r) : place.grab(r) // grow edits the same objects place does
  // A PRESS ON A GIZMO HANDLE BELONGS TO THE GIZMO. `place.onGizmo` is set by a capture-phase
  // listener that runs before this one; without the check, this line hands the camera straight back
  // and OrbitControls takes the drag that was meant to move the object.
  orbit.enabled = !grabbing && !place.onGizmo
})
/**
 * A click is a press and release that did not MOVE. How long you held it is not the question.
 *
 * This used to also require the whole gesture inside 400 ms, to tell a click from the end of an
 * orbit drag — but distance already tells those apart, and the clock quietly rejected deliberate
 * clicks: lining up a polygon vertex and pressing carefully takes longer than that, and so does
 * any click at all on a loaded machine. The point silently did not go down, which reads as the
 * draw tool being broken rather than as the click being too slow. (Measured while chasing exactly
 * that: a press-and-release with zero movement, rejected at 751 ms.)
 *
 * The case the clock protected against — press, orbit away, orbit back to the same pixel, release
 * — needs the camera to return within five pixels of where it started, and while you are drawing
 * the camera cannot rotate at all.
 */
const isClick = (e: PointerEvent) => !!down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5
canvas.addEventListener('pointermove', (e) => {
  if (mode === 'structures') {
    // while an interval is being picked the panel shows where on the spine the click would land
    if (structs.picking && !grabbing) structs.hoverAt(groundAt(e))
    if (grabbing) structs.dragTo(groundAt(e))
    return
  }
  if (!grabbing) return
  const pt = groundAt(e)
  if (mode === 'areas') areas.dragTo(pt)
  else if (mode === 'traffic') traffic.dragTo(pt)
  else if (mode === 'stunts') stunts.dragTo(pt)
  else if (mode === 'points') (inCourses() ? races : points).dragTo(pt)
  else place.dragTo(pt)
})
addEventListener('pointerup', (e) => {
  // `enabled` is the grab lock; `enableRotate`/`enablePan` are the draw lock, and this must not
  // undo the second while releasing the first
  orbit.enabled = true
  if (mode === 'structures') {
    if (grabbing) {
      grabbing = false
      structs.drop()
    } else if (isClick(e as PointerEvent)) routeClick(groundAt(e as PointerEvent)) // a click from here can land on any mode's thing too
    down = null
    return
  }
  if (grabbing) {
    grabbing = false
    if (mode === 'areas') areas.drop()
    else if (mode === 'traffic') traffic.drop()
    else if (mode === 'stunts') stunts.drop()
    else if (mode === 'points') (inCourses() ? races : points).drop()
    else place.drop()
    down = null
    return
  }
  // a click is a click, not the end of an orbit drag — `isClick`, not a second copy of its rule
  if (isClick(e as PointerEvent)) {
    const pt = groundAt(e as PointerEvent)
    routeClick(pt)
  }
  down = null
})
/*
 * A DOUBLE CLICK PLACES, a single one selects.
 *
 * Rich, 2026-09-28: "Should be double click to place new instance, not single." With an asset
 * armed, every click on the ground dropped another copy — including the click you make to look at
 * something, or to deselect. Two clicks is the deliberate gesture, and it matches the drag, which
 * is also something you cannot do by accident.
 */
canvas.addEventListener('dblclick', (e) => {
  if (mode !== 'place') return
  const pt = groundAt(e as unknown as PointerEvent)
  if (pt) void place.placeAt(pt)
})

canvas.addEventListener('wheel', (e) => {
  // shift+wheel rotates the selected placement; everything else is the orbit's zoom
  if (mode === 'place' && e.shiftKey && place.wheel(e)) e.preventDefault()
}, { passive: false })

addEventListener('keydown', (e) => {
  // Not our keys when we are not the mode being looked at: the world editor's map is using them.
  if (!active) return
  if (preview.open) return // the preview owns the keyboard while it is up
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void doSave()
    return
  }
  /*
   * FLIGHT FIRST, and before every mode's own keys.
   *
   * W/A/S/D/Q/E belong to the camera in every mode now — which is why rotating a placement, a
   * bridge and a stunt fixture all moved to Z and X. Ctrl+S is handled above so the flight keys
   * cannot eat a save.
   */
  if (fly.down(e)) {
    e.preventDefault()
    return
  }
  if (mode === 'structures') {
    if (structs.key(e)) {
      e.preventDefault()
      refresh()
      return
    }
    if (e.key.toLowerCase() === 'n') return structs.startPick()
    if (e.key.toLowerCase() === 'c') return structs.flyToSelected(flyTo) // C centres; F is the camera's drop
  } else if (mode === 'points' ? (inCourses() ? races.key(e) : points.key(e)) : mode === 'stunts' ? stunts.key(e) : mode === 'traffic' ? traffic.key(e) : mode === 'areas' ? areas.key(e) : place.key(e)) {
    e.preventDefault()
    refresh()
    return
  }
  if (mode === 'place' && place.panelTabNow === 'grow' && grow.key(e, site, place.assets)) {
    e.preventDefault()
    return
  }
  switch (e.key.toLowerCase()) {
    case 'n':
      if (mode === 'areas') areas.startDraw() // startDraw calls onChange, which is refresh
      else if (mode === 'traffic') traffic.startDraw()
      break
    case 't': toTop(); break
    case 'v': void openPreview(); break
    // C CENTRES ON THE SELECTION. It was F, and F is now "drop" on the flown camera — a key that
    // both flies you down and jumps you somewhere else is a key that does neither reliably.
    case 'c': {
      const a = areas.doc.areas.find((x) => x.id === areas.selected)
      const z = traffic.doc.zones.find((x) => x.id === traffic.selected)
      if (mode === 'areas' && a) flyTo(a.polygon)
      else if (mode === 'traffic' && z) flyTo(z.polygon)
      else if (mode === 'place') place.flyToSelected(flyTo)
      break
    }
    case '1': setMode('areas'); break
    case '2': setMode('place'); break
    case '3': setMode('structures'); break
    case '4': setMode('traffic'); break
    case '5': setMode('stunts'); break
    case '6': setMode('points'); break
    case '7': setMode('world'); break
  }
})

// ---------------------------------------------------------------------------------------------
// modes, panel, saving
function setMode(m: Mode) {
  mode = m
  // the proposed pavement edges are drawn only while the World tab is up
  roadWidth.setShown(m === 'world')
  if (site) location.hash = `${site.manifest.slug}:${m}`
  ui.setMode(m)
  // The traffic overlay is shown only in its own mode, and `applyLayers` runs at load — so without
  // this the zones were painted into the scene and never became visible until the next site load.
  applyLayers()
  refresh()
}
/**
 * The World tab: what is true of the whole world — its textures (surfacesdoc.ts) and the road's
 * cross-section. Rich, 2026-09-30: "apply default textures per world for things like roads by
 * material, grass, buildings (have a pool to pick from randomly)… per world we can pick the
 * textures from the place editor."
 */
let materialsCache: Material[] | null = null
function worldPanel(root: HTMLElement) {
  root.replaceChildren()
  if (!site) { root.append(el('p', 'dim', 'no world loaded')); return }
  const slug = site.manifest.slug
  const doc = structuredClone(site.surfaces())
  root.append(el('h2', '', 'textures'))
  const body = el('div', 'world-surfaces')
  root.append(body)
  const draw = (mats: Material[]) => {
    body.replaceChildren()
    const byCat = (test: (c: string) => boolean) => mats.filter((m) => test(m.category ?? '')).map((m) => ({ value: m.id, label: m.name || m.id }))
    const roadOpts = byCat((c) => ROAD_CATEGORIES.includes(c))
    const groundOpts = byCat((c) => GROUND_CATEGORIES.includes(c))
    const walls = mats.filter((m) => WALL_CATEGORY_RE.test(m.category ?? ''))
    const roofs = mats.filter((m) => ROOF_CATEGORY_RE.test(m.category ?? ''))
    if (!mats.length) body.append(el('p', 'dim', 'no materials in the library — the asset service is not reachable, or holds none'))
    // every road class the bake measured here, plus the one branches always take
    const classes = [...new Set([...(site!.manifest.surface?.class ?? []), 'asphalt_aged'])].sort()
    const roads = el('div', 'world-group')
    roads.append(el('h3', '', 'road, by class'))
    for (const cls of classes) {
      roads.append(select({
        label: cls.replace(/_/g, ' '),
        value: doc.road?.[cls] ?? '',
        options: [{ value: '', label: `default (${cls})` }, ...roadOpts],
        onChange: (v) => { doc.road ??= {}; if (v) doc.road[cls] = v; else delete doc.road[cls] },
      }))
    }
    body.append(roads)
    const grass = el('div', 'world-group')
    grass.append(el('h3', '', 'ground'))
    for (const [k, label] of [['mown', 'mown verge'], ['rough', 'rough grass']] as const) {
      grass.append(select({
        label,
        value: doc.ground?.[k] ?? '',
        options: [{ value: '', label: `default (grass_${k})` }, ...groundOpts],
        onChange: (v) => { doc.ground ??= {}; if (v) doc.ground[k] = v; else delete doc.ground[k] },
      }))
    }
    body.append(grass)
    const pools = el('div', 'world-group')
    pools.append(el('h3', '', 'buildings'), el('p', 'dim', 'one pool for EVERY building in this world; each draws one wall and one roof from it by the seed. Nothing ticked leaves each building class its own pool — Assets → Buildings.'))
    const chipsFor = (list: Material[], key: 'walls' | 'roofs') => {
      const wrap = el('div', 'palette')
      for (const m of list) {
        const on = (doc.buildings?.[key] ?? []).includes(m.id)
        const b = el('button', `chip${on ? ' on' : ''}`)
        b.append(el('span', 'nm', m.name || m.id), el('span', 'mono', `${m.category} · ${m.metres_per_tile} m`))
        b.onclick = () => {
          doc.buildings ??= {}
          const cur = new Set(doc.buildings[key] ?? [])
          if (cur.has(m.id)) cur.delete(m.id)
          else cur.add(m.id)
          doc.buildings[key] = [...cur]
          b.classList.toggle('on', cur.has(m.id))
        }
        wrap.append(b)
      }
      return wrap
    }
    pools.append(el('h4', '', `walls (${walls.length})`), chipsFor(walls, 'walls'), el('h4', '', `roofs (${roofs.length})`), chipsFor(roofs, 'roofs'))
    const seed = el('input', 'input') as HTMLInputElement
    seed.type = 'number'
    seed.step = '1'
    seed.value = String(doc.buildings?.seed ?? 1)
    seed.onchange = () => { doc.buildings ??= {}; doc.buildings.seed = Number(seed.value) || 1 }
    const seedRow = el('label', 'field text')
    seedRow.append(el('span', 'field-label', 'seed'), seed)
    pools.append(seedRow)
    body.append(pools)
    const acts = el('div', 'row')
    const save = el('button', 'primary', 'save textures') as HTMLButtonElement
    save.onclick = async () => {
      try {
        await saveSurfacesDoc(slug, doc)
        site?.setSurfaces(doc)
        status(`saved ${slug}/surfaces.json — the road is redrawn; buildings take the pools on the next load`)
        toast('textures saved', 'ok')
      } catch (e) {
        toast(`textures: ${(e as Error).message}`, 'danger', 8000)
      }
    }
    acts.append(save)
    body.append(acts)
  }
  if (materialsCache) draw(materialsCache)
  else {
    body.append(el('p', 'dim', 'reading the library…'))
    assetsvc.materials().then((r) => { materialsCache = r.materials; if (mode === 'world') draw(materialsCache) }).catch(() => draw([]))
  }
  root.append(el('h2', '', 'road cross-section'))
  roadWidth.panelInto(root)
}
// the same handle the viewer exposes as window.corridor, so probes can drive the editor too
;(window as unknown as { __ed: unknown }).__ed = { scene, camera, orbit, tune: TUNE_TABS, get site() { return site } }

/*
 * W/A/S/D across, Q/E down and up — Rich, 2026-09-29. It moves the orbit rather than replacing it,
 * so a drag afterwards continues from where you flew to; see the note in `flycam.ts`.
 */
const fly = new FlyCam({
  camera,
  target: orbit.target,
  // not while the preview owns the keyboard, not while a text field has it, and not while this
  // editor is the hidden half of the world editor
  active: () => active && !preview.open && !typingInAField(),
  onMove: () => { /* the orbit reads camera.position and target directly */ },
})
addEventListener('keyup', (e) => fly.up_(e))
// A window that loses focus mid-flight never sees the keyup, and the camera flies away for ever.
addEventListener('blur', () => fly.release())

function typingInAField(): boolean {
  const t = document.activeElement as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')
}

const unsaved = () => areas.dirty || place.dirty || structs.dirty || traffic.dirty || stunts.dirty || races.dirty || points.dirty

// The loaded site was built from the files as they were on disk at load time. Anything saved
// since means the scene in front of you is behind the JSON — which matters only for the preview,
// since that is the one view claiming to be the game.
let sitePredatesEdits = false

async function saveBoth(): Promise<string> {
  const out: string[] = []
  if (areas.dirty) out.push(await areas.save())
  if (place.dirty) out.push(await place.save())
  if (structs.dirty) out.push(await structs.save())
  if (traffic.dirty) out.push(await traffic.save())
  if (stunts.dirty) out.push(await stunts.save())
  if (races.dirty) out.push(await races.save())
  if (points.dirty) out.push(await points.save())
  if (out.length) sitePredatesEdits = true
  // our own writes are not "changed on disk"
  if (out.length) await watch.prime(docPaths())
  return out.join(' · ')
}

/**
 * `buildSite` reads both JSON files off the server and bakes the canopy corrections into the
 * height model as it decodes it, so there is no way to show edited canopy without a rebuild.
 * Save, reload, then hand the preview the very same site the editor is holding.
 */
/**
 * A click on the ground: to the tool that owns it, or to whatever was actually under the pointer.
 *
 * Rich, 2026-09-29: *"clicking stunts from the areas tab would focus the stunt and activate the
 * stunts tab… would love to be able to click anything from the editor and have it highlighted in
 * the place editor on the right."* And 2026-10-10: *"The active tab's items should … be first on
 * selection when clicking."*
 *
 * A TOOL IN THE MIDDLE OF SOMETHING owns every click until it is finished — drawing a polygon,
 * holding an armed piece, picking an interval's ends, waiting for you to pick the road an end joins
 * to. Otherwise every mode is asked what it has under the pointer and the order is
 * view/pickorder.ts's: the active mode's thing first, then the smallest of the rest, and a second
 * click on the same spot walks to the next one there — which is how a loop standing inside a canopy
 * area is still reachable from the Areas tab, the case the old smallest-wins rule existed for.
 * Choosing another mode's thing switches to that mode with it selected and its row in view.
 */
function routeClick(pt: { x: number; y: number } | null) {
  if (!pt || modeBusy()) return give(mode, pt)
  const h = cycle.choose(pt, rankHits(hitsAt(pt), mode))
  // nothing of any mode here: the active tool's own click, which clears its selection
  if (!h) return give(mode, pt)
  selectHit(h)
}

/** The active tool's own handling of a click — drawing, placing, clearing. */
function give(m: Mode, pt: { x: number; y: number } | null) {
  if (m === 'areas') areas.click(pt)
  else if (m === 'traffic') traffic.click(pt)
  else if (m === 'stunts') stunts.click(pt)
  else if (m === 'structures') structs.click(pt)
  else if (m === 'points') (inCourses() ? races : points).click(pt)
  else if (m === 'place') place.click(pt)
}

/** Is the active tool in the middle of something, so the click is its own? */
function modeBusy(): boolean {
  return mode === 'areas' ? areas.busy
    : mode === 'traffic' ? traffic.busy
      : mode === 'stunts' ? stunts.busy
        : mode === 'structures' ? structs.busy
          : mode === 'points' ? (inCourses() ? false : points.busy)
            : mode === 'place' ? place.busy
              : false
}

/** Everything of every mode under a ground point — one candidate per mode, its smallest. A layer
 *  switched off in Settings is not on the map, so it is not under the pointer either. */
function hitsAt(pt: { x: number; y: number }): PickHit[] {
  const out: PickHit[] = []
  const add = (m: PickHit['mode'], g: THREE.Object3D, h: { id: string; size: number } | null) => {
    if (h && g.visible) out.push({ mode: m, id: h.id, size: h.size })
  }
  add('points', points.group, points.pick(pt))
  add('points', races.group, races.pick(pt))
  add('stunts', stunts.group, stunts.pick(pt))
  add('place', place.group, place.pick(pt))
  add('structures', structs.group, structs.pick(pt))
  add('traffic', traffic.group, traffic.pick(pt))
  add('areas', areas.group, areas.pick(pt))
  return out
}

/** Select a thing in its own mode, switching to that mode first. */
function selectHit(h: PickHit) {
  if (h.mode !== mode) setMode(h.mode)
  if (h.mode === 'stunts') stunts.select(h.id)
  else if (h.mode === 'traffic') traffic.select(h.id)
  else if (h.mode === 'areas') areas.select(h.id)
  else if (h.mode === 'structures') structs.select(h.id)
  else if (h.mode === 'points') {
    // a point, or a race gate through the Courses tab
    if (points.doc.points.some((p) => p.id === h.id)) { points.panelTab = 'points'; points.select(h.id) }
    else { points.panelTab = 'courses'; races.select(h.id) }
  } else place.select(h.id)
  // the panel that just opened shows the thing: its placed tab, the row highlighted and in view
  refresh()
  status(`${h.mode}: ${h.id}`)
}

// ---------------------------------------------------------------------------------------------
// every mode's layer, in every mode

const cycle = new ClickCycle()
const labels = new Labels()
scene.add(labels.group)
/** the surface every overlay drapes on, kept from the last load for the hover ring and the labels */
let groundH: (x: number, y: number) => number = () => 0

/**
 * The active mode at full strength, the others quieter; the active mode's names on the map.
 *
 * Run at the end of every `refresh`, and every mode's change goes through `refresh` (it is each
 * mode's `onChange`), so a passive mode that rebuilt its meshes — a reload off disk, a drop that
 * switched modes — is quietened on the same pass. Cheap: tens to hundreds of overlay objects.
 */
function emphasiseLayers() {
  const e = (m: Mode) => (mode === m ? 'active' : 'passive')
  applyEmphasis(areas.group, e('areas'))
  applyEmphasis(place.group, e('place'))
  applyEmphasis(structs.group, e('structures'))
  applyEmphasis(traffic.group, e('traffic'))
  applyEmphasis(stunts.group, e('stunts'))
  applyEmphasis(points.group, e('points'))
  applyEmphasis(races.group, e('points'))
  place.setPassive(mode !== 'place')
  stunts.setPassive(mode !== 'stunts')
  const src = mode === 'areas' ? areas.labels()
    : mode === 'traffic' ? traffic.labels()
      : mode === 'structures' ? structs.labels()
        : mode === 'stunts' ? stunts.labels()
          : mode === 'points' ? [...points.labels(), ...races.labels()]
            : []
  labels.set(src.map((l): LabelItem => ({ key: `${mode}:${l.id}`, text: l.text, at: l.at })), groundH)
  // the hover ring was drawn from the thing as it was: a selection, a mode switch or a reload may
  // have moved it, or put something else first under the pointer — look again
  if (hovered) { setHover(null); hoverTimer ??= setTimeout(hoverNow, 0) }
}

/*
 * HOVER: what a click here would take, outlined before you click. Across modes too — a zone under
 * the pointer in the Structures tab lights up, which is the only way to know a click will jump
 * there. Coalesced to one ground raycast per 60 ms; it is a raycast into the terrain.
 */
let hovered: string | null = null
let hoverLine: THREE.Object3D | null = null
let hoverEvent: { clientX: number; clientY: number } | null = null
let hoverTimer: ReturnType<typeof setTimeout> | null = null
function setHover(h: PickHit | null) {
  const k = h ? `${h.mode}:${h.id}` : null
  if (k === hovered) return
  hovered = k
  if (hoverLine) {
    scene.remove(hoverLine)
    ;(hoverLine as THREE.Mesh).geometry?.dispose()
    hoverLine = null
  }
  canvas.style.cursor = h ? 'pointer' : ''
  if (!h) return
  const ring = h.mode === 'areas' ? areas.outline(h.id)
    : h.mode === 'traffic' ? traffic.outline(h.id)
      : h.mode === 'stunts' ? stunts.outline(h.id)
        : h.mode === 'structures' ? structs.outline(h.id)
          : h.mode === 'place' ? place.outline(h.id)
            : points.outline(h.id) ?? races.outline(h.id)
  if (!ring || ring.length < 2) return
  const line = outlineMesh(ring, groundH, 0xffffff, 0.9, 3.5)
  line.renderOrder = 13
  hoverLine = markOverlay(line)
  scene.add(hoverLine)
}
function hoverNow() {
  hoverTimer = null
  const e = hoverEvent
  if (!e || !site || grabbing || modeBusy()) return setHover(null)
  const pt = groundAt(e as PointerEvent)
  setHover(pt ? rankHits(hitsAt(pt), mode)[0] ?? null : null)
}
canvas.addEventListener('pointermove', (e) => {
  // a drag (orbit, a handle) is not a hover
  if (e.buttons) return
  hoverEvent = { clientX: e.clientX, clientY: e.clientY }
  hoverTimer ??= setTimeout(hoverNow, 60)
})
canvas.addEventListener('pointerleave', () => { hoverEvent = null; setHover(null) })

/*
 * DOCUMENTS CHANGED ON DISK — an agent's traffic_zone_add, point_add or course_save while this is
 * open. See store/docwatch.ts. Every eight seconds while the editor is the thing on screen.
 */
const watch = new DocWatch(new URLSearchParams(location.search).get('data') ?? '')
const docPaths = () => docs().map((d) => d.path)
function docs(): { path: string; file: string; mode: { dirty: boolean }; reload: () => Promise<unknown>; reselect: () => void }[] {
  const s = site
  if (!s) return []
  const slug = s.manifest.slug
  const keep = <T,>(get: () => T, put: (v: T) => void) => { const v = get(); return () => put(v) }
  const at = (f: string) => `/sites/${slug}/${f}`
  return [
    { path: at('adjustments.json'), file: 'adjustments.json', mode: areas, reload: () => areas.load(slug, groundH, s), reselect: keep(() => areas.selected, (v) => { if (v && areas.doc.areas.some((a) => a.id === v)) areas.select(v) }) },
    { path: at('placements.json'), file: 'placements.json', mode: place, reload: () => place.load(slug, s, groundH), reselect: keep(() => place.selected, (v) => { if (v && place.doc.items.some((p) => p.id === v)) place.select(v) }) },
    { path: at('structures.json'), file: 'structures.json', mode: structs, reload: () => structs.load(slug, s, place.catalog), reselect: keep(() => structs.selected, (v) => { if (v && structs.doc.items.some((i) => i.id === v)) structs.select(v) }) },
    { path: at('zones.json'), file: 'zones.json', mode: traffic, reload: () => traffic.load(slug, groundH, s), reselect: keep(() => traffic.selected, (v) => { if (v && traffic.doc.zones.some((z) => z.id === v)) traffic.select(v) }) },
    { path: at('stunts.json'), file: 'stunts.json', mode: stunts, reload: () => stunts.load(slug, groundH, s), reselect: keep(() => stunts.selected, (v) => { if (v && stunts.doc.fixtures.some((f) => f.id === v)) stunts.select(v) }) },
    { path: at('courses.json'), file: 'courses.json', mode: races, reload: () => races.load(slug, groundH, s), reselect: () => {} },
    { path: at('points.json'), file: 'points.json', mode: points, reload: () => points.load(slug, groundH, s), reselect: keep(() => points.selected, (v) => { if (v && points.doc.points.some((p) => p.id === v)) points.select(v) }) },
  ]
}
/** ONE LOOK AT A TIME: a look asked for while another is in flight waits for it and then looks
 *  again, rather than returning nothing — a probe's (or a test's) "look now" must mean now. */
let polling: Promise<string[]> = Promise.resolve([])
function pollDocs(): Promise<string[]> {
  polling = polling.catch(() => []).then(() => pollOnce())
  return polling
}
let pollBusy = false
async function pollOnce(): Promise<string[]> {
  if (!site) return []
  pollBusy = true
  try {
    const list = docs()
    const changed = new Set(await watch.changed(list.map((d) => d.path)))
    const reloaded: string[] = []
    for (const d of list) {
      if (!changed.has(d.path)) continue
      // unsaved edits win; saying so is the whole of what can be done without losing somebody's work
      if (d.mode.dirty) { toast(`${d.file} changed on disk — you have unsaved edits to it, and saving will write over that change`, 'warn', 8000); continue }
      const reselect = d.reselect
      await d.reload()
      reselect()
      reloaded.push(d.file)
    }
    if (reloaded.length) {
      refresh()
      status(`reloaded ${reloaded.join(', ')} — changed on disk`)
    }
    return reloaded
  } finally {
    pollBusy = false
  }
}
setInterval(() => {
  if (!pollBusy && active && !preview.open && document.visibilityState === 'visible') void pollDocs()
}, 8000)

async function openPreview() {
  if (!site) return
  try {
    if (unsaved()) status(await saveBoth())
    // Rebuild when the scene is behind the files, or when it was built without impostors — a
    // preview whose far trees are lollipops while the game's are camera-facing cards is a preview
    // of something else.
    if (sitePredatesEdits || !siteHasImpostors) {
      status(sitePredatesEdits ? 'rebuilding the site with your edits…' : 'baking the far trees for the preview…')
      await loadSite(site.manifest.slug, 'preview')
    }
  } catch (err) {
    status(`preview: ${(err as Error).message}`)
    return
  }
  if (!site) return
  orbit.enabled = false
  /*
   * A WORLD WITH STUNTS GETS A PHYSICS PREVIEW. The fixtures come from the TOOL rather than from
   * the file, so a loop you have just dropped is solid the first time you look at it — the save
   * above has already written it, but the tool is the thing that knows what is on screen.
   */
  const withPhysics = await preview.usePhysics(site, stunts.doc.fixtures)
  preview.show(site, season)
  status(withPhysics ?? '')
}

/**
 * `structural` false means only a VALUE changed — a slider, a name, a tag list. Rebuilding the
 * panel then would tear the control out from under the pointer mid-drag, so those repaint the
 * save button and nothing else. Everything that changes the SHAPE of the panel (selection,
 * adding, deleting, mode) rebuilds it.
 */
/*
 * WHILE YOU ARE DROPPING PINS, THE WORLD HOLDS STILL.
 *
 * Rich, 2026-09-29: "Also clicking moves the world around - we should disable world move and limit
 * to zoom in/out only when dropping pins."
 *
 * Orbit takes a drag as a rotation and a click is a drag of a few pixels, so drawing a polygon
 * spun the camera between vertices: the fourth point went down on a view that was not the one you
 * chose the first three on. `isClick` upstream stops the rotation being COMMITTED as a click, but
 * the camera has already moved by then and the damage is to your aim, not to the document.
 *
 * ZOOM STAYS. It is the one camera control you want mid-draw — a polygon is usually drawn around
 * something you need to get closer to — and it is on the wheel, so it cannot be confused with
 * placing a point.
 */
function holdTheCamera(still: boolean) {
  orbit.enableRotate = !still
  orbit.enablePan = !still
  orbit.enableZoom = true
}

function refresh(structural = true) {
  season = preview.season
  // the draw state changes from the panel, the keyboard and the canvas, so it is read here rather
  // than mirrored at each of those
  holdTheCamera((mode === 'areas' && areas.drawing) || (mode === 'traffic' && traffic.drawing))
  if (structural) {
    if (mode === 'areas') areas.panel(ui.inspector, (a: Area) => flyTo(a.polygon))
    else if (mode === 'world') worldPanel(ui.inspector)
    else if (mode === 'structures') structs.panel(ui.inspector, flyTo)
    else if (mode === 'traffic') traffic.panel(ui.inspector, (z) => flyTo(z.polygon))
    else if (mode === 'stunts') stunts.panel(ui.inspector, (f) => flyTo(fixtureFootprint(f)))
    else if (mode === 'points') points.panel(ui.inspector, (p) => flyTo([p.at, [p.at[0] + 1, p.at[1] + 1]]))
    else place.panel(ui.inspector, flyTo)
    /*
     * AND THE SELECTED ROW IS BROUGHT INTO VIEW. A panel that lists forty placements and selects
     * the one you clicked somewhere below the fold has, from where you are sitting, done nothing.
     * `nearest` rather than `center` so a row already on screen does not jump.
     */
    ui.inspector.querySelector('.item.sel, .row.sel, .sel')?.scrollIntoView({ block: 'nearest' })
  }
  const what = mode === 'areas' ? 'areas' : mode === 'structures' ? 'structures' : mode === 'traffic' ? 'traffic' : mode === 'stunts' ? 'stunts' : mode === 'points' ? (inCourses() ? 'races' : 'points') : 'place'
  ui.setDirty(CAN_SAVE && unsaved(), `Save ${what}`)
  emphasiseLayers()
}

/**
 * Save this mode's file, and REBUILD IF THE SAVE CHANGED THE WORLD.
 *
 * Rich, 2026-09-29: *"Clicking save areas should redraw everything, I have to reload the page to
 * see the change applied with zeroing out the trees."*
 *
 * He is right and the reason is worth stating, because it decides which saves rebuild. An
 * adjustment area is consumed at BUILD time: the trees are picked out of canopy cells during the
 * "planting" phase and thinned there by `tree_density`, the ground is graded with
 * `ground_offset_m`, the surface classes are baked into the road's material buckets. Nothing
 * re-reads those per frame, so saving the file changed the file and nothing else — and the only
 * way to see it was a reload, which is a reload somebody has to know to do.
 *
 * Placements, traffic zones and stunt fixtures are different: they are drawn from live objects that
 * the editor already updates as you drag them, so rebuilding for those would be a minute of
 * rebuilding to show what is already on screen.
 */
async function doSave() {
  const rebuilds = mode === 'areas' || mode === 'structures'
  let rebuild = false
  try {
    if (rebuilds) {
      /*
       * SAVE EVERYTHING DIRTY, not only this mode's file.
       *
       * The rebuild goes through `loadSite`, which asks "discard your unsaved edits?" if anything
       * is still dirty — so saving only the areas and then rebuilding would meet somebody who also
       * had placements in flight with a dialog threatening to throw them away, in response to
       * pressing Save. Everything here is an authored file; writing them all is never destructive.
       */
      status(await saveBoth())
      rebuild = true
    } else {
      status(mode === 'traffic' ? await traffic.save()
        : mode === 'stunts' ? await stunts.save()
        : mode === 'points' ? (inCourses() ? await races.save() : await points.save())
        : await place.save())
    }
    sitePredatesEdits = true
    await watch.prime(docPaths())
  } catch (err) {
    toast(`save failed: ${(err as Error).message}`, 'danger')
    refresh()
    return
  }
  if (rebuild && site) {
    // SAY SO. A rebuild is seconds on a corridor and over a minute on a network site, and an
    // editor that goes quiet for a minute after a save looks like an editor that has crashed.
    status('saved — rebuilding the world with your edits…')
    try {
      await loadSite(site.manifest.slug)
      status('saved and rebuilt')
    } catch (err) {
      toast(`saved, but the rebuild failed: ${(err as Error).message}`, 'danger')
    }
  }
  refresh()
}
addEventListener('beforeunload', (e) => {
  if (unsaved()) e.preventDefault()
})

setMode(mode)
/*
 * ACTIVE ONLY WHEN IT IS THE MODE YOU ARE IN.
 *
 * Embedded, this shares a document with the world editor, so two things have to stop when it is
 * hidden: the render loop, which would otherwise draw a whole 3D scene behind a 2D map forever,
 * and the key handler, which would otherwise answer to keys the map is using.
 */
let active = !mounts
export function setActive(on: boolean) {
  active = on
  if (on) {
    resize()
    orbit.enabled = true
  }
}
/** Point the editor at a world. Called by the host when the picker changes. */
export async function openSite(slug: string): Promise<string | null> {
  if (site?.manifest.slug === slug) return slug
  return loadSite(slug)
}
/** Which site it is looking at, so the host can tell whether it has to load one. */
export const currentSite = () => site?.manifest.slug ?? null

/**
 * Drop an asset from the roster onto the ground under the cursor.
 *
 * Rich, 2026-09-28: "We should be able to drag from the roster, place it on the map, set the pose,
 * that's it." The roster lives in the host's inspector and knows nothing about cameras, so it
 * hands over the asset and the screen point and this does the raycast — the same one every click
 * in this editor goes through, so a drop lands exactly where a click would have.
 *
 * False means the cursor was not over the terrain, which the caller reports rather than placing
 * something at an arbitrary point the person did not choose.
 */
export async function dropAsset(assetId: string, clientX: number, clientY: number): Promise<boolean> {
  if (!site) return false
  const pt = groundAt({ clientX, clientY } as PointerEvent)
  if (!pt) return false
  const ok = await place.addAt(assetId, pt.x, pt.y)
  if (ok) refresh()
  return ok
}

/** Arm an asset so the next click on the ground places it — the keyboard-and-click route. */
export function armAsset(assetId: string | null) {
  place.arming = assetId
  refresh()
}

/** What can be placed, for a roster that lives outside this module. */
export const placeCatalog = () => place.catalog.assets

// For probes: what is actually in the placements document. A drop that "worked" has to be
// visible as an item in the document, not as an event that fired.
;(window as unknown as { __apexPlace: unknown }).__apexPlace = {
  count: () => place.doc.items.length,
  last: () => place.doc.items[place.doc.items.length - 1] ?? null,
  armed: () => place.arming,
}

const clock = new THREE.Clock()
function frame() {
  const dt = Math.min(0.1, clock.getDelta())
  // Hidden: keep the loop alive but draw nothing. Stopping it entirely would mean re-entering the
  // mode had to restart it, and a loop that can be started twice eventually is.
  if (!active) {
    clock.getDelta()
    requestAnimationFrame(frame)
    return
  }
  if (preview.open) {
    preview.tick(dt, clock.elapsedTime)
    preview.render(renderer)
  } else {
    // FLY BEFORE THE ORBIT UPDATES: the fly moves the camera and its target together, and the
    // orbit's own `update` is what re-derives the transform from them and applies its damping.
    fly.tick(dt)
    orbit.update()
    renderer.render(scene, camera)
  }
  requestAnimationFrame(frame)
}
// EMBEDDED, THE HOST SAYS WHICH WORLD. On its own page the editor opens the hash's site or the
// first one; inside the world editor that first site loaded UNDER whatever the host asked for,
// and the two builds raced (see `loadSite`). The host calls `openSite`; here only the list.
if (mounts) {
  fetchJSON<{ sites: IndexEntry[] }>('/sites/index.json').then((idx) => ui.setSites(idx.sites, idx.sites[0]?.slug ?? '')).catch(() => {})
  frame()
} else loadIndex().then(frame).catch((e) => status(`failed: ${e.message}`))
