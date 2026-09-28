// corridor editor: correct what the data inferred, and put things beside the road.
//
// The viewer (index.html) is read-only by design — it shows the bake. This page is the other
// half: the same scene, from above, with two authoring modes over it. AREAS draw polygons that
// locally override what was measured; PLACE puts catalog objects on the ground. Both write JSON
// beside the bake through the dev server, and neither touches anything the bake produced.
//
// The scene itself is built by the viewer's own `buildSite`, read-only — the editor must be
// looking at exactly what the game looks at, or it is correcting something else.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildSite, type Site } from '../scene'
import { RoadWidth } from './roadwidth'
import { TUNE_TABS } from '../tuning'
import { fetchJSON, type IndexEntry, type Manifest } from '../site'
import { AreaMode } from './areas'
import { PlaceMode } from './place'
import { StructureMode } from './structures'
import { GrowMode } from './grow'
import { Preview, markOverlay } from './preview'
import { CAN_SAVE, type Area } from './schema'
import { LOOK, type Season } from '../season'
import { EditorUI } from '../ui/editor'
import { AssetCatalog } from '../ui/assets'
import { confirm, installShellKeys, toast, status } from '../ui/shell'
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true })
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
// STRUCTURES: intervals on the spine — a bridge over the road, a grade to flatten, a detection to
// ignore. Its own file (structures.json) and its own pointer/key handling, so below it is always
// a `mode === 'structures'` branch ahead of the areas/place pair, never mixed into them.
const structs = new StructureMode((structural) => refresh(structural))
import type { Mode } from '../ui/editor'
let mode: Mode = (location.hash.split(':')[1] as Mode) || 'areas'

// The interface. Every callback here is a function declared later in this file, which is fine —
// they are declarations, so they are hoisted, and none of them runs before the first event.
restoreTheme()
const assets = new AssetCatalog()
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
scene.add(markOverlay(structs.group))
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

async function loadSite(slug: string, quality: 'edit' | 'preview' = 'edit') {
  if (unsaved() && !(await confirm({
    title: 'Unsaved edits',
    message: 'This site has edits that have not been saved. Load another one anyway?',
    ok: 'Discard and load',
    danger: true,
  }))) {
    ui.setSite(site?.manifest.slug ?? slug)
    return
  }
  location.hash = `${slug}:${mode}`
  ui.setSite(slug)
  if (site) {
    scene.remove(site.group)
    site.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
    })
    site = null
  }
  status(`loading ${slug}…`)
  const manifest = await fetchJSON<Manifest>(`/sites/${slug}/web/manifest.json`)
  site = await buildSite(manifest, status, false, quality === 'preview' ? renderer : undefined, scene.fog as THREE.FogExp2, season)
  siteHasImpostors = quality === 'preview'
  sitePredatesEdits = false
  scene.add(site.group)
  // NOT site.heightAt. `groundAt` is the graded corridor strip near the road and the DEM beyond —
  // the surface the game actually drives on. Beside the pavement the two differ by metres, so
  // draping an area or standing a diner on the raw DEM would author against a surface nobody sees.
  const ground = (x: number, y: number) => site!.groundAt(x, -y) ?? site!.heightAt(x, y)
  await Promise.all([areas.load(slug, ground, site), place.load(slug, site, ground)])
  await structs.load(slug, site, place.catalog) // after place: it shares the catalog place loaded
  roadWidth.setSite(site)
  grow.adopt()
  ;(window as unknown as { corridor: unknown }).corridor = { site, scene, camera, areas, place, grow, preview, orbitTarget: orbit.target } // probes
  ;(window as unknown as { corridor: { structs: unknown } }).corridor.structs = structs
  applyLayers()
  toTop()
  refresh()
  status('')
}

// ---------------------------------------------------------------------------------------------
// view
function applyLayers() {
  if (!site) return
  const state = ui.layers()
  const on = (n: string) => state[n] ?? false
  site.setImagery(on('imagery'))
  if (site.layers.trees) site.layers.trees.visible = on('trees')
  site.layers.structures.visible = on('structures')
  site.layers.spine.visible = on('spine')
  if (site.layers.horizon) site.layers.horizon.visible = on('horizon')
  areas.group.visible = on('areas')
  place.group.visible = on('placements')
  structs.group.visible = on('authored')
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
let down: { x: number; y: number; t: number } | null = null
let grabbing = false

function castRay(e: PointerEvent | WheelEvent) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
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
  if (!e.dataTransfer?.types.includes('text/apex-asset')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  canvas.classList.add('drop-target')
})
canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-target'))
canvas.addEventListener('drop', (e) => {
  canvas.classList.remove('drop-target')
  const id = e.dataTransfer?.getData('text/apex-asset')
  if (!id) return
  e.preventDefault()
  void dropAsset(id, e.clientX, e.clientY).then((ok) => {
    if (!ok) status('drop it on the ground')
  })
})

canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() }
  const r = castRay(e)
  if (mode === 'structures') {
    grabbing = structs.grab(r)
    orbit.enabled = !grabbing
    return
  }
  grabbing = mode === 'areas' ? areas.grab(r) : place.grab(r) // grow edits the same objects place does
  orbit.enabled = !grabbing
})
/** a press-and-release within 400 ms and 5 px is a click, not the end of an orbit drag */
const isClick = (e: PointerEvent) => !!down && performance.now() - down.t < 400 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5
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
  else place.dragTo(pt)
})
addEventListener('pointerup', (e) => {
  orbit.enabled = true
  if (mode === 'structures') {
    if (grabbing) {
      grabbing = false
      structs.drop()
    } else if (isClick(e as PointerEvent)) structs.click(groundAt(e as PointerEvent))
    down = null
    return
  }
  if (grabbing) {
    grabbing = false
    if (mode === 'areas') areas.drop()
    else place.drop()
    down = null
    return
  }
  // a click is a click, not the end of an orbit drag
  if (down && performance.now() - down.t < 400 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
    const pt = groundAt(e as PointerEvent)
    if (mode === 'areas') areas.click(pt)
    else place.click(pt)
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
  if (mode === 'structures') {
    if (structs.key(e)) {
      e.preventDefault()
      refresh()
      return
    }
    if (e.key.toLowerCase() === 'n') return structs.startPick()
    if (e.key.toLowerCase() === 'f') return structs.flyToSelected(flyTo)
  } else if ((mode === 'areas' ? areas.key(e) : place.key(e))) {
    e.preventDefault()
    refresh()
    return
  }
  if (mode === 'grow' && grow.key(e, site, place.assets)) {
    e.preventDefault()
    return
  }
  switch (e.key.toLowerCase()) {
    case 'n': if (mode === 'areas') areas.startDraw(); break
    case 't': toTop(); break
    case 'v': void openPreview(); break
    case 'f': {
      const a = areas.doc.areas.find((x) => x.id === areas.selected)
      if (mode === 'areas' && a) flyTo(a.polygon)
      else if (mode === 'place') place.flyToSelected(flyTo)
      break
    }
    case '1': setMode('areas'); break
    case '2': setMode('place'); break
    case '3': setMode('grow'); break
    case '4': setMode('structures'); break
  }
})

// ---------------------------------------------------------------------------------------------
// modes, panel, saving
function setMode(m: Mode) {
  mode = m
  if (site) location.hash = `${site.manifest.slug}:${m}`
  ui.setMode(m)
  refresh()
}
// the road panel is not a mode — it overlays whatever mode you are in, so it gets its own button
roadWidth.mount(ui.modeHost)
// the same handle the viewer exposes as window.corridor, so probes can drive the editor too
;(window as unknown as { __ed: unknown }).__ed = { scene, camera, orbit, tune: TUNE_TABS, get site() { return site } }

const unsaved = () => areas.dirty || place.dirty || structs.dirty

// The loaded site was built from the files as they were on disk at load time. Anything saved
// since means the scene in front of you is behind the JSON — which matters only for the preview,
// since that is the one view claiming to be the game.
let sitePredatesEdits = false

async function saveBoth(): Promise<string> {
  const out: string[] = []
  if (areas.dirty) out.push(await areas.save())
  if (place.dirty) out.push(await place.save())
  if (structs.dirty) out.push(await structs.save())
  if (out.length) sitePredatesEdits = true
  return out.join(' · ')
}

/**
 * `buildSite` reads both JSON files off the server and bakes the canopy corrections into the
 * height model as it decodes it, so there is no way to show edited canopy without a rebuild.
 * Save, reload, then hand the preview the very same site the editor is holding.
 */
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
  preview.show(site, season)
  status('')
}

/**
 * `structural` false means only a VALUE changed — a slider, a name, a tag list. Rebuilding the
 * panel then would tear the control out from under the pointer mid-drag, so those repaint the
 * save button and nothing else. Everything that changes the SHAPE of the panel (selection,
 * adding, deleting, mode) rebuilds it.
 */
function refresh(structural = true) {
  season = preview.season
  if (structural) {
    if (mode === 'areas') areas.panel(ui.inspector, (a: Area) => flyTo(a.polygon))
    else if (mode === 'grow') grow.panel(ui.inspector, site, place.assets, flyTo)
    else if (mode === 'structures') structs.panel(ui.inspector, flyTo)
    else place.panel(ui.inspector, flyTo)
  }
  const what = mode === 'areas' ? 'areas' : mode === 'structures' ? 'structures' : 'place'
  ui.setDirty(CAN_SAVE && unsaved(), `Save ${what}`)
}

async function doSave() {
  try {
    status(mode === 'areas' ? await areas.save() : mode === 'structures' ? await structs.save() : await place.save())
    sitePredatesEdits = true
  } catch (err) {
    toast(`save failed: ${(err as Error).message}`, 'danger')
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
export async function openSite(slug: string) {
  if (site?.manifest.slug === slug) return
  await loadSite(slug)
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
    orbit.update()
    renderer.render(scene, camera)
  }
  requestAnimationFrame(frame)
}
loadIndex().then(frame).catch((e) => status(`failed: ${e.message}`))
