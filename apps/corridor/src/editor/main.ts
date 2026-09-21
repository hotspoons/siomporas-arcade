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
import { fetchJSON, type IndexEntry, type Manifest } from '../site'
import { AreaMode } from './areas'
import { PlaceMode } from './place'
import { CAN_SAVE, type Area } from './schema'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const status = (s: string) => ($('#status').textContent = s)

const canvas = $<HTMLCanvasElement>('#gl')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true })
renderer.setPixelRatio(Math.min(2, devicePixelRatio))
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x8fa6c2)
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
let mode: 'areas' | 'place' = (location.hash.split(':')[1] as 'areas' | 'place') || 'areas'
scene.add(areas.group, place.group)

function resize() {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

// ---------------------------------------------------------------------------------------------
// loading
async function loadIndex() {
  const idx = await fetchJSON<{ sites: IndexEntry[] }>('/sites/index.json')
  const sel = $<HTMLSelectElement>('#site')
  sel.replaceChildren()
  for (const s of idx.sites) {
    const o = document.createElement('option')
    o.value = s.slug
    o.textContent = `${s.slug} — ${(s.length_m / 1000).toFixed(1)} km`
    sel.append(o)
  }
  const want = location.hash.slice(1).split(':')[0] || idx.sites[0]?.slug
  if (!want) throw new Error('no sites baked')
  sel.value = want
  sel.onchange = () => loadSite(sel.value)
  await loadSite(want)
}

async function loadSite(slug: string) {
  if (unsaved() && !confirm('There are unsaved edits. Load another site anyway?')) {
    $<HTMLSelectElement>('#site').value = site?.manifest.slug ?? slug
    return
  }
  location.hash = `${slug}:${mode}`
  if (site) {
    scene.remove(site.group)
    site.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
    })
    site = null
  }
  status(`loading ${slug}…`)
  const manifest = await fetchJSON<Manifest>(`/sites/${slug}/web/manifest.json`)
  // No renderer argument on purpose: impostor baking costs half a minute and the editor hides the
  // trees by default. The terrain, the road and the ground height — the things a polygon lands on — are
  // identical either way.
  site = await buildSite(manifest, status, false)
  scene.add(site.group)
  // NOT site.heightAt. `groundAt` is the graded corridor strip near the road and the DEM beyond —
  // the surface the game actually drives on. Beside the pavement the two differ by metres, so
  // draping an area or standing a diner on the raw DEM would author against a surface nobody sees.
  const ground = (x: number, y: number) => site!.groundAt(x, -y) ?? site!.heightAt(x, y)
  await Promise.all([areas.load(slug, ground), place.load(slug, site, ground)])
  ;(window as unknown as { corridor: unknown }).corridor = { site, scene, camera, areas, place, orbitTarget: orbit.target } // probes
  applyLayers()
  toTop()
  refresh()
  status('')
}

// ---------------------------------------------------------------------------------------------
// view
function applyLayers() {
  if (!site) return
  const on = (n: string) => $<HTMLInputElement>(`input[data-layer="${n}"]`).checked
  site.setImagery(on('imagery'))
  if (site.layers.trees) site.layers.trees.visible = on('trees')
  site.layers.structures.visible = on('structures')
  site.layers.spine.visible = on('spine')
  if (site.layers.horizon) site.layers.horizon.visible = on('horizon')
  areas.group.visible = on('areas')
  place.group.visible = on('placements')
}
for (const c of document.querySelectorAll<HTMLInputElement>('input[data-layer]')) c.onchange = applyLayers

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

canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() }
  const r = castRay(e)
  grabbing = mode === 'areas' ? areas.grab(r) : place.grab(r)
  orbit.enabled = !grabbing
})
canvas.addEventListener('pointermove', (e) => {
  if (!grabbing) return
  const pt = groundAt(e)
  if (mode === 'areas') areas.dragTo(pt)
  else place.dragTo(pt)
})
addEventListener('pointerup', (e) => {
  orbit.enabled = true
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
canvas.addEventListener('wheel', (e) => {
  // shift+wheel rotates the selected placement; everything else is the orbit's zoom
  if (mode === 'place' && e.shiftKey && place.wheel(e)) e.preventDefault()
}, { passive: false })

addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void doSave()
    return
  }
  if ((mode === 'areas' ? areas.key(e) : place.key(e))) {
    e.preventDefault()
    refresh()
    return
  }
  switch (e.key.toLowerCase()) {
    case 'n': if (mode === 'areas') areas.startDraw(); break
    case 't': toTop(); break
    case 'f': {
      const a = areas.doc.areas.find((x) => x.id === areas.selected)
      if (mode === 'areas' && a) flyTo(a.polygon)
      else if (mode === 'place') place.flyToSelected(flyTo)
      break
    }
    case '1': setMode('areas'); break
    case '2': setMode('place'); break
  }
})

// ---------------------------------------------------------------------------------------------
// modes, panel, saving
function setMode(m: 'areas' | 'place') {
  mode = m
  if (site) location.hash = `${site.manifest.slug}:${m}`
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.classList.toggle('on', b.dataset.mode === m)
  refresh()
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.onclick = () => setMode(b.dataset.mode as 'areas' | 'place')

const unsaved = () => areas.dirty || place.dirty

/**
 * `structural` false means only a VALUE changed — a slider, a name, a tag list. Rebuilding the
 * panel then would tear the control out from under the pointer mid-drag, so those repaint the
 * save button and nothing else. Everything that changes the SHAPE of the panel (selection,
 * adding, deleting, mode) rebuilds it.
 */
function refresh(structural = true) {
  if (structural) {
    if (mode === 'areas') areas.panel($('#body'), (a: Area) => flyTo(a.polygon))
    else place.panel($('#body'), flyTo)
  }
  const save = $<HTMLButtonElement>('#save')
  save.disabled = !CAN_SAVE || !unsaved()
  save.textContent = unsaved() ? `save ${mode} •` : `save ${mode}`
  $('#dirty').textContent = unsaved() ? 'unsaved edits' : ''
}

async function doSave() {
  try {
    status(mode === 'areas' ? await areas.save() : await place.save())
  } catch (err) {
    status(`save failed: ${(err as Error).message}`)
  }
  refresh()
}
$('#save').onclick = () => void doSave()
addEventListener('beforeunload', (e) => {
  if (unsaved()) e.preventDefault()
})

setMode(mode)
function frame() {
  orbit.update()
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
loadIndex().then(frame).catch((e) => status(`failed: ${e.message}`))
