#!/usr/bin/env node
// The rock kit: boulders and ledge blocks per lithology, flux.2-dev -> chroma key -> TRELLIS.2 ->
// finished .glb into apps/corridor/public/assets/, and a `category: "rock"` catalog entry with
// `rock_type` so rocks.ts picks the set that matches a cut face's geology.
//
//   node probes/terrain-rockkit.mjs                 # every spec not yet on disk
//   node probes/terrain-rockkit.mjs shale           # one lithology
//   node probes/terrain-rockkit.mjs shale-boulder-01
//
// Same chain and the same prompt rules as probes/editor-assets.mjs (the editor agent's, which
// made the barn, diner, water tower and bridges): name the material and its real metres, say the
// colour (a colourless subject on a green backdrop comes back green and the key eats it), no
// ground shadow, no ground plane. A boulder is a WIDE subject, so flux's tall-subject crop does
// not bite. Assets are lit (unlit: false) like the other corridor props.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { keyChroma } from '../tools/assetgen/generate.mjs'
import { finish } from '../tools/assetgen/finish.mjs'

const FLUX = process.env.FLUX_URL ?? 'https://high-brine.richard-siomporas.basedweights.com/v1/images/generations'
const RECON = process.env.RECON_URL ?? 'https://recon.richard-siomporas.basedweights.com'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WORK = process.env.CORRIDOR_ASSET_WORK ?? '/tmp/claude-1000/-workspaces-apex-conduit/d80c2f1a-3a78-4555-bdcc-8e4f5d457599/scratchpad/rockkit'
const DEST = path.join(ROOT, 'apps/corridor/public/assets')
const CATALOG = path.join(DEST, 'catalog.json')

const BACKDROP =
  'The entire background is one flat chroma-green screen, pure saturated green, evenly lit, nothing else in frame. ' +
  'No ground plane, no horizon, no cast shadow on the backdrop, no people, no vehicles, no text, no watermark, no moss, no plants, nothing green on the rock itself. ' +
  'The whole rock is well inside the frame with empty green margin on every side. ' +
  'Three-quarter view from about twenty degrees above, even soft daylight from the front, sharp focus, photorealistic.'

// per lithology: the look (from the Macrostrat descriptions and the reference photos), then
// four shapes: two boulders, a ledge block, a talus slab
const LITHS = {
  shale: {
    look: 'thin-bedded grey shale and siltstone, medium grey to dark grey-brown, flat parallel bedding planes a few centimetres apart, splintery edges, rust-orange iron staining along some beds',
    footprint: [1.6, 1.2], height: 1.0,
  },
  sandstone: {
    look: 'thick-bedded tan and light grey sandstone, buff to pale brown, blocky with rounded weathered corners, faint cross-bedding lines, grey lichen patches',
    footprint: [1.8, 1.4], height: 1.2,
  },
  greenstone: {
    look: 'Catoctin metabasalt greenstone, dark grey-green to blue-grey, massive and blocky, blast-fractured angular faces, faint chloritic sheen, thin white quartz veins',
    footprint: [1.6, 1.3], height: 1.1,
  },
  schist: {
    look: 'muscovite schist, silvery grey with a mica glitter, wavy foliation planes, slabby, splitting into plates, brown weathering rind on old faces',
    footprint: [1.7, 1.2], height: 1.0,
  },
  phyllite: {
    look: 'slaty phyllite, silver-grey to blue-grey with a satin sheen, thin plates splitting parallel, sharp edges, light rust streaks',
    footprint: [1.5, 1.1], height: 0.9,
  },
}
const SHAPES = [
  ['boulder-01', 'A single large weathered boulder of {look}, about 1.6 metres wide and 1 metre tall, rounded-blocky, resting on nothing.'],
  ['boulder-02', 'A single angular fractured boulder of {look}, about 1.3 metres wide and 1.1 metres tall, sharp-cornered, resting on nothing.'],
  ['ledge-01', 'A single flat ledge block of {look}, about 2 metres wide, 1.4 metres deep and only 0.6 metres tall, a broken-off bench of bedrock with layered sides and a flat top, resting on nothing.'],
  ['talus-01', 'A single small heap of three or four broken slabs of {look} lying against each other, about 1.5 metres across and 0.7 metres tall, as found at the foot of a rock cut, resting on nothing.'],
]
const SPECS = []
for (const [lith, L] of Object.entries(LITHS)) {
  for (const [shape, tmpl] of SHAPES) {
    SPECS.push({ id: `${lith}-${shape}`, lith, prompt: tmpl.replace('{look}', L.look), footprint: L.footprint, height: shape.startsWith('ledge') ? 0.6 : shape.startsWith('talus') ? 0.7 : L.height })
  }
}

const CHROMA = { key: 'green', word: 'green', dominance: '(u.g-max(u.r,u.b))', despill: ['-channel', 'G', '-fx', 'min(u.g,(u.r+u.b)/2)'] }
const curl = (args, { binary = false } = {}) => execFileSync('curl', ['-sk', '--max-time', '900', ...args], { maxBuffer: 1 << 28, encoding: binary ? 'buffer' : 'utf8' })

function generate(spec, dir) {
  const raw = path.join(dir, 'raw.png')
  if (existsSync(raw)) return raw
  const body = path.join(dir, 'request.json')
  writeFileSync(body, JSON.stringify({ model: 'flux.2-dev', prompt: `${spec.prompt} ${BACKDROP}`, size: '1024x1024', response_format: 'b64_json' }))
  console.log(`  flux    ${spec.id}`)
  const out = JSON.parse(curl([FLUX, '-H', 'Content-Type: application/json', '--data-binary', `@${body}`]))
  const b64 = out?.data?.[0]?.b64_json
  if (!b64) throw new Error(`flux gave no image: ${JSON.stringify(out).slice(0, 300)}`)
  writeFileSync(raw, Buffer.from(b64, 'base64'))
  return raw
}

function reconstruct(cut, outGlb) {
  if (existsSync(outGlb)) return outGlb
  const started = JSON.parse(curl([`${RECON}/reconstruct`, '-F', `images=@${cut}`, '-F', 'seed=1']))
  if (!started.job) throw new Error(`recon refused: ${JSON.stringify(started).slice(0, 300)}`)
  console.log(`  recon   job ${started.job}`)
  for (let i = 0; i < 240; i++) {
    execFileSync('sleep', ['5'])
    const s = JSON.parse(curl([`${RECON}/jobs/${started.job}`]))
    if (s.state === 'failed') throw new Error(`recon failed: ${s.detail}`)
    if (s.state === 'done') {
      writeFileSync(outGlb, curl([`${RECON}${s.asset ?? `/jobs/${started.job}/asset`}`, '-o', '-'], { binary: true }))
      return outGlb
    }
  }
  throw new Error('recon timed out')
}

const args = process.argv.slice(2)
const wanted = args.filter((a) => !a.startsWith('--'))
const chosen = wanted.length ? SPECS.filter((s) => wanted.includes(s.id) || wanted.includes(s.lith)) : SPECS
mkdirSync(WORK, { recursive: true })
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
let made = 0
for (const spec of chosen) {
  const dest = path.join(DEST, `${spec.id}.glb`)
  const dir = path.join(WORK, spec.id)
  mkdirSync(dir, { recursive: true })
  console.log(`=== ${spec.id}`)
  try {
    if (!existsSync(dest)) {
      const raw = generate(spec, dir)
      const cut = path.join(dir, 'cut.png')
      const { ink, bbox } = keyChroma(raw, cut, CHROMA)
      console.log(`  key     ${ink.toFixed(1)}% opaque, bbox ${bbox}`)
      if (ink < 4 || ink > 92) throw new Error(`cut-out is ${ink.toFixed(1)}% opaque — look at ${cut}`)
      const glb = reconstruct(cut, path.join(dir, 'recon.glb'))
      // rocks are small and many: 8k faces and a 512 px texture each
      finish(glb, dest, { unlit: false, ratio: 0.02, texture: 512 })
      console.log(`  done    ${dest} (${(readFileSync(dest).length / 2 ** 20).toFixed(2)} MB)`)
      made++
    }
    // the catalog entry (append only; an existing entry keeps its yaw_offset)
    let entry = catalog.assets.find((a) => a.id === spec.id)
    if (!entry) {
      entry = { id: spec.id, name: `${spec.lith} ${spec.id.split('-').slice(1).join(' ')}`, category: 'rock', rock_type: spec.lith, footprint_m: spec.footprint, height_m: spec.height }
      catalog.assets.push(entry)
    }
    entry.glb = `assets/${spec.id}.glb`
    writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 1)}\n`)
  } catch (e) {
    console.error(`  FAILED  ${spec.id}: ${e.message}`)
  }
}
console.log(`rock kit: ${made} new; ${catalog.assets.filter((a) => a.category === 'rock' && a.glb).length} rock entries with a model`)
