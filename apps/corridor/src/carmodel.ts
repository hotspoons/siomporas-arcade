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

/** Which mesh file to prefer: the finished one, else the raw reconstruction. */
function variantOf(item: AssetItem): MeshVariant | null {
  if (item.finished) return 'finished'
  if (item.mesh) return 'raw'
  return null
}

/**
 * Load an asset's model and fit it to a chassis.
 *
 * Returns null for every ordinary reason it might not work — no asset service, no such asset, no
 * mesh on it, a file that will not decode — because a level that names a car the library cannot
 * produce must still be driveable. The caller shows the procedural body and says so.
 */
export async function loadCarModel(assetId: string, spec: VehicleChassis): Promise<CarModel | null> {
  let item: AssetItem | null = null
  try {
    item = await assetsvc.get(assetId)
  } catch {
    return null
  }
  const variant = item ? variantOf(item) : null
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

  // What we were given, before anything is done to it.
  const box = new THREE.Box3().setFromObject(root)
  const raw = new THREE.Vector3()
  box.getSize(raw)
  if (!(raw.x > 0 && raw.y > 0 && raw.z > 0)) return null

  const fit = fitToChassis(root, spec)
  const holder = new THREE.Group()
  holder.name = `car:${assetId}`
  holder.add(root)

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
export function fitToChassis(object: THREE.Object3D, spec: VehicleChassis): { scale: number; rawSize: THREE.Vector3 } {
  object.position.set(0, 0, 0)
  object.scale.setScalar(1)
  object.updateMatrixWorld(true)
  const raw = new THREE.Vector3()
  new THREE.Box3().setFromObject(object).getSize(raw)
  const longest = Math.max(raw.x, raw.z)
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
