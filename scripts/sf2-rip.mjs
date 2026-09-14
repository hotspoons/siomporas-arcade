#!/usr/bin/env node
// Rip Street Fighter II reference sheets (ext/reference-artwork, gitignored) into game-ready atlases.
//
// SUPERSEDED FOR CHARACTERS. Fighters now come out of the graphics ROM itself — see
// scripts/rom-sprites.mjs, which gets every pose the game has, in the order the moves play them,
// with anchors measured rather than guessed. This still cuts the things no ROM dump gives us as
// neatly: the parallax stage layers and the hit sparks. The character row maps below are kept
// because they are hand-authored and still work (`node scripts/sf2-rip.mjs zangief`), but a plain
// run no longer touches them.
//
//   node scripts/sf2-rip.mjs                    # everything in the manifest
//   node scripts/sf2-rip.mjs zangief ryu        # just those ids (chars, stages or fx)
//   node scripts/sf2-rip.mjs zangief --debug    # also write a row-numbered overview to shots/rip-rows-<id>-N.png
//
// The sheets we cut are the spritedatabase.net Champion Edition rips: one flat background colour,
// no labels, no shadows, no cell borders, every row of a sheet standing on a common baseline. That
// is the whole reason they are cuttable by a script, and the four steps below lean on it.
//
// KEY. The background is whatever colour dominates the sheet border — sampled, never assumed, so a
// re-saved sheet with a slightly different flat colour still keys. Blanka's sheet is the same file
// The Spriters Resource hosts, so it also keys out the flat green shadow ellipses and the label
// text (extra `key` colours in the manifest).
//
// COMPONENTS. Everything that is not key gets dilated a couple of pixels and flood-filled with
// 8-connectivity, so a fist or a foot the artist left detached by a pixel joins its owner. The box
// we keep is the tight box of the *un*dilated pixels. Anything too small or too short is a glyph,
// a credit or a stray pixel and is dropped; whole header regions are dropped with `skipAbove`.
//
// ROWS. Boxes whose vertical spans overlap belong to one row of the sheet; rows are sorted top to
// bottom, boxes left to right. Rows are unlabelled on these sheets, so the row → animation map is
// hand-authored per character in sf2-rip.manifest.json after looking at the sheet. One row can
// hold two animations (split by frame count or on a wide x gap), and a row can be skipped.
//
// ANCHOR. Every frame trims to a different box, so the game draws each frame from an anchor:
// ax = the frame's own centre-x, ay = the row baseline (the lowest pixel of the row, which on these
// sheets is the floor the whole row stands on) measured from the frame's top. Frames within a row
// then share a floor line and stepping through an animation does not jitter. Airborne rows use
// the same rule — the baseline is where the row's feet would land.
//
// Stages come from the layered Spriters Resource sheets (bands of sky / far / floor + props), with
// the spritedatabase composite as the reference for how they stack; sparks come from the fx sheet.
// Their cut rectangles are authored in the manifest too. Output goes under
// apps/fighter/public/assets/crown/, plus a labelled contact sheet per thing under shots/ so the
// grouping and the keying can be checked by eye. Idempotent: re-running rewrites everything.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'apps/fighter/public/assets/crown')
const SHOTS = path.join(ROOT, 'shots')
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'scripts/sf2-rip.manifest.json'), 'utf8'))

const argv = process.argv.slice(2)
const DEBUG = argv.includes('--debug')
const wanted = argv.filter((a) => !a.startsWith('--'))

// ---------------------------------------------------------------------------------------------
// raster helpers — everything is RGBA Uint8Array + width/height
// ---------------------------------------------------------------------------------------------

async function loadRGBA(file) {
  const { data, info } = await sharp(file, { animated: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

function hexToRGB(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

// The most common opaque colour along the four edges of the image.
function borderColour(img) {
  const { data, w, h } = img
  const hist = new Map()
  const bump = (x, y) => {
    const i = (y * w + x) * 4
    if (data[i + 3] < 128) return
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    hist.set(k, (hist.get(k) || 0) + 1)
  }
  for (let x = 0; x < w; x++) { bump(x, 0); bump(x, h - 1) }
  for (let y = 0; y < h; y++) { bump(0, y); bump(w - 1, y) }
  let best = 0, bestN = -1
  for (const [k, n] of hist) if (n > bestN) { best = k; bestN = n }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255]
}

// Foreground mask: 1 where the pixel is not within `tol` of any key colour (and not transparent).
function keyMask(img, keys, tol) {
  const { data, w, h } = img
  const mask = new Uint8Array(w * h)
  const t2 = tol * tol
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (data[i + 3] < 128) continue
    let fg = 1
    for (const [kr, kg, kb] of keys) {
      const dr = data[i] - kr, dg = data[i + 1] - kg, db = data[i + 2] - kb
      if (dr * dr + dg * dg + db * db <= t2) { fg = 0; break }
    }
    mask[p] = fg
  }
  return mask
}

function dilate(mask, w, h, r) {
  let src = mask
  for (let k = 0; k < r; k++) {
    const dst = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (src[p]) { dst[p] = 1; continue }
        let on = 0
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= w) continue
            if (src[yy * w + xx]) { on = 1; break }
          }
        }
        dst[p] = on
      }
    }
    src = dst
  }
  return src
}

// 8-connected components on `grown`, boxes measured on `tight`.
function components(tight, grown, w, h) {
  const label = new Int32Array(w * h) // 0 = unvisited
  const boxes = []
  components.lastLabel = label
  const stack = new Int32Array(w * h)
  let next = 1
  for (let start = 0; start < w * h; start++) {
    if (!grown[start] || label[start]) continue
    const id = next++
    let sp = 0
    stack[sp++] = start
    label[start] = id
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0
    while (sp) {
      const p = stack[--sp]
      const x = p % w, y = (p - x) / w
      if (tight[p]) {
        area++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (grown[q] && !label[q]) { label[q] = id; stack[sp++] = q }
        }
      }
    }
    if (x1 >= 0) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area, id })
  }
  return boxes
}

// Group boxes into rows by vertical overlap. Two boxes share a row if they overlap vertically by
// at least `minOverlap` of the shorter one. Rows sorted top→bottom, boxes left→right.
function groupRows(boxes, minOverlap = 0.25) {
  const sorted = [...boxes].sort((a, b) => a.y - b.y)
  const rows = []
  for (const b of sorted) {
    let placed = false
    for (const row of rows) {
      const top = Math.max(row.y0, b.y), bot = Math.min(row.y1, b.y + b.h)
      const ov = bot - top
      const minH = Math.min(b.h, row.y1 - row.y0)
      if (ov > 0 && ov >= minOverlap * minH) {
        row.boxes.push(b)
        row.y0 = Math.min(row.y0, b.y)
        row.y1 = Math.max(row.y1, b.y + b.h)
        placed = true
        break
      }
    }
    if (!placed) rows.push({ y0: b.y, y1: b.y + b.h, boxes: [b] })
  }
  rows.sort((a, b) => a.y0 - b.y0)
  for (const r of rows) r.boxes.sort((a, b) => a.x - b.x)
  return rows
}

function extract(img, box) {
  const { data, w } = img
  const out = Buffer.alloc(box.w * box.h * 4)
  for (let y = 0; y < box.h; y++) {
    const src = ((box.y + y) * w + box.x) * 4
    data.copy(out, y * box.w * 4, src, src + box.w * 4)
  }
  return { data: out, w: box.w, h: box.h }
}

// Apply alpha from the sheet-wide mask (1 = keep, stride `sheetW`) to a frame cut from `box`. When
// the box came from component detection (`box.id`) only that component's pixels survive, so a row
// label or a neighbouring sprite that strays into the rectangle is dropped with the background.
function applyMask(fr, mask, box, sheetW, label = null) {
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const p = (box.y + y) * sheetW + (box.x + x)
      const keep = mask[p] && (!label || !box.id || label[p] === box.id)
      if (!keep) fr.data[(y * box.w + x) * 4 + 3] = 0
    }
  }
}

function toPng(img) {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.w, height: img.h, channels: 4 },
  }).png()
}

function flipX(img) {
  const out = Buffer.alloc(img.data.length)
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4, d = (y * img.w + (img.w - 1 - x)) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
    }
  }
  return { data: out, w: img.w, h: img.h }
}

// ---------------------------------------------------------------------------------------------
// shelf packing
// ---------------------------------------------------------------------------------------------

function shelfPack(items, maxW, pad) {
  // items: {w,h,...} — sort by height desc for tidy shelves, place row by row
  const order = [...items].sort((a, b) => b.h - a.h || b.w - a.w)
  let x = pad, y = pad, shelfH = 0, width = 0
  for (const it of order) {
    if (x + it.w + pad > maxW && x > pad) { x = pad; y += shelfH + pad; shelfH = 0 }
    it.px = x; it.py = y
    x += it.w + pad
    shelfH = Math.max(shelfH, it.h)
    width = Math.max(width, x)
  }
  return { w: width, h: y + shelfH + pad }
}

async function composeAtlas(items, size) {
  const layers = items.map((it) => ({
    input: Buffer.from(it.img.data.buffer, it.img.data.byteOffset, it.img.data.byteLength),
    raw: { width: it.img.w, height: it.img.h, channels: 4 },
    left: it.px, top: it.py,
  }))
  return sharp({ create: { width: size.w, height: size.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).png()
}

// ---------------------------------------------------------------------------------------------
// contact sheet: frames on a checkerboard, labelled
// ---------------------------------------------------------------------------------------------

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') }

async function contactSheet(items, file, { maxW = 1800, scale = 1 } = {}) {
  // each item: {img, name, ax, ay}
  const pad = 6, labelH = 14
  let x = pad, y = pad, rowH = 0, W = 0
  for (const it of items) {
    const w = it.img.w * scale, h = it.img.h * scale + labelH
    if (x + w + pad > maxW && x > pad) { x = pad; y += rowH + pad; rowH = 0 }
    it.cx = x; it.cy = y
    x += Math.max(w, 30) + pad
    rowH = Math.max(rowH, h)
    W = Math.max(W, x)
  }
  const H = y + rowH + pad
  const checker = Buffer.alloc(W * H * 4)
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const v = ((xx >> 3) + (yy >> 3)) & 1 ? 0x60 : 0x48
    const i = (yy * W + xx) * 4
    checker[i] = v; checker[i + 1] = v; checker[i + 2] = v; checker[i + 3] = 255
  }
  const layers = []
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
  for (const it of items) {
    layers.push({
      input: await toPng(it.img).resize(it.img.w * scale, it.img.h * scale, { kernel: 'nearest' }).toBuffer(),
      left: it.cx, top: it.cy + labelH,
    })
    svg += `<text x="${it.cx}" y="${it.cy + 10}" font-family="monospace" font-size="10" fill="#fff">${esc(it.name)}</text>`
    if (it.ax != null) {
      const ax = it.cx + it.ax * scale, ay = it.cy + labelH + it.ay * scale
      svg += `<line x1="${it.cx}" x2="${it.cx + it.img.w * scale}" y1="${ay}" y2="${ay}" stroke="#0f0" stroke-width="1"/>`
      svg += `<line x1="${ax}" x2="${ax}" y1="${it.cy + labelH}" y2="${it.cy + labelH + it.img.h * scale}" stroke="#f0f" stroke-width="1"/>`
    }
  }
  svg += '</svg>'
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 })
  await sharp(checker, { raw: { width: W, height: H, channels: 4 } }).composite(layers).png().toFile(file)
}

// Row-numbered overview of the raw sheet, in ~1000px-high bands, so the manifest can be authored.
async function debugRows(img, rows, id) {
  writeFileSync(path.join(SHOTS, `rip-rows-${id}.json`), JSON.stringify(rows.map((r) => ({ y0: r.y0, y1: r.y1, boxes: r.boxes.map(({ x, y, w, h, area }) => ({ x, y, w, h, area })) }))))
  const bandH = 1000
  for (let b = 0, y = 0; y < img.h; y += bandH, b++) {
    const h = Math.min(bandH, img.h - y)
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.w}" height="${h}">`
    rows.forEach((row, ri) => {
      if (row.y1 < y || row.y0 > y + h) return
      svg += `<line x1="0" x2="${img.w}" y1="${row.y1 - y}" y2="${row.y1 - y}" stroke="#0f0" stroke-width="1"/>`
      svg += `<text x="4" y="${row.y0 - y + 14}" font-family="monospace" font-size="18" font-weight="bold" fill="#ff0" stroke="#000" stroke-width="0.6">r${ri} (${row.boxes.length})</text>`
      row.boxes.forEach((bx, fi) => {
        svg += `<rect x="${bx.x}" y="${bx.y - y}" width="${bx.w}" height="${bx.h}" fill="none" stroke="#f0f" stroke-width="1"/>`
        svg += `<text x="${bx.x + 1}" y="${bx.y - y + 10}" font-family="monospace" font-size="10" fill="#fff" stroke="#000" stroke-width="0.4">${fi}</text>`
      })
    })
    svg += '</svg>'
    const out = path.join(SHOTS, `rip-rows-${id}-${b}.png`)
    await toPng(extract(img, { x: 0, y, w: img.w, h }))
      .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
      .toFile(out)
    console.log(`  debug ${path.relative(ROOT, out)} (y ${y}..${y + h})`)
  }
}

// ---------------------------------------------------------------------------------------------
// characters
// ---------------------------------------------------------------------------------------------

function fpsFor(anim, spec) {
  if (spec.fps) return spec.fps
  if (/^(idle|walk-|crouch-idle|crouch$|turn|crouch-turn)/.test(anim)) return 12
  if (/^(dizzy|down|ko|getup|time-over|win|thrown)/.test(anim)) return 6
  return 15
}

async function detectSheet(spec, id) {
  const src = path.join(ROOT, spec.source)
  const img = await loadRGBA(src)
  const keys = [spec.key === 'auto' || !spec.key ? borderColour(img) : hexToRGB(spec.key), ...(spec.extraKeys || []).map(hexToRGB)]
  const tol = spec.tolerance ?? 10
  const mask = keyMask(img, keys, tol)
  if (spec.skipAbove) mask.fill(0, 0, spec.skipAbove * img.w)
  if (spec.skipBelow) mask.fill(0, spec.skipBelow * img.w)
  for (const r of spec.skipRects || []) {
    for (let y = r.y; y < r.y + r.h; y++) mask.fill(0, y * img.w + r.x, y * img.w + r.x + r.w)
  }
  const minArea = spec.minArea ?? 80, minH = spec.minHeight ?? 14
  // Two passes. The first, undilated, finds the specks — row labels, credits, stray pixels — and
  // erases them from the mask, so that the dilated pass cannot glue a label to the sprite above it.
  for (const b of components(mask, mask, img.w, img.h)) {
    if (b.area >= minArea && b.h >= minH) continue
    const lab = components.lastLabel
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { const p = y * img.w + x; if (lab[p] === b.id) mask[p] = 0 }
  }
  const grown = dilate(mask, img.w, img.h, spec.dilate ?? 2)
  const boxes = components(mask, grown, img.w, img.h).filter((b) => b.area >= minArea && b.h >= minH)
  const label = components.lastLabel
  const rows = groupRows(boxes, spec.rowOverlap ?? 0.25)
  console.log(`  ${id}: ${img.w}x${img.h} key ${keys.map(rgbToHex).join(',')} tol ${tol} → ${boxes.length} boxes in ${rows.length} rows`)
  return { img, mask, label, keys, boxes, rows }
}

async function ripCharacter(id, spec) {
  console.log(`[char] ${id}`)
  const { img, mask, label, keys, rows } = await detectSheet(spec, id)
  if (DEBUG) await debugRows(img, rows, id)

  const frames = {}, anims = {}, items = [], notes = [...(spec.notes ? [spec.notes] : [])]
  const rowBaseline = (row) => row.y1 // lowest pixel of the row = the floor the row stands on

  function addAnim(anim, boxes, row, opts = {}) {
    if (opts.dropFrames) boxes = boxes.filter((_, i) => !opts.dropFrames.includes(i))
    if (!boxes.length) return
    const baseline = opts.baseline ?? rowBaseline(row)
    const names = []
    boxes.forEach((b, i) => {
      const name = `${anim}-${i}`
      let fr = extract(img, b)
      applyMask(fr, mask, b, img.w, label)
      let ax = Math.round(b.w / 2)
      if (opts.flip) { fr = flipX(fr); ax = b.w - ax }
      const ay = baseline - b.y
      frames[name] = { x: 0, y: 0, w: b.w, h: b.h, ax, ay, sheet: { x: b.x, y: b.y } }
      items.push({ name, img: fr, w: b.w, h: b.h, ax, ay })
      names.push(name)
    })
    anims[anim] = { frames: names, fps: fpsFor(anim, opts), loop: !!opts.loop, pingpong: !!opts.pingpong }
    if (opts.alias) for (const a of opts.alias) anims[a] = { ...anims[anim], frames: [...names] }
  }

  // Row map. Each entry: { anim, count?, from?, to?, pingpong?, loop?, alias?, flip?, skip?, splitGap?, segs? }
  // `segs` = several anims sharing one row, taken left→right by `count` (or the rest).
  const rowSpecs = spec.rows || []
  rowSpecs.forEach((rs, ri) => {
    const row = rows[rs.row ?? ri]
    if (!row) { console.warn(`  ! ${id}: row ${rs.row ?? ri} does not exist`); return }
    if (rs.skip) return
    let boxes = row.boxes
    if (rs.dropFrames) boxes = boxes.filter((_, i) => !rs.dropFrames.includes(i))
    if (rs.from != null || rs.to != null) boxes = boxes.slice(rs.from ?? 0, rs.to ?? boxes.length)
    const rowOpts = { ...rs, dropFrames: undefined }
    let segs = rs.segs
    if (!segs && rs.splitGap) {
      // split on wide x gaps into as many anims as listed
      const names = rs.anims
      segs = []
      let cur = [boxes[0]]
      for (let i = 1; i < boxes.length; i++) {
        const gap = boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w)
        if (gap >= rs.splitGap && segs.length < names.length - 1) { segs.push({ anim: names[segs.length], boxes: cur }); cur = [] }
        cur.push(boxes[i])
      }
      segs.push({ anim: names[segs.length], boxes: cur })
      for (const s of segs) addAnim(s.anim, s.boxes, row, { ...rowOpts, ...(s.opts || {}) })
      return
    }
    if (segs) {
      let i = 0
      for (const s of segs) {
        const n = s.count ?? boxes.length - i
        const sb = boxes.slice(i, i + n)
        i += n
        if (s.skip) continue
        addAnim(s.anim, sb, row, { ...rowOpts, ...s })
      }
      if (i < boxes.length) console.warn(`  ! ${id}: row ${ri} has ${boxes.length - i} unused frames after segs`)
      return
    }
    if (rs.count != null && boxes.length !== rs.count) console.warn(`  ! ${id}: row ${ri} (${rs.anim}) expected ${rs.count} frames, found ${boxes.length}`)
    addAnim(rs.anim, boxes, row, rowOpts)
  })
  if (rows.length > rowSpecs.length) console.warn(`  ! ${id}: ${rows.length - rowSpecs.length} rows past the end of the row map (r${rowSpecs.length}..r${rows.length - 1})`)

  // extra frames pulled from another sheet (e.g. Ryu's projectile from the boxed sheet)
  for (const ex of spec.extra || []) {
    const { img: eimg, mask: emask, label: elabel, rows: erows } = await detectSheet(ex, `${id}/${ex.anim}`)
    if (DEBUG) await debugRows(eimg, erows, `${id}-${ex.anim}`)
    const row = erows[ex.row]
    if (!row) { console.warn(`  ! ${id}: extra ${ex.anim} row ${ex.row} missing`); continue }
    let boxes = row.boxes
    if (ex.from != null || ex.to != null) boxes = boxes.slice(ex.from ?? 0, ex.to ?? boxes.length)
    const names = []
    boxes.forEach((b, i) => {
      const name = `${ex.anim}-${i}`
      const fr = extract(eimg, b)
      applyMask(fr, emask, b, eimg.w, elabel)
      const ax = Math.round(b.w / 2), ay = Math.round(b.h / 2) // projectiles anchor at their centre
      frames[name] = { x: 0, y: 0, w: b.w, h: b.h, ax, ay, sheet: { x: b.x, y: b.y, source: ex.source } }
      items.push({ name, img: fr, w: b.w, h: b.h, ax, ay })
      names.push(name)
    })
    anims[ex.anim] = { frames: names, fps: ex.fps || 12, loop: !!ex.loop, pingpong: !!ex.pingpong }
    notes.push(`${ex.anim} taken from ${ex.source} (row ${ex.row})`)
  }

  if (!items.length) { console.log('  (no rows mapped yet — author spec.rows from the --debug overview)'); return }

  // pack
  const size = shelfPack(items, spec.maxAtlasWidth || 2048, 2)
  for (const it of items) { frames[it.name].x = it.px; frames[it.name].y = it.py }
  const dir = path.join(OUT, 'chars', id)
  mkdirSync(dir, { recursive: true })
  await (await composeAtlas(items, size)).toFile(path.join(dir, 'atlas.png'))

  const missing = CANON.concat(spec.specials || []).filter((a) => !anims[a])
  const out = {
    id, source: spec.source, pixelScale: 1, atlas: 'atlas.png', atlasSize: size,
    key: keys.map(rgbToHex), facing: 'right', anchor: 'ax = frame centre-x; ay = row baseline (floor) from frame top',
    frames, anims, missing, notes,
  }
  writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(out, null, 1))

  // portrait
  if (spec.portrait) await ripPortrait(spec.portrait, path.join(dir, 'portrait.png'))

  // contact sheet, in animation order
  mkdirSync(SHOTS, { recursive: true })
  const ordered = []
  for (const an of Object.values(anims)) for (const f of an.frames) { const it = items.find((i) => i.name === f); if (it && !ordered.includes(it)) ordered.push(it) }
  await contactSheet(ordered, path.join(SHOTS, `rip-${id}.png`))
  const counts = Object.entries(anims).map(([a, an]) => `${a}:${an.frames.length}`).join(' ')
  console.log(`  ${Object.keys(frames).length} frames, atlas ${size.w}x${size.h}\n  ${counts}\n  missing: ${missing.join(', ') || '-'}`)
}

// Portrait: the detected box on the portraits sheet that contains the point `at` (a grid of faces
// this tight groups as a single row, so row/column indexing is no use).
async function ripPortrait(p, file) {
  const { img, mask, boxes } = await detectSheet(p, 'portrait')
  const [px, py] = p.at
  const b = boxes.find((bx) => px >= bx.x && px < bx.x + bx.w && py >= bx.y && py < bx.y + bx.h)
  if (!b) { console.warn(`  ! portrait: no box at ${px},${py} (${boxes.length} boxes)`); return }
  const fr = extract(img, b)
  if (p.keep !== false) applyMask(fr, mask, b, img.w)
  await toPng(fr).toFile(file)
  console.log(`  portrait ${b.w}x${b.h} at ${b.x},${b.y}`)
}

const CANON = `idle walk-fwd walk-back crouch crouch-idle turn crouch-turn jump-neutral jump-fwd jump-back land
stand-lp stand-mp stand-hp stand-lk stand-mk stand-hk close-lp close-mp close-hp close-lk close-mk close-hk
crouch-lp crouch-mp crouch-hp crouch-lk crouch-mk crouch-hk air-lp air-mp air-hp air-lk air-mk air-hk
block-stand block-crouch hit-high hit-low hit-crouch hit-air knockdown down getup dizzy ko throw thrown win time-over`.split(/\s+/)

// ---------------------------------------------------------------------------------------------
// stages — authored rectangles from a layered sheet
// ---------------------------------------------------------------------------------------------

async function ripStage(id, spec) {
  console.log(`[stage] ${id}`)
  const img = await loadRGBA(path.join(ROOT, spec.source))
  const at = (x, y) => { const i = (y * img.w + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]] }
  const key = spec.keyAt ? at(spec.keyAt[0], spec.keyAt[1]) : spec.key === 'auto' || !spec.key ? borderColour(img) : hexToRGB(spec.key)
  console.log(`  key ${rgbToHex(key)}`)
  const dir = path.join(OUT, 'stages', id)
  mkdirSync(path.join(dir, 'props'), { recursive: true })
  const layers = [], props = []
  for (const L of spec.layers) {
    const fr = extract(img, L.rect)
    if (L.keyBackground) {
      const m = keyMask(fr, [key], spec.tolerance ?? 10)
      applyMask(fr, m, { x: 0, y: 0, w: fr.w, h: fr.h }, fr.w)
    }
    let s = toPng(fr)
    if (L.cropTransparent) s = s.trim()
    const file = `${L.name}.png`
    const info = await s.toFile(path.join(dir, file))
    layers.push({ name: L.name, file, w: info.width, h: info.height, parallax: L.parallax, y: L.y, repeat: !!L.repeat, ...(L.x != null ? { x: L.x } : {}) })
  }
  for (const P of spec.props || []) {
    const fr = extract(img, P.rect)
    const m = keyMask(fr, [key, ...(P.extraKeys || []).map(hexToRGB)], spec.tolerance ?? 10)
    applyMask(fr, m, { x: 0, y: 0, w: fr.w, h: fr.h }, fr.w)
    const file = `props/${P.name}.png`
    const info = await toPng(fr).trim().toFile(path.join(dir, file))
    props.push({ name: P.name, file, w: info.width, h: info.height, x: P.x, y: P.y, parallax: P.parallax ?? 1 })
  }
  const out = { id, source: spec.source, reference: spec.reference, pixelScale: 1, floorY: 0, screen: { w: 384, h: 224 }, key: rgbToHex(key), layers, props, notes: spec.notes || [] }
  writeFileSync(path.join(dir, 'stage.json'), JSON.stringify(out, null, 1))
  console.log('  ' + layers.map((l) => `${l.name} ${l.w}x${l.h} p=${l.parallax} y=${l.y}`).join(' | '))
  console.log('  props: ' + props.map((p) => `${p.name} ${p.w}x${p.h}`).join(', '))

  // preview: stack the layers the way the game would, at parallax 0 (fighters mid-screen)
  if (spec.preview) {
    const W = spec.preview.w, H = spec.preview.h, floor = spec.preview.floorY
    const comp = []
    for (const l of layers) {
      const buf = await sharp(path.join(dir, l.file)).toBuffer()
      const top = floor + l.y - l.h
      const left = l.x ?? 0
      comp.push({ input: buf, left, top })
    }
    for (const p of props) {
      const buf = await sharp(path.join(dir, p.file)).toBuffer()
      comp.push({ input: buf, left: p.x, top: floor + p.y - p.h })
    }
    mkdirSync(SHOTS, { recursive: true })
    await sharp({ create: { width: W, height: H, channels: 4, background: '#000' } }).composite(comp).png().toFile(path.join(SHOTS, `rip-stage-${id}.png`))
  }
}

// ---------------------------------------------------------------------------------------------
// fx — hit sparks: components on the fx sheet, rows mapped like a character but anchored at centre
// ---------------------------------------------------------------------------------------------

async function ripFx(id, spec) {
  console.log(`[fx] ${id}`)
  const { img, mask, label, rows } = await detectSheet(spec, id)
  if (DEBUG) await debugRows(img, rows, id)
  const frames = {}, anims = {}, items = []
  for (const rs of spec.rows) {
    const row = rows[rs.row]
    if (!row) { console.warn(`  ! fx row ${rs.row} missing`); continue }
    let boxes = row.boxes
    if (rs.from != null || rs.to != null) boxes = boxes.slice(rs.from ?? 0, rs.to ?? boxes.length)
    if (rs.dropFrames) boxes = boxes.filter((_, i) => !rs.dropFrames.includes(i))
    const names = []
    boxes.forEach((b, i) => {
      const name = `${rs.anim}-${i}`
      const fr = extract(img, b)
      applyMask(fr, mask, b, img.w, label)
      const ax = Math.round(b.w / 2), ay = Math.round(b.h / 2)
      frames[name] = { x: 0, y: 0, w: b.w, h: b.h, ax, ay, sheet: { x: b.x, y: b.y } }
      items.push({ name, img: fr, w: b.w, h: b.h, ax, ay })
      names.push(name)
    })
    anims[rs.anim] = { frames: names, fps: rs.fps || 20, loop: !!rs.loop, pingpong: !!rs.pingpong }
    if (rs.alias) for (const a of rs.alias) anims[a] = { ...anims[rs.anim], frames: [...names] }
  }
  const size = shelfPack(items, 1024, 2)
  for (const it of items) { frames[it.name].x = it.px; frames[it.name].y = it.py }
  const dir = path.join(OUT, 'fx')
  mkdirSync(dir, { recursive: true })
  await (await composeAtlas(items, size)).toFile(path.join(dir, `${id}.png`))
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, source: spec.source, pixelScale: 1, atlas: `${id}.png`, atlasSize: size, anchor: 'ax,ay = spark centre', frames, anims, notes: spec.notes || [] }, null, 1))
  mkdirSync(SHOTS, { recursive: true })
  await contactSheet(items, path.join(SHOTS, `rip-fx-${id}.png`), { scale: 2 })
  console.log(`  ${items.length} frames, atlas ${size.w}x${size.h}: ` + Object.entries(anims).map(([a, an]) => `${a}:${an.frames.length}`).join(' '))
}

// ---------------------------------------------------------------------------------------------

const jobs = []
// Characters are not in the default set on purpose: scripts/rom-sprites.mjs owns those files now.
for (const [id, spec] of Object.entries(MANIFEST.chars || {})) jobs.push({ id, kind: 'char', spec, optIn: true })
for (const [id, spec] of Object.entries(MANIFEST.stages || {})) jobs.push({ id, kind: 'stage', spec })
for (const [id, spec] of Object.entries(MANIFEST.fx || {})) jobs.push({ id, kind: 'fx', spec })
const run = wanted.length ? jobs.filter((j) => wanted.includes(j.id)) : jobs.filter((j) => !j.optIn)
if (!run.length) { console.error(`nothing matched ${wanted.join(' ')}; ids: ${jobs.map((j) => j.id).join(' ')}`); process.exit(1) }
for (const j of run) {
  if (j.kind === 'char') await ripCharacter(j.id, j.spec)
  else if (j.kind === 'stage') await ripStage(j.id, j.spec)
  else await ripFx(j.id, j.spec)
}
