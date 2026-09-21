#!/usr/bin/env node
// Real catalog assets, end to end: flux.2-dev -> chroma key -> TRELLIS.2 -> finished .glb
// into apps/corridor/public/assets/, and the catalog entry pointed at it.
//
//   node probes/editor-assets.mjs                # all three
//   node probes/editor-assets.mjs watertower-01  # one
//   node probes/editor-assets.mjs --recon-only   # re-mesh the cut-outs already on disk
//
// This is deliberately NOT tools/assetgen/generate.mjs: that pipeline is driven by coast's
// assets.json and owned elsewhere. It does reuse `keyChroma` from it, because the two chroma tests
// in there are measured and re-deriving them would just be re-learning the same lessons.
//
// The prompt rules are assetgen's and they are load-bearing (see tools/assetgen/README.md):
// name the construction and the era rather than a place or a brand, give real metres, say what
// colour the thing is — a prompt that names no colour but names a green backdrop comes back green
// and the key then eats it — and ask for no ground shadow, because the key reads a black contact
// shadow as further from the backdrop than the subject is.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { keyChroma } from '../tools/assetgen/generate.mjs'
import { finish } from '../tools/assetgen/finish.mjs'

const FLUX = 'https://high-brine.richard-siomporas.basedweights.com/v1/images/generations'
const RECON = 'https://recon.richard-siomporas.basedweights.com'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WORK = process.env.CORRIDOR_ASSET_WORK ?? '/tmp/corridor-assets'
const DEST = path.join(ROOT, 'apps/corridor/public/assets')
const CATALOG = path.join(DEST, 'catalog.json')

const BACKDROP =
  'The entire background is one flat chroma-green screen, pure saturated green, evenly lit, nothing else in frame. ' +
  'No ground plane, no horizon, no cast shadow on the backdrop, no people, no vehicles, no text, no signage lettering, no watermark. ' +
  'The object itself contains no green anywhere. ' +
  // MEASURED, AND IT DOES NOT WORK — kept so nobody spends the generation again. The first water
  // tower came back with its legs running off the bottom edge (keyed bbox 645x999 of 1024), so
  // TRELLIS invented the last few metres of them. This sentence names a margin SIZE and names the
  // bottom of the object explicitly, and the regeneration came back 436x996 of 1024: narrower, and
  // cropped at the bottom by exactly as much. flux.2-dev's framing prior for a tall subject is not
  // movable by words, which is the same class of failure tools/assetgen/README.md reports for
  // proportion — and the fix there was an ATTACHED REFERENCE, not a better sentence. It costs
  // nothing on wide subjects (the barn and the diner frame themselves correctly), so it stays.
  'The complete object from its very top to the very bottom where it meets the ground is well inside the frame, ' +
  'with at least 15 percent empty green margin above it, below it and on both sides. Nothing is cropped by any edge. ' +
  'Three-quarter view from about twenty degrees above the horizon, even soft daylight from the front, full object, sharp focus.'

const SPECS = [
  {
    id: 'watertower-01',
    prompt:
      'A single American municipal water tower standing alone: a spheroid steel tank about 12 metres across on four splayed steel lattice legs, ' +
      'overall height 38 metres, a narrow caged ladder up one leg and a slim railed catwalk around the tank. ' +
      'The tank is painted pale silver-grey with a white band; the legs and ladder are darker weathered grey steel with rust streaks at the joints. Riveted plate seams visible on the tank.',
  },
  {
    id: 'barn-01',
    prompt:
      'A single American gambrel-roof timber barn standing alone: 30 metres long, 14 metres deep, 11 metres to the ridge, two-slope gambrel roof, ' +
      'vertical board-and-batten siding, a large sliding door on the long side, a hay door high in the gable end, a small cupola on the ridge. ' +
      'The siding is weathered oxide-red paint going chalky; the roof is corrugated galvanised steel gone dull silver-grey; the stone foundation course is grey.',
  },
  // The two bridge assets are SPANS ONLY — no piers, no abutments, no ground. The viewer's
  // `bridge_over` puts the fitted model's base at road + clearance and builds its own concrete
  // abutments down to the ground (src/structures.ts::buildBridges), so a model that carried its
  // own supports would stand on them at deck height and float the whole bridge by their height.
  // Both are generated as WIDE subjects seen from the side at 3/4: the tall-subject crop (see the
  // BACKDROP note) does not bite on a wide one, and `fit: "span"` in the catalog scales the long
  // axis, so what matters is the long axis being complete in frame.
  {
    id: 'horsebridge-01',
    // v1 said "box-truss bridleway bridge, 22 × 3.5 × 4.5 m" and came back as a 1.5:1 open-sided
    // pavilion on legs — the metres did not move the proportion (assetgen's finding again). v2
    // leans on the one prior that IS long and narrow, "a classic American covered bridge", and
    // says the ratio in words as well as metres.
    prompt:
      'A single classic American covered bridge span standing alone, seen from the side at a three-quarter angle: a very long, narrow timber tunnel, ' +
      '22 metres long but only 3.5 metres wide and 4.5 metres tall — six times longer than it is tall — with a shallow gable roof running its full length, ' +
      'both ends open so you can see straight through it, vertical board-and-batten siding along both long sides, a plank deck, heavy timber corner posts. It carries a bridle path for horses. ' +
      'The span alone: no piers, no abutments, no legs, no supports, no ground under it, cut cleanly at both ends. ' +
      'The siding is dark chocolate brown stained wood weathered nearly black; the roof is dull grey corrugated steel; the deck planks are grey-brown.',
  },
  {
    id: 'overpass-01',
    prompt:
      'A single highway overpass bridge span standing alone, seen from the side at a three-quarter angle: a modern prestressed concrete girder bridge deck 30 metres long and 12 metres wide, 2.6 metres deep, ' +
      'four deep concrete I-girders under a flat deck, a low concrete parapet wall along each edge, straight and level. The span alone: no piers, no abutments, no columns, no ground under it, cut cleanly at both ends. ' +
      'The concrete is pale warm grey with darker weathering streaks under the deck edge; the parapet is lighter grey.',
  },
  {
    id: 'diner-01',
    prompt:
      'A single 1950s American roadside diner building standing alone: a long low box 22 metres by 14 metres, 6 metres tall, ' +
      'brushed stainless-steel panelling with horizontal fluting, a band of large windows down the long side, a rounded corner entrance with a canopy, glass block at one end. ' +
      'The steel is bright warm silver, the window frames and the trim bands are deep cherry red, the low parapet is cream enamel.',
  },
]

const CHROMA = { key: 'green', word: 'green', dominance: '(u.g-max(u.r,u.b))', despill: ['-channel', 'G', '-fx', 'min(u.g,(u.r+u.b)/2)'] }

const curl = (args, { binary = false } = {}) =>
  execFileSync('curl', ['-sk', '--max-time', '900', ...args], { maxBuffer: 1 << 28, encoding: binary ? 'buffer' : 'utf8' })

function generate(spec, dir) {
  const raw = path.join(dir, 'raw.png')
  if (existsSync(raw)) return raw
  const body = path.join(dir, 'request.json')
  writeFileSync(body, JSON.stringify({ model: 'flux.2-dev', prompt: `${spec.prompt} ${BACKDROP}`, size: '1024x1024', response_format: 'b64_json' }))
  console.log(`  flux    ${spec.id} (${spec.prompt.length + BACKDROP.length} chars)`)
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
  for (let i = 0; i < 200; i++) {
    execFileSync('sleep', ['4'])
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
const reconOnly = args.includes('--recon-only')
const wanted = args.filter((a) => !a.startsWith('--'))
const chosen = wanted.length ? SPECS.filter((s) => wanted.includes(s.id)) : SPECS

mkdirSync(WORK, { recursive: true })
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
for (const spec of chosen) {
  const dir = path.join(WORK, spec.id)
  mkdirSync(dir, { recursive: true })
  console.log(`=== ${spec.id}`)
  try {
    const raw = reconOnly ? path.join(dir, 'raw.png') : generate(spec, dir)
    const cut = path.join(dir, 'cut.png')
    const { ink, bbox } = keyChroma(raw, cut, CHROMA)
    console.log(`  key     ${ink.toFixed(1)}% opaque, bbox ${bbox}`)
    // Under ~4% opaque the key ate the subject (it came back green); over ~92% it kept the
    // backdrop. Either way the reconstruction would be of the wrong thing, so stop and look.
    if (ink < 4 || ink > 92) throw new Error(`cut-out is ${ink.toFixed(1)}% opaque — look at ${cut} before spending a reconstruction`)
    const glb = reconstruct(cut, path.join(dir, 'recon.glb'))
    // NOT unlit, unlike coast: the corridor renders these in a lit scene with seasonal light, so a
    // material that ignores the sun would sit in the world without belonging to it.
    const out = path.join(DEST, `${spec.id}.glb`)
    finish(glb, out, { unlit: false })
    const mb = readFileSync(out).length / 2 ** 20
    console.log(`  done    ${out} (${mb.toFixed(2)} MB)`)
    const entry = catalog.assets.find((a) => a.id === spec.id)
    if (entry) entry.glb = `assets/${spec.id}.glb`
  } catch (e) {
    console.error(`  FAILED  ${spec.id}: ${e.message}`)
  }
}
writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 1)}\n`)
console.log(`catalog: ${catalog.assets.filter((a) => a.glb).length}/${catalog.assets.length} entries have a model`)
