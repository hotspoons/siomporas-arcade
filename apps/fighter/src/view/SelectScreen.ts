// Drawing the character select, on the same 384×224 monitor as the fight.
//
// The portraits are the ones the ROM rip found next to each atlas. A character without one is drawn
// from the first frame of their idle instead, and a character with no art at all gets a panel in
// their own two colours — the same graceful fall the fight renderer makes, for the same reason: the
// roster is data and the art arrives later.

import { CHARACTERS } from '../sim/Character'
import { COLUMNS, type Select } from '../app/Select'
import { cachedArt, type CharacterArt } from './Sprites'
import { screen, VIEW_H, VIEW_W } from './Render'

const INK = '#f4f0e4'
const DIM = 'rgba(244,240,228,0.5)'
const P1_INK = '#e05a4f'
const P2_INK = '#5aa9e0'

// The portraits are 96 square, so the grid is built around showing one whole: four columns of 96
// across a 384 screen, and two rows of 96 once the title and the footer have taken 32 between them.
// A longer roster needs three rows, which no longer fits, and the cell scales the portrait down —
// but at the size the roster actually is, every mugshot is drawn at 1:1.
const HEAD_H = 12
const FOOT_H = 20
const CELL_W = Math.floor(VIEW_W / COLUMNS)
const NAME_H = 9

function font(ctx: CanvasRenderingContext2D, px: number, weight = 700): void {
  ctx.font = `${weight} ${px}px ui-monospace, "Courier New", monospace`
}

export function renderSelect(ctx: CanvasRenderingContext2D, sel: Select): void {
  screen(ctx, () => draw(ctx, sel))
}

function draw(ctx: CanvasRenderingContext2D, sel: Select): void {
  ctx.fillStyle = '#0b0c10'
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)

  const rows = sel.rows
  const cellH = Math.min(CELL_W, Math.floor((VIEW_H - HEAD_H - FOOT_H) / rows))
  const gridH = rows * cellH
  const top = HEAD_H + Math.floor((VIEW_H - HEAD_H - FOOT_H - gridH) / 2)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  font(ctx, 7)
  ctx.fillStyle = INK
  ctx.fillText('SELECT YOUR FIGHTER', VIEW_W / 2, 6)

  for (let i = 0; i < sel.cells.length; i++) {
    const x = (i % COLUMNS) * CELL_W
    const y = top + Math.floor(i / COLUMNS) * cellH
    cell(ctx, sel.cells[i], x, y, CELL_W, cellH)
  }

  // The cursors last, so they sit over the panels. Both on one cell draws the second inset, which
  // is how a mirror match announces itself before anybody has locked anything in.
  const both = sel.cursors[0].cell === sel.cursors[1].cell
  sel.cursors.forEach((c, i) => {
    const x = (c.cell % COLUMNS) * CELL_W
    const y = top + Math.floor(c.cell / COLUMNS) * cellH
    const inset = both && i === 1 ? 3 : 0
    // Half a cycle apart, so the two of them are never both dark at once.
    cursor(ctx, x + inset, y + inset, CELL_W - inset * 2, cellH - inset * 2, i === 0 ? P1_INK : P2_INK, c.locked >= 0, sel.frame + i * 12)
  })

  footer(ctx, sel)
}

/** One panel: the portrait if there is one, the idle frame if not, colours if there is no art. */
function cell(ctx: CanvasRenderingContext2D, id: string | null, x: number, y: number, w: number, h: number): void {
  const art = id ? artFor(id) : null
  const ch = id ? CHARACTERS.find((c) => c.id === id) : undefined

  ctx.fillStyle = ch ? shade(ch.body, -0.55) : '#161a22'
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2)

  ctx.save()
  ctx.beginPath()
  ctx.rect(x + 1, y + 1, w - 2, h - 2)
  ctx.clip()
  const boxH = h - 2
  if (art?.portrait) {
    // The whole mugshot, not the top of it: the thing that makes a character recognisable at this
    // size is often below the chin — a raised fist, a colour on the shoulder — and cropping it away
    // would mean the artist is designing for a frame we do not actually show.
    const img = art.portrait
    const s2 = Math.min(1, (w - 2) / img.naturalWidth, boxH / img.naturalHeight)
    const iw = Math.round(img.naturalWidth * s2)
    const ih = Math.round(img.naturalHeight * s2)
    ctx.drawImage(img, Math.round(x + (w - iw) / 2), y + 1 + Math.max(0, boxH - ih), iw, ih)
  } else if (art) {
    // No mugshot: stand the character in the panel, head at the top, feet cropped by the clip.
    const idle = art.anims.idle
    const fr = idle ? art.frames[idle.frames[0]] : undefined
    if (fr) {
      const s = Math.min(1, (w - 8) / fr.w, (boxH * 1.35) / fr.h)
      ctx.drawImage(art.image, fr.x, fr.y, fr.w, fr.h, Math.round(x + (w - fr.w * s) / 2), y + 2, Math.round(fr.w * s), Math.round(fr.h * s))
    }
  } else if (ch) {
    blank(ctx, x, y, w, boxH, ch.body, ch.trim, ch.name[0])
  } else {
    blank(ctx, x, y, w, boxH, '#2a2f3a', '#ffd166', '?')
  }
  ctx.restore()

  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.fillRect(x + 1, y + h - NAME_H - 1, w - 2, NAME_H)
  font(ctx, 6)
  ctx.fillStyle = ch ? INK : '#ffd166'
  ctx.fillText(ch?.name ?? 'RANDOM', x + w / 2, y + h - NAME_H / 2 - 1)
}

/** A character with no art at all: their own two colours and their initial, so the cell still reads. */
function blank(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, body: string, trim: string, letter: string): void {
  ctx.fillStyle = shade(body, -0.2)
  ctx.fillRect(x + 8, y + 6, w - 16, h - 6)
  ctx.fillStyle = trim
  ctx.fillRect(x + 8, y + 6, w - 16, 3)
  font(ctx, 26)
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillText(letter, x + w / 2, y + h / 2 + 4)
}

function cursor(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string, locked: boolean, frame: number): void {
  // Locked is solid; still choosing blinks, which is the oldest way to say "this one is live".
  if (!locked && frame % 24 >= 16) return
  ctx.strokeStyle = colour
  ctx.lineWidth = locked ? 3 : 2
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3)
  if (!locked) return
  for (const [cx, cy] of [[x + 3, y + 3], [x + w - 3, y + 3], [x + 3, y + h - 3], [x + w - 3, y + h - 3]]) {
    ctx.fillStyle = colour
    ctx.fillRect(cx - 2, cy - 2, 4, 4)
  }
}

function footer(ctx: CanvasRenderingContext2D, sel: Select): void {
  const y = VIEW_H - 13
  const nameOf = (i: 0 | 1): string => {
    const c = sel.cursors[i]
    const id = c.locked >= 0 ? c.choice : sel.cells[c.cell]
    return CHARACTERS.find((x) => x.id === id)?.name ?? 'RANDOM'
  }

  font(ctx, 9)
  ctx.textAlign = 'left'
  ctx.fillStyle = P1_INK
  ctx.fillText(nameOf(0), 6, y)
  ctx.textAlign = 'right'
  ctx.fillStyle = P2_INK
  ctx.fillText(nameOf(1), VIEW_W - 6, y)

  ctx.textAlign = 'center'
  font(ctx, 8)
  ctx.fillStyle = sel.settled ? '#ffd166' : DIM
  ctx.fillText('VS', VIEW_W / 2, y)

  font(ctx, 6, 600)
  ctx.fillStyle = DIM
  const p2 = sel.twoPlayer ? 'P2 arrows + numpad' : 'P2 is the machine — press 4 for two players'
  ctx.fillText(sel.settled ? 'HERE WE GO' : `W A S D to choose, any punch to lock in · ${p2}`, VIEW_W / 2, VIEW_H - 4)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
}

/** The art for a character, if it has already been fetched. The grid never waits for it. */
function artFor(id: string): CharacterArt | null {
  const ch = CHARACTERS.find((c) => c.id === id)
  return ch ? cachedArt(ch.art) : null
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const hx = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)))))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
  return `#${hx}`
}
