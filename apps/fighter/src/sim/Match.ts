// Two fighters, the space between them, and the rules for what happens when one touches the other.
//
// Everything that crosses between fighters goes through here. A Fighter never reads the other
// Fighter; Match reads both and calls methods on each. That separation is what makes the whole
// simulation runnable with no canvas, no browser and no art, which is how the tests run it.

import { Fighter, BODY_HALF, STAGE_HALF } from './Fighter'
import { overlap, scaled, type Box, type Height, type Move } from './Moves'

export const ROUND_FRAMES = 99 * 60
export const ROUNDS_TO_WIN = 2
export const HITSTOP_HIT = 9
export const HITSTOP_BLOCK = 6
/** How long the KO freeze lasts before the next round is set up. */
export const KO_FRAMES = 150
export const INTRO_FRAMES = 80

export type Phase = 'intro' | 'fight' | 'ko' | 'over'

export interface Projectile {
  owner: 0 | 1
  x: number
  y: number
  vx: number
  box: Box
  damage: number
  hitstun: number
  blockstun: number
  dead: boolean
}

/** The last thing that happened, for the HUD and for tests to assert on. */
export interface Event {
  kind: 'hit' | 'block' | 'ko' | 'round' | 'whiff'
  who: 0 | 1
  move?: string
  damage?: number
  combo?: number
}

export class Match {
  readonly fighters: [Fighter, Fighter]
  readonly projectiles: Projectile[] = []
  readonly wins: [number, number] = [0, 0]
  readonly combo: [number, number] = [0, 0]
  /**
   * Where the last few hits landed, so the renderer can put a mark there. Effects live in the sim
   * rather than the renderer because the contact point is known here and nowhere else — the boxes
   * that produced it are gone by the time anything is drawn.
   */
  readonly impacts: Array<{ x: number; y: number; blocked: boolean; life: number }> = []

  phase: Phase = 'intro'
  phaseFrame = 0
  round = 1
  timer = ROUND_FRAMES
  frame = 0
  events: Event[] = []
  /** Set when a round ends: who won it, or null for a double KO / time-out draw. */
  roundWinner: 0 | 1 | null = null

  constructor(a: string, b: string) {
    this.fighters = [new Fighter(a, -160, 1), new Fighter(b, 160, -1)]
  }

  get over(): boolean {
    return this.phase === 'over'
  }

  /**
   * One fixed tick. Inputs must already be in each fighter's history — the caller owns where input
   * comes from, so the same Match runs against a keyboard, a CPU, or a recorded script.
   */
  tick(): void {
    this.frame++
    this.events = []
    this.phaseFrame++

    switch (this.phase) {
      case 'intro':
        if (this.phaseFrame >= INTRO_FRAMES) this.setPhase('fight')
        return
      case 'ko':
        // Fighters keep falling over during the freeze; nothing else runs.
        for (const f of this.fighters) f.tick()
        if (this.phaseFrame >= KO_FRAMES) this.nextRound()
        return
      case 'over':
        for (const f of this.fighters) f.tick()
        return
    }

    const [a, b] = this.fighters
    a.faceToward(b.x)
    b.faceToward(a.x)

    for (const f of this.fighters) f.tick()

    this.collectProjectiles()
    this.stepProjectiles()
    this.resolveStrikes()
    for (let i = this.impacts.length - 1; i >= 0; i--) if (--this.impacts[i].life <= 0) this.impacts.splice(i, 1)
    this.decayCombos()
    this.separate()
    this.clampCamera()

    if (this.timer > 0) this.timer--
    if (this.timer === 0) this.endRound(this.byHealth())
  }

  private setPhase(p: Phase): void {
    this.phase = p
    this.phaseFrame = 0
  }

  private collectProjectiles(): void {
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i]
      const m = f.spawn
      if (!m?.projectile) continue
      f.spawn = null
      const p = m.projectile
      this.projectiles.push({
        owner: i as 0 | 1,
        x: f.x + ((p.at.x0 + p.at.x1) / 2) * f.facing,
        y: f.y + p.at.y0,
        vx: p.speed * f.facing,
        box: { x0: -(p.at.x1 - p.at.x0) / 2, y0: 0, x1: (p.at.x1 - p.at.x0) / 2, y1: p.at.y1 - p.at.y0 },
        damage: Math.round(p.damage * f.character.damageScale),
        hitstun: p.hitstun,
        blockstun: p.blockstun,
        dead: false,
      })
    }
  }

  private stepProjectiles(): void {
    for (const p of this.projectiles) {
      if (p.dead) continue
      const owner = this.fighters[p.owner]
      if (owner.hitstop > 0) continue
      p.x += p.vx
      if (Math.abs(p.x) > STAGE_HALF + 80) {
        p.dead = true
        continue
      }
      const target = this.fighters[1 - p.owner]
      if (target.invulnerable || target.state === 'ko' || target.state === 'down') continue
      const world: Box = { x0: p.x + p.box.x0, y0: p.y + p.box.y0, x1: p.x + p.box.x1, y1: p.y + p.box.y1 }
      if (!overlap(world, target.hurtBox())) continue
      p.dead = true
      this.land(p.owner, {
        contact: { x: p.x, y: p.y + (p.box.y0 + p.box.y1) / 2 },
        damage: p.damage,
        chip: Math.round(p.damage / 8),
        hitstun: p.hitstun,
        blockstun: p.blockstun,
        height: 'mid',
        pushHit: 6,
        pushBlock: 8,
        knockdown: false,
        meter: 4,
        name: 'Fireball',
        attackerPush: 0,
      })
    }
    // Two fireballs meeting cancel each other, which is the only reason a zoner ever approaches.
    for (let i = 0; i < this.projectiles.length; i++) {
      for (let j = i + 1; j < this.projectiles.length; j++) {
        const p = this.projectiles[i]
        const q = this.projectiles[j]
        if (p.dead || q.dead || p.owner === q.owner) continue
        const pw: Box = { x0: p.x + p.box.x0, y0: p.y + p.box.y0, x1: p.x + p.box.x1, y1: p.y + p.box.y1 }
        const qw: Box = { x0: q.x + q.box.x0, y0: q.y + q.box.y0, x1: q.x + q.box.x1, y1: q.y + q.box.y1 }
        if (overlap(pw, qw)) {
          p.dead = true
          q.dead = true
        }
      }
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (this.projectiles[i].dead) this.projectiles.splice(i, 1)
  }

  private resolveStrikes(): void {
    for (let i = 0; i < 2; i++) {
      const attacker = this.fighters[i]
      const defender = this.fighters[1 - i]
      const hb = attacker.hitBox()
      if (!hb || !attacker.action) continue
      if (defender.state === 'ko' || defender.state === 'down') continue
      if (defender.invulnerable) continue
      if (!overlap(hb, defender.hurtBox())) continue

      const hurt = defender.hurtBox()
      const m = scaled(attacker.action, attacker.character)
      this.land(i as 0 | 1, {
        // The middle of the overlap, which is as close to "where it connected" as boxes get.
        contact: {
          x: (Math.max(hb.x0, hurt.x0) + Math.min(hb.x1, hurt.x1)) / 2,
          y: (Math.max(hb.y0, hurt.y0) + Math.min(hb.y1, hurt.y1)) / 2,
        },
        damage: m.damage,
        chip: m.chip ?? 0,
        hitstun: m.hitstun,
        blockstun: m.blockstun,
        height: m.height,
        pushHit: m.pushHit,
        pushBlock: m.pushBlock,
        knockdown: Boolean(m.knockdown),
        meter: m.meter,
        name: m.name,
        attackerPush: m.pushBlock / 2,
      })
    }
  }

  private land(
    who: 0 | 1,
    hit: {
      contact: { x: number; y: number }
      damage: number; chip: number; hitstun: number; blockstun: number; height: Height
      pushHit: number; pushBlock: number; knockdown: boolean; meter: number; name: string; attackerPush: number
    },
  ): void {
    const attacker = this.fighters[who]
    const defender = this.fighters[1 - who]

    // Guarding only works if the guard is in the right place: a low has to be blocked crouching and
    // an overhead standing. `mid` is stopped by either, which is most of the game.
    const guarding = defender.blocking
    const right = hit.height === 'mid' || (hit.height === 'low' ? defender.guardLow : !defender.guardLow)
    const blocked = guarding && right && defender.grounded

    if (blocked) {
      defender.takeBlock(hit.chip, hit.blockstun, hit.pushBlock, HITSTOP_BLOCK)
      attacker.didConnect(HITSTOP_BLOCK, hit.attackerPush, hit.meter / 2)
      this.combo[who] = 0
      this.impacts.push({ x: hit.contact.x, y: hit.contact.y, blocked: true, life: HITSTOP_BLOCK + 4 })
      this.events.push({ kind: 'block', who, move: hit.name })
    } else {
      // Damage scales down as a combo runs, so a long combo is worth having but not worth the round.
      const n = this.combo[who]
      const scale = n === 0 ? 1 : Math.max(0.3, 1 - n * 0.1)
      const dealt = Math.max(1, Math.round(hit.damage * scale))
      defender.takeHit(dealt, hit.hitstun, hit.pushHit, hit.knockdown, HITSTOP_HIT)
      attacker.didConnect(HITSTOP_HIT, 0, hit.meter)
      this.combo[who] = n + 1
      this.impacts.push({ x: hit.contact.x, y: hit.contact.y, blocked: false, life: HITSTOP_HIT + 5 })
      this.events.push({ kind: 'hit', who, move: hit.name, damage: dealt, combo: this.combo[who] })
      if (defender.health <= 0) this.endRound(who)
    }
    this.combo[1 - who] = 0
  }

  /**
   * A combo is by definition an unbroken run of hitstun, so the counter ends the moment the
   * defender can act again. Without this it is not a combo counter, it is a tally of every hit
   * anyone has ever landed.
   */
  private decayCombos(): void {
    for (let i = 0; i < 2; i++) {
      const d = this.fighters[1 - i]
      const stuck = d.state === 'hitstun' || d.state === 'down' || d.state === 'ko' || d.hitstop > 0
      if (!stuck) this.combo[i] = 0
    }
  }

  /** Nobody stands inside anybody. Shove both, or one if the other is against a wall. */
  private separate(): void {
    const [a, b] = this.fighters
    if (!a.overlapsBody(b)) return
    const gap = BODY_HALF * 2 - Math.abs(a.x - b.x)
    if (gap <= 0) return
    const dir = a.x <= b.x ? -1 : 1
    const wallA = Math.abs(a.x) >= STAGE_HALF - BODY_HALF - 0.5
    const wallB = Math.abs(b.x) >= STAGE_HALF - BODY_HALF - 0.5
    const share = wallA || wallB ? gap : gap / 2
    if (!wallA) a.x += dir * share
    if (!wallB) b.x -= dir * share
    for (const f of this.fighters) f.x = Math.max(-STAGE_HALF + BODY_HALF, Math.min(STAGE_HALF - BODY_HALF, f.x))
  }

  /** Nothing may leave the camera; the camera is the distance between them, clamped. */
  private clampCamera(): void {
    const [a, b] = this.fighters
    const spread = Math.abs(a.x - b.x)
    const max = STAGE_HALF * 1.55
    if (spread <= max) return
    const pull = (spread - max) / 2
    a.x += a.x < b.x ? pull : -pull
    b.x += b.x < a.x ? pull : -pull
  }

  private byHealth(): 0 | 1 | null {
    const [a, b] = this.fighters
    if (a.health === b.health) return null
    return a.health > b.health ? 0 : 1
  }

  private endRound(winner: 0 | 1 | null): void {
    if (this.phase !== 'fight') return
    this.roundWinner = winner
    if (winner !== null) {
      this.wins[winner]++
      this.fighters[winner].win()
    }
    this.events.push({ kind: 'ko', who: (winner ?? 0) as 0 | 1 })
    this.setPhase('ko')
  }

  private nextRound(): void {
    if (this.wins[0] >= ROUNDS_TO_WIN || this.wins[1] >= ROUNDS_TO_WIN) {
      this.setPhase('over')
      return
    }
    this.round++
    this.timer = ROUND_FRAMES
    this.projectiles.length = 0
    this.impacts.length = 0
    this.combo[0] = 0
    this.combo[1] = 0
    this.fighters[0].reset(-160, 1)
    this.fighters[1].reset(160, -1)
    this.events.push({ kind: 'round', who: 0 })
    this.setPhase('intro')
  }
}

export type { Move }
