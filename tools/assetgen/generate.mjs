#!/usr/bin/env node
// A spec in `assets.json`, end to end: prompt → flux.2-dev → keyed cut-out → TRELLIS.2 → .glb.
//
//   node tools/assetgen/generate.mjs --id hero-prototype
//   node tools/assetgen/generate.mjs --class vehicle --dry-run     # the prompts, and nothing spent
//   node tools/assetgen/generate.mjs --id traffic-van --views 3    # profile and back too, by edit
//
// Everything lands in `ext/assetgen/<id>/` — gitignored — and nothing here writes into a game.
// Promoting an asset is a deliberate second step: copy the `.glb` into the owning game's `public/`,
// add a `ModelDef`, re-run `scripts/model-catalogue.mjs`. See README.md.
//
// THE TWO SERVERS ARE PORT-FORWARDS, not public URLs:
//
//   kubectl port-forward -n default svc/<flux-2-dev-svc> 18090:80      # FLUX_HOST
//   kubectl port-forward -n default svc/recon 8500:80                  # RECON_HOST
//
// flux.2-dev, not klein. `scripts/flux-art.mjs` is the fighter pipeline's client and it is pointed
// at klein by default; the two models take their attachments under different field names, which is
// the first thing that breaks when a prompt is moved between them. Dev wants `image[]` (repeated),
// klein wants `image`. `--field` exists for the day that changes. The art path belongs to the image
// generator — ask before editing `scripts/flux-art.mjs`; this file deliberately does not import it.
//
// WHY EXTRA VIEWS GO THROUGH /v1/images/edits AND NEVER THROUGH A SECOND PROMPT. Two text→image
// generations from one spec are two different cars. They agree on era and proportion and on nothing
// else — a different vent, a different lamp, a different tail — and handing TRELLIS both is asking
// it to reconstruct a single object from photographs of two. So view 1 is generated, and every
// later view is an EDIT of view 1, which is what keeps the subject the same subject.
//
// AND ONLY AT CARDINALS. Measured on this server by the photogrammetry agent: "rotate 90 degrees,
// full side profile" returns a true profile, and "a three-quarter view, 45 degrees between front
// and profile" returns a plain front view — bounding box 424 px against the front's 425, i.e. the
// same picture. Front, profile and back work; nothing in between does, and no wording fixes it. So
// intermediate angles are rejected here with a message rather than burned as generations.
//
// A ROTATION IS RELATIVE TO ITS SOURCE, which is the corollary and it cost a generation to learn.
// Asking a three-quarter view of the hero car for "a full side profile, rotated exactly 90 degrees"
// returned the same car turned about that far — a view still some fifteen degrees off a true
// profile. The cardinal names the model understands are cardinals OF THE SOURCE FRAME. That is
// harmless for reconstruction, which only needs several consistent views of one object, and it is
// not harmless for measurement: `proportionCheck` therefore only trusts a profile that was either
// generated outright or rotated from a cardinal.
//
// THE SAME FLANK COMES BACK EVERY TIME. To get the other one, `-flop` the source, edit, `-flop` the
// result back: the two mirrorings cancel and asymmetric detail lands on the correct side. That is
// `--flank left`.
//
// KEYING. Our chroma key beats anything TRELLIS would infer, and the service keeps an alpha channel
// when it finds one (`tools/recon-service/app/main.py`), so a keyed cut-out skips its background
// remover entirely. It keys on green DOMINANCE, not on distance from a sampled colour — see
// `keyChroma` for what that buys and what it cannot fix. The ink coverage is reported after every
// view, because a key that ate the subject and a key that kept the backdrop both look fine right up
// until something downstream is inexplicable.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dimsOf, renderProportion } from './proportion.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

const FLUX_HOST = process.env.FLUX_HOST ?? 'http://127.0.0.1:18090'
const FLUX_MODEL = process.env.FLUX_MODEL ?? 'flux.2-dev'
const RECON_HOST = process.env.RECON_HOST ?? 'https://recon.bradley-hartlove-gh200.basedweights.com'

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

/**
 * Node's fetch gives up after five minutes waiting for response headers and this server sends
 * nothing until the picture is finished. Same reasoning, and the same rescue, as flux-art.mjs:
 * the GPU carries on and only the client leaves, so the failure reads as a hung model.
 */
let dispatcher
try {
  const { Agent } = await import('undici')
  dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
} catch {
  console.warn('assetgen: undici unavailable — long generations will time out client-side')
}

// --- prompts -----------------------------------------------------------------------------------

/**
 * How long a prompt is allowed to get. Not the model's limit — the cluster patched dev's text
 * encoder to 2048 tokens, which is four times this — but the point at which the fighter pipeline
 * measured the model starting to TRADE one rule for another: its ~3700-character sheet prompt came
 * back with the character finally right and the layout in pieces.
 *
 * 1900 rather than 2000 leaves a margin below that, and these prompts have no layout to manage, so
 * the failure mode the fighter hit is not available here. It is a discipline, not a ceiling: a spec
 * that will not fit is usually a spec with two cues that are one cue.
 */
const BUDGET = 1900

/**
 * The two backdrops, and how to tell each from a subject. Green is the default; vegetation goes on
 * magenta, because a green screen behind a leaf forces the prompt to tell the model its plant is
 * not green, and the model obeys — the first palm came back with brown fronds.
 *
 * `dominance` is the fx expression for "how much this pixel is backdrop", and `despill` clamps the
 * key's own channels back down where they have bounced onto the subject's edge. Each is wrong for
 * the other's subjects, which is the point of choosing: a red car belongs on green, a palm on
 * magenta, and nothing belongs on the colour it is made of.
 */
const CHROMA = {
  green: {
    key: 'green',
    word: 'green',
    dominance: '(u.g-max(u.r,u.b))',
    despill: ['-channel', 'G', '-fx', 'min(u.g,(u.r+u.b)/2)'],
  },
  magenta: {
    key: 'magenta',
    word: 'magenta',
    // The AVERAGE of red and blue, not the smaller of them. The model returns a muted rose rather
    // than #ff00ff — measured at srgb(158,54,87) — and on that, `min(r,b)-g` is 0.13, a hair over
    // the threshold, so backdrop noise flips pixels back to opaque and the cut-out comes out
    // freckled. The average scores 0.27 on the same pixel and still reads negative on every
    // vegetation colour there is: olive, khaki, dead frond, grey bark.
    dominance: '((u.r+u.b)/2-u.g)',
    // Both key channels drop to green only where both stand above it — true of a magenta fringe,
    // false of anything merely warm, so brown bark and dry fronds come through untouched.
    despill: ['-channel', 'RB', '-fx', 'min(u.r,u.b) > u.g ? u.g : u'],
  },
}

/** Vegetation on magenta, everything else on green, and `chroma` in a spec beats both. */
export const chromaFor = (spec) => CHROMA[spec.chroma ?? (spec.class === 'nature' ? 'magenta' : 'green')]

const CARDINALS = { front: 'front', profile: 'profile', side: 'profile', flank: 'profile', back: 'back', rear: 'back' }

/** A spec's view names, normalised. The first may be anything; the rest must be cardinals. */
export function viewPlan(spec, count) {
  const names = (spec.views?.length ? spec.views : ['front three-quarter']).slice(0, count)
  return names.map((name, i) => {
    if (i === 0) return { name, how: 'generate' }
    const word = name.toLowerCase().split(/[\s-]+/).find((w) => CARDINALS[w])
    if (!word || /three.quarter|45/.test(name.toLowerCase())) {
      throw new Error(
        `${spec.id}: view ${i + 1} is ${JSON.stringify(name)}. Rotations only land on front, profile ` +
          `and back — an intermediate angle silently returns the front view. Make it a cardinal, or ` +
          `make it view 1, which is generated rather than rotated.`,
      )
    }
    return { name: CARDINALS[word], how: 'edit' }
  })
}

/** Join spec lines into a sentence run without doubling the punctuation they already carry. */
const list = (xs) => (xs ?? []).map((x) => x.trim().replace(/[.;,]+$/, '')).join('. ')

/** The metres, as a sentence. The single highest-leverage part of the prompt — see README.md. */
export function proportionLine(spec) {
  const d = dimsOf(spec)
  const bits = []
  if (spec.dims?.lengthM) bits.push(`${d.lengthM} m long`)
  if (spec.dims?.spanM) bits.push(`spanning ${d.spanM} m`)
  bits.push(`${d.height} m high`)
  if (spec.dims?.widthM) bits.push(`${spec.dims.widthM} m wide`)
  if (d.wheelbaseM) bits.push(`${d.wheelbaseM} m wheelbase`)
  return bits.join(', ')
}

/**
 * The positive prompt for view 1.
 *
 * ORDER IS A RESOURCE-ALLOCATION DECISION, not taste. What kind of picture this is comes first,
 * then the subject and its measurements, then the shape, then the finish. A rule at the bottom of a
 * long prompt has not been weakly applied — past the encoder's reach it was never read at all.
 *
 * So the prompt has a HEAD and a TAIL that are never dropped and an ELASTIC MIDDLE that is. The
 * tail carries the backdrop, and the backdrop is not decoration: losing it costs the key, which
 * costs the cut-out, which costs the reconstruction. The cues are where the shape lives and they
 * are also the longest part, so they are what gives way — from the end, loudly, never silently.
 */
export function generatePrompt(spec, view, { defaults, budget = BUDGET }) {
  const subject = spec.subject ?? spec.kind.replace(/_/g, ' ')
  const chroma = chromaFor(spec)
  const head = [
    `A single photograph: ONE ${subject}, alone, the only object in the picture, seen from ${view}. ${spec.era}.`,
    `IMAGE 1 is its measured side outline — match it exactly: ${proportionLine(spec)}. Draw the object, not the outline.`,
    list(spec.silhouette),
    spec.paint ? `It is painted ${spec.paint}.` : null,
  ]
  const tail = [
    defaults.render,
    defaults.camera,
    `Background: ${defaults.backgrounds[chroma.key]}. Nothing on the object itself is ${chroma.word}.`,
    'One object, one view, filling the frame. NOT a technical drawing and NOT a sheet of panels: no second view, no dimension lines, no leader lines, no measurements, no text, no lettering, no numbers, no badges.',
  ]
  return fit(head.filter(Boolean), [list(spec.cues), list(spec.materials)], tail, budget, spec.cues ?? [])
}

/**
 * Assemble under the budget, giving way at the end of the cues. Returns the prompt with a `dropped`
 * count on it, so the caller can say what it cost rather than quietly shipping a shorter spec.
 */
function fit(head, middle, tail, budget, cues) {
  const join = (parts) => parts.filter(Boolean).join('\n\n')
  let dropped = 0
  let body = middle
  for (;;) {
    const text = join([...head, ...body, ...tail])
    if (text.length <= budget || dropped >= cues.length) {
      const out = new String(text)
      out.dropped = dropped
      return out
    }
    dropped++
    body = [list(cues.slice(0, cues.length - dropped)), middle[1]]
  }
}

/**
 * The prompt that rotates view 1. Short on purpose, and it names what must be KEPT: an edit prompt
 * that only describes the change treats everything unmentioned as negotiable, which is how a pose
 * change dropped a character's wrist jewellery. The measurements go in again because a rotation is
 * also where proportion drifts.
 */
export function editPrompt(spec, view, { defaults }) {
  const chroma = chromaFor(spec)
  const what = {
    front: 'seen head-on from directly in front',
    profile: 'in full side profile, rotated exactly 90 degrees',
    back: 'seen from directly behind',
  }[view]
  return [
    `IMAGE 1 shows the object. Draw the SAME object — same shape, same proportions, same colours, same materials, same details — ${what}.`,
    `It is ${proportionLine(spec)}${spec.paint ? `, painted ${spec.paint}` : ''}.`,
    'Change nothing except the camera angle. Every panel, vent, lamp, wheel and marking stays exactly where it is.',
    defaults.render,
    `Background: ${defaults.backgrounds[chroma.key]}.`,
    'No text, no lettering, no numbers, no badges anywhere in the picture.',
  ].join('\n\n')
}

export function negativePrompt(spec, { defaults }) {
  return [...(defaults.avoid ?? []), ...(spec.avoid ?? [])].join(', ')
}

// --- the servers -------------------------------------------------------------------------------

async function flux({ prompt, negative, trueCfg, attach = [], size, steps, seed, field }) {
  const started = Date.now()
  let res
  if (!attach.length) {
    res = await fetch(`${FLUX_HOST}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FLUX_MODEL, prompt, negative_prompt: negative, true_cfg_scale: trueCfg, size, num_inference_steps: steps, seed, response_format: 'b64_json' }),
      dispatcher,
    })
  } else {
    const form = new FormData()
    form.append('model', FLUX_MODEL)
    form.append('prompt', prompt)
    form.append('size', size)
    form.append('num_inference_steps', String(steps))
    form.append('response_format', 'b64_json')
    if (seed !== undefined) form.append('seed', String(seed))
    if (negative) form.append('negative_prompt', negative)
    if (trueCfg) form.append('true_cfg_scale', String(trueCfg))
    for (const p of attach) form.append(field, new Blob([readFileSync(p)], { type: 'image/png' }), path.basename(p))
    res = await fetch(`${FLUX_HOST}/v1/images/edits`, { method: 'POST', body: form, dispatcher })
  }

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`flux ${res.status}: non-JSON reply ${text.slice(0, 300)}`)
  }
  if (!res.ok || json.error) throw new Error(`flux ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 400)}`)
  if (!json.data?.[0]?.b64_json) throw new Error(`flux: no image in reply ${JSON.stringify(json).slice(0, 300)}`)
  return { png: Buffer.from(json.data[0].b64_json, 'base64'), seconds: (Date.now() - started) / 1000 }
}

/**
 * Key the chroma to alpha, on GREEN DOMINANCE rather than distance from a sampled colour.
 *
 * The first cut did what the fighter pipeline does — sample the corner, `-fuzz N% -transparent` —
 * and it left two things behind that a sprite cannot carry: a green rim around every wheel and
 * window, and the model's own contact shadow. Distance from one colour cannot tell a shadow on
 * green from a tyre, because the shadow arrives nearly BLACK: measured at srgb(6,17,3), which is
 * further from the backdrop than the white car is.
 *
 * So there are two tests, and a pixel is backdrop if either fires:
 *
 * - **absolute**: green beats both other channels by `threshold` of full scale. True of the
 *   backdrop at any ordinary brightness, false of anything neutral.
 * - **relative**: green beats them by a THIRD of its own value. That is what catches the shadow —
 *   (17-6)/17 is 0.65 — while a black tyre at (20,20,20) scores zero. The absolute floor of 0.02
 *   is there because near-black sensor noise makes the ratio meaningless: without it, a tyre
 *   pixel of (3,5,2) scores 0.4 and a hole is punched in the car.
 *
 * Then DESPILL — clamp green back to the average of red and blue — which kills the fringe bounced
 * light leaves on a white flank. Both are computed from the ORIGINAL, in that order: despilling
 * first erases the very signal the mask is read from.
 *
 * `-morphology Close` afterwards fills the few pixels the shadow test punches out of genuinely dark
 * green-lit recesses, without reconnecting the shadow, which is far too large a region to close.
 *
 * The prompt was tried first and three wordings did not settle it — `defaults.render` asks for flat
 * shadowless lighting and `defaults.background` says the object floats — each shrank the shadow and
 * none removed it. The ink figure reported per view is how a key that went wrong announces itself.
 */
export function keyChroma(raw, out, chroma, threshold = 0.12) {
  const despilled = `${out}.despill.png`
  const mask = `${out}.mask.png`
  const dom = chroma.dominance
  // The relative test divides by the key's own strongest channel, so it reads the same on a shadow
  // as on the open backdrop.
  const level = chroma.word === 'green' ? 'u.g' : 'max(u.r,u.b)'
  const isBackdrop = `(${dom}>${threshold} || (${dom}>0.02 && ${dom}/(${level}+0.004)>0.3))`
  magick([raw, '-alpha', 'off', ...chroma.despill, '+channel', despilled])
  // A soft edge: the hard test gives a stair-stepped outline, and blur-then-level narrows it back to
  // a one-pixel ramp rather than a halo.
  magick([raw, '-alpha', 'set', '-channel', 'A', '-fx', `${isBackdrop} ? 0 : 1`, '+channel',
    // Open first to drop single-pixel specks the test flips in a noisy backdrop, then Close to fill
    // the few it punches out of dark recesses. Either alone leaves one of the two.
    '-alpha', 'extract', '-morphology', 'Open', 'Disk:1', '-morphology', 'Close', 'Disk:2',
    '-blur', '0x0.6', '-level', '40%,60%', mask])
  magick([despilled, mask, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', out])
  const ink = Number(magick([out, '-format', '%[fx:mean.a*100]', 'info:'])) || 0
  const bbox = magick([out, '-format', '%@', 'info:'])
  rmSync(despilled, { force: true })
  rmSync(mask, { force: true })
  return { ink, bbox }
}

/**
 * Did the proportion reference actually land? On a PROFILE view the keyed bounding box is the
 * object's elevation, so its aspect is directly comparable with the metres in the spec — the one
 * cheap objective test of the thing this whole file exists to control. Any other view foreshortens
 * by an unknown amount and is not worth guessing at, so nothing is claimed about those.
 *
 * `trustworthy` is false for a profile rotated out of a three-quarter view, which is not square-on
 * and would report a foreshortened length as a proportion failure. Measuring the wrong thing
 * confidently is worse than not measuring.
 */
export function proportionCheck(spec, view, bbox, trustworthy) {
  if (view !== 'profile' || !trustworthy) return null
  const m = /^(\d+)x(\d+)/.exec(bbox)
  if (!m) return null
  const d = dimsOf(spec)
  const want = d.along / d.height
  const got = Number(m[1]) / Number(m[2])
  return { want, got, off: (got - want) / want }
}

/** `-flop`, for the flank trick. Two of these cancel. */
const flop = (src, out) => magick([src, '-flop', out])

async function recon(images, outGlb, { seed = 1, poll = 3000 } = {}) {
  const form = new FormData()
  for (const p of images) form.append('images', new Blob([readFileSync(p)], { type: 'image/png' }), path.basename(p))
  form.append('seed', String(seed))
  const res = await fetch(`${RECON_HOST}/reconstruct`, { method: 'POST', body: form, dispatcher })
  const started = await res.json().catch(() => ({}))
  if (!res.ok || !started.job) throw new Error(`recon ${res.status}: ${JSON.stringify(started).slice(0, 300)}`)

  for (;;) {
    await new Promise((r) => setTimeout(r, poll))
    const s = await (await fetch(`${RECON_HOST}/jobs/${started.job}`, { dispatcher })).json()
    if (s.state === 'failed') throw new Error(`recon job ${started.job} failed: ${s.detail}`)
    if (s.state === 'done') {
      const glb = Buffer.from(await (await fetch(`${RECON_HOST}${s.asset}`, { dispatcher })).arrayBuffer())
      writeFileSync(outGlb, glb)
      return s
    }
  }
}

// --- one asset ---------------------------------------------------------------------------------

export async function generate(spec, defaults, opts) {
  const dir = path.join(ROOT, opts.out, spec.id)
  mkdirSync(dir, { recursive: true })
  const plan = viewPlan(spec, opts.views)
  const meta = { id: spec.id, class: spec.class, model: FLUX_MODEL, seed: opts.seed, steps: opts.steps, size: opts.size, views: [] }

  const proportion = renderProportion(spec, path.join(dir, 'proportion.png'))
  renderProportion(spec, path.join(dir, 'proportion-annotated.png'), { annotate: true })

  const budget = opts.long ? Infinity : BUDGET
  const prompts = plan.map((v) => (v.how === 'generate' ? generatePrompt(spec, v.name, { defaults, budget }) : editPrompt(spec, v.name, { defaults })))
  const negative = negativePrompt(spec, { defaults })

  for (const [i, p] of prompts.entries()) {
    const over = p.length > BUDGET ? `  ** ${p.length - BUDGET} over budget **` : ''
    const cut = p.dropped ? `  ** ${p.dropped} cue${p.dropped > 1 ? 's' : ''} dropped to fit — shorten the spec **` : ''
    console.log(`\n--- ${spec.id} view ${i + 1} (${plan[i].name}, ${plan[i].how})  ${p.length} chars${over}${cut}\n${p}`)
    if (i === 0) {
      console.log(`\n[negative] ${negative}`)
      if (!opts.trueCfg) console.log('[negative] NOT sampled: this is a guidance-distilled model, so a negative prompt only bites with --true-cfg 2 (and costs twice the time).')
    }
  }
  if (opts.dryRun) return { dir, dryRun: true }

  const keyed = []
  // Whether a rotation off view 1 lands square-on: true only if view 1 was itself a cardinal, since
  // the model rotates relative to the picture it is given.
  const squareOn = ['front', 'profile', 'back'].includes(plan[0].name.toLowerCase())
  if (plan.length > 1 && !squareOn) {
    console.log(`  note: view 1 is ${plan[0].name}, so every rotation off it lands that far from square-on.`)
    console.log('        Consistent views are all TRELLIS needs, but the profile will not be measurable.')
  }
  let first
  for (const [i, v] of plan.entries()) {
    const raw = path.join(dir, `view-${i}-${v.name.replace(/\W+/g, '-')}.png`)
    const src = []
    if (v.how === 'generate') {
      src.push(proportion)
    } else {
      // The flank trick: mirror in, mirror out, and the asymmetric detail lands on the right side.
      const from = opts.flank === 'left' ? path.join(dir, '_flopped.png') : first
      if (opts.flank === 'left') flop(first, from)
      src.push(from)
    }
    const r = await flux({ prompt: String(prompts[i]), negative, trueCfg: opts.trueCfg, attach: src, size: opts.size, steps: opts.steps, seed: opts.seed + i, field: opts.field })
    writeFileSync(raw, r.png)
    if (v.how === 'edit' && opts.flank === 'left') flop(raw, raw)
    if (i === 0) first = raw

    const cut = raw.replace(/\.png$/, '-keyed.png')
    const k = keyChroma(raw, cut, chromaFor(spec), opts.threshold)
    keyed.push(cut)
    meta.views.push({ view: v.name, how: v.how, file: path.basename(raw), keyed: path.basename(cut), seconds: r.seconds, ...k })
    const warn = k.ink < 4 ? '  ** almost nothing left — key ate the subject? **' : k.ink > 85 ? '  ** nearly opaque — did the backdrop key at all? **' : ''
    console.log(`  view ${i + 1} ${v.name}: ${r.seconds.toFixed(1)}s, ${k.ink.toFixed(1)}% ink, bbox ${k.bbox}${warn}`)
    const prop = proportionCheck(spec, v.name, k.bbox, v.how === 'generate' || squareOn)
    if (prop) {
      meta.views[meta.views.length - 1].proportion = prop
      const pc = `${prop.off > 0 ? '+' : ''}${(prop.off * 100).toFixed(0)}%`
      const loud = Math.abs(prop.off) > 0.15 ? '  ** the reference did not land — regenerate, or check the dims **' : ''
      console.log(`    profile aspect ${prop.got.toFixed(2)} against ${prop.want.toFixed(2)} from the spec (${pc})${loud}`)
    }
  }
  rmSync(path.join(dir, '_flopped.png'), { force: true })

  if (!opts.skipRecon) {
    const glb = path.join(dir, `${spec.id}.glb`)
    const s = await recon(keyed, glb, { seed: opts.seed })
    meta.mesh = { file: path.basename(glb), vertices: s.vertices, faces: s.faces, seconds: s.seconds }
    console.log(`  mesh: ${s.faces} faces, ${s.vertices} vertices, ${s.seconds}s → ${path.relative(ROOT, glb)}`)
  }

  writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return { dir, meta }
}

// --- CLI ---------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const flag = (n, d) => {
    const i = argv.indexOf(`--${n}`)
    return i === -1 ? d : argv[i + 1]
  }
  const has = (n) => argv.includes(`--${n}`)

  const id = flag('id')
  const klass = flag('class')
  if ((!id && !klass && !has('audit')) || has('help')) {
    console.log(`
  node tools/assetgen/generate.mjs --id hero-prototype [options]
  node tools/assetgen/generate.mjs --class vehicle --dry-run

    --id ID          one asset out of assets.json
    --class CLASS    every asset of a class: vehicle, architecture, signage, props, nature
    --dry-run        print the assembled prompts and stop
    --views N        how many views to hand TRELLIS (default 1; extras are rotations of view 1)
    --flank left     mirror in and out, to get the flank the model will not give you
    --steps N        default 28
    --seed N         default 1
    --size WxH       default 1024x1024
    --threshold N    how far green must beat red and blue to be backdrop (default 0.12)
    --true-cfg N     real CFG, which is what makes the negative prompt do anything; ~2x slower
    --skip-recon     stop after the keyed cut-outs
    --long           allow a prompt over ${BUDGET} characters
    --audit          which of the game's kinds have a spec, and which specs have no slot
    --out DIR        default ext/assetgen
    --field NAME     attachment field: image[] for flux.2-dev, image for klein

  FLUX_HOST=${FLUX_HOST}  RECON_HOST=${RECON_HOST}
`)
    process.exit(has('help') ? 0 : 1)
  }

  const file = path.join(HERE, 'assets.json')
  const { defaults, assets } = JSON.parse(readFileSync(file, 'utf8'))

  if (has('audit')) {
    // What the game asks for against what this file describes. The manifest builds most of its
    // kinds through the N/P/C helpers rather than writing `kind:` out, so both spellings are read.
    const ts = readFileSync(path.join(ROOT, 'apps/coast/src/render/models.ts'), 'utf8')
    const kinds = new Set([...ts.matchAll(/kind: '([A-Za-z0-9_]+)'/g), ...ts.matchAll(/[NPC]\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
    kinds.add('hero') // one ModelDef per livery, all built from buildPrototype
    const spec = new Map(assets.filter((a) => a.kind).map((a) => [a.kind, a.id]))
    const missing = [...kinds].filter((k) => !spec.has(k) && !k.startsWith('hero_'))
    const stray = [...spec.keys()].filter((k) => !kinds.has(k))
    console.log(`${assets.length} specs, ${kinds.size} kinds in the game's manifest`)
    console.log(`  no spec yet:      ${missing.join(', ') || 'none'}`)
    console.log(`  not in the game:  ${stray.join(', ') || 'none'}`)
    console.log(`  no slot yet:      ${assets.filter((a) => a.newKind).map((a) => a.id).join(', ') || 'none'}`)
    process.exit(0)
  }
  const chosen = assets.filter((a) => (id ? a.id === id : a.class === klass))
  if (!chosen.length) {
    console.error(`nothing matched. ids: ${assets.map((a) => a.id).join(', ')}`)
    process.exit(1)
  }

  const opts = {
    dryRun: has('dry-run'),
    views: Number(flag('views', 1)),
    flank: flag('flank'),
    steps: Number(flag('steps', 28)),
    seed: Number(flag('seed', 1)),
    size: flag('size', '1024x1024'),
    threshold: Number(flag('threshold', 0.12)),
    trueCfg: flag('true-cfg') ? Number(flag('true-cfg')) : undefined,
    skipRecon: has('skip-recon'),
    long: has('long'),
    out: flag('out', 'ext/assetgen'),
    field: flag('field', 'image[]'),
  }

  let failed = 0
  for (const spec of chosen) {
    try {
      await generate(spec, defaults, opts)
    } catch (e) {
      failed++
      console.error(`\n${spec.id}: ${e.message}`)
    }
  }
  if (failed) {
    console.error(`\n${failed} of ${chosen.length} failed`)
    process.exit(1)
  }
}
