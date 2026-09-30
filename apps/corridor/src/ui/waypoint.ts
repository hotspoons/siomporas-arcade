// The waypoint: an arrow in the top-right corner that points at where you are going, and the
// line of text that says what is there.
//
// Rich, 2026-09-30: *"an indicator with an arrow pointing to the direction (3d at an angle) in
// the upper right corner where we can see where the next way point is — and if we have mission
// start — show the message for the waypoint (e.g. race starts at the intersection of johns
// hopkins and route 3 south) that can be hidden and shown by clicking on it."*
//
// The arrow is drawn on a small canvas as a chevron lying on a tilted plane — a perspective
// squash and a shaded near face — turned by the bearing from the car's heading to the target, so
// straight ahead is up and behind you is down. The distance sits under it. The message is a
// button: one click folds it to a marker, another opens it, and a new waypoint opens it again.

import { el } from './shell'

export interface Waypoint {
  /** site metres, x east, y north */
  x: number
  y: number
  text?: string
}

export class WaypointHud {
  readonly root = el('div', 'waypoint')
  private canvas = document.createElement('canvas')
  private dist = el('div', 'waypoint-dist')
  private msg = el('button', 'waypoint-msg') as HTMLButtonElement
  private target: Waypoint | null = null
  private folded = false
  private lastText = ''

  constructor() {
    this.canvas.width = 132
    this.canvas.height = 132
    this.canvas.className = 'waypoint-arrow'
    this.msg.type = 'button'
    this.msg.title = 'click to fold the message away, and again to open it'
    this.msg.onclick = () => { this.folded = !this.folded; this.renderMsg() }
    this.root.append(this.canvas, this.dist, this.msg)
    this.root.hidden = true
  }

  /** Where to point, and what to say. Null hides the whole thing. */
  set(target: Waypoint | null): void {
    const text = target?.text ?? ''
    if (target && text !== this.lastText) this.folded = false // a new message opens itself
    this.lastText = text
    this.target = target
    this.root.hidden = !target
    this.renderMsg()
  }

  get current(): Waypoint | null {
    return this.target
  }

  /** Every frame: the car (site metres) and its heading, radians counter-clockwise from east. */
  update(x: number, y: number, heading: number): void {
    const t = this.target
    if (!t) return
    const dx = t.x - x
    const dy = t.y - y
    const d = Math.hypot(dx, dy)
    const bearing = Math.atan2(dy, dx) - heading // 0 = dead ahead, +ve = to the left
    this.dist.textContent = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`
    this.draw(bearing)
  }

  private renderMsg(): void {
    const text = this.target?.text ?? ''
    this.msg.hidden = !text
    this.msg.classList.toggle('folded', this.folded)
    this.msg.textContent = this.folded ? '…' : text
  }

  private draw(bearing: number): void {
    const c = this.canvas
    const ctx = c.getContext('2d')
    if (!ctx) return
    const W = c.width, H = c.height
    ctx.clearRect(0, 0, W, H)
    // the arrow lies on a plane tilted away from you: x as drawn, y squashed, so a turn reads as a
    // turn and not as a flat dial — "3d at an angle"
    const tilt = 0.55
    const cx = W / 2, cy = H / 2 + 6
    const pts: [number, number][] = [[0, -40], [26, 14], [10, 6], [10, 34], [-10, 34], [-10, 6], [-26, 14]]
    const rot = -bearing // screen y is down; ahead (bearing 0) must point up
    const map = (p: [number, number], lift = 0): [number, number] => {
      const x = p[0] * Math.cos(rot) - p[1] * Math.sin(rot)
      const y = p[0] * Math.sin(rot) + p[1] * Math.cos(rot)
      return [cx + x, cy + y * tilt - lift]
    }
    // the side face first, dark, then the top face: a slab with a little height
    const h = 9
    ctx.beginPath()
    for (const [i, p] of pts.entries()) { const q = map(p, 0); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]) }
    ctx.closePath()
    ctx.fillStyle = 'rgba(20, 60, 30, 0.9)'
    ctx.fill()
    ctx.beginPath()
    for (const [i, p] of pts.entries()) { const q = map(p, h); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]) }
    ctx.closePath()
    const g = ctx.createLinearGradient(0, cy - 40, 0, cy + 40)
    g.addColorStop(0, '#9dffb0')
    g.addColorStop(1, '#2fbf5f')
    ctx.fillStyle = g
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}
