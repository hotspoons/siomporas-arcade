#!/usr/bin/env node
// Bake the sprite atlas at build time, so the game never downloads a mesh.
//
//   just dev coast                       # the dev server has to be up; this drives it
//   node scripts/bake-atlas.mjs          # writes apps/coast/public/assets/atlas/*
//   node scripts/bake-atlas.mjs --check  # exits non-zero if what is on disk is stale (for CI)
//
// WHY THIS EXISTS. The roadside is reconstructions now, and the manifest is tens of megabytes of
// .glb that the game downloads, parses, renders into one texture and never looks at again. This
// does that once, here, and ships the texture.
//
// WHY IT DRIVES A BROWSER. The bake is `SpriteAtlas.bake` — a real WebGL render target, real
// lights, GLTFLoader, and canvas text on the signs. Reimplementing it in Node against a headless GL
// binding would be a second bake to keep in step with the first, and the cost of drift is sprites
// that are subtly wrong on exactly the devices that got the prebake. So: the same code, in
// Chromium, with the plan forced instead of chosen. Slow (software GL, minutes) and run by hand.
//
// WHICH PLANS. `atlasPlan` picks a size from the GPU cap, from device memory, and from `?atlas=N`.
// Every plan it can choose for the current manifest gets a file; anything else falls through to the
// runtime bake, which is still there and still correct.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const OUT = 'apps/coast/public/assets/atlas'
const URL_BASE = process.env.BAKE_URL ?? 'http://localhost:5182'

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}

/**
 * The plans worth baking, largest first. `atlasSizeFor` decides the size from the manifest at each
 * cell scale, so these are derived rather than guessed — ask the app itself.
 */
async function plansFrom(page) {
  return await page.evaluate(async () => {
    const { MODELS, atlasSizeFor } = await import('/src/render/models.ts')
    const out = []
    for (const cellScale of [1, 0.5, 0.25]) {
      const size = atlasSizeFor(MODELS, cellScale)
      if (!out.some((p) => p.size === size && p.cellScale === cellScale)) out.push({ size, cellScale })
    }
    return out
  })
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--max-old-space-size=4096'] })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [page]', m.text())
})

await page.goto(`${URL_BASE}/bake.html?size=1&cell=1`, { waitUntil: 'domcontentloaded' }).catch(() => {
  console.error(`no dev server at ${URL_BASE} — start it with: just dev coast`)
  process.exit(1)
})
const plans = flag('size') ? [{ size: Number(flag('size')), cellScale: Number(flag('cell', 1)) }] : await plansFrom(page)

mkdirSync(path.join(ROOT, OUT), { recursive: true })
const wanted = new Set()
let stale = 0

for (const plan of plans) {
  await page.goto(`${URL_BASE}/bake.html?size=${plan.size}&cell=${plan.cellScale}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__atlas || window.__atlasError, null, { timeout: 15 * 60 * 1000 })
  const err = await page.evaluate(() => window.__atlasError)
  if (err) {
    console.error(`${plan.size}x${plan.cellScale}: ${err}`)
    process.exitCode = 1
    continue
  }
  const { key, png, kinds, size, cellScale } = await page.evaluate(() => window.__atlas)
  wanted.add(`${key}.png`)
  wanted.add(`${key}.json`)

  const image = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64')
  const meta = `${JSON.stringify({ key, size, cellScale, kinds })}\n`
  const imgPath = path.join(ROOT, OUT, `${key}.png`)
  const metaPath = path.join(ROOT, OUT, `${key}.json`)

  const fresh = existsSync(imgPath) && existsSync(metaPath) && readFileSync(metaPath, 'utf8') === meta
  if (check) {
    if (!fresh) {
      stale++
      console.error(`stale: ${key} (${size}px ×${cellScale})`)
    }
    continue
  }
  writeFileSync(imgPath, image)
  writeFileSync(metaPath, meta)
  console.log(`${OUT}/${key}.png  ${size}px ×${cellScale}  ${(image.length / 1e6).toFixed(1)} MB, ${kinds.length} kinds`)
}

await browser.close()

if (check) {
  // A file nobody asked for is as wrong as a missing one: it means the manifest moved and the atlas
  // for the old one is still sitting there, ready to be served to whoever hashes to it.
  const orphans = readdirSync(path.join(ROOT, OUT)).filter((f) => !wanted.has(f))
  for (const f of orphans) console.error(`orphan: ${f}`)
  if (stale || orphans.length) {
    console.error('\nrun: node scripts/bake-atlas.mjs   (needs `just dev coast`)')
    process.exit(1)
  }
  console.log(`atlas up to date (${wanted.size / 2} plans)`)
} else {
  for (const f of readdirSync(path.join(ROOT, OUT))) {
    if (!wanted.has(f)) {
      rmSync(path.join(ROOT, OUT, f))
      console.log(`removed stale ${f}`)
    }
  }
}
