// The Stage panel: a level — a baked world, dressed, and given something to do.
//
// Everything behind this has existed for hours and was reachable only with curl, which is the
// same as not existing. `levels.mjs` validates, the viewer's `level.ts` applies, and this is the
// surface: pick a world, set when it opens and what the weather is doing, name the simulations
// running in it, write the scenario, and open it in the viewer.
//
// WHAT IT REFUSES IS THE INTERESTING PART. The validator's vocabulary — the facts a scenario may
// test and the actions an event may take — comes from the SERVER, listed in `GET /api/levels`, so
// the panel shows the same words the validator will accept rather than a copy that can drift from
// them. An event testing `rage_meter` is refused with the list of facts that do exist, here, in
// front of the person writing it, instead of saving cleanly and never firing.

import { button, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout, select, textField } from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type Level } from './api'

const hint = (text: string, warn = false) => {
  const p = el('div', `panel-hint${warn ? ' warn' : ''}`)
  p.append(icon(warn ? 'exclamation-triangle' : 'information-circle', 14), el('span', '', text))
  return p
}

export interface StageOpts {
  host: HTMLElement
  /** worlds that are actually baked on this volume — a level for anything else cannot open */
  bakedWorlds: () => string[]
  /** open the viewer on this level */
  play: (level: Level) => void
  onDirty: (dirty: boolean) => void
}

const WEATHERS = ['clear', 'cloud', 'overcast', 'rain', 'storm', 'wet', 'snow']
const SEASONS = ['spring', 'summer', 'autumn', 'winter']

export class StagePanel {
  private levels: Level[] = []
  private facts: Record<string, string> = {}
  private actions: Record<string, string> = {}
  private modes: string[] = ['drive', 'fly', 'walk']
  private draft: Level | null = null
  private dirty = false
  private problems: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] }

  private o: StageOpts

  constructor(o: StageOpts) {
    this.o = o
  }

  async load() {
    try {
      const r = await api.levels()
      this.levels = r.levels
      this.facts = r.facts ?? {}
      this.actions = r.actions ?? {}
      this.modes = r.modes ?? this.modes
    } catch (e) {
      this.levels = []
      toast(`levels: ${(e as Error).message}`, 'warn', 5000)
    }
    this.render()
  }

  private mark(d: boolean) {
    this.dirty = d
    this.o.onDirty(d)
  }

  /** Ask the server, not a copy of its rules — the same call the agent makes before it writes. */
  private async check() {
    if (!this.draft) return
    try {
      const v = await api.validateLevel(this.draft)
      this.problems = { errors: v.errors, warnings: v.warnings }
    } catch (e) {
      this.problems = { errors: [(e as Error).message], warnings: [] }
    }
    this.render()
  }

  private edit(l: Level | null) {
    this.draft = l ? JSON.parse(JSON.stringify(l)) : null
    this.problems = { errors: [], warnings: [] }
    this.mark(false)
    this.render()
    if (this.draft) void this.check()
  }

  private blank() {
    const baked = this.o.bakedWorlds()
    this.edit({
      id: '',
      world: baked[0] ?? '',
      defaults: { time: '17:30', weather: 'clear', season: 'summer' },
      mode: 'drive',
      placements: [],
      splats: [],
      simulations: [],
      scenario: null,
    })
  }

  render() {
    const host = this.o.host
    host.replaceChildren()

    if (!this.draft) {
      host.append(hint('A baked world with the lights set, things put in it, and something to do.'))
      const list = group('Levels')
      const lb = bodyOf(list)
      if (!this.levels.length) lb.append(empty('no levels yet'))
      for (const l of this.levels) {
        const row = el('button', 'row')
        row.append(el('span', 'row-name', l.id), el('span', 'row-note', `${l.world}${l.defaults?.time ? ` · ${l.defaults.time}` : ''}${l.scenario ? ' · scenario' : ''}`))
        row.onclick = () => this.edit(l)
        lb.append(row)
      }
      lb.append(button({ label: 'New level', icon: 'plus', onClick: () => this.blank() }))
      host.append(list)
      return
    }

    const d = this.draft
    const baked = this.o.bakedWorlds()

    /* what and where */
    const what = group('The level')
    const wb = bodyOf(what)
    wb.append(
      textField({
        label: 'id',
        value: d.id,
        onChange: (v) => {
          d.id = v.trim()
          this.mark(true)
          void this.check()
        },
      }),
    )
    if (baked.length) {
      wb.append(
        select({
          label: 'world',
          value: baked.includes(d.world) ? d.world : baked[0],
          options: baked.map((w) => ({ value: w, label: w })),
          onChange: (v) => {
            d.world = v
            this.mark(true)
            void this.check()
          },
        }),
      )
    } else {
      wb.append(hint('nothing is baked on this volume yet — bake a world first', true))
    }
    wb.append(
      select({
        label: 'mode',
        value: d.mode ?? 'drive',
        options: this.modes.map((m) => ({ value: m, label: m })),
        onChange: (v) => {
          d.mode = v
          this.mark(true)
        },
      }),
    )
    host.append(what)

    /* what it opens like */
    const look = group('What it opens like')
    const kb = bodyOf(look)
    d.defaults ??= {}
    kb.append(
      textField({
        label: 'time',
        value: d.defaults.time ?? '17:30',
        onChange: (v) => {
          d.defaults!.time = v.trim()
          this.mark(true)
          void this.check()
        },
      }),
      select({
        label: 'weather',
        value: d.defaults.weather ?? 'clear',
        options: WEATHERS.map((w) => ({ value: w, label: w })),
        onChange: (v) => {
          d.defaults!.weather = v
          this.mark(true)
        },
      }),
      select({
        label: 'season',
        value: d.defaults.season ?? 'summer',
        options: SEASONS.map((s) => ({ value: s, label: s })),
        onChange: (v) => {
          d.defaults!.season = v
          this.mark(true)
        },
      }),
    )
    host.append(look)

    /* what is running in it */
    const sim = group('Running in it')
    const sb = bodyOf(sim)
    d.simulations ??= []
    if (!d.simulations.length) sb.append(empty('nothing running'))
    for (const [i, s] of d.simulations.entries()) {
      sb.append(readout(String(s.kind), `${s.density ?? 'normal'}${s.seed !== undefined ? ` · seed ${s.seed}` : ''}`))
      sb.append(
        button({
          label: 'remove',
          icon: 'trash',
          onClick: () => {
            d.simulations!.splice(i, 1)
            this.mark(true)
            void this.check()
          },
        }),
      )
    }
    sb.append(
      button({
        label: 'Add traffic',
        icon: 'plus',
        onClick: () => {
          // a seed, always: it is what makes a run repeatable, and the validator refuses a
          // fractional one for the same reason
          d.simulations!.push({ kind: 'traffic', density: 'rush', seed: Math.floor(Math.random() * 1000) })
          this.mark(true)
          void this.check()
        },
      }),
    )
    host.append(sim)

    /* the scenario */
    // NOT COLLAPSED WHEN THERE IS NOTHING IN IT. The first version collapsed this group when the
    // level had no scenario — which hid the only button that adds one, precisely in the state
    // where you need it. A section is collapsed because it is long, not because it is empty.
    const sc = group('Something to do', {
    })
    const cb = bodyOf(sc)
    if (!d.scenario) {
      cb.append(
        empty('no scenario: this is a world to drive around in'),
        button({
          label: 'Add a scenario',
          icon: 'flag',
          onClick: () => {
            d.scenario = { goal: { type: 'score', target: 5000, time_s: 300 }, events: [], scoring: [{ event: 'wreck', points: 100 }] }
            this.mark(true)
            void this.check()
          },
        }),
      )
    } else {
      const g = d.scenario.goal ?? { type: 'score' }
      cb.append(
        readout('goal', `${g.type}${g.target ? ` ${g.target}` : ''}${g.time_s ? ` in ${g.time_s}s` : ''}`),
        readout('scoring', (d.scenario.scoring ?? []).map((r) => `${r.event} ${r.points}${r.per ? `/${r.per}` : ''}`).join(', ') || 'nothing'),
      )
      // THE FACTS COME FROM THE SERVER. A condition on something the engine does not measure
      // saves cleanly and never fires, so the words it will accept are shown next to the field.
      const facts = Object.keys(this.facts)
      cb.append(hint(`Conditions read: ${facts.join(', ') || '(ask the server)'}`))
      cb.append(hint(`Events may: ${Object.keys(this.actions).join(', ')}`))
      for (const [i, ev] of (d.scenario.events ?? []).entries()) {
        cb.append(readout(`when ${ev.when}`, `${ev.do}${ev.text ? ` “${String(ev.text).slice(0, 28)}”` : ''}`))
        cb.append(button({ label: 'remove', icon: 'trash', onClick: () => { d.scenario!.events!.splice(i, 1); this.mark(true); void this.check() } }))
      }
      const whenF = textField({ label: 'when', value: '', placeholder: facts[0] ? `${facts[0]} >= 100` : 'score >= 100', onChange: () => {} })
      const doF = textField({ label: 'message', value: '', placeholder: 'Traffic is now worse than you found it.', onChange: () => {} })
      cb.append(whenF, doF)
      cb.append(
        button({
          label: 'Add event',
          icon: 'plus',
          onClick: () => {
            const when = (whenF.querySelector('input') as HTMLInputElement)?.value.trim()
            const text = (doF.querySelector('input') as HTMLInputElement)?.value.trim()
            if (!when) return toast('an event needs a condition', 'warn', 3000)
            d.scenario!.events ??= []
            d.scenario!.events.push({ when, do: 'message', text })
            this.mark(true)
            void this.check()
          },
        }),
      )
    }
    host.append(sc)

    /* what is wrong with it, said before it is saved */
    if (this.problems.errors.length || this.problems.warnings.length) {
      const bad = group(this.problems.errors.length ? 'This will not save' : 'Worth knowing')
      const bb = bodyOf(bad)
      for (const e of this.problems.errors) bb.append(hint(e, true))
      for (const w of this.problems.warnings) bb.append(hint(w))
      host.append(bad)
    }

    /* and the actions */
    const acts = el('div', 'panel-actions')
    acts.append(
      button({
        label: this.levels.some((l) => l.id === d.id) ? 'Save' : 'Create',
        icon: 'check',
        variant: 'primary',
        onClick: () => {
          if (this.problems.errors.length) return toast(this.problems.errors[0], 'warn', 6000)
          void this.save()
        },
      }),
      button({
        label: 'Play',
        icon: 'play',
        onClick: () => {
          if (this.problems.errors.length) return toast('this level does not validate yet', 'warn', 4000)
          if (this.dirty) return toast('save it first — the viewer reads what is on the volume', 'warn', 4000)
          this.o.play(d)
        },
      }),
      button({ label: 'Close', icon: 'x-mark', onClick: () => this.edit(null) }),
    )
    host.append(acts)
  }

  private async save() {
    const d = this.draft
    if (!d) return
    try {
      const exists = this.levels.some((l) => l.id === d.id)
      const r = exists ? await api.saveLevel(d.id, d) : await api.createLevel(d)
      toast(`${r.level.id} saved`, 'ok', 2500)
      for (const w of r.warnings ?? []) toast(w, 'warn', 5000)
      this.mark(false)
      await this.load()
      this.edit(r.level)
    } catch (e) {
      toast(`could not save: ${(e as Error).message}`, 'danger', 6000)
    }
  }
}
