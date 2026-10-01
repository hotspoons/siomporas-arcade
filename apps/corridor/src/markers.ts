// The posts a level start uses — a ring on the ground, a stake, a head — drawn for anything a
// game asks the player to drive to. Pickup and drop-off use the same prop as a start, in their
// own colour. The editor's point tool draws the same shapes; this is the copy that exists while
// you are playing.
import * as THREE from 'three'

const COLOUR: Record<string, number> = {
  home: 0xffd54f,
  start: 0x4fc3f7,
  finish: 0xff8a65,
  checkpoint: 0xb39ddb,
  pickup: 0x81c784,
  dropoff: 0xffb74d,
  goal: 0xfff176,
  spot: 0xa5d6a7,
}

export interface Mark {
  id: string
  x: number
  y: number
  kind: string
}

export class ZoneMarks {
  readonly group = new THREE.Group()
  private readonly byId = new Map<string, THREE.Group>()
  private readonly ring = new THREE.RingGeometry(2.2, 2.8, 28)
  private readonly post = new THREE.CylinderGeometry(0.12, 0.12, 3, 6)
  private readonly head = new THREE.SphereGeometry(0.7, 10, 8)

  constructor() {
    this.group.name = 'zone-marks'
  }

  set(id: string, at: { x: number; y: number }, kind: string, z: number): void {
    this.remove(id)
    const colour = COLOUR[kind] ?? COLOUR.spot
    const g = new THREE.Group()
    g.name = id
    g.userData.kind = kind
    const mat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.9 })
    const ring = new THREE.Mesh(this.ring, new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.4, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.15
    ring.renderOrder = 10
    const stake = new THREE.Mesh(this.post, mat)
    stake.position.y = 1.5
    stake.renderOrder = 11
    const top = new THREE.Mesh(this.head, mat)
    top.position.y = 3.2
    top.renderOrder = 12
    g.add(ring, stake, top)
    g.position.set(at.x, z, -at.y)
    this.group.add(g)
    this.byId.set(id, g)
  }

  remove(id: string): void {
    const g = this.byId.get(id)
    if (!g) return
    this.group.remove(g)
    this.byId.delete(id)
  }

  clear(): void {
    for (const id of [...this.byId.keys()]) this.remove(id)
  }

  list(): Mark[] {
    const out: Mark[] = []
    for (const [id, g] of this.byId) out.push({ id, x: g.position.x, y: -g.position.z, kind: (g.userData.kind as string) || 'spot' })
    return out
  }
}
