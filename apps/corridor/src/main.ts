// corridor viewer: look at what tools/corridor baked, from above and from the driver's seat.
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildSite, describe, type Site } from './scene'
import { Car, type CarInput } from './car'
import { FlyControls } from './fly'
import { MiniMap } from './minimap'
import { Sky } from './sky'
import { SquishyHunt } from './games/squishy'
import * as T from './tuning'
import { TUNE_TABS } from './tuning'
import { applySiteTuning, saveSiteTuning } from './sitetuning'

import { fetchJSON, type IndexEntry, type Manifest, type Structure, type Crossing } from './site'
import { LOOK, SEASONS, type Season } from './season'
import { STYLE, styled, isStyle, type Style } from './style'
import { WEATHER, WEATHERS, type Weather } from './weather'
import { ViewerUI, restoreTheme } from './ui/viewer'
import { TuneUI } from './ui/tune'
import { installShellKeys, toast, status, clearStatus } from './ui/shell'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

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

const ambient = new THREE.HemisphereLight(0xe9eef2, 0x7a6a50, 0.75)
scene.add(ambient)
const sun = new THREE.DirectionalLight(0xfff0d8, 2.0)
sun.position.set(-3000, 4000, 2500)
scene.add(sun)
// the dome behind everything; `scene.background` stays as the colour under it for the one frame
// before the shader compiles and for anything that reads it
const skyDome = new Sky()
scene.add(skyDome.mesh)

let site: Site | null = null
let minimap: MiniMap | null = null

// The interface. Built before anything else touches a tunable, because TuneUI's constructor
// restores this browser's saved knobs and everything downstream reads them as its starting value.
restoreTheme()
const tuneUI = new TuneUI({
  context: () => (captureStance() ?? {}) as Record<string, unknown>,
  onChange: () => onTuneChange(),
  onSaveSite: () => void doSaveSiteTuning(),
})
const ui = new ViewerUI({
  onSite: (slug) => {
    location.hash = slug
    void loadSite(slug)
  },
  onSeason: (s) => setSeason(s),
  onStyle: (s) => setStyle(s),
  onWeather: (w) => setWeatherSelection(w),
  onLayers: () => applyLayers(),
  onDrive: () => setDrive(!drive.on),
  onPhoto: () => toPhoto(),
  onTop: () => toTop(),
  onStance: () => void copyStance(),
  onTune: () => tuneUI.toggle(),
  onStructure: (i) => site && goToStructure(site.manifest.structures[i]),
})
ui.describe = (s) => describe(s as Structure)
installShellKeys(() => ui.drawer)
let dragging = false, lastX = 0, lastY = 0, downAt = 0
// drive mode: a real car (stuntin dynamics) on the corridor strip, chase camera behind it
const drive = { on: false, cockpit: false, yaw: 0, pitch: 0, car: null as Car | null, input: { throttle: 0, brake: 0, steer: 0, handbrake: false } as CarInput, steerKey: 0 }
let fly: FlyControls | null = null
// the games ride on the viewer: ?game=squishy starts one when the site lands, G toggles it
let game: SquishyHunt | null = null
const wantGame = new URLSearchParams(location.search).get('game')

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
  const want = readStanceParam()?.site || location.hash.slice(1) || idx.sites[0]?.slug
  ui.setSites(idx.sites, want ?? '')
  if (want) await loadSite(want)
}

async function loadSite(slug: string) {
  location.hash = slug
  ui.setSite(slug)
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
  site = await buildSite(manifest, status, LITE, renderer, scene.fog as THREE.FogExp2, season, style)
  applySky(season)
  scene.add(site.group)
  // for probes and the console. `tune` is the same knob table the F6 panel drives, so a probe can
  // sweep a knob exactly as Rich would and see the same rebuild — the module's `export let`s
  // cannot be written from outside, and a dynamic import of tuning.ts under HMR is a dead copy.
  ;(window as unknown as { corridor: unknown }).corridor = {
    site,
    scene,
    camera,
    // the orbit controls re-derive the camera from their own target every frame, so a probe that
    // only writes camera.position gets dragged back; set orbit.target too, as applyStance does
    orbit,
    drive,
    THREE, // probes need Raycaster/Vector3 in the page, and there is no other handle on it

    tune: {
      tabs: TUNE_TABS,
      names: () => TUNE_TABS.flatMap((t) => t.sections.flatMap((sec) => sec.keys.map((k) => k.name))),
      get: (name: string) => tuneKey(name)?.get(),
      set: (name: string, v: number) => {
        const k = tuneKey(name)
        if (!k) return false
        k.set(v)
        onTuneChange()
        return true
      },
    },
  }
  applyLayers()
  fillInfo(manifest)
  fly ??= new FlyControls(camera, orbit, canvas, (x, z) => site?.groundAt(x, z) ?? null)
  game?.dispose()
  game = null
  if (wantGame === 'squishy') startSquishy()
  minimap = new MiniMap(document.body, manifest)
  const st = readStanceParam()
  if (st && st.site === slug) applyStance(st)
  else toPhoto()
  // per-site knob overrides, applied AFTER the panels have restored the browser's values so the
  // committed file wins, and undoing whatever the previous site's file had set
  const tuned = await applySiteTuning(slug, siteTuneAccess)
  if (tuned.applied || tuned.unknown.length) {
    onTuneChange()
    toast(`${slug}: ${tuned.applied} site knobs applied${tuned.unknown.length ? `, ${tuned.unknown.length} unknown (${tuned.unknown.slice(0, 3).join(', ')})` : ''}`, 'ok', 4000)
  } else clearStatus()
}

// ---------------------------------------------------------------------------------------------
// layers
function applyLayers() {
  if (!site) return
  const state = ui.layers()
  const on = (name: string) => state[name] ?? false
  site.setImagery(on('imagery'))
  site.setWire(on('wire'))
  site.setCanopy(on('canopy'))
  site.layers.buildings.visible = on('buildings')
  if (site.layers.power) site.layers.power.visible = on('power')
  if (site.layers.trees) site.layers.trees.visible = on('trees')
  if (site.layers.grass) site.layers.grass.visible = on('grass')
  site.layers.road.visible = on('road')
  if (site.layers.horizon) site.layers.horizon.visible = on('horizon')
  site.layers.structures.visible = on('structures')
  if (site.layers.furniture) site.layers.furniture.visible = on('furniture')
  if (site.layers.parking) site.layers.parking.visible = on('parking')
  if (site.layers.barriers) site.layers.barriers.visible = on('barriers')
  if (site.layers.sidewalks) site.layers.sidewalks.visible = on('sidewalks')
  // street-spice's derived intersection control. The Site carries these but nothing toggled them:
  // their branch declared the checkboxes in index.html, and that markup no longer exists — layers
  // are declared in ui/viewer.ts LAYER_GROUPS now, so the wiring has to be here.
  if (site.layers.signals) site.layers.signals.visible = on('signals')
  if (site.layers.stopbars) site.layers.stopbars.visible = on('stopbars')
  if (site.layers.blades) site.layers.blades.visible = on('blades')
  if (site.layers.rocks) site.layers.rocks.visible = on('rocks')
  if (site.layers.water) site.layers.water.visible = on('water')
  site.layers.spine.visible = on('spine') && !drive.on
  site.layers.markers.visible = on('markers') && !drive.on
}

// ---------------------------------------------------------------------------------------------
// info panel
/**
 * Hand the settings dialog what the bake measured.
 *
 * Everything this used to build by hand — a table of innerHTML, a nested <dialog> for the geology
 * and a strip of <img> — is now built by ui/viewer.ts from the manifest, so the markup lives with
 * the rest of the interface and this function is the seam: the two counts below are the only
 * things the scene knows and the manifest does not.
 */
function fillInfo(m: Manifest) {
  ui.setManifest(m, {
    'Stand-ins': `${site?.treeCount ?? 0} trees from the canopy, road from ${m.spine.segments.length} OSM segments`,
    Buildings: site
      ? `${site.buildingStats.count} footprints (${site.buildingStats.fromLidar} measured, ${site.buildingStats.gabled} gabled)`
      : '—',
  })
}
// ---------------------------------------------------------------------------------------------
// cameras
/** Squishy Hunt on this site, on foot; G again ends it. */
function startSquishy() {
  if (!site) return
  game?.dispose()
  game = new SquishyHunt(site, document.body)
  // ?room=name&player=Ava shares the hunt through the world-editor service's relay
  const qs = new URLSearchParams(location.search)
  const roomName = qs.get('room')
  if (roomName) game.join(roomName, qs.get('player') ?? 'you')
  setDrive(false)
  setWalk(true)
  toast(`Squishy Hunt: ${game.hauls.length} squishies hidden around town. Walk with W/A/S/D, look with the right mouse button.`, 'info', 6000)
}
function setWalk(on: boolean) {
  if (!fly) return
  fly.setWalk(on)
  if (on) toast('on foot (B to fly again)', 'info', 1500)
}
function setDrive(on: boolean) {
  drive.on = on
  if (on && fly?.walk) fly.setWalk(false)
  orbit.enabled = !on
  ui.setDriveMode(on)
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
    site.layers.spine.visible = !on && ui.layers().spine
    site.layers.markers.visible = !on && ui.layers().markers
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
// style: realistic is the bake as measured; ?style=fantasy is the first palette that is not Crofton
const styleParam = new URLSearchParams(location.search).get('style')
let style: Style = isStyle(styleParam) ? styleParam : 'realistic'
/**
 * Sky, fog and LIGHT for the season, then the weather pulled over the top of it. Both in one place
 * because weather is a modifier on a season and not a state of its own: snow under a winter sun is
 * a different scene from snow under a summer one.
 */
function applySky(s: Season) {
  const look = styled(LOOK[s], style)
  const def = STYLE[style]
  const w = WEATHER[weatherNow()]
  const sky = look.sky.clone().lerp(w.skyTint, w.skyMix)
  ;(scene.background as THREE.Color).copy(sky)
  ;(scene.fog as THREE.FogExp2).color.copy(sky)
  ;(scene.fog as THREE.FogExp2).density = look.fog * w.fogScale
  // the dome reads the same two inputs: the season's blue overhead, the fog colour at the horizon,
  // the weather's cover — a clear day is a third cumulus, an overcast one (skyMix ~0.9) is shut
  skyDome.set({
    zenith: (def.sky ? def.sky.zenith.clone() : look.sky.clone().lerp(new THREE.Color(0x4f86d2), 0.55)).lerp(w.skyTint, w.skyMix),
    horizon: sky,
    cover: Math.min(1, 0.3 + (def.sky?.cloudBias ?? 0) + 0.7 * w.skyMix),
    haze: Math.min(1, 0.35 + w.skyMix * 0.6),
    sunDir: sun.position,
    sunColour: look.sun.colour,
  })
  sun.color.copy(look.sun.colour)
  // overcast: the sun goes down and the sky comes up, which is what a grey day actually is
  sun.intensity = look.sun.intensity * (1 - 0.72 * w.skyMix)
  ambient.color.copy(look.ambient.sky)
  ambient.groundColor.copy(look.ambient.ground)
  ambient.intensity = look.ambient.intensity * (1 + 0.5 * w.skyMix)
  // the knob is the single source of truth for road-and-car: car.ts reads T.WEATHER_GRIP_SCALE
  tuneKey('WEATHER_GRIP_SCALE')?.set(w.grip)
  site?.setWeather(weatherNow())
}

/** the weather the WEATHER knob selects */
function weatherNow(): Weather {
  return WEATHERS[Math.min(4, Math.max(0, Math.round(T.WEATHER)))]
}
function setSeason(s: Season) {
  season = s
  applySky(s)
  site?.setSeason(s)
  toast(s, 'info', 1200)
}
function setStyle(s: Style) {
  style = s
  applySky(season)
  site?.setStyle(s)
  toast(s, 'info', 1200)
}

/**
 * The weather picker writes the WEATHER knob rather than a variable of its own, because the knob
 * is what `weatherNow()` reads and what a stance and a site's tuning.json already carry. One
 * source of truth, and the tuning dialog and this select stay in step for free.
 */
function setWeatherSelection(w: Weather) {
  const i = WEATHERS.indexOf(w)
  if (i < 0) return
  tuneKey('WEATHER')?.set(i)
  onTuneChange()
  toast(w, 'info', 1200)
}
/** the F6 season knob (tuning.ts SEASON, -1 = leave the selector alone) */
function applySeasonKnob() {
  if (T.SEASON < 0) return
  const want = SEASONS[Math.min(3, Math.max(0, Math.round(T.SEASON)))]
  if (want !== season) setSeason(want)
}
/**
 * A knob moved. The F6 panel and `window.corridor.tune.set` both come through here, so a probe
 * sweeping a knob gets exactly what Rich gets from the slider — the first version of the probe
 * hook called `retune()` alone and the season knob silently did nothing under it.
 */
function onTuneChange() {
  applySeasonKnob()
  applySky(season) // the WEATHER knob lives here: sky, fog, sun, grip and what is falling
  site?.retune()
}

// A STANCE is everything needed to reproduce what is on screen: site, season, mode, camera (or
// car), layer toggles, lite. C copies the current one as a URL; a URL with ?stance= restores it
// on load, and probes/corridor-stance.mjs renders it headlessly. Rich pastes the URL, I see his
// exact frame — no more guessing at a screenshot.
interface Stance {
  v: 1
  site: string
  season: Season
  style?: Style
  mode: 'fly' | 'drive'
  cam?: { p: number[]; t: number[] }
  car?: { p: number[]; yaw: number; speed: number; look: number[] }
  layers: Record<string, boolean>
  lite: boolean
}
function captureStance(): Stance | null {
  if (!site) return null
  const layers: Record<string, boolean> = {}
  Object.assign(layers, ui.layers())
  const st: Stance = { v: 1, site: site.manifest.slug, season, style, mode: drive.on ? 'drive' : 'fly', layers, lite: LITE }
  const r3 = (v: THREE.Vector3) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]
  if (drive.on && drive.car) st.car = { p: r3(drive.car.pos), yaw: +drive.car.yaw.toFixed(4), speed: +drive.car.speed.toFixed(2), look: [+drive.yaw.toFixed(3), +drive.pitch.toFixed(3)] }
  else st.cam = { p: r3(camera.position), t: r3(orbit.target) }
  return st
}
function stanceUrl(st: Stance): string {
  const u = new URL(location.href)
  u.searchParams.set('stance', btoa(JSON.stringify(st)))
  u.searchParams.set('season', st.season)
  if (st.style && st.style !== 'realistic') u.searchParams.set('style', st.style)
  else u.searchParams.delete('style')
  u.hash = st.site
  return u.toString()
}
function applyStance(st: Stance) {
  ui.setLayers(st.layers)
  applyLayers()
  if (st.style && isStyle(st.style) && st.style !== style) setStyle(st.style)
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
  // The clipboard only. This used to also rewrite the address bar, so the page's own URL changed
  // under you every time you pressed C — Rich: "copy a link to this view replaces the URL for no
  // reason" (2026-09-26). The address bar is left alone; if the clipboard is blocked the link is
  // printed to the console instead, which is where a blocked clipboard's caller is looking anyway.
  try {
    await navigator.clipboard.writeText(url)
    toast('view copied to the clipboard', 'ok')
  } catch {
    console.log(url)
    toast('clipboard blocked — the view link is in the console', 'warn')
  }
}

// M hides the whole interface, for looking at the picture rather than at the furniture.
function setChromeHidden(hidden: boolean) {
  document.body.classList.toggle('chrome-off', hidden)
}

// Tuning is its own dialog now (ui/tune.ts): the same knob table, the same localStorage keys as
// the old F6 panel so this browser's saved values survive, Copy JSON with the stance as context,
// Reset, and "save to site". F6 opens it.

/** How sitetuning.ts reaches the knobs, without it needing to know about TUNE_TABS. */
const siteTuneAccess = tuneUI.access

/**
 * The code defaults — the baseline a per-site tuning.json is a diff against. Read from each
 * TuneKey's own `default`, which `tune()` captures when tuning.ts is first evaluated, so it is the
 * committed number and not whatever this browser had restored over it.
 */
const TUNE_BASELINE = tuneUI.baseline

/** Write the knobs that differ from the code defaults into this site's tuning.json. */
async function doSaveSiteTuning() {
  if (!site) return
  try {
    const r = await saveSiteTuning(site.manifest.slug, siteTuneAccess, TUNE_BASELINE)
    toast(`saved ${r.count} knobs to ${site.manifest.slug}/tuning.json (${r.bytes} bytes)`, 'ok')
  } catch (e) {
    toast(`site tuning: ${(e as Error).message}`, 'danger')
  }
}
// Tab toggles drive/fly. Driving: W/S throttle/brake, A/D steer, Space handbrake, R backs you out (Shift+R resets to the
// road. Flying: see fly.ts (WASD move, Q/E rotate, R/F dolly, T/G lift, right-drag look). P and
// H (home = top) are shared.
/** one knob of the F6 panel by name, wherever its tab is; undefined if there is no such knob */
function tuneKey(name: string) {
  for (const t of TUNE_TABS) for (const sec of t.sections) for (const k of sec.keys) if (k.name === name) return k
  return undefined
}

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
  if (e.code === 'F6') { e.preventDefault(); tuneUI.toggle(); return }
  held.add(e.code)
  switch (e.code) {
    case 'KeyP': toPhoto(); break
    case 'KeyH': toTop(); break
    case 'KeyC': if (drive.on) { drive.cockpit = !drive.cockpit; break } void copyStance(); break
    case 'KeyX': void copyStance(); break
    case 'KeyM': setChromeHidden(!document.body.classList.contains('chrome-off')); break
    case 'KeyN': minimap?.setExpanded(!minimap.expanded); break
    case 'KeyB': if (!drive.on && fly) setWalk(!fly.walk); break
    case 'KeyG': if (game) { game.dispose(); game = null; toast('hunt over', 'info', 1200) } else startSquishy(); break
    // R backs you out the way you came (stuntin's recover); Shift+R is the old teleport to the
    // photo station, kept for getting back to the start of the corridor
    case 'KeyR':
      if (!(drive.on && site && drive.car)) break
      if (e.shiftKey) { const p = site.spineAt(site.manifest.spine.photo_s); const side = p.dir.clone().cross(up).multiplyScalar(1.83); drive.car.place(p.pos.x + side.x, p.pos.z + side.z, Math.atan2(p.dir.z, p.dir.x)) }
      else drive.car.recover(T.CAR_RECOVER_BACK)
      break
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
    if (drive.cockpit) {
      // cockpit: eye at the driver's head, looking down the nose (stuntin's C view); drive.yaw/pitch look around
      const eye = car.pos.clone().add(new THREE.Vector3(0, T.COCKPIT_EYE_UP, 0)).add(car.forward.clone().multiplyScalar(T.COCKPIT_EYE_FWD))
      camera.position.copy(eye)
      const ahead = car.forward.clone().applyAxisAngle(up, drive.yaw)
      camera.lookAt(eye.clone().add(ahead.multiplyScalar(30)).add(new THREE.Vector3(0, -Math.tan(drive.pitch) * 30 + T.COCKPIT_LOOK_UP, 0)))
      return
    }
    const back = car.forward.clone().applyAxisAngle(up, drive.yaw).multiplyScalar(-T.CHASE_BACK)
    const want = car.pos.clone().add(back).add(new THREE.Vector3(0, T.CHASE_UP + Math.tan(drive.pitch) * 4, 0))
    const gy = site.groundAt(want.x, want.z)
    if (gy !== null && want.y < gy + 1.2) want.y = gy + 1.2
    camera.position.lerp(want, 1 - Math.exp(-T.CHASE_LAG * dt))
    camera.lookAt(car.pos.clone().add(car.forward.clone().multiplyScalar(T.CHASE_LOOK_AHEAD)).add(new THREE.Vector3(0, 1.0, 0)))
    if (car.event === 'bump') status('bump')
    ui.setPos(`${(Math.abs(car.speed) * 2.237).toFixed(0)} mph · ${car.onGrass ? 'grass' : 'pavement'}${Math.abs(car.slide) > 1 ? ' · sliding' : ''}`)
  } else {
    fly?.update(dt)
    applyMove(dt)
    orbit.update()
    ui.setPos('')
  }
  if (site) {
    const fwd = camera.getWorldDirection(viewDir)
    const pitch = Math.max(0, -Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1))) // 0 level, +down
    site.updateNear(camera.position, clock.elapsedTime, fwd, pitch)
    // the player is the car when driving, the eye on foot or in the air; heading is compass from north
    if (game) game.tick(dt, drive.on && drive.car ? drive.car.pos : camera.position, drive.on && drive.car ? Math.atan2(drive.car.forward.x, -drive.car.forward.z) : Math.atan2(fwd.x, -fwd.z))
    // the inset map follows the car when driving, the camera when flying; site frame is x east, y north = -z
    if (drive.on && drive.car) minimap?.draw({ x: drive.car.pos.x, y: -drive.car.pos.z, yaw: Math.atan2(-drive.car.forward.z, drive.car.forward.x) })
    else minimap?.draw({ x: camera.position.x, y: -camera.position.z, yaw: Math.atan2(-fwd.z, fwd.x) })
  }
  skyDome.tick(performance.now() / 1000)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

// the stack matters: `status()` shows only the message, and a load failure here is usually a
// shader or a missing layer several files down
loadIndex().then(frame).catch((e) => {
  console.error('corridor: load failed', e)
  status(`failed: ${e.message}`)
})

// --- dev operator shell ---------------------------------------------------------------------
// Inert unless the dev server was started with APEX_BRIDGE set, and it cannot reach a build at
// all — the virtual module resolves to empty no-ops otherwise, so not a byte of it, and no handle
// onto the scene, exists at runtime. `just bridge-dev corridor`, then `just bridge '<js>' corridor`.
//
// This exists because the agent box has no GPU. Every frame-time number in this app's commits so
// far is swiftshader's, which falls off a cliff at a few hundred thousand triangles and says
// nothing about a real card. `apex.perf()` reads `renderer.info` — the DRAW CALLS and TRIANGLES
// the GPU was actually given — plus measured frame times, from the machine that has one.
startDevBridge()
registerBridgeContext({
  get site() {
    return site
  },
  scene,
  camera,
  orbit,
  renderer,
  drive,
  THREE,
  tune: TUNE_TABS,
  /**
   * What the renderer really did, and what the frames really cost.
   *
   * 30 frames is half a second on a real card and fits inside the bridge's 5 s eval timeout; ask
   * for more with `apex.perf(120)` and pass `--timeout 30000` to the client.
   */
  perf: (frames = 30) =>
    new Promise<unknown>((resolve) => {
      const t: number[] = []
      let last = performance.now()
      let i = 0
      const tick = () => {
        const n = performance.now()
        t.push(n - last)
        last = n
        if (++i < frames) return requestAnimationFrame(tick)
        const s = [...t].sort((a, b) => a - b)
        const at = (p: number) => Math.round((s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0) * 100) / 100
        const r = renderer.info.render
        resolve({
          site: site?.manifest.slug ?? null,
          frames: t.length,
          fps: Math.round(1000 / (t.reduce((a, b) => a + b, 0) / t.length)),
          ms: { median: at(0.5), p90: at(0.9), p99: at(0.99), max: Math.round(Math.max(...t) * 100) / 100 },
          drawCalls: r.calls,
          triangles: r.triangles,
          programs: renderer.info.programs?.length ?? null,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          drive: drive.on,
        })
      }
      requestAnimationFrame(tick)
    }),
})
