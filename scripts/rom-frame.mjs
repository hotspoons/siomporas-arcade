#!/usr/bin/env node
// Draw one frame's sprite list from one graphics ROM, and see whether it matches what the board
// drew. This is the test a new board has to pass before anything else is worth trying.
//
//   tools/sf2-probe/run.sh dumpvideo.lua ssf2tad            # PROBE_REGION=:gfx PROBE_TAG=ssf2t
//   tools/sf2-probe/run.sh dumpobj.lua  ssf2tad             # PROBE_SHARES=:objram1 PROBE_TAG=ssf2t
//   node scripts/rom-frame.mjs ssf2t --size 384x224
//   # then compare shots/rom-frame-ssf2t.png with MAME's own snapshot of the same frame
//
// The two dumps are deterministic: run both scripts with the same PROBE_SHOT_AT and they describe
// the same instant. If the picture this draws is the same as the emulator's, then the tile format,
// the palette, the block layout and the flips are all understood, and a full extraction — which
// needs the animation records as well, and those are a per-game job — is only bookkeeping away.
//
// What it assumes is the Capcom arrangement, which is more common than it has any right to be: a
// 16x16 tile of 128 bytes, four bitplanes per eight pixels, one byte per plane, most significant
// bit leftmost, colour 15 transparent; sprite records of x, y, tile code and attributes, where the
// attributes hold the palette in the low five bits, the two flips above that, and the block size in
// the top byte. CPS1 and CPS2 differ only in where the list lives and how many bits of x and y are
// position rather than flags — dumpobj.lua works that out for itself.

import sharp from 'sharp'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GFX = path.join(ROOT, 'ext/reference-artwork/rom-dumps/gfx')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const tag = argv.find((a) => !a.startsWith('--')) ?? 'ssf2t'
const [W, H] = flag('size', '384x224').split('x').map(Number)
// Screen position of a sprite at x=0, y=0. Capcom's boards put the visible area at (64, 16).
const [OX, OY] = flag('origin', '-64,-16').split(',').map(Number)
const scale = Number(flag('scale', '2'))

const gfxFile = path.join(GFX, `${tag}.bin`)
const objFile = path.join(GFX, `obj-${tag}.json`)
for (const f of [gfxFile, objFile]) {
  if (existsSync(f)) continue
  console.error(`missing ${path.relative(ROOT, f)} — see the header of this file for the two dumps it needs`)
  process.exit(1)
}
const gfx = readFileSync(gfxFile)
const dump = JSON.parse(readFileSync(objFile, 'utf8'))

const tile = new Uint8Array(256)
function tilePixels(code) {
  const base = (code * 128) % gfx.length
  for (let y = 0; y < 16; y++) {
    const row = base + y * 8
    for (let half = 0; half < 2; half++) {
      const b0 = gfx[row + half * 4], b1 = gfx[row + half * 4 + 1], b2 = gfx[row + half * 4 + 2], b3 = gfx[row + half * 4 + 3]
      for (let i = 0; i < 8; i++) {
        const bit = 7 - i
        tile[y * 16 + half * 8 + i] =
          ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2) | (((b3 >> bit) & 1) << 3)
      }
    }
  }
}

const out = Buffer.alloc(W * H * 4)
let tiles = 0
for (const o of dump.objs) {
  const palette = o.attr & 0x1f
  const flipX = (o.attr & 0x20) !== 0
  const flipY = (o.attr & 0x40) !== 0
  const w = ((o.attr >> 8) & 0x0f) + 1
  const h = ((o.attr >> 12) & 0x0f) + 1
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      tilePixels((o.code + ty * 16 + tx) & 0xffff)
      const px = o.x + OX + (flipX ? w - 1 - tx : tx) * 16
      const py = o.y + OY + (flipY ? h - 1 - ty : ty) * 16
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const n = tile[y * 16 + x]
          if (n === 15) continue
          const sx = px + (flipX ? 15 - x : x)
          const sy = py + (flipY ? 15 - y : y)
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
          const c = dump.palette[palette * 16 + n] ?? 0
          const i = (sy * W + sx) * 4
          out[i] = (c >> 16) & 255
          out[i + 1] = (c >> 8) & 255
          out[i + 2] = c & 255
          out[i + 3] = 255
        }
      }
      tiles++
    }
  }
}

const file = path.join(ROOT, 'shots', `rom-frame-${tag}.png`)
await sharp(out, { raw: { width: W, height: H, channels: 4 } })
  .resize(W * scale, H * scale, { kernel: 'nearest' })
  .flatten({ background: '#101010' })
  .png()
  .toFile(file)
console.log(`${dump.game}\n  ${dump.objs.length} sprites (${dump.share} +${dump.base.toString(16)}), ${tiles} tiles -> ${path.relative(ROOT, file)}`)
