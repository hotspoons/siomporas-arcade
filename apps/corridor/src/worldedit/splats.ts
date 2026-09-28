// The Splats panel: footage in, a captured world out.
//
// A capture is the video a gaussian world is made from — chapters, per camera, belonging to a
// world. The upload path has existed since this afternoon and was reachable only with curl, which
// for a thing whose whole difficulty is "drag forty gigabytes in from a phone" is not a feature.
//
// THE UPLOAD IS THE HARD PART AND IT IS RESUMABLE BY DESIGN. A GoPro Max 2 writes a 4 GB chapter
// every few minutes and a neighbourhood is tens of them, so:
//
//   * chunks are sized by the SERVER (`/api/uploads/limits`), because only it knows what ingress
//     sits in front of it — a chunk over the proxy's body limit is a 413 three hours in;
//   * nothing is read into memory whole. `File.slice()` gives a Blob the browser streams;
//   * a 409 is not an error. It is the server saying where the file actually ends, and the client
//     continues from there, which is also what makes re-adding a half-uploaded file resume rather
//     than start again.
//
// ORDER IS EXPLICIT. GoPro names a file `GS<chapter><recording>` — chapter FIRST — so sorting by
// name interleaves recordings, silently. The server carries an `order` and says so; nothing here
// sorts anything.

import { button, confirm, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout, select, textField } from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type Capture, type CaptureManifest, type TrainingRun } from './api'

const hint = (text: string, warn = false) => {
  const p = el('div', `panel-hint${warn ? ' warn' : ''}`)
  p.append(icon(warn ? 'exclamation-triangle' : 'information-circle', 14), el('span', '', text))
  return p
}

const GB = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${(b / 2 ** 20).toFixed(0)} MB`)

export interface SplatsOpts {
  host: HTMLElement
  /** worlds on this volume, so a capture can be attached to one */
  worlds: () => string[]
}

interface Sending {
  name: string
  camera: string
  sent: number
  total: number
  done: boolean
  error?: string
}

export class SplatsPanel {
  private o: SplatsOpts
  private captures: Capture[] = []
  private open: { capture: Capture; manifest: CaptureManifest } | null = null
  private sending: Sending[] = []
  private chunkBytes = 32 * 2 ** 20
  private plan: { via: string; kind: string | null; available: boolean; featured?: boolean; why?: string } | null = null
  private preview: { kind: string; yaml: string } | null = null
  private runs: TrainingRun[] = []
  private workers = 0
  private abort: AbortController | null = null

  constructor(o: SplatsOpts) {
    this.o = o
  }

  async load() {
    try {
      const [cs, limits, plan, runs] = await Promise.all([
        api.captures(),
        api.uploadLimits().catch(() => null),
        api.trainingPlan().catch(() => null),
        api.trainingRuns().then((r) => r.runs).catch(() => []),
      ])
      this.captures = cs.captures
      if (limits) this.chunkBytes = limits.chunkBytes
      this.plan = plan
      this.runs = runs
    } catch (e) {
      toast(`captures: ${(e as Error).message}`, 'warn', 5000)
    }
    this.render()
  }

  stop() {
    this.abort?.abort()
    this.abort = null
  }

  private async show(id: string) {
    try {
      this.open = await api.capture(id)
    } catch (e) {
      toast((e as Error).message, 'warn', 5000)
    }
    this.render()
  }

  private async create() {
    const id = `capture-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`
    try {
      const r = await api.createCapture({ id, world: this.o.worlds()[0] ?? null, rig: 'GoPro Max 2' })
      await this.load()
      await this.show(r.capture.id)
    } catch (e) {
      toast((e as Error).message, 'danger', 6000)
    }
  }

  /**
   * Send one file, resuming wherever the server says it already is.
   *
   * Sequential on purpose: the server appends only at the end, so two chunks in flight for one
   * file is a race the protocol is designed to refuse. Several FILES could go at once, and do not
   * yet, because a home connection is the bottleneck and parallelism there buys nothing.
   */
  private async send(file: File, camera: string) {
    const cap = this.open?.capture
    if (!cap) return
    const row: Sending = { name: file.name, camera, sent: 0, total: file.size, done: false }
    this.sending.push(row)
    this.render()
    this.abort ??= new AbortController()
    try {
      const begin = await api.beginChapter(cap.id, { camera, name: file.name, bytes: file.size })
      let at = begin.offset
      if (at > 0) toast(`${file.name}: resuming at ${GB(at)}`, 'info', 3500)
      let stuck = 0
      while (at < file.size) {
        const end = Math.min(at + this.chunkBytes, file.size)
        const before = at
        const r = await api.putChunk(begin.upload, at, file.slice(at, end), file.size, this.abort.signal)
        // a 409 is the server telling us where it actually is — continue from there rather than fail
        at = 'resumeAt' in r ? r.resumeAt : r.offset
        /*
         * AND IF IT DOES NOT MOVE, STOP. A loop that re-sends the same slice for ever because the
         * server keeps answering with the same offset would look, from here, exactly like a slow
         * upload — and on a 40 GB file nobody would question a progress bar that is not moving for
         * a while. Three refusals in a row is a protocol disagreement and worth saying out loud.
         */
        stuck = at > before ? 0 : stuck + 1
        if (stuck >= 3) throw new Error(`the server keeps saying this upload is at ${at} bytes — it is not accepting what we send`)
        row.sent = at
        this.render()
      }
      await api.finishChapter(begin.upload, cap.id)
      row.done = true
      toast(`${file.name} uploaded`, 'ok', 2500)
      await this.show(cap.id)
    } catch (e) {
      row.error = (e as Error).message
      this.render()
    }
  }

  /** Show the object before spending hours of several GPUs on it. */
  private async previewRun(as?: string) {
    const cap = this.open?.capture
    if (!cap) return
    try {
      const r = await api.trainingPreview({ capture: cap.id, world: cap.world, workers: this.workers }, as)
      this.preview = { kind: r.kind, yaml: JSON.stringify(r.manifest, null, 1) }
      this.render()
    } catch (e) {
      toast((e as Error).message, 'danger', 7000)
    }
  }

  /**
   * Actually start it.
   *
   * This is what the buttons used to only pretend to do — they showed a manifest and toasted
   * "not yet created", which was an honest label on a feature that did not exist.
   *
   * THE WORKER COUNT COMES FROM FREE GPUS, asked of the scheduler. Not from the length of the
   * footage, and never by counting pods by name. A worker that finds an empty queue exits and one
   * that starts before the chunks exist waits, so over-provisioning costs an idle pod rather than
   * a wrong answer — which is the property that makes this safe to schedule at all. Measured on
   * this cluster while writing it: 8 allocatable, 8 in use by flux, recon, a qwen server and the
   * splats lane's own pose job. Free is a real number and it is often zero.
   */
  private async start() {
    const cap = this.open?.capture
    if (!cap) return
    const gpus = await api.trainingGpus().catch(() => ({ free: 0, total: 0, known: false, why: 'could not ask the scheduler' }))
    /*
     * AN UNKNOWN COUNT IS NOT ZERO.
     *
     * Listing nodes is cluster-scoped and the chart's Role is namespaced, so unless it was
     * installed with gpuVisibility the answer is "could not ask" — and treating that as "no GPUs
     * free" would quietly refuse to fan any run out, forever, on a cluster with eight idle GPUs.
     * When the count is unknown the person's own number stands and the dialog says why.
     */
    const workers = gpus.known === false ? this.workers : Math.max(0, Math.min(this.workers, Math.max(0, gpus.free - 1)))
    const yes = await confirm({
      title: `Start a splat run on ${cap.id}?`,
      message: gpus.known === false
        ? `A leader and ${workers} worker${workers === 1 ? '' : 's'}. Free GPUs are unknown — ${gpus.why}. Extra workers sit idle rather than failing, but they do hold a GPU.`
        : workers === this.workers
          ? `A leader and ${workers} worker${workers === 1 ? '' : 's'}. ${gpus.free} of ${gpus.total} GPUs are free.`
          : `Only ${gpus.free} of ${gpus.total} GPUs are free, so this will run a leader and ${workers} worker${workers === 1 ? '' : 's'} rather than ${this.workers}. Extra workers would sit idle, not fail — but they would hold GPUs.`,
      ok: 'Start it',
    })
    if (!yes) return
    try {
      const { run } = await api.startTraining({ capture: cap.id, world: cap.world, workers })
      toast(`${run.kind} ${run.name} started`, 'ok', 6000)
      await this.loadRuns()
      this.render()
    } catch (e) {
      toast(`could not start: ${(e as Error).message}`, 'danger', 9000)
    }
  }

  private async loadRuns() {
    this.runs = await api.trainingRuns().then((r) => r.runs).catch(() => [])
  }

  render() {
    const host = this.o.host
    host.replaceChildren()

    if (!this.open) {
      host.append(hint('A capture is the footage a gaussian world is made from. Upload chapters, then train.'))
      const list = group('Captures')
      const lb = bodyOf(list)
      if (!this.captures.length) lb.append(empty('none yet'))
      for (const c of this.captures) {
        const done = c.chapters.filter((x) => x.complete).length
        const row = el('button', 'row')
        row.append(el('span', 'row-name', c.id), el('span', 'row-note', `${c.world ?? 'no world'} · ${done}/${c.chapters.length} chapters`))
        row.onclick = () => void this.show(c.id)
        lb.append(row)
      }
      lb.append(button({ label: 'New capture', icon: 'plus', onClick: () => void this.create() }))
      host.append(list)
      return
    }

    const { capture: c, manifest: m } = this.open
    host.append(button({ label: 'All captures', icon: 'arrow-left', variant: 'ghost', onClick: () => { this.open = null; this.render() } }))

    /* what it is and what it is for */
    const what = group(c.id, { note: c.rig ?? undefined })
    const wb = bodyOf(what)
    const worlds = this.o.worlds()
    wb.append(
      select({
        label: 'world',
        value: c.world && worlds.includes(c.world) ? c.world : (worlds[0] ?? ''),
        options: [{ value: '', label: '(none yet)' }, ...worlds.map((w) => ({ value: w, label: w }))],
        onChange: (v) => void api.patchCapture(c.id, { world: v || null }).then(() => this.show(c.id)),
      }),
    )
    // SITE_DIR is load-bearing: levelling against the site's lidar is what puts the capture on the
    // ground. Without a world the result is internally consistent and absolutely unverified.
    if (!c.world) wb.append(hint('Without a world the capture cannot be levelled against its lidar — the result will sit at an unverified height.', true))
    wb.append(readout('footage', `${m.chapters} chapter${m.chapters === 1 ? '' : 's'} · ${GB(m.bytes)}`))
    if (m.pending) wb.append(readout('unfinished', String(m.pending)))
    host.append(what)

    /* the chapters, in the order the trainer will read them */
    const chapters = group('Chapters', { note: m.ordering })
    const cb = bodyOf(chapters)
    for (const [cam, list] of Object.entries(m.cameras ?? {})) {
      cb.append(readout(cam, `${list.length} · ${GB(list.reduce((n, x) => n + x.bytes, 0))}`))
      for (const ch of list) cb.append(readout(`  ${ch.order}`, `${ch.name} · ${GB(ch.bytes)}`))
    }
    if (!Object.keys(m.cameras ?? {}).length) cb.append(empty('nothing uploaded yet'))

    /* add some */
    const camField = textField({ label: 'camera', value: 'max2-front', placeholder: 'max2-front', onChange: () => {} })
    cb.append(camField)
    const picker = el('input') as HTMLInputElement
    picker.type = 'file'
    picker.multiple = true
    picker.accept = '.360,.mp4,.mov,.insv,.mkv,.lrv'
    picker.className = 'input wide'
    picker.onchange = () => {
      const cam = (camField.querySelector('input') as HTMLInputElement)?.value.trim() || 'cam'
      for (const f of Array.from(picker.files ?? [])) void this.send(f, cam)
      picker.value = ''
    }
    cb.append(picker)
    cb.append(hint(`Chunks of ${GB(this.chunkBytes)}, resumable — re-adding an interrupted file carries on where it stopped.`))

    for (const s of this.sending) {
      const pct = s.total ? Math.round((s.sent / s.total) * 100) : 0
      cb.append(readout(s.name, s.error ? `failed: ${s.error.slice(0, 40)}` : s.done ? 'done' : `${pct}% · ${GB(s.sent)} of ${GB(s.total)}`))
    }
    host.append(chapters)

    /* and the run */
    const train = group('Train', {
      note: this.plan?.featured
        ? 'This cluster has the platform’s TrainingDeployment, which brings up the JobSet, the volume and the metrics for you.'
        : (this.plan?.why ?? 'A plain JobSet.'),
    })
    const tb = bodyOf(train)
    tb.append(readout('will use', this.plan?.kind ?? 'nothing — no workload API installed'))
    tb.append(
      textField({
        label: 'workers',
        value: String(this.workers),
        type: 'number',
        step: 1,
        onChange: (v) => {
          this.workers = Math.max(0, Math.min(16, Number(v) || 0))
        },
      }),
    )
    // the count is a function of FREE GPUS, not of the footage: an idle worker finishes, an early
    // one waits, so over-provisioning costs a pod rather than a wrong answer
    tb.append(hint('0 workers is a complete run on one pod. More is a leader plus that many, and the count follows free GPUs rather than the footage.'))
    if (m.pending) tb.append(hint(`${m.pending} chapter(s) are still uploading — a run started now would train on part of the footage.`, true))
    tb.append(
      button({ label: 'Start run', icon: 'play', variant: 'primary', onClick: () => void this.start() }),
      button({ label: 'Show what would run', icon: 'eye', onClick: () => void this.previewRun() }),
      button({ label: 'As a plain JobSet', icon: 'eye', variant: 'ghost', onClick: () => void this.previewRun('jobset') }),
    )
    host.append(train)

    /* The manifest, when it has been asked for. Inside render() rather than appended from the
       click handler: appending from outside meant repeated clicks stacked duplicate blocks and
       the next render silently discarded them. */
    if (this.preview) {
      const g = group(`What would be created — ${this.preview.kind}`, { collapsed: false })
      const pre = el('pre', 'manifest')
      pre.textContent = this.preview.yaml
      bodyOf(g).append(pre)
      host.append(g)
    }

    /* Runs this editor has started. */
    const runs = group('Runs')
    const rb = bodyOf(runs)
    if (!this.runs.length) rb.append(empty('none started from here'))
    for (const r of this.runs) {
      const row = el('div', 'run-row')
      row.append(
        el('span', `chip state-${r.state ?? 'unknown'}`, r.state ?? 'unknown'),
        el('span', 'run-title', r.name),
        el('span', 'run-meta', [r.capture, r.phase].filter(Boolean).join(' · ')),
      )
      row.append(button({
        icon: 'stop', variant: 'ghost', title: `stop ${r.name}`,
        onClick: async () => {
          if (!(await confirm({ title: `Stop ${r.name}?`, message: 'The pods go with it. Work already written to the volume stays.', ok: 'Stop it', danger: true }))) return
          await api.stopTraining(r.name).catch((e) => toast((e as Error).message, 'danger'))
          await this.loadRuns()
          this.render()
        },
      }))
      rb.append(row)
    }
    host.append(runs)
  }
}
