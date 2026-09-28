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

import { button, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout, select, textField } from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type AssetJob, type Recipe, type SpecSummary } from './api'

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
  private views: { file: string; seed: number; seconds: number }[] = []
  private chosen: string | null = null
  private chosenSeed: number | null = null
  private job: AssetJob | null = null
  private mesh: AssetJob | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private drawCount = 4

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

  stop() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private async open(id: string) {
    this.spec = null
    this.views = []
    this.chosen = null
    this.chosenSeed = null
    this.render()
    try {
      this.spec = await api.recipe(id)
    } catch (e) {
      toast(`${id}: ${(e as Error).message}`, 'warn', 5000)
    }
    this.render()
  }

  private async draw() {
    const s = this.spec
    if (!s) return
    try {
      const r = await api.candidates(s.id, { count: this.drawCount, steps: 24, seed: Math.floor(Math.random() * 100000) })
      this.job = { job: r.job.job, lane: 'image', label: `candidates ${s.id}`, state: 'running' }
      this.render()
      this.watch()
    } catch (e) {
      toast(`could not draw: ${(e as Error).message}`, 'danger', 6000)
    }
  }

  /** Poll the job until it lands. The service is a job queue on purpose: nothing holds a socket. */
  private watch() {
    this.stop()
    this.poll = setInterval(async () => {
      try {
        const { jobs } = await api.assetJobs()
        const mine = jobs.find((j) => j.job === this.job?.job)
        if (!mine) return
        this.job = mine
        if (mine.state === 'done') {
          this.views = mine.result?.drawn ?? []
          this.stop()
        } else if (mine.state === 'failed') {
          this.stop()
          toast(mine.detail?.slice(0, 200) ?? 'the draw failed', 'danger', 8000)
        }
        this.render()
      } catch {
        this.stop()
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
    this.stop()
    this.poll = setInterval(async () => {
      try {
        const { jobs } = await api.assetJobs()
        const mine = jobs.find((j) => j.job === this.mesh?.job)
        if (!mine) return
        this.mesh = mine
        if (mine.state === 'done' || mine.state === 'failed') this.stop()
        this.render()
      } catch {
        this.stop()
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

  render() {
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
      host.append(hint(`${this.count} specs. Pick one to see what it will be drawn as.`))
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
      button({ label: 'Back to the roster', icon: 'arrow-left', variant: 'ghost', onClick: () => { this.spec = null; this.stop(); this.render() } }),
    )

    /* what it will be drawn as, and why */
    const how = group(s.id, { note: s.subject ?? undefined })
    const hb = bodyOf(how)
    hb.append(readout('paint', s.paint ?? '—'), readout('backdrop', s.chroma), readout('glass key', s.glassKey), readout('prompt', `${s.chars} chars${s.over ? ' — over budget' : ''}`))
    // WHY, not just what. These were expensive to learn and an unexplained choice gets overridden.
    for (const [k, v] of Object.entries(s.why ?? {})) hb.append(hint(`${k}: ${v}`))
    if (s.over) hb.append(hint('this prompt is over the budget the recipe sets — the tail may be ignored', true))
    host.append(how)

    /* draw some */
    const draw = group('Candidates', { note: 'An image is about ten seconds. A mesh is thirty to forty on one GPU that serialises — so choose a picture first.' })
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
        img.alt = `${s.id}, seed ${v.seed}`
        cell.append(img, el('span', 'candidate-seed', `seed ${v.seed} · ${v.seconds.toFixed(1)}s`))
        cell.title = 'choose this one — its seed is what makes the asset reproducible'
        cell.onclick = () => void this.choose(v.file)
        grid.append(cell)
      }
      db.append(grid)
    }
    host.append(draw)

    /* and only then, the expensive half */
    if (this.chosen) {
      const make = group('Make the model')
      const mb = bodyOf(make)
      mb.append(readout('chosen', this.chosen), readout('seed', String(this.chosenSeed ?? '—')))
      mb.append(hint('The seed is pinned, so this asset can be made again. Reconstruction is the expensive half and runs one at a time.'))
      mb.append(
        button({
          label: this.mesh && this.mesh.state === 'running' ? 'Reconstructing…' : 'Reconstruct',
          icon: 'cube',
          variant: 'primary',
          onClick: () => void this.reconstruct(),
        }),
      )
      if (this.mesh) {
        const p = this.mesh.progress as { state?: string } | undefined
        mb.append(readout('mesh', this.mesh.state === 'done' ? `${(this.mesh.result as { bytes?: number })?.bytes ?? 0} bytes` : (p?.state ?? this.mesh.state)))
        if (this.mesh.detail) mb.append(hint(this.mesh.detail.slice(0, 180), true))
      }
      host.append(make)
    }
  }
}
