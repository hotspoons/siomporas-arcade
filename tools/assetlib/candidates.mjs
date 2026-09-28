#!/usr/bin/env node
// Draw one spec several times so a human can pick the good one.
//
//   node tools/assetlib/candidates.mjs --id civic-eg --n 6
//   node tools/assetlib/candidates.mjs --class hero-car --n 4     # the whole roster
//
// WHY SEED SELECTION IS THE MAIN QUALITY LEVER NOW. Once the glazing holes are closed
// (fillholes.mjs), what is left is not a reconstruction problem — it is what flux drew. The first
// civic-eg came back wearing an invented roof-rack contraption, and TRELLIS reproduced it
// faithfully, because a reconstruction can only be as good as its one view. Re-rolling the seed
// costs ten seconds; re-engineering the prompt costs an afternoon and often moves a different
// thing. Draw four, keep one, pin the seed.
//
// The seed then belongs IN THE SPEC. Two generations from one prompt are two different cars, so
// the seed that produced the accepted car is the only thing that makes it reproducible later.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { buildPrompt } from './style.mjs'
import { loadSpecs } from './build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..')
const DIR = path.join(LIB, 'candidates')

let dispatcher
try {
  const { Agent } = await import('undici')
  dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { rejectUnauthorized: false } })
} catch { /* the cert on the public host does not chain here; see build.mjs */ }

const FLUX_HOST = process.env.FLUX_HOST || 'https://high-brine.richard-siomporas.basedweights.com'
const FLUX_MODEL = process.env.FLUX_MODEL || 'flux.2-dev'

export async function draw(prompt, out, { steps = 28, seed = 1, size = '1024x1024', negative = '', trueCfg = 4 } = {}) {
  const res = await fetch(`${FLUX_HOST}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, dispatcher,
    body: JSON.stringify({ model: FLUX_MODEL, prompt, size, num_inference_steps: steps, seed, response_format: 'b64_json',
      ...(negative ? { negative_prompt: negative, true_cfg_scale: trueCfg } : {}) }),
  })
  if (!res.ok) throw new Error(`flux ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  if (!j?.data?.[0]?.b64_json) throw new Error('flux returned no image')
  writeFileSync(out, Buffer.from(j.data[0].b64_json, 'base64'))
}

const argv = process.argv.slice(2)
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const id = flag('id'), klass = flag('class'), n = Number(flag('n', 4))
const specs = loadSpecs().filter((s) => (id ? s.id === id : klass ? s.class === klass : false))
if (!specs.length) { console.error('pass --id or --class'); process.exit(1) }

mkdirSync(DIR, { recursive: true })
// Seed 1 is what an unpinned spec already used, so it is always in the set and never redrawn.
const seeds = Array.from({ length: n }, (_, i) => [1, 4, 7, 11, 17, 23, 29, 37][i] ?? i * 13 + 3)
for (const spec of specs) {
  const { prompt, negative } = buildPrompt(spec, { view: spec.view })
  for (const seed of seeds) {
    const out = path.join(DIR, `${spec.id}-s${seed}.png`)
    if (existsSync(out) && !argv.includes('--redo')) { console.log(`${spec.id} s${seed}  (have)`); continue }
    const t0 = Date.now()
    try {
      await draw(prompt, out, { seed, negative, steps: Number(flag('steps', 28)) })
      console.log(`${spec.id} s${seed}  ${((Date.now() - t0) / 1000).toFixed(1)}s${spec.seed === seed ? '  <- pinned' : ''}`)
    } catch (e) { console.error(`${spec.id} s${seed}  FAILED: ${e.message}`) }
  }
}
