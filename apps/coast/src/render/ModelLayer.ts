// Draws the real meshes where the sprites would go.
//
// The game is sprite scaling by design — that is the look — but the models behind the sprites are
// real, and it is worth being able to see them in the road rather than in a viewer. So this is the
// same frame the sprite pass produces, with every quad replaced by the mesh it was baked from:
// same screen position, same size, same pose, in the same screen-space scene. Off by default; the
// tuning panel's MODELS_3D turns it on.
//
// It is not a second renderer. Poses come out of the same numbers the sprite pass computes, and the
// only thing the meshes get that a sprite cannot is a continuous angle instead of the nearest baked
// one — which is exactly the comparison worth looking at.

import { AmbientLight, Box3, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { MODELS, type ModelDef } from './models'

const DEG = Math.PI / 180
/** Half the camera's z range, shared out among the meshes in a frame. */
const Z_RANGE = 30000

/**
 * The bake's normalisation, so a mesh here is the size the sprite of it would have been: scaled to
 * the manifest's height in metres, standing on y = 0, centred over its own footprint.
 */
function normalise(model: Object3D, def: ModelDef): Object3D {
  model.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const sm = mat as MeshStandardMaterial
      if (sm.isMeshStandardMaterial) {
        sm.flatShading = true
        sm.metalness = Math.min(sm.metalness, 0.2)
        sm.needsUpdate = true
      }
    }
  })
  const box = new Box3().setFromObject(model)
  const size = box.getSize(new Vector3())
  const scale = (def.heightM / Math.max(1e-3, size.y)) * (def.fit ?? 1)
  model.scale.setScalar(scale)
  model.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale)
  // A wrapper, so instances can be posed without disturbing the fit.
  const holder = new Group()
  holder.add(model)
  return holder
}

export class ModelLayer {
  readonly group = new Group()
  /** One prototype per kind; instances clone it and share its geometry and materials. */
  private readonly protos = new Map<string, Object3D>()
  private readonly pools = new Map<string, Object3D[]>()
  private readonly cursor = new Map<string, number>()
  private z = 0
  private screenW = 800
  private screenH = 448
  ready = false
  private loading = false

  constructor() {
    // The bake's lights, so a mesh here is shaded the way its sprite was.
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(3, 6, 4)
    this.group.add(new AmbientLight(0xffffff, 0.35), new HemisphereLight(0xffffff, 0x8080a0, 0.7), sun)
    this.group.visible = false
  }

  /**
   * Load every model in the manifest. The atlas throws its copies away once they are baked — and when
   * the atlas comes back from the browser's cache it never loads any at all — so this is a second,
   * deliberate load, paid for only by someone who asks for it.
   */
  async load(): Promise<void> {
    if (this.ready || this.loading) return
    this.loading = true
    const loader = new GLTFLoader()
    for (const def of MODELS) {
      try {
        const model = def.file ? (await loader.loadAsync(def.file)).scene : def.build?.()
        if (model) this.protos.set(def.kind, normalise(model, def))
      } catch (err) {
        console.warn(`3D models: ${def.kind} would not load; it keeps its sprite`, err)
      }
    }
    this.loading = false
    this.ready = true
  }

  /** The logical screen, for the size and position sanity checks below. */
  begin(w: number, h: number): void {
    this.cursor.clear()
    this.screenW = w
    this.screenH = h
    // Ordering is by real depth: each mesh gets a slab of the camera's z range roughly as deep as its
    // own geometry, handed out in the order the sprite pass draws — far first.
    this.z = -Z_RANGE
  }

  /**
   * Pose one mesh where its sprite would have been drawn: ground contact at screen (`x`, `y`), the
   * frame `h` pixels tall for `frameHeightM` metres of it, seen from `yawDeg` / `pitchDeg` and leaning
   * by `roll`. Returns false when this kind has no mesh loaded, so the caller can draw the sprite.
   */
  add(kind: string, x: number, y: number, h: number, frame: { heightM: number; nearMag?: number }, yawDeg: number, pitchDeg: number, roll: number): boolean {
    const proto = this.protos.get(kind)
    if (!proto || h <= 0) return false
    // The near field is where this stops being a comparison. A sprite whose quad is four screens tall
    // and half a screen off the side costs nothing and shows a sliver of trunk; the same thing as
    // geometry is a mesh the size of a stadium leaning over the road, and it eats the whole z range
    // the rest of the frame has to share. Those keep their sprites.
    if (h > this.screenH * 2.5 || x < -this.screenW || x > this.screenW * 2) return false
    let pool = this.pools.get(kind)
    if (!pool) {
      pool = []
      this.pools.set(kind, pool)
    }
    const i = this.cursor.get(kind) ?? 0
    this.cursor.set(kind, i + 1)
    let obj = pool[i]
    if (!obj) {
      obj = proto.clone()
      // Over the road and the sprites, like a sprite would be. renderOrder does not reach a group's
      // children, so leaving it at zero paints every mesh *under* the road it is standing on.
      obj.traverse((o) => (o.renderOrder = 6))
      obj.userData.kind = kind
      pool.push(obj)
      this.group.add(obj)
    }
    obj.visible = true
    // Sized as the sprite is: pixels to the metre at the frame's centre plane, times half the lens
    // magnification — the sprite's near end is `nearMag` bigger than its far end, and a flat mesh can
    // only pick one number out of that gradient. The middle of it is what matches by eye.
    const mag = 1 + ((frame.nearMag ?? 1) - 1) * 0.5
    obj.scale.setScalar((h / Math.max(1e-3, frame.heightM)) * mag)
    // Yaw turns the mesh to face the way the bake camera stood (which is behind the car, hence the
    // half turn); pitch tips it towards the viewer the way a camera above the road sees it; roll is
    // the bank. Applied in that order, in world space, about the ground contact.
    obj.rotation.order = 'ZXY'
    obj.rotation.set(pitchDeg * DEG, (yawDeg + 180) * DEG, roll)
    this.z += Math.min(h * 1.2 + 3, 240)
    obj.position.set(x, y, this.z)
    return true
  }

  end(): void {
    for (const [kind, pool] of this.pools) {
      const used = this.cursor.get(kind) ?? 0
      for (let i = used; i < pool.length; i++) pool[i].visible = false
    }
  }
}
