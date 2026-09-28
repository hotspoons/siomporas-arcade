// Running a bake, watching it, and publishing what comes out.
//
// THE LOG TAIL IS A setTimeout LOOP READING BYTE OFFSETS, and everything about that is deliberate.
// `GET /api/runs/<id>/log?offset=N` returns the bytes after N and the file's size; the poll asks
// again from wherever it got to. No EventSource (it needs proxy buffering off at the ingress and
// dies on a rolling update), and no `requestAnimationFrame` anywhere near it — rAF does not fire
// in a background tab, which is exactly the tab a person leaves a forty-minute bake in. A
// background `setTimeout` is clamped to about 1 Hz, which for a log tail is fine and is the
// difference between "slower" and "stopped".
//
// The poll also survives a reload and a pod restart: the log is a file on the volume, so the tail
// picks up from byte 0 of whatever is there.
import { Dialog, button, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout } from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type Run, type World } from './api'
import { downloadBakeGroup } from './transfer'

const STATE_KIND: Record<Run['state'], 'info' | 'ok' | 'warn' | 'danger'> = {
  starting: 'info',
  queued: 'info',
  running: 'warn',
  done: 'ok',
  failed: 'danger',
}

/** A live tail of one run's log, in a dialog. One at a time; opening another replaces it. */
export class LogView {
  dialog: Dialog
  private pre = el('pre', 'run-log')
  private head = el('div', 'run-head')
  private offset = 0
  private timer = 0
  private id: string | null = null
  private stick = true

  constructor() {
    this.dialog = new Dialog({ title: 'Run', icon: 'queue-list', size: 'lg', onClose: () => this.stop() })
    this.dialog.body.append(this.head, this.pre)
    this.dialog.body.classList.add('run-body')
    // "follow the tail unless the reader has scrolled up" — the one behaviour every log viewer
    // needs and the one that is always missing.
    this.pre.addEventListener('scroll', () => {
      this.stick = this.pre.scrollTop + this.pre.clientHeight >= this.pre.scrollHeight - 24
    })
  }

  async open(id: string) {
    this.stop()
    this.id = id
    this.offset = 0
    this.stick = true
    this.pre.textContent = ''
    this.dialog.open()
    await this.tick()
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = 0
    this.id = null
  }

  private async tick() {
    const id = this.id
    if (!id) return
    try {
      const [{ run }, chunk] = await Promise.all([api.run(id), api.log(id, this.offset)])
      this.offset = chunk.offset
      if (chunk.text) {
        this.pre.append(document.createTextNode(chunk.text))
        if (this.stick) this.pre.scrollTop = this.pre.scrollHeight
      }
      this.head.replaceChildren(
        chip(run.state),
        el('span', 'run-title', run.label),
        liveMeta(run),
      )
      this.dialog.footer(
        run.state === 'done' || run.state === 'failed'
          ? button({ label: 'Close', onClick: () => this.dialog.close() })
          : button({
              label: 'Cancel this run',
              icon: 'stop',
              variant: 'danger',
              onClick: async () => {
                await api.cancel(id).catch((e) => toast((e as Error).message, 'danger'))
              },
            }),
      )
      if (run.state === 'done' || run.state === 'failed') {
        // one last read, so the final lines written between the two calls above are not lost
        const last = await api.log(id, this.offset)
        if (last.text) this.pre.append(document.createTextNode(last.text))
        if (this.stick) this.pre.scrollTop = this.pre.scrollHeight
        this.stop()
        return
      }
    } catch (e) {
      this.pre.append(document.createTextNode(`\n[tail] ${(e as Error).message}\n`))
    }
    if (this.id) this.timer = window.setTimeout(() => void this.tick(), 2000)
  }
}

export interface RunsOpts {
  host: HTMLElement
  logs: LogView
  worlds: () => World[]
  selected: () => string | null
  /** a run finished — the world list's "baked" state has moved and wants re-reading */
  onFinished: () => void
  /** re-read the world list, after an uploaded archive brought a new baked world with it */
  refreshWorlds: () => Promise<void>
}

/**
 * The live run's line: where it is running, and how long it has been.
 *
 * TICKING, because the panel itself only re-renders on the four-second poll and a duration that
 * jumps in four-second steps reads as a stuck number. One `setInterval` per row, stopped when the
 * row leaves the DOM, so a closed panel is not running a clock.
 */
function liveMeta(run: Run): HTMLElement {
  const where = `${run.runner}${run.job ? ` \u00b7 ${run.job}` : ''}${run.pod ? ` \u00b7 ${run.pod}` : ''}`
  const meta = el('span', 'run-meta')
  meta.title = startedAt(run)
  const tick = () => {
    if (!meta.isConnected) { clearInterval(timer); return }
    meta.textContent = `${where} \u00b7 ${when(run)}`
  }
  const timer = setInterval(tick, 1000)
  tick()
  return meta
}

/** The Bake panel: what exists, what has been baked, what is running. */
export class RunsPanel {
  /** Set once config arrives; null means publishing is off and the panel says why. */
  bucket: { bucket: string; endpoint: string; prefix: string } | null = null
  runner = 'local'

  private o: RunsOpts
  private runs: Run[] = []
  private live = new Set<string>()
  private timer = 0

  constructor(o: RunsOpts) {
    this.o = o
  }

  /** Poll the run list while this panel is on screen. A timer, for the same reason as the tail. */
  start() {
    void this.refresh()
    clearTimeout(this.timer)
    const loop = async () => {
      await this.refresh()
      this.timer = window.setTimeout(loop, this.runs.some((r) => r.state === 'running' || r.state === 'queued') ? 4000 : 15000)
    }
    this.timer = window.setTimeout(loop, 4000)
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = 0
  }

  async refresh() {
    try {
      this.runs = (await api.runs()).runs
    } catch {
      /* the panel still renders; a backend that is down shows as an empty run list */
    }
    // A run that was live and is not any more changed something on the volume: a bake wrote a
    // site, a publish wrote the bucket's index. Tell the page so "baked" stops lying.
    const nowLive = new Set(this.runs.filter((r) => r.state === 'running' || r.state === 'queued' || r.state === 'starting').map((r) => r.id))
    let finished = false
    for (const id of this.live) if (!nowLive.has(id)) finished = true
    this.live = nowLive
    if (finished) this.o.onFinished()
    this.render()
  }

  render() {
    const host = this.o.host
    host.replaceChildren()
    const slug = this.o.selected()
    const world = this.o.worlds().find((w) => w.slug === slug) ?? null

    const where = group('Where it runs')
    bodyOf(where).append(
      readout('runner', this.runner),
      this.runner === 'local'
        ? note('Runs as a subprocess here.')
        : note('Runs as a Kubernetes Job on the shared volume.'),
    )
    host.append(where)

    const sel = group(world ? `Bake “${world.slug}”` : 'Bake')
    const sb = bodyOf(sel)
    if (!world) sb.append(empty('No world selected'))
    else {
      sb.append(
        readout('centre', `${world.lat.toFixed(5)}, ${world.lon.toFixed(5)}`),
        readout('radius', `${world.radius_m.toLocaleString()} m`),
        readout('roads', world.all_streets ? 'every drivable street' : `${world.roads?.length ?? 0} named`),
        readout('primary', world.primary ?? '—'),
        readout('baked', world.baked ? `${world.baked.fetched ?? 'yes'}${world.baked.seconds ? ` · ${world.baked.seconds} s` : ''}` : 'never'),
      )
      // `frame.kind` is the ONLY thing that says which metres a bake holds, and the absence of it
      // is not evidence of either — it means this bake predates the stamp, which is exactly the
      // case worth saying out loud rather than assuming into "enu".
      const frame = world.baked?.frame
      if (frame) {
        sb.append(readout('frame', frame.kind ?? 'unstamped'))
        if (frame.anchor) sb.append(readout('anchor', `${frame.anchor.lat.toFixed(5)}, ${frame.anchor.lon.toFixed(5)}`))
        if (frame.kind && frame.kind !== 'enu') {
          sb.append(warn('Old UTM-relative frame — re-bake before authoring against it.'))
        } else if (!frame.kind) {
          sb.append(warn('No frame stamp — re-bake.'))
        }
      }
      const acts = el('div', 'panel-actions')
      acts.append(
        button({
          label: world.baked ? 'Re-bake' : 'Bake',
          icon: 'play',
          variant: 'primary',
          onClick: async () => {
            try {
              const { run } = await api.bake(world.slug)
              toast(`${run.label} started`, 'ok')
              await this.refresh()
              void this.o.logs.open(run.id)
            } catch (e) {
              toast((e as Error).message, 'danger', 8000)
            }
          },
        }),
      )
      if (world.baked) {
        acts.append(
          button({
            label: 'Open in the viewer',
            icon: 'globe-alt',
            onClick: () => window.open(`/index.html?site=${world.slug}`, '_blank'),
          }),
          button({
            label: 'Open in the editor',
            icon: 'pencil-square',
            onClick: () => window.open(`/editor.html?site=${world.slug}`, '_blank'),
          }),
        )
      }
      sb.append(acts)
      if (world.baked) sb.append(note('Re-baking is quicker: the sources are cached.'))
    }
    host.append(sel)

    /* publish */
    const pub = group('Publish')
    const pb = bodyOf(pub)
    if (!this.bucket) {
      pb.append(
        empty('No bucket configured'),
        note('Set a bucket to publish baked worlds.'),
      )
    } else {
      pb.append(readout('bucket', `${this.bucket.bucket}/${this.bucket.prefix}`), readout('endpoint', this.bucket.endpoint))
      const acts = el('div', 'panel-actions')
      acts.append(
        button({
          label: world?.baked ? `Publish ${world.slug}` : 'Publish everything baked',
          icon: 'cloud-arrow-up',
          variant: 'primary',
          onClick: async () => {
            try {
              const { run } = await api.publish(world?.baked ? world.slug : 'all')
              toast(`${run.label} started`, 'ok')
              await this.refresh()
              void this.o.logs.open(run.id)
            } catch (e) {
              toast((e as Error).message, 'danger', 8000)
            }
          },
        }),
        button({
          label: 'Dry run',
          icon: 'beaker',
          title: 'list what would be uploaded without uploading it',
          onClick: async () => {
            try {
              const { run } = await api.publish(world?.baked ? world.slug : 'all', { dryRun: true })
              void this.o.logs.open(run.id)
            } catch (e) {
              toast((e as Error).message, 'danger', 8000)
            }
          },
        }),
      )
      pb.append(acts)
      pb.append(note('Unchanged files are skipped.'))
    }
    host.append(pub)

    /* Download only. IMPORTING a baked world is part of making one, so it lives on the world
       form beside "draw an area" rather than here under a heading called "move" — which is what
       it was, and read as a third thing you might do to a world you already had. */
    host.append(downloadBakeGroup({
      selected: () => world?.slug ?? null,
      worlds: () => this.o.worlds(),
      reload: () => this.o.refreshWorlds(),
    }))

    /* history */
    const hist = group('Runs')
    const hb = bodyOf(hist)
    if (!this.runs.length) hb.append(empty('Nothing has run yet'))
    for (const r of this.runs.slice(0, 20)) {
      const row = el('button', 'run-row')
      const meta = el('span', 'run-meta', when(r))
      meta.title = startedAt(r)
      row.append(chip(r.state), el('span', 'run-title', r.label), meta)
      row.onclick = () => void this.o.logs.open(r.id)
      hb.append(row)
    }
    host.append(hist)
  }
}

function chip(state: Run['state']): HTMLElement {
  const s = el('span', `state-chip ${STATE_KIND[state]}`)
  s.append(icon(state === 'running' ? 'bolt' : state === 'done' ? 'check' : state === 'failed' ? 'exclamation-triangle' : 'clock', 13), el('span', '', state))
  return s
}

/**
 * A duration, in the largest unit that still says something.
 *
 * `1h 12m`, not `72m` and not `4320s`: a bake runs for hours and the question a person has is
 * whether it has been going for ten minutes or all afternoon.
 */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  const h = Math.floor(s / 3600)
  return `${h}h ${Math.floor((s % 3600) / 60)}m`
}

/**
 * How long a run has been going, or how long it took.
 *
 * ELAPSED, NOT THE START TIME. Rich, 2026-09-28: "would be helpful to show how many seconds or
 * minutes or hours the bake is running, not just start time." A clock time makes the reader do the
 * subtraction, and they have to know what time it is now to do it. The start time is still there,
 * in the tooltip, because it is the thing you need when correlating with a log.
 */
function when(r: Run, now = Date.now()): string {
  if (!r.finished) return `${elapsed((now - Date.parse(r.started)) / 1000)} so far`
  return elapsed((Date.parse(r.finished) - Date.parse(r.started)) / 1000)
}

/** The start time, for the tooltip — the thing you want when reading a log beside this. */
function startedAt(r: Run): string {
  const d = new Date(r.started)
  return `started ${d.toLocaleTimeString()} on ${d.toLocaleDateString()}`
}

function note(text: string): HTMLElement {
  const p = el('p', 'panel-hint')
  p.append(icon('information-circle', 14), el('span', '', text))
  return p
}

function warn(text: string): HTMLElement {
  const p = el('p', 'panel-hint warn')
  p.append(icon('exclamation-triangle', 14), el('span', '', text))
  return p
}
