// The Vehicles screen: find a car, see it, give it dynamics.
//
// Rich, 2026-09-29, on the first version of this: *"How do I attach dynamics to the cars? How do I
// set their engine simulator config? ... how do I filter by class, how do I search, and why aren't
// we using preview images if we have them? And why just a big old list"*
//
// Every one of those was fair, and the first version was worse than it looked. It listed 120 cars,
// none of which had a dynamics document, and rendered the CLASS TEMPLATE for each — so all 120 read
// "1420 kg · 275 hp · RWD · 6-speed · 215 mph geared" and looked like data. Inventing a number and
// putting it beside a real id is the worst thing a screen like this can do, so:
//
//   **NOTHING NUMERIC IS SHOWN FOR A CAR THAT HAS NO DOCUMENT.** It says "no dynamics yet" and
//   offers to start one. A template is a thing you CHOOSE, with a button — not something the screen
//   asserts on the car's behalf.
//
// The other half was that the tab could not DO anything: the editor lived on the Catalog tab's
// detail pane, so "how do I attach dynamics" was answered by "go to a different tab and click the
// item". The form is now shared — `dynamicsForm` — so there is one form and two doors to it.
//
// LAYOUT. Cards in a grid with the asset's own rendered view, a search box, a class filter and a
// dynamics filter. The grid is laid out with inline styles rather than a class because `ui.css` is
// the editor lane's file and a grid is four properties; if this screen earns a place in that
// stylesheet it belongs there, but helping myself to somebody else's stylesheet for a first cut
// does not.
import { PROFILES, type DriveProfile } from '@apex/engine/physics/profiles'
import { assetsvc, type AssetItem, type Build, type RigBinding } from '../../assets/assetsvc'
import {
  axleGrip, defaultVehicle, describeVehicle, estimateVmax, finalDriveFor, FINAL_DRIVE_MAX,
  lampCounts,
  FINAL_DRIVE_MIN, frontShare, gearedTopSpeed, mountPoint, mountYaw, overrideRange, peakTorque,
  rebalanceGears, toDriveProfile, tractiveForce, TYRE_REFERENCE_MM, validateVehicle, VEHICLE_CLASSES,
  VEHICLE_MOUNTS, VEHICLE_TEMPLATE_IDS, wheelBoneCount,
  type VehicleDoc, type VehicleMesh, type VehicleMount,
} from '../../game/vehicle/vehicles'
import { presetDoc, presetsFor } from '../../game/vehicle/vehiclepresets'
import type { AssetDetailCtx } from './assets'
import { bench, engineChoices, engineSetups, type ListenState } from './enginelisten'
import { soundsGroup } from './soundpicker'
import { bodyOf, group, readout, select, slider, textField, toggle } from '../../ui/controls'
import { button, el, type Tab } from '../../ui/shell'
import { icon } from '../../ui/icons'
import { CLASSES_BY_TYPE } from '../../assets/classes'
import { buildScreen, type BuildPreset, type BuildSpec } from './buildscreen'

export type VehicleCtx = AssetDetailCtx

/** Is this the kind of thing that has a vehicle document at all? */
export function isVehicle(kind: string): boolean {
  return VEHICLE_CLASSES.includes(kind)
}

/* ================================================================================================
 * The form. ONE of it, used by the tab and by the detail pane.
 * ============================================================================================= */

export interface FormOpts {
  /** how many bones the rig binds to the wheel role, or undefined for "cannot tell" */
  rigWheels?: number
  /**
   * Which mesh files the chosen model has. Null means no model yet, so both choices stay open.
   * Omitted means the caller does not know, and both stay open too.
   */
  meshes?: { finished: boolean; raw: boolean } | null
  /** the catalog asset the build is on — where its own sound clips are uploaded. Null: no model yet */
  assetId?: string | null
  /** called on every edit. `live` is true for a drag, where the form must NOT be rebuilt */
  onChange: (doc: VehicleDoc, live: boolean) => void
}

/**
 * The whole dynamics editor, rendered into `host`. Returns a `rebuild`.
 *
 * A caller that replaces the document wholesale — starting from a template, discarding an edit —
 * calls `rebuild`; everything else the form does to itself.
 */
export function dynamicsForm(host: HTMLElement, getDoc: () => VehicleDoc, opts: FormOpts): () => void {
  /*
   * The armoury, for the mount picker. BUILT weapons, not catalog rows: a mount names something
   * with damage and a rate of fire, and a bare catalog id has neither. Fetched once; a failure is a
   * normal state (asset generation is off by default) and must not take the form down with it.
   */
  let weaponIds: string[] | undefined
  void assetsvc.builds<Build<unknown>>('weapons')
    .then((ws) => { weaponIds = ws.map((w) => w.id); render() })
    .catch(() => { /* no service: the mount falls back to a text field */ })

  /*
   * WHICH SECTION IS OPEN, remembered across rebuilds.
   *
   * Rich, 2026-09-29: *"It would be great if instead of expando areas we had tabs"*. Forty fields
   * in five collapsing groups means the one you want is either below the fold or behind a chevron,
   * and every edit rebuilds the form, so the groups you opened close again. Tabs fix both: one
   * screenful at a time, and the section you are working in survives its own edits.
   *
   * These are `.tab-strip`/`.tab` from `ui.css`, so they look like every other tab in the app, but
   * they are NOT the `Tabs` class — that one owns its height and its own scroller, which inside a
   * screen that already scrolls produces two scrollbars for one form.
   */
  const SECTIONS = [
    { id: 'basic', label: 'Basic', icon: 'cube' as const },
    { id: 'finish', label: 'Finish', icon: 'swatch' as const },
    { id: 'engine', label: 'Engine & gearing', icon: 'bolt' as const },
    { id: 'sound', label: 'Engine sound', icon: 'play' as const },
    { id: 'sounds', label: 'Sounds', icon: 'speaker-wave' as const },
    { id: 'other', label: 'Weapons & overrides', icon: 'adjustments-horizontal' as const },
  ]
  let section = 'basic'

  function render() {
    const doc = getDoc()
    host.replaceChildren()
    const report = validateVehicle(doc, { rigWheels: opts.rigWheels, audioSetups: engineSetups(), weapons: weaponIds })

    /*
     * PROBLEMS STAY ABOVE THE TABS. A message about the gearbox shown only on the gearing tab is a
     * message somebody reading the chassis tab cannot see, and the error they need is nearly always
     * in the section they are not looking at.
     */
    if (report.errors.length || report.warnings.length) {
      const box = el('div', 'panel-note')
      for (const e of report.errors) box.append(el('div', 'field-error', e))
      for (const w of report.warnings) box.append(el('div', 'field-note', w))
      host.append(box)
    }

    const strip = el('div', 'tab-strip')
    for (const sec of SECTIONS) {
      const b = el('button', `tab${section === sec.id ? ' on' : ''}`)
      b.type = 'button'
      b.append(icon(sec.icon, 16), el('span', '', sec.label))
      b.onclick = () => { section = sec.id; render() }
      strip.append(b)
    }
    host.append(strip)
    const pane = el('div', 'bld-formpane')
    host.append(pane)
    /** every group goes into the open section's pane, and nowhere else */
    const put = (which: string, node: HTMLElement) => { if (section === which) pane.append(node) }

    /** stage and rebuild — for anything that changes what the form SHOWS */
    const stage = () => { opts.onChange(doc, false); render() }
    /** stage WITHOUT rebuilding — a slider's control has to survive its own drag */
    const live = () => opts.onChange(doc, true)

    const num = (into: HTMLElement, label: string, value: number, step: number, set: (v: number) => void, note?: string) => {
      into.append(textField({
        label, value: String(value), type: 'number', step, note,
        onChange: (v) => { const n = Number(v); if (Number.isFinite(n)) { set(n); stage() } },
      }))
    }

    /* ---- which file the world draws ------------------------------------------------------- */
    const model = group('Model', { note: 'which mesh this vehicle draws in the world' })
    const modelBody = bodyOf(model)
    const available: VehicleMesh[] = opts.meshes
      ? ([opts.meshes.finished ? 'finished' : null, opts.meshes.raw ? 'raw' : null].filter(Boolean) as VehicleMesh[])
      : ['finished', 'raw']
    const chosen: VehicleMesh = available.includes(doc.mesh ?? 'finished') ? (doc.mesh ?? 'finished') : (available[0] ?? 'finished')
    if (!opts.meshes) {
      modelBody.append(select({
        label: 'Version',
        value: chosen,
        options: [
          { value: 'finished' as const, label: 'Finished' },
          { value: 'raw' as const, label: 'Raw' },
        ],
        note: 'finished is the simplified mesh. Raw is the reconstruction, with many more triangles. Choose a model and this list shrinks to the files it has',
        onChange: (v) => { doc.mesh = v; stage() },
      }))
    } else if (available.length === 0) {
      modelBody.append(el('div', 'field-note', 'This model has no mesh yet.'))
    } else if (available.length === 1) {
      modelBody.append(readout('Version', available[0] === 'raw' ? 'Raw' : 'Finished'))
      modelBody.append(el('div', 'field-note', available[0] === 'raw'
        ? 'The raw reconstruction is the mesh on this model, so that is what the world draws.'
        : 'The finished mesh is the mesh on this model, so that is what the world draws.'))
    } else {
      modelBody.append(select({
        label: 'Version',
        value: chosen,
        options: [
          { value: 'finished' as const, label: 'Finished' },
          { value: 'raw' as const, label: 'Raw' },
        ],
        note: 'finished is the simplified mesh. Raw is the full reconstruction. The world draws whichever you leave selected',
        onChange: (v) => { doc.mesh = v; stage() },
      }))
    }
    put('basic', model)

    /* ---- the chassis ---------------------------------------------------------------------- */
    const chassis = group('Chassis', { note: 'metres and kilograms' })
    const cb = bodyOf(chassis)
    num(cb, 'Mass (kg)', doc.spec.mass, 10, (v) => (doc.spec.mass = v))
    num(cb, 'Wheelbase (m)', doc.spec.wheelbase, 0.05, (v) => (doc.spec.wheelbase = v))
    num(cb, 'Track (m)', doc.spec.track, 0.05, (v) => (doc.spec.track = v))
    num(cb, 'Wheel radius (m)', doc.spec.wheelRadius, 0.01, (v) => (doc.spec.wheelRadius = v))
    num(cb, 'Length (m)', doc.spec.length ?? +(doc.spec.wheelbase * 1.6).toFixed(2), 0.05, (v) => (doc.spec.length = v), 'the model is scaled to this, so it decides how big the car looks')
    num(cb, 'Width (m)', doc.spec.width ?? +(doc.spec.track * 1.2).toFixed(2), 0.05, (v) => (doc.spec.width = v))
    num(cb, 'Height (m)', doc.spec.height ?? 1.4, 0.05, (v) => (doc.spec.height = v))
    num(cb, 'CG height (m)', doc.spec.cgHeight, 0.01, (v) => (doc.spec.cgHeight = v), 'above the ROAD, as a spec sheet gives it — not above the model origin')
    num(cb, 'Ride height (m)', doc.spec.rideHeight ?? 0.16, 0.01, (v) => (doc.spec.rideHeight = v), 'road to the bottom of the body; this is what positions the car')
    cb.append(select({
      label: 'Which end is the front',
      value: doc.spec.nose ?? 'auto',
      options: [{ value: 'auto' as const, label: 'Guess from the roofline' }, { value: 'keep' as const, label: 'As the model stands' }, { value: 'flip' as const, label: 'Turned round' }],
      note: 'a reconstruction does not say; the guess is right for most shapes and this fixes the rest',
      onChange: (v) => { doc.spec.nose = v; stage() },
    }))
    cb.append(select({
      label: 'Driven wheels',
      value: doc.spec.drive,
      options: [{ value: 'rwd' as const, label: 'Rear (RWD)' }, { value: 'fwd' as const, label: 'Front (FWD)' }, { value: 'awd' as const, label: 'All four (AWD)' }],
      note: 'a fact about the car, so it beats whatever the handling profile says',
      onChange: (v) => { doc.spec.drive = v; stage() },
    }))
    /*
     * WEIGHT DISTRIBUTION AND RUBBER — the two things that decide what the car does in a bend, and
     * the two that were missing. Both are shown with what they DO beside them, because "0.6" and
     * "255" are not numbers anybody can feel.
     */
    cb.append(slider({
      label: 'Weight on the front axle', value: frontShare(doc.spec), min: 0.2, max: 0.8, step: 0.005,
      neutral: 0.5, resettable: true,
      note: 'a front-engined saloon is about 0.55, a mid-engined car 0.42, a 911 about 0.38',
      onInput: (v) => { doc.spec.weightFront = +v.toFixed(3); live() },
    }))
    num(cb, 'Front tyres (mm)', doc.spec.tyreFront_mm ?? TYRE_REFERENCE_MM, 5, (v) => (doc.spec.tyreFront_mm = v))
    num(cb, 'Rear tyres (mm)', doc.spec.tyreRear_mm ?? TYRE_REFERENCE_MM, 5, (v) => (doc.spec.tyreRear_mm = v), 'section width, as a tyre is written: 255 front, 305 rear')
    const grip = axleGrip(doc.spec)
    const bias = grip.front / grip.rear
    cb.append(readout('Grip balance', `front ×${grip.front.toFixed(3)} · rear ×${grip.rear.toFixed(3)} — ${
      Math.abs(bias - 1) < 0.01 ? 'even' : bias < 1 ? `${((1 / bias - 1) * 100).toFixed(0)}% toward understeer` : `${((bias - 1) * 100).toFixed(0)}% toward oversteer`}`))
    const comCm = doc.spec.wheelbase * (frontShare(doc.spec) - 0.5) * 100
    cb.append(readout('Mass sits', Math.abs(comCm) < 1 ? 'in the middle of the wheelbase'
      : `${Math.abs(comCm).toFixed(0)} cm ${comCm > 0 ? 'ahead of' : 'behind'} the middle`))
    if (doc.spec.track > 0 && doc.spec.cgHeight > 0) {
      cb.append(readout('Stability factor', (doc.spec.track / 2 / doc.spec.cgHeight).toFixed(2)))
    }
    put('basic', chassis)

    const lamps = lampCounts(doc.spec)
    const lights = group('Lights', { note: 'night traffic. Two across a car, one on a motorcycle, unless you set them' })
    const lb = bodyOf(lights)
    num(lb, 'Headlights', doc.spec.headlights ?? lamps.headlights, 1, (v) => { doc.spec.headlights = Math.max(0, Math.round(v)) }, 'across the front. 0 is none')
    num(lb, 'Tail lights', doc.spec.taillights ?? lamps.taillights, 1, (v) => { doc.spec.taillights = Math.max(0, Math.round(v)) }, 'across the rear, and they throw red light')
    put('basic', lights)

    /* ---- handling ------------------------------------------------------------------------- */
    const handling = group('Handling', { note: 'a profile plus what this car differs by — never a copy of all forty numbers' })
    const hb = bodyOf(handling)
    const ids = Object.keys(PROFILES)
    hb.append(select({
      label: 'Profile', value: doc.profile.base,
      options: ids.map((id) => ({ value: id, label: PROFILES[id].name })),
      note: PROFILES[doc.profile.base]?.note,
      onChange: (v) => { doc.profile.base = v; stage() },
    }))
    hb.append(select({
      label: 'Blend toward', value: doc.profile.blendWith ?? '',
      options: [{ value: '', label: 'nothing — use the profile as it is' }, ...ids.filter((id) => id !== doc.profile.base).map((id) => ({ value: id, label: PROFILES[id].name }))],
      note: 'for a car that wants to sit between two of them rather than pick a side',
      onChange: (v) => { if (v) doc.profile.blendWith = v; else { delete doc.profile.blendWith; delete doc.profile.blend }; stage() },
    }))
    if (doc.profile.blendWith) {
      hb.append(slider({
        label: `${PROFILES[doc.profile.base]?.name ?? doc.profile.base} → ${PROFILES[doc.profile.blendWith]?.name ?? doc.profile.blendWith}`,
        value: doc.profile.blend ?? 0.5, min: 0, max: 1, step: 0.01,
        onInput: (v) => { doc.profile.blend = v; live() },
      }))
    }
    put('basic', handling)

    /* ---- the finish ------------------------------------------------------------------------ */
    /*
     * THE MATERIAL, NOT A GAIN ON IT.
     *
     * Rich, 2026-10-05: *"the car seems to apply some sort of blur or matte effect on the
     * environment reflections ... car shine just seems to change the reflection gain but not the
     * material blend"*. Every car was forced to `roughness ≤ 0.28, metalness ≥ 0.5`, so the paint
     * could only get brighter, never smoother — these four numbers are the surface itself. The F6
     * REFLECT and CAR_SHINE dials still move the whole fleet; a value saved here multiplies them
     * (reflect, shine) or replaces the forced default (roughness, metalness).
     */
    const finish = group('Finish', { note: 'what the paint is made of, per vehicle. F6 REFLECT and CAR_SHINE still move every car — these are this car’s own numbers' })
    const fb = bodyOf(finish)
    const fin = doc.finish ?? {}
    const isChrome = fin.chrome === true
    const finishSlider = (label: string, key: 'roughness' | 'metalness' | 'reflect' | 'shine', def: number, max: number, note: string) => {
      fb.append(slider({
        label, value: fin[key] ?? def, min: 0, max, step: 0.01,
        neutral: def, resettable: true,
        note: fin[key] === undefined ? `${note} — default` : note,
        onInput: (v) => {
          doc.finish ??= {}
          if (Math.abs(v - def) < 1e-9) delete doc.finish[key]
          else doc.finish[key] = v
          if (doc.finish && !Object.keys(doc.finish).length) delete doc.finish
          live()
        },
      }))
    }
    /*
     * THE ONE-CLICK MIRROR. Rich, 2026-10-05: *"the chrome mirror look should be both a vehicle
     * option and a tuning panel option, that is bad ass"*. The chrome flag is that vehicle option;
     * F6 `CAR_CHROME` is the fleet-wide one. It overrides the two sliders below, so they are hidden
     * while it is on rather than sitting there doing nothing.
     */
    fb.append(toggle({
      label: 'Chrome mirror',
      value: isChrome,
      note: 'mirror-smooth and fully metallic, so the paint reflects the world like polished metal. Overrides roughness and metalness; turn on the F6 car probe to see the surroundings in it',
      onChange: (v) => {
        doc.finish ??= {}
        if (v) doc.finish.chrome = true
        else delete doc.finish.chrome
        if (doc.finish && !Object.keys(doc.finish).length) delete doc.finish
        stage()
      },
    }))
    if (isChrome) {
      fb.append(el('div', 'field-note', 'Chrome overrides paint roughness and metalness. Reflection strength and clearcoat below still multiply the global dials.'))
    } else {
      finishSlider('Paint roughness', 'roughness', 0.28, 1, '0 is a mirror, 1 is flat matte — the number that decides whether it reads as paint or plastic')
      finishSlider('Paint metalness', 'metalness', 0.5, 1, '0 is plastic/dielectric, 1 is chrome')
    }
    finishSlider('Reflection strength', 'reflect', 1, 4, 'times the global REFLECT — raise it for a car that mirrors the world harder')
    finishSlider('Clearcoat', 'shine', 1, 3, 'times the global CAR_SHINE — the wet-looking coat over the paint')
    fb.append(el('div', 'field-note', 'a mirror-finish car is roughness near 0, metalness 1 and reflectance up (or just tick Chrome); a matte wrap is roughness near 1, metalness 0'))
    put('finish', finish)

    /* ---- the drivetrain -------------------------------------------------------------------- */
    const eng = group('Engine, gearing and brakes', {})
    const eb = bodyOf(eng)
    num(eb, 'Power (kW)', doc.engine.power_kw, 5, (v) => (doc.engine.power_kw = v), `${Math.round(doc.engine.power_kw * 1.341)} hp`)
    const pt = peakTorque(doc.engine)
    num(eb, 'Peak torque (N·m)', doc.engine.torque_nm ?? Math.round(pt.nm), 5, (v) => (doc.engine.torque_nm = v),
      pt.estimated ? 'ESTIMATED from power and redline — type a real one if you have it' : 'as given')
    num(eb, 'Redline (rpm)', doc.engine.redline_rpm, 100, (v) => (doc.engine.redline_rpm = v))
    num(eb, 'Idle (rpm)', doc.engine.idle_rpm, 50, (v) => (doc.engine.idle_rpm = v))
    num(eb, 'Final drive', doc.engine.final_drive, 0.01, (v) => (doc.engine.final_drive = v),
      `${FINAL_DRIVE_MIN}…${FINAL_DRIVE_MAX} is the range a differential is actually built in`)
    /*
     * THE FIELD PEOPLE ACTUALLY THINK IN, and it writes back.
     *
     * Rich, 2026-09-29: *"we should make the top speed calculated by the gearing like it is now,
     * but if you edit it will change the final drive ratio to match, and bound it as an error
     * condition if it is out of bounds"*. So this is derived until you type in it, at which point
     * it solves for the final drive — wheel radius, redline and top gear all in the arithmetic —
     * and an unreachable answer becomes an error on the form rather than a silently absurd diff.
     */
    const geared = gearedTopSpeed(doc.engine, doc.spec.wheelRadius)
    eb.append(textField({
      label: 'Geared top speed (mph)', value: (geared * 2.237).toFixed(0), type: 'number', step: 1,
      note: 'type a speed and the final drive is solved for it — at the redline in top gear',
      onChange: (v) => {
        const mph = Number(v)
        if (!Number.isFinite(mph) || mph <= 0) return
        doc.engine.final_drive = +finalDriveFor(doc.engine, doc.spec.wheelRadius, mph / 2.237).toFixed(3)
        stage()
      },
    }))
    /*
     * GEAR FOR THE SPEED IT REALLY REACHES, not the speed you typed. The sim's top speed
     * (`estimateVmax`) is set by power, grip and drag together; gearing top gear to it puts the
     * redline at the wall instead of leaving the engine droning below it. Iterated because the
     * final drive feeds back into the derived `topSpeed` the estimate reads, until it settles.
     */
    const vmax = estimateVmax(doc)
    const vmaxMph = Math.round(vmax * 2.237)
    eb.append(readout(
      'Physics top speed',
      vmax > 0 ? `${vmaxMph} mph · ${vmax.toFixed(1)} m/s` : 'no terminal speed — the profile has no drag',
    ))
    eb.append(button({
      label: vmax > 0 ? `Gear top for ${vmaxMph} mph` : 'Gear top for the physical top speed',
      title: 'sets the final drive so top gear redlines at the speed the car actually reaches',
      disabled: !(vmax > 0),
      onClick: () => {
        // ONE pass. The final drive also feeds the derived `topSpeed` the estimate reads, so a
        // second pass chases its own tail (shorter gearing raises first-gear force but lowers the
        // ceiling); this lands top gear on the estimate as it stands.
        doc.engine.final_drive = +finalDriveFor(doc.engine, doc.spec.wheelRadius, vmax).toFixed(3)
        stage()
      },
    }))
    put('engine', eng)

    /*
     * THE GEARBOX: one field per gear, and add/remove.
     *
     * It was a comma-separated string, which is one typo away from silently losing a gearbox — and
     * "how many gears has it got" is a thing somebody sets deliberately rather than by counting
     * commas.
     */
    const gears = group(`Gearbox — ${doc.engine.gears.length} speed`, {})
    const gb = bodyOf(gears)
    // WHAT EACH GEAR IS GOOD FOR: the speed it reaches at the redline. "10938 rpm at 60 mph" is
    // also true of first gear and reads like a fault; "up to 38 mph" is the gear chart everybody
    // has seen, and a box whose gears do not climb evenly is obvious at a glance.
    const topOf = (ratio: number) => (doc.engine.redline_rpm / 60) / (ratio * doc.engine.final_drive) * 2 * Math.PI * doc.spec.wheelRadius * 2.237
    doc.engine.gears.forEach((ratio, i) => {
      const row = el('div', 'bld-gear')
      row.append(textField({
        label: `Gear ${i + 1}${i === doc.engine.gears.length - 1 ? ' (top)' : ''}`,
        value: String(ratio), type: 'number', step: 0.01,
        // WHAT THE RATIO MEANS AT A SPEED YOU KNOW. 3.36 is not a number anybody feels; "4600 rpm
        // at 60 mph" is, and it is what tells you the box is geared wrong before you drive it.
        note: `up to ${topOf(ratio).toFixed(0)} mph`,
        onChange: (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) { doc.engine.gears[i] = n; stage() } },
      }))
      row.append(button({
        icon: 'trash', variant: 'ghost', title: `Remove gear ${i + 1}`,
        disabled: doc.engine.gears.length <= 1,
        onClick: () => { doc.engine.gears = rebalanceGears(doc.engine.gears, doc.engine.gears.length - 1); stage() },
      }))
      gb.append(row)
    })
    const gfoot = el('div', 'panel-actions')
    gfoot.append(button({
      label: 'Add a gear', icon: 'plus',
      // REBALANCED, NOT APPENDED. Bolting another ratio onto the end lengthened the car's gearing
      // every time — seven speeds and it was geared for 300 mph. Rich: "when adding gears rebalance
      // the other gears between the low and high gear. Removing gears do the same." Both ends stay,
      // the middle is re-spaced geometrically, and the top speed does not move.
      onClick: () => { doc.engine.gears = rebalanceGears(doc.engine.gears, doc.engine.gears.length + 1); stage() },
    }))
    gb.append(el('div', 'field-note', 'the first and last ratios are yours; adding or removing re-spaces the ones between them so every shift drops the same proportion of the revs'))
    gb.append(gfoot)
    put('engine', gears)

    const brakes = group('Brakes', {})
    const bb = bodyOf(brakes)
    num(bb, 'Brake torque (N·m)', doc.engine.brake_torque_nm, 50, (v) => (doc.engine.brake_torque_nm = v))
    bb.append(slider({
      label: 'Brake bias (front)', value: doc.engine.brake_bias, min: 0, max: 1, step: 0.01,
      onInput: (v) => { doc.engine.brake_bias = v; live() },
    }))
    // WHAT THE NUMBERS MEAN, computed rather than found out by driving.
    const resolved = toDriveProfile(doc)
    const top = gearedTopSpeed(doc.engine, doc.spec.wheelRadius)
    const reach = estimateVmax(doc)
    bb.append(readout('Top speed', `${(reach * 2.237).toFixed(0)} mph · ${reach.toFixed(1)} m/s`))
    bb.append(readout('Geared for', `${(top * 2.237).toFixed(0)} mph at the redline in top${top > reach + 0.5 ? ' — power, grip or drag stops it first' : ' — the gearbox is what limits it'}`))
    bb.append(readout('Pull in first', `${(tractiveForce(doc.engine, doc.spec.wheelRadius) / 1000).toFixed(1)} kN`))
    bb.append(readout('Standing acceleration', `${resolved.powerPerKg.toFixed(1)} m/s² before the tyres get a say`))
    put('engine', brakes)

    /* ---- audio ------------------------------------------------------------------------------ */
    const audio = group('Engine sound', {})
    const ab = bodyOf(audio)
    const choices = engineChoices()
    ab.append(select({
      label: 'enginesim setup', value: doc.audio.setup,
      options: choices.some((c) => c.value === doc.audio.setup) ? choices : [{ value: doc.audio.setup, label: `${doc.audio.setup} (not in this build)` }, ...choices],
      note: `${choices.length} engine scripts in this build`,
      onChange: (v) => { doc.audio.setup = v; stage() },
    }))
    ab.append(slider({ label: 'Gain', value: doc.audio.gain, min: 0, max: 1, step: 0.01, onInput: (v) => { doc.audio.gain = v; bench.setGain(v); live() } }))
    ab.append(slider({ label: 'Low-pass (Hz)', value: doc.audio.lowpass_hz, min: 200, max: 20000, step: 100, onInput: (v) => { doc.audio.lowpass_hz = v; bench.setLowpass(v); live() } }))
    ab.append(slider({ label: 'Heard from the cabin', value: doc.audio.cabin_mix, min: 0, max: 1, step: 0.01, onInput: (v) => { doc.audio.cabin_mix = v; live() } }))
    const status = el('div', 'field-note', '')
    const say = (st: ListenState) => {
      status.textContent = st.at === 'running' ? `running — ${st.engine}`
        : st.at === 'starting' ? 'starting the audio worklet…'
        : st.at === 'failed' ? `could not start: ${st.why}` : ''
      status.classList.toggle('field-error', st.at === 'failed')
    }
    const row = el('div', 'panel-actions')
    row.append(button({
      label: 'Listen', icon: 'play',
      // THE CAR'S REV RANGE, not the script's. Otherwise the slider's top is somebody else's
      // redline and the bench describes an engine this car does not have.
      onClick: () => void bench.listen({
        setup: doc.audio.setup, gain: doc.audio.gain, lowpass: doc.audio.lowpass_hz,
        revs: { idle: doc.engine.idle_rpm, redline: doc.engine.redline_rpm },
        throttle: 0.35, seconds: 20, onState: say,
      }),
    }))
    row.append(button({ label: 'Stop', variant: 'ghost', onClick: () => { void bench.stop().then(() => say({ at: 'stopped' })) } }))
    ab.append(row)
    ab.append(slider({
      label: `Revs — ${doc.engine.idle_rpm} to ${doc.engine.redline_rpm} rpm`, value: 0.35, min: 0, max: 1, step: 0.01,
      note: 'this car’s own range on the bench — a dyno, and it does not touch the saved numbers',
      onInput: (v) => { bench.setRevs({ idle: doc.engine.idle_rpm, redline: doc.engine.redline_rpm }); bench.rev(v) },
    }))
    /*
     * WHAT THE TOP OF THE SLIDER REALLY IS. A script's own redline is only known once it is
     * loaded — the catalog carries a path, a group and a name and nothing else — so this can only
     * be honest while the bench is running, and it says so rather than guessing beforehand.
     */
    const running = bench.revRangeNow
    ab.append(readout('At the top of the slider', running
      ? `${running.redline.toFixed(0)} rpm${running.redline < doc.engine.redline_rpm - 1
        ? ` — your ${doc.engine.redline_rpm} held back to what this script revs to` : ''}`
      : `${doc.engine.redline_rpm} rpm, this car's redline`))
    ab.append(status)
    put('sound', audio)

    /* ---- the sampled sounds: crashes, squeal, guns, by slot ------------------------------- */
    if (section === 'sounds') put('sounds', soundsGroup({ get: () => doc.sounds, set: (o) => { if (o) doc.sounds = o; else delete doc.sounds; stage() }, assetId: opts.assetId ?? null }))

    /* ---- mounted weapons -------------------------------------------------------------------- */
    const arms = group(`Weapons${doc.mounts?.length ? ` — ${doc.mounts.length}` : ''}`, {
      collapsed: !doc.mounts?.length,
      note: weaponIds === undefined ? 'reading the armoury…'
        : weaponIds.length ? `${weaponIds.length} built weapon${weaponIds.length === 1 ? '' : 's'} to choose from`
        : 'none built yet — the Weapons tab is where one is made',
    })
    const wb = bodyOf(arms)
    for (const [i, m] of (doc.mounts ?? []).entries()) {
      const row = el('div', 'panel-actions')
      if (weaponIds?.length) {
        row.append(select({
          value: m.weapon,
          options: [...new Set([m.weapon, ...weaponIds])].filter(Boolean).map((id) => ({ value: id, label: id })),
          onChange: (v) => { doc.mounts![i].weapon = v; stage() },
        }))
      } else {
        row.append(textField({ label: `Weapon ${i + 1}`, value: m.weapon, onChange: (v) => { doc.mounts![i].weapon = v.trim(); stage() } }))
      }
      row.append(select({
        value: m.at,
        options: VEHICLE_MOUNTS.map((v) => ({ value: v, label: v })),
        onChange: (v) => { doc.mounts![i].at = v as VehicleMount; stage() },
      }))
      row.append(button({ label: 'Remove', variant: 'ghost', onClick: () => { doc.mounts!.splice(i, 1); if (!doc.mounts!.length) delete doc.mounts; stage() } }))
      wb.append(row)
      // WHERE IT ACTUALLY ENDS UP, derived from this car's own chassis rather than typed in.
      const at = mountPoint(doc.spec, m.at)
      wb.append(readout(`  ${m.at}`, `${at.x.toFixed(2)} forward · ${at.y.toFixed(2)} up · ${at.z.toFixed(2)} right · pointing ${((mountYaw(m) * 180) / Math.PI).toFixed(0)}°`))
    }
    const wfoot = el('div', 'panel-actions')
    wfoot.append(button({
      label: 'Mount a weapon', icon: 'plus',
      onClick: () => { (doc.mounts ??= []).push({ weapon: weaponIds?.[0] ?? '', at: 'roof' }); stage() },
    }))
    wb.append(wfoot)
    put('other', arms)

    /* ---- the overrides, GENERATED ---------------------------------------------------------- */
    const base = PROFILES[doc.profile.base] ?? PROFILES.street
    const setKeys = Object.keys(doc.profile.overrides ?? {})
    const over = group(`Overrides${setKeys.length ? ` — ${setKeys.length} set` : ''}`, {
      collapsed: !setKeys.length,
      note: 'every number on the profile, generated from its own keys — a knob added to the engine appears here on its own',
    })
    const ob = bodyOf(over)
    for (const key of Object.keys(base) as (keyof DriveProfile)[]) {
      const def = base[key]
      if (typeof def !== 'number') continue
      const set = doc.profile.overrides?.[key]
      const liveValue = (resolved[key] as number) ?? def
      const range = overrideRange(def)
      ob.append(slider({
        label: key, value: set ?? liveValue,
        min: range.min, max: range.max, step: range.step,
        neutral: def, resettable: true,
        note: set === undefined ? `profile: ${round(liveValue)}` : `overridden — profile says ${round(def)}`,
        onInput: (v) => {
          doc.profile.overrides ??= {}
          if (Math.abs(v - def) < 1e-9) delete doc.profile.overrides[key]
          else doc.profile.overrides[key] = v
          live()
        },
      }))
    }
    put('other', over)
  }

  render()
  return render
}

function round(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4)
}

/** The buttons that start a document off. Named after what they are: a choice, not a guess. */
function templatePicker(onPick: (t: string) => void): HTMLElement {
  const row = el('div', 'panel-actions')
  for (const t of VEHICLE_TEMPLATE_IDS) row.append(button({ label: t, onClick: () => onPick(t) }))
  return row
}

/* ================================================================================================
 * The detail pane extension — the same form, staged through the pane's own draft
 * ============================================================================================= */

export function vehicleDetail(item: AssetItem, host: HTMLElement, ctx: VehicleCtx): void {
  if (!isVehicle(ctx.kind)) return
  const stored = item.vehicle as VehicleDoc | null | undefined
  let doc: VehicleDoc | null = stored ? structuredClone(stored) : null

  const g = group('Dynamics', { note: doc ? describeVehicle(doc) : undefined })
  const body = bodyOf(g)
  host.append(g)

  const { count: rigWheels } = wheelBoneCount(
    (item.rig as RigBinding | null | undefined)?.roles?.wheel,
    ctx.mesh3d?.rig()?.roles?.wheel,
  )

  const draw = () => {
    body.replaceChildren()
    if (!doc) {
      /*
       * NOTHING IS INVENTED FOR A CAR THAT HAS NONE. The first version rendered the class template
       * here, so an asset with no dynamics showed a full set of numbers that were not its own.
       */
      body.append(el('div', 'field-note', `No dynamics saved. This ${ctx.kind} drives the engine's default chassis — pick a starting point to give it its own.`))
      body.append(templatePicker((t) => { doc = defaultVehicle(t); ctx.edit({ vehicle: structuredClone(doc) }); draw() }))
      return
    }
    const form = el('div')
    body.append(form)
    dynamicsForm(form, () => doc!, {
      rigWheels,
      meshes: { finished: !!item.finished, raw: !!item.mesh },
      onChange: (d) => ctx.edit({ vehicle: structuredClone(d) }),
    })
    const foot = el('div', 'panel-actions')
    foot.append(button({
      label: 'Start again from a template', variant: 'ghost',
      onClick: () => { doc = null; draw() },
    }))
    body.append(foot)
  }
  draw()
}


/* ================================================================================================
 * THE FLEET
 *
 * All the workflow is `buildScreen` — see the essay at the top of `ui/buildscreen.ts` for why a
 * vehicle is not a catalog row. What is left here is what makes a vehicle a vehicle.
 * ============================================================================================= */

/** What the Vehicles screen needs to know about a vehicle, and nothing else. */
export const VEHICLE_BUILD: BuildSpec<VehicleDoc> = {
  kind: 'vehicles',
  noun: 'vehicle',
  assetType: 'vehicle',
  classes: CLASSES_BY_TYPE.vehicle,
  icon: 'cube',
  emptyTitle: 'No vehicles yet',
  emptyBlurb: 'A vehicle is a model from the library plus the dynamics that make it drive — mass, '
    + 'drivetrain, gearing, handling and engine sound. The library’s cars are visuals; this is where '
    + 'one becomes something you can drive.',
  presets: (kind) => presetsFor(kind).map((p): BuildPreset<VehicleDoc> => ({ id: p.id, name: p.name, note: p.note, doc: presetDoc(p.id) ?? p.doc })),
  defaultDoc: (kind) => defaultVehicle(kind ?? 'hero-car'),
  describe: describeVehicle,
  summary: (d) => `${d.spec.mass} kg · ${Math.round(d.engine.power_kw * 1.341)} hp · ${d.spec.drive.toUpperCase()}`,
  tags: (d) => [{ text: `${d.engine.gears.length}-speed` }, { text: d.profile.base }],
  form: (host, getDoc, onChange, asset) => void dynamicsForm(host, getDoc, {
    meshes: asset ? { finished: !!asset.finished, raw: !!asset.mesh } : null,
    assetId: asset?.id ?? null,
    onChange: (doc) => onChange(doc),
  }),
  errors: (d) => validateVehicle(d, { audioSetups: engineSetups() }).errors,
}

/** What the asset library mounts: the fleet tab, and the dynamics section on a vehicle's detail pane. */
export function vehicleExtension(): { tabs: Tab[]; detail: (item: AssetItem, host: HTMLElement, ctx: VehicleCtx) => void } {
  return {
    tabs: [{ id: 'vehicles', label: 'Vehicles', icon: 'cube', build: (host) => buildScreen(host, VEHICLE_BUILD) }],
    detail: vehicleDetail,
  }
}
