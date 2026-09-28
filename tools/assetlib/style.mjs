// Style profiles and the prompt builder for the corridor asset library.
//
// This is the half of tools/assetgen that is taste rather than physics. The keyer, the despill and
// the mesh finisher are imported from there unchanged; the look is not, because corridor's scene is
// photographic — lidar relief, NAIP ground, gaussian splats, a real sun and wet-road shading — and
// Radrun's "flat bright arcade look, BRIGHT SATURATED colour, no photographic texture or grain" is
// a deliberate mismatch for it.
//
// PROMPT BUDGET is 1900 characters, the same discipline assetgen settled on. The encoder is patched
// to 2048 tokens, but past roughly 2000 characters flux.2-dev starts trading one instruction for
// another rather than obeying both — and a spec that will not fit is usually a spec whose cues
// repeat each other.
//
// THE PROHIBITIONS GO IN A REAL NEGATIVE PROMPT, not as negations inside the positive one.
//
// They started in the positive prompt, and for badges and wordmarks that worked. For SHAPES it
// backfired: the Countach drew its scissor doors open when the spec said closed, and both the M1
// and the Diablo grew the exact rear wing their `avoid` lists named. Two of four specs produced
// the thing they forbade — a negation in a positive prompt is read as a mention, and a mention is
// an instruction.
//
// `negative_prompt` only bites when `true_cfg_scale` is set. The repo records that as roughly
// doubling generation time; measured here it did not — 10.2s against 12.3s at cfg 4 — and the two
// images plainly differ, so it is taking effect and it is close to free.

export const BUDGET = 1900

/**
 * Pseudorealistic: what corridor wants. A studio photograph, not a render and not a toy.
 *
 * The backdrop is chroma green because `keyChroma` is built for green dominance and the despill is
 * tuned for it. The rule that follows from that is absolute and it is why assetgen's `--audit`
 * exists: A SUBJECT MUST NEVER BE PAINTED THE COLOUR OF ITS OWN BACKDROP. assetgen lost a delivery
 * van that way — "bright grass green" on a green card generated beautifully five times and keyed
 * down to 8% ink. `paintClash()` below refuses it instead.
 */
export const PSEUDOREAL = {
  key: 'pseudoreal',
  // NOT "cyclorama". A cyclorama is a wall that curves down into a floor, and naming one gets you
  // one: the first FD came back standing on a lit floor with its own shadow and a studio light
  // intruding at the top of the frame, and the light survived the key as an opaque blob that the
  // reconstruction would have welded to the roof. "Backdrop filling the frame behind and below"
  // asks for the same flat field without the architecture.
  shot:
    'A colour studio photograph of a single {subject} against a flat {chroma} backdrop filling the ' +
    'frame behind and below it. It floats clear: no floor, no ground, no cast shadow, no reflection, ' +
    'no horizon. Nothing else is in frame.',
  camera: 'Long lens, no perspective distortion, the whole subject in frame with clear backdrop all round.',
  // LIGHTING IS NOT A LOOK HERE, IT IS DATA. TRELLIS bakes whatever lighting it is shown straight
  // into base colour and then wraps that onto the half of the subject it never saw — so a strong
  // highlight down one flank and a dark shadow under the sill come back as blotches and a black
  // far side. Asking for lightbox-flat light costs nothing and gives the reconstruction something
  // close to true albedo to work from.
  finish:
    'Lit FLATLY and EVENLY as if inside a lightbox: no strong highlights, no dark shadows on the ' +
    'bodywork, no reflections, every panel its true paint colour. Photorealistic, correct panel ' +
    'gaps, sharp throughout — a photograph, not a drawing or render.',
  // PHRASED AS THINGS, NOT AS PROHIBITIONS. These now go into `negative_prompt`, where the word
  // "no" is a double negative: "no second vehicle" in a negative prompt asks for a second vehicle,
  // and that is exactly what came back — two Diablos in one frame, twice.
  avoid: [
    'badge', 'emblem', 'grille crest', 'wheel centre logo', 'wordmark',
    'model name', 'type number', 'script lettering',
    'licence plate', 'dealer frame', 'sponsor decal', 'racing number',
    'text', 'watermark', 'signature', 'caption', 'border', 'colour chart',
    'person', 'background object', 'second vehicle', 'duplicate car', 'two cars',
    // No hero car in this library is a kei car, and the model reaches for one whenever a spec
    // calls something small: both Miatas came back as scaled-up microcars with the cabin too big
    // for the body. "Tiny" has no scale reference in a studio shot on a plain backdrop.
    'kei car', 'microcar', 'city car', 'bubble car', 'toy car proportions',
    'oversized cabin on a short body', 'tall narrow body',
    'floor', 'ground plane', 'cast shadow', 'studio light', 'light stand',
  ],
}

/**
 * The view the reconstruction is built from.
 *
 * A THREE-QUARTER, AND THE HANDOFF SAYS THAT IS IMPOSSIBLE. It is not — the cardinals-only finding
 * was measured on `/v1/images/edits`, which rotates an existing frame and genuinely cannot land
 * between front, profile and back. A fresh text→image generation puts the camera where it is told.
 * Verified 2026-09-27: this phrasing returned a true front three-quarter, and the same prompt with
 * the profile phrasing returned a true profile.
 *
 * It matters because TRELLIS.2 gets exactly one view (see README) and has to invent everything it
 * cannot see. A three-quarter shows the front, a full flank and the roof in one frame — the most
 * informative single view there is. A profile would hand it two ends to guess; a front, a whole car.
 */
export const VIEWS = {
  // RAISED, and that is not a stylistic choice. At eye level the roof is edge-on and the rear
  // window is invisible, so TRELLIS has to invent both — and it invents plausible brown, not the
  // key colour, which is why the 911's roof and backlight came back as smear while its windscreen
  // and side glass keyed perfectly. Lifting the camera about twenty degrees puts the roof and the
  // rear glass in the one view the reconstruction gets.
  'front-three-quarter':
    'Camera at a FRONT THREE-QUARTER angle, forty-five degrees between front and side so both are ' +
    'fully visible, and RAISED twenty degrees looking gently down so the roof and rear window show too.',
  'rear-three-quarter':
    'The camera is at a REAR THREE-QUARTER angle, forty-five degrees between the back and the side, ' +
    'so the rear and the entire near-side flank are BOTH fully visible at once.',
  profile:
    'The camera is at a FULL SIDE PROFILE, ninety degrees, square on to the near-side flank.',
  front: 'The camera is square on to the FRONT of the subject, dead ahead, level.',
}

/**
 * WHICH BACKDROP A PAINT BELONGS ON, and this is about the DESPILL, not about the key.
 *
 * assetgen's rule was "a subject must never be painted the colour of its own backdrop", enforced
 * against the key: a green van on a green card keys down to 8% ink and disappears. True, and kept.
 *
 * But there is a second, quieter failure that costs a car without ever tripping that test. The
 * green despill clamps the green channel to `(r+b)/2` to kill the fringe bounced light leaves on a
 * flank. Yellow is red plus green, so `(r+b)/2` is about half of what its green channel should be,
 * and the despill hammers it down: the first FD keyed cleanly at 16.3% ink and came out ORANGE.
 * Nothing was eaten. It was recoloured, silently, after the mask was already correct.
 *
 * So the rule is per backdrop, and it is symmetric:
 *   green despill damages   g > (r+b)/2   — green, and everything yellow
 *   magenta despill damages min(r,b) > g  — magenta, pink, purple, violet
 * Each list is safe on the other's card, so a yellow car simply goes on magenta.
 */
const DAMAGED_BY = {
  green: /\b(green|lime|olive|emerald|jade|mint|chartreuse|teal|viridian|sage|moss|forest|yellow|gold|golden|amber|mustard|canary|lemon)\b/i,
  magenta: /\b(magenta|pink|purple|violet|lilac|lavender|mauve|plum|fuchsia|rose)\b/i,
}

/**
 * KEY THE GLASS AT GENERATION TIME INSTEAD OF INFERRING IT LATER.
 *
 * The first glass separator classified faces by sampling the baked texture — dark and desaturated,
 * with a height floor and a face-normal test to keep roofs and tyres out. It worked on the car it
 * was tuned on and did not port: every asset wanted different thresholds, and a black targa roof
 * is genuinely indistinguishable from glazing by colour. Rich, after looking at the whole set:
 * "only a few actually work with glass, the sampling technique isn't portable."
 *
 * So the glazing is PAINTED A KEY COLOUR in the generation, exactly as the backdrop is. The
 * selection then stops being a heuristic and becomes a lookup: a face is glass if its texel is the
 * key colour. No thresholds, no per-car tuning, portable by construction.
 *
 * WHICH COLOURS ARE AVAILABLE is decided by the keyer and despill, not by taste (measured):
 *
 *   green backdrop   -> magenta, blue or red survive; green is eaten by the key, cyan is despilled
 *   magenta backdrop -> green or cyan survive; magenta, blue AND red are all eaten by the key
 *
 * Within that, the choice avoids the subject's own paint the same way the backdrop does.
 */
const GLASS_KEYS = {
  magenta: { say: 'vivid magenta #ff00ff', test: 'min(r,b)-g' },
  blue:    { say: 'vivid blue #0000ff',    test: 'b-max(r,g)' },
  red:     { say: 'vivid red #ff0000',     test: 'r-max(g,b)' },
  green:   { say: 'vivid green #00ff00',   test: 'g-max(r,b)' },
  cyan:    { say: 'vivid cyan #00ffff',    test: 'min(g,b)-r' },
}

/** Ordered candidates per backdrop — only colours that survive that backdrop's key and despill. */
const GLASS_BY_BACKDROP = { green: ['magenta', 'blue', 'red'], magenta: ['green', 'cyan'] }

const PAINT_FAMILY = {
  magenta: /\b(magenta|pink|purple|violet|lilac|lavender|mauve|plum|fuchsia|rose)\b/i,
  blue:    /\b(blue|navy|azure|cobalt|indigo|sapphire|petty|bayside|estoril)\b/i,
  red:     /\b(red|crimson|scarlet|maroon|burgundy|cranberry|rosso|cherry|guards|oxide|orange|tangerine|arancio|copper|bronze|rust|amber|ochre|brick|hugger|vitamin|carousel)\b/i,
  green:   /\b(green|lime|olive|emerald|jade|mint|chartreuse|sublime|sage|moss|forest)\b/i,
  cyan:    /\b(cyan|turquoise|teal|aqua|aquamarine)\b/i,
}

/**
 * Pick the glass key colour for a spec, given the backdrop it will be shot on.
 * Throws if every candidate clashes with the paint — better than silently keying the bodywork.
 */
/** Approximate hue angle of a paint description, or null if it reads as neutral. */
const PAINT_HUE = [
  [/\b(red|crimson|scarlet|maroon|burgundy|cranberry|rosso|cherry|guards|oxide)\b/i, 0],
  [/\b(orange|tangerine|copper|bronze|rust|amber|arancio|ochre|chocolate|brown|tan)\b/i, 30],
  [/\b(yellow|gold|golden|mustard|canary|lemon|butter)\b/i, 60],
  [/\b(green|lime|olive|emerald|jade|mint|sublime|sage|moss|forest)\b/i, 120],
  [/\b(cyan|turquoise|teal|aqua|aquamarine)\b/i, 180],
  [/\b(blue|navy|azure|cobalt|indigo|sapphire|petty|bayside|estoril|colonial)\b/i, 240],
  [/\b(purple|violet|magenta|pink|lilac|lavender|mauve|plum|fuchsia|rose)\b/i, 300],
]
const GLASS_HUE = { red: 0, green: 120, cyan: 180, blue: 240, magenta: 300 }

/**
 * How well each key SURVIVES reconstruction, best first. Survivability ranks ahead of hue
 * separation: a key that is maximally contrasting and GONE is worth less than one that is merely
 * contrasting and still there.
 *
 * Traced through all three stages on single assets, which is the reliable measurement — the share
 * of the keyed cut-out carrying the key, against the share of the reconstructed texture:
 *
 *   red   16.54% of cut-out -> 4.75% of atlas, peak dominance 0.894   SURVIVES
 *   blue  12.36%            -> 0.00%,          peak 0.200             DESTROYED
 *   green 11.49%            -> 0.00%,          peak 0.216             DESTROYED
 *
 * TRELLIS is trained on photographs of real objects. Red is deeply in-distribution and it keeps
 * it; blue and green glazing are not, and it regresses them to plausible greys and browns. An
 * aggregate over the roster appeared to say green was best — that was n=3 and confounded by which
 * backdrop each key rides on. Trust the trace.
 *
 * Consequence: the BODY must stay out of red's way, which is why PAINT_FAMILY.red below also
 * covers orange, bronze and copper — `r - max(g,b)` is 0.5 for orange, well over the 0.18 cut,
 * so an orange car would key its own bodywork as glass.
 */
const KEY_SURVIVAL = ['red', 'cyan', 'blue', 'magenta', 'green']
const hueOf = (text) => { for (const [re, h] of PAINT_HUE) if (re.test(text)) return h; return null }
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

/**
 * Pick the glass key colour for a spec, given the backdrop it will be shot on.
 *
 * PICK THE MOST SEPARABLE KEY, NOT MERELY A NON-CLASHING ONE. Taking the first candidate that did
 * not literally clash put magenta glass on a bronze minivan; magenta is red plus blue and bronze is
 * red plus green, so when TRELLIS desaturated the key it drifted straight into the paint and the
 * windows came back red and unselectable. Scoring by hue distance puts blue glass on that van.
 *
 * Throws if every candidate clashes outright — better than silently keying the bodywork.
 */
export function glassKeyFor(spec, chroma) {
  // DEFAULT OFF. The glazing no longer needs painting a key colour: TRELLIS predicts per-texel
  // alpha and glass.mjs reads it (see build.mjs). Keeping the instruction would cost prompt budget,
  // constrain the paint, and put coloured windows in a picture that no longer needs them.
  if (spec.glassKey === false || spec.glassMode !== 'key') return null
  const said = [spec.paint, ...(spec.materials ?? [])].filter(Boolean).join(' ')
  const candidates = (GLASS_BY_BACKDROP[chroma] ?? []).filter((c) => !PAINT_FAMILY[c].test(said))
  if (spec.glassKey) {
    if (!(GLASS_BY_BACKDROP[chroma] ?? []).includes(spec.glassKey)) {
      throw new Error(`${spec.id}: glass key "${spec.glassKey}" does not survive a ${chroma} backdrop`)
    }
    return spec.glassKey
  }
  if (!candidates.length) {
    throw new Error(`${spec.id}: no glass key survives a ${chroma} backdrop without clashing with "${spec.paint}"`)
  }
  // Survivability first, hue separation as the tie-break. Picking purely by hue distance sent the
  // NSX from magenta (2.61% of faces) to blue and then to nothing at all.
  const h = hueOf(said)
  const rank = (k) => KEY_SURVIVAL.indexOf(k)
  return candidates.slice().sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    return h === null ? 0 : hueGap(GLASS_HUE[b], h) - hueGap(GLASS_HUE[a], h)
  })[0]
}

/** The backdrop description that goes into the prompt, matched to the keyer's two despills. */
export const CHROMA_SAYS = {
  green: 'chroma-green #2ecc40',
  magenta: 'chroma-magenta #ff00ff',
}

/**
 * Pick the backdrop a spec should be shot on. An explicit `chroma` in the spec wins, but is still
 * checked — an override that walks into the despill is worth refusing loudly.
 * Returns { chroma, why } or throws if the paint is unsafe on both.
 */
export function chromaForPaint(spec) {
  const said = [spec.paint, ...(spec.materials ?? [])].filter(Boolean).join(' ')
  const hits = { green: said.match(DAMAGED_BY.green), magenta: said.match(DAMAGED_BY.magenta) }
  if (spec.chroma) {
    if (hits[spec.chroma]) throw new Error(`${spec.id}: chroma "${spec.chroma}" would damage paint "${hits[spec.chroma][0]}"`)
    return { chroma: spec.chroma, why: 'set by the spec' }
  }
  if (hits.green && hits.magenta) throw new Error(`${spec.id}: paint is unsafe on both backdrops (${hits.green[0]}, ${hits.magenta[0]})`)
  if (hits.green) return { chroma: 'magenta', why: `"${hits.green[0]}" would be flattened by the green despill` }
  return { chroma: 'green', why: 'default' }
}

/** Back-compat: the offending word if the default green card would damage this paint, else null. */
export function paintClash(spec) {
  const said = [spec.paint, ...(spec.materials ?? [])].filter(Boolean).join(' ')
  const hit = said.match(DAMAGED_BY.green)
  return hit ? hit[0] : null
}

const list = (items) => items.map((s) => s.replace(/\.$/, '')).join('. ')

/**
 * Build the prompt for one spec.
 *
 * Order is deliberate and was chosen the way assetgen chose its own: the things flux obeys least
 * go first, while it is still paying attention. Shot and camera set the frame; the subject line
 * and silhouette establish the shape; cues add detail; the prohibitions go last, where a list is
 * read as a list rather than as a description to draw.
 */
export function buildPrompt(spec, { profile = PSEUDOREAL, view = spec.view ?? 'front-three-quarter', chroma = chromaForPaint(spec).chroma, glassKey = glassKeyFor(spec, chroma) } = {}) {
  const parts = [
    profile.shot.replace('{subject}', spec.subject).replace('{chroma}', CHROMA_SAYS[chroma]),
    VIEWS[view] ?? VIEWS['front-three-quarter'],
    profile.camera,
    // ERA LEADS. Buried mid-prompt as "Period: 1993-2002" it was ignored wholesale: reviewing the
    // first 77, flux had defaulted almost every 1990s car to a mid-1980s boxy coupe. The Supra Mk4
    // came back as an A60 Celica Supra, the Z32 as a Starion, the EG Civic as an 80s Civic. Cars
    // whose real era IS 80s-boxy came out right, which is exactly what a default looks like.
    spec.era ? `A ${spec.era} car; the period must read in its shape.` : '',
    `Paint: ${spec.paint}.`,
    ...(spec.silhouette ?? []).map((s) => (s.endsWith('.') ? s : `${s}.`)),
    // Surfacing language, because "1994" alone does not move a shape prior. `shape: 'organic'`
    // says the thing the 1990s cars needed said and the 1980s ones must not have.
    spec.shape === 'organic'
      ? 'Surfaces SMOOTH and ORGANIC: full rounded volumes, soft continuous curves, flush glazing, ' +
        'moulded body-coloured bumpers, no hard crease or square corner anywhere.'
      : spec.shape === 'boxy'
        ? 'Surfaces FLAT and HARD: straight edges, square corners, slab sides, crisp folds.'
        : '',
    (spec.cues ?? []).length ? `Details: ${list(spec.cues)}.` : '',
    (spec.materials ?? []).length ? `Materials: ${list(spec.materials)}.` : '',
    profile.finish,
    // Opaque, and said three ways, because "glass" is a strong prior and the model will reach for
    // transparency and reflections unless told plainly that these are painted panels.
    glassKey
      ? `EVERY WINDOW is a completely OPAQUE flat panel of ${GLASS_KEYS[glassKey].say}: solid ` +
        `matte paint, not glass. No transparency, no reflection, nothing visible through it. The ` +
        `windscreen, side windows and rear window are all this one flat ${glassKey} colour.`
      : '',
  ]
  const prompt = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  // Everything the picture must not contain, as its own prompt. Per-spec shape prohibitions first,
  // then the standing ones that apply to every asset in the library.
  const negative = [...(spec.avoid ?? []), ...profile.avoid,
    // Every roster is road vehicles; a roof rack or an estate tailgate on a sports coupe is always
    // wrong, and three cars came back wearing one (the AE86 as a five-door estate, the Fox-body
    // Mustang and the 944 likewise).
    'roof rack', 'roof bars', 'estate car', 'station wagon body', 'five-door body',
    ...(spec.shape === 'organic'
      ? ['boxy body', 'slab sides', 'square corners', 'hard creases', 'flat panels',
         'rectangular headlamps', 'chrome bumpers', '1980s styling']
      : []),
    ...(glassKey ? ['transparent windows', 'see-through glass', 'reflections in the windows',
                    'visible interior, seats or dashboard', 'tinted glass', 'dark glass'] : [])]
    .map((t) => t.replace(/\.$/, '')).join(', ').replace(/\s+/g, ' ').trim()
  return { prompt, negative, chroma, glassKey, over: prompt.length > BUDGET, length: prompt.length }
}
