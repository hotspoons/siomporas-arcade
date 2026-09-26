// SQUISHY HUNT — the first game on top of the corridor world.
//
// Rich's nine-year-old: "a squishy hunting game where her and her friends can go multiplayer and
// grab squishy hauls from area stores and pop ups and gas stations and that kind of thing. Some
// sort of exploration game with hints telling you where to go find the squishies."
//
// The bake already knows the stores: `manifest.pois` carries every OSM point of interest with its
// kind, its name and the building it belongs to (crofton-triangle: 237, of which 5 supermarkets,
// 7 convenience stores, 8 fuel stations, 21 fast food, 24 restaurants, 25 playgrounds). So a haul
// has a real address, and a hint can be written from the record itself — what kind of place, which
// road it is on, which way and how far from where you are standing.
//
// One squishy at a time is the target (the hint is the game); the rest are placed and waiting, so
// stumbling on one early counts. Pickup is standing close to it, on foot or in the car.
//
// Single-player here. Multiplayer is a relay that shares `{id, pos, yaw, found}` between friends
// and settles who claimed what first — see docs/corridor/STYLES-AND-GAMES.md — and hangs off the
// same class: nothing in the hunt cares whether the player next to you is on this machine.
import * as THREE from 'three'
import type { Site } from '../scene'
import { el, toast } from '../ui/shell'
import { icon } from '../ui/icons'

interface Poi { x: number; y: number; kind: string; name?: string | null; building?: number | null }

export interface Haul {
  poi: Poi
  pos: THREE.Vector3
  mesh: THREE.Group
  found: boolean
  /** the road it stands on, from the nearest branch */
  road: string
  /** "a gas station", "a burger place", "a playground" */
  what: string
  colour: THREE.Color
}

/** What a POI kind is, in words a nine-year-old uses. */
const WHAT: [RegExp, string][] = [
  [/^amenity=fuel/, 'a gas station'],
  [/^amenity=fast_food/, 'a burger place'],
  [/^amenity=restaurant/, 'a restaurant'],
  [/^amenity=cafe/, 'a coffee shop'],
  [/^amenity=ice_cream/, 'an ice cream shop'],
  [/^amenity=pharmacy/, 'a pharmacy'],
  [/^amenity=bank/, 'a bank'],
  [/^amenity=post_office/, 'the post office'],
  [/^amenity=school/, 'a school'],
  [/^leisure=playground/, 'a playground'],
  [/^leisure=park/, 'a park'],
  [/^leisure=swimming_pool/, 'a swimming pool'],
  [/^shop=supermarket/, 'a supermarket'],
  [/^shop=convenience/, 'a corner store'],
  [/^shop=candles/, 'a candle shop'],
  [/^shop=beauty|^shop=hairdresser/, 'a hair salon'],
  [/^shop=clothes/, 'a clothes shop'],
  [/^shop=alcohol/, 'a bottle shop'],
  [/^shop=car_repair/, 'a garage'],
  [/^shop=(.+)/, 'a $1 shop'],
]
/** the kinds worth hiding a squishy at, in the order a store-crawl would want them */
const HUNTABLE = /^(shop=|amenity=(fuel|fast_food|restaurant|cafe|ice_cream|pharmacy|post_office)|leisure=(playground|park))/

const PASTELS = [0xff9ec9, 0x9ed7ff, 0xc9ff9e, 0xfff39e, 0xd9b3ff, 0xffc39e, 0x9effe6, 0xffb3d9]

function whatIs(kind: string): string {
  for (const [re, w] of WHAT) {
    const m = kind.match(re)
    if (m) return w.replace('$1', (m[1] ?? '').replace(/_/g, ' '))
  }
  return 'a place'
}

function compass(dx: number, dz: number): string {
  // site frame: +x east, world -z north
  const ang = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
  return names[Math.round(ang / 45) % 8]
}

function band(d: number): string {
  if (d < 25) return 'right here'
  if (d < 120) return 'really close'
  if (d < 400) return 'a couple of blocks away'
  if (d < 1200) return 'a good walk away'
  return 'across town'
}

/** A squishy: a squashed pastel blob with a soft glow ring under it. */
function squishyMesh(colour: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), new THREE.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0, emissive: colour, emissiveIntensity: 0.25 }))
  body.scale.set(1, 0.78, 1)
  body.name = 'squishy:body'
  const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0x222233 }))
  const e1 = eyes.clone(), e2 = eyes.clone()
  e1.position.set(-0.18, 0.12, 0.46)
  e2.position.set(0.18, 0.12, 0.46)
  body.add(e1, e2)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.1, 32), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.05
  ring.name = 'squishy:ring'
  g.add(body, ring)
  return g
}

/** another player in the room, as we draw them */
interface Friend { id: string; name: string; mesh: THREE.Group; label: THREE.Sprite; target: THREE.Vector3; yaw: number; found: number }

export class SquishyHunt {
  readonly group = new THREE.Group()
  readonly hud: HTMLElement
  readonly hauls: Haul[] = []
  active: Haul | null = null
  score = 0
  private t = 0
  private hintAt = -1 // so the first tick writes a real hint, not the placeholder
  private hintEl: HTMLElement
  private scoreEl: HTMLElement
  private arrowEl: HTMLElement
  private playersEl: HTMLElement
  private site: Site
  private done = false
  // the room, when friends are in it
  private room: string | null = null
  private me = { id: Math.random().toString(36).slice(2, 10), name: 'you', colour: 0xff9ec9 }
  private friends = new Map<string, Friend>()
  private events: EventSource | null = null
  private poseAt = 0
  private claimedByOthers = new Set<string>()

  constructor(site: Site, parent: HTMLElement, opts: { count?: number; seed?: number } = {}) {
    this.site = site
    this.group.name = 'game:squishy'
    const count = opts.count ?? 12
    const seed = opts.seed ?? 7
    const pois = ((site.manifest as unknown as { pois?: Poi[] }).pois ?? []).filter((p) => p.name && HUNTABLE.test(p.kind))
    // spread across town: a seeded start, then the farthest remaining point each time, so the
    // hunt walks the whole site rather than one strip mall
    const chosen: Poi[] = []
    if (pois.length) {
      let cur = pois[Math.floor(hash(seed) * pois.length)]
      chosen.push(cur)
      const left = new Set(pois.filter((p) => p !== cur))
      while (chosen.length < Math.min(count, pois.length) && left.size) {
        let best: Poi | null = null, bd = -1
        for (const p of left) {
          let d = Infinity
          for (const c of chosen) d = Math.min(d, Math.hypot(p.x - c.x, p.y - c.y))
          if (d > bd) { bd = d; best = p }
        }
        if (!best) break
        chosen.push(best)
        left.delete(best)
        cur = best
      }
    }
    const branches = ((site.manifest as unknown as { branches?: { ident?: string; name?: string; coords: number[][] }[] }).branches ?? [])
    chosen.forEach((poi, i) => {
      const x = poi.x, z = -poi.y
      const gy = site.groundAt(x, z) ?? 0
      const pos = new THREE.Vector3(x, gy + 0.9, z)
      const colour = new THREE.Color(PASTELS[i % PASTELS.length])
      const mesh = squishyMesh(colour)
      mesh.position.copy(pos)
      this.group.add(mesh)
      // the road it stands on: the nearest branch vertex
      let road = '', bd = Infinity
      for (const b of branches) {
        const ident = b.ident ?? b.name
        if (!ident) continue
        for (let k = 0; k < b.coords.length; k += 3) {
          const c = b.coords[k]
          const d = Math.hypot(c[0] - poi.x, c[1] - poi.y)
          if (d < bd) { bd = d; road = ident }
        }
      }
      this.hauls.push({ poi, pos, mesh, found: false, road, what: whatIs(poi.kind), colour })
    })
    // the hunt goes in placement order, which the spread above made a tour of the town
    this.active = this.hauls[0] ?? null

    this.hud = el('div', 'squishy-hud')
    this.hud.id = 'squishy'
    const title = el('div', 'squishy-title')
    title.append(icon('sparkles', 16), el('span', '', 'Squishy Hunt'))
    this.scoreEl = el('div', 'squishy-score', `0 / ${this.hauls.length}`)
    this.hintEl = el('div', 'squishy-hint', this.hauls.length ? 'Find the first squishy…' : 'No stores in this world to hide squishies at.')
    this.arrowEl = el('div', 'squishy-arrow')
    this.arrowEl.append(icon('map-pin', 18))
    const row = el('div', 'squishy-row')
    row.append(this.arrowEl, this.hintEl)
    this.playersEl = el('div', 'squishy-players')
    this.hud.append(title, this.scoreEl, row, this.playersEl)
    parent.append(this.hud)
    site.group.add(this.group)
  }

  /** a stable key for a haul across machines: the store, not the index */
  private keyOf(h: Haul) { return `${h.poi.kind}|${h.poi.name}|${Math.round(h.poi.x)}|${Math.round(h.poi.y)}` }

  /**
   * Share this hunt with friends. The relay is the world-editor service's `/api/rooms`; it only
   * carries poses and claims, the world and the hunt are the same seed on every machine. Fails
   * soft: no service, no room, the hunt is single-player and says so once.
   */
  join(room: string, name: string, colour?: number) {
    this.room = room
    this.me.name = name || 'you'
    if (colour != null) this.me.colour = colour
    const base = `/api/rooms/${encodeURIComponent(room)}`
    try {
      this.events = new EventSource(`${base}/events`)
    } catch {
      this.events = null
    }
    if (!this.events) { toast('no relay reachable — hunting alone', 'warn', 3000); this.room = null; return }
    this.events.addEventListener('state', (e) => this.onState(JSON.parse((e as MessageEvent).data)))
    this.events.onerror = () => { if (this.room) { toast('lost the room — hunting alone until it comes back', 'warn', 3000) } }
    this.playersEl.textContent = `room ${room} · waiting for friends…`
  }

  private onState(s: { players: Record<string, { name: string; colour: number; pos: number[]; yaw: number; found: number }>; claims: Record<string, string> }) {
    // claims by others: their squishies vanish for us too, and we do not get the point
    for (const [key, by] of Object.entries(s.claims)) {
      if (by === this.me.id || this.claimedByOthers.has(key)) continue
      const h = this.hauls.find((x) => this.keyOf(x) === key)
      if (!h) continue
      this.claimedByOthers.add(key)
      if (!h.found) {
        h.found = true
        h.mesh.visible = false
        const who = s.players[by]?.name ?? 'a friend'
        toast(`${who} got the ${h.poi.name} squishy!`, 'info', 2600)
        if (h === this.active) this.active = this.hauls.find((x) => !x.found) ?? null
      }
    }
    // friends: make, move, drop
    const seen = new Set<string>()
    for (const [id, p] of Object.entries(s.players)) {
      if (id === this.me.id) continue
      seen.add(id)
      let f = this.friends.get(id)
      if (!f) {
        f = this.makeFriend(id, p.name, p.colour)
        this.friends.set(id, f)
      }
      f.target.set(p.pos[0], p.pos[1], p.pos[2])
      f.yaw = p.yaw
      f.found = p.found
    }
    for (const [id, f] of this.friends) if (!seen.has(id)) { this.group.remove(f.mesh); this.friends.delete(id) }
    const names = [...this.friends.values()].map((f) => `${f.name} ${f.found}`)
    this.playersEl.textContent = `room ${this.room} · ${names.length ? names.join(' · ') : 'nobody else yet'}`
  }

  private makeFriend(id: string, name: string, colour: number): Friend {
    const mesh = new THREE.Group()
    const c = new THREE.Color(colour)
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 10), new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }))
    body.position.y = 0.8
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    nose.rotation.x = -Math.PI / 2
    nose.position.set(0, 1.2, -0.45)
    mesh.add(body, nose)
    // the name over their head
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = 'rgba(13,16,20,0.7)'; ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = '#fff'; ctx.font = 'bold 30px "IBM Plex Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(name, 128, 34)
    const tex = new THREE.CanvasTexture(cv)
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
    label.scale.set(2.2, 0.55, 1)
    label.position.y = 2.2
    mesh.add(label)
    this.group.add(mesh)
    return { id, name, mesh, label, target: new THREE.Vector3(), yaw: 0, found: 0 }
  }

  private async sendPose(player: THREE.Vector3, heading: number) {
    if (!this.room) return
    try {
      await fetch(`/api/rooms/${encodeURIComponent(this.room)}/pose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.me.id, name: this.me.name, colour: this.me.colour, pos: [player.x, player.y, player.z], yaw: heading, found: this.score }) })
    } catch { /* the relay is gone; the next state event or its error says so */ }
  }

  /** Every frame: the squishies bob, the hint follows the player, a close player collects. */
  tick(dt: number, player: THREE.Vector3, heading: number) {
    this.t += dt
    for (const h of this.hauls) {
      if (h.found) continue
      h.mesh.position.y = h.pos.y + Math.sin(this.t * 2.2 + h.pos.x * 0.1) * 0.18
      h.mesh.rotation.y += dt * 0.9
      const active = h === this.active
      const ring = h.mesh.getObjectByName('squishy:ring') as THREE.Mesh | null
      if (ring) (ring.material as THREE.MeshBasicMaterial).opacity = active ? 0.55 + 0.25 * Math.sin(this.t * 4) : 0.25
      // pickup: standing close, on foot or in the car
      if (Math.hypot(h.pos.x - player.x, h.pos.z - player.z) < 6 && Math.abs(h.pos.y - player.y) < 12) this.collect(h)
    }
    if (this.t - this.hintAt > 0.4) {
      this.hintAt = this.t
      this.hint(player, heading)
    }
    // friends glide toward their last reported spot and face their heading
    for (const f of this.friends.values()) {
      f.mesh.position.lerp(f.target, 1 - Math.exp(-6 * dt))
      f.mesh.rotation.y = -f.yaw
    }
    if (this.room && this.t - this.poseAt > 0.25) {
      this.poseAt = this.t
      void this.sendPose(player, heading)
    }
  }

  private collect(h: Haul) {
    h.found = true
    h.mesh.visible = false
    // in a room the first claim wins; if a friend beat us to it the relay's state event already
    // took it off our list, so this only races on the last few metres
    if (this.room) {
      const key = this.keyOf(h)
      void fetch(`/api/rooms/${encodeURIComponent(this.room)}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.me.id, haul: key }) })
        .then((r) => r.json()).then((j: { ok: boolean; by?: string }) => { if (!j.ok) { this.score = Math.max(0, this.score - 1); this.scoreEl.textContent = `${this.score} / ${this.hauls.length}`; toast('a friend got that one first!', 'warn', 2000) } })
        .catch(() => { /* offline: keep the point */ })
    }
    this.score++
    this.scoreEl.textContent = `${this.score} / ${this.hauls.length}`
    toast(`You got the ${h.poi.name} squishy! ${this.score} of ${this.hauls.length}`, 'ok', 2600)
    if (h === this.active) this.active = this.hauls.find((x) => !x.found) ?? null
    if (!this.active && !this.done) {
      this.done = true
      this.hintEl.textContent = `That is all of them. ${this.hauls.length} squishies — the whole haul!`
      toast('The whole haul! You found every squishy in town.', 'ok', 6000)
    }
  }

  private hint(player: THREE.Vector3, heading: number) {
    const h = this.active
    if (!h) return
    const dx = h.pos.x - player.x, dz = h.pos.z - player.z
    const d = Math.hypot(dx, dz)
    const where = h.road ? ` on ${h.road}` : ''
    this.hintEl.textContent = d < 25
      ? `It is right here — ${h.what}${where}. Look around!`
      : `Try ${h.what}${where}, ${band(d)} to the ${compass(dx, dz)}.`
    // the arrow points at the target relative to where the player is looking
    const bearing = Math.atan2(dx, -dz) // from north, clockwise
    const rel = bearing - heading
    this.arrowEl.style.transform = `rotate(${(rel * 180) / Math.PI}deg)`
  }

  dispose() {
    this.events?.close()
    this.events = null
    this.site.group.remove(this.group)
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.hud.remove()
  }
}

function hash(n: number): number {
  let h = Math.imul(n | 0, 2654435761) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}
