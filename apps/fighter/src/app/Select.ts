// The character select: a grid of portraits, two cursors, and the CPU rolling its own pick.
//
// There is no DOM and no canvas in this file. It takes one input frame per player — the same
// `{x, y, buttons}` shape the fighters are fed — and hands back the chosen pair when the screen is
// finished. That keeps it testable, and it is the same discipline as the sim: the CPU cursor can
// only do things a second player could do.
//
// The last cell is always random. A roster of seven plus random is eight, which is two clean rows
// of four; the view derives its rows from the cell count, so adding a character does not need a
// layout change.

import { Button, type ButtonMask } from '../sim/Motion'

export const COLUMNS = 4

/** Any attack button locks a choice in. */
const ANY_BUTTON = Button.LP | Button.MP | Button.HP | Button.LK | Button.MK | Button.HK

/** Frames a direction must be held before it repeats, and the gap between repeats after that. */
const REPEAT_DELAY = 20
const REPEAT_RATE = 6
/** How long the screen holds on the matchup once both sides are locked. */
const START_DELAY = 54

export interface PadFrame {
  x: number
  y: number
  buttons: ButtonMask
}

export interface Pick {
  p1: string
  p2: string
}

export interface Cursor {
  /** Index into `cells`. */
  cell: number
  /** The cell that was locked in, or −1 while still choosing. */
  locked: number
  /** What that lock resolved to. Random cells only decide at the moment they are pressed. */
  choice: string | null
  dx: number
  dy: number
  hold: number
  buttons: ButtonMask
  /** CPU only: frames until the cursor hops again, and how many hops it has made since you locked. */
  hop: number
  rolls: number
}

const newCursor = (cell: number): Cursor => ({ cell, locked: -1, choice: null, dx: 0, dy: 0, hold: 0, buttons: 0, hop: 0, rolls: 0 })

export class Select {
  /** The roster, then one null: the random cell. */
  readonly cells: readonly (string | null)[]
  readonly cursors: [Cursor, Cursor]
  /** Whether player two is a person. When false the second cursor is the machine's. */
  twoPlayer: boolean
  frame = 0
  /** Counts down once both sides are locked; the match starts when it reaches zero. */
  startIn = START_DELAY

  private readonly random: () => number

  constructor(ids: readonly string[], twoPlayer: boolean, random: () => number = Math.random) {
    this.cells = [...ids, null]
    this.twoPlayer = twoPlayer
    this.random = random
    // Player one starts on the first fighter, player two on the last, which is how you can see at a
    // glance that there are two cursors on the screen.
    this.cursors = [newCursor(0), newCursor(ids.length - 1)]
  }

  get rows(): number {
    return Math.ceil(this.cells.length / COLUMNS)
  }

  /** True once both sides have chosen and the screen is just showing the matchup. */
  get settled(): boolean {
    return this.cursors[0].locked >= 0 && this.cursors[1].locked >= 0
  }

  /** One frame. Returns the pair when the screen is done, null while it is still running. */
  step(p1: PadFrame, p2: PadFrame | null): Pick | null {
    this.frame++
    this.drive(this.cursors[0], p1)
    if (this.twoPlayer && p2) this.drive(this.cursors[1], p2)
    else this.driveCpu(this.cursors[1])

    if (!this.settled) return null
    if (--this.startIn > 0) return null
    return { p1: this.cursors[0].choice ?? this.cells[0] ?? '', p2: this.cursors[1].choice ?? this.cells[0] ?? '' }
  }

  /** Give this cursor its pick without waiting for a button — how a URL or a key preselects one. */
  preset(player: 0 | 1, id: string): void {
    const i = this.cells.indexOf(id)
    if (i < 0) return
    this.cursors[player].cell = i
  }

  private drive(c: Cursor, pad: PadFrame): void {
    // Whatever was already held when the screen opened is not a press. Otherwise finishing a round
    // on a punch and hitting select would lock that cursor before the grid had drawn a frame.
    if (this.frame === 1) {
      c.buttons = pad.buttons
      c.dx = pad.x
      c.dy = pad.y
      return
    }
    if (c.locked < 0) {
      // A direction fires on the frame it is pressed, then again on a repeat, so a held stick walks
      // the grid instead of flying across it.
      const changed = pad.x !== c.dx || pad.y !== c.dy
      if (changed) c.hold = 0
      else c.hold++
      const fire = changed ? pad.x !== 0 || pad.y !== 0 : c.hold >= REPEAT_DELAY && (c.hold - REPEAT_DELAY) % REPEAT_RATE === 0
      if (fire) this.move(c, pad.x, pad.y)
      c.dx = pad.x
      c.dy = pad.y

      const pressed = pad.buttons & ~c.buttons & ANY_BUTTON
      if (pressed) this.lock(c)
    }
    c.buttons = pad.buttons
  }

  /** The machine wanders while you are choosing, then makes up its mind just after you do. */
  private driveCpu(c: Cursor): void {
    if (c.locked >= 0) return
    const decided = this.cursors[0].locked >= 0
    if (--c.hop > 0) return
    // Slow browsing before you commit, a fast slot-machine roll after.
    c.hop = decided ? 3 : 14
    c.cell = Math.floor(this.random() * this.cells.length) % this.cells.length
    // Seven more hops once you have committed — a fifth of a second of slot machine — and then it
    // stops on whatever it is showing. A counter and not a coin flip, so the screen always ends.
    if (decided && ++c.rolls >= 7) this.lock(c)
  }

  private move(c: Cursor, dx: number, dy: number): void {
    const cols = COLUMNS
    const rows = this.rows
    let col = c.cell % cols
    let row = Math.floor(c.cell / cols)
    if (dx) col = (col + dx + cols) % cols
    if (dy) row = (row - dy + rows) % rows // screen y is down, stick y is up
    // Wrapping onto a gap in the last row lands on the last cell there instead of nothing.
    let cell = row * cols + col
    if (cell >= this.cells.length) cell = dx ? row * cols : this.cells.length - 1
    c.cell = Math.min(cell, this.cells.length - 1)
  }

  private lock(c: Cursor): void {
    const id = this.cells[c.cell]
    c.locked = c.cell
    // The random cell decides now, and never picks the random cell itself.
    c.choice = id ?? this.cells[Math.floor(this.random() * (this.cells.length - 1))] ?? this.cells[0] ?? null
  }
}
