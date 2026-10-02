// The Actors screen, and the Behaviour group on a character's detail pane.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md §2. The document, the defaults, the validation and the
// arithmetic live in `src/actorspecs.ts` where they can be tested without a browser; the workflow
// is `ui/buildscreen.ts`, shared with vehicles and weapons.
//
// WHAT AN ACTOR FORM HAS THAT A VEHICLE FORM DOES NOT: numbers that only mean something against
// another number. A jump velocity of 4 m/s tells nobody whether a character can reach a ledge, and
// 18 damage against 100 health is a fight whose length you have to work out in your head. So the
// derived readouts — jump height, jump distance, hits to kill, seconds to kill — are not decoration
// here; they are the fields somebody is actually designing against, and the raw velocities are the
// implementation.
//
// THE ROSTER IS GONE, and that is the point. It listed every catalog asset filed under an actor
// class and rendered `defaultActor(kind)` for the ones with no document — then SORTED THE CAST BY
// THE DAMAGE PER SECOND OF A DOCUMENT NONE OF THEM HAD. The same mistake as the Vehicles list, with
// the same fix: a cast is what somebody has built, and it starts empty.
import { assetsvc, type AssetItem, type Build, type RigBinding } from '../../assets/assetsvc'
import {
  ACTOR_CLASSES, ACTOR_TEMPLATE_IDS, defaultActor, describeActor, dps, hitsToKill, jumpDistance,
  jumpHeight, validateActor, type ActorDoc,
} from '../../game/actors/actorspecs'
import { actorPresetDoc, actorPresetsFor } from '../../game/actors/actorpresets'
import { CLASSES_BY_TYPE } from '../../assets/classes'
import type { AssetDetailCtx } from './assets'
import { buildScreen, type BuildPreset, type BuildSpec } from './buildscreen'
import { bodyOf, group, readout, select, setGroupError, slider, textField, toggle } from '../../ui/controls'
import { button, el, type Tab } from '../../ui/shell'

/** Is this the kind of thing that has an actor document at all? */
export function isActor(kind: string): boolean {
  return ACTOR_CLASSES.includes(kind)
}

/* ================================================================================================
 * The form. ONE of it, used by the Actors screen and by the detail pane.
 * ============================================================================================= */

export interface ActorFormOpts {
  /** which bone roles the asset's rig binds, for the weapon warning. Empty when nothing is known */
  rigRoles?: string[]
  /** called on every edit. `live` is true for a drag, where the form must NOT be rebuilt */
  onChange: (doc: ActorDoc, live: boolean) => void
  /** somewhere to put "N problems", when the caller has a group heading to put it on */
  onReport?: (errors: number) => void
}

/**
 * The whole behaviour editor, rendered into `host`. Returns a `rebuild`.
 *
 * The weapons it offers are BUILDS, not catalog rows: a weapon is a model plus ballistics, exactly
 * as a vehicle is a model plus dynamics, and carrying a bare catalog id would mean carrying
 * something with no damage, no rate of fire and no range. A weapon that has not been built yet is
 * not a weapon this actor can hold.
 */
export function actorForm(host: HTMLElement, getDoc: () => ActorDoc, opts: ActorFormOpts): () => void {
  /** built weapons, for the picker and for validation. Undefined until the fetch lands */
  let weaponIds: string[] | undefined
  void assetsvc.builds<Build<unknown>>('weapons')
    .then((ws) => { weaponIds = ws.map((w) => w.id); render() })
    .catch(() => { /* no service: the picker falls back to a text field and validation skips */ })

  function render() {
    const doc = getDoc()
    host.replaceChildren()
    const report = validateActor(doc, { weapons: weaponIds, rigRoles: opts.rigRoles })
    opts.onReport?.(report.errors.length)

    if (report.errors.length || report.warnings.length) {
      const box = el('div', 'panel-note')
      for (const e of report.errors) box.append(el('div', 'field-error', e))
      for (const w of report.warnings) box.append(el('div', 'field-note', w))
      host.append(box)
    }

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
    host.append(move)

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
    host.append(bod)

    /* ---- combat ---------------------------------------------------------------------------- */
    const fight = group('Combat', {})
    const fb = bodyOf(fight)
    num(fb, 'Damage per hit', doc.combat.damage, 1, (v) => (doc.combat.damage = v), 'unarmed')
    num(fb, 'Seconds between hits', doc.combat.attack_s, 0.05, (v) => (doc.combat.attack_s = v))
    num(fb, 'Reach (m)', doc.combat.reach_m, 0.1, (v) => (doc.combat.reach_m = v))
    fb.append(readout('Damage per second', dps(doc).toFixed(1)))
    // A fight, in the terms somebody balancing one thinks in: how long does this take against an
    // ordinary person, and against another of these.
    fb.append(readout('To drop a pedestrian', ratio(hitsToKill(doc, defaultActor('pedestrian')))))
    fb.append(readout('To drop another of these', ratio(hitsToKill(doc, doc))))
    host.append(fight)

    /* ---- weapons --------------------------------------------------------------------------- */
    const arms = group('Weapons', {
      note: weaponIds === undefined ? 'no asset service, so these are not checked'
        : weaponIds.length ? `${weaponIds.length} built weapon${weaponIds.length === 1 ? '' : 's'} to choose from`
        : 'none built yet — the Weapons tab is where one is made',
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
      // PULL FROM WHAT EXISTS, never invent. An empty string is a picker somebody has to fill in,
      // which the validator reports; a made-up id is a weapon that silently does nothing.
      onClick: () => { doc.combat.weapons.push(weaponIds?.[0] ?? ''); stage() },
    }))
    if (doc.combat.weapons.length && !opts.rigRoles?.length) {
      ab.append(el('div', 'field-note', 'nothing here knows this model’s rig, so no bone is claimed for the weapon to hang off'))
    }
    host.append(arms)
  }

  render()
  return render
}

function ratio(r: { hits: number; seconds: number }): string {
  if (!Number.isFinite(r.hits)) return 'never — the armour refuses everything'
  return `${r.hits} hit${r.hits === 1 ? '' : 's'} · ${r.seconds.toFixed(1)} s`
}

/* ================================================================================================
 * The detail pane extension — the same form, staged through the pane's own draft
 * ============================================================================================= */

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

  const form = el('div')
  body.append(form)
  const rebuild = actorForm(form, () => doc, {
    rigRoles: roles,
    onChange: (d) => ctx.edit({ actor: structuredClone(d) }),
    onReport: (n) => setGroupError(g, n ? `${n} problem${n === 1 ? '' : 's'}` : null),
  })

  const foot = el('div', 'panel-actions')
  foot.append(select({
    label: 'Start from',
    value: '',
    options: [{ value: '', label: 'a template…' }, ...ACTOR_TEMPLATE_IDS.map((t) => ({ value: t, label: t }))],
    onChange: (v) => { if (v) { doc = defaultActor(v); ctx.edit({ actor: structuredClone(doc) }); rebuild() } },
  }))
  body.append(foot)
}

/* ================================================================================================
 * The cast
 * ============================================================================================= */

/** What the Actors screen needs to know about an actor, and nothing else. */
export const ACTOR_BUILD: BuildSpec<ActorDoc> = {
  kind: 'actors',
  noun: 'actor',
  assetType: 'actor',
  classes: CLASSES_BY_TYPE.actor,
  icon: 'flag',
  emptyTitle: 'No actors yet',
  emptyBlurb: 'An actor is a model from the library plus how it moves, what it is made of and what '
    + 'it can do to you — speeds, health, mass for the ragdoll, reach and the weapons it carries. '
    + 'The library’s people and animals are visuals; this is where one becomes somebody.',
  presets: (kind) => actorPresetsFor(kind).map((p): BuildPreset<ActorDoc> => ({ id: p.id, name: p.name, note: p.note, doc: actorPresetDoc(p.id) ?? p.doc })),
  defaultDoc: (kind) => defaultActor(kind ?? 'pedestrian'),
  describe: describeActor,
  summary: (d) => `${d.body.health} hp · ${d.body.mass} kg · ${d.move.run_ms} m/s run`,
  tags: (d) => {
    const out: { text: string; cls?: string }[] = [{ text: `${dps(d).toFixed(1)} dps` }]
    if (d.move.fly_ms > 0) out.push({ text: 'flies' })
    if (d.move.climb_ms > 0) out.push({ text: 'climbs' })
    if (d.combat.weapons.length) out.push({ text: `${d.combat.weapons.length} armed`, cls: 'ok' })
    if (!d.body.ragdoll) out.push({ text: 'no ragdoll', cls: 'none' })
    return out
  },
  form: (host, getDoc, onChange) => void actorForm(host, getDoc, { onChange: (doc) => onChange(doc) }),
  errors: (d) => validateActor(d).errors,
}

/** The extension object to hand `AssetCatalog`. */
export function actorExtension(): { tabs: Tab[]; detail: (item: AssetItem, host: HTMLElement, ctx: AssetDetailCtx) => void } {
  return {
    tabs: [{ id: 'actors', label: 'Actors', icon: 'flag', build: (host) => buildScreen(host, ACTOR_BUILD) }],
    detail: actorDetail,
  }
}
