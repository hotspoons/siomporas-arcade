// Programmer art, drawn honestly.
//
// There is no character art yet and this build exists so the mechanics can be played before there
// is any. So the fighters are a torso, a head, two legs and whichever limb is currently attacking —
// and the attacking limb is drawn *from the move's own hitbox*, reaching out through startup,
// locked at full extension while it is active, and pulled back through recovery.
//
// That is the whole idea: the placeholder art is not a stand-in for the real art, it is a picture of
// the frame data. If a move looks wrong here it is wrong, and you can see why. Press F1 and the
// actual boxes come up over the top.
//
// THE CAMERA zooms. It is not decoration: a fixed camera either shows the whole stage, in which case
// two fighters at jab range are thumbnails, or it frames them nicely and they walk off the sides.
// Every game in the genre solves this the same way — the view width follows the distance between
// the fighters, clamped at both ends — and so does this.
//
// Canvas 2D on purpose. The 2D layer is orthographic, side-on and made of rectangles; three.js would
// buy nothing until the 2.5D camera exists.

import { STAGE_HALF, type Fighter } from '../sim/Fighter'
import { ROUNDS_TO_WIN, type Match } from '../sim/Match'
import { HURT, blockAdvantage, scaled, totalFrames, type Box } from '../sim/Moves'

/** Closest the camera will ever get, and widest it will pull back to, in world units. */
const ZOOM_IN = 760
const ZOOM_OUT = 1420
/** World units of headroom the view keeps above the floor, and of floor below it. */
const HEADROOM = 430
const UNDERFOOT = 76

export interface RenderOptions {
  /** F1: hitboxes, hurtboxes and frame data. */
  debug: boolean
  /** The banner shown before the first round. */
  hint: boolean
}

/** The frame being drawn, in world units. Everything below works in these. */
interface View {
  w: number
  h: number
  /** Where world y = 0 sits, measured down from the top of the view. */
  floor: number
  camera: number
}

const INK = '#e8e6df'
const DIM = 'rgba(232,230,223,0.45)'

export function render(ctx: CanvasRenderingContext2D, match: Match, opts: RenderOptions): void {
  const cv = ctx.canvas
  const [a, b] = match.fighters

  // Frame the pair: close in when they are trading, pull back when they are not.
  const want = Math.max(ZOOM_IN, Math.min(ZOOM_OUT, Math.abs(a.x - b.x) + 470))
  const scale = Math.min(cv.width / want, cv.height / (HEADROOM + UNDERFOOT))
  const w = cv.width / scale
  const h = cv.height / scale

  const lo = -STAGE_HALF + w / 2
  const hi = STAGE_HALF - w / 2
  const mid = (a.x + b.x) / 2
  const view: View = { w, h, floor: h - UNDERFOOT, camera: lo > hi ? 0 : Math.max(lo, Math.min(hi, mid)) }

  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.fillStyle = '#0b0c10'
  ctx.fillRect(0, 0, w, h)

  drawStage(ctx, view)

  ctx.save()
  ctx.translate(w / 2 - view.camera, 0)
  // Whoever is further away draws first, so the nearer fighter overlaps — the only depth cue a flat
  // plane has, and it stops two overlapping bodies reading as one shape.
  for (const f of a.y >= b.y ? [b, a] : [a, b]) drawFighter(ctx, f, view, opts.debug)
  for (const p of match.projectiles) {
    drawProjectile(ctx, p.x, p.y, p.box, match.fighters[p.owner].character.trim, view, opts.debug)
  }
  for (const im of match.impacts) drawImpact(ctx, im, view)
  ctx.restore()

  drawHud(ctx, match, view)
  drawBanner(ctx, match, view, opts)
  if (opts.debug) drawFrameData(ctx, match, view)
}

function drawStage(ctx: CanvasRenderingContext2D, v: View): void {
  const sky = ctx.createLinearGradient(0, 0, 0, v.floor)
  sky.addColorStop(0, '#101219')
  sky.addColorStop(0.7, '#1d1c1c')
  sky.addColorStop(1, '#2e2719')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, v.w, v.floor)

  // Chain-link fence posts, parallaxing at half speed. The only thing telling you the camera moved.
  ctx.strokeStyle = 'rgba(255,255,255,0.055)'
  ctx.lineWidth = 3
  const half = v.camera * 0.5
  for (let x = -1600; x <= 1600; x += 104) {
    const sx = x - half + v.w / 2
    if (sx < -20 || sx > v.w + 20) continue
    ctx.beginPath()
    ctx.moveTo(sx, v.floor * 0.18)
    ctx.lineTo(sx, v.floor)
    ctx.stroke()
  }

  ctx.fillStyle = '#39311f'
  ctx.fillRect(0, v.floor, v.w, v.h - v.floor)
  ctx.fillStyle = 'rgba(255,255,255,0.14)'
  ctx.fillRect(0, v.floor, v.w, 2)

  // Floor markings, so walking reads as movement without a background to move against.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 2
  for (let x = -STAGE_HALF; x <= STAGE_HALF; x += 80) {
    const sx = x - v.camera + v.w / 2
    ctx.beginPath()
    ctx.moveTo(sx, v.floor + 6)
    ctx.lineTo(sx - 30, v.h)
    ctx.stroke()
  }

  for (const wall of [-STAGE_HALF, STAGE_HALF]) {
    const sx = wall - v.camera + v.w / 2
    if (sx < -10 || sx > v.w + 10) continue
    ctx.fillStyle = 'rgba(180,48,58,0.55)'
    ctx.fillRect(sx - 3, v.floor - 200, 6, 200)
  }
}

function drawFighter(ctx: CanvasRenderingContext2D, f: Fighter, v: View, debug: boolean): void {
  const hb = HURT[f.stance]
  const h = hb.y1 - hb.y0
  const c = f.character

  // The shadow shrinks with height, which is most of what tells you how high a jump is.
  const shadow = Math.max(0.28, 1 - Math.max(0, f.y) / 260)
  ctx.fillStyle = `rgba(0,0,0,${0.42 * shadow})`
  ctx.beginPath()
  ctx.ellipse(f.x, v.floor + 3, 42 * shadow, 8 * shadow, 0, 0, Math.PI * 2)
  ctx.fill()

  const down = f.state === 'down' || f.state === 'ko'
  const recoil = f.state === 'hitstun' ? 0.22 : f.state === 'blockstun' ? 0.07 : 0
  const struck = f.hitstop > 0 && (f.state === 'hitstun' || f.state === 'blockstun')
  const body = struck ? shade(c.body, 0.72) : c.body

  ctx.save()
  ctx.translate(f.x, v.floor - f.y - hb.y0)
  ctx.scale(f.facing, 1)
  if (down) {
    ctx.rotate(-1.15)
    ctx.translate(-h * 0.34, -h * 0.1)
  } else if (recoil) {
    ctx.rotate(-recoil)
  }

  const hipY = -h * 0.42
  const shoulderY = -h * 0.84
  const headR = h * 0.115

  const splay = f.stance === 'air' ? 6 : f.stance === 'crouch' ? 26 : 17
  const legW = h * 0.12
  ctx.strokeStyle = shade(body, -0.28)
  ctx.lineWidth = legW
  ctx.lineCap = 'round'
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(0, hipY)
    // Stop half a line-width short: a round cap hangs past its endpoint, and the floor is the floor.
    ctx.lineTo(s * splay, f.stance === 'air' ? hipY + h * 0.28 : -legW / 2)
    ctx.stroke()
  }

  ctx.fillStyle = body
  ctx.beginPath()
  ctx.roundRect(-h * 0.13, shoulderY, h * 0.26, hipY - shoulderY, h * 0.055)
  ctx.fill()

  ctx.fillStyle = shade(body, 0.2)
  ctx.beginPath()
  ctx.arc(headR * 0.3, -h * 0.96, headR, 0, Math.PI * 2)
  ctx.fill()

  // Guard: a slab across the front, the clearest possible reading of "this is being blocked".
  if (f.state === 'blockstun' || (f.blocking && f.free)) {
    ctx.fillStyle = 'rgba(120,190,255,0.85)'
    ctx.beginPath()
    ctx.roundRect(h * 0.11, f.guardLow ? hipY + h * 0.04 : shoulderY, h * 0.09, h * 0.34, h * 0.03)
    ctx.fill()
  }

  drawLimb(ctx, f, h, shoulderY, hipY)
  ctx.restore()

  if (debug) {
    drawBox(ctx, f.hurtBox(), 'rgba(90,190,255,0.8)', v)
    const hit = f.hitBox()
    if (hit) drawBox(ctx, hit, 'rgba(255,70,70,0.95)', v)
    if (f.invulnerable) {
      const box = f.hurtBox()
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 3
      ctx.strokeRect(box.x0 - 5, v.floor - box.y1 - 5, box.x1 - box.x0 + 10, box.y1 - box.y0 + 10)
    }
  }
}

/**
 * The attacking limb, drawn from the move's own hitbox: out over startup, locked at full extension
 * while the move is active, retracted over recovery. A move that looks slow here is slow.
 */
function drawLimb(ctx: CanvasRenderingContext2D, f: Fighter, h: number, shoulderY: number, hipY: number): void {
  const m = f.action
  if (!m || f.state !== 'attack') return
  const sc = scaled(m, f.character)
  if (sc.hitbox.x1 === 0 && !m.projectile) return

  // Matches hitBox()'s window exactly, so the limb is fully out on precisely the frames that hit.
  const begin = m.startup - 1
  const fr = f.actionFrame
  const t = fr < begin
    ? (fr / Math.max(1, begin)) * 0.88
    : fr < begin + m.active
      ? 1
      : Math.max(0, 1 - (fr - begin - m.active) / Math.max(1, m.recovery))

  const kick = m.id.endsWith('k')
  const from = kick ? hipY : shoulderY
  const box = m.projectile ? m.projectile.at : sc.hitbox
  const tx = ((box.x0 + box.x1) / 2) * t
  const ty = -((box.y0 + box.y1) / 2) * t + from * (1 - t)

  ctx.strokeStyle = f.character.trim
  ctx.lineWidth = h * (kick ? 0.105 : 0.088)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(0, from)
  ctx.lineTo(tx, ty)
  ctx.stroke()

  ctx.fillStyle = shade(f.character.trim, 0.3)
  ctx.beginPath()
  ctx.arc(tx, ty, h * (kick ? 0.065 : 0.052), 0, Math.PI * 2)
  ctx.fill()
}

function drawProjectile(
  ctx: CanvasRenderingContext2D, x: number, y: number, box: Box, colour: string, v: View, debug: boolean,
): void {
  const cy = v.floor - y - (box.y0 + box.y1) / 2
  const r = (box.y1 - box.y0) / 2
  const g = ctx.createRadialGradient(x, cy, 2, x, cy, r * 1.6)
  g.addColorStop(0, '#fff')
  g.addColorStop(0.45, colour)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.ellipse(x, cy, r * 1.6, r, 0, 0, Math.PI * 2)
  ctx.fill()
  if (debug) drawBox(ctx, { x0: x + box.x0, y0: y + box.y0, x1: x + box.x1, y1: y + box.y1 }, 'rgba(255,200,60,0.9)', v)
}

/**
 * A hit mark. White spokes for a hit, a blue arc for a guard — the same two readings the genre has
 * used since the beginning, and the fastest way to tell at a glance whether that did anything.
 */
function drawImpact(ctx: CanvasRenderingContext2D, im: { x: number; y: number; blocked: boolean; life: number }, v: View): void {
  const y = v.floor - im.y
  const t = Math.max(0, Math.min(1, im.life / 12))
  ctx.globalAlpha = t
  if (im.blocked) {
    ctx.strokeStyle = '#7dc4ff'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(im.x, y, 20 + (1 - t) * 26, -0.9, 0.9)
    ctx.stroke()
  } else {
    const r = 14 + (1 - t) * 40
    ctx.strokeStyle = '#fff6e0'
    ctx.lineWidth = 5
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3
      ctx.beginPath()
      ctx.moveTo(im.x + Math.cos(a) * r * 0.35, y + Math.sin(a) * r * 0.35)
      ctx.lineTo(im.x + Math.cos(a) * r, y + Math.sin(a) * r)
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

function drawBox(ctx: CanvasRenderingContext2D, b: Box, colour: string, v: View): void {
  ctx.strokeStyle = colour
  ctx.lineWidth = 2
  ctx.strokeRect(b.x0, v.floor - b.y1, b.x1 - b.x0, b.y1 - b.y0)
}

// --- the furniture ----------------------------------------------------------------------------

function font(ctx: CanvasRenderingContext2D, px: number, weight = 600): void {
  ctx.font = `${weight} ${px}px ui-monospace, "Courier New", monospace`
}

function drawHud(ctx: CanvasRenderingContext2D, match: Match, v: View): void {
  const [a, b] = match.fighters
  const pad = v.w * 0.022
  const barW = v.w * 0.37
  const barH = v.h * 0.045
  const top = v.h * 0.035

  bar(ctx, pad, top, barW, barH, false, a.health / a.character.health, a.character.trim)
  bar(ctx, v.w - pad - barW, top, barW, barH, true, b.health / b.character.health, b.character.trim)

  font(ctx, v.h * 0.033, 700)
  ctx.textBaseline = 'top'
  ctx.fillStyle = INK
  ctx.textAlign = 'left'
  ctx.fillText(a.character.name, pad, top + barH + 6)
  ctx.textAlign = 'right'
  ctx.fillText(b.character.name, v.w - pad, top + barH + 6)

  for (let i = 0; i < ROUNDS_TO_WIN; i++) {
    pip(ctx, pad + i * v.h * 0.042, top + barH + v.h * 0.05, v.h * 0.013, match.wins[0] > i)
    pip(ctx, v.w - pad - i * v.h * 0.042, top + barH + v.h * 0.05, v.h * 0.013, match.wins[1] > i)
  }

  const secs = Math.min(99, Math.ceil(match.timer / 60))
  ctx.textAlign = 'center'
  font(ctx, v.h * 0.085, 700)
  ctx.fillStyle = secs <= 10 ? '#e05a4f' : INK
  ctx.fillText(String(secs).padStart(2, '0'), v.w / 2, top)

  meter(ctx, pad, v.h - v.h * 0.05, v.w * 0.24, v.h * 0.022, false, a.meter)
  meter(ctx, v.w - pad - v.w * 0.24, v.h - v.h * 0.05, v.w * 0.24, v.h * 0.022, true, b.meter)

  for (let i = 0; i < 2; i++) {
    if (match.combo[i] < 2) continue
    ctx.textAlign = i === 0 ? 'left' : 'right'
    font(ctx, v.h * 0.048, 700)
    ctx.fillStyle = '#ffd166'
    ctx.fillText(`${match.combo[i]} HITS`, i === 0 ? pad : v.w - pad, v.h * 0.22)
  }
  ctx.textBaseline = 'alphabetic'
}

function bar(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  flip: boolean, frac: number, colour: string,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6)
  ctx.fillStyle = '#48201f'
  ctx.fillRect(x, y, w, h)
  const fw = Math.max(0, Math.min(1, frac)) * w
  ctx.fillStyle = colour
  ctx.fillRect(flip ? x + w - fw : x, y, fw, h)
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, w, h)
}

function meter(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, flip: boolean, value: number,
): void {
  const seg = w / 4
  for (let i = 0; i < 4; i++) {
    const sx = flip ? x + w - (i + 1) * seg : x + i * seg
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(sx + 2, y, seg - 4, h)
    const fill = Math.max(0, Math.min(1, value - i))
    if (fill <= 0) continue
    ctx.fillStyle = fill >= 1 ? '#ffd166' : 'rgba(255,209,102,0.45)'
    ctx.fillRect(sx + 2, y, (seg - 4) * fill, h)
  }
}

function pip(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, on: boolean): void {
  ctx.beginPath()
  ctx.arc(x + r, y + r, r, 0, Math.PI * 2)
  ctx.fillStyle = on ? '#ffd166' : 'rgba(255,255,255,0.22)'
  ctx.fill()
}

function drawBanner(ctx: CanvasRenderingContext2D, match: Match, v: View, opts: RenderOptions): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (match.phase === 'intro') {
    const late = match.phaseFrame > 46
    font(ctx, v.h * 0.13, 700)
    ctx.fillStyle = late ? '#ffd166' : INK
    ctx.fillText(late ? 'FIGHT' : `ROUND ${match.round}`, v.w / 2, v.h * 0.36)
    if (opts.hint && match.round === 1) controls(ctx, v)
  } else if (match.phase === 'ko') {
    font(ctx, v.h * 0.15, 700)
    ctx.fillStyle = '#e05a4f'
    ctx.fillText(match.roundWinner === null ? 'DRAW' : 'K.O.', v.w / 2, v.h * 0.36)
  } else if (match.phase === 'over') {
    const winner = match.wins[0] > match.wins[1] ? match.fighters[0] : match.fighters[1]
    font(ctx, v.h * 0.095, 700)
    ctx.fillStyle = '#ffd166'
    ctx.fillText(`${winner.character.name} WINS`, v.w / 2, v.h * 0.34)
    font(ctx, v.h * 0.036)
    ctx.fillStyle = DIM
    ctx.fillText('R — RUN IT BACK', v.w / 2, v.h * 0.44)
  }
  ctx.textBaseline = 'alphabetic'
}

function controls(ctx: CanvasRenderingContext2D, v: View): void {
  const lines = [
    'A D move    W jump    S crouch    hold back to block',
    'F G H punches    C V B kicks',
    '236 + punch fireball        623 + punch uppercut',
    'F1 hitboxes   F2 training   1 2 3 opponent   4 two players   R reset',
  ]
  font(ctx, v.h * 0.031)
  ctx.fillStyle = DIM
  lines.forEach((l, i) => ctx.fillText(l, v.w / 2, v.h * 0.52 + i * v.h * 0.045))
}

/** The tuning readout: what each fighter is doing, this frame, in the genre's own vocabulary. */
function drawFrameData(ctx: CanvasRenderingContext2D, match: Match, v: View): void {
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  font(ctx, v.h * 0.028)
  const lineH = v.h * 0.036

  match.fighters.forEach((f, i) => {
    const x = i === 0 ? v.w * 0.022 : v.w * 0.76
    let y = v.h * 0.27
    const put = (s: string, colour = DIM): void => {
      ctx.fillStyle = colour
      ctx.fillText(s, x, y)
      y += lineH
    }
    put(`${f.state}  ${f.stateFrame}`, INK)
    const m = f.action
    if (m) {
      const begin = m.startup - 1
      const fr = f.actionFrame
      const phase = fr < begin ? 'startup' : fr < begin + m.active ? 'ACTIVE' : 'recovery'
      put(`${m.name}  ${m.startup}/${m.active}/${m.recovery}`, INK)
      put(`f${fr + 1}/${totalFrames(m)}  ${phase}`, phase === 'ACTIVE' ? '#ff8080' : DIM)
      const adv = blockAdvantage(m)
      put(`on block ${adv >= 0 ? '+' : ''}${adv}`)
    }
    if (f.hitstop > 0) put(`hitstop ${f.hitstop}`, '#ffd166')
    if (f.invulnerable) put('INVULNERABLE', '#ffd166')
    put(`x ${f.x.toFixed(0)}  y ${f.y.toFixed(0)}  hp ${f.health}`)
  })

  ctx.textAlign = 'center'
  ctx.fillStyle = DIM
  ctx.fillText(`gap ${Math.abs(match.fighters[0].x - match.fighters[1].x).toFixed(0)}`, v.w / 2, v.h * 0.27)
  ctx.fillText(`frame ${match.frame}`, v.w / 2, v.h * 0.27 + lineH)
  ctx.textBaseline = 'alphabetic'
}

/**
 * Lighten or darken a hex colour. Placeholder art needs exactly this much colour theory.
 *
 * Returns hex rather than `rgb(...)` so that shading a shade works — the hit flash is a lightened
 * body colour, and the legs are that colour darkened. Returning `rgb()` made the second call parse
 * `NaN` and paint everything black, which is a very confusing way to find out.
 */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const hx = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)))))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
  return `#${hx}`
}
