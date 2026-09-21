// corridor viewer: look at what tools/corridor baked, from above and from the driver's seat.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildSite, describe, type Site } from './scene'
import { Car, type CarInput } from './car'
import { FlyControls, sitOnRoad } from './fly'
import { MiniMap } from './minimap'
import { TunePanel } from '@apex/engine/app/TunePanel'
import * as T from './tuning'
import { TUNE_TABS } from './tuning'
import { fetchJSON, type IndexEntry, type Manifest, type Structure, type Crossing } from './site'
import { LOOK, SEASONS, type Season } from './season'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const status = (s: string) => ($('#status').textContent = s)

const canvas = $<HTMLCanvasElement>('#gl')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true })
renderer.setPixelRatio(Math.min(2, devicePixelRatio))
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xbfd2ea)
scene.fog = new THREE.FogExp2(0xbfd2ea, 0.000018)
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 120_000)
const orbit = new OrbitControls(camera, canvas)
orbit.enableDamping = true
orbit.maxPolarAngle = Math.PI / 2 - 0.02

scene.add(new THREE.HemisphereLight(0xe9eef2, 0x7a6a50, 0.75))
const sun = new THREE.DirectionalLight(0xfff0d8, 2.0)
sun.position.set(-3000, 4000, 2500)
scene.add(sun)

let site: Site | null = null
let minimap: MiniMap | null = null
const panel = $('#panel')
let dragging = false, lastX = 0, lastY = 0, downAt = 0
// drive mode: a real car (stuntin dynamics) on the corridor strip, chase camera behind it
const drive = { on: false, cockpit: false, yaw: 0, pitch: 0, car: null as Car | null, input: { throttle: 0, brake: 0, steer: 0, handbrake: false } as CarInput, steerKey: 0 }
let fly: FlyControls | null = null

function resize() {
  const w = innerWidth, h = innerHeight
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
  const sel = $<HTMLSelectElement>('#site')
  sel.innerHTML = ''
  for (const s of idx.sites) {
    const o = document.createElement('option')
    o.value = s.slug
    const ident = s.ident ? Object.values(s.ident)[0] : '?'
    o.textContent = `${s.slug} — ${ident}, ${(s.length_m / 1000).toFixed(1)} km, ${s.structures} structures`
    sel.append(o)
  }
  const want = readStanceParam()?.site || location.hash.slice(1) || idx.sites[0]?.slug
  if (want) {
    sel.value = want
    await loadSite(want)
  }
  sel.onchange = () => loadSite(sel.value)
}

async function loadSite(slug: string) {
  location.hash = slug
  if (site) {
    scene.remove(site.group)
    site.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material as THREE.Material & { map?: THREE.Texture | null; alphaMap?: THREE.Texture | null }
        m.map?.dispose()
        m.alphaMap?.dispose()
        m.dispose()
      }
    })
    site = null
  }
  if (drive.car) { scene.remove(drive.car.mesh); drive.car = null }
  minimap?.dispose()
  minimap = null
  status(`loading ${slug}…`)
  const manifest = await fetchJSON<Manifest>(`/sites/${slug}/web/manifest.json`)
  site = await buildSite(manifest, status, LITE, renderer, scene.fog as THREE.FogExp2, season)
  applySky(season)
  scene.add(site.group)
  // `tune` is TUNE_TABS itself, so a probe can read and set any knob through the same getters and
  // setters the F6 panel uses — importing tuning.ts from a probe gets an HMR-dead copy instead.
  ;(window as unknown as { corridor: unknown }).corridor = { site, scene, camera, drive, tune: TUNE_TABS } // for probes and the console
  applyLayers()
  fillInfo(manifest)
  fly ??= new FlyControls(camera, orbit, canvas, (x, z) => site?.groundAt(x, z) ?? null)
  minimap = new MiniMap(document.body, manifest)
  const st = readStanceParam()
  if (st && st.site === slug) applyStance(st)
  else toPhoto()
  status('')
}

// ---------------------------------------------------------------------------------------------
// layers
function applyLayers() {
  if (!site) return
  const on = (name: string) => $<HTMLInputElement>(`input[data-layer="${name}"]`).checked
  site.setImagery(on('imagery'))
  site.setWire(on('wire'))
  if (site.layers.canopy) site.layers.canopy.visible = on('canopy')
  if (site.layers.trees) site.layers.trees.visible = on('trees')
  site.layers.road.visible = on('road')
  if (site.layers.horizon) site.layers.horizon.visible = on('horizon')
  site.layers.structures.visible = on('structures')
  site.layers.spine.visible = on('spine') && !drive.on
  site.layers.markers.visible = on('markers') && !drive.on
}
for (const el of document.querySelectorAll<HTMLInputElement>('input[data-layer]')) el.onchange = applyLayers

// ---------------------------------------------------------------------------------------------
// info panel
function fillInfo(m: Manifest) {
  const info = $('#info')
  const ident = m.ident ? Object.values(m.ident)[0] : '(unnamed)'
  const lidar = m.lidar.points_in_corridor ? `${m.lidar.dataset}, ${(m.lidar.points_in_corridor / 1e6).toFixed(1)} M points` : 'none'
  const rows = (pairs: [string, string][]) => `<table>${pairs.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`
  const structs = m.structures
    .map((st, i) => `<tr class="struct" data-i="${i}"><td>${st.kind}</td><td>${describe(st)}</td></tr>`)
    .join('')
  const byRel = m.crossings.reduce<Record<string, number>>((a, c) => ((a[c.relation] = (a[c.relation] ?? 0) + 1), a), {})
  // geology: one line of formation names in the panel; the full Macrostrat text opens in a dialog
  const geoShort = m.geology.units.slice(0, 4).map((u) => u.strat_name).filter(Boolean).join(' · ') || 'no named formations'
  const geoFull = m.geology.units
    .map((u) => `<p><b>${u.strat_name}</b>${u.lith ? ` · ${u.lith}` : ''}${u.b_age ? ` · ${u.b_age}–${u.t_age} Ma` : ''}${u.descrip ? `<br>${u.descrip}` : ''}</p>`)
    .join('')
  const geo = `<p>${geoShort}${m.geology.units.length > 4 ? ` +${m.geology.units.length - 4}` : ''} <button class="geo-more" type="button">full text</button></p>
    <dialog class="geo-dialog"><h2>geology along this corridor</h2>${geoFull || '<p>no named formations</p>'}<form method="dialog"><button>close</button></form></dialog>`
  info.innerHTML = `
    ${rows([
      ['road', ident],
      ['spine', `${(m.spine.length_m / 1000).toFixed(2)} km, photo at ${m.spine.photo_s.toFixed(0)} m`],
      ['frame', `EPSG:${m.frame.epsg}, origin ${m.frame.origin.map((v) => v.toFixed(0)).join(', ')}`],
      ['lidar', lidar],
      ['stand-ins', `${site?.treeCount ?? 0} trees from the canopy, road from ${m.spine.segments.length} OSM segments`],
      ['crossings', Object.entries(byRel).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'],
      ['surface', m.surface ? Object.entries(m.surface.summary).map(([k, v]) => `${k} ${(v * m.surface!.step_m / 1000).toFixed(1)} km`).join(', ') : 'not measured'],
    ])}
    <h2>structures (${m.structures.length})</h2><table>${structs || '<tr><td>none</td></tr>'}</table>
    <h2>geology</h2>${geo || '<p>no named formations</p>'}`
  info.querySelector<HTMLButtonElement>('.geo-more')?.addEventListener('click', () => info.querySelector<HTMLDialogElement>('.geo-dialog')?.showModal())
  for (const tr of info.querySelectorAll<HTMLTableRowElement>('tr.struct')) {
    tr.onclick = () => goToStructure(m.structures[Number(tr.dataset.i)])
  }
  const photos = $('#photos')
  photos.innerHTML = m.photos.map((p) => `<a href="/photos/${p.file}" target="_blank"><img src="/photos/${p.file}" title="${p.file} heading ${p.heading_deg ?? '?'}°" loading="lazy" /></a>`).join('')
}

// ---------------------------------------------------------------------------------------------
// cameras
function setDrive(on: boolean) {
  drive.on = on
  orbit.enabled = !on
  $('#drive').textContent = on ? 'fly (Tab)' : 'drive (Tab)'
  if (fly) fly.enabled = !on
  if (on && site) {
    if (!drive.car) {
      drive.car = new Car({ heightAt: site.groundAt, edgeDistance: site.edgeDistance, treesNear: site.treesNear })
      scene.add(drive.car.mesh)
      // spawn in the right-hand lane at the photo, facing along the road
      const p = site.spineAt(site.manifest.spine.photo_s)
      const side = p.dir.clone().cross(up).multiplyScalar(1.83)
      drive.car.place(p.pos.x + side.x, p.pos.z + side.z, Math.atan2(p.dir.z, p.dir.x))
    }
    drive.yaw = 0
    drive.pitch = 0
  }
  // the analysis overlays (centreline, photo ring) are for the map view; from the seat they read
  // as paint on the road, so they step aside while driving
  if (site) {
    site.layers.spine.visible = !on && $<HTMLInputElement>('input[data-layer="spine"]').checked
    site.layers.markers.visible = !on && $<HTMLInputElement>('input[data-layer="markers"]').checked
  }
}

function toPhoto() {
  if (!site) return
  setDrive(false)
  const p = site.spineAt(site.manifest.spine.photo_s)
  const back = p.dir.clone().multiplyScalar(-140)
  camera.position.copy(p.pos).add(back).add(new THREE.Vector3(0, 60, 0))
  orbit.target.copy(p.pos).add(p.dir.clone().multiplyScalar(80))
  orbit.update()
}

function toTop() {
  if (!site) return
  setDrive(false)
  const mid = site.spineAt(site.manifest.spine.length_m / 2)
  camera.position.copy(mid.pos).add(new THREE.Vector3(0, 4500, 1))
  orbit.target.copy(mid.pos)
  orbit.update()
}

function goToStructure(st: Structure) {
  if (!site) return
  setDrive(false)
  const p = site.spineAt(st.s_start - 60)
  camera.position.copy(p.pos).add(new THREE.Vector3(0, 12, 0)).add(p.dir.clone().multiplyScalar(-20))
  orbit.target.copy(site.spineAt((st.s_start + st.s_end) / 2).pos).add(new THREE.Vector3(0, st.kind === 'bridge' ? 0 : (st.clearance_m ?? 6), 0))
  orbit.update()
  status(describe(st))
}

// phone: bottom-sheet panel and on-screen drive buttons. LITE is also how the scene builder
// knows to hand a phone GPU a quarter of the vertices and a 4k texture instead of a 22 MP one.
export const LITE = matchMedia('(pointer: coarse)').matches || innerWidth < 900 || new URLSearchParams(location.search).has('lite')
$('#toggle').onclick = () => panel.classList.toggle('collapsed')
if (LITE) panel.classList.add('collapsed')
for (const b of document.querySelectorAll<HTMLButtonElement>('#drivepad button')) {
  // + and − are hold-to-throttle / hold-to-brake while driving
  if (b.dataset.act === 'faster' || b.dataset.act === 'slower') {
    const key = b.dataset.act === 'faster' ? 'throttle' : 'brake'
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!drive.on) setDrive(true); drive.input[key] = 1 })
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { drive.input[key] = 0 })
  }
  b.onclick = () => {
    switch (b.dataset.act) {
      case 'drive': setDrive(!drive.on); break
      case 'faster': if (!drive.on) setDrive(true); break
      case 'slower': break
      case 'photo': toPhoto(); break
    }
  }
}
// one finger drag looks around in drive mode; OrbitControls already handles touch when orbiting
canvas.addEventListener('touchstart', (e) => { if (drive.on && e.touches.length === 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY } }, { passive: true })
canvas.addEventListener('touchmove', (e) => {
  if (!drive.on || !dragging || e.touches.length !== 1) return
  drive.yaw -= (e.touches[0].clientX - lastX) * 0.005
  drive.pitch = Math.max(-0.8, Math.min(0.8, drive.pitch - (e.touches[0].clientY - lastY) * 0.004))
  lastX = e.touches[0].clientX; lastY = e.touches[0].clientY
}, { passive: true })
canvas.addEventListener('touchend', () => { dragging = false }, { passive: true })

// hold-to-move pad (phone). Velocity in the camera's horizontal frame; distance-scaled so it is
// a stroll at street level and a glide from the air.
const move = { fwd: 0, side: 0, up: 0 }
for (const b of document.querySelectorAll<HTMLButtonElement>('#movepad button')) {
  const set = (on: boolean) => {
    const v = on ? 1 : 0
    switch (b.dataset.move) {
      case 'fwd': move.fwd = v; drive.input.throttle = drive.on ? v : 0; break
      case 'back': move.fwd = -v; drive.input.brake = drive.on ? v : 0; break
      case 'left': move.side = -v; drive.steerKey = on ? -1 : 0; break
      case 'right': move.side = v; drive.steerKey = on ? 1 : 0; break
      case 'up': move.up = v; break
      case 'down': move.up = -v; break
    }
  }
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true) })
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => set(false))
}
function applyMove(dt: number) {
  if (drive.on || (!move.fwd && !move.side && !move.up)) return
  const dist = camera.position.distanceTo(orbit.target)
  const speed = Math.max(4, dist * 0.6) * dt
  const fwd = new THREE.Vector3()
  camera.getWorldDirection(fwd)
  fwd.y = 0
  fwd.normalize()
  const side = fwd.clone().cross(up)
  const d = fwd.multiplyScalar(move.fwd * speed).add(side.multiplyScalar(move.side * speed)).add(new THREE.Vector3(0, move.up * speed, 0))
  camera.position.add(d)
  orbit.target.add(d)
}

// season: sky, fog, ground tint here; leaves and grass in the scene
let season: Season = (new URLSearchParams(location.search).get('season') as Season) || 'summer'
if (!SEASONS.includes(season)) season = 'summer'
function applySky(s: Season) {
  const look = LOOK[s]
  ;(scene.background as THREE.Color).copy(look.sky)
  ;(scene.fog as THREE.FogExp2).color.copy(look.sky)
  ;(scene.fog as THREE.FogExp2).density = look.fog
}
const seasonSel = $<HTMLSelectElement>('#season')
seasonSel.value = season
seasonSel.onchange = () => {
  season = seasonSel.value as Season
  applySky(season)
  site?.setSeason(season)
  status(`${season}`)
  setTimeout(() => status(''), 1200)
}

// A STANCE is everything needed to reproduce what is on screen: site, season, mode, camera (or
// car), layer toggles, lite. C copies the current one as a URL; a URL with ?stance= restores it
// on load, and probes/corridor-stance.mjs renders it headlessly. Rich pastes the URL, I see his
// exact frame — no more guessing at a screenshot.
interface Stance {
  v: 1
  site: string
  season: Season
  mode: 'fly' | 'drive'
  cam?: { p: number[]; t: number[] }
  car?: { p: number[]; yaw: number; speed: number; look: number[] }
  layers: Record<string, boolean>
  lite: boolean
}
function captureStance(): Stance | null {
  if (!site) return null
  const layers: Record<string, boolean> = {}
  for (const el of document.querySelectorAll<HTMLInputElement>('input[data-layer]')) layers[el.dataset.layer!] = el.checked
  const st: Stance = { v: 1, site: site.manifest.slug, season, mode: drive.on ? 'drive' : 'fly', layers, lite: LITE }
  const r3 = (v: THREE.Vector3) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]
  if (drive.on && drive.car) st.car = { p: r3(drive.car.pos), yaw: +drive.car.yaw.toFixed(4), speed: +drive.car.speed.toFixed(2), look: [+drive.yaw.toFixed(3), +drive.pitch.toFixed(3)] }
  else st.cam = { p: r3(camera.position), t: r3(orbit.target) }
  return st
}
function stanceUrl(st: Stance): string {
  const u = new URL(location.href)
  u.searchParams.set('stance', btoa(JSON.stringify(st)))
  u.searchParams.set('season', st.season)
  u.hash = st.site
  return u.toString()
}
function applyStance(st: Stance) {
  for (const el of document.querySelectorAll<HTMLInputElement>('input[data-layer]')) if (el.dataset.layer! in st.layers) el.checked = st.layers[el.dataset.layer!]
  applyLayers()
  if (st.mode === 'drive' && st.car) {
    setDrive(true)
    if (drive.car) {
      drive.car.pos.set(st.car.p[0], st.car.p[1], st.car.p[2])
      drive.car.yaw = st.car.yaw
      drive.car.speed = st.car.speed
      drive.yaw = st.car.look[0]
      drive.pitch = st.car.look[1]
      // settle the camera immediately so the first frame is the stance, not a lerp toward it
      const back = drive.car.forward.set(Math.cos(st.car.yaw), 0, Math.sin(st.car.yaw)).clone().applyAxisAngle(up, drive.yaw).multiplyScalar(-7.5)
      camera.position.copy(drive.car.pos).add(back).add(new THREE.Vector3(0, 2.6, 0))
    }
  } else if (st.cam) {
    setDrive(false)
    camera.position.set(st.cam.p[0], st.cam.p[1], st.cam.p[2])
    orbit.target.set(st.cam.t[0], st.cam.t[1], st.cam.t[2])
    orbit.update()
  }
}
function readStanceParam(): Stance | null {
  const raw = new URLSearchParams(location.search).get('stance')
  if (!raw) return null
  try {
    return JSON.parse(atob(raw)) as Stance
  } catch {
    return null
  }
}
async function copyStance() {
  const st = captureStance()
  if (!st) return
  const url = stanceUrl(st)
  history.replaceState(null, '', url)
  try {
    await navigator.clipboard.writeText(url)
    status('stance copied to clipboard (also in the address bar)')
  } catch {
    status('stance is in the address bar — copy the URL')
  }
  setTimeout(() => { if ($('#status').textContent?.startsWith('stance')) status('') }, 4000)
}
$('#stance').onclick = copyStance

// the side panel hides completely (M or the ≡ tab), for looking at the picture
const panelTab = $('#paneltab')
function setPanelHidden(hidden: boolean) {
  panel.classList.toggle('hidden', hidden)
  panelTab.textContent = hidden ? '≡' : '×'
}
panelTab.onclick = () => setPanelHidden(!panel.classList.contains('hidden'))

// Tuning: one engine TunePanel per tab (grass, trees, LOD shape, road, car, camera), a tab strip
// above them. F6 toggles. Values persist per browser under apex-corridor-<tab>; Copy JSON in a
// panel hands the numbers back to tuning.ts. A change re-picks trees / re-seeds grass at once.
const tuneHost = document.createElement('div')
tuneHost.id = 'tunehost'
tuneHost.className = 'hidden'
const tabStrip = document.createElement('div')
tabStrip.className = 'tunetabs'
tuneHost.append(tabStrip)
document.body.append(tuneHost)
const tunePanels = TUNE_TABS.map((tab) => {
  const panelEl = document.createElement('div')
  tuneHost.append(panelEl)
  const p = new TunePanel(panelEl, `corridor-${tab.name}`, tab.sections)
  p.context = () => (captureStance() ?? {}) as Record<string, unknown>
  p.onChange = () => site?.retune()
  const b = document.createElement('button')
  b.textContent = tab.name
  b.onclick = () => showTuneTab(tab.name)
  tabStrip.append(b)
  return { name: tab.name, panel: p, button: b }
})
let tuneTab = tunePanels[0].name
function showTuneTab(name: string) {
  tuneTab = name
  for (const t of tunePanels) {
    t.panel.toggle(t.name === name)
    t.button.classList.toggle('active', t.name === name)
  }
}
function toggleTune() {
  const on = tuneHost.classList.toggle('hidden')
  if (!on) showTuneTab(tuneTab)
  else for (const t of tunePanels) t.panel.toggle(false)
}
$('#tune').onclick = toggleTune

$('#drive').onclick = () => setDrive(!drive.on)
$('#photo').onclick = toPhoto
$('#top').onclick = toTop
// Tab toggles drive/fly. Driving: W/S throttle/brake, A/D steer, Space handbrake, R resets to the
// road. Flying: see fly.ts (WASD move, Q/E rotate, R/F dolly, T/G lift, right-drag look). P and
// H (home = top) are shared.
const held = new Set<string>()
addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement
  const inField = tgt.tagName === 'SELECT' || tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA'
  // focus management: while driving, a slider or select that still has focus must not eat the
  // arrow keys (Rich: "arrow keys move around inside the frame while you are driving")
  if (inField && drive.on && (e.code.startsWith('Arrow') || ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Tab'].includes(e.code))) {
    tgt.blur()
    e.preventDefault()
  } else if (inField && !(tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type === 'range' && e.code === 'Tab')) return
  if (e.code === 'Tab') { e.preventDefault(); setDrive(!drive.on); return }
  if (e.code === 'F6') { e.preventDefault(); toggleTune(); return }
  held.add(e.code)
  switch (e.code) {
    case 'KeyP': toPhoto(); break
    case 'KeyH': toTop(); break
    case 'KeyC': if (drive.on) { drive.cockpit = !drive.cockpit; break } void copyStance(); break
    case 'KeyX': void copyStance(); break
    case 'KeyG': if (!drive.on && site) sitOnRoad(camera, orbit, site.spineAt, site.manifest.spine.length_m); break
    case 'KeyM': setPanelHidden(!panel.classList.contains('hidden')); break
    case 'KeyN': minimap?.setExpanded(!minimap.expanded); break
    case 'KeyR': if (drive.on && site && drive.car) { const p = site.spineAt(site.manifest.spine.photo_s); const side = p.dir.clone().cross(up).multiplyScalar(1.83); drive.car.place(p.pos.x + side.x, p.pos.z + side.z, Math.atan2(p.dir.z, p.dir.x)) } break
  }
  if (drive.on && (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'].includes(e.code) || e.code.startsWith('Arrow'))) e.preventDefault()
})
addEventListener('keyup', (e) => held.delete(e.code))
addEventListener('blur', () => held.clear())
function readDriveKeys() {
  const i = drive.input
  i.throttle = Math.max(i.throttle, held.has('KeyW') || held.has('ArrowUp') ? 1 : 0)
  i.brake = Math.max(i.brake, held.has('KeyS') || held.has('ArrowDown') ? 1 : 0)
  const ks = Number(held.has('KeyD') || held.has('ArrowRight')) - Number(held.has('KeyA') || held.has('ArrowLeft'))
  i.steer = THREE.MathUtils.clamp(ks || drive.steerKey, -1, 1)
  i.handbrake = held.has('Space')
}

// drag to look around while driving; click a structure or crossing for its numbers
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; downAt = performance.now() })
canvas.addEventListener('pointerup', (e) => {
  dragging = false
  if (performance.now() - downAt < 250 && site) pick(e)
})
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !drive.on) return
  drive.yaw -= (e.clientX - lastX) * 0.004
  drive.pitch = Math.max(-0.8, Math.min(0.8, drive.pitch - (e.clientY - lastY) * 0.003))
  lastX = e.clientX; lastY = e.clientY
})
const ray = new THREE.Raycaster()
function pick(e: PointerEvent) {
  if (!site) return
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera)
  const hit = ray.intersectObjects([...site.layers.structures.children, ...site.layers.markers.children], true)[0]
  if (!hit) return
  const st = hit.object.userData.structure as Structure | undefined
  const c = hit.object.userData.crossing as Crossing | undefined
  if (st) status(describe(st))
  else if (c) status(`${c.kind ?? 'way'} ${c.name ?? ''} crosses ${c.relation} us at ${c.s.toFixed(0)} m${c.inferred ? ' (inferred from OSM)' : ''}`)
}

// ---------------------------------------------------------------------------------------------
// frame loop
const clock = new THREE.Clock()
const up = new THREE.Vector3(0, 1, 0)
const viewDir = new THREE.Vector3()
function frame() {
  const dt = Math.min(0.1, clock.getDelta())
  if (site && drive.on && drive.car) {
    const car = drive.car
    // keyboard is read fresh each frame; the phone pads have already set throttle/brake/steer
    const padT = drive.input.throttle, padB = drive.input.brake
    readDriveKeys()
    // fixed-step sim at 120 Hz like stuntin, so speed does not depend on the frame rate
    for (let acc = dt; acc > 0; acc -= 1 / 120) car.tick(Math.min(acc, 1 / 120), drive.input)
    drive.input.throttle = padT
    drive.input.brake = padB
    // chase camera: behind and above, looking over the bonnet; drag adds a look-around yaw
    car.setCockpit(drive.cockpit)
    if (drive.cockpit) {
      // Cockpit: eye at the driver's head, looking down the nose (stuntin's C view); drive.yaw/pitch
      // look around. NOTE there is no early return here. This branch used to `return` out of
      // frame(), which skipped site.updateNear, the minimap, renderer.render AND the
      // requestAnimationFrame that re-arms the loop — so pressing C froze the viewer dead and
      // nothing brought it back (probes/corridor-cockpit.mjs: the car moved 0.48 m in 2 s in chase
      // and 0.00 m in cockpit). The eye rides the body, so it pitches and rolls with the car.
      const lean = new THREE.Vector3(0, T.COCKPIT_EYE_UP, 0).applyAxisAngle(car.right, -Math.atan(car.pitch))
      const eye = car.pos.clone().add(lean).add(car.forward.clone().multiplyScalar(T.COCKPIT_EYE_FWD)).addScaledVector(car.right, T.COCKPIT_EYE_SIDE)
      camera.position.copy(eye)
      const ahead = car.forward.clone().applyAxisAngle(up, drive.yaw)
      camera.up.set(0, 1, 0).applyAxisAngle(car.forward, Math.atan(car.roll) * T.COCKPIT_ROLL)
      camera.lookAt(eye.clone().add(ahead.multiplyScalar(30)).add(new THREE.Vector3(0, -Math.tan(drive.pitch) * 30 + T.COCKPIT_LOOK_UP, 0)))
    } else {
      camera.up.set(0, 1, 0)
      const back = car.forward.clone().applyAxisAngle(up, drive.yaw).multiplyScalar(-T.CHASE_BACK)
      const want = car.pos.clone().add(back).add(new THREE.Vector3(0, T.CHASE_UP + Math.tan(drive.pitch) * 4, 0))
      const gy = site.groundAt(want.x, want.z)
      if (gy !== null && want.y < gy + 1.2) want.y = gy + 1.2
      camera.position.lerp(want, 1 - Math.exp(-T.CHASE_LAG * dt))
      camera.lookAt(car.pos.clone().add(car.forward.clone().multiplyScalar(T.CHASE_LOOK_AHEAD)).add(new THREE.Vector3(0, 1.0, 0)))
    }
    if (car.event === 'bump') status('bump')
    $('#pos').textContent = `${(Math.abs(car.speed) * 2.237).toFixed(0)} mph  ${car.onGrass ? 'grass' : 'pavement'}${Math.abs(car.slide) > 1 ? '  sliding' : ''}${drive.cockpit ? '  cockpit' : ''}`
  } else {
    fly?.update(dt)
    applyMove(dt)
    orbit.update()
    $('#pos').textContent = ''
  }
  if (site) {
    const fwd = camera.getWorldDirection(viewDir)
    const pitch = Math.max(0, -Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1))) // 0 level, +down
    site.updateNear(camera.position, clock.elapsedTime, fwd, pitch)
    // the inset map follows the car when driving, the camera when flying; site frame is x east, y north = -z
    if (drive.on && drive.car) minimap?.draw({ x: drive.car.pos.x, y: -drive.car.pos.z, yaw: Math.atan2(-drive.car.forward.z, drive.car.forward.x) })
    else minimap?.draw({ x: camera.position.x, y: -camera.position.z, yaw: Math.atan2(-fwd.z, fwd.x) })
  }
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

loadIndex().then(frame).catch((e) => status(`failed: ${e.message}`))
