// Scenery pieces from the editor: water, tree clusters, buildings, a gas
// station. Cheap low-poly meshes, instanced where there are many, rebuilt
// with the track. Placement comes from sim/decor.ts so the sim's collision
// boxes and what you see are the same thing.

import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three'
import { solidsOf, treesIn } from '../sim/decor'
import { PIECE_BY_TYPE, rotatedSize } from '../sim/pieces'
import type { Track } from '../sim/Track'
import { CELL } from '../sim/Tuning'

const mat = (color: number, extra: Partial<MeshStandardMaterial> = {}) => new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, flatShading: true, ...extra })

export class Scenery {
  readonly root = new Group()
  private built: Mesh[] = []
  private readonly water = mat(0x2f7fbf, { emissive: new Color(0x0c2a48), emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.2 })
  private readonly trunk = mat(0x6a4a2a)
  private readonly leaf = mat(0x2f8a3a)
  private readonly leaf2 = mat(0x3fa04a)
  private readonly wall = mat(0xb8bcc8)
  private readonly window = mat(0x2a3a52, { emissive: new Color(0x1a2a44), emissiveIntensity: 0.6 })
  private readonly roof = mat(0x5a5e6a)
  private readonly canopy = mat(0xf0e6d0)
  private readonly post = mat(0x8a8f9a)
  private readonly pump = mat(0xd83a2a)
  private readonly kiosk = mat(0xe8e4d8)

  build(track: Track): void {
    this.clear()
    const treeM: Matrix4[] = []
    const leafM: Matrix4[] = []
    const m = new Matrix4()
    const q = new Quaternion()
    const p = new Vector3()
    const s = new Vector3()
    for (const piece of track.decor) {
      const def = PIECE_BY_TYPE[piece.type]
      const size = rotatedSize(def, piece.rot)
      const cx = (piece.x + size.w / 2) * CELL
      const cz = (piece.z + size.h / 2) * CELL
      const y = piece.level * 8 + (piece.level === 0 ? track.groundHeight(cx, cz) : 0)
      switch (def.decor) {
        case 'water': {
          const w = new Mesh(new PlaneGeometry(size.w * CELL, size.h * CELL), this.water)
          w.rotation.x = -Math.PI / 2
          // A shade above grade: the flat ground plane and the heightfield both sit within a few
          // centimetres of it, and water below them simply disappears.
          w.position.set(cx, y + 0.03, cz)
          this.add(w)
          break
        }
        case 'trees':
          for (let dx = 0; dx < size.w; dx++)
            for (let dz = 0; dz < size.h; dz++)
              for (const t of treesIn(piece.x + dx, piece.z + dz)) {
                p.set(t.x, y + t.h * 0.25, t.z)
                s.set(t.r * 0.35, t.h * 0.5, t.r * 0.35)
                treeM.push(m.compose(p, q, s).clone())
                p.set(t.x, y + t.h * 0.5 + t.h * 0.3, t.z)
                s.set(t.r, t.h * 0.6, t.r)
                leafM.push(m.compose(p, q, s).clone())
              }
          break
        case 'building': {
          const solid = solidsOf(piece)[0]
          const bw = solid.hw * 2
          const bd = solid.hh * 2
          const h = solid.height
          const b = new Mesh(new BoxGeometry(bw, h, bd), this.wall)
          b.position.set(solid.x, y + h / 2, solid.z)
          this.add(b)
          const r = new Mesh(new BoxGeometry(bw + 0.6, 0.6, bd + 0.6), this.roof)
          r.position.set(solid.x, y + h + 0.3, solid.z)
          this.add(r)
          // Window bands on all four faces.
          for (let k = 1; k < h / 3.2; k++) {
            const band = new Mesh(new BoxGeometry(bw + 0.1, 1.2, bd + 0.1), this.window)
            band.position.set(solid.x, y + k * 3.2, solid.z)
            this.add(band)
          }
          break
        }
        case 'gas': {
          const solids = solidsOf(piece)
          for (const so of solids) {
            if (so.kind === 'post') {
              const c = new Mesh(new CylinderGeometry(0.35, 0.35, so.height, 8), this.post)
              c.position.set(so.x, y + so.height / 2, so.z)
              this.add(c)
            } else if (so.kind === 'pump') {
              const c = new Mesh(new BoxGeometry(so.hw * 2, so.height, so.hh * 2), this.pump)
              c.position.set(so.x, y + so.height / 2, so.z)
              this.add(c)
            } else {
              const c = new Mesh(new BoxGeometry(so.hw * 2, so.height, so.hh * 2), this.kiosk)
              c.position.set(so.x, y + so.height / 2, so.z)
              this.add(c)
            }
          }
          // Canopy over the posts.
          const posts = solids.filter((so) => so.kind === 'post')
          if (posts.length) {
            const minX = Math.min(...posts.map((o) => o.x))
            const maxX = Math.max(...posts.map((o) => o.x))
            const minZ = Math.min(...posts.map((o) => o.z))
            const maxZ = Math.max(...posts.map((o) => o.z))
            const c = new Mesh(new BoxGeometry(maxX - minX + 8, 0.7, maxZ - minZ + 8), this.canopy)
            c.position.set((minX + maxX) / 2, y + posts[0].height + 0.35, (minZ + maxZ) / 2)
            this.add(c)
            const stripe = new Mesh(new BoxGeometry(maxX - minX + 8.2, 0.3, maxZ - minZ + 8.2), this.pump)
            stripe.position.set((minX + maxX) / 2, y + posts[0].height - 0.2, (minZ + maxZ) / 2)
            this.add(stripe)
          }
          void cx
          void cz
          break
        }
      }
    }
    if (treeM.length) {
      const trunks = new InstancedMesh(new CylinderGeometry(1, 1.2, 1, 6), this.trunk, treeM.length)
      treeM.forEach((mm, i) => trunks.setMatrixAt(i, mm))
      trunks.instanceMatrix.needsUpdate = true
      this.add(trunks)
      const leaves = new InstancedMesh(new ConeGeometry(1, 1, 7), this.leaf, leafM.length)
      leafM.forEach((mm, i) => leaves.setMatrixAt(i, mm))
      leaves.instanceMatrix.needsUpdate = true
      this.add(leaves)
      void this.leaf2
    }
  }

  private add(mesh: Mesh): void {
    mesh.castShadow = false
    this.root.add(mesh)
    this.built.push(mesh)
  }

  clear(): void {
    for (const b of this.built) {
      this.root.remove(b)
      b.geometry.dispose()
    }
    this.built = []
  }
}
