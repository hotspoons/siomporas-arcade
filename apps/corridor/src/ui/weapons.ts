// The Weapons tab, and the Ballistics group on a weapon's detail pane.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md §3. Third of three, same shape as the other two, and the
// document with all of its arithmetic is in `src/weapons.ts`.
//
// WHAT THE FORM SHOWS THAT THE DOCUMENT DOES NOT SAY: a weapon is balanced against a target, not in
// isolation. `34 damage at 9 per second` means nothing until you know it drops an ordinary person
// in four hits over a third of a second, that the magazine lasts three and a third seconds, and
// that the cone is 2 m across at its own maximum range. All of those are derived, all of them are
// shown beside the fields they come from, and the raw spec is what you edit.
import { type AssetItem, type RigBinding } from '../assetsvc'
import {
  burstDps, defaultWeapon, describeWeapon, dropAt, flightTime, magazineSeconds, shotsToKill,
  spreadRadiusAt, sustainedDps, validateWeapon, WEAPON_CLASS, WEAPON_KINDS, WEAPON_TEMPLATE_IDS,
  type WeaponDoc, type WeaponKind,
} from '../weapons'
import { weaponPresetDoc, weaponPresetsFor } from '../weaponpresets'
import { CLASSES_BY_TYPE } from '../classes'
import type { AssetDetailCtx } from './assets'
import { buildScreen, type BuildPreset, type BuildSpec } from './buildscreen'
import { bodyOf, group, readout, select, setGroupError, slider, textField } from './controls'
import { el, type Tab } from './shell'

export function isWeapon(kind: string): boolean {
  return kind === WEAPON_CLASS
}

export interface WeaponFormOpts {
  /** bone roles the holder's rig binds, when anything knows them */
  rigRoles?: string[]
  onChange: (doc: WeaponDoc, live: boolean) => void
  onReport?: (errors: number) => void
}

/**
 * The whole ballistics editor, rendered into `host`. Returns a `rebuild`.
 *
 * ONE of it, used by the Weapons screen and by the detail pane, for the same reason as the vehicle
 * and actor forms: two copies of a form over one document is two places for a field to go missing.
 */
export function weaponForm(host: HTMLElement, getDoc: () => WeaponDoc, opts: WeaponFormOpts): () => void {
  const roles = opts.rigRoles ?? []

  function render() {
    const doc = getDoc()
    host.replaceChildren()
    const body = host
    const report = validateWeapon(doc, { rigRoles: roles.length ? roles : undefined })
    opts.onReport?.(report.errors.length)
    if (report.errors.length || report.warnings.length) {
      const box = el('div', 'panel-note')
      for (const e of report.errors) box.append(el('div', 'field-error', e))
      for (const w of report.warnings) box.append(el('div', 'field-note', w))
      body.append(box)
    }
    const stage = () => { opts.onChange(doc, false); render() }
    const live = () => opts.onChange(doc, true)

    const num = (into: HTMLElement, label: string, value: number, step: number, set: (v: number) => void, note?: string) => {
      into.append(textField({
        label, value: String(value), type: 'number', step, note,
        onChange: (v) => { const n = Number(v); if (Number.isFinite(n)) { set(n); stage() } },
      }))
    }

    const what = group('What it is', {})
    const wb = bodyOf(what)
    wb.append(select({
      label: 'Kind',
      value: doc.kind,
      options: WEAPON_KINDS.map((k) => ({ value: k, label: k })),
      note: 'melee has no magazine and no muzzle velocity; a beam has no spread',
      onChange: (v) => { doc.kind = v as WeaponKind; stage() },
    }))
    num(wb, 'Damage per hit', doc.damage, 1, (v) => (doc.damage = v))
    num(wb, 'Rate (per second)', doc.rate_per_s, 0.1, (v) => (doc.rate_per_s = v))
    num(wb, 'Magazine', doc.magazine, 1, (v) => (doc.magazine = v), '0 = never reloads')
    num(wb, 'Reload (s)', doc.reload_s, 0.1, (v) => (doc.reload_s = v))
    body.append(what)

    const shot = group('The shot', {})
    const sb = bodyOf(shot)
    num(sb, 'Muzzle speed (m/s)', doc.muzzle_ms, 10, (v) => (doc.muzzle_ms = v), '0 = HITSCAN: instant, no travel, no drop')
    num(sb, 'Range (m)', doc.range_m, 1, (v) => (doc.range_m = v))
    num(sb, 'Spread (° half-angle)', doc.spread_deg, 0.1, (v) => (doc.spread_deg = v))
    sb.append(slider({ label: 'Recoil', value: doc.recoil, min: 0, max: 1, step: 0.01, onInput: (v) => { doc.recoil = v; live() } }))
    num(sb, 'Impulse on hit (N·s)', doc.impulse, 10, (v) => (doc.impulse = v), 'what it does to the physics world — this is the seam with the engine')
    // The derived half: what the numbers above actually mean at the range this weapon works at.
    sb.append(readout('Cone at maximum range', `${(spreadRadiusAt(doc, doc.range_m) * 2).toFixed(2)} m across`))
    sb.append(readout('Time to maximum range', doc.muzzle_ms > 0 ? `${flightTime(doc, doc.range_m).toFixed(2)} s` : 'instant (hitscan)'))
    sb.append(readout('Drop at maximum range', doc.muzzle_ms > 0 ? `${dropAt(doc, doc.range_m).toFixed(2)} m` : 'none (hitscan)'))
    body.append(shot)

    const bal = group('What it does to somebody', { note: 'against an ordinary 100 hp person with no armour' })
    const bb = bodyOf(bal)
    bb.append(readout('Damage per second (held)', burstDps(doc).toFixed(1)))
    bb.append(readout('Damage per second (with reloads)', sustainedDps(doc).toFixed(1)))
    bb.append(readout('A magazine lasts', Number.isFinite(magazineSeconds(doc)) ? `${magazineSeconds(doc).toFixed(1)} s` : 'for ever'))
    const k = shotsToKill(doc, 100)
    bb.append(readout('To drop a person', Number.isFinite(k.hits) ? `${k.hits} hit${k.hits === 1 ? '' : 's'} · ${k.seconds.toFixed(2)} s` : 'never'))
    body.append(bal)

    const hold = group('How it is held', {})
    const hb = bodyOf(hold)
    if (roles.length) {
      hb.append(select({
        label: 'Attaches to', value: doc.attach,
        options: [...new Set([doc.attach, ...roles])].map((r) => ({ value: r, label: r })),
        onChange: (v) => { doc.attach = v; stage() },
      }))
    } else {
      hb.append(textField({ label: 'Attaches to', value: doc.attach, note: 'a bone role on whoever carries it — this asset has no rig bound, so it is not checked', onChange: (v) => { doc.attach = v.trim(); stage() } }))
    }
    hb.append(textField({ label: 'Fire sound', value: doc.audio.fire ?? '', onChange: (v) => { doc.audio.fire = v.trim() || undefined; stage() } }))
    hb.append(textField({ label: 'Reload sound', value: doc.audio.reload ?? '', onChange: (v) => { doc.audio.reload = v.trim() || undefined; stage() } }))
    body.append(hold)

  }

  render()
  return render
}

/* ---- the detail pane: the same form, staged through the pane's own draft --------------------- */

/** The Ballistics group. Renders nothing for anything that is not a weapon. */
export function weaponDetail(item: AssetItem, host: HTMLElement, ctx: AssetDetailCtx): void {
  if (!isWeapon(ctx.kind)) return

  const stored = item.weapon as WeaponDoc | null | undefined
  let doc: WeaponDoc = stored ? structuredClone(stored) : defaultWeapon()

  const g = group('Ballistics', {
    note: stored ? describeWeapon(doc) : 'no ballistics saved yet — these are pistol defaults, and nothing is stored until you save',
  })
  const body = bodyOf(g)
  host.append(g)

  const roles = Object.keys((item.rig as RigBinding | null | undefined)?.roles ?? {})
  const form = el('div')
  body.append(form)
  const rebuild = weaponForm(form, () => doc, {
    rigRoles: roles,
    onChange: (d) => ctx.edit({ weapon: structuredClone(d) }),
    onReport: (n) => setGroupError(g, n ? `${n} problem${n === 1 ? '' : 's'}` : null),
  })

  const foot = el('div', 'panel-actions')
  foot.append(select({
    label: 'Start from', value: '',
    options: [{ value: '', label: 'a template…' }, ...WEAPON_TEMPLATE_IDS.map((t) => ({ value: t, label: t }))],
    onChange: (v) => { if (v) { doc = defaultWeapon(v); ctx.edit({ weapon: structuredClone(doc) }); rebuild() } },
  }))
  body.append(foot)
}

/* ================================================================================================
 * The armoury
 * ============================================================================================= */

/** What the Weapons screen needs to know about a weapon, and nothing else. */
export const WEAPON_BUILD: BuildSpec<WeaponDoc> = {
  kind: 'weapons',
  noun: 'weapon',
  assetType: 'weapon',
  classes: CLASSES_BY_TYPE.weapon,
  icon: 'bolt',
  emptyTitle: 'No weapons yet',
  emptyBlurb: 'A weapon is a model from the library plus what it does — damage, rate, magazine, '
    + 'muzzle speed, spread and the impulse it delivers into the physics world. Actors carry these '
    + 'and vehicles mount them, so nothing can be armed until one exists.',
  presets: (kind) => weaponPresetsFor(kind).map((p): BuildPreset<WeaponDoc> => ({ id: p.id, name: p.name, note: p.note, doc: weaponPresetDoc(p.id) ?? p.doc })),
  defaultDoc: () => defaultWeapon(),
  describe: describeWeapon,
  summary: (d) => `${d.damage} dmg · ${sustainedDps(d).toFixed(0)} dps · ${d.range_m} m`,
  tags: (d) => {
    const out: { text: string; cls?: string }[] = [{ text: d.kind }]
    out.push(d.muzzle_ms > 0 ? { text: `${d.muzzle_ms} m/s` } : { text: 'hitscan', cls: 'none' })
    if (d.magazine > 0) out.push({ text: `${d.magazine} rounds` })
    if (d.impulse > 0) out.push({ text: `${d.impulse} N·s`, cls: 'ok' })
    return out
  },
  form: (host, getDoc, onChange) => void weaponForm(host, getDoc, { onChange: (doc) => onChange(doc) }),
  errors: (d) => validateWeapon(d).errors,
}

/** The extension object to hand `AssetCatalog`. */
export function weaponExtension(): { tabs: Tab[]; detail: (item: AssetItem, host: HTMLElement, ctx: AssetDetailCtx) => void } {
  return {
    tabs: [{ id: 'weapons', label: 'Weapons', icon: 'bolt', build: (host) => buildScreen(host, WEAPON_BUILD) }],
    detail: weaponDetail,
  }
}
