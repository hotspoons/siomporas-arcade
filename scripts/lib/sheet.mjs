// Find the panels in a filled-in sheet, rather than assuming where they are.
//
// The template says where every slot is, and `sheet.json` has those positions as fractions, which
// worked for as long as the generators came back with the sheet's own 4:3. They do not. A better one
// turned up that keeps the layout faithfully — the shapes, the order, the proportions of each panel
// — on a 3:2 canvas of its own choosing, and against that a fraction is a guess: cut by it and the
// marquee loses an edge.
//
// So the panels are found. Every one of them is busy artwork sitting on the template's flat grey, so
// what is measured is distance from the background colour — whatever that colour turns out to be —
// and the islands that leaves are the panels. Then each island is matched to the slot whose position
// on the sheet it is nearest, which is what turns five rectangles into a marquee, two flanks, a
// control panel and a bezel.
//
// This is strictly better than the fractions even when the canvas *is* right: a generator that draws
// a panel a little inside its slot gets cut to its artwork rather than to the slot.

import { execFileSync } from 'node:child_process'

/** Grid the sheet is sampled at. Fine enough to separate panels, coarse enough to stay cheap. */
const COLS = 240
/** How far off the background a cell has to be to count as artwork, out of 255. */
const TOLERANCE = 26
/**
 * An island smaller than this fraction of the sheet is not a panel. The bar is set high on purpose:
 * the labels the template writes over each slot come back in the artwork, they are not the
 * background colour either, and the smallest real panel still covers four times this.
 */
const MIN_AREA = 0.02

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

/** The sheet as a grid of RGB cells. */
function sample(src, cols, rows) {
  const txt = magick([src, '-resize', `${cols}x${rows}!`, '-depth', '8', 'txt:-'])
  const cells = new Array(cols * rows).fill(null)
  for (const line of txt.split('\n')) {
    const m = /^(\d+),(\d+): \((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(line)
    if (m) cells[Number(m[2]) * cols + Number(m[1])] = [Number(m[3]), Number(m[4]), Number(m[5])]
  }
  return cells
}

/** The colour the most cells are, to within a shade: the template's field. */
function background(cells) {
  const bins = new Map()
  for (const c of cells) {
    if (!c) continue
    const key = `${c[0] >> 3}:${c[1] >> 3}:${c[2] >> 3}`
    const got = bins.get(key) ?? { n: 0, sum: [0, 0, 0] }
    got.n++
    for (let i = 0; i < 3; i++) got.sum[i] += c[i]
    bins.set(key, got)
  }
  let best = null
  for (const b of bins.values()) if (!best || b.n > best.n) best = b
  return best.sum.map((s) => s / best.n)
}

/**
 * The panels in a sheet, as pixel rectangles, biggest first. Each carries the fraction of the sheet
 * its centre sits at, which is what the slot matching runs on.
 */
export function detectPanels(src) {
  const [w, h] = magick([src, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  const cols = COLS
  const rows = Math.max(1, Math.round((COLS * h) / w))
  const cells = sample(src, cols, rows)
  const bg = background(cells)

  // Artwork. Deliberately *not* dilated: a label sits a few pixels above its slot, and smearing the
  // mask joins the two into one island whose bounding box then has the word MARQUEE along the top of
  // it. Left alone, a label is its own small island and is dropped on area. Panels that come apart
  // into two big pieces are put back together below.
  const art = new Uint8Array(cols * rows)
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]
    if (!c) continue
    const d = Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2]))
    if (d > TOLERANCE) art[i] = 1
  }

  // Islands, by flood fill.
  const seen = new Uint8Array(cols * rows)
  const found = []
  const stack = []
  for (let start = 0; start < art.length; start++) {
    if (!art[start] || seen[start]) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let n = 0
    let x0 = cols
    let x1 = -1
    let y0 = rows
    let y1 = -1
    while (stack.length) {
      const i = stack.pop()
      const x = i % cols
      const y = (i - x) / cols
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
        const j = ny * cols + nx
        if (art[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    if (n / (cols * rows) < MIN_AREA) continue
    found.push({ x0, x1, y0, y1, area: n / (cols * rows) })
  }

  // One panel, two islands: a light band across a piece of artwork can cut it in half. Overlapping
  // boxes are the same panel — the slots on the sheet do not overlap, so nothing else can be.
  for (let again = true; again; ) {
    again = false
    outer: for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        const a = found[i]
        const b = found[j]
        if (a.x0 > b.x1 || b.x0 > a.x1 || a.y0 > b.y1 || b.y0 > a.y1) continue
        found[i] = {
          x0: Math.min(a.x0, b.x0),
          x1: Math.max(a.x1, b.x1),
          y0: Math.min(a.y0, b.y0),
          y1: Math.max(a.y1, b.y1),
          area: a.area + b.area,
        }
        found.splice(j, 1)
        again = true
        break outer
      }
    }
  }

  const panels = found.map((f) => {
    // Back to pixels, a cell out on each side so a panel is never cut inside its own artwork.
    const box = {
      x: Math.max(0, Math.round((f.x0 * w) / cols)),
      y: Math.max(0, Math.round((f.y0 * h) / rows)),
      w: Math.min(w, Math.round(((f.x1 + 1) * w) / cols)) - Math.max(0, Math.round((f.x0 * w) / cols)),
      h: Math.min(h, Math.round(((f.y1 + 1) * h) / rows)) - Math.max(0, Math.round((f.y0 * h) / rows)),
      area: f.area,
    }
    box.cx = (box.x + box.w / 2) / w
    box.cy = (box.y + box.h / 2) / h
    return box
  })
  panels.sort((a, b) => b.area - a.area)
  return { panels, sheet: { w, h }, background: bg }
}

/**
 * Match the panels found to the slots the template drew, by where each sits on the sheet. Greedy on
 * the closest pairing there is, which is stable for a layout this sparse and does not care what
 * shape the canvas came back as.
 */
export function matchSlots(panels, slots) {
  const want = Object.entries(slots).map(([name, s]) => ({ name, cx: s.x + s.w / 2, cy: s.y + s.h / 2 }))
  const pairs = []
  for (const p of panels) for (const s of want) pairs.push({ p, s, d: Math.hypot(p.cx - s.cx, p.cy - s.cy) })
  pairs.sort((a, b) => a.d - b.d)
  const out = new Map()
  const usedPanel = new Set()
  for (const { p, s, d } of pairs) {
    if (out.has(s.name) || usedPanel.has(p)) continue
    out.set(s.name, { ...p, off: d })
    usedPanel.add(p)
  }
  return out
}
