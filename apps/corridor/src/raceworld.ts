// The race, in a running world: the throbber on the ground, the gates in the air, and the readout.
//
// Rich, 2026-09-29: *"Think race areas in Forza Horizon where you drive into a throbber and you
// enter the race."*
//
// `racerun.ts` owns the SESSION and knows nothing about a screen; this is the half that draws — a
// pulsing ring at each entry, a banner across each gate, and a small panel of text. Split that way
// because the session is the part with rules in it and the rules are worth testing without a
// browser, and because a headless probe wants to drive a race without loading a renderer.
//
// THE THROBBER IS A RING, NOT A MODEL. It has to be legible from a hundred metres out and from
// inside a car at speed, it has to work on tarmac, grass and gravel, and it has to be obviously not
// part of the world. A bright annulus that breathes does all four; anything more detailed reads as
// scenery, which is the one thing it must not.

import * as THREE from 'three'
import { RaceSession, type RaceOpts, type RaceState, type RaceTick } from './racerun'
import { gateWidth, midpoint, type Course, type CourseDoc, type Gate } from './races'

const ENTRY_COLOUR = 0x3ddc84
const GATE_COLOUR = 0xffd400
const NEXT_COLOUR = 0x2ee6c0

export interface RaceWorldOpts extends RaceOpts {
  /** the ground under a site-frame point, so the ring lies on the road rather than through it */
  groundAt: (x: number, y: number) => number
}

/**
 * Everything a world needs to run its races.
 *
 * Built once per site load. `tick` takes the player's position in SITE metres — x east, y north —
 * because that is the frame the courses are authored in; the caller converts from three's.
 */
export class RaceWorld {
  readonly group = new THREE.Group()
  readonly session: RaceSession
  private opts: RaceWorldOpts
  private rings = new THREE.Group()
  private gates = new THREE.Group()
  private ringOf = new Map<string, THREE.Mesh>()
  private t = 0
  private shownFor: string | null = null

  constructor(doc: CourseDoc, opts: RaceWorldOpts) {
    this.group.name = 'races'
    this.group.add(this.rings, this.gates)
    this.opts = opts
    this.session = new RaceSession(doc.courses ?? [], opts)
    this.buildRings()
  }

  get state(): RaceState {
    return this.session.state
  }

  /** The courses this world offers, for a menu. */
  get courses(): readonly Course[] {
    return this.session.list
  }

  /** Every entry marker and whether it is currently inviting you in — for a minimap or a probe. */
  get markers() {
    return this.session.markers
  }

  private buildRings() {
    for (const m of this.session.markers) {
      const geo = new THREE.RingGeometry(m.r * 0.72, m.r, 64)
      const mat = new THREE.MeshBasicMaterial({
        color: ENTRY_COLOUR, side: THREE.DoubleSide, transparent: true, opacity: 0.75, depthWrite: false,
      })
      const ring = new THREE.Mesh(geo, mat)
      // flat on the ground, a hand above it so it is not eaten by the road's own z-fighting
      ring.rotation.x = -Math.PI / 2
      ring.position.set(m.x, this.opts.groundAt(m.x, m.y) + 0.12, -m.y)
      ring.renderOrder = 9
      ring.name = `race-entry:${m.course.id}`
      this.rings.add(ring)
      this.ringOf.set(m.course.id, ring)
    }
  }

  /**
   * The gates of the race you are in — and only of that one.
   *
   * Drawing every gate of every course at once turns a world with four stages into a forest of
   * banners nobody can read. They appear when you commit and go when you are done.
   */
  private showGates(c: Course | null) {
    if (this.shownFor === (c?.id ?? null)) return
    this.shownFor = c?.id ?? null
    for (const o of [...this.gates.children]) {
      this.gates.remove(o)
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      ;(m.material as THREE.Material | undefined)?.dispose?.()
    }
    if (!c) return
    for (const g of c.gates) this.gates.add(this.gateBanner(g, GATE_COLOUR))
  }

  private gateBanner(g: Gate, colour: number): THREE.Object3D {
    const za = this.opts.groundAt(g.a[0], g.a[1])
    const zb = this.opts.groundAt(g.b[0], g.b[1])
    const h = 8
    const geo = new THREE.BufferGeometry()
    // a quad standing on the two posts: cheap, readable, and visible from both sides
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      g.a[0], za, -g.a[1], g.b[0], zb, -g.b[1],
      g.a[0], za + h, -g.a[1], g.b[0], zb + h, -g.b[1],
    ], 3))
    geo.setIndex([0, 1, 2, 1, 3, 2])
    const mat = new THREE.MeshBasicMaterial({
      color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.22, depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = `race-gate:${g.id}`
    mesh.renderOrder = 9
    return mesh
  }

  /**
   * Advance the race and the world's own animation.
   *
   * The ring BREATHES rather than spins: a rotating ring on the ground reads as a loading spinner,
   * and a loading spinner in the middle of a road is a thing people drive around.
   */
  tick(at: { x: number; y: number }, dt: number): RaceTick {
    this.t += dt
    const out = this.session.tick(at, dt)
    this.showGates(out.state.phase === 'idle' ? null : out.state.course)

    const pulse = 1 + Math.sin(this.t * 2.2) * 0.06
    for (const m of this.session.markers) {
      const ring = this.ringOf.get(m.course.id)
      if (!ring) continue
      ring.visible = m.active
      ring.scale.setScalar(m.active ? pulse : 1)
      const mat = ring.material as THREE.MeshBasicMaterial
      mat.opacity = m.active ? 0.6 + Math.sin(this.t * 2.2) * 0.18 : 0.2
    }

    // the gate you are being sent to next is picked out; the rest stay dim
    const next = out.state.next?.id ?? null
    for (const o of this.gates.children) {
      const mesh = o as THREE.Mesh
      const isNext = mesh.name === `race-gate:${next}`
      const mat = mesh.material as THREE.MeshBasicMaterial
      mat.color.setHex(isNext ? NEXT_COLOUR : GATE_COLOUR)
      mat.opacity = isNext ? 0.4 : 0.16
    }
    return out
  }

  dispose(): void {
    this.showGates(null)
    for (const ring of this.ringOf.values()) {
      ring.geometry.dispose()
      ;(ring.material as THREE.Material).dispose()
    }
    this.ringOf.clear()
    this.rings.clear()
  }
}

/**
 * Load a site's courses. Null when it has none, which is most worlds.
 *
 * A 404 is the normal case and must not log: a console full of them is a console nobody reads.
 */
export async function loadRaceWorld(slug: string, opts: RaceWorldOpts, base = ''): Promise<RaceWorld | null> {
  let doc: CourseDoc
  try {
    const r = await fetch(`${base}/sites/${slug}/courses.json`, { cache: 'no-cache' })
    if (!r.ok) return null
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return null
    doc = JSON.parse(text) as CourseDoc
  } catch {
    return null
  }
  if (!doc.courses?.length) return null
  return new RaceWorld(doc, opts)
}

/** How wide the widest gate is — for a probe, and for a sanity check on a course. */
export function widestGate(c: Course): number {
  return c.gates.reduce((a, g) => Math.max(a, gateWidth(g)), 0)
}

/** Where a course begins on the map, for a map pin or a camera. */
export function courseAt(c: Course): { x: number; y: number } | null {
  if (c.entry) return { x: c.entry.x, y: c.entry.y }
  const g = c.gates[0]
  return g ? midpoint(g) : null
}
