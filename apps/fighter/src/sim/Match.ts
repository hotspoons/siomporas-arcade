// Two fighters, the space between them, and the rules for what happens when one touches the other.
//
// Everything that crosses between fighters goes through here. A Fighter never reads the other
// Fighter; Match reads both and calls methods on each. That separation is what makes the whole
// simulation runnable with no canvas, no browser and no art, which is how the tests run it.

import { Fighter } from './Fighter'
import { SYSTEM, RULES } from './Character'
import { overlap, type Box, type Height, type Move } from './Moves'

/** The clock counts down once per `timerFramesPerTick`, not per second — 99 is 66 real seconds, as it was. */
export const ROUND_FRAMES = SYSTEM.roundSeconds * SYSTEM.timerFramesPerTick
export const ROUNDS_TO_WIN = SYSTEM.roundsToWin
/** How long the KO freeze lasts before the next round is set up. */
export const KO_FRAMES = SYSTEM.koFrames
export const INTRO_FRAMES = SYSTEM.introFrames
/** Where the two start a round, either side of the stage's middle. */
export const START_X = 76

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
  /** Sprite animation, if the art has one. */
  anim?: string
  /** Frames alive, for the animation. */
  age: number
  dead: boolean
}

/** The last thing that happened, for the HUD and for tests to assert on. */
export interface Event {
  kind: 'hit' | 'block' | 'throw' | 'ko' | 'round' | 'whiff' | 'dizzy'
  who: 0 | 1
  move?: string
  damage?: number
  combo?: number
}

/** A move's chip under the rules currently in force, rather than the ones it was written under. */
function chipNow(baked: number): number {
  if (baked <= 0 || SYSTEM.chipFraction <= 0) return 0
  if (RULES.chipFraction === SYSTEM.chipFraction) return baked
  return Math.round(baked * (RULES.chipFraction / SYSTEM.chipFraction))
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
  readonly impacts: Array<{ x: number; y: number; blocked: boolean; heavy: boolean; life: number }> = []

  readonly stageHalf: number
  phase: Phase = 'intro'
  phaseFrame = 0
  round = 1
  timer = ROUND_FRAMES
  frame = 0
  events: Event[] = []
  /** Set when a round ends: who won it, or null for a double KO / time-out draw. */
  roundWinner: 0 | 1 | null = null
  /** A grab in progress: who is holding whom, and for how long. */
  private hold: { who: 0 | 1; frames: number; total: number; lift: number } | null = null

  constructor(a: string, b: string, stageHalf = SYSTEM.stageHalf) {
    this.stageHalf = stageHalf
    this.fighters = [new Fighter(a, -START_X, 1), new Fighter(b, START_X, -1)]
    for (const f of this.fighters) f.stageHalf = stageHalf
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
    const gap = Math.abs(a.x - b.x)
    a.sense(gap, b.grabbable)
    b.sense(gap, a.grabbable)

    for (const f of this.fighters) f.tick()

    this.resolveGrabs()
    this.carryHold()
    this.collectProjectiles()
    this.stepProjectiles()
    this.resolveStrikes()
    for (let i = this.impacts.length - 1; i >= 0; i--) if (--this.impacts[i].life <= 0) this.impacts.splice(i, 1)
    this.decayCombos()
    this.separate()
    this.clampSpread()

    if (this.timer > 0) this.timer--
    if (this.timer === 0) this.endRound(this.byHealth())
  }

  private setPhase(p: Phase): void {
    this.phase = p
    this.phaseFrame = 0
  }

  /** A grab reached its active frame this tick. Either there is a body in reach or there is not. */
  private resolveGrabs(): void {
    for (let i = 0; i < 2; i++) {
      const who = i as 0 | 1
      const attacker = this.fighters[who]
      const m = attacker.grab
      if (!m) continue
      attacker.grab = null
      const victim = this.fighters[1 - who]
      const gap = Math.abs(attacker.x - victim.x)
      if (!victim.grabbable || gap > m.range || this.hold) {
        attacker.whiffed()
        this.events.push({ kind: 'whiff', who, move: m.name })
        continue
      }
      victim.beThrown(m.damage, m.hold, m.stun)
      attacker.didConnect(0, 0, m.meter)
      this.hold = { who, frames: 0, total: m.hold, lift: m.kind === 'command-throw' ? 70 : 34 }
      this.combo[who] = Math.max(1, this.combo[who] + 1)
      this.events.push({ kind: 'throw', who, move: m.name, damage: m.damage })
    }
  }

  /** While someone is held, they go where the hands go. */
  private carryHold(): void {
    const h = this.hold
    if (!h) return
    const attacker = this.fighters[h.who]
    const victim = this.fighters[1 - h.who]
    if (victim.state !== 'thrown') {
      this.hold = null
      if (victim.health <= 0) this.endRound(h.who)
      return
    }
    h.frames++
    const t = h.frames / h.total
    // Up and over: the victim rises through the first half and comes down on the far side.
    const side = t < 0.55 ? 1 : -1
    const x = attacker.x + attacker.facing * side * (attacker.character.bodyHalf + victim.character.bodyHalf) * (t < 0.55 ? 1 : 0.7)
    const y = Math.sin(Math.min(1, t) * Math.PI) * h.lift
    victim.heldAt(x, y, (-attacker.facing) as 1 | -1)
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
        damage: p.damage,
        hitstun: p.hitstun,
        blockstun: p.blockstun,
        anim: p.anim,
        age: 0,
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
      p.age++
      if (Math.abs(p.x) > this.stageHalf + 80) {
        p.dead = true
        continue
      }
      const target = this.fighters[1 - p.owner]
      if (target.projectileInvulnerable || target.state === 'ko' || target.state === 'down' || target.state === 'thrown') continue
      const world: Box = { x0: p.x + p.box.x0, y0: p.y + p.box.y0, x1: p.x + p.box.x1, y1: p.y + p.box.y1 }
      if (!overlap(world, target.hurtBox())) continue
      p.dead = true
      this.land(p.owner, {
        contact: { x: p.x, y: p.y + (p.box.y0 + p.box.y1) / 2 },
        damage: p.damage,
        chip: RULES.chipFraction > 0 ? Math.max(1, Math.round(p.damage * RULES.chipFraction)) : 0,
        hitstun: p.hitstun,
        blockstun: p.blockstun,
        hitstop: SYSTEM.hitstop.medium,
        stun: SYSTEM.stun.special,
        height: 'mid',
        pushHit: SYSTEM.pushback.hit,
        pushBlock: SYSTEM.pushback.block,
        knockdown: false,
        meter: SYSTEM.meter.hit,
        name: 'Fireball',
        attackerPush: 0,
        heavy: false,
        stunTimer: SYSTEM.stun.timer.special,
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
      if (defender.state === 'ko' || defender.state === 'down' || defender.state === 'thrown') continue
      if (defender.invulnerable) continue
      if (!overlap(hb, defender.hurtBox())) continue

      const hurt = defender.hurtBox()
      const m = attacker.action
      this.land(i as 0 | 1, {
        // The middle of the overlap, which is as close to "where it connected" as boxes get.
        contact: {
          x: (Math.max(hb.x0, hurt.x0) + Math.min(hb.x1, hurt.x1)) / 2,
          y: (Math.max(hb.y0, hurt.y0) + Math.min(hb.y1, hurt.y1)) / 2,
        },
        damage: m.damage,
        // Each move's chip was baked in when the character was built, from the chip fraction the
        // config was *written* with. Scaling by the ratio lets a school turn chip off — both 3D
        // boards have none — without rebuilding every move.
        chip: chipNow(m.chip),
        hitstun: m.hitstun,
        blockstun: m.blockstun,
        hitstop: m.hitstop,
        stun: m.stun,
        height: m.height,
        pushHit: m.pushHit,
        pushBlock: m.pushBlock,
        knockdown: m.knockdown,
        meter: m.meter,
        name: m.name,
        attackerPush: m.travel ? 0 : m.pushBlock / 2,
        heavy: m.strength === 'heavy' || m.kind !== 'strike' || m.chip > 0,
        stunTimer: m.chip > 0 ? SYSTEM.stun.timer.special : m.knockdown ? SYSTEM.stun.timer.sweep : SYSTEM.stun.timer[m.strength],
      })
    }
  }

  private land(
    who: 0 | 1,
    hit: {
      contact: { x: number; y: number }
      damage: number; chip: number; hitstun: number; blockstun: number; hitstop: number; stun: number; height: Height
      pushHit: number; pushBlock: number; knockdown: boolean; meter: number; name: string; attackerPush: number; heavy: boolean
      stunTimer: number
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
      defender.takeBlock(hit.chip, hit.blockstun, hit.pushBlock, hit.hitstop + SYSTEM.defenderFreezeExtra)
      attacker.didConnect(hit.hitstop, hit.attackerPush, SYSTEM.meter.block)
      this.combo[who] = 0
      this.impacts.push({ x: hit.contact.x, y: hit.contact.y, blocked: true, heavy: hit.heavy, life: hit.hitstop + 4 })
      this.events.push({ kind: 'block', who, move: hit.name })
    } else {
      // The machine did not scale combo damage — four hits was four hits' worth — and the default
      // honours that. The switch exists for when that turns out to be too much.
      const n = this.combo[who]
      const scale = !SYSTEM.comboScaling || n === 0 ? 1 : Math.max(0.3, 1 - n * 0.1)
      const dealt = Math.max(1, Math.round(hit.damage * scale))
      const wasDizzy = defender.state === 'dizzy'
      defender.takeHit(dealt, hit.hitstun, hit.pushHit, hit.knockdown, hit.hitstop + SYSTEM.defenderFreezeExtra, hit.stun, hit.height, hit.stunTimer)
      attacker.didConnect(hit.hitstop, 0, hit.meter)
      this.combo[who] = n + 1
      this.impacts.push({ x: hit.contact.x, y: hit.contact.y, blocked: false, heavy: hit.heavy, life: hit.hitstop + 5 })
      this.events.push({ kind: 'hit', who, move: hit.name, damage: dealt, combo: this.combo[who] })
      if (!wasDizzy && defender.stun >= defender.character.dizzyResist) this.events.push({ kind: 'dizzy', who: (1 - who) as 0 | 1 })
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
      const stuck = d.state === 'hitstun' || d.state === 'down' || d.state === 'ko' || d.state === 'thrown' || d.hitstop > 0
      if (!stuck) this.combo[i] = 0
    }
  }

  /** Nobody stands inside anybody. Shove both, or one if the other is against a wall. */
  private separate(): void {
    const [a, b] = this.fighters
    if (this.hold) return
    if (!a.overlapsBody(b)) return
    const want = a.character.bodyHalf + b.character.bodyHalf
    const gap = want - Math.abs(a.x - b.x)
    if (gap <= 0) return
    const dir = a.x <= b.x ? -1 : 1
    const wallA = Math.abs(a.x) >= this.stageHalf - a.character.bodyHalf - 0.5
    const wallB = Math.abs(b.x) >= this.stageHalf - b.character.bodyHalf - 0.5
    const share = wallA || wallB ? gap : gap / 2
    if (!wallA) a.x += dir * share
    if (!wallB) b.x -= dir * share
    for (const f of this.fighters) {
      const h = f.character.bodyHalf
      f.x = Math.max(-this.stageHalf + h, Math.min(this.stageHalf - h, f.x))
    }
  }

  /** Nothing may leave the screen; the screen is one width wide and neither fighter can push past its edge. */
  private clampSpread(): void {
    const [a, b] = this.fighters
    const spread = Math.abs(a.x - b.x)
    const max = SYSTEM.maxSpread
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
    this.hold = null
    this.fighters[0].reset(-START_X, 1)
    this.fighters[1].reset(START_X, -1)
    this.events.push({ kind: 'round', who: 0 })
    this.setPhase('intro')
  }

  /** Everything back to the first bell. */
  restart(): void {
    this.wins[0] = 0
    this.wins[1] = 0
    this.round = 0
    this.roundWinner = null
    this.nextRound()
  }
}

export type { Move }
