// The asset catalog, in the editor: what the world is made of, and how far along each piece is.
//
// The whole pipeline reads as one column per item — spec, then a drawn view, then a mesh — because
// that IS the pipeline, and a person's question is almost always "which of these still needs
// something doing to it". The state chip answers it at a glance across the whole catalog.
//
// Nothing here knows what a model is. It POSTs to assetsvc and polls a job (see ../assetsvc.ts);
// which image model draws the view and which reconstructor meshes it is the service's business and
// is shown, read-only, under Service so that a person can see what they are about to spend a
// GPU-minute on.
import { Dialog, Tabs, ask, button, confirm, el, lightbox, toast, type Tab } from './shell'
import { icon } from './icons'
import { bodyOf, empty, group, readout, segmented, select, textArea, textField, toggle } from './controls'
import { MeshView } from './meshview'
import { assetsvc, type AssetItem, type AssetJob, type Material, type ModelRoster } from '../assetsvc'

/**
 * WHAT SORT OF THING IT IS, and where the list of sorts comes from.
 *
 * Rich, 2026-09-28: "we need to be able to set the catagory like traffic, hero car, furnature,
 * etc. and we need to be able to provide new classes of models and textures."
 *
 * These are the ones worth offering on an empty library; the list a person actually sees is these
 * PLUS every class already in use, so adding one is adding it to an item and there is no second
 * place for a class to exist and go stale. Same rule for material categories.
 */
/** The texture classes worth offering on an empty library; the rest come from what is in it. */
const MATERIAL_CATEGORIES = ['wall_house', 'wall_commercial', 'roof', 'road', 'ground_cover', 'metal', 'glass', 'wood', 'other']

const KINDS = [
  'hero-car', 'traffic', 'emergency', 'commercial-vehicle', 'pedestrian', 'animal',
  'furniture', 'building-dressing', 'vegetation', 'signage', 'prop',
]

/** The classes on offer: the standard ones, plus whatever is already in the library. */
function classesIn(used: (string | null | undefined)[], base = KINDS): string[] {
  const out = new Set(base)
  for (const k of used) if (k) out.add(k)
  return [...out].sort()
}

const NEW_CLASS = '\u0000new'
/** The selection when what is selected has not been created yet. Not a usable id, by construction. */
const PENDING = '\u0000pending'

/** A name to the id it will be filed under. Matches worldedit/slug.ts, which is not importable here. */
function slugOf(name: string): string {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/** Enough of an item to show while the service confirms it. Every generated field is empty. */
const EMPTY_ITEM: AssetItem = {
  id: '', subject: '', kind: 'prop', prompt: '', negative: '', notes: '', tags: [],
  chosen: null, created: '', updated: '', views: [], mesh: null, finished: null, state: 'spec', history: [],
}

/** A line with a warning triangle on it — for a state a person has to act on. */
const warnNote = (text: string) => {
  const p = el('div', 'panel-hint warn')
  p.append(icon('exclamation-triangle', 14), el('span', '', text))
  return p
}

const STATE_LABEL: Record<AssetItem['state'], string> = {
  spec: 'described',
  drawn: 'drawn',
  meshed: 'meshed',
  finished: 'ready',
}

export class AssetCatalog {
  dialog: Dialog
  private tabs: Tabs
  private items: AssetItem[] = []
  private roster: ModelRoster | null = null
  private reachable = false
  private selected: string | null = null
  /**
   * EDITS THAT HAVE NOT BEEN SAVED, and the bar that says so.
   *
   * Every field used to PUT on blur, which is a library that changes under you as you tab through
   * it and has no way back. Rich, 2026-09-28: "if editing an item we need a save changes button
   * and confirmation before navigating away." So a field writes here, and only Save writes to the
   * service — which also means the change to the id, the class and the prompt land as one record
   * rather than three.
   */
  private draft: Partial<AssetItem> = {}
  private saveBar: HTMLElement | null = null
  /**
   * AN ITEM THAT DOES NOT EXIST YET, sitting in the list where it will live.
   *
   * Rich, 2026-09-28: "This form needs some work, it is super cramped. Why don't we just not have
   * a dialog and just place it in the catalog directly, then move it in the listing order once the
   * slug is set (or changed)". A 420px modal over the catalog is a worse place to fill in three
   * fields than the detail pane, which is right there and empty — and a new item appearing in the
   * list as you name it says what will happen far better than any label can.
   */
  private pending: { id: string; subject: string; kind: string } | null = null
  /** what is typed in the search box; a question being asked now, so it is not remembered */
  private find = ''
  private listBox = el('div', 'asset-list-box')
  /** a pinned seed per item; absent means "a new one every draw" */
  private seeds = new Map<string, number>()

  /* ---- the materials half ------------------------------------------------------------------- */
  private materials: Material[] = []
  private matHost: HTMLElement | null = null
  private material: string | null = null
  private matFind = ''
  /** which view of the material is on the stage — the sample wall, or one map flat */
  private matMode: 'tiled' | 'albedo' | 'normal' | 'roughness' = 'tiled'
  /** edits to the record that have not been saved, exactly as the catalog half works */
  private matDraft: Partial<Material> = {}
  /**
   * Materials with a freshly drawn set waiting to be accepted.
   *
   * The maps are on the service under `<id>/draft/` and the live ones are untouched, so this is
   * only "is there one to look at" — the truth is on disk and survives a reload.
   */
  private matDrafts = new Set<string>()
  private matBusy: string | null = null
  /** a texture being described that does not exist yet */
  private pendingMaterial: { id: string; name: string; category: string; metres_per_tile: number; prompt: string; seed?: number; idTouched: boolean } | null = null
  /** the 3D preview, one at a time — a WebGL context per click exhausts the browser's supply */
  private mesh3d: MeshView | null = null
  private listHost = el('div', 'asset-list')
  private detailHost = el('div', 'asset-detail')

  constructor() {
    const tabs: Tab[] = [
      { id: 'catalog', label: 'Catalog', icon: 'cube', build: (h) => this.buildCatalog(h) },
      { id: 'materials', label: 'Materials', icon: 'swatch', build: (h) => void this.buildMaterials(h) },
      { id: 'service', label: 'Service', icon: 'beaker', build: (h) => void this.buildService(h) },
    ]
    this.tabs = new Tabs(tabs)
    // A closed dialog must give its WebGL context back. Browsers cap live contexts (around
    // sixteen in Chromium) and silently lose the oldest when you go over, so a preview left
    // running behind a closed panel eventually kills the viewer in another tab of the same app.
    this.dialog = new Dialog({
      title: 'Assets', icon: 'cube', size: 'xl', movable: true,
      // unsaved edits in the detail pane are the one thing in here that only exists in the page.
      // A BOOLEAN when there is nothing to ask: the promise path costs a dialog round trip and is
      // the interesting case, so the common one should not go anywhere near it.
      beforeClose: () => (this.dirty ? this.mayLeave('close the catalog') : true),
      onClose: () => { this.mesh3d?.dispose(); this.mesh3d = null },
    })
    this.dialog.body.append(this.tabs.root)
    this.dialog.body.classList.add('asset-body')
    /*
     * TWO THINGS, BOTH ABOUT THE LIBRARY IN FRONT OF YOU.
     *
     * "Push to S3" was here as well — a deployment operation, offered beside "New item", visible
     * whether or not a bucket is configured, and already present in the Service tab beside the
     * endpoint it pushes to and the note about what it skips (Rich, 2026-09-28: "Still have push
     * to s3 buttons on assets, no makey sense"). It lives there, where the bucket does.
     */
    this.dialog.footer(
      button({ label: 'New item', icon: 'plus', onClick: () => this.create() }),
      button({ label: 'Refresh', icon: 'arrow-path', onClick: () => void this.refresh() }),
    )
  }

  async open() {
    this.dialog.open()
    await this.refresh()
  }

  private get dirty(): boolean {
    return Object.keys(this.draft).length > 0
  }

  /** Ask before throwing away unsaved edits. True means "go ahead". */
  private async mayLeave(what: string): Promise<boolean> {
    if (!this.dirty) return true
    const fields = Object.keys(this.draft).join(', ')
    return confirm({
      title: 'Unsaved changes',
      message: `${this.selected}: ${fields} changed but not saved. ${what[0].toUpperCase()}${what.slice(1)} anyway?`,
      ok: 'Discard',
      danger: true,
    })
  }

  async refresh() {
    this.reachable = await assetsvc.health()
    if (this.reachable) {
      try {
        this.items = await assetsvc.list()
      } catch (e) {
        toast(`assetsvc: ${(e as Error).message}`, 'danger')
        this.items = []
      }
    }
    this.tabs.invalidate()
  }

  // ---- catalog tab ---------------------------------------------------------------------------

  private buildCatalog(host: HTMLElement) {
    if (!this.reachable) {
      host.append(this.notConfigured())
      return
    }
    const split = el('div', 'asset-split')
    /*
     * A SEARCH BOX, because the catalog is a hundred and twenty rows in a 280px column (Rich,
     * 2026-09-28: "Need a search field for the catalog"). It matches the id, the subject and the
     * class — the three things anybody knows about a thing they are looking for — and it is not
     * remembered between visits, because it is a question rather than a preference.
     */
    this.listBox.replaceChildren(this.searchBox(), this.listHost)
    split.append(this.listBox, this.detailHost)
    host.append(split)
    this.renderList()
    this.renderDetail()
  }

  /**
   * "No service" is a normal state, not an error — generation is off by default and everything
   * else works without it. But it is a state for a PERSON, not a paragraph of setup instructions:
   * what is off, where it looked, and one line saying where the instructions are. The previous
   * version put the README path, the two commands and a query-string override into the panel
   * (Rich, 2026-09-27: "make these more production grade").
   */
  private notConfigured(): HTMLElement {
    const wrap = el('div', 'asset-none')
    wrap.append(el('p', '', 'Asset generation is off.'))
    wrap.append(readout('endpoint', assetsvc.url, true), readout('status', 'not answering'))
    wrap.append(el('p', 'dim', 'Everything else in the editor works without it.'))
    return wrap
  }

  private searchBox(): HTMLElement {
    const wrap = el('div', 'tree-filter')
    const i = el('input', 'input wide') as HTMLInputElement
    i.type = 'search'
    i.placeholder = 'find a car, a class, a word'
    i.value = this.find
    // `input`, not `change`: a filter you have to leave the box to apply is a filter you have to
    // be told about
    i.oninput = () => { this.find = i.value; this.renderList() }
    wrap.append(icon('magnifying-glass', 14), i)
    return wrap
  }

  /** Does this row answer what was typed? Id, subject and class — nothing else is searched for. */
  private matches(it: { id: string; subject?: string; kind?: string }): boolean {
    const q = this.find.trim().toLowerCase()
    if (!q) return true
    return `${it.id} ${it.subject ?? ''} ${it.kind ?? ''}`.toLowerCase().includes(q)
  }

  private renderList() {
    this.listHost.replaceChildren()
    if (!this.items.length && !this.pending) {
      this.listHost.append(empty('Nothing in the catalog yet. “New item” describes one.'))
      return
    }
    // the new row sorts by the id as it is typed, so it walks to where it will live
    const rows: { id: string; node: HTMLElement }[] = []
    // the one being named always shows, whatever is in the search box: it is what you are doing
    if (this.pending) rows.push({ id: this.pending.id, node: this.pendingRow() })
    for (const it of this.items) {
      if (!this.matches(it)) continue
      const row = el('button', `asset-row${it.id === this.selected ? ' on' : ''}`)
      const thumb = el('div', 'asset-thumb')
      if (it.chosen) {
        const img = el('img')
        img.src = assetsvc.fileUrl(it.id, `views/${it.chosen}`)
        img.loading = 'lazy'
        thumb.append(img)
      } else {
        thumb.append(icon('photo', 18))
      }
      const text = el('div', 'asset-row-text')
      text.append(el('span', 'asset-row-id', it.id))
      text.append(el('span', 'asset-row-sub', it.subject))
      row.append(thumb, text, el('span', `chip state-${it.state}`, STATE_LABEL[it.state]))
      row.onclick = async () => {
        if (it.id === this.selected) return
        if (!(await this.mayLeave(`open ${it.id}`))) return
        this.draft = {}
        this.selected = it.id
        this.renderList()
        this.renderDetail()
      }
      rows.push({ id: it.id, node: row })
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const r of rows) this.listHost.append(r.node)
    if (rows.length <= (this.pending ? 1 : 0) && this.find.trim()) {
      this.listHost.append(empty(`Nothing matching “${this.find.trim()}”.`))
    }
  }

  /** The row for the item being named: no thumbnail, no state, because neither exists yet. */
  private pendingRow(): HTMLElement {
    const p = this.pending!
    const row = el('button', `asset-row new${this.selected === PENDING ? ' on' : ''}`)
    const thumb = el('div', 'asset-thumb')
    thumb.append(icon('plus', 18))
    const text = el('div', 'asset-row-text')
    text.append(el('span', 'asset-row-id', p.id || 'new item'), el('span', 'asset-row-sub', p.subject || ''))
    row.append(thumb, text, el('span', 'chip state-spec', 'not created'))
    row.onclick = () => { this.selected = PENDING; this.renderList(); this.renderDetail() }
    return row
  }

  private renderDetail() {
    this.detailHost.replaceChildren()
    if (this.selected === PENDING && this.pending) { this.renderNew(); return }
    const it = this.items.find((x) => x.id === this.selected)
    if (!it) {
      this.detailHost.append(empty('Pick an item.'))
      return
    }

    const head = el('header', 'asset-detail-head')
    head.append(el('h2', '', it.id), el('span', `chip state-${it.state}`, STATE_LABEL[it.state]))
    this.detailHost.append(head)

    // ---- the pipeline, as three steps in order
    const steps = el('div', 'asset-steps')

    // 1 · the description
    const spec = group('1 · Described')
    const specBody = bodyOf(spec)
    const edit = <K extends keyof AssetItem>(k: K, v: AssetItem[K]) => {
      if (v === it[k]) delete this.draft[k]
      else this.draft[k] = v
      this.showSaveBar()
    }
    const kinds = classesIn(this.items.map((x) => x.kind))
    specBody.append(
      textField({ label: 'Subject', value: this.draft.subject ?? it.subject, onChange: (v) => edit('subject', v) }),
      select({
        label: 'Class',
        value: this.draft.kind ?? it.kind ?? 'prop',
        options: [...kinds.map((k) => ({ value: k, label: k.replace(/-/g, ' ') })), { value: NEW_CLASS, label: 'new class…' }],
        note: 'what it is, for the roster and for what places it',
        onChange: (v) => {
          if (v !== NEW_CLASS) { edit('kind', v); return }
          void ask({ title: 'New class', label: 'name', placeholder: 'market-stall', icon: 'plus', validate: (x) => (slugOf(x) ? null : 'letters and digits') })
            .then((name) => { if (name) { edit('kind', slugOf(name)); this.renderDetail() } else this.renderDetail() })
        },
      }),
      promptField('Prompt', this.draft.prompt ?? it.prompt, (v) => edit('prompt', v)),
      promptField('Avoid', this.draft.negative ?? it.negative, (v) => edit('negative', v)),
    )
    this.saveBar = el('div', 'panel-actions asset-save')
    this.saveBar.append(
      button({ label: 'Save changes', icon: 'document-arrow-down', variant: 'primary', onClick: () => void this.commit() }),
      button({ label: 'Discard', icon: 'arrow-uturn-left', variant: 'ghost', onClick: () => { this.draft = {}; this.renderDetail() } }),
    )
    specBody.append(this.saveBar)
    this.showSaveBar()
    steps.append(spec)

    // 2 · the view
    const drawn = group(`2 · Drawn${it.views.length ? ` (${it.views.length})` : ''}`)
    const drawnBody = bodyOf(drawn)
    if (it.views.length) {
      const strip = el('div', 'asset-views')
      for (const v of it.views) {
        const a = el('button', `asset-view${v === it.chosen ? ' on' : ''}`)
        const img = el('img')
        img.src = assetsvc.fileUrl(it.id, `views/${v}`)
        img.loading = 'lazy'
        a.append(img)
        /*
         * CLICK OPENS IT; the choice is made from inside.
         *
         * A click used to pick the view for meshing straight from the grid — a decision about
         * which of six drawings becomes a mesh, taken at ninety pixels wide, with no way to see
         * one properly short of opening its file URL in another tab. The lightbox carries the
         * whole set so the comparison can be made with the arrow keys, and the choice is a button
         * in it rather than a side effect of looking.
         */
        a.title = v === it.chosen ? `${v} — the one that will be meshed` : v
        a.onclick = () => lightbox({
          items: it.views.map((name) => ({
            src: assetsvc.fileUrl(it.id, `views/${name}`),
            caption: name === it.chosen ? `${name} — will be meshed` : name,
            current: name === it.chosen,
          })),
          index: it.views.indexOf(v),
          action: {
            label: 'Mesh this one',
            icon: 'cube',
            onPick: (idx) => void this.save(it.id, { chosen: it.views[idx] }),
          },
        })
        strip.append(a)
      }
      drawnBody.append(strip)
    } else {
      drawnBody.append(empty('No view yet.'))
    }
    drawnBody.append(
      textField({
        label: 'seed',
        value: this.seeds.has(it.id) ? String(this.seeds.get(it.id)) : '',
        type: 'number',
        step: 1,
        placeholder: 'a new one each draw',
        note: 'a seed draws the same thing again, which is how you tell a prompt change from a dice roll',
        onChange: (v) => {
          const n = Math.floor(Number(v))
          if (v.trim() && Number.isFinite(n) && n >= 0) this.seeds.set(it.id, n)
          else this.seeds.delete(it.id)
        },
      }),
      rowOf(
        button({ label: it.views.length ? 'Draw another' : 'Draw', icon: 'sparkles', variant: it.views.length ? 'default' : 'primary', onClick: () => void this.draw(it.id) }),
        el('span', 'dim', 'flux — about ten seconds'),
      ),
    )
    steps.append(drawn)

    // 3 · the mesh
    const meshed = group('3 · Meshed')
    const meshBody = bodyOf(meshed)
    if (it.mesh) {
      /*
       * THE MESH, IN 3D, HERE.
       *
       * This used to be two file sizes and a download link — so the only way to see whether a
       * reconstruction was any good was to download it and open it in something else. The viewer
       * came from ext/assetlib, which was a separate process on a separate port behind a tunnel,
       * and `ext/*` is gitignored so it does not survive a clone.
       *
       * One MeshView per panel render, disposed with the panel: a WebGL context is not free and
       * leaking one per click is how a tab runs out of them (browsers cap it around sixteen).
       */
      this.mesh3d?.dispose()
      const view = new MeshView({ remember: 'catalog' })
      this.mesh3d = view
      // for probes: the one preview currently on screen
      ;(window as unknown as { __meshview?: MeshView }).__meshview = view
      meshBody.append(view.root)
      void view.load(assetsvc.fileUrl(it.id, it.finished ? 'mesh.finished.glb' : 'mesh.glb'))
      view.start()
      // the toggles read the viewer, which read what it was left as — a hard-coded `true` here
      // would turn spin back on at every render and make the preference look ignored
      const viewControls = rowOf(
        button({ label: 'Pop out', icon: 'arrows-pointing-out', title: 'the model, big', onClick: () => view.popOut(it.id) }),
        toggle({ label: 'spin', value: view.spinning, onChange: (v) => view.setSpin(v) }),
        toggle({ label: 'wireframe', value: view.wireframe, onChange: (v) => view.setWireframe(v) }),
      )
      meshBody.append(viewControls)
      /*
       * IF IT IS RIGGED, SAY SO — and say what kind of rig.
       *
       * A Rigify control rig is around seven hundred bones and only a few dozen deform the mesh;
       * the rest is IK plumbing and the handles a human grabs in Blender. A character that
       * arrives with all of them is an AUTHORING rig, not a runtime one, and the difference is
       * the sort of thing that is discovered much later and much more expensively.
       *
       * Added after the load resolves, because whether there is a skeleton is not known until
       * the glb has been parsed.
       */
      void view.loaded.then(() => {
        const rig = view.rig()
        if (!rig) {
          meshBody.append(readout('Rig', 'none'))
          return
        }
        viewControls.append(toggle({ label: 'skeleton', value: false, onChange: (v) => view.setSkeleton(v) }))
        meshBody.append(readout('Rig', `${rig.convention} · ${rig.bones} bones${rig.skinned ? ' · skinned' : ''}`))
        if (rig.convention === 'rigify') {
          meshBody.append(readout('', `${rig.deform} deform · ${rig.control} control · ${rig.mch} mechanism`))
        }
        // THE ROLES ARE THE USEFUL PART for anything that is not a character: a car's rig matters
        // because something can find its four wheels and its steering axis, not because it has
        // eleven bones.
        const roles = Object.entries(rig.roles).sort((a, b) => b[1] - a[1])
        if (roles.length) {
          meshBody.append(readout('Drives', roles.map(([r, n]) => (n > 1 ? `${n}x ${r}` : r)).join(' · ')))
        }
      })
      meshBody.append(readout('Raw mesh', `${(it.mesh / 1e6).toFixed(1)} MB`))
      if (it.finished) meshBody.append(readout('Finished', `${(it.finished / 1e3).toFixed(0)} kB`))
      const links = rowOf()
      const a = el('a', 'btn')
      a.href = assetsvc.fileUrl(it.id, it.finished ? 'mesh.finished.glb' : 'mesh.glb')
      a.download = `${it.id}.glb`
      a.append(icon('cube', 16), el('span', 'btn-label', it.finished ? 'Download finished glb' : 'Download raw glb'))
      links.append(a)
      meshBody.append(links)
    } else {
      this.mesh3d?.dispose()
      this.mesh3d = null
      meshBody.append(empty(it.views.length ? 'Not meshed yet.' : 'Draw a view first.'))
    }
    meshBody.append(
      rowOf(
        button({
          label: it.mesh ? 'Mesh again' : 'Mesh in 3D',
          icon: 'cube',
          variant: it.views.length && !it.mesh ? 'primary' : 'default',
          onClick: () => void this.mesh(it.id),
        }),
        el('span', 'dim', 'TRELLIS — a minute or more, one at a time'),
      ),
    )
    if (!it.views.length) meshBody.querySelector<HTMLButtonElement>('.btn')!.disabled = true
    steps.append(meshed)

    this.detailHost.append(steps)

    // ---- provenance. The reason this is here and not hidden: an asset whose origin nobody can
    // reconstruct is one you cannot regenerate when the style changes.
    if (it.history?.length) {
      const hist = group(`Provenance (${it.history.length})`, { collapsed: true })
      const hb = bodyOf(hist)
      for (const h of [...it.history].reverse()) {
        const r = el('div', 'asset-hist')
        r.append(el('span', 'asset-hist-step', h.step))
        r.append(el('span', 'asset-hist-what', [h.model, h.file, h.seconds ? `${h.seconds.toFixed(1)}s` : null].filter(Boolean).join(' · ')))
        r.append(el('span', 'asset-hist-at', new Date(h.at).toLocaleString()))
        hb.append(r)
      }
      this.detailHost.append(hist)
    }

    const danger = rowOf(button({ label: 'Delete item', icon: 'trash', variant: 'danger', onClick: () => void this.remove(it.id) }))
    danger.classList.add('asset-danger')
    this.detailHost.append(danger)
  }

  // ---- service tab ---------------------------------------------------------------------------

  private async buildService(host: HTMLElement) {
    if (!this.reachable) {
      host.append(this.notConfigured())
      return
    }
    const g = group('Service')
    bodyOf(g).append(readout('URL', assetsvc.url))
    host.append(g)
    try {
      this.roster = await assetsvc.models()
    } catch (e) {
      host.append(empty(`Could not read the roster: ${(e as Error).message}`))
      return
    }
    const r = this.roster

    const models = group('Models')
    const mb = bodyOf(models)
    for (const m of r.models) {
      const live = r.reachable[m.id]
      const row = el('div', 'asset-model')
      const dot = el('span', `dot ${live?.ok ? 'ok' : m.configured ? 'bad' : 'off'}`)
      row.append(dot, el('span', 'asset-model-id', m.id), el('span', 'asset-model-kind', m.kind))
      const def = r.defaults.image === m.id || r.defaults.mesh === m.id
      if (def) row.append(el('span', 'chip', 'default'))
      row.append(el('span', 'asset-model-detail', live?.ok ? (live.detail ?? 'reachable') : (live?.detail ?? 'unreachable')))
      mb.append(row)
    }
    // Deliberately read-only. Which model is in use is a deployment decision (an env var or the
    // chart), not a per-person toggle — two people silently on different models is how you get a
    // catalog nobody can explain.
    mb.append(el('p', 'group-note', 'Read-only: the roster and the defaults come from the service’s models.json and environment. Changing them is a deployment change.'))
    host.append(models)

    const bucket = group('Bucket')
    const bb = bodyOf(bucket)
    if (r.s3.configured) {
      bb.append(readout('Bucket', `${r.s3.bucket}/${r.s3.prefix}`, false), readout('Endpoint', r.s3.endpoint, false))
      bb.append(
        rowOf(
          button({ label: 'Push', icon: 'document-arrow-down', onClick: () => void this.sync('push') }),
          button({ label: 'Pull', icon: 'arrow-path', onClick: () => void this.sync('pull') }),
          el('span', 'dim', 'objects whose size already matches are skipped'),
        ),
      )
    } else {
      bb.append(empty('No bucket configured. Save and load are off.'))
    }
    host.append(bucket)
  }

  // ---- actions --------------------------------------------------------------------------------

  /** The bar only exists while there is something to save. */
  private showSaveBar(): void {
    if (this.saveBar) this.saveBar.hidden = !this.dirty
  }

  /** Write the draft, as one record. */
  private async commit(): Promise<void> {
    const id = this.selected
    if (!id || !this.dirty) return
    const patch = this.draft
    this.draft = {}
    try {
      await assetsvc.put({ id, ...patch })
      await this.refresh()
      toast(`saved ${id}`, 'ok')
    } catch (e) {
      this.draft = patch // it did not land, so it is still unsaved
      toast(`save: ${(e as Error).message}`, 'danger')
    }
  }

  private async save(id: string, spec: Partial<AssetItem>) {
    try {
      await assetsvc.put({ id, ...spec })
      await this.refresh()
    } catch (e) {
      toast(`save: ${(e as Error).message}`, 'danger')
    }
  }

  /**
   * The materials browser: the other half of the library, and the same shape as the first half.
   *
   * A LIST AND A DETAIL PANEL, because a texture is a thing you keep working on. Rich,
   * 2026-09-28: "Need a detail panel for each texture where we can capture prompts and edit them
   * and regenerate textures (don't blow away old copies until an explicit save operation
   * happens!)" — so the prompt lives on the record, Regenerate writes a DRAFT, and the live maps
   * are only replaced when somebody presses Save.
   *
   * The preview is a sample wall eight metres across so `metres_per_tile` is legible as a RATIO:
   * at 2 m you count four courses across it, at 0.5 m sixteen. A texture whose tile size is wrong
   * looks perfectly good on its own and absurd on a building, and that number is the one thing a
   * generated surface reliably gets wrong. The same viewer shows one map flat when what you are
   * judging is the pixels rather than the scale.
   */
  private async buildMaterials(host: HTMLElement) {
    host.replaceChildren()
    try {
      this.materials = (await assetsvc.materials()).materials
    } catch {
      host.append(this.notConfigured())
      return
    }
    this.matHost = el('div', 'material-split')
    host.append(this.matHost)
    if (!this.material && this.materials.length) this.material = this.materials[0].id
    this.renderMaterials()
  }

  private renderMaterials() {
    const host = this.matHost
    if (!host) return
    host.replaceChildren()

    /* left: the one you are looking at */
    const left = el('div', 'material-side')
    const stage = el('div', 'material-stage')
    const current = this.materials.find((m) => m.id === this.material) ?? null
    this.mesh3d ??= new MeshView({ spin: false, remember: 'materials' })
    const view = this.mesh3d
    ;(window as unknown as { __meshview?: MeshView }).__meshview = view
    stage.append(view.root)
    const caption = el('div', 'material-caption')
    stage.append(caption)
    view.start()

    /*
     * ONE CONTROL FOR WHAT YOU ARE LOOKING AT, not two buttons that do nearly the same thing.
     *
     * "tiled" answers "is the tile the right size"; the three maps answer "are the pixels any
     * good". They were a Pop out button and a lightbox button side by side, which is two ways to
     * make it bigger and no way to say what you wanted bigger (Rich, 2026-09-28: "These buttons
     * are confusing, they do kind of the same thing. Why isn't the tiled vs up close just an
     * option in the viewer?").
     */
    const modes = segmented<'tiled' | 'albedo' | 'normal' | 'roughness'>({
      value: this.matMode,
      options: [
        { value: 'tiled', label: 'tiled' },
        { value: 'albedo', label: 'albedo' },
        { value: 'normal', label: 'normal' },
        { value: 'roughness', label: 'rough' },
      ],
      onChange: (v) => { this.matMode = v; this.showMaterial(current, caption) },
    })
    const acts = el('div', 'panel-actions')
    acts.append(
      button({ label: 'Pop out', icon: 'arrows-pointing-out', title: 'the same view, big', onClick: () => view.popOut(current?.name ?? 'Material') }),
      button({ label: 'New texture', icon: 'plus', variant: 'primary', onClick: () => this.newMaterial() }),
    )
    left.append(stage, modes, acts)
    this.showMaterial(current, caption)

    /* right: the library, and the one selected in detail */
    const right = el('div', 'material-right')
    right.append(this.materialSearch())
    const q = this.matFind.trim().toLowerCase()
    const shown = this.materials.filter((m) => !q || `${m.id} ${m.name} ${m.category}`.toLowerCase().includes(q))
    if (this.pendingMaterial) right.append(this.materialForm(null))
    else if (current) right.append(this.materialForm(current))

    const browser = el('div', 'material-list')
    const byCategory = new Map<string, Material[]>()
    for (const m of shown) byCategory.set(m.category ?? 'other', [...(byCategory.get(m.category ?? 'other') ?? []), m])
    for (const [cat, items] of [...byCategory].sort()) {
      const g = group(`${cat.replace(/_/g, ' ')} (${items.length})`)
      const b = bodyOf(g)
      for (const m of items) {
        const row = el('button', `material-row${m.id === this.material ? ' on' : ''}`)
        row.dataset.id = m.id
        const swatch = el('img', 'material-swatch') as HTMLImageElement
        swatch.src = assetsvc.materialUrl(m.id, m.albedo)
        swatch.loading = 'lazy'
        swatch.alt = ''
        const text = el('div', 'material-text')
        text.append(el('span', 'material-name', m.name), el('span', 'material-sub', `${m.metres_per_tile} m tile`))
        row.append(swatch, text)
        row.onclick = () => {
          this.material = m.id
          this.pendingMaterial = null
          this.matDraft = {}
          this.renderMaterials()
        }
        b.append(row)
      }
      browser.append(g)
    }
    if (!shown.length) browser.append(empty(this.materials.length ? `Nothing matching “${this.matFind.trim()}”.` : 'No materials yet. “New texture” describes one.'))
    right.append(browser)
    host.append(left, right)
  }

  private materialSearch(): HTMLElement {
    const wrap = el('div', 'tree-filter')
    const i = el('input', 'input wide') as HTMLInputElement
    i.type = 'search'
    i.placeholder = `find one of ${this.materials.length}`
    i.value = this.matFind
    i.oninput = () => {
      this.matFind = i.value
      this.renderMaterials()
      const again = this.matHost?.querySelector<HTMLInputElement>('.tree-filter input')
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length) }
    }
    wrap.append(icon('magnifying-glass', 14), i)
    return wrap
  }

  /** Put the current material (or its draft) on the stage, in whichever mode is chosen. */
  private showMaterial(m: Material | null, caption: HTMLElement): void {
    const view = this.mesh3d
    if (!view) return
    if (!m) { view.clear(); caption.textContent = this.pendingMaterial ? 'nothing drawn yet' : 'nothing selected'; return }
    // a draft is shown INSTEAD of the live maps, and said so, because otherwise "regenerate" looks
    // like it did nothing
    const drafted = this.matDrafts.has(m.id)
    const at = (f?: string) => (f ? assetsvc.materialUrl(m.id, drafted ? `draft/${f.split('/').pop()}` : f) : undefined)
    caption.textContent = `${m.name} · ${m.metres_per_tile} m tile · ${(m.category ?? 'other').replace(/_/g, ' ')}${drafted ? ' · DRAFT, not saved' : ''}`
    void view.showMaterial({
      metres_per_tile: m.metres_per_tile,
      albedo: at(drafted ? 'albedo.jpg' : m.albedo)!,
      normal: at(drafted ? 'normal.png' : m.normal),
      roughness: at(drafted ? 'roughness.jpg' : m.roughness),
      mode: this.matMode,
    })
    for (const n of this.matHost?.querySelectorAll('.material-row') ?? []) {
      n.classList.toggle('on', (n as HTMLElement).dataset.id === m.id)
    }
  }

  /**
   * The form for one texture: what it is, how big a tile is, and the prompt that drew it.
   *
   * THE PROMPT IS THE MATERIAL. A texture you cannot re-draw is a texture you cannot improve, so
   * it is kept on the record and it is editable — and Regenerate spends a GPU on the edited one
   * without touching what is on disk (Rich: "don't blow away old copies until an explicit save
   * operation happens!").
   */
  private materialForm(m: Material | null): HTMLElement {
    const making = !m
    const p = this.pendingMaterial
    const g = group(making ? 'New texture' : m!.name, { note: making ? undefined : m!.id })
    const b = bodyOf(g)
    const draft = this.matDraft
    const val = <K extends keyof Material>(k: K): Material[K] | undefined =>
      (draft[k] as Material[K] | undefined) ?? (making ? (p as unknown as Material)?.[k] : m![k])

    const set = <K extends keyof Material>(k: K, v: Material[K]) => {
      if (making) { (p as unknown as Record<string, unknown>)[k as string] = v; this.renderMaterials(); return }
      if (v === m![k]) delete draft[k]
      else (draft as Record<string, unknown>)[k as string] = v
      this.renderMaterials()
    }

    const nameField = textField({
      label: 'name',
      value: String(val('name') ?? ''),
      placeholder: 'red common brick',
      onChange: (v) => {
        if (making) { p!.name = v; p!.id = p!.idTouched ? p!.id : slugOf(v).replace(/-/g, '_'); this.renderMaterials() }
        else set('name', v)
      },
    })
    b.append(nameField)
    if (making) {
      const idField = textField({
        label: 'id',
        value: p!.id,
        placeholder: 'red_common_brick',
        note: 'what it is filed under; follows the name until you change it',
        onChange: (v) => { p!.idTouched = true; p!.id = slugOf(v).replace(/-/g, '_'); this.renderMaterials() },
      })
      b.append(idField)
    }

    const cats = classesIn(this.materials.map((x) => x.category), MATERIAL_CATEGORIES)
    b.append(select({
      label: 'category',
      value: String(val('category') ?? 'wall_house'),
      options: [...cats.map((c) => ({ value: c, label: c.replace(/_/g, ' ') })), { value: NEW_CLASS, label: 'new class…' }],
      onChange: (v) => {
        if (v !== NEW_CLASS) { set('category', v); return }
        void ask({ title: 'New texture class', label: 'name', placeholder: 'cobblestone', icon: 'plus', validate: (x) => (slugOf(x) ? null : 'letters and digits') })
          .then((name) => { if (name) set('category', slugOf(name).replace(/-/g, '_')); else this.renderMaterials() })
      },
    }))
    b.append(textField({
      label: 'metres per tile',
      value: String(val('metres_per_tile') ?? 2),
      type: 'number',
      step: 0.1,
      note: 'the whole game: how much wall one tile covers',
      onChange: (v) => set('metres_per_tile', Number(v) as Material['metres_per_tile']),
    }))
    b.append(textArea({
      label: 'prompt',
      value: String(val('prompt') ?? ''),
      rows: 4,
      note: 'what it is. The straight-down, flat-light, edge-to-edge rules are added for you.',
      onChange: (v) => set('prompt', v as Material['prompt']),
    }))
    b.append(textField({
      label: 'seed',
      value: val('seed') === undefined || val('seed') === null ? '' : String(val('seed')),
      type: 'number',
      step: 1,
      placeholder: 'a new one each time',
      onChange: (v) => set('seed', (v.trim() ? Number(v) : undefined) as Material['seed']),
    }))

    const acts = el('div', 'panel-actions')
    if (making) {
      acts.append(
        button({
          label: 'Draw it',
          icon: 'sparkles',
          variant: 'primary',
          onClick: () => void this.generateMaterial(p!.id, true),
        }),
        button({ label: 'Cancel', variant: 'ghost', onClick: () => { this.pendingMaterial = null; this.renderMaterials() } }),
        button({ label: 'Upload instead', icon: 'arrow-up-tray', variant: 'ghost', onClick: () => this.uploadMaterial(p!.id) }),
      )
    } else {
      const drafted = this.matDrafts.has(m!.id)
      acts.append(button({
        label: this.matBusy === m!.id ? 'Drawing…' : 'Regenerate',
        icon: 'sparkles',
        onClick: () => void this.generateMaterial(m!.id, false),
      }))
      if (drafted) {
        acts.append(
          button({ label: 'Save the new one', icon: 'document-arrow-down', variant: 'primary', onClick: () => void this.saveMaterialDraft(m!.id) }),
          button({ label: 'Discard it', icon: 'arrow-uturn-left', variant: 'ghost', onClick: () => void this.discardMaterialDraft(m!.id) }),
        )
      } else if (Object.keys(draft).length) {
        acts.append(button({ label: 'Save changes', icon: 'document-arrow-down', variant: 'primary', onClick: () => void this.saveMaterialRecord(m!.id) }))
      }
      acts.append(button({ label: 'Upload maps', icon: 'arrow-up-tray', variant: 'ghost', onClick: () => this.uploadMaterial(m!.id) }))
    }
    b.append(acts)
    if (this.matDrafts.has(m?.id ?? '')) {
      b.append(warnNote('A newly drawn set is on the stage. The one in use has not been touched until you save.'))
    }
    return g
  }

  private newMaterial(): void {
    this.pendingMaterial = { id: '', name: '', category: 'wall_house', metres_per_tile: 2, prompt: '', idTouched: false }
    this.material = null
    this.matDraft = {}
    this.renderMaterials()
    this.matHost?.querySelector('input')?.focus()
  }

  /**
   * Draw one. It lands in a draft and nothing on disk changes.
   *
   * For a NEW texture the record is written first — a draft has to belong to something, and an id
   * with a prompt and no maps is a perfectly good row that says "described, not drawn".
   */
  private async generateMaterial(id: string, creating: boolean): Promise<void> {
    const p = this.pendingMaterial
    const m = this.materials.find((x) => x.id === id)
    const spec = creating
      ? { name: p!.name || id, category: p!.category, metres_per_tile: p!.metres_per_tile, prompt: p!.prompt, seed: p!.seed }
      : { ...m!, ...this.matDraft }
    if (!id) return void toast('give it a name first', 'warn')
    if (!String(spec.prompt ?? '').trim()) return void toast('say what the texture is — the prompt is what draws it', 'warn')
    this.matBusy = id
    this.renderMaterials()
    try {
      if (creating || Object.keys(this.matDraft).length) {
        await assetsvc.putMaterial(id, { ...spec, albedo: m?.albedo ?? 'albedo.jpg' })
      }
      const job = await assetsvc.generateMaterial(id, { prompt: spec.prompt!, metres_per_tile: spec.metres_per_tile, seed: spec.seed })
      toast(`drawing ${id}…`, 'info', 0)
      const done = await assetsvc.wait(job.job, (j) => toast(`drawing ${id} — ${j.progress?.state ?? j.state}`, 'info', 0))
      if (done.state === 'failed') { toast(`${id}: ${done.detail}`, 'danger', 8000); return }
      toast(`${id} drawn — look at it, then save it`, 'ok')
      this.matDrafts.add(id)
      this.pendingMaterial = null
      this.material = id
      this.matDraft = {}
      this.materials = (await assetsvc.materials()).materials
    } catch (e) {
      toast(`${id}: ${(e as Error).message}`, 'danger', 8000)
    } finally {
      this.matBusy = null
      this.renderMaterials()
    }
  }

  private async saveMaterialDraft(id: string): Promise<void> {
    try {
      await assetsvc.saveMaterialDraft(id)
      this.matDrafts.delete(id)
      this.materials = (await assetsvc.materials()).materials
      toast(`${id} saved — the previous maps are kept beside it`, 'ok')
    } catch (e) {
      toast(`save: ${(e as Error).message}`, 'danger')
    }
    this.renderMaterials()
  }

  private async discardMaterialDraft(id: string): Promise<void> {
    try {
      await assetsvc.discardMaterialDraft(id)
    } catch { /* it may already be gone; the point is that it is not shown */ }
    this.matDrafts.delete(id)
    this.renderMaterials()
  }

  private async saveMaterialRecord(id: string): Promise<void> {
    try {
      await assetsvc.putMaterial(id, this.matDraft)
      this.matDraft = {}
      this.materials = (await assetsvc.materials()).materials
      toast(`saved ${id}`, 'ok')
    } catch (e) {
      toast(`save: ${(e as Error).message}`, 'danger')
    }
    this.renderMaterials()
  }

  /**
   * Upload maps by hand — still here, because a library that can only hold what it drew cannot
   * hold the photograph somebody already has. It is the secondary path now, not the only one.
   */
  private uploadMaterial(id: string): void {
    if (!id) return void toast('give it a name first', 'warn')
    const d = new Dialog({ title: `Upload maps for ${id}`, size: 'md', icon: 'arrow-up-tray' })
    const files: Record<string, File | null> = { albedo: null, normal: null, roughness: null }
    for (const map of ['albedo', 'normal', 'roughness'] as const) {
      const row = el('label', 'field text')
      row.append(el('span', 'field-label', map + (map === 'albedo' ? '' : ' (optional)')))
      const input = el('input', 'input wide') as HTMLInputElement
      input.type = 'file'
      input.accept = 'image/png,image/jpeg,image/webp'
      input.onchange = () => { files[map] = input.files?.[0] ?? null }
      row.append(input)
      d.body.append(row)
    }
    const status = readout('upload', 'idle')
    const set = (t: string) => { status.querySelector('.field-value')!.textContent = t }
    d.body.append(status)
    d.footer(
      button({ label: 'Cancel', variant: 'ghost', onClick: () => d.close() }),
      button({
        label: 'Upload',
        icon: 'arrow-up-tray',
        variant: 'primary',
        onClick: async () => {
          if (!files.albedo && !this.materials.some((x) => x.id === id)) return void toast('an albedo map is required', 'warn')
          try {
            const record: Record<string, unknown> = {}
            for (const map of ['albedo', 'normal', 'roughness'] as const) {
              const file = files[map]
              if (!file) continue
              set(`${map}…`)
              const name = `${map}${(file.name.match(/\.[a-z0-9]+$/i) ?? ['.jpg'])[0]}`.toLowerCase()
              await assetsvc.putMaterialFile(id, name, file)
              record[map] = name
            }
            const p = this.pendingMaterial
            if (p && p.id === id) {
              await assetsvc.putMaterial(id, { name: p.name || id, category: p.category, metres_per_tile: p.metres_per_tile, prompt: p.prompt, ...record })
              this.pendingMaterial = null
              this.material = id
            } else if (Object.keys(record).length) {
              await assetsvc.putMaterial(id, record)
            }
            this.materials = (await assetsvc.materials()).materials
            toast(`${id} updated`, 'ok')
            d.close()
            this.renderMaterials()
          } catch (e) {
            toast(`upload failed: ${(e as Error).message}`, 'danger', 8000)
          } finally {
            set('idle')
          }
        },
      }),
    )
    d.open()
  }
  /**
   * A NAME, AND THE ID FOLLOWS IT.
   *
   * It asked for an id and nothing else — so the thing you type is a slug, the readable name is
   * derived backwards from it by putting the hyphens back as spaces, and there is nowhere to say
   * what sort of thing it is (Rich, 2026-09-28: "why does new item only have an ID field (and why
   * can't we have a name field and an auto-generated id from the slug or something)").
   *
   * The id follows the name until somebody edits the id, and then it stops: a derived field that
   * overwrites what you typed into it is worse than no derivation.
   */
  /** Start naming one. Nothing is sent until Create. */
  private create(): void {
    this.pending = { id: '', subject: '', kind: 'prop' }
    this.draft = {}
    this.selected = PENDING
    // straight to the tab it lands in, because "it appeared and then vanished" was the bug
    this.tabs.show('catalog')
    this.renderList()
    this.renderDetail()
    this.detailHost.querySelector('input')?.focus()
  }

  /**
   * The new item, filled in where it will live.
   *
   * The id follows the name until somebody edits the id, and then it stops: a derived field that
   * overwrites what you typed into it is worse than no derivation. Both of them re-sort the list
   * as they are typed — which is the thing that makes putting this here worth doing, because you
   * can see where it is going.
   */
  private renderNew(): void {
    const p = this.pending!
    const head = el('header', 'asset-detail-head')
    head.append(el('h2', '', 'New item'), el('span', 'chip state-spec', 'not created'))
    this.detailHost.append(head)

    const g = group('1 · Described')
    const b = bodyOf(g)
    let idTouched = false
    const why = el('p', 'field-error')
    why.hidden = true

    const idField = textField({
      label: 'id',
      value: p.id,
      placeholder: 'roadside-mailbox',
      note: 'what it is filed under; follows the name until you change it',
      onChange: (v) => { idTouched = true; p.id = slugOf(v); idInput.value = p.id; this.renderList() },
    })
    const idInput = idField.querySelector('input')!
    const nameField = textField({
      label: 'name',
      value: p.subject,
      placeholder: 'roadside mailbox',
      onChange: (v) => { p.subject = v.trim(); this.renderList() },
    })
    // live, not on blur: the point of naming it here is watching it find its place in the list
    nameField.querySelector('input')!.addEventListener('input', (e) => {
      p.subject = (e.target as HTMLInputElement).value.trim()
      if (!idTouched) { p.id = slugOf(p.subject); idInput.value = p.id }
      why.hidden = true
      this.renderList()
    })

    const kinds = classesIn(this.items.map((x) => x.kind))
    const kindField = select({
      label: 'class',
      value: p.kind,
      options: [...kinds.map((k) => ({ value: k, label: k.replace(/-/g, ' ') })), { value: NEW_CLASS, label: 'new class…' }],
      note: 'what it is, for the roster and for what places it',
      onChange: (v) => {
        if (v !== NEW_CLASS) { p.kind = v; return }
        void ask({ title: 'New class', label: 'name', placeholder: 'market-stall', icon: 'plus', validate: (x) => (slugOf(x) ? null : 'letters and digits') })
          .then((name) => { if (name) p.kind = slugOf(name); this.renderDetail() })
      },
    })

    const bar = el('div', 'panel-actions')
    bar.append(
      button({
        label: 'Create',
        icon: 'plus',
        variant: 'primary',
        onClick: () => {
          if (!p.id) { why.textContent = 'a name (or an id) is required'; why.hidden = false; return }
          if (this.items.some((x) => x.id === p.id)) { why.textContent = `${p.id} already exists`; why.hidden = false; return }
          void this.commitNew()
        },
      }),
      button({ label: 'Cancel', variant: 'ghost', onClick: () => { this.pending = null; this.selected = null; this.renderList(); this.renderDetail() } }),
    )
    b.append(nameField, idField, kindField, why, bar)
    this.detailHost.append(g)
    this.detailHost.append(el('p', 'note', 'Drawing and meshing open once it exists.'))
  }

  private async commitNew(): Promise<void> {
    const p = this.pending
    if (!p) return
    try {
      await assetsvc.put({ id: p.id, subject: p.subject || p.id.replace(/-/g, ' '), kind: p.kind, prompt: '', negative: '' })
      this.pending = null
      this.draft = {}
      this.selected = p.id
      /*
       * SHOW IT AS THE ITEM IMMEDIATELY, before the refresh.
       *
       * `refresh` re-lists a catalog of a hundred and twenty items, which takes long enough to
       * see — and until it lands the pane is still the form you just submitted, with the Create
       * button still on it. Pressing it again is the obvious thing to do and creates nothing,
       * because the item is already there.
       */
      this.items = [...this.items, { ...EMPTY_ITEM, id: p.id, subject: p.subject || p.id.replace(/-/g, ' '), kind: p.kind }]
      this.renderList()
      this.renderDetail()
      await this.refresh()
      toast(`${p.id} created — describe it, then draw`, 'ok')
    } catch (e) {
      toast(`create: ${(e as Error).message}`, 'danger')
    }
  }

  private async remove(id: string) {
    const yes = await confirm({
      title: `Delete ${id}?`,
      message: `${id} and every file generated for it will be removed. This cannot be undone.`,
      ok: 'Delete',
      danger: true,
      icon: 'trash',
    })
    if (!yes) return
    try {
      await assetsvc.remove(id)
      if (this.selected === id) this.selected = null
      await this.refresh()
      toast(`${id} deleted`, 'ok')
    } catch (e) {
      toast(`delete: ${(e as Error).message}`, 'danger')
    }
  }

  /**
   * Draw one, with the seed if a seed was given.
   *
   * Rich, 2026-09-28: "being able to override the seed number would be good for the image
   * generator." Blank draws a new one every time, which is what you want while you are still
   * looking for the car; a number draws the same one again, which is what tells a prompt change
   * from a dice roll. It is per item, kept beside the draw button.
   */
  private async draw(id: string) {
    const seed = this.seeds.get(id)
    await this.run(() => assetsvc.image(id, seed === undefined ? {} : { seed }), `drawing ${id}`)
  }

  private async mesh(id: string) {
    await this.run(() => assetsvc.mesh(id), `meshing ${id}`)
  }

  /** Start a job, follow it, and say what happened. One path for both kinds. */
  private async run(start: () => Promise<AssetJob>, what: string) {
    let job: AssetJob
    try {
      job = await start()
    } catch (e) {
      return toast(`${what}: ${(e as Error).message}`, 'danger')
    }
    toast(`${what}…`, 'info', 0)
    const done = await assetsvc.wait(job.job, (j) => {
      const where = j.state === 'queued' ? `queued, ${j.ahead} ahead` : (j.progress?.state ?? j.state)
      toast(`${what} — ${where}`, 'info', 0)
    })
    if (done.state === 'failed') toast(`${what} failed: ${done.detail}`, 'danger', 8000)
    else toast(`${what} done`, 'ok')
    await this.refresh()
  }

  private async sync(dir: 'push' | 'pull') {
    try {
      const r = dir === 'push' ? await assetsvc.push() : await assetsvc.pull()
      const moved = dir === 'push' ? (r as { pushed: string[] }).pushed : (r as { pulled: string[] }).pulled
      toast(`${dir}: ${moved.length} files, ${r.skipped.length} already matched`, 'ok')
      if (dir === 'pull') await this.refresh()
    } catch (e) {
      toast(`${dir}: ${(e as Error).message}`, 'danger')
    }
  }
}

/* -------------------------------------------------------------------------------------------- */

function rowOf(...nodes: HTMLElement[]): HTMLElement {
  const r = el('div', 'asset-row-actions')
  r.append(...nodes)
  return r
}

/** A prompt is a paragraph, not a line — it gets a textarea that commits on blur. */
function promptField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = el('label', 'field prompt')
  wrap.append(el('span', 'field-label', label))
  const t = el('textarea', 'input prompt-input')
  t.value = value
  t.rows = 4
  t.spellcheck = false
  t.onchange = () => onChange(t.value)
  wrap.append(t)
  return wrap
}

/** Where the drawer entry and the keyboard shortcut land. */
export function installAssetCatalog(): AssetCatalog {
  return new AssetCatalog()
}
