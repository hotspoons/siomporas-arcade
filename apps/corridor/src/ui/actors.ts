// The Actors tab, and the Behaviour group on a character's detail pane.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md §2. The same shape as `ui/vehicles.ts` and deliberately so:
// one seam, two extensions, and the document, the defaults, the validation and the arithmetic all
// live in `src/actorspecs.ts` where they can be tested without a browser.
//
// WHAT AN ACTOR FORM HAS THAT A VEHICLE FORM DOES NOT: numbers that only mean something against
// another number. A jump velocity of 4 m/s tells nobody whether a character can reach a ledge, and
// 18 damage against 100 health is a fight whose length you have to work out in your head. So the
// derived readouts — jump height, jump distance, hits to kill, seconds to kill — are not decoration
// here; they are the fields somebody is actually designing against, and the raw velocities are the
// implementation.
import { assetsvc, type AssetItem, type RigBinding } from '../assetsvc'
import {
  ACTOR_CLASSES, ACTOR_TEMPLATE_IDS, defaultActor, describeActor, dps, hitsToKill, jumpDistance,
  jumpHeight, validateActor, type ActorDoc,
} from '../actorspecs'
import type { AssetDetailCtx } from './assets'
import { bodyOf, empty, group, readout, select, setGroupError, slider, textField, toggle } from './controls'
import { button, el, type Tab } from './shell'

/** Is this the kind of thing that has an actor document at all? */
export function isActor(kind: string): boolean {
  return ACTOR_CLASSES.includes(kind)
}

/** The Behaviour group, appended to an actor's detail pane. Renders nothing for anything else. */
export function actorDetail(item: AssetItem, host: HTMLElement, ctx: AssetDetailCtx): void {
  if (!isActor(ctx.kind)) return

  const stored = item.actor as ActorDoc | null | undefined
  let doc: ActorDoc = stored ? structuredClone(stored) : defaultActor(ctx.kind)
  const fresh = !stored

  const g = group('Behaviour', {
    note: fresh ? `no behaviour saved yet — these are ${ctx.kind} defaults, and nothing is stored until you save` : describeActor(doc),
  })
  const body = bodyOf(g)
  host.append(g)

  // Which bone roles the rig binds. An actor needs a hand for a weapon to hang off; unlike a
  // vehicle's wheels, the COUNT is not the question — the NAMES are, so only the stored binding can
  // answer and the preview's guess is no use here.
  const roles = Object.keys((item.rig as RigBinding | null | undefined)?.roles ?? {})

  // The weapons in the library, for the picker and for validation. Fetched once; a failure is a
  // normal state (asset generation is off by default) and must not take the form down with it.
  let weaponIds: string[] | undefined
  void assetsvc.list()
    .then((items) => {
      weaponIds = items.filter((it) => it.kind === 'weapon').map((it) => it.id)
      render()
    })
    .catch(() => { /* no service: the picker falls back to a text field and validation skips */ })

  const stage = () => {
    ctx.edit({ actor: structuredClone(doc) })
    render()
  }
  const live = () => ctx.edit({ actor: structuredClone(doc) })

  function render() {
    body.replaceChildren()
    const report = validateActor(doc, { weapons: weaponIds, rigRoles: roles })
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

    /* ---- moving ---------------------------------------------------------------------------- */
    const move = group('Moving', { note: 'metres per second, like everything else in this app' })
    const mb = bodyOf(move)
    num(mb, 'Walk (m/s)', doc.move.walk_ms, 0.1, (v) => (doc.move.walk_ms = v))
    num(mb, 'Run (m/s)', doc.move.run_ms, 0.1, (v) => (doc.move.run_ms = v))
    num(mb, 'Climb (m/s)', doc.move.climb_ms, 0.1, (v) => (doc.move.climb_ms = v), '0 = cannot climb')
    num(mb, 'Fly (m/s)', doc.move.fly_ms, 0.5, (v) => (doc.move.fly_ms = v), '0 = cannot fly')
    num(mb, 'Jump (m/s up)', doc.move.jump_ms, 0.1, (v) => (doc.move.jump_ms = v))
    num(mb, 'Turn (°/s)', doc.move.turn_deg_s, 10, (v) => (doc.move.turn_deg_s = v))
    // THE NUMBERS SOMEBODY IS ACTUALLY DESIGNING AGAINST. A jump velocity tells nobody whether a
    // ledge can be reached; a jump height does.
    mb.append(readout('Jump height', `${jumpHeight(doc).toFixed(2)} m`))
    mb.append(readout('Jump distance from a run', `${jumpDistance(doc).toFixed(2)} m`))
    body.append(move)

    /* ---- the body -------------------------------------------------------------------------- */
    const bod = group('Body', {})
    const bb = bodyOf(bod)
    num(bb, 'Health', doc.body.health, 10, (v) => (doc.body.health = v), 'the ECS stores this in a Uint16, so 65535 is the ceiling')
    num(bb, 'Mass (kg)', doc.body.mass, 1, (v) => (doc.body.mass = v), 'what a car throws, and what the ragdoll weighs')
    num(bb, 'Height (m)', doc.body.height, 0.05, (v) => (doc.body.height = v), 'the ragdoll is proportioned from this')
    bb.append(slider({
      label: 'Armour', value: doc.body.armour, min: 0, max: 1, step: 0.01,
      note: 'the share of every hit that never lands — a fraction refused, not a subtraction',
      onInput: (v) => { doc.body.armour = v; live() },
    }))
    bb.append(toggle({
      label: 'Ragdolls when it dies', value: doc.body.ragdoll,
      onChange: (v) => { doc.body.ragdoll = v; stage() },
    }))
    body.append(bod)

    /* ---- combat ---------------------------------------------------------------------------- */
    const fight = group('Combat', {})
    const fb = bodyOf(fight)
    num(fb, 'Damage per hit', doc.combat.damage, 1, (v) => (doc.combat.damage = v), 'unarmed')
    num(fb, 'Seconds between hits', doc.combat.attack_s, 0.05, (v) => (doc.combat.attack_s = v))
    num(fb, 'Reach (m)', doc.combat.reach_m, 0.1, (v) => (doc.combat.reach_m = v))
    fb.append(readout('Damage per second', dps(doc).toFixed(1)))
    // A fight, in the terms somebody balancing one thinks in: how long does this take against an
    // ordinary person, and against another of these.
    const vsPerson = hitsToKill(doc, defaultActor('pedestrian'))
    const vsSelf = hitsToKill(doc, doc)
    fb.append(readout('To drop a pedestrian', ratio(vsPerson)))
    fb.append(readout('To drop another of these', ratio(vsSelf)))
    body.append(fight)

    /* ---- weapons --------------------------------------------------------------------------- */
    const arms = group('Weapons', {
      note: weaponIds === undefined ? 'no asset service, so these are not checked' : `${weaponIds.length} in the library`,
    })
    const ab = bodyOf(arms)
    for (const [i, id] of doc.combat.weapons.entries()) {
      const row = el('div', 'panel-actions')
      if (weaponIds?.length) {
        row.append(select({
          value: id,
          options: [...new Set([id, ...weaponIds])].map((w) => ({ value: w, label: w })),
          onChange: (v) => { doc.combat.weapons[i] = v; stage() },
        }))
      } else {
        row.append(textField({ label: `Weapon ${i + 1}`, value: id, onChange: (v) => { doc.combat.weapons[i] = v.trim(); stage() } }))
      }
      row.append(button({ label: 'Remove', variant: 'ghost', onClick: () => { doc.combat.weapons.splice(i, 1); stage() } }))
      ab.append(row)
    }
    ab.append(button({
      label: 'Carry a weapon', icon: 'plus',
      // PULL FROM THE LIBRARY, never invent. The brief is explicit and it is also the only way the
      // id can be checked: an empty string is a picker somebody has to fill in, not a broken weapon.
      onClick: () => { doc.combat.weapons.push(weaponIds?.[0] ?? ''); stage() },
    }))
    if (doc.combat.weapons.length && !roles.length) {
      ab.append(el('div', 'field-note', 'this asset has no rig binding, so there is no bone for a weapon to hang off'))
    }
    body.append(arms)

    /* ---- start again ------------------------------------------------------------------------ */
    const foot = el('div', 'panel-actions')
    foot.append(select({
      label: 'Start from',
      value: '',
      options: [{ value: '', label: 'a template…' }, ...ACTOR_TEMPLATE_IDS.map((t) => ({ value: t, label: t }))],
      onChange: (v) => { if (v) { doc = defaultActor(v); stage() } },
    }))
    body.append(foot)
  }

  render()
}

function ratio(r: { hits: number; seconds: number }): string {
  if (!Number.isFinite(r.hits)) return 'never — the armour refuses everything'
  return `${r.hits} hit${r.hits === 1 ? '' : 's'} · ${r.seconds.toFixed(1)} s`
}

/* ---- the roster -------------------------------------------------------------------------------- */

/**
 * The Actors tab: the cast, and whether it is finished.
 *
 * Same argument as the Vehicles roster — the pane already has per-class tabs over the same list, so
 * this is the ACROSS view instead: who has no behaviour yet, whose numbers do not validate, and
 * who can actually hurt whom. The last of those is the one that is genuinely hard to see any other
 * way, so the roster sorts by damage per second.
 */
export function actorRosterTab(): Tab {
  return { id: 'actors', label: 'Actors', icon: 'flag', build: (host) => void renderRoster(host) }
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
  const weapons = items.filter((it) => it.kind === 'weapon').map((it) => it.id)
  const cast = items.filter((it) => isActor(it.kind || ''))
  host.replaceChildren()
  if (!cast.length) {
    host.replaceChildren(empty(`Nothing in the library is an actor yet. Give an asset one of these classes: ${ACTOR_CLASSES.join(', ')}.`))
    return
  }

  let unset = 0
  let broken = 0
  const rows = el('div', 'asset-list')
  const sorted = [...cast].sort((a, b) => dps(docOf(b)) - dps(docOf(a)))
  for (const it of sorted) {
    const doc = docOf(it)
    const report = validateActor(doc, { weapons, rigRoles: Object.keys((it.rig as RigBinding | null | undefined)?.roles ?? {}) })
    if (!it.actor) unset++
    else if (!report.ok) broken++

    const row = el('div', 'asset-row')
    const head = el('div', 'asset-row-head')
    head.append(el('strong', '', it.id), el('span', 'chip', it.kind))
    if (!it.actor) head.append(el('span', 'chip state-spec', 'no behaviour'))
    else if (!report.ok) head.append(el('span', 'chip state-spec', `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`))
    else head.append(el('span', 'chip state-finished', 'ready'))
    row.append(head)
    row.append(el('div', 'field-note', describeActor(doc)))
    for (const e of report.errors.slice(0, 3)) row.append(el('div', 'field-error', e))
    rows.append(row)
  }

  const summary = group('The cast', {
    note: `${cast.length} actor${cast.length === 1 ? '' : 's'} · ${cast.length - unset - broken} ready · ${unset} with no behaviour · ${broken} with problems · sorted by damage per second`,
  })
  bodyOf(summary).append(rows)
  host.append(summary)
  const foot = el('div', 'panel-actions')
  foot.append(button({ label: 'Refresh', icon: 'arrow-path', variant: 'ghost', onClick: () => void renderRoster(host) }))
  host.append(foot)
}

function docOf(it: AssetItem): ActorDoc {
  return (it.actor as ActorDoc | null | undefined) ?? defaultActor(it.kind)
}

/** The extension object to hand `AssetCatalog`. */
export function actorExtension() {
  return { tabs: [actorRosterTab()], detail: actorDetail }
}
