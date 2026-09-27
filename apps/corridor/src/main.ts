// corridor viewer: look at what tools/corridor baked, from above and from the driver's seat.
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildSite, describe, type Site } from './scene'
import { Car, type CarInput } from './car'
import { retro } from './retro'
import { SiteSearch } from './search'

/** 16-point compass, indexed by bearing/22.5 — N at 0, clockwise through E. */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
import { FlyControls } from './fly'
import { MiniMap, siteProjector } from './minimap'
import { Sky } from './sky'
import { SquishyHunt } from './games/squishy'
import { Parkour } from './games/parkour'
import * as T from './tuning'
import { TUNE_TABS } from './tuning'
import { applySiteTuning, clearSiteTuning, saveSiteTuning } from './sitetuning'

import { fetchJSON, type IndexEntry, type Manifest, type Structure, type Crossing } from './site'
import { LOOK, SEASONS, type Season } from './season'
import { STYLE, styled, isStyle, type Style } from './style'
import { setRelief, relief, clampRelief, spineDatum, reliefManifest } from './relief'
import { WorldClock, sunPosition, sunVector } from './sun'
import { SplatField, attachmentsFor } from './splats'
import { rasteriseEnvelope, splatMaskUniforms } from './splatmask'
import { Attribution } from './attribution'
import { loadSiteTuning } from './sitetuning'
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
// You can look UP. The half-circle limit stopped the camera dropping below the target's own
// plane, which also meant the sky above the horizon was unreachable — no use at all now that
// there is a sun arc, a sunset and a sky full of stars to look at (2026-09-26).
orbit.maxPolarAngle = Math.PI - 0.05

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
/** captured worlds attached to this site (splats.ts) */
let splats: SplatField[] = []
/**
 * A probe's direct hold on the seam's strength.
 *
 * Going through the knob would work and would also `retune()` — re-seeding the grass and
 * re-picking the trees between the two frames a difference image is comparing, so the measurement
 * would be of the vegetation rather than of the seam. Four rounds of exactly that were spent on
 * the splat depth test in September. This writes the uniform and nothing else.
 */
let splatFadeOverride: number | null = null
/** the seam: where a capture has taken over, as a texture the built world's shaders sample */
const splatMask = splatMaskUniforms()
let splatCover: { w: number; h: number; covered: number; segments: number } | null = null
/** the credits line: two of the sources require it, the rest deserve it */
const attribution = new Attribution(document.body)

// The interface. Built before anything else touches a tunable, because TuneUI's constructor
// restores this browser's saved knobs and everything downstream reads them as its starting value.
restoreTheme()
const tuneUI = new TuneUI({
  context: () => (captureStance() ?? {}) as Record<string, unknown>,
  onChange: () => onTuneChange(),
  onSaveSite: () => void doSaveSiteTuning(),
  onClearSite: () => void doClearSiteTuning(),
})
const ui = new ViewerUI({
  onSite: (slug) => {
    location.hash = slug
    void loadSite(slug)
  },
  onSeason: (s) => setSeason(s),
  onStyle: (s) => setStyle(s),
  onRelief: (k) => {
    reliefWanted = clampRelief(k)
    const u = new URL(location.href)
    if (reliefWanted === 1) u.searchParams.delete('relief')
    else u.searchParams.set('relief', String(reliefWanted))
    history.replaceState(null, '', u.toString())
    if (site) void loadSite(site.manifest.slug)
  },
  onWeather: (w) => setWeatherSelection(w),
  onLayers: () => applyLayers(),
  onDrive: () => setDrive(!drive.on),
  onPhoto: () => toPhoto(),
  onTop: () => toTop(),
  onStance: () => void copyStance(),
  onTune: () => tuneUI.toggle(),
  onGoto: (h) => gotoHit(h),
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
let parkour: Parkour | null = null
const wantGame = new URLSearchParams(location.search).get('game')

function resize() {
  const w = innerWidth, h = innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
// the last quarter-second is worth keeping too: a reload can land between ticks
addEventListener('pagehide', saveResume)
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveResume() })
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
  // terrain exaggeration is decided BEFORE anything decodes: the URL, else the stance, else the
  // world's own look (tuning.json, written by the world editor). It is a load-time transform on
  // every absolute height (relief.ts), so changing it reloads the site.
  {
    const q = new URLSearchParams(location.search)
    const fromUrl = q.get('relief') != null ? Number(q.get('relief')) : NaN
    const fromStance = readStanceParam()?.relief
    const fromWorld = Number.isFinite(fromUrl) || fromStance != null ? undefined : (await loadSiteTuning(slug))?.look?.relief
    reliefWanted = clampRelief(Number.isFinite(fromUrl) ? fromUrl : fromStance ?? fromWorld ?? reliefWanted)
    setRelief(reliefWanted, spineDatum(manifest))
    reliefManifest(manifest)
    ui.setRelief(reliefWanted)
  }
  retro.clear() // the previous site's paint and signs are gone
  ui.setSearch(null) // the old site's index is meaningless now
  site = await buildSite(manifest, status, LITE, renderer, scene.fog as THREE.FogExp2, season, style)
  applySky(season)
  scene.add(site.group)
  // for probes and the console. `tune` is the same knob table the F6 panel drives, so a probe can
  // sweep a knob exactly as Rich would and see the same rebuild — the module's `export let`s
  // cannot be written from outside, and a dynamic import of tuning.ts under HMR is a dead copy.
  // The address index, from the site's own OSM extract. Built after the world is up rather than
  // before it, because it is a convenience and the world is not — and `force-cache` means the
  // file is usually already local, the minimap having asked for it first.
  const searchIndex = new SiteSearch()
  void searchIndex
    .load(manifest)
    .then(() => {
      ui.setSearch((q) => searchIndex.find(q), `${searchIndex.counts.address} addresses`)
    })
    .catch((e) => console.warn('address index:', e))
  ;(window as unknown as { corridor: unknown }).corridor = {
    site,
    scene,
    camera,
    // probes that need to read PIXELS must render and call gl.readPixels in the same turn: the
    // viewer's renderer has no preserveDrawingBuffer, so a drawImage a frame later reads a
    // cleared buffer and every measurement comes back black
    renderer,
    // the orbit controls re-derive the camera from their own target every frame, so a probe that
    // only writes camera.position gets dragged back; set orbit.target too, as applyStance does
    orbit,
    drive,
    /** the car itself, so a probe can check what the HUD claims against what the car is doing */
    get car() { return drive.car },
    /**
     * lon/lat to the site's PLAN coordinates (east, north metres about the frame anchor) — the
     * same projector the minimap draws with. World is (east, up, -north), so plan y is -worldZ.
     * Exposed because it is the only honest way for a probe to ask which way is north.
     */
    project: (lon: number, lat: number) => siteProjector(site!.manifest.frame as Parameters<typeof siteProjector>[0])(lon, lat),
    tuneDialog: tuneUI.dialog, // probes drive the panel's dock/float through this
    /** how far the minimap's photograph is from its linework, at the bake's own control points */
    minimapRegistration: () => minimap?.registration() ?? null,
    /** the address index, for probes: `search('1053 route 3')` */
    search: (q: string) => (searchIndex.ready ? searchIndex.find(q) : null),
    searchCounts: () => ({ ready: searchIndex.ready, ...searchIndex.counts }),
    /** the retroreflection rig: what the paint and the signs were told this frame */
    retro: () => ({
      ...retro.count,
      night: +retro.uniforms.uNight.value.toFixed(3),
      lampOn: +retro.uniforms.uLampOn.value.toFixed(3),
      lampPos: retro.uniforms.uLampPos.value.map((v) => [+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]),
      lampDir: retro.uniforms.uLampDir.value.map((v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]),
      range: retro.uniforms.uLampRange.value,
      cosOuter: +retro.uniforms.uCosOuter.value.toFixed(3),
    }),
    splats: () => splats.map((f) => f.counts()),
    /** show/hide the captured world WITHOUT a retune — a knob change re-seeds the grass and
     * re-picks the trees, so a probe comparing two frames would be measuring that instead */
    splatsVisible: (on: boolean) => { for (const f of splats) f.group.visible = on },
    splatWeight: (x: number, y: number, z?: number) => splats.reduce((w, f) => Math.max(w, f.weightAt(x, y, z)), 0),
    /**
     * The seam as the shaders see it: sample the coverage raster at a world point.
     *
     * Not `splatWeight`, which also asks whether the tile is resident — that is right for a point
     * query and wrong as a description of what is being drawn, because the raster is geometric
     * and does not move when a tile streams in or out.
     */
    splatSeamAt: (x: number, z: number) => {
      const t = splatMask.uSplatMap.value as THREE.DataTexture | null
      if (!t || !splatCover) return 0
      const b = splatMask.uSplatBox.value
      const u = (x - b.x) / Math.max(1e-3, b.z - b.x)
      const v = (z - b.y) / Math.max(1e-3, b.w - b.y)
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0
      const i = Math.min(splatCover.w - 1, Math.max(0, Math.floor(u * splatCover.w)))
      const j = Math.min(splatCover.h - 1, Math.max(0, Math.floor(v * splatCover.h)))
      return (t.image.data as Uint8Array)[j * splatCover.w + i] / 255
    },
    /** set the seam's strength directly, with no retune — see `splatFadeOverride` */
    splatFade: (v: number | null) => {
      splatFadeOverride = v
    },
    /** the rasterised seam: its size and how much of the site a capture covers */
    splatCover: () => (splatCover ? { ...splatCover, cellM: T.SPLAT_MASK_CELL_M, fade: splatMask.uSplatFade.value } : null),
    /** what the canopy overhead is doing to the ambient light, and the numbers behind it */
    light: () => ({ canopyShade: +canopyShade.toFixed(3), baseAmbient: +baseAmbient.toFixed(3), baseEnv: +baseEnv.toFixed(3), foliage: +foliageFraction().toFixed(2), ambient: +ambient.intensity.toFixed(3), env: +scene.environmentIntensity.toFixed(3) }),
    THREE, // probes need Raycaster/Vector3 in the page, and there is no other handle on it
    // the world's clock: probes and the console drive time of day through this
    time: {
      get ms() { return worldClock.ms },
      set ms(v: number) { worldClock.ms = v; applySky(season) },
      home: () => { worldClock.home(); applySky(season) },
      parts: (tz = Intl.DateTimeFormat().resolvedOptions().timeZone) => worldClock.parts(tz),
      setLocal: (date?: string, time?: string, tz = Intl.DateTimeFormat().resolvedOptions().timeZone) => {
        worldClock.setLocal(tz, date, time)
        applySky(season)
      },
      sun: () => sunNow(),
    },

    tune: {
      tabs: TUNE_TABS,
      names: () => TUNE_TABS.flatMap((t) => t.sections.flatMap((sec) => sec.keys.map((k) => k.name))),
      get: (name: string) => tuneKey(name)?.get(),
      set: (name: string, v: number) => {
        // through the PANEL's own setter, so the slider, its readout, the off-neutral mark and the
        // section's changed dot all follow — a knob set from a probe or from a site's tuning.json
        // has to look exactly like one that was dragged
        if (!tuneUI.access.set(name, v)) return false
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
  endParkour()
  if (wantGame === 'squishy') startSquishy()
  if (wantGame === 'parkour') startParkour()
  // the captured world, if this site has one attached (or ?splats=<world> named one). It is a
  // skin over the bake, never the ground: see docs/corridor/PLAN-SPLAT-CORRIDORS.md.
  for (const f of splats) f.dispose()
  splats = []
  {
    const anchor = manifest.frame?.anchor
    if (anchor) {
      for (const att of await attachmentsFor(slug)) {
        const f = await SplatField.attach(att, anchor, renderer)
        if (!f) continue
        scene.add(f.group)
        splats.push(f)
        toast(`splats: ${att.id} attached`, 'ok', 2500)
      }
    }
    /*
     * THE SEAM. Rasterise every attached capture's envelope into one coverage texture in site
     * metres, and hand it to the built world so it can get out of the way.
     *
     * Once, here, rather than per frame: `weightAt` walks every segment of every capture pass --
     * 7,703 of them on arrowhead-2026-09 -- which is fine a few times and impossible per fragment.
     * The raster IS `weightAt`, sampled on a lattice, so what the shaders draw and what a probe
     * measures cannot drift apart.
     */
    splatCover = null
    if (splats.length && site) {
      const b = manifest.bbox // site metres, (east, north)
      const box = { x0: b[0], z0: -b[3], x1: b[2], z1: -b[1] }
      const env = splats.map((f) => f.envelope())
      const r = rasteriseEnvelope(
        box,
        Math.max(1, T.SPLAT_MASK_CELL_M),
        env.flatMap((e) => e.passes),
        Math.max(...env.map((e) => e.core)),
        Math.max(...env.map((e) => e.fade)),
      )
      // the NUMBERS only: `r` carries the DataTexture, and a probe that prints this should not
      // get six megabytes of pixel data back
      splatCover = { w: r.w, h: r.h, covered: r.covered, segments: r.segments }
      splatMask.uSplatMap.value = r.tex
      splatMask.uSplatBox.value.copy(r.box)
      const pct = (100 * r.covered) / (r.w * r.h)
      console.log(`splats: seam ${r.w}x${r.h} at ${T.SPLAT_MASK_CELL_M} m from ${r.segments} pass segments, ${pct.toFixed(1)}% of the site inside a capture envelope`)
      site.setSplatMask(splatMask)
    }
  }
  attribution.set(manifest)
  minimap = new MiniMap(document.body, manifest)
  const st = readStanceParam()
  const resume = st && st.site === slug ? null : readResume(slug)
  if (st && st.site === slug) applyStance(st)
  else if (resume) applyStance(resume)
  else toPhoto()
  // per-site knob overrides, applied AFTER the panels have restored the browser's values so the
  // committed file wins, and undoing whatever the previous site's file had set
  const tuned = await applySiteTuning(slug, siteTuneAccess)
  // the world's own look (tuning.json `look`, written by the world editor): the URL's ?style and
  // ?season win, so a shared link keeps saying what it said
  const urlQ = new URLSearchParams(location.search)
  if (tuned.look?.style && !urlQ.get('style') && isStyle(tuned.look.style) && tuned.look.style !== style) setStyle(tuned.look.style)
  if (tuned.look?.season && !urlQ.get('season') && SEASONS.includes(tuned.look.season as Season) && tuned.look.season !== season) setSeason(tuned.look.season as Season)
  if (tuned.applied || tuned.unknown.length || tuned.kept.length) {
    onTuneChange()
    toast(`${slug}: ${tuned.applied} site knobs applied${tuned.kept.length ? `, ${tuned.kept.length} left as you set them (${tuned.kept.slice(0, 3).join(', ')})` : ''}${tuned.unknown.length ? `, ${tuned.unknown.length} unknown (${tuned.unknown.slice(0, 3).join(', ')})` : ''}`, 'ok', 4000)
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
/** Parkour on this site: the runner takes the camera; P again ends it. */
function startParkour() {
  if (!site || !fly) return
  game?.dispose()
  game = null
  setDrive(false)
  fly.setWalk(false)
  fly.enabled = false
  orbit.enabled = true
  parkour = new Parkour(site, camera, orbit, canvas, document.body)
  ;(window as unknown as { __parkour: Parkour }).__parkour = parkour // probes drive the tick directly
  toast('Parkour: W/A/S/D run, Space jumps, A/D spin in the air, Space again to roll it out. F draws the bow.', 'info', 7000)
}
function endParkour() {
  if (!parkour) return
  parkour.dispose()
  parkour = null
  if (fly) fly.enabled = !drive.on
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
    drive.car.setCockpit(drive.cockpit)
  }
  // leaving the seat: the body shell comes back, or the car is a dashboard floating in a field
  if (!on) drive.car?.setCockpit(false)
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
/** terrain exaggeration for the next load; 1 is the world as measured (see relief.ts) */
let reliefWanted = 1
/**
 * Sky, fog and LIGHT for the season, then the weather pulled over the top of it. Both in one place
 * because weather is a modifier on a season and not a state of its own: snow under a winter sun is
 * a different scene from snow under a summer one.
 */
/**
 * THE WORLD'S CLOCK. It starts at the real now and keeps up with it (sun.ts WorldClock), so a
 * session opens at today's light without anyone choosing anything; the date and time controls move
 * an OFFSET from real time rather than an absolute instant, which is what lets a world left paused
 * yesterday still open on today. TIME_RATE is how fast it runs.
 */
const worldClock = new WorldClock()
/** where the sun is for this site, right now on the world's clock */
function sunNow(): { el: number; az: number; dir: THREE.Vector3; moon: THREE.Vector3; phase: number } {
  const a = site?.manifest.frame?.anchor
  const lat = a?.lat ?? 39, lon = a?.lon ?? -76.7
  const s = sunPosition(worldClock.ms, lat, lon)
  const v = sunVector(s.elevation, s.azimuth, T.SUN_ARC)
  // The moon, cheaply: it runs the same arc about 50 minutes later each day, and its phase is the
  // synodic month since a known new moon (2026-01-18 19:52 UTC). This is not an ephemeris — it is
  // a light in the sky that is in roughly the right place at roughly the right brightness, which
  // is all a night drive needs. A real one is Meeus chapter 47 if it ever matters.
  const SYNODIC = 29.530588853 * 86400000
  const phase = (((worldClock.ms - Date.parse('2026-01-18T19:52:00Z')) % SYNODIC) + SYNODIC) % SYNODIC / SYNODIC
  const m = sunPosition(worldClock.ms - phase * SYNODIC + SYNODIC / 2, lat, lon)
  const mv = sunVector(m.elevation, m.azimuth, T.SUN_ARC)
  return {
    el: s.elevation,
    az: s.azimuth,
    dir: new THREE.Vector3(v.x, v.y, v.z),
    moon: new THREE.Vector3(mv.x, mv.y, mv.z),
    phase: 1 - Math.abs(phase * 2 - 1), // 0 new, 1 full
  }
}

/**
 * THE SKY IS THE LIGHT. A hemisphere light is two colours and a constant, which is why a night
 * road still read as pitch black however far the ambient was turned up: nothing in the scene knew
 * what the sky above it actually looked like (Rich, 2026-09-26 — "we need ambient light, probably
 * sampled from what is going on in the sky").
 *
 * So the dome is rendered into a small environment map and handed to the scene: every physical
 * material then picks up the real sky — blue overhead at noon, orange along one side at sunset,
 * deep blue with a moon at night. It is the same shader the dome draws, so the light and the sky
 * can never disagree, and it costs one 128 px cube render each time the light changes materially.
 */
/**
 * WHAT THE CANOPY TAKES OUT OF THE SKY.
 *
 * Ambient light IS sky light, so standing under a closed canopy there is simply less of it — and
 * how much less depends on the season and on what the trees are (Rich, 2026-09-26: "heavy canopy
 * in summer would be much darker than a field in winter … would need to take into account if the
 * trees are evergreens or deciduous"). Every piece of that is already measured and in the viewer:
 *
 *   how much canopy   the bake's CHM, sampled around the eye (2 m from the tiles where resident)
 *   leaf or no leaf   the season palette's own per-leaf-kind DENSITY — winter oak is 0.08, ash 0
 *   which trees       the species palette this site built, each archetype flagged evergreen
 *
 * So the transmittance under a wood is 1 − cover · foliage · CANOPY_SHADE, where `foliage` is the
 * site's own mix of evergreen (always 1) and deciduous (the season's density). A pine wood in
 * February is as dark as it is in July; an oak wood is not. It is smoothed over a few tenths of a
 * second because driving out of a wood should be a change in the light, not a step.
 */
let baseAmbient = 1
let baseEnv = 1
let canopyShade = 1
function foliageFraction(): number {
  const lk = LOOK[season].leaves
  const pal = site?.treePalette() ?? []
  if (!pal.length) return (lk.oak.density + lk.ash.density) / 2
  let sum = 0
  for (const a of pal) sum += a.evergreen ? 1 : (lk[a.leaf as keyof typeof lk]?.density ?? 1)
  return sum / pal.length
}
/** 0 = pitch under the trees, 1 = open sky, sampled in a small kernel around the eye */
function canopyTransmittance(eye: THREE.Vector3): number {
  if (!site || !(T.CANOPY_SHADE > 0)) return 1
  // WHAT YOU ARE SAMPLING IS THE SKY YOU CAN SEE, NOT THE TREE YOU ARE UNDER. So the kernel is
  // the hemisphere's worth of ground around the eye — two rings out to 10 m — rather than a few
  // metres: a 2 m CHM has real gaps between crowns, and standing in one of them under a wood does
  // not put you in a field, because the crowns either side still close over you.
  let cover = 0, n = 0
  for (const r of [0, 5, 10]) {
    const steps = r === 0 ? 1 : 6
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const h = site.canopyAt(eye.x + Math.cos(a) * r, -(eye.z + Math.sin(a) * r))
      cover += h > 2 ? Math.min(1, (h - 2) / 6) : 0   // an 8 m crown is already a closed roof
      n++
    }
  }
  return 1 - (cover / n) * foliageFraction() * T.CANOPY_SHADE
}
function applyCanopyShade(immediate = false) {
  const g = Math.max(0.05, T.AMBIENT_GAIN)
  if (immediate) {
    ambient.intensity = baseAmbient * canopyShade * g
    scene.environmentIntensity = baseEnv * canopyShade * g
    return
  }
  ambient.intensity = baseAmbient * canopyShade * g
  scene.environmentIntensity = baseEnv * canopyShade * g
}

const pmrem = new THREE.PMREMGenerator(renderer)
const skyScene = new THREE.Scene()
let envRT: THREE.WebGLRenderTarget | null = null
function skyEnvironment() {
  // the dome lives in the main scene; borrow it for the capture and put it straight back
  const parent = skyDome.mesh.parent
  skyScene.add(skyDome.mesh)
  const next = pmrem.fromScene(skyScene, 0, 0.1, 100)
  if (parent) parent.add(skyDome.mesh)
  envRT?.dispose()
  envRT = next
  scene.environment = next.texture
}

function applySky(s: Season) {
  const look = styled(LOOK[s], style)
  const def = STYLE[style]
  const w = WEATHER[weatherNow()]
  const sunAt = sunNow()
  // day 1 → night 0, across civil twilight: the light changes fastest right at the horizon, which
  // is why the band is −6° to +4° and not something symmetric and tidy
  const day = THREE.MathUtils.smoothstep(sunAt.el, -6, 4)
  const night = 1 - day
  // the golden hour is a fact about elevation, not a time: low sun, long air, red light
  // SUNSET_BOLD is a postcard knob: 1 is what the air really does, higher widens the band the low
  // sun paints in and deepens it
  const golden = Math.max(0, 1 - Math.abs(sunAt.el - 4) / (10 * Math.max(0.3, T.SUNSET_BOLD))) * day * Math.min(1.6, T.SUNSET_BOLD)
  // the season's daylight palette, then dusk pulled over it and night under that
  // These mixes happen in the renderer's LINEAR working space (three converts on setHex), so a
  // mix of 0.92 toward a dark blue still reads as a mid slate once it is written back out to
  // sRGB. The numbers are chosen against what the screen shows, not against the arithmetic.
  const NIGHT_SKY = new THREE.Color(0x05080f)
  const DUSK = new THREE.Color(0xe8a765)
  const sky = look.sky.clone().lerp(w.skyTint, w.skyMix).lerp(DUSK, Math.min(0.9, golden * 0.45 * T.SUNSET_BOLD)).lerp(NIGHT_SKY, night * 0.985)
  ;(scene.background as THREE.Color).copy(sky)
  ;(scene.fog as THREE.FogExp2).color.copy(sky)
  ;(scene.fog as THREE.FogExp2).density = look.fog * w.fogScale
  // the dome reads the same two inputs: the season's blue overhead, the fog colour at the horizon,
  // the weather's cover — a clear day is a third cumulus, an overcast one (skyMix ~0.9) is shut
  // the sun is a direction now, not a fixed corner of the sky; the light is 3 km out along it so
  // shadows and specular agree with the disc the dome draws
  sun.position.copy(sunAt.dir).multiplyScalar(5000)
  skyDome.set({
    zenith: (def.sky ? def.sky.zenith.clone() : look.sky.clone().lerp(new THREE.Color(0x4f86d2), 0.55)).lerp(w.skyTint, w.skyMix).lerp(NIGHT_SKY, night * 0.99),
    horizon: sky,
    cover: Math.min(1, 0.3 + (def.sky?.cloudBias ?? 0) + 0.7 * w.skyMix),
    haze: Math.min(1, 0.35 + w.skyMix * 0.6),
    sunDir: sunAt.dir,
    sunColour: look.sun.colour.clone().lerp(new THREE.Color(0xff6b2a), Math.min(0.95, golden * 0.8 * T.SUNSET_BOLD)),
    night,
    stars: T.SKY_STARS,
    cirrus: T.SKY_CIRRUS * (1 - w.skyMix * 0.6),
    moonDir: sunAt.moon,
    moonPhase: sunAt.phase,
  })
  // the sun's own colour reddens as it drops, and it hands over to the moon below the horizon
  const moonUp = THREE.MathUtils.smoothstep(sunAt.moon.y, -0.05, 0.25)
  sun.color.copy(look.sun.colour).lerp(new THREE.Color(0xff8a3d), Math.min(0.95, golden * 0.85 * T.SUNSET_BOLD)).lerp(new THREE.Color(0x9fb4de), night)
  // overcast: the sun goes down and the sky comes up, which is what a grey day actually is
  const moonlight = T.MOON_LIGHT * sunAt.phase * moonUp
  sun.intensity = look.sun.intensity * (1 - 0.72 * w.skyMix) * (day + night * moonlight)
  // at night the light comes from the whole sky, not from a lamp: the ambient carries it, cold and
  // dim, and the ground bounce all but disappears
  // A NIGHT YOU CAN SEE. There is no such thing as a black night outdoors — there is airglow, the
  // moon, and in a neighbourhood a sky full of other people's lights. At 0.10 the road went
  // genuinely pitch black (Rich, 2026-09-26); NIGHT_AMBIENT is the floor, and the moon adds to it.
  ambient.color.copy(look.ambient.sky).lerp(new THREE.Color(0x3d4f76), night)
  ambient.groundColor.copy(look.ambient.ground).lerp(new THREE.Color(0x141b2b), night)
  ambient.intensity = look.ambient.intensity * (1 + 0.5 * w.skyMix) * (day + night * (T.NIGHT_AMBIENT + 1.2 * moonlight))
  // and the image-based half: the sky itself, as an environment map. Its intensity carries the
  // night floor, so what lights the car at midnight is a dark blue sky with a moon in it rather
  // than a grey constant.
  // the shaders that light themselves — grass, tree impostors — take the same day/night level as
  // everything else, or they glow in the dark
  site?.setLight(
    Math.max(0.03, day + night * (T.NIGHT_AMBIENT * 1.1 + 1.6 * moonlight)) * Math.max(0.05, T.AMBIENT_GAIN),
    new THREE.Color(1, 1, 1).lerp(new THREE.Color(0x7f93c4), night * 0.85),
  )
  baseAmbient = ambient.intensity
  baseEnv = T.SKY_LIGHT * (day + night * (T.NIGHT_AMBIENT * 1.2 + 1.5 * moonlight))
  applyCanopyShade(true)
  skyEnvironment()
  // headlights follow the night, not the clock: they come on as the sun goes and off as it returns
  drive.car?.setLights(night * (drive.on ? 1 : 0.6))
  // and the retroreflectors take the same day/night level as the grass and the impostors, so the
  // paint and the signs go dark with everything else and come back only in the beam (retro.ts)
  retro.setLight(
    Math.max(0.02, day + night * (T.NIGHT_AMBIENT * 1.1 + 1.6 * moonlight)) * Math.max(0.05, T.AMBIENT_GAIN),
    new THREE.Color(1, 1, 1).lerp(new THREE.Color(0x7f93c4), night * 0.85),
  )
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
  /** terrain exaggeration the frame was made with; absent means 1 */
  relief?: number
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
  if (relief().k !== 1) st.relief = relief().k
  const r3 = (v: THREE.Vector3) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]
  if (drive.on && drive.car) st.car = { p: r3(drive.car.pos), yaw: +drive.car.yaw.toFixed(4), speed: +drive.car.speed.toFixed(2), look: [+drive.yaw.toFixed(3), +drive.pitch.toFixed(3)] }
  else st.cam = { p: r3(camera.position), t: r3(orbit.target) }
  return st
}
/**
 * WHERE YOU WERE, KEPT ACROSS A RELOAD.
 *
 * A stance is already everything needed to reproduce a frame, so parking one in localStorage a
 * couple of times a second is all "don't dump me back at the start" takes — and an HMR reload
 * while driving (which is every edit I make while Rich is in the car) lands back on the same
 * stretch of road at the same speed instead of at the photo point. Per site, so switching sites
 * returns to where you last were in THAT one.
 *
 * Order of authority on load: `?stance=` in the URL (a shared link must mean what it says), then
 * the saved stance, then the photo point. `?fresh` skips the saved one.
 */
const RESUME_KEY = 'apex-corridor-resume'
const RESUME_MS = 400
let resumeAt = 0
function saveResume() {
  const st = captureStance()
  if (!st) return
  try {
    const all = JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as Record<string, Stance & { t?: number }>
    all[st.site] = { ...st, t: Date.now() }
    localStorage.setItem(RESUME_KEY, JSON.stringify(all))
  } catch { /* private window, or the quota is full: losing the resume point is not worth a throw */ }
}
function readResume(slug: string): Stance | null {
  if (new URLSearchParams(location.search).has('fresh')) return null
  try {
    const all = JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as Record<string, Stance>
    const st = all[slug]
    return st && st.v === 1 && st.site === slug ? st : null
  } catch {
    return null
  }
}
function stanceUrl(st: Stance): string {
  const u = new URL(location.href)
  u.searchParams.set('stance', btoa(JSON.stringify(st)))
  u.searchParams.set('season', st.season)
  if (st.style && st.style !== 'realistic') u.searchParams.set('style', st.style)
  else u.searchParams.delete('style')
  if (st.relief && st.relief !== 1) u.searchParams.set('relief', String(st.relief))
  else u.searchParams.delete('relief')
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
    toast(`saved ${r.count} knobs to tools/corridor/data/sites/${site.manifest.slug}/tuning.json (${r.bytes} bytes)`, 'ok', 6000)
  } catch (e) {
    toast(`site tuning: ${(e as Error).message}`, 'danger')
  }
}

async function doClearSiteTuning() {
  if (!site) return
  const slug = site.manifest.slug
  try {
    const r = await clearSiteTuning(slug, siteTuneAccess)
    onTuneChange()
    toast(r.cleared ? `cleared ${r.cleared} knobs from ${slug}/tuning.json; ${r.restored} put back` : `${slug}/tuning.json was already empty`, r.cleared ? 'ok' : 'info', 6000)
  } catch (e) {
    toast(`clearing ${slug}/tuning.json: ${(e as Error).message}`, 'danger')
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
    case 'KeyC': if (drive.on) { drive.cockpit = !drive.cockpit; drive.car?.setCockpit(drive.cockpit); break } void copyStance(); break
    case 'KeyX': void copyStance(); break
    case 'KeyM': setChromeHidden(!document.body.classList.contains('chrome-off')); break
    case 'KeyN': minimap?.setExpanded(!minimap.expanded); break
    case 'KeyB': if (!drive.on && fly) setWalk(!fly.walk); break
    case 'KeyG': if (game) { game.dispose(); game = null; toast('hunt over', 'info', 1200) } else startSquishy(); break
    case 'KeyP': if (parkour) { endParkour(); toast('parkour over', 'info', 1200) } else startParkour(); break
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
  const wasDrag = Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 6
  dragging = false
  if (performance.now() - downAt >= 250 || wasDrag || !site) return
  // in the air, a left click is "drive here"; a click on a structure still reads it out
  if (!drive.on && e.button === 0 && !pick(e)) driveHere(e)
  else pick(e)
})
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !drive.on) return
  drive.yaw -= (e.clientX - lastX) * 0.004
  drive.pitch = Math.max(-0.8, Math.min(0.8, drive.pitch - (e.clientY - lastY) * 0.003))
  lastX = e.clientX; lastY = e.clientY
})
const ray = new THREE.Raycaster()
/**
 * DRIVE HERE. A left click in fly mode puts the car where you pointed (Rich, 2026-09-26): ray the
 * ground, drop the car there, and take the seat. If the point is beside a road the car is snapped
 * into the near lane facing along it — clicking a street should put you ON the street, pointing
 * the way it goes, not askew in a verge — and anywhere else it simply lands facing away from the
 * camera, which is where you were looking.
 */
function driveHere(e: PointerEvent): boolean {
  if (!site) return false
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera)
  const ground = [site.terrain, ...site.layers.road.children, ...(site.layers.imagery ? [site.layers.imagery] : [])]
  let hit = ray.intersectObjects(ground, true)[0]?.point ?? null
  if (!hit) {
    // nothing under the cursor (the sky, or a gap between meshes): fall back to where the ray
    // crosses the ground's own height, walked forward until it is under the terrain
    const o = ray.ray.origin, d = ray.ray.direction
    for (let s = 5; s < 4000; s += 5) {
      const p = o.clone().addScaledVector(d, s)
      const g = site.groundAt(p.x, p.z)
      if (g !== null && p.y <= g) { hit = p.setY(g); break }
    }
  }
  if (!hit) return false
  const edge = site.edgeInfo(hit.x, hit.z)
  let x = hit.x, z = hit.z
  let yaw = Math.atan2(camera.getWorldDirection(viewDir).x, camera.getWorldDirection(viewDir).z)
  if (Number.isFinite(edge.d) && edge.d < 30 && edge.who >= 0) {
    // the gradient points away from the road, so stepping back along it lands on the pavement; the
    // road's own direction is across that
    const back = Math.min(edge.d + 1.8, 30)
    x = hit.x - edge.gx * back
    z = hit.z - edge.gz * back
    // the road runs at right angles to the gradient: forward = (-gz, gx), and a yaw is
    // atan2(forward.z, forward.x) because the car's forward is (cos yaw, 0, sin yaw)
    const along = Math.atan2(edge.gx, -edge.gz)
    // keep whichever way down the road is closer to where the camera was looking
    const camYaw = Math.atan2(camera.getWorldDirection(viewDir).x, camera.getWorldDirection(viewDir).z)
    const d1 = Math.abs(((along - camYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    yaw = d1 < Math.PI / 2 ? along : along + Math.PI
  }
  if (!drive.on) setDrive(true)
  drive.car?.place(x, z, yaw)
  drive.yaw = 0
  drive.pitch = 0
  status(edge.d < 30 ? 'drive here — on the road' : 'drive here')
  return true
}
/**
 * Go to a search result.
 *
 * Rich, 2026-09-26: "picking the address flies you to it." Which is what happens on foot or in
 * the air. Driving, flying the camera away from the car would be a worse answer than moving the
 * car, so the car goes instead — and it goes to the nearest ROAD, using the same gradient step as
 * `driveHere`, because a house's centroid is the middle of a building and nobody parks there.
 */
function gotoHit(h: { label: string; x: number; z: number; kind: string }) {
  if (!site) return
  const g = site.groundAt(h.x, h.z) ?? 0
  if (drive.on && drive.car) {
    const edge = site.edgeInfo(h.x, h.z)
    let x = h.x
    let z = h.z
    let yaw = drive.car.yaw
    if (Number.isFinite(edge.d) && edge.who >= 0) {
      // step back along the gradient onto the pavement; the road runs across it
      const back = Math.min(edge.d + 1.8, 60)
      x = h.x - edge.gx * back
      z = h.z - edge.gz * back
      yaw = Math.atan2(edge.gx, -edge.gz)
    }
    drive.car.place(x, z, yaw)
    drive.yaw = 0
    drive.pitch = 0
    toast(`${h.label} — on the road`, 'ok', 2200)
    return
  }
  // in the air: stand off and look down at it, far enough to see the thing and its surroundings
  const back = h.kind === 'road' ? 220 : 90
  const up = h.kind === 'road' ? 140 : 55
  camera.position.set(h.x - back * 0.55, g + up, h.z + back * 0.83)
  orbit.target.set(h.x, g + 2, h.z)
  orbit.update()
  toast(h.label, 'ok', 2200)
}

function pick(e: PointerEvent): boolean {
  if (!site) return false
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera)
  const hit = ray.intersectObjects([...site.layers.structures.children, ...site.layers.markers.children], true)[0]
  if (!hit) return false
  const st = hit.object.userData.structure as Structure | undefined
  const c = hit.object.userData.crossing as Crossing | undefined
  if (st) status(describe(st))
  else if (c) status(`${c.kind ?? 'way'} ${c.name ?? ''} crosses ${c.relation} us at ${c.s.toFixed(0)} m${c.inferred ? ' (inferred from OSM)' : ''}`)
  else return false
  return true
}

// ---------------------------------------------------------------------------------------------
// frame loop
const clock = new THREE.Clock()
const up = new THREE.Vector3(0, 1, 0)
const viewDir = new THREE.Vector3()
/** the simulated instant the sky was last built for; 20 s of world time is well under a degree of sun */
let lastSkyMs = -1e15
function frame() {
  const real = clock.getDelta()
  const dt = Math.min(0.1, real)
  // the world's clock, and the light that follows from it. applySky is cheap (no geometry), so it
  // runs whenever the sun has moved enough to see — a degree of elevation is about four minutes of
  // a real day, and far less than that at a high TIME_RATE.
  worldClock.rate = T.TIME_RATE
  worldClock.tick(real) // real time, not the capped physics step: the sun does not care about hitches
  if (Math.abs(worldClock.ms - lastSkyMs) > 20000) {
    lastSkyMs = worldClock.ms
    applySky(season)
  }
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
      // cockpit: eye at the driver's head, looking down the nose (stuntin's C view); drive.yaw/pitch look around.
      // NO EARLY RETURN HERE. It used to `return` out of frame(), which skipped everything below —
      // site.updateNear (the grass, the trees, the tile stream and the grading pump all take the
      // eye from it) and the minimap. Pressing C stopped the world (Rich, 2026-09-26): the frames
      // kept coming, but nothing was ever told where the camera had got to.
      const eye = car.pos.clone().add(new THREE.Vector3(0, T.COCKPIT_EYE_UP, 0)).add(car.forward.clone().multiplyScalar(T.COCKPIT_EYE_FWD))
      camera.position.copy(eye)
      const ahead = car.forward.clone().applyAxisAngle(up, drive.yaw)
      camera.lookAt(eye.clone().add(ahead.multiplyScalar(30)).add(new THREE.Vector3(0, -Math.tan(drive.pitch) * 30 + T.COCKPIT_LOOK_UP, 0)))
    } else {
      const back = car.forward.clone().applyAxisAngle(up, drive.yaw).multiplyScalar(-T.CHASE_BACK)
      const want = car.pos.clone().add(back).add(new THREE.Vector3(0, T.CHASE_UP + Math.tan(drive.pitch) * 4, 0))
      const gy = site.groundAt(want.x, want.z)
      if (gy !== null && want.y < gy + 1.2) want.y = gy + 1.2
      camera.position.lerp(want, 1 - Math.exp(-T.CHASE_LAG * dt))
      camera.lookAt(car.pos.clone().add(car.forward.clone().multiplyScalar(T.CHASE_LOOK_AHEAD)).add(new THREE.Vector3(0, 1.0, 0)))
    }
    if (car.event === 'bump') status('bump')
    // what road is this? The name comes from the same station grid the car stands on, so the
    // readout and the physics can never disagree about which road you are on (Rich, 2026-09-26).
    const on = T.HUD_ROAD_NAME > 0 ? site.roadAt(car.pos.x, car.pos.z) : null
    const road = on ? (on.ref && on.name ? `${on.name} (${on.ref})` : on.name ?? on.ref ?? null) : null
    // Elevation and heading (Rich, 2026-09-27: "the ground elevation (e.g. 121 feet) and heading
    // (e.g. e/ne) at the current position of the car").
    //
    // The number is real rather than decorative: the corridor DEM is NAVD88 metres and the bake
    // anchors the frame at h = 0, so world Y IS height above the vertical datum. Feet, because
    // the line already reads in mph. It follows the GROUND under the car, not the car body, so
    // it does not jump when you land.
    //
    // Heading is a true bearing. World is (east, up, −north), so north is −z and the bearing is
    // atan2(east, north) — not atan2 of the raw x and z, which would read 90° out.
    let tele = ''
    if (T.HUD_TELEMETRY > 0) {
      const gy = site.groundAt(car.pos.x, car.pos.z)
      const ft = Math.round((gy ?? car.pos.y) * 3.28084)
      const brg = (Math.atan2(car.forward.x, -car.forward.z) * (180 / Math.PI) + 360) % 360
      const pt = COMPASS[Math.round(brg / 22.5) % 16]
      tele = ` · ${ft} ft · ${pt} ${brg.toFixed(0).padStart(3, '0')}°`
    }
    ui.setPos(`${(Math.abs(car.speed) * 2.237).toFixed(0)} mph · ${car.onGrass ? 'grass' : 'pavement'}${Math.abs(car.slide) > 1 ? ' · sliding' : ''}${road ? ` · ${road}` : ''}${tele}`)
  } else if (parkour) {
    parkour.tick(dt)
    ui.setPos(`${parkour.score} pts`)
  } else {
    fly?.update(dt)
    applyMove(dt)
    orbit.update()
    ui.setPos('')
  }
  if (site) {
    // the canopy overhead changes as you drive; the light under it follows, smoothed
    const eye = drive.on && drive.car ? drive.car.pos : camera.position
    const want = canopyTransmittance(eye)
    canopyShade += (want - canopyShade) * Math.min(1, dt * 3)
    applyCanopyShade()
  }
  if (site && clock.elapsedTime * 1000 - resumeAt > RESUME_MS) {
    resumeAt = clock.elapsedTime * 1000
    saveResume()
  }
  if (site) {
    const fwd = camera.getWorldDirection(viewDir)
    const pitch = Math.max(0, -Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1))) // 0 level, +down
    site.updateNear(camera.position, clock.elapsedTime, fwd, pitch)
    // splat tiles stream by locality like the imagery; site frame is x east, y north = -z
    for (const f of splats) f.update(camera.position.x, -camera.position.z)
    // the world looks wet while it is wet: the weather ramps it, the surfaces follow
    site.setWet(site.weather.wetness)
    // where the headlamps are pointing THIS frame, straight off the car's own spot lights, so the
    // retro cone and the visible beam cannot drift apart (retro.ts, car.lamps)
    // how hard the built world yields to a capture: 0 leaves it alone, 1 hands the ground over
    // ONLY where a seam was actually drawn. `splats.length` is not the test: a capture with no
    // usable corridor.json attaches fine and rasterises to nothing, and dissolving the built world
    // against an empty seam is how the site went dark (Rich, 2026-09-27).
    splatMask.uSplatFade.value = splatFadeOverride ?? (splatCover && splatCover.covered > 0 ? T.SPLAT_WORLD_FADE : 0)
    const lamps = drive.car?.lamps()
    retro.setLamps(lamps?.each ?? [], lamps?.on ?? 0)
    retro.tick()
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
  // the car itself, so a probe can check what the HUD says against what the car is doing
  get car() {
    return drive.car
  },
  /**
   * lon/lat to the site's PLAN coordinates (east, north metres about the frame anchor) — the
   * same projector the minimap draws with. World is (east, up, -north), so plan y is -worldZ.
   * Exposed because it is the only honest way for a probe to ask which way is north.
   */
  project: (lon: number, lat: number) => (site ? siteProjector(site.manifest.frame as Parameters<typeof siteProjector>[0])(lon, lat) : null),
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
