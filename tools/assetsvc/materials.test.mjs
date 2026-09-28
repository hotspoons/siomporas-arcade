// Does a generated texture actually tile, and does a regeneration leave the old one alone?
//
// Both are properties nobody can see by looking at one image. A seam shows on a wall, at run time,
// a week later; and "it did not blow away the old copy" is a claim about a directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { commitDraft, discardDraft, generateDraft, readDraft, texturePrompt } from './materials.mjs'

/** A "model" that returns a deterministic, deliberately NOT tileable image. */
const noisy = {
  id: 'test-model',
  async generate({ size = '256x256' }) {
    const w = Number(size.split('x')[0])
    const px = Buffer.alloc(w * w * 3)
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3
        // a strong gradient: the left edge is black and the right edge white, so the tile's own
        // seam is as bad as it can be
        px[i] = px[i + 1] = px[i + 2] = Math.round((x / (w - 1)) * 255)
      }
    }
    return { png: await sharp(px, { raw: { width: w, height: w, channels: 3 } }).png().toBuffer(), seconds: 0, meta: { seed: 7 } }
  },
}

const home = async () => mkdtemp(path.join(tmpdir(), 'mats-'))

test('the prompt carries the rules that make it a texture, not just what was typed', () => {
  const p = texturePrompt('red brick wall', 2)
  assert.match(p, /red brick wall/)
  assert.match(p, /straight down/)
  assert.match(p, /2 metre square/)
})

test('THE SEAM IS BLENDED: opposite edges of the albedo match', async () => {
  const dir = await home()
  await generateDraft({ dir, id: 'brick', subject: 'x', metresPerTile: 2, size: '256x256', model: noisy })
  const raw = await sharp(path.join(dir, 'brick', 'draft', 'albedo.jpg')).removeAlpha().raw().toBuffer()
  const w = 256
  let worst = 0
  for (let y = 0; y < w; y++) {
    const left = raw[(y * w + 0) * 3]
    const right = raw[(y * w + (w - 1)) * 3]
    worst = Math.max(worst, Math.abs(left - right))
  }
  // the input was a full black-to-white ramp, so untiled this is ~255
  assert.ok(worst < 40, `opposite edges differ by ${worst}`)
})

/** A near-flat surface with fine grain — what a real texture looks like to the normal derivation. */
const grainy = {
  id: 'test-grain',
  async generate({ size = '256x256' }) {
    const w = Number(size.split('x')[0])
    const px = Buffer.alloc(w * w * 3)
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3
        const v = 128 + ((x * 7 + y * 13) % 11) - 5
        px[i] = px[i + 1] = px[i + 2] = v
      }
    }
    return { png: await sharp(px, { raw: { width: w, height: w, channels: 3 } }).png().toBuffer(), seconds: 0, meta: { seed: 7 } }
  },
}

test('the maps that came out are the three a material needs', async () => {
  const dir = await home()
  const out = await generateDraft({ dir, id: 'brick', subject: 'x', metresPerTile: 2, size: '256x256', model: grainy })
  assert.deepEqual(out.files, ['albedo.jpg', 'normal.png', 'roughness.jpg'])
  const normal = await sharp(path.join(dir, 'brick', 'draft', 'normal.png')).raw().toBuffer({ resolveWithObject: true })
  assert.equal(normal.info.channels, 3)
  // a normal map over a near-flat surface is mostly "pointing up": blue high. A steep input
  // legitimately gives a sideways normal, which is why this asks it of a grainy tile and not of
  // the black-to-white ramp the seam test uses.
  let blue = 0
  for (let i = 2; i < normal.data.length; i += 3) blue += normal.data[i]
  assert.ok(blue / (normal.data.length / 3) > 180, 'the normal map is not mostly facing up')
})

test('A REGENERATION TOUCHES NOTHING LIVE until it is saved', async () => {
  const dir = await home()
  await mkdir(path.join(dir, 'brick'), { recursive: true })
  await writeFile(path.join(dir, 'brick', 'albedo.jpg'), 'THE ONE THAT IS IN USE')
  await generateDraft({ dir, id: 'brick', subject: 'x', metresPerTile: 2, size: '256x256', model: noisy })
  assert.equal(await readFile(path.join(dir, 'brick', 'albedo.jpg'), 'utf8'), 'THE ONE THAT IS IN USE')
  assert.ok((await readDraft(dir, 'brick'))?.prompt === 'x')

  // discarding leaves the live copy alone as well
  await discardDraft(dir, 'brick')
  assert.equal(await readFile(path.join(dir, 'brick', 'albedo.jpg'), 'utf8'), 'THE ONE THAT IS IN USE')
  assert.equal(await readDraft(dir, 'brick'), null)
})

test('saving swaps it in AND keeps what it replaced', async () => {
  const dir = await home()
  await mkdir(path.join(dir, 'brick'), { recursive: true })
  await writeFile(path.join(dir, 'brick', 'albedo.jpg'), 'THE OLD ONE')
  await generateDraft({ dir, id: 'brick', subject: 'x', metresPerTile: 2, size: '256x256', model: noisy })
  await commitDraft(dir, 'brick')
  const now = await readFile(path.join(dir, 'brick', 'albedo.jpg'))
  assert.notEqual(now.toString('utf8'), 'THE OLD ONE')
  // a regeneration that turns out worse than what it replaced is the normal case
  assert.equal(await readFile(path.join(dir, 'brick', 'previous', 'albedo.jpg'), 'utf8'), 'THE OLD ONE')
  assert.ok(!(await readdir(path.join(dir, 'brick'))).includes('draft'))
})

test('saving with no draft is refused rather than doing something arbitrary', async () => {
  const dir = await home()
  await mkdir(path.join(dir, 'brick'), { recursive: true })
  await assert.rejects(() => commitDraft(dir, 'brick'), /no draft/)
})
