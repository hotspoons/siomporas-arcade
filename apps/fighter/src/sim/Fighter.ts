// One fighter: a state machine over frame data, and nothing else.
//
// It owns its position, its health and whatever it is currently doing. It does not know there is an
// opponent beyond a number for which way to face, it does not detect hits, and it does not draw.
// Match.ts puts two of these together and resolves what happens between them.
//
// The rule that keeps this honest: **a fighter never reads the other fighter's state.** Everything
// that flows between them — damage, hitstun, pushback — arrives through a method call from Match.
// That is what makes the whole sim testable without a renderer, and it is what will make rollback
// possible later if it ever matters.

import { DP, InputHistory, QCF, Button, matchMotion, type ButtonMask, type Facing } from './Motion'
import {
  HURT, findCharacter, move, overlap, scaled, totalFrames, worldBox,
  type Box, type Character, type Move, type Stance,
} from './Moves'

export type State =
  | 'idle' | 'walk-fwd' | 'walk-back' | 'crouch'
  | 'jumpsquat' | 'air' | 'land'
  | 'attack' | 'hitstun' | 'blockstun' | 'down' | 'ko' | 'win'

export const GRAVITY = 0.72
export const JUMPSQUAT = 3
export const LANDING_LAG = 3
export const KNOCKDOWN_FRAMES = 40
export const WAKEUP_INVULN = 8
export const STAGE_HALF = 620
/** Fighters cannot stand inside each other. */
export const BODY_HALF = 30

const PUNCHES = Button.LP | Button.MP | Button.HP

/** Which normal a button gives you, by the stance you are in when you press it. */
function normalFor(stance: Stance, buttons: ButtonMask): Move | null {
  const heavy = (buttons & (Button.HP | Button.HK)) !== 0
  const medium = (buttons & (Button.MP | Button.MK)) !== 0
  const punch = (buttons & PUNCHES) !== 0
  if (stance === 'air') return punch && !heavy ? move('air-lp') : move('air-hk')
  if (stance === 'crouch') {
    if (punch) return move(heavy || medium ? 'crouch-mp' : 'crouch-lp')
    return move(heavy ? 'crouch-hk' : 'crouch-lk')
  }
  if (punch) return move(heavy ? 'stand-hp' : medium ? 'stand-mp' : 'stand-lp')
  return move(heavy ? 'stand-hk' : medium ? 'stand-mk' : 'stand-lk')
}

export class Fighter {
  readonly character: Character
  readonly history = new InputHistory()

  x = 0
  y = 0
  vx = 0
  vy = 0
  facing: Facing = 1
  state: State = 'idle'
  /** Frames spent in the current state. */
  stateFrame = 0

  action: Move | null = null
  actionFrame = 0
  /** True once the current move has touched the opponent, on hit or on block. Gates cancels. */
  connected = false
  /** True if the current move has already spent its one hit. */
  spent = false

  health: number
  meter = 0
  hitstop = 0
  invuln = 0
  /** Set for one tick when a special wants a projectile made. Match clears it. */
  spawn: Move | null = null
  /** Which way the jump was going when it left the ground, for the placeholder art. */
  private jumpDir = 0

  constructor(characterId: string, x: number, facing: Facing) {
    this.character = findCharacter(characterId)
    this.health = this.character.health
    this.x = x
    this.facing = facing
  }

  get grounded(): boolean {
    return this.y <= 0 && this.state !== 'air' && this.state !== 'jumpsquat'
  }

  get stance(): Stance {
    if (this.state === 'air' || this.state === 'jumpsquat') return 'air'
    if (this.state === 'crouch') return 'crouch'
    if (this.state === 'attack' && this.action) return this.action.stance
    return 'stand'
  }

  /** Free to act: not attacking, not stunned, not on the floor. */
  get free(): boolean {
    return this.state === 'idle' || this.state === 'walk-fwd' || this.state === 'walk-back' || this.state === 'crouch'
  }

  get dir(): number {
    return this.history.dir(0, this.facing)
  }

  /**
   * Holding back with nothing else going on. Note that this is *not* "is safe": it says the guard
   * is up, and Match still decides whether the guard is in the right place for the attack.
   */
  get blocking(): boolean {
    if (!this.grounded) return false
    if (this.state === 'blockstun') return true
    if (!this.free) return false
    const d = this.dir
    return d === 1 || d === 4 || d === 7
  }

  /**
   * The stance a move started right now would come out of. Not the same as `stance`: on the frame
   * you first press down-and-kick, the state machine is still standing, and reading it would give a
   * roundhouse where the player very clearly asked for a sweep. Every fighting game resolves this
   * from the stick, not from the state.
   */
  private get inputStance(): Stance {
    if (!this.grounded) return 'air'
    const d = this.dir
    return d === 1 || d === 2 || d === 3 ? 'crouch' : 'stand'
  }

  get guardLow(): boolean {
    return this.dir === 1 || this.state === 'crouch'
  }

  get invulnerable(): boolean {
    if (this.invuln > 0) return true
    const a = this.action
    if (a?.invuln && this.state === 'attack') {
      const f = this.actionFrame + 1
      return f >= a.invuln[0] && f <= a.invuln[1]
    }
    return false
  }

  hurtBox(): Box {
    return worldBox(HURT[this.stance], this.x, this.y, 1)
  }

  bodyBox(): Box {
    return { x0: this.x - BODY_HALF, y0: this.y, x1: this.x + BODY_HALF, y1: this.y + 190 }
  }

  /** The active hitbox this frame, or null. */
  hitBox(): Box | null {
    const a = this.action
    if (!a || this.state !== 'attack' || this.spent) return null
    // `actionFrame` counts ticks since the move began, so frame 1 in the notation is actionFrame 0.
    // A move with 3 startup is active on frames 3..4, which is actionFrame 2..3.
    const f = this.actionFrame
    if (f < a.startup - 1 || f >= a.startup - 1 + a.active) return null
    if (a.hitbox.x1 === 0) return null // the fireball's own box is empty; the projectile carries it
    return worldBox(scaled(a, this.character).hitbox, this.x, this.y, this.facing)
  }

  /** Where in the move we are, 0..1, for the placeholder renderer. */
  get actionPhase(): number {
    const a = this.action
    if (!a) return 0
    return Math.min(1, this.actionFrame / Math.max(1, totalFrames(a)))
  }

  faceToward(otherX: number): void {
    // Turning mid-move or mid-air would move the hitbox that is already out. Only turn when idle.
    if (!this.free) return
    this.facing = otherX < this.x ? -1 : 1
  }

  /** One sim tick. `push` is a pre-resolved input frame already written into `history`. */
  tick(): void {
    if (this.hitstop > 0) {
      this.hitstop--
      return
    }
    this.stateFrame++
    if (this.invuln > 0) this.invuln--

    switch (this.state) {
      case 'ko':
      case 'win':
        this.physics(false)
        return
      case 'down':
        if (this.stateFrame >= KNOCKDOWN_FRAMES) {
          this.enter('idle')
          this.invuln = WAKEUP_INVULN
        }
        this.physics(false)
        return
      case 'hitstun':
      case 'blockstun':
        if (this.stateFrame >= this.stunFrames) this.enter(this.y > 0 ? 'air' : 'idle')
        this.physics(false)
        return
      case 'land':
        if (this.stateFrame >= LANDING_LAG) this.enter('idle')
        return
      case 'jumpsquat':
        if (this.stateFrame >= JUMPSQUAT) {
          this.vy = this.character.jumpVy
          this.vx = this.jumpDir * this.character.jumpVx
          this.enter('air')
        }
        return
      case 'attack':
        this.tickAttack()
        return
      default:
        this.tickFree()
    }
  }

  private stunFrames = 0

  private enter(s: State): void {
    this.state = s
    this.stateFrame = 0
    if (s !== 'attack') {
      this.action = null
      this.actionFrame = 0
      this.connected = false
      this.spent = false
    }
  }

  private tickAttack(): void {
    const a = this.action
    if (!a) return this.enter('idle')
    this.actionFrame++

    if (a.rise && this.actionFrame === 1) {
      this.vy = a.rise.vy
      this.vx = a.rise.vx * this.facing
      this.y = Math.max(this.y, 0.01)
    }
    if (a.projectile && this.actionFrame === a.startup - 1) this.spawn = a

    // A special may interrupt a normal that has already touched them.
    if (this.tryCancel()) return

    const airborne = this.y > 0 || Boolean(a.rise)
    this.physics(false)

    if (airborne) {
      // Air moves and the uppercut end when the ground does.
      if (this.y <= 0) {
        this.y = 0
        this.vy = 0
        this.vx = 0
        // The uppercut owes its recovery on landing; an air normal owes a short landing lag.
        this.enter('land')
        this.stateFrame = a.rise ? -a.recovery : 0
      }
      return
    }
    if (this.actionFrame >= totalFrames(a)) this.enter(this.dir === 1 || this.dir === 2 || this.dir === 3 ? 'crouch' : 'idle')
  }

  private tickFree(): void {
    if (this.tryAttack()) return

    const d = this.dir
    const up = d === 7 || d === 8 || d === 9
    const down = d === 1 || d === 2 || d === 3

    if (up && this.grounded) {
      this.jumpDir = d === 9 ? 1 : d === 7 ? -1 : 0
      this.enter('jumpsquat')
      return
    }
    if (down) {
      if (this.state !== 'crouch') this.enter('crouch')
      this.vx = 0
      this.physics(true)
      return
    }
    const fwd = d === 6
    const back = d === 4
    if (fwd) {
      if (this.state !== 'walk-fwd') this.enter('walk-fwd')
      this.vx = this.character.walkFwd * this.facing
    } else if (back) {
      if (this.state !== 'walk-back') this.enter('walk-back')
      this.vx = -this.character.walkBack * this.facing
    } else {
      if (this.state !== 'idle') this.enter('idle')
      this.vx = 0
    }
    this.physics(true)
  }

  /** Start a move if the player asked for one this frame. Specials beat normals, always. */
  private tryAttack(): boolean {
    const h = this.history
    const punch = h.pressed(Button.LP) || h.pressed(Button.MP) || h.pressed(Button.HP)
    const kick = h.pressed(Button.LK) || h.pressed(Button.MK) || h.pressed(Button.HK)
    if (!punch && !kick) return false
    const buttons = h.buttons(0)

    if (punch && this.grounded) {
      const special = this.specialFor(buttons)
      if (special) {
        this.begin(special)
        return true
      }
    }
    const m = normalFor(this.inputStance, buttons)
    if (!m) return false
    if (m.stance === 'air' && this.grounded) return false
    this.begin(m)
    return true
  }

  /**
   * Dragon punch is checked before quarter circle and that ordering is load-bearing: `6,6,2,3,6`
   * contains both, and the player walking forward into a fireball gets the uppercut. See DESIGN.md.
   */
  private specialFor(buttons: ButtonMask): Move | null {
    if ((buttons & PUNCHES) === 0) return null
    if (matchMotion(this.history, DP, this.facing)) return move('uppercut')
    if (matchMotion(this.history, QCF, this.facing)) return move('fireball')
    return null
  }

  private tryCancel(): boolean {
    const a = this.action
    if (!a?.cancel || !this.connected) return false
    if (this.actionFrame < a.startup) return false
    const h = this.history
    if (!(h.pressed(Button.LP) || h.pressed(Button.MP) || h.pressed(Button.HP))) return false
    const special = this.specialFor(h.buttons(0))
    if (!special) return false
    this.begin(special)
    return true
  }

  private begin(m: Move): void {
    this.state = 'attack'
    this.stateFrame = 0
    this.action = m
    this.actionFrame = 0
    this.connected = false
    this.spent = false
    if (m.stance !== 'air') this.vx = 0
  }

  private physics(groundedControl: boolean): void {
    if (!groundedControl && this.y <= 0 && this.state !== 'air' && !this.action?.rise) this.vx *= 0.8
    this.x += this.vx
    if (this.y > 0 || this.vy !== 0) {
      this.y += this.vy
      this.vy -= GRAVITY
      if (this.y <= 0) {
        this.y = 0
        this.vy = 0
        if (this.state === 'air') {
          this.vx = 0
          this.enter('land')
        } else if (this.state === 'hitstun') {
          this.vx = 0
          this.enter('down')
        }
      }
    }
    this.x = Math.max(-STAGE_HALF + BODY_HALF, Math.min(STAGE_HALF - BODY_HALF, this.x))
  }

  // --- what Match does to a fighter ------------------------------------------------------------

  /** Landed on. Returns nothing; Match owns the bookkeeping around it. */
  takeHit(damage: number, stun: number, push: number, knockdown: boolean, hitstop: number): void {
    this.health = Math.max(0, this.health - damage)
    this.hitstop = hitstop
    this.vx = push * -this.facing
    this.stunFrames = stun
    if (this.health <= 0) {
      this.enter('ko')
      this.vy = 6
      this.vx = push * -this.facing * 1.4
      return
    }
    if (knockdown || this.y > 0) {
      this.enter('hitstun')
      this.stunFrames = stun
      if (this.y <= 0) {
        this.y = 0.01
        this.vy = knockdown ? 7 : 4
      }
    } else {
      this.enter('hitstun')
      this.stunFrames = stun
    }
  }

  takeBlock(chip: number, stun: number, push: number, hitstop: number): void {
    this.health = Math.max(0, this.health - chip)
    this.hitstop = hitstop
    this.vx = push * -this.facing
    this.stunFrames = stun
    this.enter(this.health <= 0 ? 'ko' : 'blockstun')
  }

  /** The attacker's side of contact. */
  didConnect(hitstop: number, push: number, meter: number): void {
    this.connected = true
    this.spent = true
    this.hitstop = hitstop
    this.vx = push * -this.facing
    this.meter = Math.min(4, this.meter + meter / 100)
  }

  win(): void {
    this.enter('win')
  }

  /** Back to the corner for the next round. Everything except which character this is. */
  reset(x: number, facing: Facing): void {
    this.x = x
    this.y = 0
    this.vx = 0
    this.vy = 0
    this.facing = facing
    this.health = this.character.health
    this.hitstop = 0
    this.invuln = 0
    this.spawn = null
    this.stunFrames = 0
    this.history.clear()
    this.enter('idle')
  }

  /** Does this fighter's body overlap the other's? Used to shove them apart. */
  overlapsBody(other: Fighter): boolean {
    return overlap(this.bodyBox(), other.bodyBox())
  }
}
