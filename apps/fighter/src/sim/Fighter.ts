// One fighter: a state machine over frame data, and nothing else.
//
// It owns its position, its health and whatever it is currently doing. It does not know there is an
// opponent beyond a number for which way to face and how far away they are, it does not detect
// hits, and it does not draw. Match.ts puts two of these together and resolves what happens between
// them.
//
// The rule that keeps this honest: **a fighter never reads the other fighter's state.** Everything
// that flows between them — damage, hitstun, pushback, a grab — arrives through a method call from
// Match. The two numbers Match feeds *in* each tick (`sense`) are the gap between the feet and
// whether the other body can currently be grabbed; that is what lets a close normal and a throw be
// chosen from the stick without the fighter owning a pointer to its opponent. That is what makes
// the whole sim testable without a renderer, and it is what will make rollback possible later if it
// ever matters.

import {
  CHARGE_BACK, CHARGE_DOWN, DP, HCB, HCF, InputHistory, QCB, QCF, RDP, Button,
  matchCharge, matchMotion, matchRotation, type ButtonMask, type Facing, type Motion,
} from './Motion'
import { RULES, SYSTEM, findCharacter, type Character } from './Character'
import { activeOn, overlap, totalFrames, worldBox, type Box, type Move, type Stance } from './Moves'

export type State =
  | 'idle' | 'walk-fwd' | 'walk-back' | 'crouch'
  | 'jumpsquat' | 'air' | 'land'
  | 'attack' | 'hitstun' | 'blockstun' | 'thrown' | 'down' | 'dizzy' | 'ko' | 'win'

export const JUMPSQUAT = SYSTEM.prejumpFrames
export const LANDING_LAG = SYSTEM.landingFrames
export const KNOCKDOWN_FRAMES = SYSTEM.knockdownFrames
export const WAKEUP_INVULN = SYSTEM.wakeupInvuln
export const DIZZY_FRAMES = SYSTEM.stun.dizzyFrames
/** How close the feet have to be for a "close" normal to come out instead of the far one. */
export const CLOSE_RANGE = 46
/** How long a press made during hitstop stays good for. */
export const BUFFER_FRAMES = 5

const PUNCHES = Button.LP | Button.MP | Button.HP
const KICKS = Button.LK | Button.MK | Button.HK
const MEDIUM_HEAVY = Button.MP | Button.HP | Button.MK | Button.HK

const MOTIONS: Record<string, Motion> = { qcf: QCF, qcb: QCB, dp: DP, rdp: RDP, hcf: HCF, hcb: HCB }

/** The heaviest of the buttons in the mask, as the two-letter suffix the move ids use. */
function suffixOf(mask: ButtonMask, group: 'P' | 'K'): 'lp' | 'mp' | 'hp' | 'lk' | 'mk' | 'hk' | null {
  if (group === 'P') return mask & Button.HP ? 'hp' : mask & Button.MP ? 'mp' : mask & Button.LP ? 'lp' : null
  return mask & Button.HK ? 'hk' : mask & Button.MK ? 'mk' : mask & Button.LK ? 'lk' : null
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
  /** Half the stage, in pixels. Match sets it from the stage; the default is the system's. */
  stageHalf = SYSTEM.stageHalf

  action: Move | null = null
  actionFrame = 0
  /** True once the current move has touched the opponent, on hit or on block. Gates cancels. */
  connected = false
  /** True if the current move's hitbox is spent — it has hit, and has not re-armed. */
  spent = false
  private hitsLeft = 0
  private rearm = 0

  health: number
  meter = 0
  hitstop = 0
  invuln = 0
  /** Dizzy points. Fill the bar and the next gap in the action is spent seeing stars. */
  stun = 0
  /** Frames until the dizzy meter empties. Every hit restarts it; nothing drains it gradually. */
  stunTimer = 0
  private pendingDizzy = false
  /** Set for one tick when a special wants a projectile made. Match clears it. */
  spawn: Move | null = null
  /** Set for one tick when a grab reaches its active frame. Match resolves it and clears it. */
  grab: Move | null = null
  /** What the last hit was, for the renderer to pick a reaction pose. */
  lastHit: { height: 'mid' | 'low' | 'overhead'; airborne: boolean } = { height: 'mid', airborne: false }
  /** Which way the jump was going when it left the ground — for the art, and for the CPU. */
  jumpDir = 0
  /** What Match told us about the other body this tick. */
  private gap = 9999
  private throwable = false

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
    if (this.state === 'attack' && this.action) return this.action.rise && this.y > 0 ? 'air' : this.action.stance
    if (this.state === 'thrown') return 'air'
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
  /**
   * Whether this fighter is guarding — and the one place the three schools of defence differ.
   * Whether the guard *works* against a given blow is decided elsewhere, by height, which every
   * school agrees on: a low must be guarded low and a high must be guarded standing.
   */
  get blocking(): boolean {
    if (!this.grounded) return false
    if (this.state === 'blockstun') return true
    if (!this.free) return false
    switch (RULES.defence) {
      // Tekken: neutral is a guard. You hold nothing, and the height rules do the rest — which is
      // why lows are the whole offence on that board.
      case 'auto-standing':
        return true
      // Virtua Fighter: a button. Costs no health, covers half of you, and see `walk` for the price.
      case 'guard-button':
        return (this.history.buttons(0) & Button.G) !== 0
      // Street Fighter: hold away, so blocking and retreating are the same action.
      default: {
        const d = this.dir
        return d === 1 || d === 4 || d === 7
      }
    }
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

  /** Fireballs go straight through a lariat. */
  get projectileInvulnerable(): boolean {
    return this.invulnerable || (this.state === 'attack' && Boolean(this.action?.projectileInvuln))
  }

  /** Can this body be grabbed right now? Standing on the floor and not already being hit. */
  get grabbable(): boolean {
    if (!this.grounded || this.y > 0) return false
    switch (this.state) {
      case 'idle': case 'walk-fwd': case 'walk-back': case 'crouch': case 'land': case 'dizzy':
        return !this.invulnerable
      case 'attack':
        return this.stance !== 'air' && !this.invulnerable && this.action?.kind !== 'throw' && this.action?.kind !== 'command-throw'
      default:
        return false
    }
  }

  hurtBox(): Box {
    return worldBox(this.character.hurt[this.stance], this.x, this.y, this.facing)
  }

  bodyBox(): Box {
    const h = this.character.bodyHalf
    return { x0: this.x - h, y0: this.y, x1: this.x + h, y1: this.y + this.character.hurt.stand.y1 }
  }

  /** The active hitbox this frame, or null. */
  hitBox(): Box | null {
    const a = this.action
    if (!a || this.state !== 'attack' || this.spent) return null
    if (a.kind !== 'strike') return null
    if (!activeOn(a, this.actionFrame)) return null
    if (a.hitbox.x1 === a.hitbox.x0) return null
    return worldBox(a.hitbox, this.x, this.y, this.facing)
  }

  /** Where in the move we are, 0..1. */
  get actionPhase(): number {
    const a = this.action
    if (!a) return 0
    return Math.min(1, this.actionFrame / Math.max(1, totalFrames(a)))
  }

  /** Match tells us how far the other pair of feet is, and whether that body can be grabbed. */
  sense(gap: number, throwable: boolean): void {
    this.gap = gap
    this.throwable = throwable
  }

  faceToward(otherX: number): void {
    // Turning mid-move or mid-air would move the hitbox that is already out. Only turn when idle.
    if (!this.free) return
    this.facing = otherX < this.x ? -1 : 1
  }

  /** One sim tick. Input for this frame must already be in `history`. */
  tick(): void {
    if (this.hitstop > 0) {
      // A button pressed while frozen is remembered for a few frames after — that is how a jab is
      // chained into another and how a normal is cancelled into a special without frame-perfect timing.
      const p = this.pressedNow
      if (p) {
        this.buffered |= p
        this.bufferLife = BUFFER_FRAMES
      }
      this.hitstop--
      return
    }
    if (this.bufferLife > 0 && --this.bufferLife === 0) this.buffered = 0
    this.stateFrame++
    if (this.invuln > 0) this.invuln--
    this.decayStun()

    switch (this.state) {
      case 'ko':
      case 'win':
        this.physics(false)
        return
      case 'down':
        if (this.stateFrame >= KNOCKDOWN_FRAMES) {
          this.invuln = WAKEUP_INVULN
          this.wake()
        }
        this.physics(false)
        return
      case 'dizzy':
        if (this.stateFrame >= DIZZY_FRAMES) this.enter('idle')
        this.physics(false)
        return
      case 'thrown':
        // Held in the air until the slam; then it is an ordinary knockdown.
        if (this.stateFrame >= this.stunFrames) {
          const t = this.pendingThrow
          this.pendingThrow = null
          this.y = 0
          this.takeHit(t?.damage ?? 0, 20, 3, true, 0, t?.stun ?? 0)
        }
        return
      case 'hitstun':
      case 'blockstun':
        if (this.stateFrame >= this.stunFrames) {
          if (this.y > 0) this.enter('air')
          else this.wake()
        }
        this.physics(false)
        return
      case 'land':
        if (this.stateFrame >= LANDING_LAG) this.enter('idle')
        return
      case 'air':
        if (!this.tryAttack()) this.physics(false)
        return
      case 'jumpsquat':
        // The 360 is finished by passing through up, which would leave the ground — so a special
        // pressed during the prejump frames cancels the jump. It is why the piledriver is inputtable.
        if (this.tryAttack(true)) return
        if (this.stateFrame >= this.character.prejump) {
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
  private buffered: ButtonMask = 0
  private bufferLife = 0
  private pendingThrow: { damage: number; stun: number } | null = null

  /** Back on your feet after stun — or not, if the dizzy bar filled while you were in it. */
  private wake(): void {
    if (this.pendingDizzy) {
      this.pendingDizzy = false
      this.stun = 0
      this.stunTimer = 0
      this.enter('dizzy')
      return
    }
    this.enter('idle')
  }

  private decayStun(): void {
    if (this.stunTimer > 0 && --this.stunTimer === 0) this.stun = 0
  }

  private enter(s: State): void {
    this.state = s
    this.stateFrame = 0
    if (s !== 'attack') {
      this.action = null
      this.actionFrame = 0
      this.connected = false
      this.spent = false
      this.hitsLeft = 0
      this.rearm = 0
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
    if ((a.kind === 'throw' || a.kind === 'command-throw') && a.startup > 1 && this.actionFrame === a.startup - 1) this.grab = a

    // A multi-hit move re-arms its box a few frames after each touch.
    if (this.spent && this.rearm > 0 && --this.rearm === 0 && this.hitsLeft > 0) this.spent = false

    // A special may interrupt a normal that has already touched them.
    if (this.tryCancel()) return

    // A roll or a spinning kick carries itself forward while it is live.
    if (a.travel && activeOn(a, this.actionFrame) && !(a.bounce && this.bounced)) this.vx = a.travel.vx * this.facing
    else if (a.travel && !this.bounced && this.y <= 0) this.vx = 0

    const airborne = this.y > 0 || Boolean(a.rise)
    this.physics(false)

    if (airborne) {
      // Air moves and the uppercut end when the ground does.
      if (this.y <= 0) {
        this.y = 0
        this.vy = 0
        this.vx = 0
        this.bounced = false
        // The uppercut owes its recovery on landing; an air normal owes the air-attack landing lag.
        this.enter('land')
        this.stateFrame = a.rise || a.bounce ? -a.recovery : LANDING_LAG - SYSTEM.airAttackLandingFrames
      }
      return
    }
    if (this.actionFrame >= totalFrames(a)) {
      this.bounced = false
      this.enter(this.dir === 1 || this.dir === 2 || this.dir === 3 ? 'crouch' : 'idle')
    }
  }

  private bounced = false

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
    // Virtua Fighter charges movement for its free guard: hold it and you do not walk at all,
    // measured at exactly 0.000 units in 120 frames on the board itself.
    if (RULES.rootedWhileGuarding && (this.history.buttons(0) & Button.G) !== 0) {
      if (this.state !== 'idle') this.enter('idle')
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

  /** The buttons that went down this very frame. */
  private get pressedNow(): ButtonMask {
    return this.history.buttons(0) & ~this.history.buttons(1)
  }

  /** This frame's presses plus anything buffered through hitstop. Reading it spends the buffer. */
  private takePressed(): ButtonMask {
    const p = this.pressedNow | this.buffered
    this.buffered = 0
    this.bufferLife = 0
    return p
  }

  /**
   * Start a move if the player asked for one this frame. Specials beat throws beat normals, always
   * — that ordering is why a 360 next to someone gives a piledriver and not a jab.
   */
  private tryAttack(specialsOnly = false): boolean {
    const pressed = this.takePressed()
    if (pressed === 0) return false

    if (this.grounded || specialsOnly) {
      const special = this.specialFor(pressed)
      if (special) {
        this.begin(special)
        return true
      }
      if (specialsOnly) return false
      if (this.throwFor(pressed)) {
        this.begin(this.character.throw)
        return true
      }
    }
    const m = this.normalFor(this.inputStance, pressed)
    if (!m) return false
    if (m.stance === 'air' && this.grounded) return false
    this.begin(m)
    return true
  }

  /** Which normal a button gives you, by the stance you are in when you press it. */
  private normalFor(stance: Stance, pressed: ButtonMask): Move | null {
    const punch = (pressed & PUNCHES) !== 0
    const kick = (pressed & KICKS) !== 0
    if (!punch && !kick) return null
    // Punch and kick on the same frame: the punch wins, as it did on the machine.
    const suffix = punch ? suffixOf(pressed, 'P') : suffixOf(pressed, 'K')
    if (!suffix) return null
    const moves = this.character.moves
    if (stance === 'stand' && this.gap <= CLOSE_RANGE) {
      const close = moves[`close-${suffix}`]
      if (close) return close
    }
    return moves[`${stance}-${suffix}`] ?? moves[`${stance}-${punch ? 'lp' : 'lk'}`] ?? null
  }

  /** Forward or back and a medium or heavy button, in range, with something there to grab. */
  private throwFor(pressed: ButtonMask): boolean {
    if ((pressed & MEDIUM_HEAVY) === 0) return false
    const d = this.dir
    if (d !== 4 && d !== 6) return false
    return this.throwable && this.gap <= this.character.throw.range
  }

  /**
   * Specials are checked in the order the character's file lists them, and that order is load-
   * bearing: `6,6,2,3,6` contains both a dragon punch and a quarter circle, so a character who lists
   * the dragon punch first uppercuts when walking forward into a fireball. See DESIGN.md.
   */
  private specialFor(pressed: ButtonMask): Move | null {
    for (const m of this.character.specials) {
      const group = m.button ?? 'P'
      const suffix = suffixOf(pressed, group)
      if (!suffix || !m.id.endsWith(`-${suffix}`)) continue
      if (this.motionDone(m.motion, group)) return m
    }
    return null
  }

  private motionDone(motion: Move['motion'], group: 'P' | 'K'): boolean {
    const h = this.history
    switch (motion) {
      case undefined:
        return false
      case '360':
        return matchRotation(h, this.facing)
      case 'charge-back':
        return matchCharge(h, CHARGE_BACK, this.facing)
      case 'charge-down':
        return matchCharge(h, CHARGE_DOWN, this.facing)
      case 'ppp':
      case 'kkk': {
        // Two of the three within three frames is what "all three at once" means on a real pad.
        const bs = group === 'P' ? [Button.LP, Button.MP, Button.HP] : [Button.LK, Button.MK, Button.HK]
        let n = 0
        for (const b of bs) if (h.pressed(b) || h.pressed(b, 1) || h.pressed(b, 2)) n++
        return n >= 2
      }
      case 'mash-p':
      case 'mash-k': {
        const mask = group === 'P' ? PUNCHES : KICKS
        let taps = 0
        for (let age = 0; age < 40 && age < h.length; age++) {
          if ((h.buttons(age) & mask) !== 0 && (h.buttons(age + 1) & mask) === 0) taps++
        }
        return taps >= 4
      }
      default:
        return matchMotion(h, MOTIONS[motion], this.facing)
    }
  }

  private tryCancel(): boolean {
    const a = this.action
    if (!a || !(a.cancel || a.chain) || !this.connected) return false
    if (this.actionFrame < a.startup) return false
    const pressed = this.takePressed()
    if (pressed === 0) return false
    const special = this.specialFor(pressed)
    if (special) {
      this.begin(special)
      return true
    }
    // A light that has touched them chains into another light. Free, and what makes the game approachable.
    if (a.chain) {
      const next = this.normalFor(this.inputStance, pressed)
      if (next?.chain && next.stance !== 'air') {
        this.begin(next)
        return true
      }
    }
    return false
  }

  private begin(m: Move): void {
    if (this.state === 'jumpsquat') this.jumpDir = 0
    this.state = 'attack'
    this.stateFrame = 0
    this.action = m
    this.actionFrame = 0
    this.connected = false
    this.spent = false
    this.hitsLeft = m.hits
    this.rearm = 0
    this.bounced = false
    if (m.stance !== 'air') this.vx = 0
    if ((m.kind === 'throw' || m.kind === 'command-throw') && m.startup <= 1) this.grab = m
    if (m.kind !== 'strike' || m.chip > 0) this.meter = Math.min(SYSTEM.meter.max, this.meter + SYSTEM.meter.whiffSpecial / 100)
  }

  private physics(groundedControl: boolean): void {
    if (!groundedControl && this.y <= 0 && this.state !== 'air' && !this.action?.rise && !this.action?.travel) this.vx *= 0.8
    this.x += this.vx
    if (this.y > 0 || this.vy !== 0) {
      this.y += this.vy
      this.vy -= this.character.gravity
      if (this.y <= 0) {
        this.y = 0
        this.vy = 0
        if (this.state === 'air') {
          this.vx = 0
          this.enter('land')
        } else if (this.state === 'hitstun') {
          this.vx = 0
          if (this.health <= 0) this.enter('ko')
          else this.enter('down')
        }
      }
    }
    const h = this.character.bodyHalf
    this.x = Math.max(-this.stageHalf + h, Math.min(this.stageHalf - h, this.x))
  }

  // --- what Match does to a fighter ------------------------------------------------------------

  /** Landed on. Match owns the bookkeeping around it. */
  takeHit(damage: number, stun: number, push: number, knockdown: boolean, hitstop: number, dizzy: number, height: 'mid' | 'low' | 'overhead' = 'mid', stunTimer = SYSTEM.stun.timer.medium): void {
    this.health = Math.max(0, this.health - damage)
    this.hitstop = hitstop
    this.vx = push * -this.facing
    this.stunFrames = stun
    this.lastHit = { height, airborne: this.y > 0 }
    const wasDizzy = this.state === 'dizzy'
    if (!wasDizzy) {
      this.stun += dizzy
      this.stunTimer = Math.max(this.stunTimer, stunTimer)
      // The machine survives exactly the threshold and dizzies the point past it.
      if (this.stun > this.character.dizzyResist) this.pendingDizzy = true
    } else {
      this.pendingDizzy = false
    }
    if (this.health <= 0) {
      this.pendingDizzy = false
      this.enter('hitstun')
      this.stunFrames = 999
      this.y = Math.max(this.y, 0.01)
      this.vy = 5
      this.vx = push * -this.facing * 1.4
      return
    }
    if (knockdown || this.y > 0 || wasDizzy) {
      this.enter('hitstun')
      this.stunFrames = stun
      if (this.y <= 0) {
        this.y = 0.01
        this.vy = knockdown ? 6 : 3.5
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
    if (this.health <= 0) {
      this.enter('hitstun')
      this.stunFrames = 999
      this.y = 0.01
      this.vy = 5
      return
    }
    this.enter('blockstun')
  }

  /** Grabbed. Held for `hold` frames, then slammed for `damage`. */
  beThrown(damage: number, hold: number, stun: number): void {
    this.enter('thrown')
    this.stunFrames = hold
    this.pendingThrow = { damage, stun }
    this.vx = 0
    this.vy = 0
  }

  /** While being held, Match keeps the victim where the attacker's hands are. */
  heldAt(x: number, y: number, facing: Facing): void {
    this.x = x
    this.y = y
    this.facing = facing
  }

  /** The attacker's side of contact. */
  didConnect(hitstop: number, push: number, meter: number): void {
    const a = this.action
    this.connected = true
    this.spent = true
    this.hitsLeft = Math.max(0, this.hitsLeft - 1)
    if (a && this.hitsLeft > 0 && a.rehit > 0) this.rearm = a.rehit
    this.hitstop = hitstop
    this.meter = Math.min(SYSTEM.meter.max, this.meter + meter / 100)
    if (a?.bounce) {
      // Blanka's ball comes off whatever it touched.
      this.bounced = true
      this.hitsLeft = 0
      this.vx = a.bounce.vx * this.facing
      this.vy = a.bounce.vy
      this.y = Math.max(this.y, 0.01)
    } else {
      this.vx = push * -this.facing
    }
  }

  /** A grab that found nothing. Command throws pay their whole recovery for it. */
  whiffed(): void {
    this.grab = null
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
    this.stun = 0
    this.stunTimer = 0
    this.pendingDizzy = false
    this.pendingThrow = null
    this.spawn = null
    this.grab = null
    this.stunFrames = 0
    this.bounced = false
    this.history.clear()
    this.enter('idle')
  }

  /** Does this fighter's body overlap the other's? Used to shove them apart. */
  overlapsBody(other: Fighter): boolean {
    return overlap(this.bodyBox(), other.bodyBox())
  }
}
