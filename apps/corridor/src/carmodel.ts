// The car you can see: an asset's model, fitted to the car the physics is driving.
//
// Rich, 2026-09-29: "I have no idea how to take a car model and attach a physics model to it,
// configure the engine sound and performance, overall car performance, and use it in a level."
//
// The rest of that sentence is answered elsewhere — the dynamics document is on the asset
// (`vehicles.ts`), the level names which car (`level.player`), and the engine sound reads the same
// gearbox. This file is the last clause: making the thing you SEE be the car the level named,
// rather than the procedural wedge `car.ts` has always drawn.
//
// THE MODEL DOES NOT DECIDE THE SIZE — THE DOCUMENT DOES.
//
// That is the whole design decision here and it is worth the paragraph. A reconstructed car arrives
// at whatever scale TRELLIS happened to produce, facing whatever way the exporter felt like, with
// its origin wherever the mesh happened to be centred. If the physics took its dimensions from the
// model, every asset would handle differently for reasons nobody authored — a car that reconstructed
// 15% large would corner like a bus and nothing would say why.
//
// So the chassis is the document's (`spec.length`, `width`, `height`, `wheelbase`, `track`) and the
// model is SCALED AND SEATED to match it: uniformly, by the ratio that makes its longest horizontal
// axis the document's length, then dropped so its lowest point sits at the wheels' contact plane.
// A model that is the wrong shape then looks wrong, which is a thing you can see and fix, instead of
// driving wrong, which is not.
//
// UNRIGGED IS FIRST CLASS. Every one of the library's 120 vehicles has `skins: 0` — not missing
// metadata, the files have no bones. Nothing here reads a rig, asks for one, or refuses a model that
// has none; the wheels simply do not turn, which is what the editor's Stage panel already says.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { applyAlphaGlazing } from './glazing'
import { applyCarShine } from './shading'
import { assetsvc, MESH_FILE, type AssetItem, type MeshVariant } from './assetsvc'
import type { VehicleChassis } from './vehicles'

export interface CarModel {
  /** the fitted model, ready to be parented to the car's mesh group */
  object: THREE.Object3D
  /** which file it came from */
  variant: MeshVariant
  /** the model's own size before fitting, m — for a readout that explains a bad scale */
  rawSize: { x: number; y: number; z: number }
  /** what it was multiplied by to become the document's car */
  scale: number
  /** how many materials `applyAlphaGlazing` turned into real glass */
  glazed: number
}

let loader: GLTFLoader | null = null

/**
 * One loader, built lazily.
 *
 * DRACO IS MANDATORY AND FAILS SILENTLY: `finish.mjs` emits Draco-compressed glb, and `GLTFLoader`
 * without a working `DRACOLoader` does not warn — it rejects, and an empty car looks exactly like a
 * car that has not loaded yet. Same decoder path as `ui/meshview.ts`, because there should be one.
 */
function gltf(): GLTFLoader {
  if (!loader) {
    const draco = new DRACOLoader().setDecoderPath('/assets/vendor/draco/')
    loader = new GLTFLoader().setDRACOLoader(draco)
  }
  return loader
}

/**
 * Which mesh file to load.
 *
 * A vehicle can name `finished` or `raw`. Anything else, including a wish for a file this asset
 * does not have, keeps the old rule: the finished mesh when it exists, otherwise the raw one.
 */
export function meshVariantOf(item: AssetItem, want?: 'finished' | 'raw' | null): MeshVariant | null {
  const finished = !!item.finished
  const raw = !!item.mesh
  if (want === 'raw' && raw) return 'raw'
  if (want === 'finished' && finished) return 'finished'
  if (finished) return 'finished'
  if (raw) return 'raw'
  return null
}

/**
 * Load an asset's model and fit it to a chassis.
 *
 * Returns null for every ordinary reason it might not work — no asset service, no such asset, no
 * mesh on it, a file that will not decode — because a level that names a car the library cannot
 * produce must still be driveable. The caller shows the procedural body and says so.
 */
export async function loadCarModel(assetId: string, spec: VehicleChassis, mesh?: 'finished' | 'raw' | null): Promise<CarModel | null> {
  let item: AssetItem | null = null
  try {
    item = await assetsvc.get(assetId)
  } catch {
    return null
  }
  const variant = item ? meshVariantOf(item, mesh) : null
  if (!item || !variant) return null

  let root: THREE.Object3D
  try {
    const url = assetsvc.fileUrl(item.id, MESH_FILE[variant])
    const g = await gltf().loadAsync(url)
    root = g.scene
  } catch {
    return null
  }

  /*
   * GLASS BEFORE FITTING, because it replaces materials and nothing about it depends on the
   * transform. TRELLIS writes the window mask into the base colour texture's ALPHA and exports
   * `alphaMode: OPAQUE`, so it is in every asset and nothing ever switched it on —
   * `applyAlphaGlazing` is the editor lane's answer to that, and it is why a car stops having
   * painted-on black windows. It is idempotent and a no-op on anything with no transparent texels.
   */
  const glazed = applyAlphaGlazing(root).glazed
  // the asset's own orientation, under everything the fitter does: it says which way the front is
  const declared = orientAsset(root, item)
  if (declared) { const wrap = new THREE.Group(); wrap.add(root); root = wrap }

  // What we were given, before anything is done to it.
  const box = new THREE.Box3().setFromObject(root)
  const raw = new THREE.Vector3()
  box.getSize(raw)
  if (!(raw.x > 0 && raw.y > 0 && raw.z > 0)) return null

  const fit = fitToChassis(root, spec, { declared })
  const holder = new THREE.Group()
  holder.name = `car:${assetId}`
  holder.add(root)
  applyCarShine(holder)

  return { object: holder, variant, rawSize: { x: raw.x, y: raw.y, z: raw.z }, scale: fit.scale, glazed }
}

/**
 * Scale a loaded model to the document's car and seat it on the wheels' contact plane.
 *
 * SEPARATE AND PURE, so the arithmetic can be checked without a loader, a network or a glb — which
 * matters because this box is not running the asset service and the fitting is the part with real
 * logic in it. Mutates `object` and reports what it did.
 *
 * The model's LONGEST HORIZONTAL axis is taken as its length, whichever way the exporter faced it,
 * and the scale is uniform: a per-axis fit would stretch a car that reconstructed slightly the wrong
 * shape into one that is definitely the wrong shape, and hide the problem while doing it.
 *
 * The nose is NOT inferred. Nothing in a mesh says which end is the front, and guessing gets it
 * backwards half the time; a car facing the wrong way is visible in a second and belongs in a field
 * on the document, not in a heuristic here.
 */
/**
 * Any finished catalog asset as an object, fitted to a height. For fixtures: a sign, a pole, a
 * gate — things with a height on the spec sheet and no chassis. Null for every ordinary reason.
 */
export async function loadAssetGlb(assetId: string, heightM?: number): Promise<THREE.Object3D | null> {
  let item: AssetItem | null = null
  try { item = await assetsvc.get(assetId) } catch { return null }
  const variant = item ? meshVariantOf(item) : null
  if (!item || !variant) return null
  let root: THREE.Object3D
  try { root = (await gltf().loadAsync(assetsvc.fileUrl(item.id, MESH_FILE[variant]))).scene } catch { return null }
  applyAlphaGlazing(root)
  orientAsset(root, item)
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  if (!(size.y > 1e-6)) return null
  const k = heightM ? heightM / size.y : 1
  root.scale.setScalar(k)
  root.updateMatrixWorld(true)
  const fitted = new THREE.Box3().setFromObject(root)
  const c = fitted.getCenter(new THREE.Vector3())
  root.position.set(-c.x, -fitted.min.y, -c.z)
  const holder = new THREE.Group()
  holder.name = `fixture:${assetId}`
  holder.add(root)
  return holder
}

/**
 * Turn a loaded model the way its asset record says (`AssetItem.orient`), about its up axis.
 * Returns whether the record said anything — a model that has been oriented on purpose has a
 * known front, and nothing downstream should guess at it.
 */
export function orientAsset(root: THREE.Object3D, item: AssetItem | null | undefined): boolean {
  const yaw = item?.orient?.yaw_deg
  if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return false
  root.rotation.y = (yaw * Math.PI) / 180
  root.updateMatrixWorld(true)
  return true
}

export function fitToChassis(object: THREE.Object3D, spec: VehicleChassis, opts: { declared?: boolean } = {}): { scale: number; rawSize: THREE.Vector3 } {
  object.position.set(0, 0, 0)
  object.scale.setScalar(1)
  object.rotation.set(0, 0, 0)
  object.updateMatrixWorld(true)
  const raw = new THREE.Vector3()
  new THREE.Box3().setFromObject(object).getSize(raw)
  const longest = Math.max(raw.x, raw.z)
  /*
   * THE LENGTH GOES ALONG THE NOSE AXIS. The car frame is nose +X, and these reconstructions are
   * long along Z — so every model was fitted to the right size and mounted a quarter turn off.
   * Rich, 2026-09-30, with a screenshot of a whole jam parked across its lanes: *"every single
   * car in the game is sideways."* Turn the long axis onto X first; then decide which end is the
   * front, which the geometry can only guess at (see `noseSign`) and the spec can overrule.
   */
  // an asset that has been oriented on purpose already has its front along +X; only a model
  // nobody has looked at gets turned and guessed
  if (!opts.declared && raw.z > raw.x) object.rotation.y = Math.PI / 2
  object.updateMatrixWorld(true)
  const guess = spec.nose === 'keep' ? 1 : spec.nose === 'flip' ? -1 : opts.declared ? 1 : noseSign(object)
  if (guess < 0) object.rotation.y += Math.PI
  object.updateMatrixWorld(true)
  const want = spec.length ?? spec.wheelbase * 1.6
  const scale = longest > 1e-6 ? want / longest : 1
  object.scale.setScalar(scale)
  object.updateMatrixWorld(true)

  // Seat it: centred on the chassis in plan, sitting ON the contact plane rather than through it.
  // `car.ts` builds its own model with the wheel contact plane at local y = 0, and everything placed
  // against that frame — the chase camera, the cockpit eye, the headlight beams — depends on it.
  const fitted = new THREE.Box3().setFromObject(object)
  const centre = new THREE.Vector3()
  fitted.getCenter(centre)
  object.position.set(-centre.x, -fitted.min.y, -centre.z)
  object.updateMatrixWorld(true)
  return { scale, rawSize: raw }
}

/**
 * Which end of a car is the front: +1 for the +X end as it stands, −1 for the other.
 *
 * FROM THE WHEELS. The front overhang — bumper to front axle — is shorter than the rear one on
 * nearly every road vehicle: a saloon, a hatch, a van, a pickup with a bed behind its cab, a bus
 * with its engine at the back. The tyres are the lowest thing on the model, so the outermost
 * points of the bottom band are the axles, near enough, and the shorter gap from axle to body end
 * is the nose. The roofline breaks a tie (a raked windscreen climbs more gently than a tail), and
 * it was the first guess on its own: right for the cars, wrong for the pickup and both buses,
 * whose blunt ends have no climb to measure. Farm machinery is anyone's guess; `spec.nose` exists.
 */
export function noseSign(object: THREE.Object3D): 1 | -1 {
  const box = new THREE.Box3().setFromObject(object)
  const len = box.max.x - box.min.x
  const height = box.max.y - box.min.y
  if (!(len > 0) || !(height > 0)) return 1
  const BINS = 40
  const top = new Float32Array(BINS).fill(-Infinity)
  // the bottom band, binned along the length: tyres are dense clusters of low points, a tow
  // hitch or a rear step is a few — so the axles are the outermost DENSE bins, not the outermost points
  const low = new Uint32Array(BINS)
  const floor = box.min.y + height * 0.07
  const v = new THREE.Vector3()
  object.updateMatrixWorld(true)
  object.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry?.attributes?.position) return
    const pos = m.geometry.attributes.position
    const step = Math.max(1, Math.floor(pos.count / 40000))
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      const b = Math.min(BINS - 1, Math.max(0, Math.floor(((v.x - box.min.x) / len) * BINS)))
      if (v.y > top[b]) top[b] = v.y
      if (v.y <= floor) low[b]++
    }
  })
  let peak = 0
  for (const n of low) peak = Math.max(peak, n)
  let wheelMin = Infinity
  let wheelMax = -Infinity
  for (let b = 0; b < BINS; b++) {
    if (low[b] < peak * 0.35) continue
    const x = box.min.x + ((b + 0.5) / BINS) * len
    if (x < wheelMin) wheelMin = x
    if (x > wheelMax) wheelMax = x
  }
  if (peak > 0 && Number.isFinite(wheelMin) && Number.isFinite(wheelMax) && wheelMax - wheelMin > len * 0.3) {
    const lowOver = wheelMin - box.min.x // body beyond the −X axle
    const highOver = box.max.x - wheelMax // body beyond the +X axle
    const diff = highOver - lowOver
    if (Math.abs(diff) > len * 0.03) return diff > 0 ? -1 : 1 // the shorter overhang is the front
  }
  // the roofline: the steepest climb from each end, skipping the bumper's own step at the very end
  const climb = (from: number, dir: 1 | -1) => {
    let worst = 0
    for (let k = 3; k < BINS * 0.45; k++) {
      const a = top[from + (k - 1) * dir], b = top[from + k * dir]
      if (Number.isFinite(a) && Number.isFinite(b)) worst = Math.max(worst, b - a)
    }
    return worst
  }
  return climb(0, 1) <= climb(BINS - 1, -1) ? -1 : 1
}
