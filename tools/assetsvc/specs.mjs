// The roster, and the recipe that turns one of its entries into a prompt.
//
// `tools/assetlib` holds both: 120 vehicle specs plus the building materials, and `style.mjs`,
// which knows the things that were found by building the same car repeatedly and looking at it —
// that era has to lead or flux defaults every 1990s car to a mid-80s coupe, that the backdrop
// decides which glass keys can survive, that the key must be chosen by hue distance from the paint
// or a bronze van gets magenta glass and 0.05% of its faces are selectable.
//
// assetsvc calls it rather than reimplementing it, and imports it directly rather than shelling
// out: `buildPrompt` is string assembly with no I/O and no GPU, so the reason `finish()` runs in a
// child process — thirty seconds of execFileSync blocking the event loop, liveness probe included
// — does not apply.
//
// WHY THIS FILE EXISTS AT ALL, rather than assetsvc importing style.mjs at its call sites: the
// roster lives on a volume in a pod and beside the code in a checkout, and exactly one place
// should know that.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

/** Where the specs are: the volume in a pod, beside the code in a checkout. */
export const SPEC_DIR = process.env.ASSETLIB_SPECS ?? path.join(process.env.ASSETLIB_DATA ?? path.join(REPO, 'tools/assetlib'), 'specs')

let cached = null

/** Every spec, by id, with the roster file it came from. */
export async function roster({ refresh = false } = {}) {
  if (cached && !refresh) return cached
  const byId = new Map()
  const files = (await readdir(SPEC_DIR).catch(() => [])).filter((f) => f.endsWith('.json')).sort()
  for (const f of files) {
    let doc
    try {
      doc = JSON.parse(await readFile(path.join(SPEC_DIR, f), 'utf8'))
    } catch (e) {
      // a broken roster file is worth saying out loud rather than silently serving fewer specs
      console.warn(`assetsvc: ${f} is not readable JSON: ${e.message}`)
      continue
    }
    /*
     * `assets`, with the FILE'S `defaults` merged under each one — which is what build.mjs does
     * and what makes a roster readable: `class` and `view` are stated once at the top and every
     * entry below is only what is different about that car. Reading `assets` without the defaults
     * gives specs with no class and no view, and `buildPrompt` then silently falls back to a
     * front three-quarter of an unclassified subject. My first guess at this shape (`specs` or a
     * bare array) found 0 of 120 and said nothing at all.
     */
    const list = Array.isArray(doc) ? doc : (doc.assets ?? doc.specs ?? doc.items ?? [])
    const defaults = Array.isArray(doc) ? {} : (doc.defaults ?? {})
    for (const s of list) if (s?.id) byId.set(s.id, { ...defaults, ...s, roster: f.replace(/\.json$/, '') })
  }
  if (!byId.size && files.length) console.warn(`assetsvc: ${files.length} roster file(s) in ${SPEC_DIR} and no specs in any of them — check the shape`)
  cached = { byId, files }
  return cached
}

export async function spec(id) {
  return (await roster()).byId.get(id) ?? null
}

/**
 * A spec, as everything needed to draw it: the prompt, the backdrop, the glass key, and WHY.
 *
 * The `why` is not decoration. The editor has to show a person that the bronze van is getting blue
 * glass because magenta shares red with its paint, or the choice looks arbitrary and the first
 * thing anybody does is override it.
 */
/**
 * Which prompt and negative to draw with: the recipe's, or the ones somebody edited.
 *
 * A HAND-WRITTEN PROMPT WINS. The recipe builds a good one from the spec and there is no
 * substitute for being able to change it — every asset that came out nearly right came out nearly
 * right for a reason a person could see and the recipe could not.
 *
 * An empty prompt is a MISTAKE and falls back: asking flux for '' draws something arbitrary and
 * charges for it. An empty NEGATIVE is a real choice, because "draw whatever you like" is a thing
 * to want and is not the same as saying nothing. Neither is coerced: these arrive from a browser
 * over JSON, and `String(null)` would prompt the model with "null".
 *
 * `edited` travels with them because the catalog entry is what says how an asset was made.
 */
/**
 * The prompt a catalog item's draw uses: the one sent with the draw (the editor's unsaved draft),
 * else the item's saved one. Blank is not a prompt; `null` back means there is nothing to draw.
 *
 * AN EMPTY PROMPT IS REFUSED, not passed on. flux given '' does not fail: it draws something
 * arbitrary and plausible, which looks like a working generator that ignores you (Rich, 2026-09-30:
 * a pizza-car prompt drew children jumping in a car park). The item had been created with
 * `prompt: ''`, the typed prompt was still an unsaved draft, and `??` let '' through because '' is
 * not nullish. The negative follows promptFor's rule: an empty one SENT is a choice.
 */
export function drawPrompt(item = {}, body = {}) {
  const said = (v) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    prompt: said(body.prompt) ?? said(item.prompt),
    negative: typeof body.negative === 'string' ? body.negative : typeof item.negative === 'string' ? item.negative : '',
  }
}

export function promptFor(recipe, body = {}) {
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : recipe.prompt
  const negative = typeof body.negative === 'string' ? body.negative : recipe.negative
  return { prompt, negative, edited: prompt !== recipe.prompt || negative !== recipe.negative }
}


export async function recipeFor(id, opts = {}) {
  const s = await spec(id)
  if (!s) return null
  const style = await import('../assetlib/style.mjs')
  const chroma = opts.chroma ?? style.chromaForPaint(s).chroma
  const glassKey = opts.glassKey ?? style.glassKeyFor(s, chroma)
  const clash = style.paintClash?.(s) ?? null
  /*
   * `buildPrompt` RETURNS AN OBJECT, and one that carries its own `length`.
   *
   * `{ prompt, negative, chroma, glassKey, over, length }` — so `rec.prompt.length` reads 1879 and
   * looks exactly like a string, every check by length passes, and what reaches the model is
   * `{"prompt": {"prompt": "A colour studio photograph..."}}`. flux caught it with a validation
   * error; nothing on this side would have. Unpacked here, once, so no caller has to know.
   *
   * It also carries the NEGATIVE, which the first version of this threw away. The recipe puts
   * prohibitions there as nouns on purpose: telling an image model not to draw something in the
   * prompt draws it.
   */
  const built = style.buildPrompt(s, { ...(opts.view ? { view: opts.view } : {}), chroma, glassKey })
  return {
    id: s.id,
    roster: s.roster,
    class: s.class ?? null,
    subject: s.subject ?? null,
    paint: s.paint ?? null,
    era: s.era ?? null,
    chroma,
    glassKey,
    prompt: built.prompt,
    negative: built.negative ?? '',
    chars: built.length,
    // the recipe has a character budget and says when a spec has blown it
    over: built.over ?? false,
    why: {
      chroma: style.chromaForPaint(s).why ?? `chosen for ${s.paint}`,
      glassKey: `keyed by hue distance from the paint; on a ${chroma} backdrop the survivors are limited`,
      ...(clash ? { paint: clash } : {}),
    },
    budget: style.BUDGET,
  }
}
