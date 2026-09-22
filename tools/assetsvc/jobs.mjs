// Jobs: the one place in assetsvc that understands waiting.
//
// A 2D generation is tens of seconds and a reconstruction is minutes. Neither can be held open on
// an HTTP connection through an ingress, and the editor must be able to close its laptop and come
// back — so every unit of work here is a job: POST starts one and returns an id, GET polls it.
// Exactly the shape tools/recon-service already uses, for the same reason.
//
// ONE AT A TIME, PER LANE. The GPU behind the mesh model serialises internally; firing six
// reconstructions at it gets six that are each six times slower, plus an out-of-memory. So jobs
// run through a queue with a concurrency of one per lane ('image', 'mesh'), which also makes the
// queue depth an honest number to show someone: "third in line" rather than a spinner.
//
// Jobs are IN MEMORY and deliberately so. They are progress, not results — every result lands in
// the catalog on the volume before the job is marked done, so a pod restart loses the progress bar
// and nothing else.

import { randomUUID } from 'node:crypto'

export class Jobs {
  constructor({ keep = 200 } = {}) {
    this.jobs = new Map()
    this.queues = new Map()
    this.keep = keep
  }

  #queue(lane) {
    if (!this.queues.has(lane)) this.queues.set(lane, { running: false, waiting: [] })
    return this.queues.get(lane)
  }

  /**
   * Enqueue work. `fn` receives a `report` callback for progress and must resolve to the job's
   * result, which is JSON the poller will see.
   */
  start(lane, label, fn) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12)
    const job = {
      job: id,
      lane,
      label,
      state: 'queued',
      queued: new Date().toISOString(),
      started: null,
      finished: null,
      progress: null,
      result: null,
      detail: null,
    }
    this.jobs.set(id, job)
    this.#trim()

    const q = this.#queue(lane)
    q.waiting.push(async () => {
      job.state = 'running'
      job.started = new Date().toISOString()
      try {
        job.result = await fn((progress) => {
          job.progress = progress
        })
        job.state = 'done'
      } catch (e) {
        job.state = 'failed'
        job.detail = String(e?.message ?? e)
      } finally {
        job.finished = new Date().toISOString()
      }
    })
    this.#pump(lane)
    return this.status(id)
  }

  async #pump(lane) {
    const q = this.#queue(lane)
    if (q.running) return
    q.running = true
    try {
      while (q.waiting.length) {
        const next = q.waiting.shift()
        await next()
      }
    } finally {
      q.running = false
    }
  }

  status(id) {
    const j = this.jobs.get(id)
    if (!j) return null
    const q = this.#queue(j.lane)
    return {
      ...j,
      // how many are in front of this one, so a queued job can say something useful
      ahead: j.state === 'queued' ? q.waiting.length : 0,
    }
  }

  list() {
    return [...this.jobs.values()].map((j) => this.status(j.job)).sort((a, b) => (a.queued < b.queued ? 1 : -1))
  }

  /** Keep the newest `keep` finished jobs; running and queued ones are never dropped. */
  #trim() {
    const finished = [...this.jobs.values()].filter((j) => j.state === 'done' || j.state === 'failed')
    if (finished.length <= this.keep) return
    finished.sort((a, b) => (a.finished < b.finished ? -1 : 1))
    for (const j of finished.slice(0, finished.length - this.keep)) this.jobs.delete(j.job)
  }
}
