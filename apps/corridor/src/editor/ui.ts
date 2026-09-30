// Panel bits for the editor's four mode panels.
//
// These are now thin adapters over the shared control set in `src/ui/controls.ts`, kept at this
// path and with these signatures so areas.ts / place.ts / grow.ts / structures.ts did not have to
// change to pick up the new look. One definition of what a slider is, for both apps.
// `el` is both imported and re-exported: a bare `export { el } from '...'` forwards it to this
// module's consumers WITHOUT binding it in this module's own scope, so frameBanner below could
// not see it. tsc caught that the moment the two branches merged.
import { el } from '../ui/shell'
import { slider as uiSlider } from '../ui/controls'

export { el }

/**
 * A labelled range with its value, and a dot that tells you at a glance whether this knob is
 * still neutral — the whole point of an adjustment area is that almost every knob in it is.
 * Double-click the label to snap back to neutral.
 */
export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  neutral: number,
  note: string,
  onInput: (v: number) => void,
): HTMLElement {
  return uiSlider({ label, value, min, max, step, neutral, note, onInput })
}

/**
 * The loudest thing the panel can say. A frame mismatch means every coordinate in the file is
 * displaced — on 2026-09-22 by a median of 40 m and up to 439 m — while every polygon still draws
 * a plausible shape over plausible ground. Nothing else in this editor is wrong in a way you
 * cannot see, so nothing else gets a banner.
 */
/**
 * The two tabs every mode's panel has: what you can ADD, and what is PLACED.
 *
 * Rich, 2026-09-30: *"That has an assets/placed tab set… this would be a great formatting direction
 * to go in for everything in the place editor."* So this is the one strip every mode builds, with
 * the classes `Tabs` in ui/shell.ts emits (`tab-strip` / `tab`) so it IS that control and not a
 * lookalike. Each mode keeps its own `panelTab`; selecting something switches to the placed tab,
 * arming something switches to the palette.
 */
export function paneTabs(root: HTMLElement, tabs: { id: string; label: string }[], current: string, pick: (id: string) => void): void {
  const strip = el('div', 'tab-strip')
  strip.setAttribute('role', 'tablist')
  for (const t of tabs) {
    const b = el('button', `tab${current === t.id ? ' on' : ''}`)
    b.setAttribute('role', 'tab')
    b.append(el('span', '', t.label))
    b.onclick = () => pick(t.id)
    strip.append(b)
  }
  root.append(strip)
}

/**
 * The drag protocol every palette shares. The canvas reads one MIME type and gets the mode and
 * the thing as JSON, so a new palette needs no new listener — see `dropThing` in main.ts.
 */
export const DROP_TYPE = 'text/apex-drop'

/**
 * A palette chip you can drag onto the world or click to arm.
 *
 * Rich, 2026-09-30: *"we can drag out of the 'place' palette but no other palette."* Every mode's
 * palette is made of these now: the same chip, the same drag, the same drop.
 */
export function dragChip(o: { mode: string; id: string; label: string; note?: string; on?: boolean; title?: string; onClick: () => void }): HTMLButtonElement {
  const b = el('button', `chip${o.on ? ' on' : ''}`) as HTMLButtonElement
  b.append(el('span', 'nm', o.label))
  if (o.note) b.append(el('span', 'mono', o.note))
  b.title = o.title ?? `${o.label} — drag it onto the world, or click to arm it`
  b.draggable = true
  b.ondragstart = (e) => {
    e.dataTransfer?.setData(DROP_TYPE, JSON.stringify({ mode: o.mode, id: o.id }))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  }
  b.onclick = o.onClick
  return b
}

/**
 * A polygon hugging the road nearest a point: `halfLen` metres either way along it, `halfWidth`
 * either side. What a traffic level dropped on a road becomes. Site metres, x east, y north.
 */
export function roadStrip(
  chains: { index: number; length_m: number; half: number; at: (s: number) => { pos: { x: number; z: number }; dir: { x: number; z: number } } }[],
  pt: { x: number; y: number },
  halfLen: number,
  extraWidth = 3,
): [number, number][] | null {
  type Chain = (typeof chains)[number]
  let bestChain: Chain | null = null
  let bestS = 0
  let bestD = Infinity
  const consider = (c: Chain, s: number) => {
    const p = c.at(s).pos
    const d = Math.hypot(p.x - pt.x, -p.z - pt.y)
    if (d < bestD) { bestChain = c; bestS = s; bestD = d }
  }
  // coarse over every chain, then fine around the best: the chains are long and the answer only
  // needs to be within a metre
  for (const c of chains) for (let s = 0; s <= c.length_m; s += 20) consider(c, s)
  const coarse = bestChain as Chain | null
  if (coarse) for (let s = Math.max(0, bestS - 20); s <= Math.min(coarse.length_m, bestS + 20); s += 2) consider(coarse, s)
  const fine = bestChain as Chain | null
  const best = fine ? { chain: fine, s: bestS, d: bestD } : null
  if (!best || best.d > 40) return null
  const c = best.chain
  const s0 = Math.max(0, best.s - halfLen)
  const s1 = Math.min(c.length_m, best.s + halfLen)
  if (s1 - s0 < 10) return null
  const half = c.half + extraWidth
  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let s = s0; s <= s1 + 1e-6; s += Math.min(10, (s1 - s0) / 4)) {
    const at = c.at(Math.min(s, s1))
    const x = at.pos.x, y = -at.pos.z
    const dx = at.dir.x, dy = -at.dir.z
    const l = Math.hypot(dx, dy) || 1
    left.push([+(x - (dy / l) * half).toFixed(1), +(y + (dx / l) * half).toFixed(1)])
    right.push([+(x + (dy / l) * half).toFixed(1), +(y - (dx / l) * half).toFixed(1)])
  }
  return [...left, ...right.reverse()]
}

export function frameBanner(file: string, why: string): HTMLElement {
  const b = el('div', 'framewarn')
  b.append(el('strong', '', `${file} was authored in a different frame`))
  b.append(el('span', '', why))
  b.append(el('span', 'dim', 'Regenerate the seeded areas (`python -m corridor areas <slug> --overwrite`) and re-run grow; anything drawn by hand has to be redrawn.'))
  return b
}
