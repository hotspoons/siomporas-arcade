// THE BAKE, as numbers rather than as a render.
//
// A sprite in this game is a photograph of a model: the atlas stands the model on its feet, puts a
// long lens a few subject-widths back at a chosen yaw and pitch, and keeps the picture. Everything
// about how that photograph is framed — how far back the camera goes, how wide it opens, where the
// model's feet land in the frame — lives here, and BOTH the thing that bakes the atlas and the thing
// that re-bakes a model live in front of the player read it from here.
//
// It is one file because the alternative was two copies of the same arithmetic, and two copies is how
// a live-baked model ends up nearly-but-not-quite its own sprite: a hair wider, a hair lower, its
// nose a little more in your face. There is no "nearly" available — the live pass has to be able to
// replace the atlas outright, which means the same numbers, not equivalent ones.

import { Box3, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three'
import { orient, type ModelDef } from './models'

/** How far up the model counts as "the part touching the ground" when centring it on its feet. */
const FOOT_BAND = 0.1
/** The lens: how many subject-widths back the camera stands. Long, so a sprite reads as a photo. */
export const LENS = 6.5

/** The model as the bake leaves it, and the size the framing is measured from. */
export interface Fitted {
  /** Standing on y = 0, centred on its footprint, scaled to the manifest's height. */
  model: Object3D
  /** Extents about that origin: x and z are full widths about the origin, y is the height. */
  fs: Vector3
  /** The part touching the ground — what has to clear the tarmac (see roadside-check.mjs). */
  foot: { w: number; d: number }
}

/** How the camera is set for one view of a fitted model, and how the frame it produces is measured. */
export interface BakeView {
  /** Distance from the model's centre of interest to the camera. */
  dist: number
  /** Half the frame's world size at the model's centre plane — the frame is `half * 2` metres square. */
  half: number
  /** Half the model's own extent in this view, before the frame opens up for the near end. */
  subject: number
  /** How much bigger the near end projects than the centre plane does. */
  nearMag: number
  /** Vertical field of view, degrees. */
  fov: number
  near: number
  far: number
  /** Camera position, and the point it looks at, in the fitted model's own space. */
  eye: Vector3
  at: Vector3
  /** Where the model's ground contact sits in the frame, 0 = bottom, 1 = top. */
  baseline: number
}

/** The part of the model touching the ground, so it is centred on its feet and not on its bounding box. */
function footprint(model: Object3D): { x: number; z: number; w: number; d: number } {
  const box = new Box3().setFromObject(model)
  const band = box.min.y + (box.max.y - box.min.y) * FOOT_BAND
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const v = new Vector3()
  model.updateMatrixWorld(true)
  model.traverse((o) => {
    const mesh = o as Mesh
    const pos = mesh.isMesh ? mesh.geometry?.getAttribute('position') : null
    if (!pos) return
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as never, i).applyMatrix4(mesh.matrixWorld)
      if (v.y > band) continue
      if (v.x < minX) minX = v.x
      if (v.x > maxX) maxX = v.x
      if (v.z < minZ) minZ = v.z
      if (v.z > maxZ) maxZ = v.z
    }
  })
  if (minX === Infinity) return { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2, w: box.max.x - box.min.x, d: box.max.z - box.min.z }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ }
}

/**
 * Stand a loaded model up the way the bake does: flat-shaded, turned to face the way its kind should
 * face, scaled to the manifest's height, feet on y = 0 and centred over them.
 *
 * CENTRE ON THE FOOTPRINT, NOT THE BOUNDING BOX. A sprite is drawn by its bottom centre, so whatever
 * this calls the centre is where the game believes the object stands. The bounding box is the wrong
 * answer for anything whose mass is not over its feet — a palm leaning its crown one way, a billboard
 * whose board overhangs its posts — and all of those plant their feet to one side of where the world
 * put them, which is how trees ended up standing in the road.
 */
export function fitModel(raw: Object3D, def: ModelDef): Fitted {
  raw.traverse((o) => {
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
  const model = orient(raw, def)
  // A wrapper, so a caller can pose the whole thing without disturbing the fit.
  const holder = new Group()
  holder.add(model)
  const box = new Box3().setFromObject(model)
  const size = box.getSize(new Vector3())
  const scale = (def.heightM / Math.max(1e-3, size.y)) * (def.fit ?? 1)
  model.scale.setScalar(scale)
  // `footprint` reads world positions, so what it returns is ALREADY in scaled units — the scale was
  // set on the line above. Multiplying by it again displaces every model by its own foot offset times
  // the scale factor, which for a ten-metre palm off a unit-tall .glb is a factor of ten.
  const foot = footprint(model)
  model.position.set(-foot.x, -box.min.y * scale, -foot.z)
  const fitted = new Box3().setFromObject(model)
  const fs = fitted.getSize(new Vector3())
  // Half-extents measured about the NEW origin rather than the box centre: an object centred on its
  // feet can reach further one way than the other, and a frame sized from the box would clip the
  // overhang off.
  fs.x = 2 * Math.max(Math.abs(fitted.min.x), Math.abs(fitted.max.x))
  fs.z = 2 * Math.max(Math.abs(fitted.min.z), Math.abs(fitted.max.z))
  return { model: holder, fs, foot: { w: foot.w, d: foot.d } }
}

/**
 * How to photograph a fitted model from `yawDeg` around and `pitchDeg` above.
 *
 * The frame is fitted to what this view actually shows — a car from behind is half as wide as from
 * the side — so the cell's pixels go on the car and not on empty margin. Perspective, not
 * orthographic: an ortho bake gives the near and far ends of a car exactly the same width, which is
 * what makes a sprite read as a technical drawing rather than as a photograph of a model, and
 * photographs of models is what the arcade sprites of the era were.
 */
export function bakeView(fs: Vector3, yawDeg: number, pitchDeg: number): BakeView {
  const yawR = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const projW = Math.abs(Math.cos(yawR)) * fs.x + Math.abs(Math.sin(yawR)) * fs.z
  const projD = Math.abs(Math.sin(yawR)) * fs.x + Math.abs(Math.cos(yawR)) * fs.z
  const halfW = Math.max(projW / 2, fs.y / 2) * 1.02
  const halfH = (fs.y / 2) * 1.02 + Math.sin(pitch) * (projD / 2)
  const subject = Math.max(halfW, halfH)
  const dist = subject * LENS
  // The near half of the model projects larger than the centre plane does, so the frame has to open
  // up by that much or the nose comes off against the edge of the cell.
  const half = subject * (dist / Math.max(dist * 0.4, dist - projD / 2))
  const horiz = dist * Math.cos(pitch)
  return {
    dist,
    half,
    subject,
    nearMag: half / subject,
    fov: 2 * Math.atan(half / dist) * (180 / Math.PI),
    near: dist * 0.15,
    far: dist + projD + fs.y + 10,
    eye: new Vector3(Math.sin(yawR) * horiz, fs.y / 2 + Math.sin(pitch) * dist, -Math.cos(yawR) * horiz),
    at: new Vector3(0, fs.y / 2, 0),
    baseline: 0.5 - fs.y / 2 / (half * 2) - ((Math.sin(pitch) * projD) / 2 / (half * 2)) * 0.5,
  }
}
