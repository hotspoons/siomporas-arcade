#!/usr/bin/env node
// One spec, end to end: flux.2-dev → keyed cut-out → TRELLIS.2 → a finished, lit glb.
//
//   node tools/assetlib/build.mjs --list
//   node tools/assetlib/build.mjs --id rx7-fd --dry-run     # prompt only, nothing spent
//   node tools/assetlib/build.mjs --id rx7-fd
//   node tools/assetlib/build.mjs --class hero-car          # the whole roster
//   node tools/assetlib/build.mjs --id rx7-fd --recon-only  # cut-out already on disk
//
// WHAT IS BORROWED AND WHAT IS NOT. `keyChroma` and `chromaFor` come from tools/assetgen, and the
// comment above them is worth reading before touching anything here — the green-dominance test with
// its relative shadow branch is the reason cut-outs do not arrive with a green rim around every
// wheel and their own contact shadow still attached. `finish` comes from there too, but is called
// with `unlit: false`: assetgen defaults to KHR_materials_unlit because coast bakes sprites and
// would otherwise light the model a second time, and corridor is a lit scene that wants the PBR
// material it was given.
//
// RESUMABLE BY DEFAULT. A view already on disk is reused and a reconstruction already on disk is
// not repeated; `--redo` overrides. One recon GPU serialises the whole roster behind an internal
// lock, so a forty-car run is an unattended couple of hours and losing it to a crash on car
// thirty-nine would be its own kind of expensive.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromaFor, keyChroma } from '../../../tools/assetgen/generate.mjs'
import { finish } from '../../../tools/assetgen/finish.mjs'
import { fillHoles } from './fillholes.mjs'
import { alphaTransmission, separateGlass } from './glass.mjs'
import { buildPrompt, chromaForPaint } from './style.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..')
const ROOT = path.resolve(LIB, '../..')

// The public hostname's certificate does not chain in this container, and every client in the repo
// works around it the same way (FLUX_VERIFY=0, curl -k). `rejectUnauthorized: false` is that.
// The zero timeouts matter more than they look: a reconstruction is ~2 minutes and undici's default
// headers timeout would abandon it client-side while the GPU was still working.
let dispatcher
try {
  const { Agent } = await import('undici')
  dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { rejectUnauthorized: false } })
} catch {
  console.warn('assetlib: undici unavailable — long jobs will time out client-side')
}

const FLUX_HOST = process.env.FLUX_HOST || 'https://high-brine.richard-siomporas.basedweights.com'
const FLUX_MODEL = process.env.FLUX_MODEL || 'flux.2-dev'
// NOT the bradley default that tools/assetgen still hard-codes — that is the retired 4-node cluster.
const RECON_HOST = process.env.RECON_HOST || 'https://recon.richard-siomporas.basedweights.com'

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

export function loadSpecs() {
  const dir = path.join(LIB, 'specs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const doc = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
      return (doc.assets ?? []).map((a) => ({ ...doc.defaults, ...a, _file: f }))
    })
}

/** text→image. One view, because the reconstruction only reads one (see README). */
async function generateView(prompt, out, { steps = 28, seed = 1, size = '1024x1024', negative = '', trueCfg = 4 }) {
  const t0 = Date.now()
  const res = await fetch(`${FLUX_HOST}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: FLUX_MODEL, prompt, size,
      num_inference_steps: steps, seed, response_format: 'b64_json',
      // A negative prompt is inert unless true_cfg_scale is set. See style.mjs — putting shape
      // prohibitions in the positive prompt made two of four wedges draw the wing they forbade.
      ...(negative ? { negative_prompt: negative, true_cfg_scale: trueCfg } : {}),
    }),
    dispatcher,
  })
  if (!res.ok) throw new Error(`flux ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const b64 = j?.data?.[0]?.b64_json
  if (!b64) throw new Error(`flux returned no image: ${JSON.stringify(j).slice(0, 300)}`)
  writeFileSync(out, Buffer.from(b64, 'base64'))
  return { seconds: +((Date.now() - t0) / 1000).toFixed(1) }
}

async function recon(images, outGlb, { seed = 1, poll = 4000 } = {}) {
  const form = new FormData()
  for (const p of images) form.append('images', new Blob([readFileSync(p)], { type: 'image/png' }), path.basename(p))
  form.append('seed', String(seed))
  const res = await fetch(`${RECON_HOST}/reconstruct`, { method: 'POST', body: form, dispatcher })
  const started = await res.json().catch(() => ({}))
  if (!res.ok || !started.job) throw new Error(`recon ${res.status}: ${JSON.stringify(started).slice(0, 300)}`)
  for (;;) {
    await new Promise((r) => setTimeout(r, poll))
    const s = await (await fetch(`${RECON_HOST}/jobs/${started.job}`, { dispatcher })).json()
    if (s.state === 'failed') throw new Error(`recon ${started.job} failed: ${s.detail}`)
    if (s.state === 'done') {
      const glb = Buffer.from(await (await fetch(`${RECON_HOST}${s.asset}`, { dispatcher })).arrayBuffer())
      writeFileSync(outGlb, glb)
      return s
    }
  }
}

/**
 * MEASURE THE MODEL, NEVER TYPE IT. The spec's dims are what we asked flux for; they are not what
 * came back, and the catalog entry has to carry what came back. TRELLIS normalises everything to
 * roughly a 1 m cube, so what this reports is the PROPORTION — the consumer rescales to `height_m`
 * or fits the long horizontal axis — and a proportion that disagrees with the spec is how a car
 * that generated as a van announces itself.
 */
function measure(glb) {
  const raw = execFileSync('npx', ['--yes', '@gltf-transform/cli@4', 'inspect', glb, '--format', 'md'],
    { encoding: 'utf8', maxBuffer: 1 << 28, cwd: ROOT })
  // The SCENES table, not the first three-number run in the file. The first version of this matched
  // a bare /(\d+), *(\d+), *(\d+)/ and cheerfully reported a car as 0.65 x 1.44 — it had locked on
  // to some other table entirely. A measurement that is quietly wrong is worse than none, so this
  // anchors on bboxMin/bboxMax and throws rather than guessing.
  const m = raw.match(/\|\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\|/)
  if (!m) throw new Error(`could not find a bounding box in the inspect output for ${path.basename(glb)}`)
  const n = m.slice(1).map(Number)
  const extent = [n[3] - n[0], n[4] - n[1], n[5] - n[2]]
  const long = Math.max(...extent)
  return { extent: extent.map((v) => +v.toFixed(4)), normalised: extent.map((v) => +(v / long).toFixed(3)) }
}

export async function build(spec, opts) {
  // A SEED IS PART OF THE SPEC once a good one is found. Two generations from one prompt are two
  // different cars — that is why extra views have to be edits rather than re-prompts — so the seed
  // that produced the car we accepted is the only thing that makes it reproducible. `--seed`
  // remains the default for specs that have not been judged yet.
  // A PER-SPEC FRAME SIZE, because the roster is about to include semis, buses and excavators.
  // flux's framing prior does not move for words — a tall subject gets cropped whatever the prompt
  // says, and adding a sentence naming a margin made it narrower AND cropped by exactly as much.
  // Wide subjects, though, frame themselves. So a 53-foot trailer is asked for in a wide frame and
  // an excavator in a tall one, which costs nothing and is the only lever that has ever worked.
  opts = { ...opts, seed: spec.seed ?? opts.seed, size: spec.size ?? opts.size }
  const dir = path.join(LIB, 'out', spec.id)
  mkdirSync(dir, { recursive: true })
  const { prompt, negative, over, length, chroma, glassKey } = buildPrompt(spec, { view: spec.view })
  const metaPath = path.join(dir, 'meta.json')
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {}

  // chromaForPaint throws if the paint is unsafe on both cards; it picks the safe one otherwise.
  const pick = chromaForPaint(spec)
  if (pick.why !== 'default') console.log(`  backdrop: ${pick.chroma} — ${pick.why}`)
  if (over) console.warn(`  ! prompt is ${length} chars, over the 1900 budget — flux will start dropping rules`)

  Object.assign(meta, {
    id: spec.id, class: spec.class, subject: spec.subject, view: spec.view ?? 'front-three-quarter',
    // The engine that actually drew it. assetgen records its module-level default here instead,
    // which is why every car in ext/assetgen claims it was drawn by klein when it was drawn by dev.
    engine: { host: FLUX_HOST, model: FLUX_MODEL, steps: opts.steps, seed: opts.seed },
    chroma,
    glassKey,
    prompt, negative, promptChars: length, builtAt: new Date().toISOString(),
  })

  const raw = path.join(dir, 'view-1.png')
  const cut = path.join(dir, 'view-1-keyed.png')

  if (!opts.reconOnly && !opts.finishOnly) {
    if (existsSync(raw) && !opts.redo) {
      console.log('  view-1.png  (reused)')
    } else {
      const r = await generateView(prompt, raw, { ...opts, negative })
      console.log(`  view-1.png  ${r.seconds}s`)
      meta.draw = r
    }
    const k = keyChroma(raw, cut, chromaFor({ ...spec, chroma }), opts.threshold)
    // `ink` is the share of the frame the cut-out still covers. A car that keyed correctly sits
    // around 20–35%; single digits mean the subject was painted the backdrop colour and dissolved.
    console.log(`  view-1-keyed.png  ink ${k.ink.toFixed(1)}%  bbox ${k.bbox}`)
    if (k.ink < 5) throw new Error(`${spec.id}: keyed to ${k.ink.toFixed(1)}% ink — the subject was eaten by the key`)
    meta.key = k

    // Close the glazing the key correctly but unhelpfully removed. Default on: a car reconstructed
    // with its windows missing comes back with an invented interior showing through them, and that
    // is the single biggest source of artefacts in the first roster.
    //
    // OFF for anything with a wing standing clear of the bodywork. The gap under a rear wing is
    // also a fully enclosed region in a three-quarter projection, so filling it welds the wing to
    // the deck. Size does not separate the two cases (the F40's wing gap is 6,198 px against its
    // windscreen's 3,982) and neither does brightness — measured, and it runs the wrong way, since
    // raked clear glass barely attenuates while a wing gap sits in shadow. So the spec declares it.
    if (spec.fillHoles !== false) {
      const h = fillHoles(cut)
      if (h.filled > 0.05) console.log(`  holes filled  ink ${h.before}% -> ${h.after}%`)
      meta.holes = h
    }
  }

  const glb = path.join(dir, `${spec.id}.glb`)
  if (!opts.finishOnly && opts.recon !== false) {
    if (existsSync(glb) && !opts.redo) {
      console.log(`  ${spec.id}.glb  (reused)`)
    } else {
      const s = await recon([cut], glb, { seed: opts.seed })
      console.log(`  ${spec.id}.glb  ${s.seconds}s  ${s.faces} faces  textured=${s.textured}`)
      meta.mesh = s
    }
    const out = path.join(dir, `${spec.id}-finished.glb`)
    // Skip a finish that would reproduce a file already newer than its source. `finish()` shells
    // out to gltf-transform three times and costs ~20s, and a resumed whole-roster run would
    // otherwise pay that for every asset it correctly skipped generating — 25 minutes across 77
    // specs, spent entirely on rewriting identical bytes.
    let f
    if (existsSync(out) && !opts.redo && statSync(out).mtimeMs >= statSync(glb).mtimeMs) {
      f = { bytes: statSync(out).size, from: statSync(glb).size }
      console.log(`  ${spec.id}-finished.glb  (reused)`)
    } else {
      // unlit: false — corridor lights its own scene. See the header.
      f = finish(glb, out, { ratio: opts.ratio, texture: opts.texture, unlit: false })
      console.log(`  ${spec.id}-finished.glb  ${(f.from / 1e6).toFixed(1)} MB → ${(f.bytes / 1e6).toFixed(2)} MB`)
    }
    // Never type a model's extent. TRELLIS normalises to roughly a 1 m cube, so what the catalog
    // needs from here is the PROPORTION; the consumer rescales to a real height_m. A proportion
    // that disagrees with the spec is how a car that generated as a van announces itself.
    let measured = null
    try { measured = measure(out) } catch (e) { console.warn(`  ! ${e.message}`) }
    meta.finished = { bytes: f.bytes, from: f.from, measured }
    if (measured) {
      const [w, h, l] = measured.normalised
      console.log(`  measured  extent ${measured.extent.join(' x ')}  normalised ${w} x ${h} x ${l}`)
      const spec_lh = spec.dims ? +(spec.dims.lengthM / spec.dims.heightM).toFixed(2) : null
      if (spec_lh) {
        const got_lh = +(Math.max(...measured.normalised) / measured.normalised[1]).toFixed(2)
        const off = Math.abs(got_lh - spec_lh) / spec_lh
        console.log(`  length:height  spec ${spec_lh}  mesh ${got_lh}${off > 0.25 ? '   <-- OFF BY ' + Math.round(off * 100) + '%' : ''}`)
      }
    }
  }

  // GLAZING AS A MATERIAL, alongside the plain mesh rather than instead of it. Both are written,
  // so the viewer can show either and a car the classifier gets wrong is a comparison rather than
  // a loss. Defaults are the ones tuned on the NSX; a spec can override them or opt out with
  // `"glass": false`. See glass.mjs for why the selection needs colour, a height floor AND a
  // face-normal test that only applies at the top of the body.
  // GLASS FROM TRELLIS'S OWN ALPHA, CONTINUOUSLY. The model predicts per-texel transparency and
  // `to_glb` discards it with a hardcoded OPAQUE; this feeds it back in as a transmissionTexture,
  // so a windscreen can be more transparent at its centre than at its edge. A chroma key could
  // only ever produce a binary, aliased mask.
  //
  // It is not uniformly reliable — across 45 assets the prediction is clean on roughly half and
  // diffuse on the rest, and a diffuse one makes the whole BODY faintly transmissive. Rich's call
  // (2026-09-28) is that quality matters more than first-pass reliability because we can reprompt.
  // So this measures the result and RE-ROLLS THE SEED rather than falling back to a worse method.
  //
  // The gate is the mean of the transmission map: too high and the body is bleeding, too low and
  // the model predicted no glass at all. Both are re-rollable; neither is tunable.
  if (spec.glass !== false && !opts.finishOnly && opts.recon !== false && existsSync(glb)) {
    const lo = spec.glassMin ?? 0.4, hi = spec.glassMax ?? 8
    const tries = opts.rerolls ?? 3
    const trans = path.join(dir, `${spec.id}-trans.glb`)
    const gOut = path.join(dir, `${spec.id}-glass-finished.glb`)
    let best = null

    for (let attempt = 0; attempt <= tries; attempt++) {
      const r = await alphaTransmission(glb, trans, { alphaFloor: 0.08 })
      const v = r.meanTransmission
      if (!best || Math.abs(v - 2.5) < Math.abs(best.v - 2.5)) best = { v, seed: opts.seed }
      const ok = v >= lo && v <= hi
      console.log(`  transmission ${v}%${ok ? '' : attempt < tries ? '  — out of band, re-rolling' : '  — out of band, keeping best'}`)
      if (ok || attempt === tries) break
      // Re-roll: a new seed is a new picture, and the alpha prediction follows the picture.
      opts = { ...opts, seed: (opts.seed ?? 1) + 101 * (attempt + 1) }
      const raw2 = path.join(dir, 'view-1.png')
      const r2 = await generateView(prompt, raw2, { ...opts, negative })
      const k2 = keyChroma(raw2, cut, chromaFor({ ...spec, chroma }), opts.threshold)
      if (spec.fillHoles !== false) fillHoles(cut)
      meta.draw = r2; meta.key = k2; meta.rerolledTo = opts.seed
      const s2 = await recon([cut], glb, { seed: opts.seed })
      meta.mesh = s2
    }

    const gf = finish(trans, gOut, { ratio: opts.ratio, texture: opts.texture, unlit: false })
    rmSync(trans, { force: true })
    meta.glass = { meanTransmission: best.v, bytes: gf.bytes, mode: 'alpha-transmission' }
    console.log(`  ${spec.id}-glass-finished.glb  ${best.v}% transmission  ${(gf.bytes / 1e6).toFixed(2)} MB`)
  }

  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

// --- CLI ---------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
  const has = (n) => argv.includes(`--${n}`)
  const specs = loadSpecs()

  if (has('list') || !specs.length) {
    const by = {}
    for (const s of specs) (by[s.class] ??= []).push(s.id)
    for (const [k, v] of Object.entries(by)) console.log(`${k} (${v.length})\n  ${v.join('  ')}`)
    if (!specs.length) console.log('no specs in tools/assetlib/specs/')
    process.exit(0)
  }

  const id = flag('id')
  const klass = flag('class')
  let chosen = specs.filter((s) => (id ? s.id === id : klass ? s.class === klass : true))

  // --stale: only the assets whose PROMPT has changed since they were built. meta.json records the
  // exact prompt, so a spec edit or a style change is detectable without guessing which assets a
  // sweep touched — and without re-running three and a half hours to fix twenty-seven of them.
  if (has('stale')) {
    const before = chosen.length
    chosen = chosen.filter((spec) => {
      const f = path.join(LIB, 'out', spec.id, 'meta.json')
      if (!existsSync(f)) return true
      try {
        const built = JSON.parse(readFileSync(f, 'utf8'))
        return built.prompt !== buildPrompt(spec, { view: spec.view }).prompt
      } catch { return true }
    })
    console.log(`${chosen.length} of ${before} assets are stale`)
    if (!chosen.length) process.exit(0)
  }
  if (!chosen.length) { console.error(`nothing matches ${id ?? klass ?? 'the filter'}`); process.exit(1) }

  const opts = {
    steps: Number(flag('steps', 28)), seed: Number(flag('seed', 1)), size: flag('size', '1024x1024'),
    threshold: Number(flag('threshold', 0.12)), ratio: Number(flag('ratio', 0.05)),
    texture: Number(flag('texture', 1024)), redo: has('redo'),
    reconOnly: has('recon-only'), finishOnly: has('finish-only'), recon: !has('skip-recon'),
  }

  if (has('dry-run')) {
    for (const s of chosen) {
      const { prompt, length, over, chroma } = buildPrompt(s, { view: s.view })
      console.log(`\n=== ${s.id} === ${length} chars, ${chroma} backdrop${over ? '  OVER BUDGET' : ''}\n${prompt}`)
    }
    process.exit(0)
  }

  let ok = 0
  const failed = []
  for (const [i, spec] of chosen.entries()) {
    console.log(`\n[${i + 1}/${chosen.length}] ${spec.id} — ${spec.subject}`)
    try { await build(spec, opts); ok += 1 } catch (e) {
      // One bad spec must not abandon the other thirty-nine on an unattended run.
      console.error(`  FAILED: ${e.message}`)
      failed.push(spec.id)
    }
  }
  console.log(`\n${ok}/${chosen.length} built${failed.length ? `, failed: ${failed.join(' ')}` : ''}`)
  if (failed.length) process.exit(1)
}
