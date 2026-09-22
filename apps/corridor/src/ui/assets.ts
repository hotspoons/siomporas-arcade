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
import { Dialog, Tabs, button, el, toast, type Tab } from './shell'
import { icon } from './icons'
import { bodyOf, empty, group, readout, textField } from './controls'
import { assetsvc, type AssetItem, type AssetJob, type ModelRoster } from '../assetsvc'

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
  private listHost = el('div', 'asset-list')
  private detailHost = el('div', 'asset-detail')

  constructor() {
    const tabs: Tab[] = [
      { id: 'catalog', label: 'Catalog', icon: 'cube', build: (h) => this.buildCatalog(h) },
      { id: 'service', label: 'Service', icon: 'beaker', build: (h) => void this.buildService(h) },
    ]
    this.tabs = new Tabs(tabs)
    this.dialog = new Dialog({ title: 'Assets', icon: 'cube', size: 'lg' })
    this.dialog.body.append(this.tabs.root)
    this.dialog.body.classList.add('asset-body')
    this.dialog.footer(
      button({ label: 'New item', icon: 'plus', onClick: () => void this.create() }),
      button({ label: 'Refresh', icon: 'arrow-path', onClick: () => void this.refresh() }),
      button({ label: 'Push to S3', icon: 'document-arrow-down', title: 'sync the catalog to the bucket', onClick: () => void this.sync('push') }),
    )
  }

  async open() {
    this.dialog.open()
    await this.refresh()
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
    split.append(this.listHost, this.detailHost)
    host.append(split)
    this.renderList()
    this.renderDetail()
  }

  /**
   * "No service" is a normal state, not an error: asset generation is off by default and the
   * editor works completely without it. So this says where it looked and how to start one, rather
   * than showing a failure.
   */
  private notConfigured(): HTMLElement {
    const wrap = el('div', 'asset-none')
    wrap.append(el('p', '', 'No asset service is answering.'))
    wrap.append(readout('Tried', assetsvc.url, true))
    const p = el('p', 'dim')
    p.append(
      el('span', '', 'Generation is off by default. To run one locally, port-forward the models and start the service — '),
      el('code', '', 'tools/assetsvc/README.md'),
      el('span', '', ' has the two commands. Point the editor elsewhere with '),
      el('code', '', '?assetsvc=<url>'),
      el('span', '', '.'),
    )
    wrap.append(p)
    return wrap
  }

  private renderList() {
    this.listHost.replaceChildren()
    if (!this.items.length) {
      this.listHost.append(empty('Nothing in the catalog yet. “New item” describes one.'))
      return
    }
    for (const it of this.items) {
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
      row.onclick = () => {
        this.selected = it.id
        this.renderList()
        this.renderDetail()
      }
      this.listHost.append(row)
    }
  }

  private renderDetail() {
    this.detailHost.replaceChildren()
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
    specBody.append(
      textField({ label: 'Subject', value: it.subject, onChange: (v) => void this.save(it.id, { subject: v }) }),
      promptField('Prompt', it.prompt, (v) => void this.save(it.id, { prompt: v })),
      promptField('Avoid', it.negative, (v) => void this.save(it.id, { negative: v })),
    )
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
        a.title = `${v}${v === it.chosen ? ' — the one that will be meshed' : ' — click to choose for meshing'}`
        a.onclick = () => void this.save(it.id, { chosen: v })
        strip.append(a)
      }
      drawnBody.append(strip)
    } else {
      drawnBody.append(empty('No view yet.'))
    }
    drawnBody.append(
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

  private async save(id: string, spec: Partial<AssetItem>) {
    try {
      await assetsvc.put({ id, ...spec })
      await this.refresh()
    } catch (e) {
      toast(`save: ${(e as Error).message}`, 'danger')
    }
  }

  private async create() {
    const id = prompt('An id for the new item — lower case, hyphens (e.g. roadside-mailbox)')?.trim()
    if (!id) return
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return toast('ids are lower case letters, digits and hyphens', 'warn')
    try {
      await assetsvc.put({ id, subject: id.replace(/-/g, ' '), prompt: '', negative: '' })
      this.selected = id
      await this.refresh()
      toast(`${id} created — describe it, then draw`, 'ok')
    } catch (e) {
      toast(`create: ${(e as Error).message}`, 'danger')
    }
  }

  private async remove(id: string) {
    if (!confirm(`Delete ${id} and every file generated for it? This cannot be undone.`)) return
    try {
      await assetsvc.remove(id)
      if (this.selected === id) this.selected = null
      await this.refresh()
      toast(`${id} deleted`, 'ok')
    } catch (e) {
      toast(`delete: ${(e as Error).message}`, 'danger')
    }
  }

  private async draw(id: string) {
    await this.run(() => assetsvc.image(id), `drawing ${id}`)
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
