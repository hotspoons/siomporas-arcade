// Talk to the FLUX.2 [klein] 9B image model on the cluster, in the shape the fighter art pipeline
// wants: a prompt out of PROMPTS.md, one or more template images attached, a PNG back in ext/.
//
// The model is served by vllm-omni and speaks the OpenAI images API — /v1/images/generations for a
// prompt on its own, /v1/images/edits (multipart) when there are images to attach. The bible is the
// only prompt in the pipeline with no attachment; everything after it attaches the bible first and
// the layout template second, which is what `--attach a.png,b.png` is for.
//
// It is NOT on the public URL. Port-forward the vllm service first:
//
//   kubectl port-forward -n default svc/flux-2-klein-9b-flux-2-klein-9b-flux2klei-d6cf254b 8402:80
//
// THE PROMPT IS TRUNCATED AT ABOUT 2000 CHARACTERS AND NOTHING SAYS SO. Measured, not guessed:
// insert a loud instruction ("THE CHARACTER WEARS A LARGE BRIGHT YELLOW HAT IN EVERY BOX") at
// char 1200 and the image changes; insert the same sentence at 2200 and the image is BYTE
// IDENTICAL to the one without it. The boundary is between 1700 and 2200 — consistent with a
// 512-token text encoder at roughly four characters a token. There is no error, no warning and no
// field in the response: the tail is simply never read.
//
// Everything that matters must therefore go in the FIRST ~1800 CHARACTERS, and the order of a
// prompt is now a resource-allocation decision rather than a matter of taste. A rule written at the
// bottom of a long prompt has not been weakly applied, it has not been applied at all — which for a
// while looked exactly like a model that ignores instructions.
//
// TWO IMAGES, AND WHY IT ONCE LOOKED LIKE ONE. Attach the bible AND the layout template, both as
// `image`. If the server answers "Only a single image is supported by this model", that is not the
// model: it is an admission gate in vllm-omni's API server reading a capability registry that has
// no entry for the pipeline. Neither FLUX.2 pipeline is registered upstream — klein was added on
// 11 September, dev still is not — and unregistered pipelines fall through to a single-image
// default. The dev pipeline concatenates a list of references and hands each one to its text
// encoder separately; the capability is there, nothing advertises it. The cluster deployment
// registers `Flux2Pipeline` at container start to fix this.
//
// DO NOT USE `reference_image` ON DEV. The server accepts it, puts it in its own `multi_modal_data`
// key, and only the klein pipeline ever reads that key — so on dev it is silently discarded and you
// get a stranger drawn to an otherwise perfectly obeyed prompt. `--reference` is klein-only.
//
// The bible has to be an attached image rather than a description, because the PAINTED STYLE lives
// in it and does not survive being written down: asked in words for retouched arcade illustration,
// dev returns photographs of an actor on a green screen.
//
// THE SIZE IS NOT NEGOTIABLE UPWARDS. The templates are 2390x1792 but the card OOMs above about
// 3.2 megapixels, so we ask for 2048x1536 — the same 4:3, 85.7% of the linear size. The cutter
// works in fractions of the sheet rather than absolute pixels, so this costs nothing but detail.

import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HOST = process.env.FLUX_HOST ?? 'http://127.0.0.1:8402'
const MODEL = process.env.FLUX_MODEL ?? 'FLUX.2 [klein] 9B'
export const SHEET_SIZE = '2048x1536'

/**
 * Node's fetch gives up after five minutes of silence waiting for response headers, and this server
 * sends nothing at all until the image is finished. A 50-step sheet takes about three minutes, so
 * the default is survivable — but real CFG runs a second forward pass per step and goes past it,
 * and the failure looks exactly like a hung model rather than a client timeout:
 *
 *   TypeError: fetch failed ... UND_ERR_HEADERS_TIMEOUT
 *
 * The GPU carries on and finishes the picture; only the client has left. So: no header or body
 * deadline, and let the wall clock be the generation's business. `undici` reaches us through Node's
 * own dependencies rather than our package.json, so this degrades to the default if it is absent.
 */
let dispatcher
try {
  const { Agent } = await import('undici')
  dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
} catch {
  console.warn('flux-art: undici unavailable — generations past five minutes will time out')
}

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

/** Read a prompt out of PROMPTS.md by its heading number, so the file stays the single source. */
export function promptFromFile(file, number) {
  const md = readFileSync(file, 'utf8')
  // Split on the headings rather than trying to match up to the next one — a lookahead for "the
  // next ## or the end of file" is the kind of regex that quietly matches nothing.
  const sections = md.split(/^## /m).slice(1)
  const hit = sections.find((s) => Number(s.match(/^(\d+)\./)?.[1]) === Number(number))
  if (!hit) throw new Error(`no prompt ${number} in ${path.basename(file)}`)
  const fence = hit.match(/```text\n([\s\S]*?)```/)
  const title = hit.slice(0, hit.indexOf('\n')).trim()
  if (!fence) throw new Error(`prompt ${number} (${title}) has no text block`)
  return { title, text: fence[1].trim() }
}

/**
 * One generation. `attach` is a list of image paths; with none it goes to /v1/images/generations,
 * with any it goes to /v1/images/edits as multipart. Returns the PNG bytes.
 *
 * `guidance` and `trueCfg` are not the same knob and the difference matters on this model.
 *
 * `guidance_scale` on a DISTILLED model — and klein is one, `model_index.json` says
 * `"is_distilled": true` — is an embedded conditioning value baked in at training, not classifier-
 * free guidance. It does not run the negative prompt. `true_cfg_scale` above 1 is what turns on
 * real CFG, samples the negative prompt as a second forward pass, and therefore costs roughly twice
 * the time per step. If a negative prompt appears to be doing nothing, this is why.
 */
export async function flux({ prompt, attach = [], reference, size = SHEET_SIZE, steps = 50, guidance, trueCfg, seed, negative }) {
  const started = Date.now()
  let res

  if (attach.length === 0) {
    const body = { model: MODEL, prompt, size, num_inference_steps: steps, response_format: 'b64_json' }
    if (guidance !== undefined) body.guidance_scale = guidance
    if (trueCfg !== undefined) body.true_cfg_scale = trueCfg
    if (seed !== undefined) body.seed = seed
    if (negative) body.negative_prompt = negative
    res = await fetch(`${HOST}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher,
    })
  } else {
    const form = new FormData()
    form.append('model', MODEL)
    form.append('prompt', prompt)
    form.append('size', size)
    form.append('num_inference_steps', String(steps))
    form.append('response_format', 'b64_json')
    if (guidance !== undefined) form.append('guidance_scale', String(guidance))
    if (trueCfg !== undefined) form.append('true_cfg_scale', String(trueCfg))
    if (seed !== undefined) form.append('seed', String(seed))
    if (negative) form.append('negative_prompt', negative)
    for (const p of attach) {
      if (!existsSync(p)) throw new Error(`attachment missing: ${p}`)
      form.append('image', new Blob([readFileSync(p)], { type: 'image/png' }), path.basename(p))
    }
    if (reference) {
      if (!existsSync(reference)) throw new Error(`reference missing: ${reference}`)
      form.append('reference_image', new Blob([readFileSync(reference)], { type: 'image/png' }), path.basename(reference))
    }
    res = await fetch(`${HOST}/v1/images/edits`, { method: 'POST', body: form, dispatcher })
  }

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${res.status} non-JSON reply: ${text.slice(0, 400)}`)
  }
  if (!res.ok || json.error) throw new Error(`${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 500)}`)
  if (!json.data?.[0]?.b64_json) throw new Error(`no image in reply: ${JSON.stringify(json).slice(0, 400)}`)

  return {
    png: Buffer.from(json.data[0].b64_json, 'base64'),
    seconds: (Date.now() - started) / 1000,
    metrics: json.metrics,
  }
}

// --- CLI ---------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = flag('out')
  if (!out || has('help')) {
    console.log(`
  node scripts/flux-art.mjs --out ext/kestrel-bible.png [options]

    --prompt "..."          prompt text, or
    --prompt-file FILE      read the prompt from a file, or
    --prompt-number N       take prompt N out of apps/fighter/PROMPTS.md
    --attach a.png,b.png    images to attach, in order (bible first, template second)
    --size WxH              default ${SHEET_SIZE}
    --steps N               default 50
    --guidance N            embedded guidance (distilled models: does NOT run the negative prompt)
    --true-cfg N            real classifier-free guidance; >1 activates --negative, ~2x slower
    --seed N                repeatable
    --negative "..."        negative prompt
`)
    process.exit(has('help') ? 0 : 1)
  }

  const promptFile = flag('prompt-file')
  const num = flag('prompt-number')
  const promptsFile = flag('prompts-file', 'apps/fighter/PROMPTS.md')
  let prompt = flag('prompt') ?? (promptFile ? readFileSync(promptFile, 'utf8').trim() : undefined)
  if (num) {
    const p = promptFromFile(promptsFile, num)
    prompt = p.text
    console.log(`prompt ${num}: ${p.title}`)
  }
  if (!prompt) throw new Error('need --prompt, --prompt-file or --prompt-number')

  const attach = (flag('attach', '') || '').split(',').filter(Boolean)
  const r = await flux({
    prompt,
    attach,
    reference: flag('reference'),
    size: flag('size', SHEET_SIZE),
    steps: Number(flag('steps', 50)),
    guidance: flag('guidance') ? Number(flag('guidance')) : undefined,
    trueCfg: flag('true-cfg') ? Number(flag('true-cfg')) : undefined,
    seed: flag('seed') ? Number(flag('seed')) : undefined,
    negative: flag('negative'),
  })
  writeFileSync(out, r.png)
  console.log(`${out}  ${(r.png.length / 1e6).toFixed(1)} MB  ${r.seconds.toFixed(1)}s${attach.length ? `  (${attach.length} attached)` : ''}`)
}
