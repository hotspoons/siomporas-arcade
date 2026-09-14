#!/usr/bin/env node
// Draw the fighters out of the arcade board's own graphics ROM.
//
//   node scripts/rom-sprites.mjs ryu zangief blanka      # or no arguments for every character logged
//   node scripts/rom-sprites.mjs ryu --contact           # also a labelled contact sheet in shots/
//
// This is the other half of tools/sf2-probe. That harness measured what the moves *do*; this one
// takes what they *look like*, from the same source and in the same pass, so a frame of animation
// and the frame data that goes with it can never drift apart.
//
// WHERE THE PIXELS COME FROM. `ext/reference-artwork/rom-dumps/gfx/gfx.bin` is the board's whole
// 6 MB graphics region, dumped by tools/sf2-probe/lua/dumpgfx.lua — MAME has already stitched the
// twelve mask ROMs into one address space, so it is the bytes the hardware reads. The format is
// 16x16 tiles of 128 bytes: sixteen rows of eight bytes, each row two groups of four, and each
// group is eight pixels stored as four bitplanes, one byte per plane, most significant bit
// leftmost. Colour 15 is transparent. None of that is written down anywhere — it was read off a
// hexdump of one tile and then checked by drawing a whole frame and diffing it against MAME's own
// screenshot of the same frame.
//
// WHICH TILES. The game builds a sprite list every frame — 8-byte entries of x, y, tile code and
// attributes, at the page CPS-A register 0 points to — and the recorder logged the entries around
// each fighter along with the animation record they belonged to. So a pose is: its animation
// pointer, the handful of sprite entries that drew it, and the fighter's position that frame.
// Everything here is assembled from those three.
//
// THE ANCHOR falls out for free, and that is the real prize. The fighter's own coordinate is on the
// floor between their feet; every sprite is placed relative to the screen. Subtract one from the
// other and you have the offset from the feet to the top-left of the drawn pixels — the exact
// number the renderer needs so that stepping through an animation does not make the character
// wander. Cut from a sheet, that number has to be guessed from a baseline; here it is measured.
//
// NAMING. The frames are named after the moves they belong to, in the order the move plays them,
// taken from apps/fighter/research/rom/sf2ce/<char>.json — the same measurement that produced the
// character's frame data. Poses that belong to no move (idle, the walks, the jumps, and the
// reactions, which happen to the dummy rather than the attacker) are named from the test that was
// running when they appeared.

import sharp from 'sharp'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DUMPS = path.join(ROOT, 'ext/reference-artwork/rom-dumps')
const LOGS = path.join(DUMPS, 'sf2/sf2ceea')
const RESEARCH = path.join(ROOT, 'apps/fighter/research/rom/sf2ce')
const OUT = path.join(ROOT, 'apps/fighter/public/assets/crown/chars')
const SHOTS = path.join(ROOT, 'shots')

const argv = process.argv.slice(2)
const CONTACT = argv.includes('--contact')
const wanted = argv.filter((a) => !a.startsWith('--'))

// --- the board -------------------------------------------------------------------------------

const TILE = 128
const gfxPath = path.join(DUMPS, 'gfx/gfx.bin')
if (!existsSync(gfxPath)) {
  console.error(`no ${path.relative(ROOT, gfxPath)} — run: PROBE_SECONDS=60 tools/sf2-probe/run.sh dumpgfx.lua`)
  process.exit(1)
}
const gfx = readFileSync(gfxPath)

/** One 16x16 tile, as 256 palette indices. 15 is transparent. */
function tilePixels(code, into) {
  const base = (code * TILE) % gfx.length
  for (let y = 0; y < 16; y++) {
    const row = base + y * 8
    for (let half = 0; half < 2; half++) {
      const b0 = gfx[row + half * 4], b1 = gfx[row + half * 4 + 1], b2 = gfx[row + half * 4 + 2], b3 = gfx[row + half * 4 + 3]
      for (let i = 0; i < 8; i++) {
        const bit = 7 - i
        into[y * 16 + half * 8 + i] =
          ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2) | (((b3 >> bit) & 1) << 3)
      }
    }
  }
  return into
}

/** Screen position of a hardware sprite entry, and the block of tiles it stands for. */
function sprite(obj) {
  const [ox, oy, code, attr] = obj
  return {
    x: (ox & 0x1ff) - 64,
    y: (oy & 0x1ff) - 16,
    code,
    palette: attr & 0x1f,
    flipX: (attr & 0x20) !== 0,
    flipY: (attr & 0x40) !== 0,
    w: ((attr >> 8) & 0x0f) + 1,
    h: ((attr >> 12) & 0x0f) + 1,
  }
}

// --- mining the log --------------------------------------------------------------------------

/**
 * Every distinct animation record the character wore, with the sprites that drew it. Keyed by side
 * and animation pointer, because the same record can turn up in twenty tests and only needs
 * drawing once. `order` remembers, per test, the sequence the records appeared in — that is what
 * names the frames of the animations the frame data does not cover.
 */
async function minePoses(file) {
  if (!existsSync(file)) throw new Error(`no log: ${path.relative(ROOT, file)}`)
  const poses = new Map()
  const order = new Map() // "side|testbase" -> [anim, ...] first appearance order
  const rl = createInterface({ input: createReadStream(file) })
  let frames = 0
  for await (const line of rl) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    frames++
    const base = d.test.split('__')[0]
    const variant = d.test.split('__')[1] ?? ''
    for (const side of ['p1', 'p2']) {
      const p = d[side]
      if (!p?.obj?.length) continue
      const key = `${side}:${p.an}`
      if (!poses.has(key)) {
        poses.set(key, { key, side, an: p.an, objs: p.obj, x: p.x, y: p.y, fl: p.fl, st: p.st, scr: d.scr, test: base, variant, seen: 1 })
      } else poses.get(key).seen++
      const okey = `${side}|${base}|${variant}`
      let seq = order.get(okey)
      if (!seq) order.set(okey, (seq = []))
      // Runs of the same record are collapsed, keeping how long it was held: that is what tells a
      // pose that is part of a loop from one that flashes past.
      const last = seq[seq.length - 1]
      if (last?.an === p.an) last.n++
      else seq.push({ an: p.an, st: p.st, in: (side === 'p1' ? d.in1 : d.in2) ?? '', n: 1 })
    }
  }
  return { poses, order, frames }
}

/**
 * Which palette slot is the fighter's own. The sprite list around a fighter also holds the shadow,
 * the life bars and whatever the stage has near them, so the one to keep is the palette that covers
 * the most pixels close to the fighter's own position.
 */
function fighterPalette(poses, side) {
  const score = new Map()
  for (const p of poses.values()) {
    if (p.side !== side) continue
    const fx = p.x - (p.scr ?? 0)
    for (const obj of p.objs) {
      const s = sprite(obj)
      const area = s.w * s.h
      const near = Math.abs(s.x - fx) < 200 && s.y > 40
      if (!near) continue
      score.set(s.palette, (score.get(s.palette) ?? 0) + area * p.seen)
    }
  }
  return [...score].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
}

// --- drawing ---------------------------------------------------------------------------------

const CANVAS = 384       // room for the widest pose either side of the fighter
const ORIGIN_X = 192
const ORIGIN_Y = 288     // the feet; poses reach further up than down

/**
 * One pose, drawn in the fighter's own space: the origin is the point the game calls the fighter's
 * position — the floor between the feet — and the image is trimmed to whatever pixels exist.
 * Sprites always come out facing right; the game mirrors them.
 */
function drawPose(pose, palette, colours16, screenLeft) {
  const buf = new Uint8Array(CANVAS * CANVAS * 4)
  const tile = new Uint8Array(256)
  const fx = pose.x - screenLeft
  const fy = 239 - pose.y          // the screen row the fighter is standing on
  let used = 0
  for (const obj of pose.objs) {
    const s = sprite(obj)
    if (s.palette !== palette) continue
    used++
    for (let ty = 0; ty < s.h; ty++) {
      for (let tx = 0; tx < s.w; tx++) {
        // Blocks are laid out in rows of sixteen codes, and a flipped block is laid out backwards.
        tilePixels((s.code + ty * 16 + tx) & 0xffff, tile)
        const px = s.x + (s.flipX ? s.w - 1 - tx : tx) * 16
        const py = s.y + (s.flipY ? s.h - 1 - ty : ty) * 16
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const n = tile[y * 16 + x]
            if (n === 15) continue
            const sx = px + (s.flipX ? 15 - x : x)
            const sy = py + (s.flipY ? 15 - y : y)
            const lx = ORIGIN_X + sx - fx
            const ly = ORIGIN_Y + sy - fy
            if (lx < 0 || ly < 0 || lx >= CANVAS || ly >= CANVAS) continue
            // Always the character's own sixteen colours: a pose recorded while it was player two
            // was drawn in the second player's scheme, and the pixel indices mean the same thing in
            // both, so swapping the table puts every frame in one costume.
            const c = colours16[n] ?? 0
            const i = (ly * CANVAS + lx) * 4
            buf[i] = (c >> 16) & 255
            buf[i + 1] = (c >> 8) & 255
            buf[i + 2] = c & 255
            buf[i + 3] = 255
          }
        }
      }
    }
  }
  if (!used) return null

  // Trim, then measure the anchor back from the origin.
  let x0 = CANVAS, y0 = CANVAS, x1 = -1, y1 = -1
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      if (!buf[(y * CANVAS + x) * 4 + 3]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const out = Buffer.alloc(w * h * 4)
  const facingLeft = pose.fl === 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = facingLeft ? x1 - x : x0 + x
      const s = ((y0 + y) * CANVAS + sx) * 4
      const d = (y * w + x) * 4
      out[d] = buf[s]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + 2]; out[d + 3] = buf[s + 3]
    }
  }
  const ax = facingLeft ? x1 - ORIGIN_X : ORIGIN_X - x0
  return { data: out, w, h, ax, ay: ORIGIN_Y - y0, tiles: used }
}

// --- naming ------------------------------------------------------------------------------------

/** Ordered animation pointers per move, from the frame data measured out of the same ROM. */
function movesOf(char) {
  const file = path.join(RESEARCH, `${char}.json`)
  if (!existsSync(file)) return new Map()
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const out = new Map()
  const add = (id, rom) => {
    if (!rom?.frames?.length) return
    const seq = []
    for (const f of rom.frames) if (f.anim && seq[seq.length - 1] !== f.anim) seq.push(f.anim)
    // The first record of every move is the neutral pose the input was accepted on, which belongs
    // to the idle animation and not to the move.
    if (seq.length > 1) seq.shift()
    if (seq.length) out.set(id, seq)
  }
  for (const [id, m] of Object.entries(j.normals ?? {})) add(id, m.rom)
  for (const s of j.specials ?? []) {
    add(s.id, s.rom)
    for (const [k, v] of Object.entries(s.strengths ?? {})) add(`${s.id}-${k}`, v.rom)
  }
  return out
}

/** Tests whose animations are the character being themselves rather than attacking. */
const CALIB = {
  'calib-idle': { name: 'idle', keep: (e) => e.st === 0 && !e.in },
  'calib-walkfwd': { name: 'walk-fwd', keep: (e) => e.st === 0 && e.in.includes('right') },
  'calib-walkback': { name: 'walk-back', keep: (e) => e.st === 0 && e.in.includes('left') },
  'calib-crouch': { name: 'crouch', keep: (e) => e.st === 2 },
  'calib-jumpn': { name: 'jump-neutral', keep: (e) => e.st === 4 },
  'calib-jumpf': { name: 'jump-fwd', keep: (e) => e.st === 4 },
  'calib-jumpb': { name: 'jump-back', keep: (e) => e.st === 4 },
  'calib-landjab': { name: 'land', keep: (e) => e.st === 6 },
}

/**
 * What is happening to the dummy, in the order the names are claimed. A record can serve more than
 * one of these — a flinch is the first pose of the dizzy stagger — so the plain ones come first and
 * the long ones take what is left.
 *
 * `guard` also accepts the guard stance the game enters before the blow lands, which is the pose we
 * want to hold while a player blocks. `crouching` insists the dummy was ducking when it was hit.
 * The sweep's reaction runs from the fall through lying on the floor to standing up again, so it
 * becomes `knockdown` and the renderer falls back to it for `down` and `getup`.
 */
const REACTIONS = [
  { name: 'hit-high', variant: 'hit', cap: 4 },
  { name: 'hit-crouch', variant: 'chit', cap: 4, crouching: true },
  { name: 'block-stand', variant: 'block', cap: 4, guard: true },
  { name: 'block-crouch', variant: 'cblock', cap: 4, guard: true, crouching: true },
  { name: 'knockdown', base: 'crouch-hk', variant: 'hit' },
  { name: 'thrown', base: 'throw-fwd', variant: 'hit' },
  { name: 'dizzy', base: 'dizzy', variant: 'hit', longest: true, fps: 6 },
]
/** States a fighter is in while something is being done to it: hurt, thrown, and holding a guard. */
const HURT = [0x0e, 0x14]
const GUARD = 0x08

/** Every unbroken run of a fighter being hurt in one test, in the order they happened. */
function reactionRuns(seq, { crouching, guard }) {
  const states = guard ? [...HURT, GUARD] : HURT
  const runs = []
  for (let i = 0; i < seq.length; i++) {
    if (!states.includes(seq[i].st)) continue
    const ok = !crouching || seq[i].in.includes('down') || seq[i - 1]?.st === 0x02 || seq[i - 1]?.in.includes('down')
    let to = i
    while (to < seq.length && states.includes(seq[to].st)) to++
    if (ok) runs.push(seq.slice(i, to))
    i = to
  }
  return runs
}

// --- per character ------------------------------------------------------------------------------

async function ripCharacter(char) {
  const t0 = Date.now()
  const { colours } = coloursFor(char)
  const own = await minePoses(path.join(LOGS, `${char}.jsonl`))
  // A character never flinches in its own recording — it is the one attacking. Its reactions come
  // from a run where it was the dummy: react-<char>.jsonl, or its own log when it was both.
  const reactFile = path.join(LOGS, `react-${char}.jsonl`)
  const react = existsSync(reactFile) ? await minePoses(reactFile) : own
  const moves = movesOf(char)
  const palOwn = fighterPalette(own.poses, 'p1')
  const palReact = fighterPalette(react.poses, 'p2')

  const anims = {}
  const drawn = new Map()   // pose key -> frame name
  const items = []
  const missing = []
  const claimedAn = new Set()

  const claim = (mine, name, an, side) => {
    const pose = mine.poses.get(`${side}:${an}`)
    if (!pose) return null
    if (drawn.has(pose.key)) return drawn.get(pose.key)
    const pic = drawPose(pose, side === 'p1' ? palOwn : palReact, colours, pose.scr ?? 0)
    if (!pic) return null
    drawn.set(pose.key, name)
    items.push({ name, ...pic, an, side })
    return name
  }

  const addAnim = (mine, anim, seq, side, fps) => {
    const names = []
    for (const an of seq) {
      const n = claim(mine, `${anim}-${names.length}`, an, side)
      if (n && !names.includes(n)) names.push(n)
    }
    if (!names.length) { missing.push(anim); return }
    for (const an of seq) claimedAn.add(an)
    anims[anim] = { frames: names, fps, loop: /^(idle|walk|dizzy)/.test(anim) }
  }

  /** The longest run of a test's animation records, keeping only the frames a filter accepts. */
  const seqFor = (mine, side, base, keep) => {
    let best = null
    for (const [key, seq] of mine.order) {
      const [s2, b2] = key.split('|')
      if (s2 !== side || b2 !== base) continue
      const kept = keep ? seq.filter(keep) : seq
      if (!best || kept.length > best.length) best = kept
    }
    return best?.map((e) => e.an) ?? null
  }

  // 1. the moves, in the order the frame data says they play
  for (const [id, seq] of moves) addAnim(own, id, seq, 'p1', 15)
  // 2. the character being itself
  for (const [test, { name, keep }] of Object.entries(CALIB)) {
    const seq = seqFor(own, 'p1', test, keep)
    if (seq?.length) addAnim(own, name, seq, 'p1', /walk|idle/.test(name) ? 12 : 15)
    else missing.push(name)
  }
  // 3. the throw, from the throwing end
  for (const base of ['throw-fwd-hp', 'throw-fwd-mp', 'throw-back-hp']) {
    if (anims.throw) break
    const seq = seqFor(own, 'p1', base, (e) => e.st !== 0)
    if (seq?.length) addAnim(own, 'throw', seq, 'p1', 10)
  }
  // 4. and everything that is done to it, which only its turn as the dummy can show
  const specific = REACTIONS.filter((r) => r.base).map((r) => r.base)
  for (const r of REACTIONS) {
    let best = null
    for (const [key, seq] of react.order) {
      const [side, b2, v2] = key.split('|')
      if (side !== 'p2' || v2 !== r.variant) continue
      if (r.base ? !b2.startsWith(r.base) : specific.some((c) => b2.startsWith(c))) continue
      const runs = reactionRuns(seq, r)
      if (!runs.length) continue
      if (!r.longest) { best = r.cap ? runs[0].slice(0, r.cap) : runs[0]; break }  // the first one that shows it
      for (const run of runs) if (!best || run.length > best.length) best = run
    }
    if (!best?.length) { missing.push(r.name); continue }
    if (r.longest) {
      // A stagger is the records held longest, not the flinch that started it — and never a record
      // some shorter reaction has already claimed.
      const held = new Map()
      for (const e of best) if (!claimedAn.has(e.an)) held.set(e.an, (held.get(e.an) ?? 0) + e.n)
      const top = new Set([...held].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([an]) => an))
      best = best.filter((e) => top.has(e.an))
    }
    addAnim(react, r.name, best.map((e) => e.an), 'p2', r.fps ?? 8)
  }

  if (!items.length) throw new Error(`${char}: nothing drawn`)
  // pack: shelves, tallest first
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w)
  const maxW = 2048
  let x = 1, y = 1, shelf = 0, width = 0
  for (const it of sorted) {
    if (x + it.w + 1 > maxW && x > 1) { x = 1; y += shelf + 1; shelf = 0 }
    it.px = x; it.py = y
    x += it.w + 1
    shelf = Math.max(shelf, it.h)
    width = Math.max(width, x)
  }
  const size = { w: width + 1, h: y + shelf + 2 }

  const dir = path.join(OUT, char)
  mkdirSync(dir, { recursive: true })
  await sharp({ create: { width: size.w, height: size.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(items.map((it) => ({ input: it.data, raw: { width: it.w, height: it.h, channels: 4 }, left: it.px, top: it.py })))
    .png().toFile(path.join(dir, 'atlas.png'))

  const framesJson = {}
  for (const it of items) framesJson[it.name] = { x: it.px, y: it.py, w: it.w, h: it.h, ax: it.ax, ay: it.ay, rom: { anim: it.an, side: it.side } }
  writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({
    id: char,
    source: `Street Fighter II: Champion Edition (sf2ceea) graphics ROM, via tools/sf2-probe`,
    pixelScale: 1,
    atlas: 'atlas.png',
    atlasSize: size,
    facing: 'right',
    anchor: 'ax, ay = the fighter position the board drew this pose around: the floor between the feet',
    palette: { own: palOwn, react: palReact, colours: colours.map((c) => '#' + c.toString(16).padStart(6, '0')) },
    frames: framesJson,
    anims,
    missing,
  }, null, 1))

  console.log(`${char}: ${own.frames + (react === own ? 0 : react.frames)} log frames -> ${items.length} sprites, atlas ${size.w}x${size.h}, ${Object.keys(anims).length} animations${missing.length ? `, missing ${missing.join(' ')}` : ''} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)

  if (CONTACT) await contactSheet(char, items, anims)
}

async function contactSheet(char, items, anims) {
  const order = []
  for (const a of Object.values(anims)) for (const f of a.frames) { const it = items.find((i) => i.name === f); if (it && !order.includes(it)) order.push(it) }
  const pad = 6, labelH = 12, maxW = 2000
  let x = pad, y = pad, rowH = 0, W = 0
  for (const it of order) {
    if (x + it.w + pad > maxW && x > pad) { x = pad; y += rowH + pad; rowH = 0 }
    it.cx = x; it.cy = y
    x += Math.max(it.w, 24) + pad
    rowH = Math.max(rowH, it.h + labelH)
    W = Math.max(W, x)
  }
  const H = y + rowH + pad
  const bg = Buffer.alloc(W * H * 4)
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const v = ((xx >> 3) + (yy >> 3)) & 1 ? 0x5a : 0x46
    const i = (yy * W + xx) * 4
    bg[i] = v; bg[i + 1] = v; bg[i + 2] = v; bg[i + 3] = 255
  }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
  const layers = []
  for (const it of order) {
    layers.push({ input: it.data, raw: { width: it.w, height: it.h, channels: 4 }, left: it.cx, top: it.cy + labelH })
    svg += `<text x="${it.cx}" y="${it.cy + 9}" font-family="monospace" font-size="9" fill="#fff">${it.name}</text>`
    const ay = it.cy + labelH + it.ay, ax = it.cx + it.ax
    svg += `<line x1="${it.cx}" x2="${it.cx + it.w}" y1="${ay}" y2="${ay}" stroke="#0f0" stroke-width="1"/>`
    svg += `<line x1="${ax}" x2="${ax}" y1="${it.cy + labelH}" y2="${it.cy + labelH + it.h}" stroke="#f0f" stroke-width="1"/>`
  }
  svg += '</svg>'
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 })
  mkdirSync(SHOTS, { recursive: true })
  await sharp(bg, { raw: { width: W, height: H, channels: 4 } }).composite(layers).png().toFile(path.join(SHOTS, `rom-${char}.png`))
}

// --- go ------------------------------------------------------------------------------------------

/**
 * A character's own sixteen colours, from a pose dumped while it was player one. The palette slot
 * is found the same way the fighter's sprites are: whichever palette covers the most of the
 * fighter's own position.
 */
function coloursFor(char) {
  for (const tag of [char, 'idle']) {
    const file = path.join(LOGS, `pose-${tag}.json`)
    if (!existsSync(file)) continue
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (tag !== 'idle' && j.players?.[0]?.char !== char) continue
    const fx = j.players[0].x - j.screenLeft
    const score = new Map()
    for (const o of j.objs) {
      const sp = sprite([o.x, o.y, o.code, o.attr])
      if (Math.abs(sp.x - fx) > 60 || sp.y < 60) continue
      score.set(sp.palette, (score.get(sp.palette) ?? 0) + sp.w * sp.h)
    }
    const slot = [...score].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (slot == null) continue
    return { slot, colours: j.palette.slice(slot * 16, slot * 16 + 16) }
  }
  throw new Error(`no palette for ${char}: run PROBE_STATE=match_${char}_... PROBE_TAG=${char} tools/sf2-probe/run.sh pose.lua`)
}

const chars = wanted.length ? wanted : ['ryu', 'zangief', 'blanka']
for (const c of chars) await ripCharacter(c)
