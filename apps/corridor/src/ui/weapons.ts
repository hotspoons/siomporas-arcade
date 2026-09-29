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
import { assetsvc, type AssetItem, type RigBinding } from '../assetsvc'
import {
  burstDps, defaultWeapon, describeWeapon, dropAt, flightTime, magazineSeconds, shotsToKill,
  spreadRadiusAt, sustainedDps, validateWeapon, WEAPON_CLASS, WEAPON_KINDS, WEAPON_TEMPLATE_IDS,
  type WeaponDoc, type WeaponKind,
} from '../weapons'
import type { AssetDetailCtx } from './assets'
import { bodyOf, empty, group, readout, select, setGroupError, slider, textField } from './controls'
import { button, el, type Tab } from './shell'

export function isWeapon(kind: string): boolean {
  return kind === WEAPON_CLASS
}

/** The Ballistics group. Renders nothing for anything that is not a weapon. */
export function weaponDetail(item: AssetItem, host: HTMLElement, ctx: AssetDetailCtx): void {
  if (!isWeapon(ctx.kind)) return

  const stored = item.weapon as WeaponDoc | null | undefined
  let doc: WeaponDoc = stored ? structuredClone(stored) : defaultWeapon()
  const fresh = !stored

  const g = group('Ballistics', {
    note: fresh ? 'no ballistics saved yet — these are pistol defaults, and nothing is stored until you save' : describeWeapon(doc),
  })
  const body = bodyOf(g)
  host.append(g)

  const roles = Object.keys((item.rig as RigBinding | null | undefined)?.roles ?? {})
  const stage = () => { ctx.edit({ weapon: structuredClone(doc) }); render() }
  const live = () => ctx.edit({ weapon: structuredClone(doc) })

  function render() {
    body.replaceChildren()
    const report = validateWeapon(doc, { rigRoles: roles.length ? roles : undefined })
    setGroupError(g, report.errors.length ? `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}` : null)
    if (report.errors.length || report.warnings.length) {
      const box = el('div', 'panel-note')
      for (const e of report.errors) box.append(el('div', 'field-error', e))
      for (const w of report.warnings) box.append(el('div', 'field-note', w))
      body.append(box)
    }

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

    const foot = el('div', 'panel-actions')
    foot.append(select({
      label: 'Start from', value: '',
      options: [{ value: '', label: 'a template…' }, ...WEAPON_TEMPLATE_IDS.map((t) => ({ value: t, label: t }))],
      onChange: (v) => { if (v) { doc = defaultWeapon(v); stage() } },
    }))
    body.append(foot)
  }

  render()
}

/* ---- the roster -------------------------------------------------------------------------------- */

/**
 * The Weapons tab: the armoury, sorted by what it actually does per second.
 *
 * The across view again, and here it is the most useful of the three: a weapon is only ever
 * balanced against the other weapons, and `sustainedDps` side by side is the comparison that a
 * per-item pane cannot show and that burst damage actively misleads about.
 */
export function weaponRosterTab(): Tab {
  return { id: 'weapons', label: 'Weapons', icon: 'bolt', build: (host) => void renderRoster(host) }
}

async function renderRoster(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', 'field-note', 'reading the library…'))
  let items: AssetItem[]
  try {
    items = await assetsvc.list()
  } catch (e) {
    host.replaceChildren(empty(`No asset service: ${(e as Error).message}`))
    return
  }
  const armoury = items.filter((it) => isWeapon(it.kind || ''))
  host.replaceChildren()
  if (!armoury.length) {
    host.replaceChildren(empty(`Nothing in the library is a weapon yet. Give an asset the class "${WEAPON_CLASS}".`))
    return
  }

  let unset = 0
  let broken = 0
  const rows = el('div', 'asset-list')
  for (const it of [...armoury].sort((a, b) => sustainedDps(docOf(b)) - sustainedDps(docOf(a)))) {
    const doc = docOf(it)
    const report = validateWeapon(doc)
    if (!it.weapon) unset++
    else if (!report.ok) broken++
    const row = el('div', 'asset-row')
    const head = el('div', 'asset-row-head')
    head.append(el('strong', '', it.id), el('span', 'chip', doc.kind))
    if (!it.weapon) head.append(el('span', 'chip state-spec', 'no ballistics'))
    else if (!report.ok) head.append(el('span', 'chip state-spec', `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`))
    else head.append(el('span', 'chip state-finished', 'ready'))
    row.append(head)
    row.append(el('div', 'field-note', describeWeapon(doc)))
    for (const e of report.errors.slice(0, 3)) row.append(el('div', 'field-error', e))
    rows.append(row)
  }

  const summary = group('The armoury', {
    note: `${armoury.length} weapon${armoury.length === 1 ? '' : 's'} · ${armoury.length - unset - broken} ready · ${unset} with no ballistics · ${broken} with problems · sorted by sustained damage per second`,
  })
  bodyOf(summary).append(rows)
  host.append(summary)
  const foot = el('div', 'panel-actions')
  foot.append(button({ label: 'Refresh', icon: 'arrow-path', variant: 'ghost', onClick: () => void renderRoster(host) }))
  host.append(foot)
}

function docOf(it: AssetItem): WeaponDoc {
  return (it.weapon as WeaponDoc | null | undefined) ?? defaultWeapon()
}

export function weaponExtension() {
  return { tabs: [weaponRosterTab()], detail: weaponDetail }
}
