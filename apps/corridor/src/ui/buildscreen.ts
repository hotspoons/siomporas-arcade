// The screen that turns a model into a thing: vehicles, actors and weapons, one implementation.
//
// Rich, 2026-09-29, describing it for vehicles: *"go to vehicles today, see nothing, add a new,
// pick a model, apply config and dynamics preset optionally, add metadata, and full options
// presented on the last form -> save. Edit will bring up the full options again with the ability to
// change the model and apply presets, save."* And then: *"The same concept will apply to actors and
// weapons as well."*
//
// WHAT WAS STRUCTURALLY WRONG BEFORE, and it was wrong in all three tabs the same way. Each listed
// the CATALOG, filtered to its classes, and rendered the class template for every row — so 120 cars
// with no dynamics all read "1420 kg · 275 hp", and the actor roster sorted a cast of characters by
// the damage per second of a document none of them had. A catalog entry is a VISUAL. A vehicle is a
// visual plus dynamics; an actor is a visual plus behaviour; a weapon is a visual plus ballistics.
// Those are separate objects with separate lifetimes, so they get their own collection — `builds`
// on the asset service — and this screen starts EMPTY until somebody makes one.
//
// The library appears at exactly one moment: step 1, choosing what the new thing looks like.
//
// WHAT IS GENERIC AND WHAT IS NOT. Everything about the WORKFLOW is here — the five steps, the
// cards, the previews, the search, the preset library, saving, editing, deleting. Everything about
// the DOCUMENT is in the spec each caller passes: what a default one is, how to describe it, what
// to put on its card, and the form that edits it. No `if (kind === 'vehicle')` anywhere in this
// file; a fourth kind would be a fourth spec and no change here.
import { assetsvc, type AssetItem, type Build, type BuildKind } from '../assetsvc'
import { typeOf, type AssetType } from '../classes'
import { bodyOf, empty, group, readout, select, textArea, textField } from './controls'
import { ask, button, confirm, el, toast } from './shell'
import { icon, type IconName } from './icons'
import './buildscreen.css'

/** A starting point: a document with a name on it and no model. */
export interface BuildPreset<Doc> {
  id: string
  name: string
  note: string
  doc: Doc
}

/** Everything that differs between vehicles, actors and weapons. */
export interface BuildSpec<Doc> {
  /** the collection on the asset service, which is also the tab id */
  kind: BuildKind
  /** "vehicle" — used in sentences, so it is singular and lower case */
  noun: string
  /** the catalog type whose assets may be its model */
  assetType: AssetType
  /** the classes offered in the model picker's filter */
  classes: string[]
  icon: IconName
  /** the empty state: a heading and a paragraph saying what this thing IS */
  emptyTitle: string
  emptyBlurb: string
  /** the built-in presets, the ones that suit this class first */
  presets: (kind: string | null) => BuildPreset<Doc>[]
  /** a fresh document for a catalog class, when no preset was chosen */
  defaultDoc: (kind: string | null) => Doc
  /** one line for a preset card — the numbers, not the prose */
  describe: (doc: Doc) => string
  /** the line under the name on a built card */
  summary: (doc: Doc) => string
  /** the little tags along the bottom of a built card */
  tags: (doc: Doc) => { text: string; cls?: string }[]
  /** the whole configuration form, rendered into `host` */
  form: (host: HTMLElement, getDoc: () => Doc, onChange: (doc: Doc) => void) => void
  /** what would make saving this a mistake. Empty means save it */
  errors: (doc: Doc) => string[]
}

type Step = 'list' | 'model' | 'preset' | 'form'

interface Draft<Doc> {
  id: string
  name: string
  asset: string | null
  preset: string | null
  notes: string
  doc: Doc
  /** an existing build being edited, rather than one being made */
  existing: boolean
}

/** "a vehicle", "an actor" — a button that says "Add a actor" is a button nobody trusts. */
function an(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`
}

/** A slug that will survive being a filename and a URL, from whatever they typed. */
export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/** The class of the catalog asset a build wears, or null when it wears none. */
function kindOfAsset(assets: AssetItem[], id: string | null): string | null {
  if (!id) return null
  return assets.find((a) => a.id === id)?.kind ?? null
}

/**
 * The preview, at card size.
 *
 * `chosen` is the view that gets meshed and it is the one an asset's author picked as its best
 * face, so it is the right one to show. An asset with no views gets an ICON rather than an empty
 * grey box — the first version's letterboxes read as broken images, and "there is no picture" and
 * "the picture failed to load" should not look the same.
 */
function shot(item: AssetItem | null | undefined, fallback: IconName): HTMLElement {
  const box = el('div', 'bld-shot')
  if (item?.chosen) {
    const img = el('img')
    img.loading = 'lazy'
    img.alt = item.subject || item.id
    img.src = assetsvc.fileUrl(item.id, `views/${item.chosen}`)
    // A 404 leaves a broken-image glyph, which looks like a bug in the screen. Fall back to the icon.
    img.onerror = () => { img.remove(); box.append(icon(fallback, 28)) }
    box.append(img)
  } else {
    box.append(icon(fallback, 28))
  }
  return box
}

/**
 * A text field that reports every keystroke.
 *
 * A search box that only fires on blur is a search box that does nothing while you use it, and the
 * name field here drives the id as you type. `onChange` is still wired, to the same callback, so a
 * paste-and-tab behaves like typing.
 */
function liveField(o: { label: string; value: string; placeholder?: string; note?: string; onInput: (v: string) => void }): HTMLElement {
  return textField({ label: o.label, value: o.value, placeholder: o.placeholder, note: o.note, onInput: o.onInput, onChange: o.onInput })
}

function tag(text: string, cls = ''): HTMLElement {
  return el('span', `bld-tag${cls ? ` ${cls}` : ''}`, text)
}

/** The step strip along the top of the wizard. */
function steps(current: Step): HTMLElement {
  /*
   * THREE STEPS, NOT FOUR. There was a Details step between the preset and the form, asking for the
   * name, the id and the notes — and then the form asked for all three again at the top, because
   * editing is where you fix a name. Rich, 2026-09-29: *"We can skip the details panel since the
   * same info is available in the configure panel at the top"*.
   */
  const order: { id: Step; label: string }[] = [
    { id: 'model', label: 'Model' },
    { id: 'preset', label: 'Preset' },
    { id: 'form', label: 'Configure' },
  ]
  const at = order.findIndex((s) => s.id === current)
  const row = el('div', 'bld-steps')
  order.forEach((s, i) => {
    if (i) row.append(el('span', 'bld-step-sep', '›'))
    const done = i < at
    const box = el('span', `bld-step${i === at ? ' on' : done ? ' done' : ''}`)
    const dot = el('span', 'bld-step-dot')
    if (done) dot.append(icon('check', 12))
    else dot.textContent = String(i + 1)
    box.append(dot, el('span', '', s.label))
    row.append(box)
  })
  return row
}

/**
 * Mount the screen into `host`.
 *
 * ONE ELEMENT, redrawn — `host` gets `.bld-screen`, which is the column that makes the list scroll.
 * `.tab-body` says `overflow-y: auto`, but that only bites when something above gives it a height,
 * and the library dialog and the world editor's side pane give it that height in different ways. A
 * screen that owns its own column works in both instead of depending on where it was dropped.
 */
export function buildScreen<Doc>(host: HTMLElement, spec: BuildSpec<Doc>): void {
  host.classList.add('bld-screen')

  let builds: Build<Doc>[] = []
  let assets: AssetItem[] = []
  /** presets somebody saved here, as opposed to the ones that ship in the code */
  let saved: Build<Doc>[] = []
  let loaded = false
  let loadError: string | null = null

  let step: Step = 'list'
  let draft: Draft<Doc> | null = null
  /** set when the form sent you to a sub-screen, so Back returns there instead of to the list */
  let fromForm = false

  let search = ''
  let classFilter = ''

  const bar = el('div', 'bld-bar')
  const scroll = el('div', 'bld-scroll')
  host.append(bar, scroll)

  const reload = async () => {
    try {
      const [b, a, pre] = await Promise.all([
        assetsvc.builds<Build<Doc>>(spec.kind),
        assetsvc.list(),
        assetsvc.builds<Build<Doc>>('presets').catch(() => []),
      ])
      builds = b
      assets = a.filter((it) => typeOf(it) === spec.assetType)
      saved = pre.filter((x) => x.for === spec.assetType)
      loadError = null
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
    }
    loaded = true
    draw()
  }

  /** A preset's name, whether it ships in the code or somebody saved it here. */
  const presetName = (id: string | null): string => {
    if (!id) return ''
    const built = spec.presets(null).find((p) => p.id === id)
    return built?.name ?? saved.find((x) => x.id === id)?.name ?? id
  }

  /* ---- step 1: the model ------------------------------------------------------------------- */

  function drawModels() {
    bar.append(button({ label: 'Back', icon: 'arrow-left', variant: 'ghost', onClick: () => { step = fromForm ? 'form' : 'list'; fromForm = false; draw() } }))
    bar.append(liveField({
      label: 'Search', value: search, placeholder: 'name, id or tag',
      onInput: (v: string) => { search = v; drawBody() },
    }))
    bar.append(select({
      label: 'Class', value: classFilter,
      options: ['', ...spec.classes].map((k) => ({ value: k, label: k || 'any class' })),
      onChange: (v) => { classFilter = v; drawBody() },
    }))
    bar.append(el('div', 'bld-spacer'))
    bar.append(button({
      label: 'No model for now', variant: 'ghost',
      title: `configure the ${spec.noun} first and attach a model later`,
      onClick: () => { draft!.asset = null; afterModel() },
    }))
    drawBody()

    function drawBody() {
      scroll.replaceChildren()
      if (!fromForm) scroll.append(steps('model'))
      const q = search.toLowerCase().trim()
      const shown = assets.filter((it) => {
        if (classFilter && it.kind !== classFilter) return false
        if (!q) return true
        return `${it.id} ${it.subject} ${it.kind} ${it.tags.join(' ')}`.toLowerCase().includes(q)
      })
      scroll.append(el('div', 'bld-count', `${shown.length} of ${assets.length} ${spec.noun} models`))
      if (!shown.length) {
        scroll.append(empty(assets.length
          ? 'No model matches that. Clear the search, or pick another class.'
          : `The library has no ${spec.noun} models yet. Make one on the Catalog tab, or carry on without one.`))
        return
      }
      const grid = el('div', 'bld-grid')
      for (const it of shown) grid.append(modelCard(it, draft!.asset === it.id, () => { draft!.asset = it.id; afterModel() }))
      scroll.append(grid)
    }
  }

  /** The card for a catalog asset: nothing numeric, because it has no document of its own. */
  function modelCard(item: AssetItem, on: boolean, onPick: () => void): HTMLElement {
    const card = el('button', `bld-card${on ? ' on' : ''}`)
    card.type = 'button'
    card.onclick = onPick
    card.append(shot(item, spec.icon))
    const meta = el('div', 'bld-meta')
    meta.append(el('div', 'bld-name', item.subject || item.id))
    meta.append(el('div', 'bld-sub', item.id))
    const tags = el('div', 'bld-tags')
    if (item.kind) tags.append(tag(item.kind))
    tags.append(item.finished ? tag('finished', 'ok') : item.mesh ? tag('meshed') : tag('no mesh', 'none'))
    meta.append(tags)
    card.append(meta)
    return card
  }

  /**
   * What a chosen model does to the draft, which is NOT "nothing".
   *
   * The asset's class is the best evidence anybody has about what sort of thing this is, so it sorts
   * the presets and — only for a draft nobody has configured yet — picks the starting document. It
   * never overwrites one that has been edited: choosing a new model for an existing build changes
   * what it LOOKS like, and silently replacing its numbers because the new body is filed under a
   * different class would be the worst kind of helpful.
   */
  function afterModel() {
    const kind = kindOfAsset(assets, draft!.asset)
    if (!draft!.existing && !draft!.preset && kind) draft!.doc = spec.defaultDoc(kind)
    if (!draft!.existing && !draft!.name && draft!.asset) {
      const it = assets.find((a) => a.id === draft!.asset)
      draft!.name = it?.subject || draft!.asset
      draft!.id = slugify(draft!.name)
    }
    step = fromForm ? 'form' : 'preset'
    fromForm = false
    draw()
  }

  /* ---- step 2: the preset ------------------------------------------------------------------ */

  function drawPresets() {
    bar.append(button({ label: 'Back', icon: 'arrow-left', variant: 'ghost', onClick: () => { step = fromForm ? 'form' : 'model'; fromForm = false; draw() } }))
    bar.append(el('div', 'bld-spacer'))
    bar.append(button({
      label: fromForm ? 'Leave it as it is' : 'Skip — start from the class template', variant: 'ghost',
      onClick: () => { step = 'form'; fromForm = false; draw() },
    }))

    scroll.replaceChildren()
    if (!fromForm) scroll.append(steps('preset'))
    const kind = kindOfAsset(assets, draft!.asset)

    const apply = (id: string, doc: Doc) => {
      draft!.preset = id
      draft!.doc = structuredClone(doc)
      step = 'form'
      fromForm = false
      draw()
    }

    const card = (id: string, name: string, note: string, doc: Doc, remove?: () => void) => {
      const c = el('div', `bld-preset${draft!.preset === id ? ' on' : ''}`)
      const pick = el('button', 'bld-preset-pick')
      pick.type = 'button'
      pick.append(el('div', 'bld-preset-name', name))
      pick.append(el('div', 'bld-preset-note', note))
      pick.append(el('div', 'bld-preset-spec', spec.describe(doc)))
      pick.onclick = () => apply(id, doc)
      c.append(pick)
      if (remove) {
        const foot = el('div', 'panel-actions')
        foot.append(button({ label: 'Delete', icon: 'trash', variant: 'ghost', onClick: remove }))
        c.append(foot)
      }
      return c
    }

    /*
     * YOURS FIRST. A preset somebody saved on this box is the one they are most likely to want
     * again, and the ones in the code are always there under it.
     */
    if (saved.length) {
      scroll.append(el('div', 'bld-count', `${saved.length} saved here`))
      const mine = el('div', 'bld-presets')
      for (const p of saved) {
        mine.append(card(p.id, p.name, p.notes || 'saved on this box', p.doc, () => void confirm({
          title: `Delete the ${p.name} preset?`, message: `${spec.noun}s built from it keep their numbers.`, ok: 'Delete', danger: true, icon: 'trash',
        }).then(async (yes) => { if (!yes) return; await assetsvc.deleteBuild('presets', p.id); toast('Preset deleted', 'ok'); await reload() })))
      }
      scroll.append(mine)
    }

    const built = spec.presets(kind)
    scroll.append(el('div', 'bld-count',
      kind ? `${built.length} built in, the ones that suit a ${kind} first` : `${built.length} built in`))
    const grid = el('div', 'bld-presets')
    for (const p of built) grid.append(card(p.id, p.name, p.note, p.doc))
    scroll.append(grid)
  }

  /* ---- step 3 and the editor: the whole thing ----------------------------------------------- */

  function drawForm() {
    bar.append(button({ label: 'Cancel', icon: 'arrow-left', variant: 'ghost', onClick: () => { draft = null; step = 'list'; draw() } }))
    bar.append(el('div', 'bld-spacer'))
    if (draft!.existing) {
      bar.append(button({
        label: 'Delete', icon: 'trash', variant: 'danger',
        onClick: () => void confirm({
          title: `Delete ${draft!.name || draft!.id}?`,
          message: 'The model stays in the library; only this goes.',
          ok: 'Delete', danger: true, icon: 'trash',
        }).then(async (yes) => {
          if (!yes) return
          const id = draft!.id
          await assetsvc.deleteBuild(spec.kind, id)
          toast(`Deleted ${id}`, 'ok')
          draft = null
          step = 'list'
          await reload()
        }),
      }))
    }
    bar.append(button({ label: 'Save', icon: 'check', variant: 'primary', onClick: () => void save() }))

    scroll.replaceChildren()
    if (!draft!.existing) scroll.append(steps('form'))

    /* The model, with the doors out of it: change it, preset it, or keep these numbers as one. */
    const item = assets.find((a) => a.id === draft!.asset)
    const head = el('div', 'bld-head')
    head.append(shot(item, spec.icon))
    const hm = el('div', 'bld-head-meta')
    hm.append(el('div', 'bld-name', draft!.name || draft!.id))
    hm.append(el('div', 'bld-sub', draft!.asset
      ? (item ? `${item.subject || item.id} · ${item.kind}` : `${draft!.asset} — not in this library`)
      : 'no model yet'))
    if (draft!.preset) hm.append(el('div', 'bld-sub', `from the ${presetName(draft!.preset)} preset`))
    const acts = el('div', 'panel-actions')
    acts.append(button({ label: 'Change model', icon: 'cube', variant: 'ghost', onClick: () => { fromForm = true; step = 'model'; draw() } }))
    acts.append(button({ label: 'Apply a preset', icon: 'sparkles', variant: 'ghost', onClick: () => { fromForm = true; step = 'preset'; draw() } }))
    acts.append(button({
      label: 'Save as a preset', icon: 'sparkles', variant: 'ghost',
      title: 'keep these numbers as a starting point for the next one',
      onClick: () => void ask({
        title: 'Save these numbers as a preset',
        label: 'Name',
        value: draft!.name ? `${draft!.name} setup` : '',
        ok: 'Save',
      }).then(async (name) => {
        if (!name) return
        const id = slugify(name)
        if (!id) { toast('That name has nothing to make an id from', 'warn'); return }
        await assetsvc.saveBuild('presets', id, { name, for: spec.assetType, asset: null, notes: '', doc: draft!.doc })
        toast(`Saved the ${name} preset`, 'ok')
        await reload()
      }),
    }))
    acts.append(button({
      label: 'Start from a template', icon: 'arrow-path', variant: 'ghost',
      title: 'the class default, with no preset',
      onClick: () => { draft!.doc = spec.defaultDoc(kindOfAsset(assets, draft!.asset)); draft!.preset = null; draw() },
    }))
    hm.append(acts)
    head.append(hm)
    scroll.append(head)

    /* The name and the id live here now, which is the only place they were ever settled. */
    const meta = group('Details', { collapsed: draft!.existing })
    const mb = bodyOf(meta)
    mb.append(liveField({ label: 'Name', value: draft!.name, onInput: (v: string) => { draft!.name = v } }))
    if (!draft!.existing) {
      mb.append(liveField({ label: 'Id', value: draft!.id, note: 'lowercase, dashes', onInput: (v: string) => { draft!.id = slugify(v) } }))
    } else {
      mb.append(readout('Id', draft!.id, true))
    }
    mb.append(textArea({ label: 'Notes', value: draft!.notes, rows: 3, onChange: (v) => { draft!.notes = v } }))
    scroll.append(meta)

    const form = el('div')
    scroll.append(form)
    spec.form(form, () => draft!.doc, (d) => { draft!.doc = d })
  }

  async function save() {
    const d = draft!
    if (!d.id) { toast(`${an(spec.noun).replace(/^./, (c) => c.toUpperCase())} needs an id — it is what a level says when it names this`, 'warn'); return }
    if (!d.existing && builds.some((b) => b.id === d.id)) { toast(`There is already ${an(spec.noun)} called ${d.id}`, 'warn'); return }
    const errors = spec.errors(d.doc)
    if (errors.length) { toast(errors[0], 'danger'); return }
    try {
      await assetsvc.saveBuild<Build<Doc>>(spec.kind, d.id, {
        name: d.name || d.id, asset: d.asset, preset: d.preset, notes: d.notes, doc: d.doc,
      })
      toast(`Saved ${d.name || d.id}`, 'ok')
      draft = null
      step = 'list'
      await reload()
    } catch (e) {
      toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, 'danger')
    }
  }

  /* ---- the list, which is where everybody starts -------------------------------------------- */

  function startNew() {
    draft = { id: '', name: '', asset: null, preset: null, notes: '', doc: spec.defaultDoc(null), existing: false }
    search = ''
    classFilter = ''
    step = 'model'
    draw()
  }

  /** The card for one built thing: its picture and the numbers that are REALLY on its document. */
  function builtCard(b: Build<Doc>, item: AssetItem | undefined, onOpen: () => void): HTMLElement {
    const card = el('button', 'bld-card')
    card.type = 'button'
    card.onclick = onOpen
    card.append(shot(item, spec.icon))
    const meta = el('div', 'bld-meta')
    meta.append(el('div', 'bld-name', b.name || b.id))
    meta.append(el('div', 'bld-sub', spec.summary(b.doc)))
    const tags = el('div', 'bld-tags')
    for (const t of spec.tags(b.doc)) tags.append(tag(t.text, t.cls))
    if (b.preset) tags.append(tag(presetName(b.preset), 'ok'))
    if (!b.asset) tags.append(tag('no model', 'warn'))
    meta.append(tags)
    card.append(meta)
    return card
  }

  function drawList() {
    bar.append(liveField({ label: 'Search', value: search, placeholder: 'name or id', onInput: (v: string) => { search = v; drawBody() } }))
    bar.append(el('div', 'bld-spacer'))
    bar.append(button({ label: `Add ${an(spec.noun)}`, icon: 'plus', variant: 'primary', onClick: startNew }))
    drawBody()

    function drawBody() {
      scroll.replaceChildren()
      if (!loaded) { scroll.append(empty('Loading…')); return }
      if (loadError) { scroll.append(empty(`The asset service did not answer: ${loadError}`)); return }
      if (!builds.length) {
        const box = el('div', 'bld-empty')
        box.append(icon(spec.icon, 40))
        box.append(el('h3', '', spec.emptyTitle))
        box.append(el('p', '', spec.emptyBlurb))
        box.append(button({ label: `Add ${an(spec.noun)}`, icon: 'plus', variant: 'primary', onClick: startNew }))
        scroll.append(box)
        return
      }
      const q = search.toLowerCase().trim()
      const shown = builds.filter((b) => !q || `${b.id} ${b.name}`.toLowerCase().includes(q))
      scroll.append(el('div', 'bld-count', `${shown.length} of ${builds.length}`))
      const grid = el('div', 'bld-grid')
      for (const b of shown) {
        grid.append(builtCard(b, assets.find((a) => a.id === b.asset), () => {
          draft = {
            id: b.id, name: b.name, asset: b.asset, preset: b.preset ?? null,
            notes: b.notes ?? '', doc: structuredClone(b.doc), existing: true,
          }
          step = 'form'
          draw()
        }))
      }
      scroll.append(grid)
    }
  }

  function draw() {
    bar.replaceChildren()
    scroll.replaceChildren()
    scroll.scrollTop = 0
    if (step === 'list' || !draft) { step = draft ? step : 'list'; drawList(); return }
    if (step === 'model') return drawModels()
    if (step === 'preset') return drawPresets()
    drawForm()
  }

  draw()
  void reload()
}
