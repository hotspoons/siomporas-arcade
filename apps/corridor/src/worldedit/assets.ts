// The Assets panel: pick from pictures, commit to meshes.
//
// That sentence is the whole design, and it comes from a measured asymmetry the asset-library
// agent's handoff states plainly: an image is about ten seconds on flux, and a mesh is thirty to
// forty seconds on ONE GPU that serialises. So the loop is draw several, let a person choose, and
// only then spend a reconstruction — and the editor's job is to make that asymmetry visible
// rather than to explain it.
//
// THE RECIPE TRAVELS WITH THE PICTURES. A spec arrives with its backdrop, its glass key and the
// reason for each: the yellow RX-7 is shot on magenta because "yellow would be flattened by the
// green despill", and its windows are keyed cyan by hue distance from the paint. Shown, because a
// choice that looks arbitrary is the first thing anybody overrides — and these were expensive to
// learn (a bronze van first-fitted to magenta keyed 0.05% of its faces; hue distance gave it blue
// and 2.41%).
//
// AND THE SEED IS PART OF THE ASSET. Two generations from one prompt are two different cars, so
// the seed behind the picture a person picked is what makes it reproducible. `choose` pins it
// from the view's own provenance rather than from the caller, who is a person clicking a picture.

import { button, el, lightbox, toast } from '../ui/shell'
import { bodyOf, empty, group, keepScroll, readout, select, textArea, textField, toggle } from '../ui/controls'
import { MeshView } from '../ui/meshview'
import { icon } from '../ui/icons'
import { api, type AssetJob, type Recipe, type SpecSummary } from './api'

/**
 * The backdrops and the camera angles the recipe knows.
 *
 * Kept short deliberately: `CHROMA_SAYS` in tools/assetlib/style.mjs has two entries and `VIEWS`
 * has the angles flux will actually honour. A free-text field here would offer a person a fifth
 * backdrop that the prompt builder has no words for.
 */
const CHROMA = ['green', 'magenta']
const VIEWS = ['front-three-quarter', 'rear-three-quarter', 'side', 'front', 'rear']

/**
 * What a candidate tile says about itself.
 *
 * The seed is the useful half — it is what makes the picture reproducible — but it is not always
 * known (see `views`), and "seed null · NaNs" under a photograph is how a panel loses trust.
 */
const label = (v: { file: string; seed: number | null; seconds: number | null }) =>
  (v.seed === null ? v.file.replace(/^views\//, '') : `seed ${v.seed}`) +
  (v.seconds === null ? '' : ` · ${v.seconds.toFixed(1)}s`)

const hint = (text: string, warn = false) => {
  const p = el('div', `panel-hint${warn ? ' warn' : ''}`)
  p.append(icon(warn ? 'exclamation-triangle' : 'information-circle', 14), el('span', '', text))
  return p
}

export interface AssetsOpts {
  host: HTMLElement
  /** the catalog and generation dialog (ui/assets.ts) */
  openCatalog: () => void
  /** turn a finished mesh into a placeable catalog entry (adopt.ts) */
  openAdopt: () => void
}

export class AssetsPanel {
  private o: AssetsOpts
  private classes: Record<string, SpecSummary[]> = {}
  private count = 0
  private klass = ''
  private spec: Recipe | null = null
  /**
   * What has been changed by hand, over the recipe.
   *
   * Separate from `spec` so "Back to the recipe" is emptying an object rather than a re-fetch that
   * has to guess which fields were touched — and so a rebuild can refresh the prompt while
   * keeping a hand-edited one.
   */
  private over: { chroma?: string; glassKey?: string; view?: string; prompt?: string; negative?: string } = {}
  /**
   * The pictures on the table.
   *
   * `seed` and `seconds` are NULLABLE because a view can arrive two ways: drawn here, where the
   * job reports both, or found in the catalog, where the seed is only in the item's history —
   * which imported items do not have at all. A tile that says "seed 0" about a picture nobody
   * knows the seed of is worse than one that says the filename.
   */
  private views: { file: string; seed: number | null; seconds: number | null }[] = []
  /** blank means "a new one every draw"; see `#seed` */
  private seedText = ''
  private chosen: string | null = null
  private chosenSeed: number | null = null
  private job: AssetJob | null = null
  private mesh: AssetJob | null = null
  /** a mesh that was already on disk when this spec was opened, with no job of ours behind it */
  private already: { file: string; bytes: number } | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private drawCount = 4
  /**
   * The one 3D preview, and what it is showing.
   *
   * Kept across renders rather than rebuilt per render: this panel redraws on a 1.5-second poll
   * and a MeshView is a WebGL context, which a browser caps at around sixteen per tab before it
   * starts dropping the oldest. See `#preview`.
   */
  private mesh3d: MeshView | null = null
  private mesh3dKey: string | null = null
  private spin = true
  private wire = false

  constructor(o: AssetsOpts) {
    this.o = o
  }

  async load() {
    try {
      const r = await api.specs()
      this.classes = r.classes
      this.count = r.count
      this.klass ||= Object.keys(r.classes)[0] ?? ''
    } catch (e) {
      this.classes = {}
      // assetsvc is optional: the editor works without it and should say so rather than break
      toast(`assets: ${(e as Error).message}`, 'warn', 5000)
    }
    this.render()
  }

  /**
   * Leaving the tab: no poll, and no GPU turning a model over for nobody.
   *
   * NOT the same thing as `#unpoll`, which is what `watch` does to its predecessor. The preview
   * has to keep drawing while a draw is being polled, so only this one — called from `setMode`
   * when the tab goes away — stops it.
   */
  stop() {
    this.#unpoll()
    this.mesh3d?.stop()
  }

  #unpoll() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  /** Give the context back. A preview per spec you glance at is how a tab runs out of them. */
  #drop() {
    this.mesh3d?.dispose()
    this.mesh3d = null
    this.mesh3dKey = null
  }

  private async open(id: string) {
    this.#drop()
    this.spec = null
    this.over = {} // another spec's hand edits are not this one's
    this.views = []
    this.mesh = null
    this.already = null
    this.chosen = null
    this.chosenSeed = null
    this.render()
    try {
      this.spec = await api.recipe(id)
    } catch (e) {
      toast(`${id}: ${(e as Error).message}`, 'warn', 5000)
    }
    await this.#already(id)
    this.render()
  }

  /**
   * WHAT IS ALREADY THERE.
   *
   * Opening a spec used to show "nothing drawn yet" and no model, however much work had been done
   * on it — the panel only knew about jobs it had started itself, so a car drawn and meshed
   * yesterday, or imported from the old library, was invisible and the only way to see it was to
   * spend the GPU again. The catalog is the memory; this reads it.
   *
   * The per-view seed comes out of `history`, which is the only place it is kept, and is null for
   * anything imported rather than drawn here — see `views`.
   */
  async #already(id: string) {
    let item
    try {
      item = await api.assetItem(id)
    } catch {
      return // the spec exists and has never been drawn: nothing to say
    }
    const seeds = new Map<string, { seed?: number; seconds?: number }>()
    for (const h of item.history ?? []) {
      if (h.step === 'image' && h.file) seeds.set(h.file.replace(/^views\//, ''), h)
    }
    this.views = (item.views ?? []).map((f) => ({
      file: `views/${f}`,
      seed: seeds.get(f)?.seed ?? null,
      seconds: seeds.get(f)?.seconds ?? null,
    }))
    this.chosen = item.chosen ?? null
    this.chosenSeed = item.seed ?? null
    this.already = item.mesh ? { file: item.finished ? 'mesh.finished.glb' : 'mesh.glb', bytes: item.finished || item.mesh } : null
  }

  /**
   * Re-derive the recipe after a field changed, and refresh the prompt with it.
   *
   * The prompt is BUILT from the backdrop, the view and the glass key, so changing one of those
   * has to be visible in the prompt or the panel is lying about what will be sent. A prompt that
   * was edited by hand is kept: overwriting somebody's edit because they then changed the
   * backdrop is the worse of the two surprises.
   */
  private async rebuild() {
    const s = this.spec
    if (!s) return
    const handEdited = this.over.prompt !== undefined
    try {
      const fresh = await api.recipe(s.id, this.over.view)
      this.spec = fresh
      if (!handEdited) delete this.over.prompt
      if (this.over.negative === undefined) delete this.over.negative
    } catch (e) {
      toast(`could not rebuild the recipe: ${(e as Error).message}`, 'warn', 5000)
    }
    this.render()
  }

  /**
   * WHICH SEED TO DRAW WITH.
   *
   * Blank means a new one every time, which is what you want while you are still looking for the
   * car. A number means this exact draw again, which is what you want once you have found it and
   * are changing the prompt (Rich, 2026-09-28: "being able to override the seed number would be
   * good for the image generator") — changing the prompt AND the seed at once tells you nothing
   * about which of the two did it.
   *
   * The service takes `seed` and gives candidate i `seed + i`, so a pinned seed reproduces the
   * first of a set exactly and the rest are its neighbours.
   */
  #seed(): number {
    const n = Math.floor(Number(this.seedText))
    return this.seedText.trim() && Number.isFinite(n) && n >= 0 ? n : Math.floor(Math.random() * 100000)
  }

  private async draw() {
    const s = this.spec
    if (!s) return
    try {
      // whatever was changed by hand goes with it; the rest the service takes from the recipe
      const r = await api.candidates(s.id, {
        count: this.drawCount,
        steps: 24,
        seed: this.#seed(),
        ...this.over,
      })
      this.job = { job: r.job.job, lane: 'image', label: `candidates ${s.id}`, state: 'running' }
      this.render()
      this.watch()
    } catch (e) {
      toast(`could not draw: ${(e as Error).message}`, 'danger', 6000)
    }
  }

  /** Poll the job until it lands. The service is a job queue on purpose: nothing holds a socket. */
  private watch() {
    this.#unpoll()
    this.poll = setInterval(async () => {
      try {
        const { jobs } = await api.assetJobs()
        const mine = jobs.find((j) => j.job === this.job?.job)
        if (!mine) return
        this.job = mine
        if (mine.state === 'done') {
          this.views = mine.result?.drawn ?? []
          this.#unpoll()
        } else if (mine.state === 'failed') {
          this.#unpoll()
          toast(mine.detail?.slice(0, 200) ?? 'the draw failed', 'danger', 8000)
        }
        this.render()
      } catch {
        this.#unpoll()
      }
    }, 1500)
  }

  /**
   * Pick one. NO SEED IS SENT — the service takes it from the view's own provenance, because the
   * caller here is a person clicking a picture and does not know what made it.
   */
  /**
   * Reconstruct the chosen picture. THE EXPENSIVE HALF: one GPU, serialised inside the service,
   * thirty to forty seconds — which is why nothing reaches here until a person has accepted an
   * image, and why the button reports the stage rather than spinning silently.
   */
  private async reconstruct() {
    const s = this.spec
    if (!s || !this.chosen) return
    try {
      this.mesh = await api.reconstruct(s.id)
      this.render()
      this.watchMesh()
    } catch (e) {
      toast(`could not reconstruct: ${(e as Error).message}`, 'danger', 7000)
    }
  }

  private watchMesh() {
    this.#unpoll()
    this.poll = setInterval(async () => {
      try {
        const { jobs } = await api.assetJobs()
        const mine = jobs.find((j) => j.job === this.mesh?.job)
        if (!mine) return
        this.mesh = mine
        if (mine.state === 'done' || mine.state === 'failed') this.#unpoll()
        this.render()
      } catch {
        this.#unpoll()
      }
    }, 2000)
  }

  private async choose(file: string) {
    const s = this.spec
    if (!s) return
    try {
      const r = await api.chooseView(s.id, file.replace(/^views\//, ''))
      this.chosen = r.item.chosen
      this.chosenSeed = r.item.seed
      toast(`${s.id}: seed ${r.item.seed} pinned`, 'ok', 3000)
      this.render()
    } catch (e) {
      toast(`could not choose: ${(e as Error).message}`, 'danger', 6000)
    }
  }

  /**
   * Redraw the panel, keeping the scroll where it was.
   *
   * `Draw` sits under a 1,600-character prompt; a rebuild that resets `scrollTop` throws the view
   * to the top and the button you just pressed disappears upward, which reads as a navigation.
   */
  render() {
    keepScroll(this.o.host, () => this.#draw())
  }

  /**
   * The reconstruction, in 3D, in the panel.
   *
   * Rich, 2026-09-28: "After generating the mesh, I see no way to view it, definitely need a
   * viewer." It was a byte count — and a byte count cannot tell you that the model gave the car
   * three wheels, which is the only question anybody has after spending forty seconds of GPU.
   *
   * THE KEY INCLUDES THE JOB. Reconstructing the same spec twice writes the same filename, so a
   * URL alone would show the previous mesh with no sign that it was stale — and the job id in the
   * query also gets the reload past any cache between here and the file.
   */
  #preview(into: HTMLElement, id: string, file: string) {
    const url = `/assetsvc/catalog/${encodeURIComponent(id)}/file/${file}?job=${encodeURIComponent(this.mesh?.job ?? '')}`
    const fresh = this.mesh3dKey !== url
    if (fresh) {
      this.mesh3d?.dispose()
      this.mesh3d = new MeshView()
      this.mesh3dKey = url
    }
    const view = this.mesh3d!
    // for probes: the preview that is on screen
    ;(window as unknown as { __meshview?: MeshView }).__meshview = view
    view.setSpin(this.spin)
    into.append(view.root)
    // moving the element is enough on a re-render; a canvas survives being re-parented
    view.start()
    if (fresh) {
      void view.load(url)
      // one render once it has landed, so the size below stops saying "loading" and the
      // wireframe choice reaches materials that did not exist when it was made
      void view.loaded.then(() => {
        if (this.mesh3d !== view) return
        view.setWireframe(this.wire)
        this.render()
      })
    }
    const row = el('div', 'panel-actions')
    row.append(
      toggle({ label: 'spin', value: this.spin, onChange: (v) => { this.spin = v; view.setSpin(v) } }),
      toggle({ label: 'wireframe', value: this.wire, onChange: (v) => { this.wire = v; view.setWireframe(v) } }),
    )
    into.append(row)
    /*
     * BOUNDS, NOT METRES.
     *
     * The reconstruction comes back normalised to about a unit cube — this probe read 0.52 × 0.32
     * × 1.00 off a real RX-7 — so a readout with an "m" on it would be saying the car is a metre
     * long. The real dimensions are the ones given to it where it becomes placeable, and the
     * useful thing to read here is the SHAPE: a saloon that came back 1.0 × 0.9 × 1.0 is a failed
     * reconstruction whatever it is scaled to afterwards.
     */
    const sz = view.size
    if (!sz) into.append(readout('bounds', 'loading…'))
    else {
      into.append(readout('bounds', `${sz.x.toFixed(2)} × ${sz.y.toFixed(2)} × ${sz.z.toFixed(2)}`))
      if (Math.max(sz.x, sz.y, sz.z) < 2.5) into.append(hint('Unit-normalised, as the model returns it. Real metres are set by “Make placeable”.'))
    }
    into.append(readout('showing', file))
  }

  #draw() {
    const host = this.o.host
    host.replaceChildren()

    /*
     * ONE HOME FOR ASSETS.
     *
     * Generating and placing used to be two drawer items and two toolbar icons opening dialogs
     * that were not this panel — the same word meaning three things in one bar. They are steps of
     * one flow: describe it, draw it, mesh it, make it placeable. So they open from here.
     */
    const flow = el('div', 'panel-actions')
    flow.append(
      button({ label: 'Catalog & generate', icon: 'sparkles', onClick: () => void this.o.openCatalog() }),
      button({ label: 'Make placeable', icon: 'cube', title: 'turn a finished mesh into a catalog entry a level can place', onClick: () => void this.o.openAdopt() }),
    )
    host.append(flow)

    if (!this.count) {
      host.append(hint('Asset generation is off. Everything else in the editor works without it.', true))
      host.append(button({ label: 'Try again', icon: 'arrow-path', onClick: () => void this.load() }))
      return
    }

    if (!this.spec) {
      host.append(hint(`${this.count} specs.`))
      const pick = group('Roster')
      const pb = bodyOf(pick)
      pb.append(
        select({
          label: 'class',
          value: this.klass,
          options: Object.keys(this.classes).map((k) => ({ value: k, label: `${k} (${this.classes[k].length})` })),
          onChange: (v) => {
            this.klass = v
            this.render()
          },
        }),
      )
      const list = el('div', 'rows')
      for (const s of this.classes[this.klass] ?? []) {
        const row = el('button', 'row')
        row.append(el('span', 'row-name', s.id), el('span', 'row-note', [s.era, s.paint].filter(Boolean).join(' · ')))
        row.onclick = () => void this.open(s.id)
        list.append(row)
      }
      pb.append(list)
      host.append(pick)
      return
    }

    const s = this.spec
    host.append(
      button({ label: 'Back to the roster', icon: 'arrow-left', variant: 'ghost', onClick: () => { this.spec = null; this.stop(); this.#drop(); this.render() } }),
    )

    /*
     * WHAT IT WILL BE DRAWN AS, AND YOU CAN CHANGE IT.
     *
     * This used to be four readouts — including `prompt  1640 chars`, which is the one thing
     * somebody actually wants to correct and the one thing that could not be read (Rich,
     * 2026-09-28: "how am I supposed to see or edit the prompt? Or any of the fields"). The
     * recipe already sends the whole prompt; the panel was throwing it away and counting it.
     *
     * The recipe's reasons are attached to the field they are about, rather than listed
     * underneath as statements: `why.glassKey` matters when you are changing the glass key and is
     * noise otherwise.
     */
    const how = group(s.id, { note: s.subject ?? undefined })
    const hb = bodyOf(how)
    hb.append(readout('paint', s.paint ?? '—'))
    hb.append(select({
      label: 'backdrop',
      value: this.over.chroma ?? s.chroma,
      options: CHROMA.map((c) => ({ value: c, label: c })),
      note: s.why?.chroma,
      onChange: (v) => { this.over.chroma = v; void this.rebuild() },
    }))
    hb.append(select({
      label: 'view',
      value: this.over.view ?? s.view ?? VIEWS[0],
      options: VIEWS.map((v) => ({ value: v, label: v.replace(/-/g, ' ') })),
      onChange: (v) => { this.over.view = v; void this.rebuild() },
    }))
    hb.append(textField({
      label: 'glass key',
      value: this.over.glassKey ?? s.glassKey,
      onChange: (v) => { this.over.glassKey = v.trim(); void this.rebuild() },
    }))
    const chars = () => (this.over.prompt ?? s.prompt).length
    hb.append(textArea({
      label: `prompt — ${chars()} chars${s.over ? ' (over the recipe\u2019s budget; the tail may be ignored)' : ''}`,
      value: this.over.prompt ?? s.prompt,
      mono: true,
      rows: 10,
      onChange: (v) => { this.over.prompt = v; this.render() },
    }))
    hb.append(textArea({
      label: 'negative',
      value: this.over.negative ?? s.negative,
      note: 'prohibitions belong here as nouns; asking the prompt not to draw something draws it',
      mono: true,
      rows: 3,
      onChange: (v) => { this.over.negative = v },
    }))
    if (Object.keys(this.over).length) {
      hb.append(button({
        label: 'Back to the recipe',
        icon: 'arrow-uturn-left',
        variant: 'ghost',
        onClick: () => { this.over = {}; void this.rebuild() },
      }))
    }
    host.append(how)

    /* draw some */
    const draw = group('Candidates')
    const db = bodyOf(draw)
    db.append(
      textField({
        label: 'how many',
        value: String(this.drawCount),
        type: 'number',
        step: 1,
        onChange: (v) => {
          this.drawCount = Math.max(1, Math.min(8, Number(v) || 4))
        },
      }),
      textField({
        label: 'seed',
        value: this.seedText,
        type: 'number',
        step: 1,
        placeholder: 'a new one each draw',
        note: 'a seed draws the same car again, which is how you tell a prompt change from a dice roll',
        onChange: (v) => { this.seedText = v.trim() },
      }),
      button({ label: this.job && this.job.state === 'running' ? 'Drawing…' : 'Draw', icon: 'sparkles', variant: 'primary', onClick: () => void this.draw() }),
    )
    if (this.job && this.job.state === 'running') {
      const p = this.job.progress as { drawn?: number; of?: number; seed?: number } | undefined
      db.append(readout('progress', p?.of ? `${p.drawn ?? 0} of ${p.of}${p.seed !== undefined ? ` · seed ${p.seed}` : ''}` : 'starting'))
    }

    if (!this.views.length) db.append(empty('nothing drawn yet'))
    else {
      const grid = el('div', 'candidate-grid')
      for (const v of this.views) {
        const cell = el('button', `candidate${this.chosen && v.file.endsWith(this.chosen) ? ' on' : ''}`)
        const img = el('img') as HTMLImageElement
        // through the editor's own proxy, so the browser still knows one origin
        img.src = `/assetsvc/catalog/${encodeURIComponent(s.id)}/file/${v.file}`
        img.loading = 'lazy'
        img.alt = `${s.id}, ${label(v)}`
        cell.append(img, el('span', 'candidate-seed', label(v)))
        /*
         * CLICK OPENS IT, and choosing happens from there.
         *
         * These tiles are about 140 px wide and the decision they carry is which drawing gets
         * reconstructed into a mesh — thirty to forty seconds of GPU. You cannot make that
         * decision at 140 px, and there was no way to see one bigger at all (Rich, 2026-09-28:
         * "I don't see a lightbox pop up when I go to inspect the output... can't expand these").
         * The lightbox takes the whole set, so the arrow keys compare them, which is what the
         * decision actually is.
         */
        const at = this.views.indexOf(v)
        cell.title = 'look at it properly, and choose it from there'
        cell.onclick = () => lightbox({
          items: this.views.map((w) => ({
            src: `/assetsvc/catalog/${encodeURIComponent(s.id)}/file/${w.file}`,
            caption: label(w),
            current: !!this.chosen && w.file.endsWith(this.chosen),
          })),
          index: at < 0 ? 0 : at,
          action: {
            label: 'Use this one',
            icon: 'check',
            onPick: (i) => { const w = this.views[i]; if (w) void this.choose(w.file) },
          },
        })
        grid.append(cell)
      }
      db.append(grid)
    }
    host.append(draw)

    /* and only then, the expensive half */
    if (this.chosen) {
      const make = group('Make the model')
      const mb = bodyOf(make)
      mb.append(readout('chosen', this.chosen), readout('seed', this.chosenSeed === null ? 'not recorded' : String(this.chosenSeed)))
      // An imported picture has no seed anywhere, and saying "pinned" under a dash was the panel
      // claiming a reproducibility it does not have — which is the one thing the seed is for.
      mb.append(this.chosenSeed === null
        ? hint('No seed was recorded for this picture, so a redraw is a different car.', true)
        : hint('The seed is pinned, so this can be drawn again.'))
      mb.append(
        button({
          label: this.mesh && this.mesh.state === 'running' ? 'Reconstructing…' : 'Reconstruct',
          icon: 'cube',
          variant: 'primary',
          onClick: () => void this.reconstruct(),
        }),
      )
      if (!this.mesh && this.already) {
        // no job of ours behind it: a reconstruction from an earlier session, or the import
        mb.append(readout('mesh', `${this.already.bytes} bytes, already made`))
        this.#preview(mb, s.id, this.already.file)
      }
      if (this.mesh) {
        const p = this.mesh.progress as { state?: string } | undefined
        const r = this.mesh.result as { bytes?: number; finished?: { ok?: boolean } | null } | undefined
        mb.append(readout('mesh', this.mesh.state === 'done' ? `${r?.bytes ?? 0} bytes` : (p?.state ?? this.mesh.state)))
        if (this.mesh.detail) mb.append(hint(this.mesh.detail.slice(0, 180), true))
        // the finished one is what a level will load; the raw one is all there is if finishing failed
        if (this.mesh.state === 'done') this.#preview(mb, s.id, r?.finished?.ok ? 'mesh.finished.glb' : 'mesh.glb')
      }
      host.append(make)
    }
  }
}
