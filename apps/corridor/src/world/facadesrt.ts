// The building classes' facades, in the renderer: one texture array, one shader, per world.
//
// facades.ts decides what each building IS and which material it draws; this is the half that
// needs THREE and the network. It reads the library's materials and the shared `/facades` records
// once, lays the world's own choices over them, and hands `buildBuildings` two things: which class
// slot a footprint is (classified on the main thread, where the footprint's tags are), and a
// material hook that draws every class from ONE `DataArrayTexture`.
//
// THE COST IS FLAT IN THE NUMBER OF BUILDINGS AND CLASSES. A massing cell is still one mesh and one
// draw call; every cell's material compiles to the same program (`customProgramCacheKey`) and
// shares the same atlas and the same uniform arrays. What the pools add is the atlas — one layer
// per distinct material, at FACADE_TEXTURE_PX square — and nothing per vertex: the class rides in
// the layer float the massing already carried (`class × 64 + layer`, facades.ts).
//
// REFLECTIVENESS is the class's metalness and roughness, against `scene.environment` (the sky dome
// the car's paint reflects). GLASS is the material's own `glass_mask.png` packed into the albedo's
// alpha: inside a pane the roughness is the material's glass roughness, outside it (the mullions)
// the class's. Not transmission — a massing box has no interior to see, so a transmissive curtain
// wall would show the sky through the building; the viewer's transmission is for car glazing and
// placed models (src/glazing.ts), which have something behind the glass.

import * as THREE from 'three'
import { BUILTIN_FACADES, LAYER_STRIDE, MAX_CLASSES, MAX_LAYERS, classifyFootprint, facadePlan, resolveFacades, type FacadeClass, type FacadePatch, type FootprintFacts, type PlanClass, type WorldBuildings } from './facades'

/** what a library material record says that matters here */
interface MaterialRec {
  id: string
  metres_per_tile?: number
  albedo?: string
  glass_mask?: string
  glass?: { roughness?: number } | null
}

export interface FacadeRuntime {
  classes: FacadeClass[]
  plan: { layers: string[]; classes: PlanClass[] }
  /** the class slot of a footprint, or -1 */
  slotOf: (b: FootprintFacts) => number
  /** glazed classes are not dressed: a curtain wall is its own windows */
  glazed: (slot: number) => boolean
  /** make a massing material draw the pools; resolves once the atlas is up (or failed) */
  apply: (mat: THREE.MeshStandardMaterial) => Promise<void>
  /** what it costs: atlas layers, size, and bytes on the GPU with mips */
  stats: () => { layers: number; px: number; atlasBytes: number; classes: number; loaded: boolean; failed: string | null }
  /** change the classes' surfaces live (the pools need a rebuild; reflectiveness does not) */
  setSurface: (id: string, s: { metalness?: number; roughness?: number }) => void
}

/** The library's shared records; an older service with no `/facades` route is "none". */
async function sharedRecords(base: string): Promise<(FacadePatch & { id: string })[]> {
  try {
    const r = await fetch(`${base}/facades`, { cache: 'no-cache' })
    if (!r.ok) return []
    return ((await r.json()) as { facades?: (FacadePatch & { id: string })[] }).facades ?? []
  } catch {
    return []
  }
}

async function materialRecords(base: string): Promise<MaterialRec[] | null> {
  try {
    const r = await fetch(`${base}/materials`, { cache: 'no-cache' })
    if (!r.ok) return null
    return ((await r.json()) as { materials?: MaterialRec[] }).materials ?? []
  } catch {
    return null
  }
}

const file = (p: string | undefined, dflt: string) => (p ? p.split('/').pop()! : dflt)

/**
 * Albedo in RGB, `1 − glass mask` in A — one array, so a pane costs no second texture. Every layer
 * is drawn at `px` square whatever its source size: the library's maps are 1024², and at 2–3 m a
 * tile 512 is 4–6 mm a texel, which nobody driving past can tell from 2 mm — at a quarter of the
 * memory.
 */
async function facadeAtlas(urls: { albedo: string; mask: string | null }[], px: number): Promise<THREE.DataArrayTexture> {
  const load = (u: string) => new Promise<HTMLImageElement>((ok, fail) => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => ok(im)
    im.onerror = () => fail(new Error(u))
    im.src = u
  })
  const imgs = await Promise.all(urls.map(async (u) => ({ albedo: await load(u.albedo), mask: u.mask ? await load(u.mask).catch(() => null) : null })))
  const data = new Uint8Array(px * px * 4 * imgs.length)
  const c = document.createElement('canvas')
  c.width = c.height = px
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  imgs.forEach((im, i) => {
    ctx.clearRect(0, 0, px, px)
    ctx.drawImage(im.albedo, 0, 0, px, px)
    const rgba = ctx.getImageData(0, 0, px, px).data
    if (im.mask) {
      ctx.clearRect(0, 0, px, px)
      ctx.drawImage(im.mask, 0, 0, px, px)
      const m = ctx.getImageData(0, 0, px, px).data
      for (let k = 0; k < rgba.length; k += 4) rgba[k + 3] = 255 - m[k]
    } else {
      for (let k = 3; k < rgba.length; k += 4) rgba[k] = 255
    }
    data.set(rgba, i * px * px * 4)
  })
  const t = new THREE.DataArrayTexture(data, px, px, imgs.length)
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = 8
  t.flipY = false
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

/**
 * The world's facades, ready to draw — or null when there is nothing to draw them from (no
 * library reachable, or not one material any class names). Null is the palette colours, which is
 * what every world looked like before this.
 */
export async function loadFacades(world: WorldBuildings | null | undefined, opts: { base?: string; px?: number } = {}): Promise<FacadeRuntime | null> {
  const base = opts.base ?? '/assetsvc'
  const px = opts.px ?? 512
  const [shared, mats] = await Promise.all([sharedRecords(base), materialRecords(base)])
  if (!mats?.length) return null
  const byId = new Map(mats.map((m) => [m.id, m]))
  const classes = resolveFacades(shared, world)
  const plan = facadePlan(classes, new Set(byId.keys()))
  if (!plan.layers.length) return null
  const slot = new Map(plan.classes.map((c, i) => [c.id, i]))

  // the uniforms, shared BY REFERENCE by every cell's material: a surface change is one write here
  const mpt = new Array<number>(MAX_LAYERS + 1).fill(2)
  const glassRough = new Array<number>(MAX_LAYERS + 1).fill(-1)
  plan.layers.forEach((id, i) => {
    const m = byId.get(id)!
    mpt[i] = m.metres_per_tile && m.metres_per_tile > 0 ? m.metres_per_tile : 2
    if (m.glass_mask) glassRough[i] = Math.max(0.02, Number(m.glass?.roughness ?? 0.05))
  })
  const rough = new Array<number>(MAX_CLASSES).fill(0.92)
  const metal = new Array<number>(MAX_CLASSES).fill(0)
  const glass = new Array<number>(MAX_CLASSES).fill(0)
  classes.slice(0, MAX_CLASSES).forEach((c, i) => { rough[i] = c.roughness; metal[i] = c.metalness; glass[i] = c.glass ? 1 : 0 })

  let atlas: Promise<THREE.DataArrayTexture> | null = null
  let loaded = false
  let failed: string | null = null
  const urls = plan.layers.map((id) => {
    const m = byId.get(id)!
    return {
      albedo: `${base}/materials/${encodeURIComponent(id)}/file/${file(m.albedo, 'albedo.jpg')}`,
      mask: m.glass_mask ? `${base}/materials/${encodeURIComponent(id)}/file/${file(m.glass_mask, 'glass_mask.png')}` : null,
    }
  })
  const getAtlas = () => (atlas ??= facadeAtlas(urls, px).then((t) => { loaded = true; return t }, (e: Error) => { failed = e.message; throw e }))

  const apply = async (mat: THREE.MeshStandardMaterial) => {
    let tex: THREE.DataArrayTexture
    try {
      tex = await getAtlas()
    } catch {
      return // a map that would not load: the palette colours stand
    }
    mat.customProgramCacheKey = () => 'facades-v1'
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.facadeMap = { value: tex }
      shader.uniforms.facadeMpt = { value: mpt }
      shader.uniforms.facadeGlassRough = { value: glassRough }
      shader.uniforms.facadeRough = { value: rough }
      shader.uniforms.facadeMetal = { value: metal }
      shader.uniforms.facadeGlass = { value: glass }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float layer;\nvarying float vFLayer;\nvarying vec3 vFPos;\nvarying vec3 vFNrm;')
        // LOCAL position, not world: the massing is built in site metres and the floating origin
        // moves the group, which must not slide the bricks along the wall
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFLayer = layer;\nvFPos = position;\nvFNrm = normal;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform highp sampler2DArray facadeMap;
uniform float facadeMpt[${MAX_LAYERS + 1}];
uniform float facadeGlassRough[${MAX_LAYERS + 1}];
uniform float facadeRough[${MAX_CLASSES}];
uniform float facadeMetal[${MAX_CLASSES}];
uniform float facadeGlass[${MAX_CLASSES}];
varying float vFLayer;
varying vec3 vFPos;
varying vec3 vFNrm;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  float fRough = -1.0;
  float fMetal = 0.0;
  if (vFLayer >= 0.0) {
    int fS = int(floor(vFLayer / ${LAYER_STRIDE}.0 + 0.001));
    int fL = int(vFLayer - float(fS) * ${LAYER_STRIDE}.0 + 0.5);
    vec3 fn = abs(normalize(vFNrm));
    vec2 fuv = fn.y > 0.5 ? vFPos.xz : (fn.x > fn.z ? vec2(vFPos.z, vFPos.y) : vec2(vFPos.x, vFPos.y));
    vec4 fc = texture(facadeMap, vec3(fuv / facadeMpt[fL], float(fL)));
    diffuseColor.rgb *= fc.rgb;
    fRough = facadeRough[fS];
    fMetal = facadeMetal[fS];
    float gr = facadeGlassRough[fL];
    if (facadeGlass[fS] > 0.5 && gr >= 0.0) fRough = mix(gr, fRough, fc.a);
  }`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  if (fRough >= 0.0) { roughnessFactor = fRough; metalnessFactor = fMetal; }`)
    }
    mat.needsUpdate = true
  }

  return {
    classes,
    plan,
    slotOf: (b) => slot.get(classifyFootprint(b, classes)) ?? -1,
    glazed: (s) => !!plan.classes[s]?.glass,
    apply,
    stats: () => ({ layers: plan.layers.length, px, atlasBytes: Math.round(px * px * 4 * plan.layers.length * 4 / 3), classes: plan.classes.length, loaded, failed }),
    setSurface: (id, s) => {
      const i = slot.get(id)
      if (i === undefined) return
      if (s.metalness !== undefined) metal[i] = s.metalness
      if (s.roughness !== undefined) rough[i] = s.roughness
    },
  }
}

/** for tests and the tab: the built-in set's ids, in order */
export const FACADE_CLASSES = BUILTIN_FACADES.map((c) => c.id)
