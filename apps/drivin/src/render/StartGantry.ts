// Start / finish gantry: two posts and a beam wearing a chequered banner,
// straddling the road on the start piece.

import { BoxGeometry, CanvasTexture, Group, Mesh, MeshStandardMaterial, NearestFilter, PlaneGeometry, Vector3 } from 'three'
import type { LaneFrame } from '../sim/PathTable'
import { ROAD_HALF_WIDTH } from '../sim/Tuning'

export function buildStartGantry(f: LaneFrame): Group {
  const g = new Group()
  const post = new MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.5, metalness: 0.3 })
  const halfSpan = ROAD_HALF_WIDTH + 2.2
  const height = 7
  const right = new Vector3(f.right.x, f.right.y, f.right.z)
  const up = new Vector3(f.up.x, f.up.y, f.up.z)
  const tan = new Vector3(f.tan.x, f.tan.y, f.tan.z)
  const base = new Vector3(f.pos.x, f.pos.y, f.pos.z)
  for (const side of [-1, 1]) {
    const p = new Mesh(new BoxGeometry(0.5, height, 0.5), post)
    p.position.copy(base).addScaledVector(right, side * halfSpan).addScaledVector(up, height / 2)
    g.add(p)
  }
  const beam = new Mesh(new BoxGeometry(halfSpan * 2 + 0.5, 0.5, 0.6), post)
  beam.position.copy(base).addScaledVector(up, height)
  g.add(beam)
  // Chequered banner hanging from the beam, facing both ways.
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 32
  const ctx = c.getContext('2d')!
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'
    ctx.fillRect(x * 8, y * 8, 8, 8)
  }
  const tex = new CanvasTexture(c)
  tex.magFilter = tex.minFilter = NearestFilter
  const banner = new Mesh(new PlaneGeometry(halfSpan * 2 - 1, 1.6), new MeshStandardMaterial({ map: tex, roughness: 0.9, side: 2 }))
  banner.position.copy(base).addScaledVector(up, height - 1.1)
  g.add(banner)
  // Orient the flat pieces to the lane frame: x along right (across the road), y up. The third axis must
  // make a right-handed basis (right × up = -tan) or the quaternion comes out a quarter turn off.
  const m = g.matrix
  m.makeBasis(right, up, tan.clone().negate())
  for (const child of g.children) {
    // Children were positioned in world space already; only the flat pieces need rotating.
    if (child === banner || child === beam) child.quaternion.setFromRotationMatrix(m)
  }
  return g
}
