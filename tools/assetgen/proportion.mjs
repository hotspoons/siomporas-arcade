#!/usr/bin/env node
// A measured outline of an asset, drawn from its spec's metres and nothing else.
//
//   node tools/assetgen/proportion.mjs --id hero-prototype
//   node tools/assetgen/proportion.mjs --all --annotate --out ext/assetgen/_proportions
//
// WHY THIS EXISTS. Generators have strong, wrong priors about proportion, and words barely move
// them: "low" produces a car of ordinary height, and the fighter pipeline's first Kestrel came back
// at naturalistic eight-heads next to five-head arcade sprites no matter how the sentence was
// written. What fixed her was attaching a reference image (see `apps/fighter/ART.md`). This renders
// the vehicle-and-architecture equivalent: the spec's exact metre dimensions as a flat orthographic
// outline, attached to the generation as a second image.
//
// WHAT IT DELIBERATELY DOES NOT DRAW:
//
// - **Any text or number.** `scripts/fighter-prompts.mjs` ends its sheet prompt with "NO NUMBERS
//   anywhere in the image" for a reason: lettering in an attachment comes back drawn into the
//   result. The metres are stated in the prompt instead, where they steer without being copied.
//   `--annotate` writes a second, dimensioned PNG for us to read; it must never be attached.
// - **A grid, a scale rule or a scale figure.** Same failure: attach a grid and the grid comes
//   back. The metres in the prompt are the only measuring aid; the drawing's own proportions are
//   the rest.
// - **Styling of any kind.** No shading, no perspective, no wheels-with-spokes, no roofline. A
//   roofline drawn here is a roofline the generator copies, and the spec's `cues` — written, and
//   read in full — are the better place for shape. This says how big, and where the mass sits.
//
// ONE PANEL BY DEFAULT, AND THAT WAS MEASURED. The first draft drew two — the side elevation above
// and the plan below, at one scale — because a plan carries width information a single elevation
// cannot. Attaching it produced a generation with TWO CARS IN IT, one per panel, with dimension
// leader lines and garbled numbers drawn in the margins: the model read the attachment's layout as
// the layout of the answer, exactly as `scripts/fighter-frames.mjs` reports for grids ("attach one
// to a sheet and the grid comes back rewritten"). The prompt said "draw the object, never the
// outline" and it did not help, because the attachment is the stronger statement.
//
// So the reference is a single elevation, and the width goes in the prompt as metres. `--plan`
// still draws both for reading by eye, and `generate.mjs` never attaches that form.
//
// The shapes come from the dimension fields a spec actually carries; see `shapeFor`. Anything
// without a rule gets its plain envelope, which is honest — the envelope is the part we know.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

/** Canvas size. Square, and the same size the generation is asked for. */
export const SIZE = 1024
const MARGIN = 64
/** Gap between the elevation and the plan, in pixels. */
const GAP = 48

const INK = '#8a8a8a'
const DARK = '#3c3c3c'
const GROUND = '#1a1a1a'
const PAPER = '#ffffff'

export function loadSpecs(file = path.join(HERE, 'assets.json')) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * The footprint a spec describes, in metres, normalised across the two vocabularies in the file:
 * vehicles carry `lengthM`, standing things carry `widthM`/`depthM`, a gantry carries `spanM`.
 * `along` is the dimension that runs left-to-right in both panels — a car's length, a building's
 * width — so the elevation and the plan stay in register.
 */
export function dimsOf(spec) {
  const d = spec.dims ?? {}
  const runs = d.lengthM ?? d.spanM
  const along = runs ?? d.widthM ?? d.crownSpreadM ?? 1
  // When the long dimension is a length or a span, `widthM` is the across; when the long dimension
  // IS the width — a building frontage — the across is its depth. Reading `widthM` for both is the
  // easy bug here, and it renders a motel square.
  const across = runs ? (d.widthM ?? d.depthM ?? along) : (d.depthM ?? d.trunkDiameterM ?? along)
  const height = d.heightM ?? 1
  return { along, across, height, ...d }
}

/**
 * Schematic parts for a spec, in metres, in a coordinate space with the ground at y=0 and x running
 * from 0 to `along`. Two lists: `side` (the elevation) and `plan` (seen from above, y running 0 to
 * `across`). Each part is a box or an ellipse; nothing here has a profile.
 */
export function shapeFor(spec) {
  const d = dimsOf(spec)
  const side = []
  const plan = []

  if (spec.class === 'vehicle') {
    // Wheel diameter is real proportion information — how much body sits above the tyre is most of
    // what separates a prototype from a saloon — so it is a spec field where it matters, with a
    // period-plausible fallback derived from height for the entries that do not carry one.
    const wheel = d.wheelDiameterM ?? Math.min(0.72, Math.max(0.5, d.height * 0.6))
    const wb = d.wheelbaseM ?? d.along * 0.6
    const front = (d.along + wb) / 2
    const rear = (d.along - wb) / 2
    const track = d.trackM ?? d.across * 0.82
    const tyre = wheel * 0.32 // section width; only the plan sees it

    // A plain envelope box says how big, and nothing about WHERE THE MASS IS — which for a car is
    // most of what the eye reads. Asked for a mid-engined prototype against a featureless box, the
    // generator returned a front-engined sports racer: long bonnet, cabin set back, correct overall
    // size. `cabin` draws the greenhouse where it belongs, so the outline itself says cab-forward.
    // `profile` is the strongest thing this file can say, and the hero car is why it exists. Boxes
    // give proportion and nothing else, and asked for a mid-engined prototype against a box the
    // generator kept returning a long-nosed front-engined sports racer — right size, wrong car. A
    // drawn profile is copied, which everywhere else is the failure mode and here is the point.
    // Use it sparingly: for most assets the envelope is honest and a drawn roofline is an invention.
    const cabin = d.cabin
    const bodyH = cabin ? d.height - cabin.heightM : d.height
    if (spec.profile) {
      side.push({ poly: spec.profile })
    } else {
      side.push({ box: [0, 0, d.along, bodyH] })
      if (cabin) side.push({ box: [cabin.startM, bodyH, cabin.endM - cabin.startM, cabin.heightM] })
    }
    // Fatter at the back, which is true of every one of these cars and is also the only thing in
    // the drawing that says WHICH END IS THE FRONT. Without it a cab-forward outline is equally a
    // cab-back one seen the other way round, and the generator is free to choose.
    const rearWheel = d.rearWheelDiameterM ?? wheel * 1.12
    side.push({ ellipse: [rear, rearWheel / 2, rearWheel, rearWheel], fill: DARK })
    side.push({ ellipse: [front, wheel / 2, wheel, wheel], fill: DARK })

    plan.push({ box: [0, 0, d.along, d.across] })
    for (const x of [rear, front]) {
      for (const y of [(d.across - track) / 2, (d.across + track) / 2]) {
        plan.push({ box: [x - wheel / 2, y - tyre / 2, wheel, tyre], fill: DARK })
      }
    }
    return { side, plan, ...d }
  }

  if (spec.class === 'nature' && d.trunkDiameterM) {
    // A palm is all clear trunk and a crown at the very top; the ratio between the two is the whole
    // proportion problem, and a plain envelope box would throw it away.
    const crown = d.crownSpreadM ?? d.trunkDiameterM * 12
    const crownH = d.height * 0.22
    // The crown is wider than the trunk, so it — not the trunk — sets both panels' extent. Widen
    // first and lay the parts out in the widened space: doing it the other way round centres the
    // plan on the trunk's 0.35 m and draws the canopy up through the ground line.
    const along = Math.max(d.along, crown)
    const across = Math.max(d.across, crown)
    side.push({ box: [(along - d.trunkDiameterM) / 2, 0, d.trunkDiameterM, d.height - crownH * 0.5] })
    side.push({ ellipse: [along / 2, d.height - crownH / 2, crown, crownH] })
    plan.push({ ellipse: [along / 2, across / 2, crown, crown] })
    return { side, plan, ...d, along, across }
  }

  if (d.poleHeightM) {
    // A pylon sign: a panel held up on a pole, where the height of the pole against the panel is
    // the thing that reads from the road.
    const panelH = d.height - d.poleHeightM
    const pole = d.poleDiameterM ?? 0.45
    side.push({ box: [(d.along - pole) / 2, 0, pole, d.poleHeightM] })
    side.push({ box: [0, d.poleHeightM, d.along, panelH] })
    plan.push({ box: [0, (d.across - Math.min(d.across, d.depthM ?? d.across)) / 2, d.along, Math.min(d.across, d.depthM ?? d.across)] })
    return { side, plan, ...d }
  }

  if (d.spanM && d.legHeightM) {
    // A gantry: two legs and a truss, where the clearance under it is what matters.
    const leg = d.legWidthM ?? 0.6
    const trussH = d.height - d.legHeightM
    side.push({ box: [0, 0, leg, d.legHeightM] })
    side.push({ box: [d.along - leg, 0, leg, d.legHeightM] })
    side.push({ box: [0, d.legHeightM, d.along, trussH] })
    plan.push({ box: [0, 0, d.along, d.across] })
    return { side, plan, ...d }
  }

  side.push({ box: [0, 0, d.along, d.height] })
  plan.push({ box: [0, 0, d.along, d.across] })
  return { side, plan, ...d }
}

const round = (n) => Math.round(n * 100) / 100

/** The SVG. Two panels, one scale, ground line under the elevation, nothing else. */
export function silhouetteSvg(spec, { annotate = false, plan = false } = {}) {
  const s = shapeFor(spec)
  const drawW = SIZE - MARGIN * 2
  const drawH = SIZE - MARGIN * 2 - (plan ? GAP : 0)
  // One scale for both panels: the widest thing across, and the heights stacked.
  const scale = Math.min(drawW / s.along, drawH / (s.height + (plan ? s.across : 0)))
  const px = (m) => m * scale
  const left = (SIZE - px(s.along)) / 2

  // Centre the stack: fitting the width usually leaves vertical slack, and letting it all pool at
  // the bottom puts the subject in the top third of an attachment whose whole job is proportion.
  const elevTop = Math.max(MARGIN, (SIZE - (px(s.height) + (plan ? GAP + px(s.across) : 0))) / 2)
  const groundY = elevTop + px(s.height)
  const planTop = groundY + GAP

  const parts = []
  const emit = (p, originY, flip) => {
    const fill = p.fill ?? INK
    if (p.poly) {
      const pts = p.poly.map(([x, y]) => `${round(left + px(x))},${round(flip ? originY - px(y) : originY + px(y))}`).join(' ')
      parts.push(`<polygon points="${pts}" fill="${p.fill ?? INK}"/>`)
    } else if (p.box) {
      const [x, y, w, h] = p.box
      // Elevation grows upward from the ground line; the plan grows downward from its own top edge.
      const top = flip ? originY - px(y + h) : originY + px(y)
      parts.push(`<rect x="${round(left + px(x))}" y="${round(top)}" width="${round(px(w))}" height="${round(px(h))}" fill="${fill}"/>`)
    } else {
      const [cx, cy, w, h] = p.ellipse
      const y = flip ? originY - px(cy) : originY + px(cy)
      parts.push(`<ellipse cx="${round(left + px(cx))}" cy="${round(y)}" rx="${round(px(w) / 2)}" ry="${round(px(h) / 2)}" fill="${fill}"/>`)
    }
  }
  for (const p of s.side) emit(p, groundY, true)
  if (plan) for (const p of s.plan) emit(p, planTop, false)

  // The ground line is the one piece of context in the drawing: it says the elevation stands on
  // something, which stops a car being generated hovering or cropped at the sills.
  parts.push(`<rect x="${round(left - 24)}" y="${round(groundY)}" width="${round(px(s.along) + 48)}" height="3" fill="${GROUND}"/>`)

  if (annotate) {
    // Our eyes only — never attached to a generation. See the header.
    const t = (x, y, str, anchor = 'middle') =>
      parts.push(`<text x="${round(x)}" y="${round(y)}" font-family="monospace" font-size="20" fill="#c02020" text-anchor="${anchor}">${str}</text>`)
    t(SIZE / 2, elevTop - 24, `${spec.id}  —  ${s.along} m long, ${s.height} m high, ${s.across} m wide`)
    t(left + px(s.along) / 2, groundY + 26, `${s.along} m`)
    const gutter = Math.max(72, left - 12)
    t(gutter, elevTop + px(s.height) / 2, `${s.height} m`, 'end')
    if (plan) t(gutter, planTop + px(s.across) / 2, `${s.across} m`, 'end')
    if (s.wheelbaseM) t(SIZE / 2, (plan ? planTop + px(s.across) : groundY) + 56, `wheelbase ${s.wheelbaseM} m, track ${s.trackM ?? '—'} m`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="${PAPER}"/>
${parts.join('\n')}
</svg>`
}

/** Rasterise to PNG. ImageMagick's rsvg delegate does the work; no new dependency. */
export function renderProportion(spec, out, opts = {}) {
  mkdirSync(path.dirname(out), { recursive: true })
  const tmp = `${out}.svg`
  writeFileSync(tmp, silhouetteSvg(spec, opts))
  execFileSync('magick', ['-background', 'white', tmp, '-alpha', 'remove', '-alpha', 'off', out])
  rmSync(tmp, { force: true })
  return out
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
  if ((!id && !has('all')) || has('help')) {
    console.log(`
  node tools/assetgen/proportion.mjs --id hero-prototype [--out FILE|DIR]

    --id ID        one asset out of assets.json
    --all          every asset, into --out as a directory
    --annotate     draw the dimensions on it — for reading, NEVER for attaching
    --plan         add the plan below the elevation — for reading too; two panels in an
                   attachment come back as two objects in the picture
    --out PATH     default ext/assetgen/<id>/proportion.png
`)
    process.exit(has('help') ? 0 : 1)
  }

  const { assets } = loadSpecs()
  const chosen = has('all') ? assets : assets.filter((a) => a.id === id)
  if (!chosen.length) {
    console.error(`no asset ${JSON.stringify(id)} in assets.json — have: ${assets.map((a) => a.id).join(', ')}`)
    process.exit(1)
  }

  const annotate = has('annotate')
  const plan = has('plan')
  const suffix = annotate || plan ? 'proportion-annotated.png' : 'proportion.png'
  for (const spec of chosen) {
    const out = has('all')
      ? path.join(ROOT, flag('out', 'ext/assetgen'), spec.id, suffix)
      : path.resolve(ROOT, flag('out', path.join('ext/assetgen', spec.id, suffix)))
    renderProportion(spec, out, { annotate, plan })
    const d = dimsOf(spec)
    console.log(`${path.relative(ROOT, out)}  ${d.along}x${d.height}x${d.across} m`)
  }
}
