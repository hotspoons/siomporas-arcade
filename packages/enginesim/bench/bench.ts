// The tuning bench: every knob the simulator has, on one page.
//
// This is the asset-engine side of the package. The game wants two numbers and no interface; voicing
// an engine wants the opposite — a dyno, a throttle, and every synthesizer parameter where you can
// hear what moving it does. Keeping them in one package but separate entry points means the game
// never ships the sliders and the bench never reimplements the audio path.
//
//   npm run bench -w @apex/enginesim
//
// The knobs come from AUDIO_PARAMS rather than being written out here, so adding one to the binding
// makes a slider appear with its own range and explanation.

import {
  AUDIO_PARAMS, ENGINES, EngineSim, RPM_PER_RAD,
  type AudioParamSpec, type EngineProfile,
} from '../src/index'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/**
 * What the bench opens on. Not `ENGINES[0]`: the catalog sorts by path, which puts a 518 cc
 * single-cylinder quad engine first — a strange thing to meet when you open a tuning tool. This is
 * the same V8 corridor's car uses, so the bench and the game agree on what "the default" sounds like.
 */
const OPENS_WITH = 'engines/atg-video-2/07_gm_ls.mr'

const power = $<HTMLButtonElement>('power')
const status = $<HTMLElement>('status')
const main = $<HTMLElement>('main')

let engine: EngineSim | null = null
let context: AudioContext | null = null
let profile: EngineProfile | null = null
/** What the script itself asked for, so "moved off default" is answerable and a preset stays sparse. */
let scriptDefaults: number[] = []

/* ---- starting ---------------------------------------------------------------------------------- */

power.addEventListener('click', async () => {
  if (engine) return
  power.disabled = true
  status.textContent = 'starting'
  try {
    // A real click, which is the only thing a browser accepts as permission to make noise.
    context = new AudioContext({ latencyHint: 'interactive' })
    await context.resume()
    const master = context.createGain()
    master.gain.value = 1
    master.connect(context.destination)

    engine = await EngineSim.create(context, {
      onTelemetry: renderTelemetry,
      onError: (message) => { status.textContent = message },
    })
    engine.connect(master)
    await select(ENGINES.some((e) => e.path === OPENS_WITH) ? OPENS_WITH : ENGINES[0].path)

    status.textContent = `running at ${context.sampleRate} Hz`
    power.textContent = 'Running'
    main.hidden = false
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
    power.disabled = false
  }
})

/* ---- the engine -------------------------------------------------------------------------------- */

const engines = $<HTMLSelectElement>('engines')
for (const [group, list] of groupBy(ENGINES, (e) => e.group)) {
  const optgroup = document.createElement('optgroup')
  optgroup.label = group
  for (const entry of list) {
    const option = document.createElement('option')
    option.value = entry.path
    option.textContent = entry.name
    optgroup.append(option)
  }
  engines.append(optgroup)
}
engines.addEventListener('change', () => void select(engines.value))

async function select(path: string): Promise<void> {
  if (!engine) return
  status.textContent = `compiling ${path}`
  try {
    profile = await engine.load(path)
    engines.value = path
    // Read the voicing back AFTER the load: each script sets its own high-frequency gain, noise and
    // jitter, so "default" means this engine's defaults and not the package's.
    scriptDefaults = [...profile.params]
    renderSpec(profile)
    renderParams()
    renderPreset()
    // Push the current slider positions at the engine. Without this the RPM AudioParam sits at its
    // default of 0, the simulation is held at a standstill, and a freshly loaded engine is silent —
    // which looks exactly like the audio never starting.
    pushDrive()
    status.textContent = `${profile.name}`
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

function renderSpec(p: EngineProfile): void {
  definitionList($('spec'), [
    ['Cylinders', String(p.cylinders)],
    ['Displacement', `${(p.displacement * 1e6).toFixed(0)} cc`],
    ['Redline', `${Math.round(p.redline * RPM_PER_RAD)} rpm`],
    ['Simulation', `${p.simFrequency} Hz`],
  ])
  const rpm = $<HTMLInputElement>('rpm')
  rpm.max = String(Math.round(p.redline * RPM_PER_RAD * 1.05))
}

/* ---- running it -------------------------------------------------------------------------------- */

const rpm = $<HTMLInputElement>('rpm')
const pedal = $<HTMLInputElement>('pedal')
let mode: 'follow' | 'free' = 'follow'

function pushDrive(): void {
  if (!engine) return
  $('rpm-out').textContent = `${rpm.value} rpm`
  $('pedal-out').textContent = `${Math.round(Number(pedal.value) * 100)}%`
  if (mode === 'follow') engine.drive(Number(rpm.value), Number(pedal.value))
  else engine.drive(0, Number(pedal.value))
}
rpm.addEventListener('input', pushDrive)
pedal.addEventListener('input', pushDrive)

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked || !engine) return
    mode = radio.value as 'follow' | 'free'
    rpm.disabled = mode === 'free'
    if (mode === 'free') {
      // Dyno on, hold off: the engine spins up under its own power against a load, which is what a
      // power figure means. Holding it would just pin it wherever the slider was.
      engine.setFree({ dyno: true, hold: false })
    } else {
      engine.drive(Number(rpm.value), Number(pedal.value))
    }
  })
}

const starter = $<HTMLButtonElement>('starter')
for (const event of ['pointerdown']) {
  starter.addEventListener(event, () => engine?.setStarter(true))
}
for (const event of ['pointerup', 'pointerleave', 'pointercancel']) {
  starter.addEventListener(event, () => engine?.setStarter(false))
}

const ignition = $<HTMLButtonElement>('ignition')
ignition.addEventListener('click', () => {
  const on = !ignition.classList.contains('on')
  ignition.classList.toggle('on', on)
  engine?.setIgnition(on)
})

function renderTelemetry(t: { rpm: number; torque: number; power: number; manifold: number }): void {
  definitionList($('telemetry'), [
    ['RPM', t.rpm.toFixed(0)],
    ['Torque', `${t.torque.toFixed(1)} Nm`],
    ['Power', `${(t.power / 745.7).toFixed(1)} hp`],
    ['Manifold', `${(t.manifold / 1000).toFixed(1)} kPa`],
  ])
}

/* ---- the knobs --------------------------------------------------------------------------------- */

const current = new Map<string, number>()

function renderParams(): void {
  const host = $('params')
  host.replaceChildren()
  current.clear()
  for (const spec of AUDIO_PARAMS) {
    const value = scriptDefaults[spec.id] ?? spec.min
    current.set(spec.key, value)
    host.append(knob(spec, value))
  }
}

/**
 * A slider that is linear or logarithmic depending on the knob.
 *
 * The log taper is not decoration. `levelerMinGain` spans 0.000001 to 1; on a linear slider every
 * useful value is inside the first pixel, so the knob is unusable and the parameter looks broken.
 */
function knob(spec: AudioParamSpec, value: number): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'knob'

  const label = document.createElement('label')
  label.htmlFor = `p-${spec.key}`
  const out = document.createElement('output')
  label.append(`${spec.label} `, out)

  const input = document.createElement('input')
  input.type = 'range'
  input.id = `p-${spec.key}`
  input.min = '0'
  input.max = '1000'
  input.step = '1'

  const toSlider = (v: number) => spec.log
    ? (Math.log(Math.max(v, spec.min)) - Math.log(spec.min))
      / (Math.log(spec.max) - Math.log(spec.min)) * 1000
    : (v - spec.min) / (spec.max - spec.min) * 1000
  const fromSlider = (s: number) => spec.log
    ? Math.exp(Math.log(spec.min) + (s / 1000) * (Math.log(spec.max) - Math.log(spec.min)))
    : spec.min + (s / 1000) * (spec.max - spec.min)
  const show = (v: number) => {
    const rounded = Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toPrecision(3))
    out.textContent = `${rounded}${spec.unit ? ` ${spec.unit}` : ''}`
  }

  input.value = String(Math.round(toSlider(value)))
  show(value)
  input.addEventListener('input', () => {
    const v = fromSlider(Number(input.value))
    current.set(spec.key, v)
    show(v)
    engine?.setParam(spec.key, v)
    renderPreset()
  })

  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = spec.hint

  wrapper.append(label, input, hint)
  return wrapper
}

$('reset').addEventListener('click', () => {
  if (!engine) return
  for (const spec of AUDIO_PARAMS) engine.setParam(spec.key, scriptDefaults[spec.id])
  renderParams()
  renderPreset()
})

/* ---- the preset -------------------------------------------------------------------------------- */

function renderPreset(): void {
  const moved: Record<string, number> = {}
  for (const spec of AUDIO_PARAMS) {
    const value = current.get(spec.key)
    const original = scriptDefaults[spec.id]
    if (value === undefined || original === undefined) continue
    // A sparse preset: only what was actually changed, so an engine script that is later revoiced
    // upstream still moves under a preset that never mentioned the knob.
    if (Math.abs(value - original) > Math.abs(original || 1) * 1e-4) {
      moved[spec.key] = Number(value.toPrecision(5))
    }
  }
  const preset = { engine: engines.value, ...(Object.keys(moved).length ? { params: moved } : {}) }
  $<HTMLTextAreaElement>('preset').value = JSON.stringify(preset, null, 2)
}

$('copy').addEventListener('click', () => {
  void navigator.clipboard?.writeText($<HTMLTextAreaElement>('preset').value)
})

/* ---- the script -------------------------------------------------------------------------------- */

$('apply-source').addEventListener('click', async () => {
  const source = $<HTMLTextAreaElement>('source').value.trim()
  const error = $('source-error')
  if (!engine || !source) return
  error.textContent = ''
  try {
    profile = await engine.loadSource(source)
    scriptDefaults = [...profile.params]
    renderSpec(profile)
    renderParams()
    renderPreset()
    status.textContent = profile.name
  } catch (failure) {
    // Piranha reports diagnostics by writing a log rather than returning them; the binding reads
    // that back so a syntax error lands here with a line number instead of vanishing.
    error.textContent = failure instanceof Error ? failure.message : String(failure)
  }
})

/* ---- small helpers ----------------------------------------------------------------------------- */

function definitionList(host: HTMLElement, rows: [string, string][]): void {
  host.replaceChildren()
  for (const [term, value] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    host.append(dt, dd)
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const bucket = groups.get(key(item))
    if (bucket) bucket.push(item)
    else groups.set(key(item), [item])
  }
  return groups
}
