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
import { gateWidth, midpoint, startGate, type Course, type CourseDoc, type Gate } from './races'

const NEXT_COLOUR = 0x2ee6c0

export interface RaceWorldOpts extends RaceOpts {
  /** a chosen gate model (fixtures.json), cloned per gate and scaled to the gate's width; null = the built-in */
  gateModel?: THREE.Object3D | null
  /** a chosen entry-marker model, cloned per marker; null = the built-in ring and arch */
  markerModel?: THREE.Object3D | null
  /** the race-gate and race-marker settings from fixtures.json */
  gate?: { height_m?: number; colour?: string; stripe?: boolean }
  marker?: { arch?: boolean; colour?: string }
  /** the ground under a site-frame point, so the ring lies on the road rather than through it */
  groundAt: (x: number, y: number) => number
}

/**
 * Everything a world needs to run its races.
 *
 * Built once per site load. `tick` takes the player's position in SITE metres — x east, y north —
 * because that is the frame the courses are authored in; the caller converts from three's.
 */
let chequerTex: THREE.CanvasTexture | null = null
/** A black-and-white chequer, made once: the stripe on the road at a start or finish line. */
function chequer(): THREE.CanvasTexture {
  if (chequerTex) return chequerTex
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 8
  const ctx = c.getContext('2d')!
  for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
    ctx.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'
    ctx.fillRect(i * 4, j * 4, 4, 4)
  }
  chequerTex = new THREE.CanvasTexture(c)
  chequerTex.wrapS = THREE.RepeatWrapping
  chequerTex.repeat.set(2, 1)
  return chequerTex
}

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
    const colour = new THREE.Color(this.opts.marker?.colour ?? '#ffd54f')
    for (const m of this.session.markers) {
      const ground = this.opts.groundAt(m.x, m.y)
      const holder = new THREE.Group()
      holder.name = `race-entry:${m.course.id}`
      holder.position.set(m.x, ground, -m.y)
      // the trigger area, flat on the road, a hand above it so the road cannot z-fight it away
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(m.r * 0.72, m.r, 64),
        new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.75, depthWrite: false }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.12
      ring.renderOrder = 9
      ring.name = 'ring'
      holder.add(ring)
      /*
       * AND SOMETHING TO DRIVE THROUGH. Rich, 2026-09-30, after the first Route 3 run: *"The
       * start's circle was flat on the road, not something to drive through like I would have
       * thought."* A ring on the tarmac is the trigger; the arch standing over it, facing the
       * start gate, is what you aim at. A chosen marker model stands in for the arch.
       */
      const start = startGate(m.course)
      const toward = start ? midpoint(start) : null
      const yaw = toward ? Math.atan2(toward.x - m.x, -(toward.y - m.y)) : 0
      if (this.opts.markerModel) {
        const inst = this.opts.markerModel.clone(true)
        inst.rotation.y = yaw + Math.PI / 2
        holder.add(inst)
      } else if (this.opts.marker?.arch !== false) {
        const r = Math.max(3, Math.min(7, m.r * 0.5))
        const arch = new THREE.Mesh(
          new THREE.TorusGeometry(r, 0.28, 12, 48),
          new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85, depthWrite: false }),
        )
        // a torus lies in its own XY plane, so its axis is Z: turn that axis to face the start
        arch.rotation.y = yaw
        arch.position.y = r + 0.6
        arch.renderOrder = 9
        arch.name = 'arch'
        holder.add(arch)
      }
      this.rings.add(holder)
      this.ringOf.set(m.course.id, ring)
    }
  }

  /**
   * Every course's gates are in the world all the time. They used to appear only once you had
   * committed to a race, which is why the finish was nowhere to be seen on a 4 km stage (Rich,
   * 2026-09-30: *"I didn't actually see an end gate / finish line"*). Dim until you are in, bright
   * for the race you are in, brightest for the gate you are being sent to.
   */
  private showGates(c: Course | null) {
    if (this.shownFor === (c?.id ?? null) && this.gates.children.length) return
    this.shownFor = c?.id ?? null
    for (const o of [...this.gates.children]) {
      this.gates.remove(o)
      o.traverse((x) => {
        const m = x as THREE.Mesh
        m.geometry?.dispose?.()
        ;(m.material as THREE.Material | undefined)?.dispose?.()
      })
    }
    for (const course of this.session.list) {
      for (const g of course.gates) this.gates.add(this.gateMesh(g, course, c?.id === course.id))
    }
  }

  private gateMesh(g: Gate, course: Course, inRace: boolean): THREE.Object3D {
    const za = this.opts.groundAt(g.a[0], g.a[1])
    const zb = this.opts.groundAt(g.b[0], g.b[1])
    const h = this.opts.gate?.height_m ?? 6
    const colour = new THREE.Color(this.opts.gate?.colour ?? '#4fc3f7')
    const holder = new THREE.Group()
    holder.name = `race-gate:${g.id}`
    holder.userData.course = course.id
    const mx = (g.a[0] + g.b[0]) / 2, my = (g.a[1] + g.b[1]) / 2
    const w = gateWidth(g)
    if (this.opts.gateModel) {
      // a model spans the gate: its length along the gate line, scaled to the gate's width
      const inst = this.opts.gateModel.clone(true)
      const box = new THREE.Box3().setFromObject(inst)
      const len = Math.max(box.max.x - box.min.x, 1e-3)
      inst.scale.multiplyScalar(w / len)
      inst.position.set(mx, (za + zb) / 2, -my)
      inst.rotation.y = Math.atan2(-(g.b[1] - g.a[1]), g.b[0] - g.a[0])
      holder.add(inst)
      return holder
    }
    const post = new THREE.CylinderGeometry(0.16, 0.16, h, 10)
    const postMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 })
    for (const [x, y, z] of [[g.a[0], za, g.a[1]], [g.b[0], zb, g.b[1]]]) {
      const p = new THREE.Mesh(post, postMat)
      p.position.set(x, y + h / 2, -z)
      holder.add(p)
    }
    const geo = new THREE.BufferGeometry()
    // a banner between the posts, from a little below the top: cheap, readable, both sides
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      g.a[0], za + h * 0.72, -g.a[1], g.b[0], zb + h * 0.72, -g.b[1],
      g.a[0], za + h, -g.a[1], g.b[0], zb + h, -g.b[1],
    ], 3))
    geo.setIndex([0, 1, 2, 1, 3, 2])
    const banner = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity: inRace ? 0.5 : 0.28, depthWrite: false }))
    banner.name = 'banner'
    banner.renderOrder = 9
    holder.add(banner)
    // a chequered stripe on the road at a start or a finish, so the line is a line
    const striped = g.role === 'start' || g.role === 'finish' || g.role === 'startfinish'
    if (striped && this.opts.gate?.stripe !== false) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w, 2.2), new THREE.MeshBasicMaterial({ map: chequer(), transparent: true, opacity: 0.9, depthWrite: false }))
      stripe.rotation.x = -Math.PI / 2
      stripe.rotation.z = -Math.atan2(-(g.b[1] - g.a[1]), g.b[0] - g.a[0])
      stripe.position.set(mx, (za + zb) / 2 + 0.08, -my)
      stripe.renderOrder = 8
      stripe.name = 'stripe'
      holder.add(stripe)
    }
    return holder
  }

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

    // the gate you are being sent to next is picked out; the race you are in is bright; the rest dim
    const next = out.state.next?.id ?? null
    const inRace = out.state.course?.id ?? null
    for (const o of this.gates.children) {
      const banner = o.getObjectByName('banner') as THREE.Mesh | undefined
      if (!banner) continue
      const isNext = o.name === `race-gate:${next}`
      const mine = o.userData.course === inRace
      const mat = banner.material as THREE.MeshBasicMaterial
      if (isNext) mat.color.setHex(NEXT_COLOUR)
      else mat.color.set(this.opts.gate?.colour ?? '#4fc3f7')
      mat.opacity = isNext ? 0.6 : mine ? 0.45 : 0.22
    }
    return out
  }

  dispose(): void {
    this.shownFor = null
    for (const o of [...this.gates.children]) this.gates.remove(o)
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
