// corridor viewer: look at what tools/corridor baked, from above and from the driver's seat.
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildSite, describe, type Site } from './scene'
import { buildPhysics, type CorridorPhysics } from './physics'
import { fetchStuntDoc, makeStuntWorld, type StuntWorld } from './stuntworld'
import type { StuntDoc } from './stunts'
import { loadRaceWorld, type RaceWorld } from './raceworld'
import { PerfMeter } from './perf'
import { assistAt, lookAhead, pullFor } from './stuntassist'
import { PerfHud } from './ui/perfhud'
import { RapierCar } from './rapiercar'
import { assetsvc } from './assetsvc'
import { defaultVehicle, type VehicleDoc } from './vehicles'
import { loadCarModel, type CarModel } from './carmodel'
import { Car, type CarInput, type DrivableCar } from './car'
import { EngineSound, spawnPlayerEngine } from './enginesound'
import { ActorWorld } from './actorworld'
import { Transform } from './actors'
import { retro } from './retro'
import { SiteSearch } from './search'

/** 16-point compass, indexed by bearing/22.5 — N at 0, clockwise through E. */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
import { FlyControls } from './fly'
import { TransportControls } from './transportcam'
import { CRAFT, CRAFT_KINDS, type CraftKind } from './transport'
import { MiniMap, siteProjector } from './minimap'
import { Sky } from './sky'
import { Stars } from './stars'
import { MilkyWay } from './milkyway'
import { applyLevel, loadLevel, type LevelPlacement } from './level'
import { TrafficLayer, type TrafficSpec } from './trafficlayer'
import { GameRun, type ProgramHost } from './program'
import { loadGameModule } from './programload'
import { profile as driveProfile } from '@apex/engine/physics/profiles'
import { buildPlacements, loadCatalog } from './placements'
import { timeControls } from './ui/timecontrols'
import { celestialToWorld, julianDate, moonPosition, radecToVec } from './celestial'
import * as T from './tuning'
import { TUNE_TABS } from './tuning'
import { applySiteTuning, clearSiteTuning, saveSiteTuning } from './sitetuning'
import { Presets, resolve, worldKnobs } from './presets'
import { loadPresets, savePresets } from './presetstore'

import { fetchJSON, type IndexEntry, type Manifest, type Structure, type Crossing } from './site'
import { LOOK, SEASONS, type Season } from './season'
import { STYLE, styled, isStyle, type Style } from './style'
import { setRelief, relief, clampRelief, spineDatum, reliefManifest } from './relief'
import { WorldClock, sunPosition, sunVector } from './sun'
import { SplatField, attachmentsFor } from './splats'
import { antialiasFor, bootSlug, noteCaptureAttached, postAAFor } from './render'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { rasteriseEnvelope, splatMaskUniforms } from './splatmask'
import { Attribution } from './attribution'
import { loadSiteTuning } from './sitetuning'
import { WEATHER, WEATHERS, type Weather } from './weather'
import { ViewerUI, restoreTheme, perfWanted, setPerfWanted } from './ui/viewer'
import { TuneUI } from './ui/tune'
import { installShellKeys, toast, status, clearStatus } from './ui/shell'
import { downloadJSON, readJSONFile } from './ui/files'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

const canvas = $<HTMLCanvasElement>('#gl')
// MSAA is a CONTEXT attribute, so it is decided here and nowhere else: it cannot be
// toggled on a live renderer. See render.ts for why a capture makes it expensive and
// why turning it off makes the grass sparkle.
const antialias = antialiasFor(bootSlug())
const renderer = new THREE.WebGLRenderer({ canvas, antialias, logarithmicDepthBuffer: true })
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
/**
 * The physics world, when `PHYS_ENABLED` is on — null otherwise, and null is the honest answer
 * rather than a live-looking object that simulates nothing (see physics.ts).
 */
let physics: CorridorPhysics | null = null
/** this site's stunt fixtures, read before the physics so it knows whether it is needed */
let stuntDoc: StuntDoc | null = null
/** the world's loops and corkscrews, when it has any — for a probe and for a program */
let stuntWorld: StuntWorld | null = null
/** its circuits and stages, with the throbbers you drive into to start one */
let raceWorld: RaceWorld | null = null
/** the last race banner shown, so the same line is not re-posted every frame */
let lastRaceBanner: string | null = null
let minimap: MiniMap | null = null
/**
 * The real sky, once loaded: 9,096 catalogue stars as one Points object turned by one matrix.
 *
 * Null until the asset arrives, and null for ever if it does not — in which case the dome's own
 * procedural stars stay on, which is a night sky rather than a crash.
 */
let stars: Stars | null = null
/**
 * And the galaxy they sit in: the real isophotes, on the same sphere and turned by the same
 * matrix. Null when the asset is absent, which is a sky with stars and no band in it.
 */
let galaxy: MilkyWay | null = null
/** what `applySky` last worked out, so the per-frame star turn matches the dome exactly */
let skyNight = 0
let skyCover = 0
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

/**
 * THE WORLD'S CLOCK. It starts at the real now and keeps up with it (sun.ts WorldClock), so a
 * session opens at today's light without anyone choosing anything; the date and time controls move
 * an OFFSET from real time rather than an absolute instant, which is what lets a world left paused
 * yesterday still open on today. TIME_RATE is how fast it runs.
 */
const worldClock = new WorldClock()

// The interface. Built before anything else touches a tunable, because TuneUI's constructor
// restores this browser's saved knobs and everything downstream reads them as its starting value.
restoreTheme()
const tuneUI = new TuneUI({
  context: () => (captureStance() ?? {}) as Record<string, unknown>,
  onChange: () => onTuneChange(),
  onSaveSite: () => void doSaveSiteTuning(),
  onClearSite: () => void doClearSiteTuning(),
  presets: {
    presets: () => presets,
    slug: () => site?.manifest.slug ?? null,
    onChange: () => onTuneChange(),
    refresh: () => {}, // TuneUI supplies this: it owns the tab it has to rebuild
    save: async () => {
      const slug = site?.manifest.slug
      if (!slug || !presets) return
      try {
        const r = await savePresets(slug, presets.toDoc(slug))
        toast(`saved ${r.count} preset${r.count === 1 ? '' : 's'} to tools/corridor/data/sites/${slug}/presets.json (${r.bytes} bytes)`, 'ok', 6000)
      } catch (e) {
        toast(`presets: ${(e as Error).message}`, 'danger')
      }
    },
    exportDoc: () => {
      const slug = site?.manifest.slug
      if (!slug || !presets) return
      downloadJSON(`${slug}-presets.corridor.json`, presets.toDoc(slug))
    },
    importDoc: async () => {
      if (!presets) return
      const doc = await readJSONFile()
      if (!doc) return
      if (doc.kind !== 'corridor-presets') return toast(`that file is a "${String(doc.kind ?? 'unknown')}", not a presets library`, 'warn', 5000)
      // MERGED, not replaced: importing somebody's dusk into a world that already has a midwinter
      // should give you both. Same id replaces, which is how you take an updated one.
      const r = presets.load(doc as never, { merge: true })
      for (const d of r.dropped) toast(`presets: ${d}`, 'warn', 5000)
      toast(`imported ${r.loaded.length} preset${r.loaded.length === 1 ? '' : 's'} — press Save to keep them`, 'ok', 6000)
    },
  },
  extras: {
    // the clock is not a slider: a date and a time, running, that you can also set
    'time of day': () =>
      timeControls({
        read: () => {
          const p = worldClock.parts(siteZone())
          return { date: p.date, time: p.time, offsetMs: worldClock.offsetMs, rate: T.TIME_RATE }
        },
        setLocal: (date, time) => {
          worldClock.setLocal(siteZone(), date, time)
          applySky(season, false)
        },
        home: () => {
          worldClock.home()
          applySky(season, false)
        },
      }).el,
  },
})

/**
 * The zone the clock's date and time are read and written in.
 *
 * The SITE's, not the browser's. A world in Maryland shows Maryland's evening whoever is looking
 * at it — otherwise setting "19:00" from another continent puts the sun somewhere else, which is
 * exactly the trap a headless probe fell into earlier today when it asked for 22:00, got UTC, and
 * measured a sky with the sun ten degrees above the horizon.
 *
 * Longitude is the honest approximation: an IANA zone would need a lookup this app does not carry,
 * and the difference between solar time and civil time is under an hour almost everywhere.
 */
function siteZone(): string {
  const lon = site?.manifest.frame?.anchor?.lon
  if (lon === undefined) return Intl.DateTimeFormat().resolvedOptions().timeZone
  const off = Math.round(lon / 15)
  // Etc/GMT is signed the other way round from everything else, which is a real and famous trap
  return off === 0 ? 'Etc/GMT' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`
}
const ui = new ViewerUI({
  // Post-process AA can be rebuilt in place; MSAA is a context attribute and needs a
  // new context, so that one and only that one reloads.
  onAAChange: () => {
    const slug = site?.manifest.slug ?? bootSlug()
    if (antialiasFor(slug) !== renderer.getContext().getContextAttributes()?.antialias) {
      const u = new URL(location.href)
      u.searchParams.delete('aa')
      location.replace(u.toString())
      return
    }
    buildPostAA(postAAFor(slug))
  },
  onSite: (slug) => {
    location.hash = slug
    void loadSite(slug)
  },
  onSeason: (s) => setSeason(s),
  onStyle: (s) => setStyle(s),
  onTrees: (t) => {
    // two knobs, one choice: cards-only is TREE_SIMPLE, the editor's trees are TREE_LOLLIPOP
    tuneKey('TREE_SIMPLE')?.set(t === 'cards' ? 1 : 0)
    tuneKey('TREE_LOLLIPOP')?.set(t === 'lollipop' ? 1 : 0)
    onTuneChange()
  },
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
  // the performance panel, from Settings → Display. F7 does the same and remembers it too.
  onPerf: (on) => perfHud.show(on),
  onGoto: (h) => gotoHit(h),
  onStructure: (i) => site && goToStructure(site.manifest.structures[i]),
})
ui.describe = (s) => describe(s as Structure)
installShellKeys(() => ui.drawer)
let dragging = false, lastX = 0, lastY = 0, downAt = 0
// drive mode: a real car (stuntin dynamics) on the corridor strip, chase camera behind it
const drive = { on: false, cockpit: false, yaw: 0, pitch: 0, car: null as DrivableCar | null, input: { throttle: 0, brake: 0, steer: 0, handbrake: false } as CarInput, steerKey: 0 }

/*
 * THE ENGINE YOU CAN HEAR.
 *
 * `enginesound.ts` runs Ange Yaghi's combustion simulator in an audio worklet and reads the two
 * numbers that decide what an engine sounds like off an `Engine` component. Corridor's car has a
 * speed and no crankshaft, so a gearbox in the package turns one into the other.
 *
 * The world here is a real bitECS world with exactly one entity in it. That is not ceremony for its
 * own sake: it is the join the traffic model already wants, so a car the player takes over keeps
 * making the right noise without anything being rewritten, and a traffic car can be voiced by
 * writing the same two fields.
 */
const actors = new ActorWorld()
const engineSound = new EngineSound()
let playerEngine = 0
let fly: FlyControls | null = null

/**
 * The transport library: a helicopter, a plane, a jet, a UFO, a character in third person.
 *
 * Separate from `fly`, which is the free camera you look at a bake with and is not a vehicle. This
 * one is a craft with physics, and a program says which (`api.transport('helicopter')`). Null
 * until something asks for one — every session that never leaves the free camera pays nothing.
 */
let transport: TransportControls | null = null
let craft: CraftKind | null = null
/*
 * THE TWO BUILT-IN GAMES ARE GONE, and the hunt's bones are in `objectives.ts`.
 *
 * Rich, 2026-09-29: *"We should remove squishy hunt and parkour, they predate the game engine. Just
 * make sure some primitives for object hunting objectives with capture survive."* They did predate
 * it: each carried its own scoring, HUD, keys and idea of a level, none of which a program could
 * reach — three ways of saying the same thing and no way to author a fourth. What was worth keeping
 * — the spread across a town, the capture radius, the hints in words — is a module a program
 * imports, listed in the code editor as `@apex/objectives`.
 */

/*
 * THE PERFORMANCE PANEL. Rich, 2026-09-29: *"Can we add a setting to show a performance stats
 * display that includes FPS, memory, p95/p99 info, cpu time, etc.?"*
 *
 * The meter is cheap and always exists; the panel only samples while it is open, which is why the
 * frame loop asks `perfHud.open` before doing any of the work. A performance panel that costs a
 * frame is a performance panel that lies.
 */
/**
 * On a stunt fixture, the track decides which way is down.
 *
 * A ray-cast vehicle feels the road along its own down axis, so a level car cannot feel a loop that
 * has stood up in front of it — it drove straight through (Rich, 2026-09-29). Turn the body to face
 * the surface and the rays point into it, the suspension loads, and the wheels carry the car round.
 *
 * ONE FUNCTION, TWO CALLERS, and that is the point of it being one: the frame loop calls it, and so
 * does `apex.assist(dt)` on the bridge. A probe that steps the car itself — which is how every
 * driving measurement in this repo is made, because headless frames are far too slow — was
 * measuring a car with no assist at all and reporting that the assist did nothing.
 */
function holdToTrack(car: DrivableCar | null, dt: number): boolean {
  if (!car || !stuntWorld || !('hold' in car)) return false
  const at = { x: car.pos.x, y: -car.pos.z, z: car.pos.y }
  if (T.STUNT_ASSIST <= 0) return false
  const hit = stuntWorld.nearestPose(at)
  if (!hit) return false
  /*
   * AND WHERE THE CAR IS ABOUT TO BE — walked ALONG THE LANE, not searched for in space. A loop
   * passes over itself, so the nearest lane point to somewhere ten metres in front of you on the
   * run-in is the run-in, and an assist that samples space reads "flat" and holds the car flat into
   * the wall. Measured, with the car level and all four wheels down at the moment it stopped.
   */
  const f = car.forward
  const window = lookAhead(car.speed, { seconds: T.STUNT_AHEAD_S, min: 12, max: 90 })
  const up = stuntWorld.upAhead(hit, window, { x: f.x, y: -f.z })
  const reach = { hold_m: T.STUNT_HOLD_M, release_m: T.STUNT_RELEASE_M }
  const here = assistAt(hit, reach)
  if (!here) return false
  // site frame (z up) to three's (y up), the same conversion `upOf` does for a pose
  const a = { ...here, up: { x: up.x, y: up.z, z: -up.y } }
  // the pull is only wanted where gravity is not enough: none on the flat, all of it on a wall
  ;(car as RapierCar).hold(a.up, dt, {
    strength: a.strength,
    align: T.STUNT_ALIGN,
    pull: pullFor(a.up, T.STUNT_PULL),
  })
  return true
}

const perfMeter = new PerfMeter()
const perfHud = new PerfHud(perfMeter)
// left on last time? then it comes back on, which is the whole point of remembering it
if (perfWanted()) perfHud.show(true)

/**
 * Post-process anti-aliasing, built only if a mode asks for it.
 *
 * The chain is RenderPass -> the AA pass -> OutputPass, and the ORDER is the
 * whole trick. EffectComposer renders into a linear half-float target, and
 * OutputPass is what converts that to sRGB for the screen -- so it has to be
 * LAST. Putting it earlier (which reads more naturally: "convert, then filter
 * what the viewer sees") makes the final pass convert an already-converted
 * frame, and the picture comes out uniformly brighter. Measured when this was
 * wrong: mean RGB 113.4/116.6/82.4 against 105.4/108.9/74.6 for the same view,
 * +8 on every channel.
 */
let composer: EffectComposer | null = null
function buildPostAA(mode: 'fxaa' | 'smaa' | null) {
  composer?.dispose()
  composer = null
  if (!mode) return
  const c = new EffectComposer(renderer)
  c.addPass(new RenderPass(scene, camera))
  c.addPass(mode === 'smaa' ? new SMAAPass() : new FXAAPass())
  c.addPass(new OutputPass())
  c.setSize(innerWidth, innerHeight)
  c.setPixelRatio(renderer.getPixelRatio())
  composer = c
}

function resize() {
  const w = innerWidth, h = innerHeight
  renderer.setSize(w, h, false)
  composer?.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
// A way BACK from a hidden interface. `M` toggles it, but a hidden interface hides the
// thing that told you about `M`, so a keyboard-only escape is a trap for anyone who hid
// it by clicking. This is the only chrome that survives chrome-off, and it fades to
// almost nothing until you go near it.
const chromeBack = document.createElement('button')
chromeBack.id = 'chrome-restore'
chromeBack.type = 'button'
chromeBack.title = 'Show the interface (M)'
chromeBack.setAttribute('aria-label', 'Show the interface')
chromeBack.textContent = '\u2261'
chromeBack.onclick = () => document.body.classList.remove('chrome-off')
document.body.append(chromeBack)

addEventListener('resize', resize)
// the last quarter-second is worth keeping too: a reload can land between ticks
addEventListener('pagehide', saveResume)
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveResume() })

/*
 * GO QUIET WHEN NOBODY IS LOOKING (Rich, 2026-09-27: "it would be great if we muted the corridor
 * UI when the tab isn't active. We do that for the other games here").
 *
 * BOTH SIGNALS, because they mean different things and the other games only listen for one.
 * stuntin and coast use window blur/focus, which catches switching tabs and switching apps but
 * NOT a minimised window on every browser; `visibilitychange` catches the tab going to the
 * background but not another application taking the foreground. Corridor wants both: hidden OR
 * unfocused is "nobody is listening".
 *
 * `document.hasFocus()` rather than a flag we keep ourselves — a page loaded in a background tab
 * never fires `blur`, so a flag that starts false would be wrong from the first frame.
 */
const listening = () => document.visibilityState === 'visible' && document.hasFocus()
const syncAudible = () => engineSound.setMuted(!listening())
for (const ev of ['visibilitychange', 'blur', 'focus'] as const) {
  addEventListener(ev, syncAudible, ev === 'visibilitychange' ? undefined : true)
}
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
  // THE CAR GOES BEFORE THE WORLD IT IS IN. A `RapierCar` holds rigid bodies that belong to the
  // physics world, so freeing the world first and the car second hands wasm-freed handles to
  // `vehicle.free()` — the order here is the whole of what stops that.
  if (drive.car) {
    scene.remove(drive.car.mesh)
    ;(drive.car as { free?: () => void }).free?.()
    drive.car = null
  }
  // The physics world belongs to the SITE. A new site is a new world, not one carrying the old
  // world's heightfield tiles at the old site's origin — which would be ground in the right place
  // and the wrong bake.
  stopProgram()
  traffic?.dispose()
  traffic = null
  physics?.free()
  physics = null
  stuntDoc = null
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
  if (!stars) {
    stars = await Stars.load()
    if (stars) {
      scene.add(stars.points)
      console.log(`sky: ${stars.count} catalogue stars`)
    }
  }
  if (!galaxy) {
    galaxy = await MilkyWay.load()
    if (galaxy) scene.add(galaxy.mesh)
  }
  retro.clear() // the previous site's paint and signs are gone
  ui.setSearch(null) // the old site's index is meaningless now
  site = await buildSite(manifest, status, LITE, renderer, scene.fog as THREE.FogExp2, season, style)
  // Built AFTER the site and awaited, because it is bound to `site.groundAt` and because the first
  // thing it does is a 4.3 MB dynamic import. A failure here must not take the world with it: a
  // viewer with no physics is the viewer as it has always been, and a viewer that failed to load
  // is nothing at all.
  // `?phys=1` / `?phys=0` beats the knob, because the knob is read once and this is the only hook
  // that runs before that happens. Same shape as the `relief` block above.
  const physParam = new URLSearchParams(location.search).get('phys')
  /*
   * A WORLD WITH STUNTS TURNS THE PHYSICS ON BY ITSELF.
   *
   * Rich, 2026-09-29: *"stunts still not drivable"*. They were solid in a probe and scenery in the
   * game, and the reason is here: `PHYS_ENABLED` is 0, so there was no physics world, so a
   * fixture's trimesh had nowhere to go — and the hand-written car follows `groundAt`, which is one
   * height per column and cannot describe a loop at all.
   *
   * So the document decides. If somebody stood a loop up in this world, the world needs the
   * machinery that can hold one; if nobody did, nothing changes and the viewer is as it was.
   * `?phys=0` still wins, because an explicit flag must always beat an inference.
   */
  stuntDoc = await fetchStuntDoc(site.manifest.slug)
  const stuntsNeedPhysics = !!stuntDoc?.fixtures?.length
  /*
   * AND SO DOES A LEVEL WITH TRAFFIC IN IT. The level opens after the site is built, but whether
   * it wants traffic has to be known now — a traffic car is a kinematic body the player can hit,
   * and a jam you drive straight through is not a jam. So the level named in the URL is read
   * here, once, for that one fact; `openLevel` reads it again for everything else.
   */
  const levelId = new URLSearchParams(location.search).get('level')
  const early = levelId ? await loadLevel(levelId).catch(() => null) : null
  const trafficNeedsPhysics = !!early?.simulations?.some((x) => x.kind === 'traffic')
  physics = await buildPhysics(site, {
    enabled: physParam != null ? Number(physParam) > 0 : stuntsNeedPhysics || trafficNeedsPhysics || undefined,
  }).catch((e) => {
    console.warn('physics: not started —', e)
    return null
  })
  if (physics) status(`physics: ${physics.phys.hz} Hz`)
  applySky(season)
  scene.add(site.group)
  /*
   * STUNT FIXTURES: the tarmac you see AND the surface you drive on.
   *
   * After the physics, because a fixture's collider is a trimesh in that world — a heightfield
   * cannot hold a loop, since it is one height per column and a loop is above itself. After the
   * site, because the ribbon is stood on the ground and hooked to the road.
   *
   * A site with no `stunts.json` resolves to null and nothing else happens; that is most worlds.
   */
  /*
   * RACES. The throbber on the ground, the gates of whichever race you are in, and the clock.
   *
   * Loaded beside the stunts and for the same reasons: after the site, because the rings are laid
   * on the ground, and tolerant of a world that has none, which is most of them.
   */
  void loadRaceWorld(site.manifest.slug, {
    groundAt: (x, y) => site!.groundAt(x, -y) ?? site!.heightAt(x, y) ?? 0,
    countdown: 3,
  }).then((w) => {
    if (!w) return
    raceWorld = w
    scene.add(w.group)
    status(`races: ${w.courses.length}`)
  }).catch((e) => console.warn('races:', e))

  /*
   * The document was already fetched, above, to decide about physics — building from it here
   * rather than fetching it again is not only a saved request: two fetches can disagree, and a
   * physics world started for fixtures that then fail to load is the worst of both.
   */
  const stuntsHere = makeStuntWorld(site, physics, stuntDoc)
  if (stuntsHere) {
    stuntWorld = stuntsHere
    scene.add(stuntsHere.group)
    status(`stunts: ${stuntsHere.count} fixture${stuntsHere.count === 1 ? '' : 's'}${physics ? '' : ' — no physics, so they are scenery'}`)
  }
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
    /**
     * The physics world, or null when `PHYS_ENABLED` is off.
     *
     * A getter, not a value: this object is built once per site load and `physics` is assigned
     * after `buildSite` returns, so a plain property here would be permanently null and every
     * probe would conclude the physics never started.
     */
    get physics() {
      return physics
    },
    /** the level's traffic, or null: `count`, `problems`, `zones`, `entities` */
    get traffic() {
      return traffic
    },
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
    /**
     * The free camera, so a probe can step it by a known dt.
     *
     * Driving it through the real frame loop measures the RENDERER: under swiftshader the loop
     * stalls for seconds while tiles stream, and a "hold W for 1.2 s" probe read 138 m on its
     * first pass and 0 m on the next two. Speed is metres per second of simulation, and this is
     * how you ask for exactly that.
     */
    get fly() { return fly },
    /** the car itself, so a probe can check what the HUD claims against what the car is doing */
    get car() { return drive.car },
    /**
     * lon/lat to the site's PLAN coordinates (east, north metres about the frame anchor) — the
     * same projector the minimap draws with. World is (east, up, -north), so plan y is -worldZ.
     * Exposed because it is the only honest way for a probe to ask which way is north.
     */
    project: (lon: number, lat: number) => siteProjector(site!.manifest.frame as Parameters<typeof siteProjector>[0])(lon, lat),
    tuneDialog: tuneUI.dialog, // probes drive the panel's dock/float through this
    /**
     * THE PRESETS API, which is also the scripting API a program layer calls:
     *
     *   __apex.preset('dusk-rain', { over: 8 })        // tween over eight real seconds
     *   __apex.preset('midwinter', { over: 60 })       // during a cutscene
     *   __apex.preset(__apex.presets.ground)           // back to where the world started
     *
     * `presets` is the library itself — list, snapshot, put, remove, export — and `preset` is the
     * one call a story tells it to make.
     */
    /**
     * The transport library: `__apex.craft('helicopter')`, or null for the free camera.
     *
     * The same call the program layer's `api.transport(...)` makes, so what a level does and what
     * a probe does go through one path — two ways into a mode is how they end up disagreeing about
     * whether the free camera is enabled.
     */
    craft: (kind: CraftKind | null) => {
      setCraft(kind)
      return transport?.readout() ?? null
    },
    get transport() { return transport },
    get presets() { return presets },
    preset: (target: string | Record<string, number>, opts?: { over?: number; ease?: 'linear' | 'in' | 'out' | 'inOut'; done?: () => void }) => {
      if (!presets) return null
      const t = presets.apply(target, opts)
      // an instant apply has already written every knob and nothing will tick; a tween re-derives
      // from the loop, one frame at a time
      if (!t) onTuneChange()
      return t ? { over: t.over, stepped: presets.stepped(target) } : { over: 0, stepped: presets.stepped(target) }
    },
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
    /**
     * Where the engine is, as the spatialiser last decided it: distance to the ears, how much of
     * the cabin bus is in the mix, and the gain the distance curve is holding it to. Exposed
     * because "does the sound come from the car" is not answerable from a screenshot.
     */
    audio: () => ({
      state: engineSound.state, error: engineSound.error,
      muted: engineSound.isMuted, ctx: engineSound.contextState,
      ...engineSound.placement,
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
    /** the level in force, if `?level=` named one: what a scenario and a simulation will read */
    level: () => level,
    openLevel: (id: string) => openLevel(id),
    /** the rasterised seam: its size and how much of the site a capture covers */
    splatCover: () => (splatCover ? { ...splatCover, cellM: T.SPLAT_MASK_CELL_M, fade: splatMask.uSplatFade.value } : null),
    /** what the canopy overhead is doing to the ambient light, and the numbers behind it */
    light: () => ({ canopyShade: +canopyShade.toFixed(3), baseAmbient: +baseAmbient.toFixed(3), baseEnv: +baseEnv.toFixed(3), foliage: +foliageFraction().toFixed(2), ambient: +ambient.intensity.toFixed(3), env: +scene.environmentIntensity.toFixed(3) }),
    /*
     * DRAW A FRAME THE WAY THE APP DRAWS ONE.
     *
     * Every probe that reads pixels used to call `renderer.render(scene, camera)` itself. Since
     * post-process anti-aliasing arrived that is the WRONG CALL: with a composer the final pass
     * owns the default framebuffer, a bare `renderer.render` draws somewhere else, and
     * `gl.readPixels` then reads a buffer nobody just wrote. It does not throw and it does not
     * come back black — corridor-splatseam.mjs reported the capture seam "leaking" 17.6% of a
     * frame at a point whose mask reads zero, with every changed pixel BRIGHTER, which is a very
     * convincing bug report about nothing.
     *
     * So the app exposes its own draw, and probes use it instead of reaching for the renderer.
     */
    drawFrame: (cam?: THREE.Camera) => {
      if (!composer) return renderer.render(scene, cam ?? camera)
      // a probe that points its own camera somewhere (the sky, a junction) has to point the
      // composer's RenderPass too, or the composer draws the app's view and the probe measures
      // a frame it did not ask for
      if (cam) for (const p of composer.passes) if (p instanceof RenderPass) p.camera = cam
      composer.render()
      if (cam) for (const p of composer.passes) if (p instanceof RenderPass) p.camera = camera
    },
    THREE, // probes need Raycaster/Vector3 in the page, and there is no other handle on it
    // the world's clock: probes and the console drive time of day through this
    time: {
      get ms() { return worldClock.ms },
      /*
       * MOVING THE CLOCK DOES NOT REBUILD THE ENVIRONMENT MAP HERE.
       *
       * It is owed and the frame loop pays for it under its own budget. A probe that steps the
       * clock hour by hour looking for night -- which is the right way to find night, since
       * headless Chromium runs in UTC -- asked for twenty-four PMREM renders in one tick and
       * crashed the tab.
       */
      set ms(v: number) { worldClock.ms = v; applySky(season, false) },
      home: () => { worldClock.home(); applySky(season, false) },
      parts: (tz = Intl.DateTimeFormat().resolvedOptions().timeZone) => worldClock.parts(tz),
      setLocal: (date?: string, time?: string, tz = Intl.DateTimeFormat().resolvedOptions().timeZone) => {
        worldClock.setLocal(tz, date, time)
        applySky(season, false)
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
  buildPostAA(postAAFor(slug))
  applyLayers()
  fillInfo(manifest)
  fly ??= new FlyControls(camera, orbit, canvas, (x, z) => site?.groundAt(x, z) ?? null)
  transport ??= new TransportControls(camera, orbit, canvas, (x, z) => site?.groundAt(x, z) ?? null)

  // the captured world, if this site has one attached (or ?splats=<world> named one). It is a
  // skin over the bake, never the ground: see docs/corridor/PLAN-SPLAT-CORRIDORS.md.
  for (const f of splats) f.dispose()
  splats = []
  {
    const anchor = manifest.frame?.anchor
    if (anchor) {
      for (const att of await attachmentsFor(slug)) {
        noteCaptureAttached(slug)
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

  /*
   * THE LEVEL, LAST. `?level=<id>` dresses the world that was just loaded: its time and weather,
   * the assets in it, the captures over it. Last because everything it sets is a setting ON the
   * site, so it has to win over the site's own tuning.json rather than be overwritten by it.
   */
  /*
   * THE PRESETS LIBRARY, and the GROUND STATE it comes home to.
   *
   * The ground state is computed from the DOCUMENTS — the code defaults for every world-scope
   * knob, then the world's tuning.json — and not read off the live knobs, because by the time
   * this runs the panel has already restored whatever this browser was last playing with, and a
   * ground state that includes somebody's scratch values is not a ground state. See
   * docs/corridor/PLAN-GAME-PIPELINE.md.
   */
  {
    const doc = await loadSiteTuning(slug)
    const codeWorld: Record<string, number> = {}
    for (const k of worldKnobs(TUNE_TABS)) codeWorld[k.name] = k.default
    const worldValues: Record<string, number> = {}
    for (const [k, v] of Object.entries(doc?.values ?? {})) if (k in codeWorld) worldValues[k] = v
    presets = new Presets(TUNE_TABS, siteTuneAccess, resolve(codeWorld, worldValues))
    const lib = await loadPresets(slug)
    const r = presets.load(lib)
    for (const d of r.dropped) toast(`presets: ${d}`, 'warn', 5000)
    // the tab is built once and cached; without this the previous world's library stays on screen
    tuneUI.invalidatePresets()
  }

  const wantLevel = new URLSearchParams(location.search).get('level')
  if (wantLevel) await openLevel(wantLevel)
}

/**
 * The world's named look snapshots, and the animator that moves between them.
 *
 * Rebuilt per site, because the library, the ground state and the knobs it may touch all belong
 * to the world. Null before the first site has loaded, which is the only state the scripting API
 * has to guard for.
 */
let presets: Presets | null = null

/** Apply a level to the site on screen, and say plainly what did not apply. */
async function openLevel(id: string) {
  const lvl = await loadLevel(id)
  if (!lvl) return toast(`no level "${id}"`, 'warn', 4000)
  /*
   * THE CAR THE LEVEL NAMES. Fetched here, before anything can press Tab.
   *
   * Every way this can fail is ordinary — no `player`, no asset service, an asset that has no
   * dynamics document yet — and every one of them means "the default chassis" rather than "no car".
   * Refusing to drive because a catalog entry is missing would be the worst of the options.
   */
  playerVehicle = null
  playerModel = null
  if (lvl.player?.vehicle) {
    /*
     * A BUILD FIRST, THEN A CATALOG ITEM. `player.vehicle` may name a vehicle build — a model plus
     * the dynamics somebody tuned for it, which is what the vehicles screen and the `vehicle_save`
     * tool make — or a bare catalog id, whose dynamics (if any) sit on the item itself. The build
     * wins because it is the thing that was configured on purpose.
     */
    let modelId = lvl.player.vehicle
    try {
      const build = (await assetsvc.builds<{ id: string; asset: string | null; doc?: VehicleDoc }>('vehicles')).find((b) => b.id === lvl.player!.vehicle)
      if (build) {
        playerVehicle = build.doc ?? null
        if (build.asset) modelId = build.asset
      } else {
        const item = await assetsvc.get(lvl.player.vehicle)
        playerVehicle = (item?.vehicle as VehicleDoc | undefined) ?? null
      }
      if (!playerVehicle) toast(`${lvl.player.vehicle} has no dynamics saved — driving the default chassis`, 'warn', 5000)
    } catch {
      toast(`could not read ${lvl.player.vehicle} — driving the default chassis`, 'warn', 5000)
    }
    // The MODEL, fitted to whatever chassis we ended up with. Null for every ordinary reason — no
    // mesh on the asset, a file that will not decode — and the wedge is the fallback, never no car.
    const spec = (playerVehicle ?? defaultVehicle('hero-car')).spec
    playerModel = await loadCarModel(modelId, spec)
    if (playerModel) status(`car: ${lvl.player.vehicle} (${playerModel.variant}, ×${playerModel.scale.toFixed(2)}, ${playerModel.glazed} glazed)`)
    else toast(`${lvl.player.vehicle} has no usable model — driving the default body`, 'warn', 5000)
  }
  const report = await applyLevel(lvl, {
    world: site?.manifest.slug ?? '',
    setTimeLocal: (date, time) => {
      worldClock.setLocal(siteZone(), date, time)
      applySky(season, false)
    },
    setWeather: (w) => setWeatherSelection(w as Weather),
    applyPreset: (p) => {
      if (!presets) return null
      if (typeof p === 'string' && !presets.get(p)) return null
      presets.apply(p)
      onTuneChange()
      const n = typeof p === 'string' ? Object.keys(presets.get(p)?.values ?? {}).length : Object.keys(p).length
      return n
    },
    setSeason: (x) => { if (SEASONS.includes(x as Season)) setSeason(x as Season) },
    place: async (items: LevelPlacement[]) => {
      if (!site) return 0
      const catalog = await loadCatalog()
      // the level's own frame: [x, y] in site metres, y north, which is what placements.json uses
      const mapped = items.map((p) => ({ asset: p.asset, x: p.at[0], y: p.at[1], z: p.at.length > 2 ? p.at[2] : undefined, yaw: p.yaw ?? 0 }))
      const g = await buildPlacements(mapped as never, catalog, (x: number, z: number) => site?.groundAt(x, z) ?? 0)
      site.layers.placements.add(...g.children.slice())
      return mapped.filter((m) => catalog.has(m.asset)).length
    },
    attachSplats: async (names) => {
      const anchor = site?.manifest.frame?.anchor
      if (!anchor) return 0
      let n = 0
      for (const att of await attachmentsFor(site!.manifest.slug)) {
        if (!names.includes(att.id)) continue
        if (splats.some((f) => f.id === att.id)) { n++; continue }
        const f = await SplatField.attach(att, anchor, renderer)
        if (!f) continue
        scene.add(f.group)
        splats.push(f)
        n++
      }
      return n
    },
    say: (m) => toast(m, 'ok', 4000),
  })
  level = lvl
  for (const s of report.skipped) toast(`${lvl.id}: ${s.part} — ${s.why}`, 'warn', 6000)
  /*
   * THE TRAFFIC THE LEVEL ASKS FOR. Built here, after the site and after the level's own
   * placements, because a car needs a road to stand on and a set to be made of. Physics was
   * started for it at site build (see `trafficNeedsPhysics`); without it the cars still drive,
   * they just cannot be hit.
   */
  traffic?.dispose()
  traffic = null
  const wantTraffic = lvl.simulations?.find((x) => x.kind === 'traffic') as TrafficSpec | undefined
  if (wantTraffic && site) {
    traffic = new TrafficLayer(site, actors, physics)
    scene.add(traffic.group)
    try {
      const n = await traffic.load(site.manifest.slug, wantTraffic)
      status(`traffic: ${n} cars`)
      for (const p of traffic.problems) toast(`traffic: ${p}`, 'warn', 6000)
      if (!n) toast(`${lvl.id}: traffic asked for, but no zone or density put a car anywhere`, 'warn', 6000)
    } catch (e) {
      toast(`traffic: ${String((e as Error).message ?? e)}`, 'warn', 8000)
    }
  }
  // and the program, last: it may read the traffic and the races, so both are in place first
  if (lvl.program) await startProgram(lvl.program)
  else stopProgram()
}

/** the level in force, for the probe surface and for whatever runs simulations later */
let level: Awaited<ReturnType<typeof loadLevel>> = null
/** the level's traffic, once a level with a traffic simulation has opened */
let traffic: TrafficLayer | null = null
/** the level's program, running: goal, score, outcome. Null when the level names none */
let game: GameRun | null = null
let gameLine = ''
let hudHidden = false

/**
 * Run the program a level names.
 *
 * THE VIEWER RUNS IT, and this is the piece the plan called "wiring ProgramHost.layers": until now
 * a program could be written, checked, built and dry-run against a stub, and never driven. The
 * JavaScript comes from the world editor (`?js=1`, the same TypeScript the repo builds with), the
 * module loads through the same shims the Program pane uses, and the host below is the real one —
 * the car, the clock, the presets, the races, the traffic zones and the stunts of the world on
 * screen. Every failure is a toast and a null `game`, never a broken world.
 */
async function startProgram(path: string): Promise<boolean> {
  stopProgram()
  let js = ''
  try {
    const r = await fetch(`/api/programs/${path.split('/').map(encodeURIComponent).join('/')}?js=1`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = (await r.json()) as { js: string; errors: { message: string; line: number | null }[] }
    if (body.errors?.length) throw new Error(body.errors.map((e) => `${e.line ?? '?'}: ${e.message}`).join('; '))
    js = body.js
  } catch (e) {
    toast(`program ${path}: could not build — ${String((e as Error).message ?? e)}`, 'warn', 8000)
    return false
  }
  let def
  try {
    def = await loadGameModule(js)
  } catch (e) {
    toast(`program ${path}: ${String((e as Error).message ?? e)}`, 'warn', 8000)
    return false
  }
  const run = new GameRun(programHost(), def)
  const ok = await run.start()
  if (!ok) {
    toast(`program ${path}: setup threw — ${run.error}`, 'warn', 8000)
    return false
  }
  game = run
  gameLine = ''
  showGame()
  return true
}

function stopProgram() {
  if (!game) return
  try { game.stop() } catch (e) { console.warn('program stop:', e) }
  game = null
  gameLine = ''
  hudHidden = false
  if (!drive.on) clearStatus()
}

/** The goal and the score, on the readout, whenever they change; the outcome, once, as a toast. */
function showGame() {
  if (!game || hudHidden) return
  const line = game.outcome
    ? `${game.outcome === 'win' ? 'WIN' : game.outcome === 'lose' ? 'LOSE' : 'abandoned'} · ${game.score} pts`
    : `${game.goalText || 'no goal yet'}${game.score ? ` · ${game.score} pts` : ''}`
  if (line !== gameLine) {
    gameLine = line
    status(line)
    if (game.outcome) toast(line, game.outcome === 'win' ? 'ok' : 'warn', 8000)
  }
}

function programHost(): ProgramHost {
  const siteAt = (): { x: number; y: number; z: number } | null => {
    if (drive.car) return { x: drive.car.pos.x, y: -drive.car.pos.z, z: drive.car.pos.y }
    return { x: camera.position.x, y: -camera.position.z, z: camera.position.y }
  }
  return {
    actors,
    hide: (what, hidden) => {
      switch (what) {
        case 'minimap': minimap?.show(!hidden); break
        case 'street-names': {
          tuneKey('HUD_ROAD_NAME')?.set(hidden ? 0 : 1)
          if (site?.layers.blades) site.layers.blades.visible = !hidden
          break
        }
        case 'hud': hudHidden = hidden; if (hidden) clearStatus(); else showGame(); break
        case 'traffic': if (traffic) traffic.group.visible = !hidden; break
        case 'signals': if (site?.layers.signals) site.layers.signals.visible = !hidden; break
        case 'buildings': if (site?.layers.buildings) site.layers.buildings.visible = !hidden; break
      }
    },
    transport: (mode) => {
      if (mode === 'drive') { setCraft(null); setDrive(true); return }
      if (mode === 'walk' || mode === 'walk-third') { setCraft(null); setDrive(false); setWalk(true); return }
      if (mode === 'fly') { setDrive(false); setCraft(null); setWalk(false); return }
      if ((CRAFT_KINDS as string[]).includes(mode)) setCraft(mode as CraftKind)
    },
    preset: (id, opts) => {
      if (!presets) return
      const t = presets.apply(id, opts)
      if (!t) onTuneChange()
    },
    say: (text, kind) => toast(text, kind ?? 'info', 4000),
    playerAt: siteAt,
    playerSpeed: () => Math.abs(drive.car?.speed ?? 0),
    setTime: (hhmm) => { worldClock.setLocal(siteZone(), undefined, hhmm); applySky(season, false) },
    setWeather: (w) => setWeatherSelection(w as Weather),
    physics: {
      setProfile: (id, overrides) => {
        if (drive.car instanceof RapierCar) drive.car.setProfile(driveProfile(id, overrides))
      },
      car: () => (drive.car ? { speed: drive.car.speed, slide: drive.car.slide ?? 0, airborne: false, damage: 0 } as never : null),
    },
    layers: {
      raceIds: () => raceWorld?.courses.map((c) => c.id) ?? [],
      race: (id) => {
        const c = raceWorld?.courses.find((x) => x.id === id)
        return c ? { id: c.id, name: c.name, kind: c.kind, laps: c.laps ?? 1, gates: c.gates.length } : null
      },
      startRace: (id) => raceWorld?.session.start(id) ?? false,
      abandonRace: () => raceWorld?.session.abandon(),
      raceState: () => {
        const st = raceWorld?.state
        return st ? { phase: st.phase, course: st.course?.id ?? null, time: st.time, penalties: st.penalties, lap: st.lap, laps: st.laps } : null
      },
      trafficIds: () => traffic?.zones.list.map((z) => z.id) ?? [],
      trafficDensity: (id) => {
        const i = traffic?.zones.list.findIndex((z) => z.id === id) ?? -1
        return i >= 0 ? (traffic!.zones.rolled[i]?.density ?? null) : null
      },
      setTraffic: (id, density) => {
        const i = traffic?.zones.list.findIndex((z) => z.id === id) ?? -1
        if (i < 0) return false
        traffic!.zones.setDensity(i, density)
        return true
      },
      trafficAt: (x, y) => traffic?.zones.densityAt(x, y) ?? 0,
      stuntIds: () => stuntWorld?.fixtures.map((f) => f.id) ?? [],
      showStunt: () => false,
      stuntVisible: (id) => (stuntWorld?.fixtures.some((f) => f.id === id) ? true : null),
      stuntAt: (id) => {
        const f = stuntWorld?.fixtures.find((x) => x.id === id)
        return f ? { x: f.at[0], y: f.at[1], z: 0 } : null
      },
    },
  }
}
/**
 * The dynamics of the car the open level names, fetched when the level opens.
 *
 * Held here rather than fetched in `setDrive` because `setDrive` is synchronous and a car that
 * appears one network round-trip after you press Tab is a car you have already tried to drive. A
 * level with no `player`, a level whose asset has no dynamics, and no asset service at all are all
 * the same state as far as this is concerned: null, and the engine's default chassis.
 */
let playerVehicle: VehicleDoc | null = null
/** the level's car as a MODEL, loaded beside its numbers. Null = the procedural wedge */
let playerModel: CarModel | null = null

// ---------------------------------------------------------------------------------------------
// layers
function applyLayers() {
  if (!site) return
  const state = ui.layers()
  const on = (name: string) => state[name] ?? false
  site.setImagery(on('imagery'))
  site.setWire(on('wire'))
  site.setCanopy(on('canopy'))
  // the captured world is a knob (it drops and reloads tiles), so the layer drives the knob
  {
    const k = tuneKey('SPLAT_ENABLED')
    const want = on('splats') ? 1 : 0
    if (k && k.get() !== want) { k.set(want); onTuneChange() }
  }
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
/**
 * Get into, or out of, one of the craft in the transport library.
 *
 * `null` puts you back in the free camera. It takes over from driving and from the free camera
 * rather than sitting beside them, because they all move the same one camera and two things
 * writing it is a camera that vibrates.
 */
function setCraft(kind: CraftKind | null) {
  if (!transport) return
  if (kind) {
    if (drive.on) setDrive(false)
    transport.take(kind)
    transport.enabled = true
    if (fly) fly.enabled = false
    orbit.enabled = false
    toast(`${CRAFT[kind].name}: ${CRAFT[kind].note}`, 'info', 5000)
  } else {
    transport.enabled = false
    if (fly) fly.enabled = !drive.on
    orbit.enabled = !drive.on
    if (craft) toast('back to the free camera', 'info', 1500)
  }
  craft = kind
}

/** V cycles through the library, which is how you find out what is in it. */
function cycleCraft(back = false) {
  // 'walk' is left out: the free camera already has a first-person walk on B, and two first-person
  // walkers on two keys is the kind of duplication the editor's once-over was about
  const kinds: CraftKind[] = CRAFT_KINDS.filter((k) => k !== 'walk')
  const i = craft ? kinds.indexOf(craft) : -1
  const next = back ? i - 1 : i + 1
  setCraft(next < 0 || next >= kinds.length ? null : kinds[next])
}

function setWalk(on: boolean) {
  if (!fly) return
  fly.setWalk(on)
  if (on) toast('on foot (B to fly again)', 'info', 1500)
}
function setDrive(on: boolean) {
  drive.on = on
  // the chase camera may have rolled with the car; everything else expects the horizon
  chaseUp.set(0, 1, 0)
  camera.up.set(0, 1, 0)
  if (on) {
    // Entering drive mode is always a click or a keypress, which is the gesture the browser wants
    // before it will let an AudioContext make a sound. Starting anywhere else gets a context that
    // is created already suspended and never recovers.
    if (!playerEngine) {
      playerEngine = spawnPlayerEngine(actors.world)
      engineSound.setVoiced(playerEngine)
    }
    void engineSound.start()
  }
  if (on && fly?.walk) fly.setWalk(false)
  orbit.enabled = !on
  ui.setDriveMode(on)
  if (fly) fly.enabled = !on
  if (on && site) {
    if (!drive.car) {
      const surface = { heightAt: site.groundAt, edgeDistance: site.edgeDistance, treesNear: site.treesNear }
      /*
       * WHICH MODEL IS DRIVING.
       *
       * `PHYS_CAR` picks, and it only has a choice when there is a physics world at all (`?phys=1`).
       * Both models stay: the Stunts profile is a port of the kinematic one and the only real test
       * of the port is driving them back to back. Everything downstream talks to `DrivableCar` and
       * cannot tell which it has.
       */
      // `?car=rapier` beats the knob, for the same reason `?phys=1` does: this is read once, when
      // drive mode is first entered, and `tune.set` persists nothing across a reload.
      const carParam = new URLSearchParams(location.search).get('car')
      /*
       * AND A WORLD WITH STUNTS DRIVES THE PHYSICS CAR, for the same reason it starts the physics
       * at all: the kinematic car samples the terrain height under itself, so it drives THROUGH a
       * loop rather than round it. Nobody who has just placed a loop wants to be told to set a
       * knob, and `?car=` still wins.
       */
      // …and so does a level with traffic in it: the kinematic car cannot touch a traffic car, and a
      // jam you drive through as if it were fog is not the game anybody authored
      const wantRapier = carParam
        ? /^(rapier|physics|1)$/i.test(carParam)
        : T.PHYS_CAR > 0 || (stuntWorld?.count ?? 0) > 0 || (traffic?.count ?? 0) > 0
      if (physics && wantRapier) {
        // Spawned at the photo station, which is where `place` below puts it anyway — a car that
        // exists half a kilometre away for one frame is a heightfield tile built somewhere nobody
        // is ever going to drive.
        const at = site.spineAt(site.manifest.spine.photo_s)
        /*
         * The level's choice of game, the asset's own engine — see `spawnCar`.
         *
         * AND A STUNT WORLD GETS THE STUNT CAR when nothing else has said. Rich, 2026-09-29:
         * *"that car needs a lot more power… can't get it fast enough to do a loop de loop"*. The
         * `street` profile is 7.5 m/s² per kilo and 58 m/s; `stunts` is 11 and 82, and a loop is
         * held by speed. A level that names a profile, or a knob somebody has moved off its
         * default, still wins — an explicit choice always beats an inference.
         */
        const stuntish = (stuntWorld?.count ?? 0) > 0 && T.physProfileId() === 'street'
        const wantProfile = level?.player?.profile ?? (stuntish ? 'stunts' : undefined)
        drive.car = new RapierCar(
          physics.spawnCar({ x: at.pos.x, z: at.pos.z, yaw: Math.atan2(at.dir.z, at.dir.x) }, wantProfile, playerVehicle ?? undefined),
          surface,
          playerModel?.object,
        )
        status(`driving: rapier, ${wantProfile ?? T.physProfileId()}${playerVehicle ? `, ${level?.player?.vehicle}` : ''}`)
      } else {
        drive.car = new Car(surface)
      }
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
/** where the sun is for this site, right now on the world's clock */
function sunNow(): { el: number; az: number; dir: THREE.Vector3; moon: THREE.Vector3; phase: number; jd: number; lat: number; lon: number } {
  const a = site?.manifest.frame?.anchor
  const lat = a?.lat ?? 39, lon = a?.lon ?? -76.7
  const s = sunPosition(worldClock.ms, lat, lon)
  const v = sunVector(s.elevation, s.azimuth, T.SUN_ARC)
  /*
   * THE MOON IS A REAL MOON NOW.
   *
   * It used to run the sun's arc fifty minutes later each day with a sawtooth phase, and the note
   * beside it said "a real one is Meeus chapter 47 if it ever matters". It matters: Rich asked for
   * the moon and the stars to move as they really do, and a moon that follows the sun's arc is in
   * the wrong part of the sky for most of the month — it never rides high in winter or skims the
   * horizon in summer, which is the thing you notice.
   *
   * So it comes from the same celestial machinery as the stars: an abridged lunar theory for its
   * right ascension and declination, and the observer's own equatorial-to-horizon rotation. The
   * phase is the angle between the Sun and the Moon as seen from here, not a 29.53-day counter —
   * so it cannot drift, and a gibbous moon is lit on the side the Sun is actually on.
   */
  const jd = julianDate(worldClock.ms)
  const mp = moonPosition(jd)
  const mv = radecToVec(mp.ra, mp.dec).applyMatrix4(celestialToWorld(lat, lon, jd))
  return {
    el: s.elevation,
    az: s.azimuth,
    dir: new THREE.Vector3(v.x, v.y, v.z),
    moon: mv,
    phase: mp.phase,
    jd,
    lat,
    lon,
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
/**
 * The environment map: the sky, prefiltered, as the thing that lights everything.
 *
 * This is the EXPENSIVE half of applySky -- a PMREM render and a fresh render target every call,
 * everything else in there being scalar colour work. So it is timed, and `frame()` uses the
 * measurement to decide how often it can afford to run (see `envCostMs`). Do not call it in a
 * loop without that guard: at TIME_RATE 3600 the sky wants rebuilding every frame, and that is
 * how the tab used to stop answering.
 */
let envCostMs = 0
function skyEnvironment() {
  const t0 = performance.now()
  // the dome lives in the main scene; borrow it for the capture and put it straight back
  const parent = skyDome.mesh.parent
  skyScene.add(skyDome.mesh)
  const next = pmrem.fromScene(skyScene, 0, 0.1, 100)
  if (parent) parent.add(skyDome.mesh)
  envRT?.dispose()
  envRT = next
  scene.environment = next.texture
  // a rolling measure, so one hitch does not shut the sky down for a second
  envCostMs = envCostMs === 0 ? performance.now() - t0 : envCostMs * 0.7 + (performance.now() - t0) * 0.3
}

/** set when the light has moved but the environment map has not been rebuilt for it yet */
let envDue = false
/**
 * `env` false does everything but the environment map, leaving it owed: the sun, the sky colour,
 * the dome and every light move on the frame the clock moves them, and only the prefiltered
 * irradiance lags — which is the one term that can lag without anyone seeing it.
 */
function applySky(s: Season, env = true) {
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
  skyNight = night
  skyCover = Math.min(1, 0.3 + (def.sky?.cloudBias ?? 0) + 0.7 * w.skyMix)
  skyDome.set({
    zenith: (def.sky ? def.sky.zenith.clone() : look.sky.clone().lerp(new THREE.Color(0x4f86d2), 0.55)).lerp(w.skyTint, w.skyMix).lerp(NIGHT_SKY, night * 0.99),
    horizon: sky,
    cover: skyCover,
    haze: Math.min(1, 0.35 + w.skyMix * 0.6),
    sunDir: sunAt.dir,
    sunColour: look.sun.colour.clone().lerp(new THREE.Color(0xff6b2a), Math.min(0.95, golden * 0.8 * T.SUNSET_BOLD)),
    night,
    // the dome's procedural stars are the FALLBACK: a hash has no Orion in it, so once the real
    // catalogue is loaded the dome draws none and `stars.ts` owns them
    stars: stars ? 0 : T.SKY_STARS,
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
  if (env) skyEnvironment()
  else envDue = true
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
  // The engine tab is live: the gearbox and the voicing take effect while you are driving, and
  // swapping ENGINE_INDEX recompiles in the audio thread. Cheap when nothing engine-shaped moved.
  engineSound.applyTuning()
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
  /*
   * ESCAPE LEAVES THE RACE. Rich, 2026-09-29: *"the ability to exit the race"*.
   *
   * It is checked before anything else a key might mean, and only while a race is actually on, so
   * it cannot shadow whatever Escape does the rest of the time. Pressed again on the results it
   * clears them and hands the world back.
   */
  if (e.code === 'Escape' && raceWorld) {
    const phase = raceWorld.state.phase
    if (phase === 'armed' || phase === 'countdown' || phase === 'running') {
      e.preventDefault()
      raceWorld.session.abandon()
      status('race abandoned — drive back into the ring to try again')
      return
    }
    if (phase === 'finished' || phase === 'abandoned') {
      e.preventDefault()
      raceWorld.session.reset()
      status('')
      return
    }
  }
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
    case 'KeyV': cycleCraft(e.shiftKey); break
    case 'F7': {
      e.preventDefault()
      const on = perfHud.toggle()
      setPerfWanted(on)
      toast(on ? 'performance stats on' : 'performance stats off', 'info', 1200)
      break
    }
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
/** the chase camera's own up: the horizon on a road, the car's roof through a loop (CHASE_ROLL) */
const chaseUp = new THREE.Vector3(0, 1, 0)
const viewDir = new THREE.Vector3()
// The camera's ears. Reused rather than allocated, because this is every frame.
const earDir = new THREE.Vector3()
const earUp = new THREE.Vector3()
const UP_LOCAL = new THREE.Vector3(0, 1, 0)
/** the simulated instant the sky was last built for; 20 s of world time is well under a degree of sun */
let lastSkyMs = -1e15
let lastSkyReal = -1e15
function frame() {
  const real = clock.getDelta()
  const dt = Math.min(0.1, real)
  // the frame's own clock, for the performance panel: `real` is the gap between frames, and the
  // work we do inside this function is measured separately so the two can be compared
  const cpu0 = perfHud.open ? performance.now() : 0
  /*
   * The physics world, once a frame.
   *
   * The eye is the CAR when there is one, not the camera: the tiles have to be solid where the
   * wheels are, and the chase camera sits eight metres behind and four above, which at the edge of
   * the radius is the difference between ground and a hole. One frame of lag on tile placement is
   * nothing at 180 m; one tile of lag under the car is the car falling through the world.
   *
   * `real`, not `dt`: the accumulator inside the physics world does its own capping, and handing it
   * an already-capped delta would make the simulation quietly run slow through every hitch.
   */
  // the traffic steps before the physics, so its bodies are where the cars are when the player hits one
  if (traffic) traffic.tick(real, camera.position)
  if (game) {
    game.tick(real)
    showGame()
    if (game.error) { toast(`program: ${game.error}`, 'warn', 8000); game = null }
  }
  if (physics) physics.update(drive.car?.pos ?? camera.position, real)
  // the world's clock, and the light that follows from it. applySky is cheap (no geometry), so it
  // runs whenever the sun has moved enough to see — a degree of elevation is about four minutes of
  // a real day, and far less than that at a high TIME_RATE.
  // a preset transition in flight, on REAL seconds: TIME_RATE is itself a knob a preset may tween,
  // and driving the animator off simulated time makes a transition that speeds up as it changes
  // the clock it is being measured against
  // the same cost as dragging a slider, and only while a transition is in flight
  if (presets?.tick(real)) onTuneChange()
  worldClock.rate = T.TIME_RATE
  worldClock.tick(real) // real time, not the capped physics step: the sun does not care about hitches
  /*
   * THE SKY, AT ANY TIME RATE.
   *
   * The cheap half runs whenever the simulated clock has moved twenty seconds, so at 3600x the sun
   * slides across the sky continuously. The environment MAP is a PMREM render, and it is allowed
   * at most an eighth of real time: `envCostMs` is measured, so this is the same rule on Rich's
   * GPU (a rebuild every few frames) and on a software rasteriser (a rebuild every second or two)
   * without a constant that means different things on each. Before this, twenty simulated seconds
   * arrived every five real milliseconds at 3600x, the map was rebuilt every frame, and the tab
   * stopped drawing entirely -- measured at 0 frames in 5 s.
   */
  const nowReal = performance.now()
  if (Math.abs(worldClock.ms - lastSkyMs) > 20000) {
    lastSkyMs = worldClock.ms
    applySky(season, false)
  }
  if (envDue && nowReal - lastSkyReal > Math.max(120, envCostMs * 8)) {
    lastSkyReal = nowReal
    envDue = false
    skyEnvironment()
  }
  if (site && drive.on && drive.car) {
    const car = drive.car
    // keyboard is read fresh each frame; the phone pads have already set throttle/brake/steer
    const padT = drive.input.throttle, padB = drive.input.brake
    readDriveKeys()
    // fixed-step sim at 120 Hz like stuntin, so speed does not depend on the frame rate
    for (let acc = dt; acc > 0; acc -= 1 / 120) car.tick(Math.min(acc, 1 / 120), drive.input)
    /*
     * ON A STUNT FIXTURE, THE TRACK DECIDES WHICH WAY IS DOWN.
     *
     * A ray-cast vehicle feels the road along its own down axis, so a level car cannot feel a loop
     * that has stood up in front of it — it drove straight through (Rich, 2026-09-29). Turn the
     * body to face the surface and the rays point into it, the suspension loads, and the wheels
     * carry the car round. Nothing happens anywhere else: `nearestPose` answers null off a fixture,
     * and on the flat run-in the correction is zero because the surface already agrees with gravity.
     */
    holdToTrack(car, dt)
    drive.input.throttle = padT
    drive.input.brake = padB
    // Site metres — x east, y north, z up — not three's axes. The conversion happens here, once.
    if (playerEngine) {
      Transform.x[playerEngine] = car.pos.x
      Transform.y[playerEngine] = -car.pos.z
      Transform.z[playerEngine] = car.pos.y
      engineSound.syncFromCar(playerEngine, car, drive.input.throttle, dt)
    }
    /*
     * WHICH WAY IS UP FOR THE CAMERA. Rich, 2026-09-29, first time round the loop: *"when the car
     * went upside down the camera stayed right side up and I got disoriented and drove off the
     * loop."* So the camera's up follows the CAR's up — `CHASE_ROLL` of it, smoothed by
     * `CHASE_ROLL_LAG` — and the rig is built in that frame: behind the car along its own floor,
     * above it along its own roof. At 0 the old horizon-locked camera is back. The blend passes
     * through zero length half way to inverted at 0.5, so a degenerate blend keeps the last frame's.
     */
    const carUp = car.right.clone().cross(car.forward).normalize()
    const wantUp = up.clone().lerp(carUp, T.CHASE_ROLL)
    if (wantUp.lengthSq() > 1e-4) chaseUp.lerp(wantUp.normalize(), 1 - Math.exp(-T.CHASE_ROLL_LAG * dt)).normalize()
    camera.up.copy(chaseUp)
    // chase camera: behind and above, looking over the bonnet; drag adds a look-around yaw
    if (drive.cockpit) {
      // cockpit: eye at the driver's head, looking down the nose (stuntin's C view); drive.yaw/pitch look around.
      // NO EARLY RETURN HERE. It used to `return` out of frame(), which skipped everything below —
      // site.updateNear (the grass, the trees, the tile stream and the grading pump all take the
      // eye from it) and the minimap. Pressing C stopped the world (Rich, 2026-09-26): the frames
      // kept coming, but nothing was ever told where the camera had got to.
      // the head sits in the car, so it is the car's up — COCKPIT_ROLL of it — that lifts it off the seat
      const headUp = up.clone().lerp(carUp, T.COCKPIT_ROLL).normalize()
      const eye = car.pos.clone().add(headUp.clone().multiplyScalar(T.COCKPIT_EYE_UP)).add(car.forward.clone().multiplyScalar(T.COCKPIT_EYE_FWD))
      camera.position.copy(eye)
      camera.up.copy(headUp)
      const ahead = car.forward.clone().applyAxisAngle(headUp, drive.yaw)
      camera.lookAt(eye.clone().add(ahead.multiplyScalar(30)).add(headUp.multiplyScalar(-Math.tan(drive.pitch) * 30 + T.COCKPIT_LOOK_UP)))
    } else {
      const back = car.forward.clone().applyAxisAngle(chaseUp, drive.yaw).multiplyScalar(-T.CHASE_BACK)
      const want = car.pos.clone().add(back).add(chaseUp.clone().multiplyScalar(T.CHASE_UP + Math.tan(drive.pitch) * 4))
      // the ground clamp is for a camera under the road, which only means something while up is up
      const gy = chaseUp.y > 0.5 ? site.groundAt(want.x, want.z) : null
      if (gy !== null && want.y < gy + 1.2) want.y = gy + 1.2
      camera.position.lerp(want, 1 - Math.exp(-T.CHASE_LAG * dt))
      camera.lookAt(car.pos.clone().add(car.forward.clone().multiplyScalar(T.CHASE_LOOK_AHEAD)).add(chaseUp.clone().multiplyScalar(1.0)))
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

  } else if (craft && transport) {
    transport.update(dt)
    const r = transport.readout()
    ui.setPos(`${r.craft} · ${(r.speed * 2.237).toFixed(0)} mph · ${r.altitude.toFixed(0)} m${r.stalled ? ' · STALLED' : ''}${r.grounded ? ' · on the ground' : ''}`)
  } else {
    fly?.update(dt)
    applyMove(dt)
    orbit.update()
    ui.setPos('')
  }
  /*
   * WHERE THE ENGINE IS, from wherever the camera ended up.
   *
   * AFTER the mode branches, not inside the driving one. The car keeps existing when you fly away
   * from it, and it used to keep sounding exactly as it did the instant you left — frozen at the
   * last listener position, so walking or flying a hundred metres away changed nothing (Rich,
   * 2026-09-27: "it just keeps the audio for the engine where you were last driving"). The engine
   * is a thing in the world; the ears belong to whoever is looking, in every mode.
   *
   * After, also, because the camera is PLACED by those branches. Voicing before they run pans
   * every frame to where you were looking last frame, which is inaudible as anything but a vague
   * sense that the audio lags.
   *
   * Site metres, x east, y north, z up. Three's world is (east, up, −north), so y = −z and z = y
   * — the same conversion Transform gets, applied to a direction as well as a point. The up
   * vector comes off the quaternion rather than being assumed to be world up: corridor does not
   * roll today, and a camera that does is then right for free.
   */
  if (playerEngine) {
    // Nobody has their foot on it while you are off flying, so let it settle to idle where it
    // stands rather than holding the revs it had when you stepped out.
    if (!(drive.on && drive.car)) engineSound.coast(playerEngine, dt)
    camera.getWorldDirection(earDir)
    earUp.copy(UP_LOCAL).applyQuaternion(camera.quaternion)
    engineSound.update(actors.world, {
      position: { x: camera.position.x, y: -camera.position.z, z: camera.position.y },
      forward: { x: earDir.x, y: -earDir.z, z: earDir.y },
      up: { x: earUp.x, y: -earUp.z, z: earUp.y },
    })
  }
  if (raceWorld) {
    /*
     * THE PLAYER'S POSITION IN SITE METRES. `drive.car.pos` and the camera are both three vectors —
     * x east, y up, z SOUTH — and every course is authored with y north. One conversion, here.
     */
    const p = drive.on && drive.car ? drive.car.pos : camera.position
    const out = raceWorld.tick({ x: p.x, y: -p.z }, dt)
    if (out.banner && out.banner !== lastRaceBanner) {
      lastRaceBanner = out.banner
      status(out.banner)
    }
    if (!out.banner) lastRaceBanner = null
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
    for (const f of splats) {
      f.update(camera.position.x, -camera.position.z)
      // and the ordering, which is asked for only when the camera has moved enough to need one
      f.step(camera, scene)
    }
    // the world looks wet while it is wet: the weather ramps it, the surfaces follow
    site.setWet(site.weather.wetness)
    // THE SKY TURNS. One matrix for nine thousand stars, rebuilt each frame from the clock — so
    // time acceleration moves the stars exactly as it moves the sun, because it is the same
    // rotation of the same Earth (celestial.ts).
    if (stars) {
      const a = site.manifest.frame?.anchor
      stars.setTransform(celestialToWorld(a?.lat ?? 39, a?.lon ?? -76.7, julianDate(worldClock.ms)))
      stars.setLook(skyNight, T.SKY_STARS, skyCover)
      stars.tick(clock.elapsedTime, renderer.getDrawingBufferSize(new THREE.Vector2()).y, T.STAR_PIXELS, T.STAR_SIZE, T.STAR_MAG_LIMIT)
      // the galaxy takes the same rotation: it is the same sky, and any second copy of that
      // arithmetic is a copy that can disagree with the first one
      galaxy?.setTransform(stars.points.matrix)
      galaxy?.setLook(skyNight, T.SKY_MILKYWAY, skyCover)
    }
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
    // the inset map follows the car when driving, the camera when flying; site frame is x east, y north = -z
    if (drive.on && drive.car) minimap?.draw({ x: drive.car.pos.x, y: -drive.car.pos.z, yaw: Math.atan2(-drive.car.forward.z, drive.car.forward.x) })
    else minimap?.draw({ x: camera.position.x, y: -camera.position.z, yaw: Math.atan2(-fwd.z, fwd.x) })
  }
  skyDome.tick(performance.now() / 1000)
  if (composer) composer.render()
  else renderer.render(scene, camera)
  /*
   * MEASURED AFTER THE RENDER CALL, which is the honest place: `renderer.info` holds the counts of
   * the frame that has just been submitted, and the CPU time covers everything this function did
   * including submitting it. What it does NOT include is the GPU actually finishing — the gap
   * between `cpuMs` and the frame time is where that shows up.
   */
  if (perfHud.open) {
    perfMeter.frame(real * 1000, performance.now() - cpu0)
    const info = renderer.info
    perfMeter.counts = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    }
  }
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
  /**
   * The world's stunt fixtures, or null when it has none.
   *
   * `stuntSurfaces()` on the physics beside it is the pair that answers the only question that
   * matters about a loop: is the thing you can see also a thing you can hit.
   */
  get stunts() {
    return stuntWorld
  },
  /** the level's traffic layer, or null: `count`, `problems`, `zones`, `entities`, `tick(dt, eye)` */
  get traffic() {
    return traffic
  },
  /** the level's program run, or null: `goalText`, `score`, `outcome`, `error`, `messages` */
  get game() {
    return game
  },
  /** run a program by path, the way a level does — for a probe, and for trying one without a level */
  startProgram: (path: string) => startProgram(path),
  /**
   * The world's races: the session, its courses and its markers.
   *
   * `races.session.start(id)` begins one without driving into its throbber, which is how a probe
   * and a program both do it.
   */
  get races() {
    return raceWorld
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
   * The physics world, or null when it is switched off.
   *
   * `groundUnder` is the interesting one: it ray-casts the heightfield the wheels will stand on, so
   * a probe can hold it against `site.groundAt` — the surface everything else is built from — and
   * find out whether the two agree. They must, to a centimetre, or the car floats and sinks in ways
   * nothing else explains. probes/corridor-physground.mjs is that comparison.
   */
  get physics() {
    return physics
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
   * The presets library, over the bridge as well as on `window.corridor`.
   *
   * Because this is the surface that reaches Rich's GPU browser, and "make it night over eight
   * seconds and tell me what snapped" is a thing to ask of a real card rather than of swiftshader.
   */
  get presets() {
    return presets
  },
  preset: (target: string | Record<string, number>, opts?: { over?: number; ease?: 'linear' | 'in' | 'out' | 'inOut' }) => {
    if (!presets) return null
    const t = presets.apply(target, opts)
    if (!t) onTuneChange()
    return { over: t?.over ?? 0, stepped: presets.stepped(target) }
  },
  /**
   * What the renderer really did, and what the frames really cost.
   *
   * 30 frames is half a second on a real card and fits inside the bridge's 5 s eval timeout; ask
   * for more with `apex.perf(120)` and pass `--timeout 30000` to the client.
   */
  /**
   * The performance panel's own meter and its panel, for probes and the console.
   *
   * `perf()` below is the bridge's one-shot frame sampler and predates this; the METER is the live
   * window the panel reads — `apex.perfMeter.read()` is exactly what is on screen.
   */
  /**
   * Hold the car to whatever stunt surface it is on, for one step.
   *
   * The frame loop does this every frame; a probe that steps the car itself has to call it too, or
   * it is driving a car the game does not have.
   */
  assist: (dt = 1 / 60) => holdToTrack(drive.car, dt),

  get perfMeter() {
    return perfMeter
  },
  get perfHud() {
    return perfHud
  },

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
