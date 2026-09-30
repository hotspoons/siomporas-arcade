// The Traffic tab: which vehicles the traffic is made of.
//
// Rich, 2026-09-29: *"Need to be able to select vehicles to comprise traffic too."*
//
// The fourth build screen and the least code of the four, because `buildScreen` already does the
// work — this supplies what a traffic set IS and nothing else. A set has no model of its own, which
// is why "no model for now" is the normal path here rather than an escape hatch: the models are the
// vehicles in the mix.
import { assetsvc, type Build } from '../assetsvc'
import { CLASSES_BY_TYPE } from '../classes'
import { buildScreen, type BuildPreset, type BuildSpec } from './buildscreen'
import { bodyOf, group, readout, select, slider, textField } from './controls'
import { button, el, type Tab } from './shell'
import {
  describeSet, expected, shares, TRAFFIC_SET_PRESETS, trafficSetPresetDoc, validateSet,
  type TrafficSetDoc,
} from '../trafficsets'
import type { VehicleDoc } from '../vehicles'

/**
 * The mix editor: a row per vehicle, a weight, and what that means in cars.
 *
 * THE SHARE IS SHOWN, NOT THE WEIGHT ALONE. "Weight 3" answers nothing on its own; "43%, about 9
 * cars per kilometre of two-lane road" is the thing somebody is actually choosing. The weights stay
 * editable because they are what survives adding a fifth vehicle.
 */
export function trafficSetForm(host: HTMLElement, getDoc: () => TrafficSetDoc, onChange: (doc: TrafficSetDoc) => void): () => void {
  /** the vehicle builds that exist, for the picker and for validation */
  let vehicles: string[] | undefined
  void assetsvc.builds<Build<VehicleDoc>>('vehicles')
    .then((vs) => { vehicles = vs.map((v) => v.id); render() })
    .catch(() => { /* no service: the picker falls back to a text field */ })

  function render() {
    const doc = getDoc()
    host.replaceChildren()
    const report = validateSet(doc, { vehicles })
    if (report.errors.length || report.warnings.length) {
      const box = el('div', 'panel-note')
      for (const e of report.errors) box.append(el('div', 'field-error', e))
      for (const w of report.warnings) box.append(el('div', 'field-note', w))
      host.append(box)
    }
    const stage = () => { onChange(doc); render() }
    const live = () => onChange(doc)

    const mix = group(`The mix — ${(doc.mix ?? []).length} vehicle${(doc.mix ?? []).length === 1 ? '' : 's'}`, {
      note: vehicles === undefined ? 'reading the fleet…'
        : vehicles.length ? `${vehicles.length} built vehicle${vehicles.length === 1 ? '' : 's'} to choose from`
        : 'none built yet — the Vehicles tab is where one is made',
    })
    const mb = bodyOf(mix)
    const share = Object.fromEntries(shares(doc).map((s) => [s.vehicle, s.share]))
    const per = Object.fromEntries(expected(doc, 100).map((e) => [e.vehicle, e.count]))

    doc.mix ??= []
    for (const [i, m] of doc.mix.entries()) {
      const row = el('div', 'panel-actions')
      if (vehicles?.length) {
        row.append(select({
          value: m.vehicle,
          options: [...new Set([m.vehicle, ...vehicles])].filter(Boolean).map((v) => ({ value: v, label: v })),
          onChange: (v) => { doc.mix[i].vehicle = v; stage() },
        }))
      } else {
        row.append(textField({ label: `Vehicle ${i + 1}`, value: m.vehicle, onChange: (v) => { doc.mix[i].vehicle = v.trim(); stage() } }))
      }
      row.append(textField({
        label: 'weight', value: String(m.weight), type: 'number', step: 1,
        onChange: (v) => { const n = Number(v); if (Number.isFinite(n)) { doc.mix[i].weight = n; stage() } },
      }))
      row.append(button({ label: 'Remove', variant: 'ghost', onClick: () => { doc.mix.splice(i, 1); stage() } }))
      mb.append(row)
      if (m.vehicle && share[m.vehicle]) {
        mb.append(readout(`  ${m.vehicle}`, `${Math.round(share[m.vehicle] * 100)}% — about ${per[m.vehicle]} in every hundred cars`))
      }
    }
    const foot = el('div', 'panel-actions')
    foot.append(button({
      label: 'Add a vehicle', icon: 'plus',
      onClick: () => { doc.mix.push({ vehicle: vehicles?.[0] ?? '', weight: 10 }); stage() },
    }))
    mb.append(foot)
    host.append(mix)

    const who = group('Who is driving', { note: 'a zone may override both of these where it is painted' })
    const wb = bodyOf(who)
    wb.append(slider({
      label: 'stop for a red', value: doc.obeyRate ?? 0.97, min: 0, max: 1, step: 0.01,
      note: 'the share who do. The ones who do not are what makes a junction feel unsafe',
      onInput: (v) => { doc.obeyRate = v; live() },
    }))
    wb.append(slider({
      label: 'speed, × the limit', value: doc.speedFactor ?? 1, min: 0.4, max: 1.6, step: 0.01,
      onInput: (v) => { doc.speedFactor = v; live() },
    }))
    host.append(who)
  }

  render()
  return render
}

/** What the Traffic screen needs to know about a traffic set, and nothing else. */
export const TRAFFIC_BUILD: BuildSpec<TrafficSetDoc> = {
  kind: 'traffic',
  noun: 'traffic set',
  assetType: 'vehicle',
  classes: CLASSES_BY_TYPE.vehicle,
  icon: 'queue-list',
  emptyTitle: 'No traffic sets yet',
  emptyBlurb: 'A traffic set is the vehicles the traffic is made of and how common each one is. '
    + 'A zone you paint says how BUSY a road is; a set says what is on it. It has no model of its '
    + 'own — the models are the vehicles in the mix — so skip the model step.',
  presets: () => TRAFFIC_SET_PRESETS.map((p): BuildPreset<TrafficSetDoc> => ({
    id: p.id, name: p.name, note: p.note, doc: trafficSetPresetDoc(p.id) ?? p.doc,
  })),
  defaultDoc: () => ({ mix: [], obeyRate: 0.97 }),
  describe: describeSet,
  summary: (d) => describeSet(d),
  tags: (d) => {
    const n = shares(d).length
    const out: { text: string; cls?: string }[] = [{ text: `${n} vehicle${n === 1 ? '' : 's'}`, cls: n ? undefined : 'warn' }]
    if (d.obeyRate !== undefined && d.obeyRate < 0.95) out.push({ text: `${Math.round(d.obeyRate * 100)}% obey`, cls: 'warn' })
    if (d.speedFactor !== undefined && d.speedFactor !== 1) out.push({ text: `${d.speedFactor.toFixed(2)}× limit` })
    return out
  },
  form: (host, getDoc, onChange) => void trafficSetForm(host, getDoc, onChange),
  errors: (d) => validateSet(d).errors,
}

/** The tab to hand `AssetCatalog`. */
export function trafficExtension(): { tabs: Tab[] } {
  return { tabs: [{ id: 'traffic', label: 'Traffic', icon: 'queue-list', build: (host) => buildScreen(host, TRAFFIC_BUILD) }] }
}
