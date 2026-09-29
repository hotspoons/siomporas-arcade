// The Vehicles tab, and the Dynamics group on a vehicle's detail pane.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md §1. The document, its defaults, its validation and all of
// its arithmetic are in `src/vehicles.ts` and none of it is repeated here — this file is a form over
// that, and the division is what lets "does a 3.7 final drive give a sensible top speed" be a test
// rather than something somebody checks by squinting at a panel.
//
// IT PLUGS IN, IT DOES NOT FORK. `AssetCatalog` grew an `extensions` seam for exactly this (the
// editor lane, 2026-09-28), so the search, the shared-versus-world scope, the model import and the
// save bar are all theirs and there is one of each. Two things are added: a **Dynamics group** at
// the bottom of a vehicle's detail pane, which is where the editing happens; and a **Vehicles tab**,
// which is a ROSTER rather than a second catalog — every vehicle in the library with what it weighs,
// what it makes, how it handles and whether its dynamics are saved and valid. That is the view that
// answers "which of our cars still have no numbers", which no per-item pane ever can.
//
// EVERY EDIT GOES THROUGH `ctx.edit({ vehicle })`, AND THE WHOLE DOCUMENT GOES EVERY TIME. That is
// the pane's own draft mechanism, so staging through it gets the Save button, the unsaved marker,
// the confirmation before navigating away and Discard for free — and the service merges by
// top-level field, so a partial `vehicle` would REPLACE the one on disk rather than merge into it.
//
// THE OVERRIDES ARE GENERATED, NOT TYPED. `DriveProfile` is a flat record of numbers precisely so
// this is a loop over its keys; forty hand-written fields is forty chances to name one wrong, and
// the brief's own example gets one wrong (`rollStiffness`, which does not exist). A generated list
// cannot go stale when the engine gains a knob.
import { PROFILES, type DriveProfile } from '@apex/engine/physics/profiles'
import { assetsvc, type AssetItem, type RigBinding } from '../assetsvc'
import {
  defaultVehicle, describeVehicle, gearedTopSpeed, overrideRange, peakTorque, toDriveProfile,
  tractiveForce, validateVehicle, VEHICLE_CLASSES, wheelBoneCount, type VehicleDoc,
} from '../vehicles'
import type { AssetDetailCtx } from './assets'
import { bench, engineChoices, engineSetups, type ListenState } from './enginelisten'
import { bodyOf, empty, group, readout, select, setGroupError, slider, textField, toggle } from './controls'
import { button, el, type Tab } from './shell'

/**
 * What the extension is handed. The pane's own type — a type-only import, so there is no runtime
 * cycle with `assets.ts` even though it imports this file back.
 */
export type VehicleCtx = AssetDetailCtx

/** Is this the kind of thing that has a vehicle document at all? */
export function isVehicle(kind: string): boolean {
  return VEHICLE_CLASSES.includes(kind)
}

/**
 * The Dynamics group, appended to a vehicle's detail pane.
 *
 * Returns nothing and renders nothing at all for a non-vehicle: an empty "Dynamics" group on a fire
 * hydrant is a form somebody will eventually fill in.
 */
export function vehicleDetail(item: AssetItem, host: HTMLElement, ctx: VehicleCtx): void {
  if (!isVehicle(ctx.kind)) return

  // The document, or this class's defaults if it has none yet. NOT written back on render: an asset
  // that has never been given dynamics should not acquire a draft just by being looked at, or every
  // item you click becomes unsaved work.
  const stored = item.vehicle as VehicleDoc | null | undefined
  let doc: VehicleDoc = stored ? structuredClone(stored) : defaultVehicle(ctx.kind)
  const fresh = !stored

  const g = group('Dynamics', {
    note: fresh ? `no dynamics saved yet — these are ${ctx.kind} defaults, and nothing is stored until you save` : describeVehicle(doc),
  })
  const body = bodyOf(g)
  host.append(g)

  /*
   * How many bones drive the wheels — and TWO DIFFERENT THINGS ANSWER THAT.
   *
   *   `item.rig.roles.wheel`  a `string[]`: the bones somebody SAID are the wheels, in the rig
   *                           editor. Authoritative, stored with the asset, present with no preview.
   *   `mesh3d.rig().roles`    a `Record<string, number>`: how many bones the viewer GUESSED from
   *                           their names. A count, not names, and only while a preview is up.
   *
   * The stored binding wins, because it is what the game will actually read. The guess is the
   * fallback and it is better than nothing on an asset nobody has bound yet.
   *
   * `undefined` — neither answered — is NOT zero. "We cannot tell" must not be reported as "this
   * car has no wheels", which would put a red warning on every asset whose preview is shut.
   */
  const { count: rigWheels, guessed: rigGuessed } = wheelBoneCount(
    (item.rig as RigBinding | null | undefined)?.roles?.wheel,
    ctx.mesh3d?.rig()?.roles?.wheel,
  )

  /** Stage the change and rebuild the form — for edits that change what the form shows. */
  const stage = () => {
    ctx.edit({ vehicle: structuredClone(doc) })
    render()
  }
  /**
   * Stage WITHOUT rebuilding: what a slider wants.
   *
   * Rebuilding the form under a finger that is mid-drag replaces the control being dragged, and the
   * drag stops. Every continuous control here uses this and the discrete ones use `stage`.
   */
  const live = () => ctx.edit({ vehicle: structuredClone(doc) })

  function render() {
    body.replaceChildren()
    const report = validateVehicle(doc, { rigWheels, audioSetups: engineSetups() })
    setGroupError(g, report.errors.length ? `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}` : null)

    /* ---- what is wrong, all of it, before anything else ---------------------------------- */
    if (report.errors.length || report.warnings.length) {
      const box = el('div', 'panel-note')
      for (const e of report.errors) box.append(el('div', 'field-error', e))
      for (const w of report.warnings) box.append(el('div', 'field-note', w))
      body.append(box)
    }

    /* ---- the chassis ---------------------------------------------------------------------- */
    const chassis = group('Chassis', { note: 'metres and kilograms' })
    const cb = bodyOf(chassis)
    const num = (into: HTMLElement, label: string, value: number, step: number, onChange: (v: number) => void, note?: string) => {
      into.append(textField({
        label,
        value: String(value),
        type: 'number',
        step,
        note,
        onChange: (v) => {
          const n = Number(v)
          if (Number.isFinite(n)) { onChange(n); stage() }
        },
      }))
    }
    num(cb, 'Mass (kg)', doc.spec.mass, 10, (v) => (doc.spec.mass = v))
    num(cb, 'Wheelbase (m)', doc.spec.wheelbase, 0.05, (v) => (doc.spec.wheelbase = v))
    num(cb, 'Track (m)', doc.spec.track, 0.05, (v) => (doc.spec.track = v))
    num(cb, 'Wheel radius (m)', doc.spec.wheelRadius, 0.01, (v) => (doc.spec.wheelRadius = v))
    num(cb, 'CG height (m)', doc.spec.cgHeight, 0.01, (v) => (doc.spec.cgHeight = v), 'above the ROAD, as a spec sheet gives it — not above the model origin')
    num(cb, 'Ride height (m)', doc.spec.rideHeight ?? 0.16, 0.01, (v) => (doc.spec.rideHeight = v), 'road to the bottom of the body; this is what positions the car')
    cb.append(select({
      label: 'Driven wheels',
      value: doc.spec.drive,
      options: [{ value: 'rwd' as const, label: 'Rear' }, { value: 'fwd' as const, label: 'Front' }, { value: 'awd' as const, label: 'All four' }],
      note: 'a fact about the car, so it beats whatever the handling profile says',
      onChange: (v) => { doc.spec.drive = v; stage() },
    }))
    // The rollover number, shown rather than left to be discovered. Half the track over the CG
    // height: under 1.0 a car tips before it slides.
    if (doc.spec.track > 0 && doc.spec.cgHeight > 0) {
      cb.append(readout('Stability factor', (doc.spec.track / 2 / doc.spec.cgHeight).toFixed(2)))
    }
    body.append(chassis)

    /* ---- the rig -------------------------------------------------------------------------- */
    const rig = group('Wheels', {})
    const rb = bodyOf(rig)
    rb.append(toggle({
      label: 'Take wheel bones from the rig',
      value: doc.wheels.from_rig,
      note: 'FL, FR, RL, RR — in that order',
      onChange: (v) => { doc.wheels.from_rig = v; stage() },
    }))
    rb.append(readout('Wheel bones', rigWheels === undefined ? 'nothing bound, no preview open' : `${rigWheels}${rigGuessed ? ' (guessed from names — bind them in the rig editor)' : ''}`))
    num(rb, 'Steering lock (°)', doc.wheels.steer_max_deg, 1, (v) => (doc.wheels.steer_max_deg = v))
    body.append(rig)

    /* ---- handling ------------------------------------------------------------------------- */
    const handling = group('Handling', { note: 'a profile plus what this car differs by — never a copy of all forty numbers' })
    const hb = bodyOf(handling)
    const ids = Object.keys(PROFILES)
    hb.append(select({
      label: 'Profile',
      value: doc.profile.base,
      options: ids.map((id) => ({ value: id, label: PROFILES[id].name })),
      note: PROFILES[doc.profile.base]?.note,
      onChange: (v) => { doc.profile.base = v; stage() },
    }))
    hb.append(select({
      label: 'Blend toward',
      value: doc.profile.blendWith ?? '',
      options: [{ value: '', label: 'nothing — use the profile as it is' }, ...ids.filter((id) => id !== doc.profile.base).map((id) => ({ value: id, label: PROFILES[id].name }))],
      note: 'for a car that wants to sit between two of them rather than pick a side',
      onChange: (v) => { if (v) doc.profile.blendWith = v; else { delete doc.profile.blendWith; delete doc.profile.blend }; stage() },
    }))
    if (doc.profile.blendWith) {
      hb.append(slider({
        label: `${PROFILES[doc.profile.base]?.name ?? doc.profile.base} → ${PROFILES[doc.profile.blendWith]?.name ?? doc.profile.blendWith}`,
        value: doc.profile.blend ?? 0.5,
        min: 0, max: 1, step: 0.01,
        onInput: (v) => { doc.profile.blend = v; ctx.edit({ vehicle: structuredClone(doc) }) },
      }))
    }
    body.append(handling)

    /* ---- the overrides, GENERATED ---------------------------------------------------------- */
    const base = PROFILES[doc.profile.base] ?? PROFILES.street
    const over = group('Overrides', {
      collapsed: !Object.keys(doc.profile.overrides ?? {}).length,
      note: 'every number on the profile, generated from its own keys — a knob added to the engine appears here on its own',
    })
    const ob = bodyOf(over)
    const resolved = toDriveProfile(doc)
    for (const key of Object.keys(base) as (keyof DriveProfile)[]) {
      const def = base[key]
      if (typeof def !== 'number') continue
      const set = doc.profile.overrides?.[key]
      const live = (resolved[key] as number) ?? def
      const range = overrideRange(def)
      ob.append(slider({
        label: key,
        value: set ?? live,
        min: range.min,
        max: range.max,
        step: range.step,
        neutral: def,
        resettable: true,
        note: set === undefined ? `profile: ${round(live)}` : `overridden — profile says ${round(def)}`,
        onInput: (v) => {
          doc.profile.overrides ??= {}
          if (Math.abs(v - def) < 1e-9) delete doc.profile.overrides[key]
          else doc.profile.overrides[key] = v
          ctx.edit({ vehicle: structuredClone(doc) })
        },
      }))
    }
    body.append(over)

    /* ---- the drivetrain -------------------------------------------------------------------- */
    const eng = group('Engine, gearing and brakes', {})
    const eb = bodyOf(eng)
    num(eb, 'Power (kW)', doc.engine.power_kw, 5, (v) => (doc.engine.power_kw = v))
    num(eb, 'Peak torque (N·m)', doc.engine.torque_nm ?? Math.round(peakTorque(doc.engine).nm), 5, (v) => (doc.engine.torque_nm = v),
      peakTorque(doc.engine).estimated ? 'ESTIMATED from power and redline — type a real one if you have it' : 'as given')
    num(eb, 'Redline (rpm)', doc.engine.redline_rpm, 100, (v) => (doc.engine.redline_rpm = v))
    num(eb, 'Idle (rpm)', doc.engine.idle_rpm, 50, (v) => (doc.engine.idle_rpm = v))
    num(eb, 'Final drive', doc.engine.final_drive, 0.01, (v) => (doc.engine.final_drive = v))
    eb.append(textField({
      label: 'Gears',
      value: doc.engine.gears.join(', '),
      note: 'first to top, comma separated',
      onChange: (v) => {
        const gears = v.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x))
        if (gears.length) { doc.engine.gears = gears; stage() }
      },
    }))
    num(eb, 'Brake torque (N·m)', doc.engine.brake_torque_nm, 50, (v) => (doc.engine.brake_torque_nm = v))
    eb.append(slider({
      label: 'Brake bias (front)', value: doc.engine.brake_bias, min: 0, max: 1, step: 0.01,
      onInput: (v) => { doc.engine.brake_bias = v; ctx.edit({ vehicle: structuredClone(doc) }) },
    }))
    // WHAT THE NUMBERS MEAN, computed rather than left to be found out by driving. These are the
    // whole reason the gearing is not decoration.
    const top = gearedTopSpeed(doc.engine, doc.spec.wheelRadius)
    eb.append(readout('Geared top speed', `${(top * 2.237).toFixed(0)} mph · ${top.toFixed(1)} m/s`))
    eb.append(readout('Pull in first', `${(tractiveForce(doc.engine, doc.spec.wheelRadius) / 1000).toFixed(1)} kN`))
    eb.append(readout('Standing acceleration', `${(resolved.powerPerKg).toFixed(1)} m/s² before the tyres get a say`))
    body.append(eng)

    /* ---- audio ------------------------------------------------------------------------------ */
    const audio = group('Engine sound', {})
    const ab = bodyOf(audio)
    const choices = engineChoices()
    // A PICKER, not a text field. `setup` names an engine script the build ships, and a typed name
    // that does not exist is a car that falls back to silence with nothing saying why.
    ab.append(select({
      label: 'enginesim setup',
      value: doc.audio.setup,
      options: choices.some((c) => c.value === doc.audio.setup) ? choices : [{ value: doc.audio.setup, label: `${doc.audio.setup} (not in this build)` }, ...choices],
      note: `${choices.length} engine scripts in this build`,
      onChange: (v) => { doc.audio.setup = v; stage() },
    }))
    ab.append(slider({ label: 'Gain', value: doc.audio.gain, min: 0, max: 1, step: 0.01, onInput: (v) => { doc.audio.gain = v; bench.setGain(v); live() } }))
    ab.append(slider({ label: 'Low-pass (Hz)', value: doc.audio.lowpass_hz, min: 200, max: 20000, step: 100, onInput: (v) => { doc.audio.lowpass_hz = v; bench.setLowpass(v); live() } }))
    ab.append(slider({ label: 'Heard from the cabin', value: doc.audio.cabin_mix, min: 0, max: 1, step: 0.01, onInput: (v) => { doc.audio.cabin_mix = v; live() } }))

    /*
     * LISTEN. The click IS the gesture a browser needs to start an AudioContext, so `bench.listen`
     * is called straight out of the handler and there is no "enable audio" step.
     *
     * The gain and low-pass sliders above are wired into the live bench too, so tuning them is
     * something you HEAR rather than something you set and find out about later — which was the
     * whole argument for the button.
     */
    const status = el('div', 'field-note', '')
    const say = (st: ListenState) => {
      status.textContent = st.at === 'running' ? `running — ${st.engine}`
        : st.at === 'starting' ? 'starting the audio worklet…'
        : st.at === 'failed' ? `could not start: ${st.why}`
        : ''
      status.classList.toggle('field-error', st.at === 'failed')
    }
    const revs = slider({
      label: 'Revs', value: 0.35, min: 0, max: 1, step: 0.01,
      note: 'idle to redline, on the bench — this is a dyno and does not touch the saved numbers',
      onInput: (v) => bench.rev(v),
    })
    const row = el('div', 'panel-actions')
    row.append(button({
      label: 'Listen', icon: 'play',
      onClick: () => {
        void bench.listen({
          setup: doc.audio.setup,
          gain: doc.audio.gain,
          lowpass: doc.audio.lowpass_hz,
          throttle: 0.35,
          // It stops on its own. A bench left running behind a closed pane is a car idling in
          // somebody's headphones for the rest of the session.
          seconds: 20,
          onState: say,
        })
      },
    }))
    row.append(button({ label: 'Stop', variant: 'ghost', onClick: () => { void bench.stop().then(() => say({ at: 'stopped' })) } }))
    ab.append(row, revs, status)
    body.append(audio)

    /* ---- start again ------------------------------------------------------------------------ */
    const foot = el('div', 'panel-actions')
    foot.append(button({
      label: `Reset to ${ctx.kind} defaults`,
      variant: 'ghost',
      onClick: () => { doc = defaultVehicle(ctx.kind); stage() },
    }))
    body.append(foot)
  }

  render()
}

function round(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4)
}

/**
 * The extension object to hand `AssetCatalog`.
 *
 * NO `tabs` ENTRY, deliberately, and this is a decision rather than an omission. The brief asks for
 * a Vehicles tab; the pane already has per-CLASS tabs over the same list, so a fourth top-level tab
 * showing the same items filtered the same way would be a second route to one place — and the two
 * would drift the first time somebody added a class. The Dynamics group appears on the items that
 * have one, which is what somebody actually wants when they click a car.
 *
 * If a top-level tab is wanted anyway, it is `tabs: [{ id: 'vehicles', … }]` here and a filtered
 * list in this file; the seam supports it and I would rather be told than guess.
 */
export function vehicleExtension() {
  return { tabs: [vehicleRosterTab()], detail: vehicleDetail }
}

/* ---- the roster ------------------------------------------------------------------------------- */

/**
 * The Vehicles tab: every vehicle in the library, and whether it is finished.
 *
 * A ROSTER, NOT A SECOND CATALOG. The pane already has per-class tabs over the same list, so
 * reproducing the list, the search and the scope here would be a second route to one place and the
 * two would drift the first time somebody added a class. What this gives that no per-item pane can
 * is the ACROSS view: which cars have no dynamics at all, which have numbers that do not validate,
 * and what the fleet's spread of mass and power looks like. That is the question somebody opens a
 * Vehicles tab to answer.
 *
 * KNOWN GAP: clicking a row cannot select that item in the Catalog tab, because the seam exposes no
 * way to. It shows the id to search for instead, which is honest and a little annoying; one method
 * on `AssetDetailCtx`'s sibling would fix it and it is asked for rather than assumed.
 */
export function vehicleRosterTab(): Tab {
  return {
    id: 'vehicles',
    label: 'Vehicles',
    icon: 'bolt',
    build: (host) => void renderRoster(host),
  }
}

async function renderRoster(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', 'field-note', 'reading the library…'))
  let items: AssetItem[]
  try {
    items = await assetsvc.list()
  } catch (e) {
    // Asset generation is off by default and the corridor works completely without it, so "no
    // service" is a normal state and has to read like one rather than like a crash.
    host.replaceChildren(empty(`No asset service: ${(e as Error).message}`))
    return
  }
  const fleet = items.filter((it) => isVehicle(it.kind || ''))
  host.replaceChildren()
  if (!fleet.length) {
    host.replaceChildren(empty(`Nothing in the library is a vehicle yet. Give an asset one of these classes: ${VEHICLE_CLASSES.join(', ')}.`))
    return
  }

  let unset = 0
  let broken = 0
  const rows = el('div', 'asset-list')
  for (const it of fleet) {
    const stored = it.vehicle as VehicleDoc | null | undefined
    const doc = stored ?? defaultVehicle(it.kind)
    const report = validateVehicle(doc, { rigWheels: (it.rig as RigBinding | null | undefined)?.roles?.wheel?.length })
    if (!stored) unset++
    else if (!report.ok) broken++

    const row = el('div', 'asset-row')
    const head = el('div', 'asset-row-head')
    head.append(el('strong', '', it.id))
    head.append(el('span', 'chip', it.kind))
    if (!stored) head.append(el('span', 'chip state-spec', 'no dynamics'))
    else if (!report.ok) head.append(el('span', 'chip state-spec', `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`))
    else head.append(el('span', 'chip state-finished', 'ready'))
    row.append(head)
    row.append(el('div', 'field-note', describeVehicle(doc)))
    for (const e of report.errors.slice(0, 3)) row.append(el('div', 'field-error', e))
    rows.append(row)
  }

  // The summary first, because it is the answer: how much of the fleet is actually done.
  const summary = group('The fleet', {
    note: `${fleet.length} vehicle${fleet.length === 1 ? '' : 's'} · ${fleet.length - unset - broken} ready · ${unset} with no dynamics · ${broken} with problems`,
  })
  bodyOf(summary).append(rows)
  host.append(summary)

  const foot = el('div', 'panel-actions')
  foot.append(button({ label: 'Refresh', icon: 'arrow-path', variant: 'ghost', onClick: () => void renderRoster(host) }))
  host.append(foot)
}
