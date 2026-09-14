// A 384×224 arcade monitor, scaled up by a whole number and letterboxed.
//
// Everything in the sim is in the 1991 machine's pixels, so the view is that machine's screen: the
// camera follows the midpoint between the fighters and stops at the stage walls, the fighters can
// never be further apart than the screen is wide, and there is no zoom. The canvas is filled with as
// many whole copies of that screen as fit, because a sprite drawn at 3.0× is crisp and a sprite
// drawn at 3.17× shimmers as it walks.
//
// Sprites are optional. A fighter with no atlas is drawn as a torso, a head, legs and whichever
// limb is attacking — pulled from the move's own hitbox, so a move that looks wrong is wrong. A stage
// with no art is a gradient and a floor line. F1 puts the real boxes over either.

import { SYSTEM } from '../sim/Character'
import type { Fighter } from '../sim/Fighter'
import { ROUNDS_TO_WIN, type Match } from '../sim/Match'
import { blockAdvantage, totalFrames, type Box } from '../sim/Moves'
import { fxFrame, poseOf, type CharacterArt, type FrameRect, type FxArt, type StageArt } from './Sprites'

export const VIEW_W = SYSTEM.screen[0]
export const VIEW_H = SYSTEM.screen[1]
/** Where the floor line sits on the monitor, from the top. */
export const FLOOR_Y = SYSTEM.floorScreenY

export interface RenderOptions {
  /** F1: hitboxes, hurtboxes and frame data. */
  debug: boolean
  /** The banner shown before the first round. */
  hint: boolean
}

/** Everything the renderer needs that is not the match itself: the art, or the lack of it. */
export interface Scene {
  chars: [CharacterArt | null, CharacterArt | null]
  stage: StageArt | null
  fx: FxArt | null
}

interface View {
  /** World x at the centre of the screen. */
  camera: number
  /** World → screen for x. */
  sx(x: number): number
}

const INK = '#f4f0e4'
const DIM = 'rgba(244,240,228,0.5)'
const BAR_YELLOW = '#f8d838'
const BAR_RED = '#c81818'

/** Scratch surface for tinting a sprite white on the frame it is hit. */
let flash: HTMLCanvasElement | null = null

export function render(ctx: CanvasRenderingContext2D, match: Match, scene: Scene, opts: RenderOptions): void {
  const cv = ctx.canvas
  const scale = Math.max(1, Math.floor(Math.min(cv.width / VIEW_W, cv.height / VIEW_H)))
  const ox = Math.floor((cv.width - VIEW_W * scale) / 2)
  const oy = Math.floor((cv.height - VIEW_H * scale) / 2)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.setTransform(scale, 0, 0, scale, ox, oy)
  ctx.imageSmoothingEnabled = false
  ctx.beginPath()
  ctx.rect(0, 0, VIEW_W, VIEW_H)
  ctx.clip()

  const [a, b] = match.fighters
  const stageHalf = match.stageHalf
  const reach = Math.max(0, stageHalf - VIEW_W / 2)
  const mid = (a.x + b.x) / 2
  const camera = Math.max(-reach, Math.min(reach, mid))
  const view: View = { camera, sx: (x) => Math.round(x - camera + VIEW_W / 2) }

  drawStage(ctx, scene.stage, view, stageHalf)

  // Whoever is further away draws first, so the nearer fighter overlaps — the only depth cue a flat
  // plane has. A thrown body draws over the thrower.
  const order = a.state === 'thrown' ? [b, a] : b.state === 'thrown' ? [a, b] : a.y >= b.y ? [b, a] : [a, b]
  for (const f of order) drawFighter(ctx, f, scene.chars[match.fighters.indexOf(f)], view, opts.debug)
  for (const p of match.projectiles) drawProjectile(ctx, p, scene.chars[p.owner], view, opts.debug)
  for (const im of match.impacts) drawImpact(ctx, im, scene.fx, view)

  drawHud(ctx, match, scene)
  drawBanner(ctx, match, opts)
  if (opts.debug) drawFrameData(ctx, match)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// --- the stage ---------------------------------------------------------------------------------

function drawStage(ctx: CanvasRenderingContext2D, stage: StageArt | null, v: View, stageHalf: number): void {
  if (!stage) return drawStandInStage(ctx, v, stageHalf)

  ctx.fillStyle = stage.sky ?? '#000'
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)

  for (const l of stage.layers) {
    const cx = VIEW_W / 2 + l.x - v.camera * l.parallax
    const top = FLOOR_Y + l.y - l.h
    if (l.repeat) {
      let x = cx - l.w / 2
      while (x > 0) x -= l.w
      for (; x < VIEW_W; x += l.w) ctx.drawImage(l.image, Math.round(x), Math.round(top), l.w, l.h)
    } else {
      ctx.drawImage(l.image, Math.round(cx - l.w / 2), Math.round(top), l.w, l.h)
    }
  }
}

function drawStandInStage(ctx: CanvasRenderingContext2D, v: View, stageHalf: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR_Y)
  sky.addColorStop(0, '#101219')
  sky.addColorStop(0.7, '#1d1c1c')
  sky.addColorStop(1, '#2e2719')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, VIEW_W, FLOOR_Y)

  // Fence posts parallaxing at half speed: the only thing telling you the camera moved.
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
  for (let x = -1200; x <= 1200; x += 48) {
    const sx = Math.round(x - v.camera * 0.5 + VIEW_W / 2)
    if (sx < -2 || sx > VIEW_W + 2) continue
    ctx.fillRect(sx, Math.round(FLOOR_Y * 0.3), 1, FLOOR_Y * 0.7)
  }

  ctx.fillStyle = '#39311f'
  ctx.fillRect(0, FLOOR_Y, VIEW_W, VIEW_H - FLOOR_Y)
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  ctx.fillRect(0, FLOOR_Y, VIEW_W, 1)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  for (let x = -stageHalf; x <= stageHalf; x += 32) ctx.fillRect(v.sx(x), FLOOR_Y + 2, 1, VIEW_H - FLOOR_Y)

  for (const wall of [-stageHalf, stageHalf]) {
    const sx = v.sx(wall)
    if (sx < -4 || sx > VIEW_W + 4) continue
    ctx.fillStyle = 'rgba(180,48,58,0.6)'
    ctx.fillRect(sx - 1, FLOOR_Y - 96, 3, 96)
  }
}

// --- fighters ----------------------------------------------------------------------------------

function drawFighter(ctx: CanvasRenderingContext2D, f: Fighter, art: CharacterArt | null, v: View, debug: boolean): void {
  const sx = v.sx(f.x)
  const sy = FLOOR_Y - Math.round(f.y)

  // The shadow shrinks with height, which is most of what tells you how high a jump is.
  const lift = Math.max(0.3, 1 - Math.max(0, f.y) / 140)
  ctx.fillStyle = `rgba(0,0,0,${0.35 * lift})`
  ctx.beginPath()
  ctx.ellipse(sx, FLOOR_Y + 1, 18 * lift, 3 * lift, 0, 0, Math.PI * 2)
  ctx.fill()

  const struck = f.hitstop > 0 && (f.state === 'hitstun' || f.state === 'blockstun')
  const pose = art ? poseOf(f, art) : null
  if (pose && art) drawSprite(ctx, art.image, pose.frame, sx, sy, pose.flip, struck)
  else drawStandInFighter(ctx, f, sx, sy, struck)

  if (f.state === 'dizzy') drawStars(ctx, sx, sy - f.character.hurt.stand.y1 - 6, f.stateFrame)

  if (debug) {
    drawBox(ctx, f.hurtBox(), 'rgba(90,190,255,0.85)', v)
    drawBox(ctx, f.bodyBox(), 'rgba(255,255,255,0.25)', v)
    const hit = f.hitBox()
    if (hit) drawBox(ctx, hit, 'rgba(255,70,70,0.95)', v)
    if (f.invulnerable || f.projectileInvulnerable) {
      const b = f.hurtBox()
      ctx.strokeStyle = f.invulnerable ? '#ffd166' : 'rgba(255,209,102,0.5)'
      ctx.lineWidth = 1
      ctx.strokeRect(v.sx(b.x0) - 2, FLOOR_Y - b.y1 - 2, b.x1 - b.x0 + 4, b.y1 - b.y0 + 4)
    }
  }
}

function drawSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, fr: FrameRect, sx: number, sy: number, flip: boolean, struck: boolean): void {
  ctx.save()
  ctx.translate(sx, sy)
  if (flip) ctx.scale(-1, 1)
  if (struck) {
    // Tint the sprite, not the rectangle it sits in: draw it alone, wash it, then place it.
    flash ??= document.createElement('canvas')
    if (flash.width < fr.w || flash.height < fr.h) {
      flash.width = Math.max(flash.width, fr.w)
      flash.height = Math.max(flash.height, fr.h)
    }
    const fc = flash.getContext('2d')
    if (fc) {
      fc.clearRect(0, 0, flash.width, flash.height)
      fc.globalCompositeOperation = 'source-over'
      fc.drawImage(img, fr.x, fr.y, fr.w, fr.h, 0, 0, fr.w, fr.h)
      fc.globalCompositeOperation = 'source-atop'
      fc.fillStyle = 'rgba(255,255,255,0.75)'
      fc.fillRect(0, 0, fr.w, fr.h)
      ctx.drawImage(flash, 0, 0, fr.w, fr.h, -fr.ax, -fr.ay, fr.w, fr.h)
      ctx.restore()
      return
    }
  }
  ctx.drawImage(img, fr.x, fr.y, fr.w, fr.h, -fr.ax, -fr.ay, fr.w, fr.h)
  ctx.restore()
}

/**
 * Programmer art, drawn honestly: the attacking limb comes from the move's own hitbox, reaching out
 * through startup, locked at full extension while it is active, and pulled back through recovery.
 */
function drawStandInFighter(ctx: CanvasRenderingContext2D, f: Fighter, sx: number, sy: number, struck: boolean): void {
  const hb = f.character.hurt[f.stance]
  const h = hb.y1 - hb.y0
  const c = f.character
  const body = struck ? shade(c.body, 0.7) : c.body
  const down = f.state === 'down' || f.state === 'ko'

  ctx.save()
  ctx.translate(sx, sy - hb.y0)
  ctx.scale(f.facing, 1)
  if (down) {
    ctx.rotate(-1.2)
    ctx.translate(-h * 0.34, -h * 0.1)
  } else if (f.state === 'hitstun') ctx.rotate(-0.2)
  else if (f.state === 'dizzy') ctx.rotate(Math.sin(f.stateFrame / 6) * 0.12)

  const hipY = -h * 0.42
  const shoulderY = -h * 0.84
  const headR = h * 0.115
  const legW = Math.max(3, h * 0.12)
  const splay = f.stance === 'air' ? 3 : f.stance === 'crouch' ? 12 : 8

  ctx.strokeStyle = shade(body, -0.28)
  ctx.lineWidth = legW
  ctx.lineCap = 'round'
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(0, hipY)
    ctx.lineTo(s * splay, f.stance === 'air' ? hipY + h * 0.28 : -legW / 2)
    ctx.stroke()
  }
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.roundRect(-h * 0.13, shoulderY, h * 0.26, hipY - shoulderY, h * 0.05)
  ctx.fill()
  ctx.fillStyle = shade(body, 0.2)
  ctx.beginPath()
  ctx.arc(headR * 0.3, -h * 0.96, headR, 0, Math.PI * 2)
  ctx.fill()

  if (f.state === 'blockstun' || (f.blocking && f.free)) {
    ctx.fillStyle = 'rgba(120,190,255,0.85)'
    ctx.fillRect(h * 0.11, f.guardLow ? hipY + h * 0.04 : shoulderY, h * 0.09, h * 0.34)
  }

  const m = f.action
  if (m && f.state === 'attack' && (m.hitbox.x1 !== m.hitbox.x0 || m.projectile)) {
    const begin = m.startup - 1
    const fr = f.actionFrame
    const t = fr < begin ? (fr / Math.max(1, begin)) * 0.88 : fr < begin + m.active ? 1 : Math.max(0, 1 - (fr - begin - m.active) / Math.max(1, m.recovery))
    const kick = m.button === 'K' || m.id.endsWith('k')
    const from = kick ? hipY : shoulderY
    const box = m.projectile ? m.projectile.at : m.hitbox
    const tx = ((box.x0 + box.x1) / 2) * t
    const ty = -((box.y0 + box.y1) / 2) * t + from * (1 - t)
    ctx.strokeStyle = c.trim
    ctx.lineWidth = Math.max(3, h * (kick ? 0.105 : 0.088))
    ctx.beginPath()
    ctx.moveTo(0, from)
    ctx.lineTo(tx, ty)
    ctx.stroke()
    ctx.fillStyle = shade(c.trim, 0.3)
    ctx.beginPath()
    ctx.arc(tx, ty, Math.max(2, h * (kick ? 0.065 : 0.052)), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawStars(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  ctx.fillStyle = '#ffe066'
  for (let i = 0; i < 4; i++) {
    const a = t / 8 + (i * Math.PI) / 2
    const px = x + Math.cos(a) * 12
    const py = y + Math.sin(a) * 3
    ctx.fillRect(Math.round(px) - 1, Math.round(py) - 1, 3, 3)
  }
}

function drawProjectile(ctx: CanvasRenderingContext2D, p: Match['projectiles'][number], art: CharacterArt | null, v: View, debug: boolean): void {
  const sx = v.sx(p.x)
  const cy = FLOOR_Y - p.y - (p.box.y0 + p.box.y1) / 2
  const a = art && p.anim ? art.anims[p.anim] : undefined
  if (art && a && a.frames.length) {
    const fr = art.frames[a.frames[Math.floor((p.age * a.fps) / 60) % a.frames.length]]
    if (fr) drawSprite(ctx, art.image, fr, sx, Math.round(FLOOR_Y - p.y), p.vx < 0, false)
  } else {
    const r = (p.box.y1 - p.box.y0) / 2
    const g = ctx.createRadialGradient(sx, cy, 1, sx, cy, r * 1.5)
    g.addColorStop(0, '#fff')
    g.addColorStop(0.45, '#6fb8ff')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.ellipse(sx, cy, r * 1.5, r, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  if (debug) drawBox(ctx, { x0: p.x + p.box.x0, y0: p.y + p.box.y0, x1: p.x + p.box.x1, y1: p.y + p.box.y1 }, 'rgba(255,200,60,0.9)', v)
}

/**
 * A hit mark. The ripped sparks if we have them; otherwise white spokes for a hit and a blue arc for
 * a guard — the same two readings the genre has used since the beginning.
 */
function drawImpact(ctx: CanvasRenderingContext2D, im: Match['impacts'][number], fx: FxArt | null, v: View): void {
  const x = v.sx(im.x)
  const y = Math.round(FLOOR_Y - im.y)
  const total = im.heavy ? 17 : 13
  const age = Math.max(0, total - im.life)
  if (fx) {
    const fr = fxFrame(fx, im.blocked ? 'block' : im.heavy ? 'hit-heavy' : 'hit-light', age, 'hit-light')
    if (fr) {
      ctx.drawImage(fx.image, fr.x, fr.y, fr.w, fr.h, x - fr.ax, y - fr.ay, fr.w, fr.h)
      return
    }
  }
  const t = Math.max(0, Math.min(1, im.life / 12))
  ctx.globalAlpha = t
  if (im.blocked) {
    ctx.strokeStyle = '#7dc4ff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, 8 + (1 - t) * 10, -0.9, 0.9)
    ctx.stroke()
  } else {
    const r = 6 + (1 - t) * 16
    ctx.strokeStyle = '#fff6e0'
    ctx.lineWidth = 2
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3
      ctx.beginPath()
      ctx.moveTo(x + Math.cos(a) * r * 0.35, y + Math.sin(a) * r * 0.35)
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r)
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

function drawBox(ctx: CanvasRenderingContext2D, b: Box, colour: string, v: View): void {
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  ctx.strokeRect(v.sx(b.x0) + 0.5, FLOOR_Y - b.y1 + 0.5, b.x1 - b.x0, b.y1 - b.y0)
}

// --- the furniture ----------------------------------------------------------------------------

function font(ctx: CanvasRenderingContext2D, px: number, weight = 700): void {
  ctx.font = `${weight} ${px}px ui-monospace, "Courier New", monospace`
}

function drawHud(ctx: CanvasRenderingContext2D, match: Match, scene: Scene): void {
  const [a, b] = match.fighters
  const barW = 144 // one point of health is one pixel, as it was
  const barH = 8
  const top = 12
  const pad = 22

  bar(ctx, pad, top, barW, barH, false, a.health / a.character.health)
  bar(ctx, VIEW_W - pad - barW, top, barW, barH, true, b.health / b.character.health)

  // Portraits sit outside the bars if the art has them.
  for (const [i, art] of scene.chars.entries()) {
    const img = art?.portrait
    if (!img) continue
    const s = 18
    const x = i === 0 ? pad - s - 3 : VIEW_W - pad + 3
    ctx.drawImage(img, x, top - 5, s, s)
  }

  font(ctx, 7)
  ctx.textBaseline = 'top'
  ctx.fillStyle = INK
  ctx.textAlign = 'left'
  ctx.fillText(a.character.name, pad, top + barH + 3)
  ctx.textAlign = 'right'
  ctx.fillText(b.character.name, VIEW_W - pad, top + barH + 3)

  for (let i = 0; i < ROUNDS_TO_WIN; i++) {
    pip(ctx, pad + barW - 6 - i * 8, top + barH + 3, match.wins[0] > i)
    pip(ctx, VIEW_W - pad - barW + 1 + i * 8, top + barH + 3, match.wins[1] > i)
  }

  const secs = Math.min(99, Math.ceil(match.timer / SYSTEM.timerFramesPerTick))
  ctx.textAlign = 'center'
  font(ctx, 16)
  ctx.fillStyle = secs <= 10 ? '#e05a4f' : INK
  ctx.fillText(String(secs).padStart(2, '0'), VIEW_W / 2, top - 4)

  meter(ctx, pad, VIEW_H - 12, 72, 4, false, a.meter)
  meter(ctx, VIEW_W - pad - 72, VIEW_H - 12, 72, 4, true, b.meter)

  for (let i = 0; i < 2; i++) {
    if (match.combo[i] < 2) continue
    ctx.textAlign = i === 0 ? 'left' : 'right'
    font(ctx, 10)
    ctx.fillStyle = '#ffd166'
    ctx.fillText(`${match.combo[i]} HITS`, i === 0 ? pad : VIEW_W - pad, 46)
  }
  ctx.textBaseline = 'alphabetic'
}

/** Remaining health hugs the outer edge; the damage shows as red creeping in from the middle. */
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, flip: boolean, frac: number): void {
  ctx.fillStyle = '#000'
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2)
  ctx.fillStyle = BAR_RED
  ctx.fillRect(x, y, w, h)
  const fw = Math.round(Math.max(0, Math.min(1, frac)) * w)
  ctx.fillStyle = BAR_YELLOW
  ctx.fillRect(flip ? x + w - fw : x, y, fw, h)
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillRect(flip ? x + w - fw : x, y, fw, 1)
}

function meter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, flip: boolean, value: number): void {
  const seg = w / 4
  for (let i = 0; i < 4; i++) {
    const sx = flip ? x + w - (i + 1) * seg : x + i * seg
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(sx + 1, y, seg - 2, h)
    const fill = Math.max(0, Math.min(1, value - i))
    if (fill <= 0) continue
    ctx.fillStyle = fill >= 1 ? '#ffd166' : 'rgba(255,209,102,0.45)'
    ctx.fillRect(sx + 1, y, (seg - 2) * fill, h)
  }
}

function pip(ctx: CanvasRenderingContext2D, x: number, y: number, on: boolean): void {
  ctx.fillStyle = on ? '#ffd166' : 'rgba(255,255,255,0.25)'
  ctx.fillRect(x, y + 1, 5, 5)
}

function drawBanner(ctx: CanvasRenderingContext2D, match: Match, opts: RenderOptions): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const shadowText = (s: string, x: number, y: number, colour: string): void => {
    ctx.fillStyle = 'rgba(0,0,0,0.8)'
    ctx.fillText(s, x + 1, y + 1)
    ctx.fillStyle = colour
    ctx.fillText(s, x, y)
  }

  if (match.phase === 'intro') {
    const late = match.phaseFrame > 46
    font(ctx, 22)
    shadowText(late ? 'FIGHT!' : `ROUND ${match.round}`, VIEW_W / 2, 84, late ? '#ffd166' : INK)
    if (opts.hint && match.round === 1) controls(ctx)
  } else if (match.phase === 'ko') {
    font(ctx, 26)
    shadowText(match.roundWinner === null ? 'DRAW' : 'K.O.', VIEW_W / 2, 84, '#e05a4f')
  } else if (match.phase === 'over') {
    const winner = match.wins[0] > match.wins[1] ? match.fighters[0] : match.fighters[1]
    font(ctx, 16)
    shadowText(`${winner.character.name} WINS`, VIEW_W / 2, 80, '#ffd166')
    font(ctx, 7)
    shadowText('R — RUN IT BACK', VIEW_W / 2, 96, DIM)
  }
  ctx.textBaseline = 'alphabetic'
}

function controls(ctx: CanvasRenderingContext2D): void {
  const lines = [
    'A D walk  W jump  S crouch  hold back to block',
    'F G H punch   C V B kick   N = 3P   M = 3K',
    'fwd+heavy up close = throw',
    '5 6 7 pick P1   8 9 0 pick P2   F1 boxes   F2 dummy',
  ]
  font(ctx, 7, 600)
  ctx.fillStyle = DIM
  lines.forEach((l, i) => ctx.fillText(l, VIEW_W / 2, 118 + i * 10))
}

/** The tuning readout: what each fighter is doing, this frame, in the genre's own vocabulary. */
function drawFrameData(ctx: CanvasRenderingContext2D, match: Match): void {
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  font(ctx, 6, 600)
  const lineH = 7

  match.fighters.forEach((f, i) => {
    const x = i === 0 ? 6 : VIEW_W - 110
    let y = 56
    const put = (s: string, colour = DIM): void => {
      ctx.fillStyle = colour
      ctx.fillText(s, x, y)
      y += lineH
    }
    put(`${f.state} ${f.stateFrame}`, INK)
    const m = f.action
    if (m) {
      const begin = m.startup - 1
      const fr = f.actionFrame
      const phase = fr < begin ? 'startup' : fr < begin + m.active ? 'ACTIVE' : 'recovery'
      put(`${m.name} ${m.startup}/${m.active}/${m.recovery}`, INK)
      put(`f${fr + 1}/${totalFrames(m)} ${phase}`, phase === 'ACTIVE' ? '#ff8080' : DIM)
      const adv = blockAdvantage(m)
      put(`on block ${adv >= 0 ? '+' : ''}${adv}  dmg ${m.damage}`)
    }
    if (f.hitstop > 0) put(`hitstop ${f.hitstop}`, '#ffd166')
    if (f.invulnerable) put('INVULNERABLE', '#ffd166')
    put(`x ${f.x.toFixed(0)} y ${f.y.toFixed(0)} hp ${f.health} stun ${f.stun}`)
  })

  ctx.textAlign = 'center'
  ctx.fillStyle = DIM
  ctx.fillText(`gap ${Math.abs(match.fighters[0].x - match.fighters[1].x).toFixed(0)}  frame ${match.frame}`, VIEW_W / 2, 40)
  ctx.textBaseline = 'alphabetic'
}

/**
 * Lighten or darken a hex colour. Returns hex rather than `rgb(...)` so that shading a shade works.
 */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const hx = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)))))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
  return `#${hx}`
}
