// Runs: a bake or a publish, from "go" to a log a person can read, in the cluster or on a laptop.
//
// A RUN IS A FILE, NOT AN OBJECT IN MEMORY. assetsvc's jobs are in memory because they are
// progress over a result that lands on a volume in seconds. A bake is twenty minutes to an hour
// and its log IS the thing you want afterwards — "which step was slow", "what did USGS say",
// "why is there no lidar here". So every run has `<data>/runs/<id>.json` and `<data>/runs/<id>.log`
// on the volume, written as it goes. A pod restart mid-bake loses nothing but the tail of the
// stream, and the reconciler picks the Job back up by name on the next poll.
//
// THE BROWSER POLLS BY BYTE OFFSET, and there is no server-sent-events stream here on purpose:
//   * an EventSource through ingress-nginx needs proxy buffering off and dies on a rolling update;
//   * `requestAnimationFrame` does not fire in a background tab and background `setTimeout` is
//     clamped to ~1 Hz, so a "live" stream a person tabs away from stops being live anyway;
//   * a byte offset into a file on a volume is resumable from any tab, any reload, any pod.
// `GET /api/runs/<id>/log?offset=N` is the whole protocol.
//
// TWO RUNNERS, ONE INTERFACE. In the cluster a run is a Job built to match `tools/corridor/chart`
// exactly. On a laptop it is a subprocess. Same record, same log file, same endpoints — which is
// what makes it possible to prove the thing works without booking a GH200.

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { bboxOf } from './geo.mjs'
import { mirrorsFor } from './overpass.mjs'

const now = () => new Date().toISOString()


/** How often a followed log's position is written to the run record. */
const SAVE_EVERY_MS = 2000

export class Runs {
  /**
   * @param store    the volume
   * @param k8s      a K8s client; used only when `.available`
   * @param cfg      image / claim / resources / the local fallback command
   */
  constructor(store, k8s, cfg) {
    this.store = store
    this.k8s = k8s
    this.cfg = cfg
    this.live = new Map() // id -> { stop() } for whatever is pumping this run's log
    // ids that have already reached a terminal state in THIS process. See #finish: two finishers
    // holding two copies of the same run both pass a check on their own object, so the guard has
    // to be on the id.
    this.done = new Set()
    // runs whose pod log is being followed right now, so a shutdown can save where each one got to
    this.following = new Map()
  }

  /**
   * Save every followed run's position (`lastStamp`). Called on SIGTERM, before the process goes:
   * the next pod adopts the run from the saved record and resumes from that stamp.
   */
  async flush() {
    await Promise.all([...this.following.values()].map((run) => this.#save(run).catch(() => {})))
  }

  describe() {
    return {
      runner: this.runner,
      // Reported, not asserted at start-up: a service configured for the cluster has no local
      // python and does not want one, and a service on a laptop wants to be told which path is
      // wrong before it spends a click finding out.
      localPythonPresent: existsSync(this.cfg.python),
      image: this.cfg.image,
      claim: this.cfg.claim,
      namespace: this.k8s.namespace,
      localPython: this.cfg.python,
      localCwd: this.cfg.cwd,
    }
  }

  get runner() {
    if (this.cfg.force === 'local') return 'local'
    return this.k8s.available ? 'kubernetes' : 'local'
  }

  /* ---- starting ----------------------------------------------------------------------------- */

  /**
   * Start a bake of one world (or `all`).
   *
   * `corridor fetch` is the whole bake: it fetches, measures, and writes `web/` plus
   * `sites/index.json` at the end (see `fetch_site`). There is no second export step to run, and
   * adding one would re-export every site on the volume.
   */
  async bake(slug, opts = {}) {
    // A WORLD TOO BIG FOR ONE JOB GOES PLAN -> SHARD -> FINALIZE (docs/corridor/PLAN-SHARDED-BAKE.md).
    // The three phases are three sets of Jobs in one run: one cheap plan Job, N shard Jobs fanned
    // across the cluster, one cheap finalizer. `run.phase`/`run.jobs` carry the state so a pod
    // restart resumes at the phase it was in (reconcile below).
    //
    // Sharding is automatic above `shardAboveM` when that is configured (OFF by default until the
    // per-shard export path lands — see the note there). `sharded: true` forces it on any world,
    // which is how the plan -> shard -> finalize path is exercised before a real large world.
    const sharded = opts.sharded ?? (await this.#shouldShard(slug))
    if (sharded) {
      return this.#start({ kind: 'bake', slug, args: [], label: `bake ${slug} (sharded)`, sharded: true, phaseArgs: opts })
    }
    const args = ['fetch', slug]
    if (opts.skip) args.push('--skip', opts.skip)
    if (opts.halfWidth) args.push('--half-width', String(opts.halfWidth))
    return this.#start({ kind: 'bake', slug, args, label: `bake ${slug}` })
  }

  /** A world large enough that one Job's bbox is the problem: > `shardAboveM` half-width.
   *
   * OFF BY DEFAULT. Auto-sharding turns on only when `cfg.shardAboveM` is set, because the sharded
   * path does not yet run `export_tiles`/`pyramid.bake` per shard — an auto-sharded world would
   * come out with no tiles until that lands. Request `{"sharded":true}` to force it for the spike.
   */
  async #shouldShard(slug) {
    if (slug === 'all') return false
    const ceiling = Number(this.cfg.shardAboveM)
    if (!Number.isFinite(ceiling) || ceiling <= 0) return false
    const world = await this.store.getWorld(slug).catch(() => null)
    const r = Number(world?.radius_m)
    return Number.isFinite(r) && r > ceiling
  }

  /**
   * The Overpass upstreams that can answer for this world, fences stripped.
   *
   * THE BAKE DOES NOT UNDERSTAND FENCES. `osm.py` splits `CORRIDOR_OVERPASS_URL` on commas and
   * posts to the first entry, and a `#south/west/north/east` fragment is never sent on the wire —
   * so handing it this service's whole fenced list sent a MARYLAND world to the EUROPE extract,
   * which answered 200 with no elements and the bake raised "no ways for roads [] within 1219 m".
   * Working mirror, correct query, silent empty.
   *
   * The fence logic stays in one place (overpass.mjs, where it is tested) and the Job is given a
   * list it can use blindly. An empty result is not an error: it means nothing we run covers this
   * place, and the bake's own public mirrors are the right answer — so the variable is left unset
   * and `osm.py` falls through to them.
   */
  async #overpassFor(slug) {
    if (!this.cfg.overpassUrl) return null
    const world = await this.store.getWorld(slug).catch(() => null)
    if (!world || !Number.isFinite(world.lat) || !Number.isFinite(world.lon)) {
      // a world with no centre cannot be placed, so every mirror is a candidate
      return this.cfg.overpassUrl.split(',').map((u) => u.split('#')[0].trim()).filter(Boolean).join(',') || null
    }
    // `radius_m` is a HALF-WIDTH (see worlds.mjs), so the square is the centre plus and minus it
    const r = Number.isFinite(world.radius_m) ? world.radius_m : 1000
    const bbox = bboxOf([{ lat: world.lat, lon: world.lon }], r)
    const urls = mirrorsFor(this.cfg.overpassUrl, bbox)
    return urls.length ? urls.join(',') : null
  }

  /** Mirror a baked world into the bucket. Needs the credentials Secret; see the chart. */
  publish(slug, opts = {}) {
    const args = ['publish', slug]
    if (opts.prefix) args.push('--prefix', opts.prefix)
    if (opts.dryRun) args.push('--dry-run')
    return this.#start({ kind: 'publish', slug, args, label: `publish ${slug}`, needsBucket: true })
  }

  /**
   * A run that is a FUNCTION in this process rather than a subprocess or a Job: the deploy. It
   * gets the same record and the same log file as a bake, so the runs list, the log viewer and
   * `cancel` (which flips its signal) all work on it without knowing the difference.
   *
   * @param {{ kind: string, slug: string, label: string, task: (ctx: { log: (line: string) => void, signal: AbortSignal }) => Promise<string | null | undefined> }} o
   */
  async startTask({ kind, slug, label, task }) {
    const id = `${kind}-${slug}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`
    const run = { id, kind, slug, label, args: [], runner: 'local', state: 'running', started: now(), finished: null, detail: null, job: null, pod: null, lastStamp: null, exit: null }
    await this.store.writeAtomic(this.store.runFile(id), Buffer.from(JSON.stringify(run, null, 1)))
    await this.store.writeAtomic(this.store.logFile(id), Buffer.from(`=== ${label} (in-process) ${run.started}\n`))
    const ac = new AbortController()
    this.live.set(id, { stop: () => ac.abort() })
    // appends are serialised: two log lines in the same tick must land in order
    let chain = Promise.resolve()
    const log = (line) => {
      chain = chain.then(() => this.#append(id, `${String(line)}\n`)).catch(() => {})
      return chain
    }
    void (async () => {
      try {
        const detail = await task({ log, signal: ac.signal })
        await chain
        await this.#finish(run, 'done', 0, detail ?? null)
      } catch (e) {
        await chain
        await this.#finish(run, 'failed', 1, String(e?.message ?? e))
        this.finishedHooks.get(id)?.('failed')
      }
      this.finishedHooks.delete(id)
    })()
    return run
  }

  /** what to tell when an in-process run ends other than well; one listener per run */
  finishedHooks = new Map()
  onFinished(id, fn) {
    this.finishedHooks.set(id, fn)
  }

  async #start({ kind, slug, args, label, needsBucket = false, sharded = false, phaseArgs = {} }) {
    if (needsBucket && !this.cfg.bucket) {
      throw Object.assign(new Error('no bucket configured — set WORLDEDITOR_S3_BUCKET and mount the credentials Secret'), { status: 400 })
    }
    const id = `${kind}-${slug}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`
    const run = {
      id,
      kind,
      slug,
      label,
      args,
      runner: this.runner,
      state: 'starting',
      started: now(),
      finished: null,
      detail: null,
      job: null,
      pod: null,
      lastStamp: null,
      exit: null,
      ...(sharded ? { sharded: true, phase: 'plan', phaseArgs, jobs: [], stamps: {} } : {}),
    }
    await this.store.writeAtomic(this.store.runFile(id), Buffer.from(JSON.stringify(run, null, 1)))
    await this.store.writeAtomic(this.store.logFile(id), Buffer.from(`=== ${label} (${run.runner}) ${run.started}\n`))
    // The world list the bake will read has to be on the volume BEFORE the Job starts.
    await this.store.materialise()
    if (this.runner === 'kubernetes' && sharded) await this.#startPhase(run)
    else if (this.runner === 'kubernetes') await this.#startJob(run)
    else await this.#startLocal(run)
    return run
  }

  async #save(run) {
    // A FINISHED RUN STAYS FINISHED. `cancel` reads its own copy of the record and finishes that;
    // the log follower holds another, still "running", and saved it when the deleted Job's stream
    // ended — so a cancelled bake read `running` again (2026-09-30, crofton-triangle), and the
    // follower's periodic saves would do it every time. Only a terminal write may follow a terminal one.
    if (this.done.has(run.id) && run.state !== 'done' && run.state !== 'failed') return run
    await this.store.writeAtomic(this.store.runFile(run.id), Buffer.from(JSON.stringify(run, null, 1)))
    return run
  }

  async #append(id, text) {
    const fh = await open(this.store.logFile(id), 'a')
    try {
      await fh.write(text)
    } finally {
      await fh.close()
    }
  }

  /* ---- the cluster runner --------------------------------------------------------------------- */

  /**
   * The Job, built to be the chart's Job.
   *
   * Differences from `tools/corridor/chart/templates/job.yaml`, all deliberate:
   *   * `backoffLimit: 0` — the chart retries once, which is right for an unattended nightly and
   *     wrong for a person watching: a failed bake that silently restarts prints its log twice and
   *     looks like a hang. Here, a failure is a failure and the person presses the button again.
   *   * `CORRIDOR_SITES=/data/sites.json` always, because the world being baked was drawn a minute
   *     ago and is not in the image.
   *   * `CORRIDOR_PYRAMID=1` always. A bake from this editor is a tile pyramid. Leaving it unset
   *     is how a world came out as one mesh: the bake image treats the variable as opt-in, and
   *     nothing in the job used to set it. There is no switch in the panel to turn LOD off.
   *   * no ConfigMap: the chart mounts sites.json as one, which caps at 1 MiB and needs a fresh
   *     object per revision. The volume is already mounted and already holds the materialised list.
   */
  async #jobSpec(run, args, { spread = false, tag = '' } = {}) {
    const name = `corridor-${run.kind}-${tag ? `${tag}-` : ''}${short(run.slug)}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`.slice(0, 60).replace(/-+$/, '')
    const overpass = await this.#overpassFor(run.slug)
    const env = [
      { name: 'CORRIDOR_DATA', value: '/data' },
      { name: 'CORRIDOR_SITES', value: '/data/sites.json' },
      { name: 'CORRIDOR_HORIZON_M', value: String(this.cfg.horizonM ?? 30000) },
      { name: 'CORRIDOR_PYRAMID', value: '1' },
      { name: 'PYTHONUNBUFFERED', value: '1' }, // or the log arrives in 4 KiB lumps, minutes late
      // No BLAS/GDAL thread pool, so the forked per-tile/profile pools cannot inherit a held lock.
      // `corridor/__main__.py` sets the same defaults before numpy loads; these make it explicit in
      // the manifest and cover a container that starts some other entrypoint. See the comment there
      // (dc-metro-take-2 deadlocked in profile_many, 2026-10-05).
      { name: 'OPENBLAS_NUM_THREADS', value: '1' },
      { name: 'OMP_NUM_THREADS', value: '1' },
      { name: 'MKL_NUM_THREADS', value: '1' },
      { name: 'NUMEXPR_NUM_THREADS', value: '1' },
      { name: 'GDAL_NUM_THREADS', value: '1' },
    ]
    if (overpass) env.push({ name: 'CORRIDOR_OVERPASS_URL', value: overpass })
    if (this.cfg.bucket) {
      env.push(
        { name: 'CORRIDOR_S3_BUCKET', value: this.cfg.bucket },
        { name: 'CORRIDOR_S3_ENDPOINT', value: this.cfg.endpoint ?? '' },
        { name: 'CORRIDOR_S3_REGION', value: this.cfg.region ?? 'auto' },
        { name: 'CORRIDOR_S3_PREFIX', value: this.cfg.prefix ?? 'corridor' },
      )
    }
    const spec = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        labels: { 'app.kubernetes.io/name': 'worldeditor-run', 'worldeditor/run': run.id, 'worldeditor/kind': run.kind },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: this.cfg.ttlSeconds ?? 604800,
        template: {
          metadata: { labels: { 'app.kubernetes.io/name': 'worldeditor-run', 'worldeditor/run': run.id } },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'corridor',
                image: this.cfg.image,
                imagePullPolicy: 'Always',
                command: ['python', '-m', 'corridor', ...args],
                env,
                ...(this.cfg.secretName ? { envFrom: [{ secretRef: { name: this.cfg.secretName, optional: true } }] } : {}),
                resources: this.cfg.resources,
                volumeMounts: [{ name: 'data', mountPath: '/data' }],
              },
            ],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: this.cfg.claim } }],
            ...(this.cfg.nodeSelector ? { nodeSelector: this.cfg.nodeSelector } : {}),
            // Fan the shard Jobs across the nodes instead of letting the scheduler pile them on
            // whichever node the API server happened to answer from. ScheduleAnyway: a world whose
            // shards outnumber the nodes must still schedule, just unevenly.
            ...(spread ? { topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: { 'worldeditor/run': run.id } } }] } : {}),
          },
        },
      },
    }
    return { name, spec }
  }

  async #startJob(run) {
    const { spec } = await this.#jobSpec(run, run.args)
    const made = await this.k8s.createJob(spec)
    run.job = made.metadata.name
    run.state = 'queued'
    await this.#save(run)
    this.#watchJob(run)
  }

  /* ---- the sharded runner: plan -> shard -> finalize ------------------------------------------ */

  #phaseArgs(run, which, index = null) {
    const o = run.phaseArgs ?? {}
    if (which === 'plan') {
      const out = ['plan', run.slug]
      if (o.halfWidth) out.push('--half-width', String(o.halfWidth))
      if (o.maxSide) out.push('--max-side', String(o.maxSide))
      if (o.maxShards) out.push('--max-shards', String(o.maxShards))
      return out
    }
    if (which === 'shard') {
      const out = ['shard', run.slug, String(index)]
      if (o.halfWidth) out.push('--half-width', String(o.halfWidth))
      if (o.lidarHalfWidth) out.push('--lidar-half-width', String(o.lidarHalfWidth))
      return out
    }
    return ['finalize', run.slug]
  }

  /** The plan the plan Job wrote: how many shards the world was cut into. */
  async #readPlan(slug) {
    try {
      return JSON.parse(await readFile(`${this.store.sites}/${slug}/plan/shards.json`, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Start the Jobs for the run's current phase and watch them.
   *
   * `plan` and `finalize` are one Job each; `shard` is N Jobs created together. N comes off the
   * volume — the plan Job just wrote it — rather than from a guess made before the network was
   * known. Whole-phase at a time: `run.jobs` is the set any one of which failing fails the run.
   */
  async #startPhase(run) {
    const phase = run.phase ?? 'plan'
    const created = []
    if (phase === 'plan') {
      const { spec } = await this.#jobSpec(run, this.#phaseArgs(run, 'plan'), { tag: 'plan' })
      created.push((await this.k8s.createJob(spec)).metadata.name)
    } else if (phase === 'shard') {
      const plan = await this.#readPlan(run.slug)
      const n = Number(plan?.n ?? 0)
      if (!n) {
        await this.#finish(run, 'failed', 1, 'the plan produced no shards')
        return
      }
      run.shardCount = n
      await this.#append(run.id, `\n=== shard phase: ${n} blocks, one Job each\n`)
      for (let i = 0; i < n; i++) {
        const { spec } = await this.#jobSpec(run, this.#phaseArgs(run, 'shard', i), { spread: true, tag: `shard-${i}` })
        created.push((await this.k8s.createJob(spec)).metadata.name)
      }
    } else {
      const { spec } = await this.#jobSpec(run, this.#phaseArgs(run, 'finalize'), { tag: 'finalize' })
      created.push((await this.k8s.createJob(spec)).metadata.name)
    }
    run.jobs = created
    run.job = created[0] ?? null
    run.followed = {}
    run.state = 'queued'
    await this.#save(run)
    this.#watchPhase(run)
  }

  /** Poll every Job in the phase; advance when all succeed, fail (and cancel the rest) on any failure. */
  #watchPhase(run) {
    let stopped = false
    this.live.set(run.id, { stop: () => { stopped = true } })
    const tick = async () => {
      while (!stopped) {
        try {
          let allDone = true
          let failed = null
          let anyActive = false
          run.followed ??= {}
          for (const name of run.jobs) {
            if (!run.followed[name]) {
              const pods = await this.k8s.podsFor(name).catch(() => [])
              const pod = pods.find((p) => p.status?.phase !== 'Pending') ?? pods[0]
              if (pod) {
                run.followed[name] = pod.metadata.name
                await this.#save(run)
                this.#followPhasePod(run, pod.metadata.name).catch((e) => void this.#append(run.id, `\n[worldeditor] log follow stopped: ${e.message}\n`))
              }
            }
            const job = await this.k8s.getJob(name)
            const s = job.status ?? {}
            if (s.failed) { failed = name; break }
            if (s.active) anyActive = true
            if (!s.succeeded) allDone = false
          }
          if (run.state !== 'running' && anyActive) {
            run.state = 'running'
            await this.#save(run)
          }
          if (failed) {
            for (const name of run.jobs) if (name !== failed) await this.k8s.deleteJob(name).catch(() => {})
            await this.#finish(run, 'failed', 1, `${run.phase} Job ${failed} failed`)
            return
          }
          if (allDone) {
            await this.#advance(run)
            return
          }
        } catch (e) {
          await this.#append(run.id, `[worldeditor] watch: ${e.message}\n`)
        }
        await sleep(3000)
      }
    }
    void tick()
  }

  async #advance(run) {
    if (run.phase === 'plan') run.phase = 'shard'
    else if (run.phase === 'shard') run.phase = 'finalize'
    else {
      await this.#finish(run, 'done', 0, null)
      return
    }
    await this.#save(run)
    await this.#startPhase(run)
  }

  /**
   * Stream one shard Job's pod log, with a per-pod position.
   *
   * The single-Job follower keeps one `lastStamp` on the run because there is one pod. A shard
   * phase has N pods writing the same log file, so the reconnect cursor has to be per pod or a
   * reconnect on one shard would either replay or skip another shard's lines.
   */
  async #followPhasePod(run, pod) {
    const key = `${run.id}:${pod}`
    this.following.set(key, run)
    try {
      let savedAt = Date.now()
      for (;;) {
        if (!this.live.has(run.id)) return
        const since = (run.stamps ?? {})[pod] ?? null
        const res = await this.k8s.logStream(pod, { follow: true, sinceTime: since })
        if (res.statusCode >= 400) {
          res.resume()
          await sleep(2000)
          if (run.state === 'done' || run.state === 'failed') return
          continue
        }
        const sink = createWriteStream(this.store.logFile(run.id), { flags: 'a' })
        let carry = ''
        await new Promise((resolve) => {
          res.on('data', (chunk) => {
            carry += chunk.toString('utf8')
            const lines = carry.split('\n')
            carry = lines.pop() ?? ''
            let out = ''
            for (const line of lines) {
              const sp = line.indexOf(' ')
              const stamp = sp > 0 ? line.slice(0, sp) : null
              const text = sp > 0 ? line.slice(sp + 1) : line
              const last = (run.stamps ?? {})[pod] ?? null
              if (stamp && last && stamp <= last) continue
              if (stamp) { run.stamps ??= {}; run.stamps[pod] = stamp }
              out += `${text}\n`
            }
            if (out) sink.write(out)
            if (out && Date.now() - savedAt >= SAVE_EVERY_MS) {
              savedAt = Date.now()
              void this.#save(run).catch(() => {})
            }
          })
          res.on('end', resolve)
          res.on('error', resolve)
        })
        sink.end()
        await this.#save(run)
        if (run.state === 'done' || run.state === 'failed') return
        await sleep(1500)
      }
    } finally {
      this.following.delete(key)
    }
  }

  /** Poll the Job, attach to its pod's log, and stop when it ends. One of these per live run. */
  #watchJob(run) {
    let stopped = false
    const stop = () => {
      stopped = true
    }
    this.live.set(run.id, { stop })
    const tick = async () => {
      while (!stopped) {
        try {
          const job = await this.k8s.getJob(run.job)
          const s = job.status ?? {}
          if (!run.pod) {
            const pods = await this.k8s.podsFor(run.job)
            const pod = pods.find((p) => p.status?.phase !== 'Pending') ?? pods[0]
            if (pod) {
              run.pod = pod.metadata.name
              await this.#save(run)
              this.#followPod(run).catch((e) => void this.#append(run.id, `\n[worldeditor] log follow stopped: ${e.message}\n`))
            }
          }
          const running = s.active ?? 0
          if (run.state !== 'running' && running) {
            run.state = 'running'
            await this.#save(run)
          }
          if (s.succeeded) {
            await this.#finish(run, 'done', 0, null)
            return
          }
          if (s.failed) {
            const cond = (s.conditions ?? []).find((c) => c.type === 'Failed')
            await this.#finish(run, 'failed', 1, cond?.message ?? 'the Job reported a failure')
            return
          }
        } catch (e) {
          // A transient API error must not kill the watch; a persistent one shows in the log.
          await this.#append(run.id, `[worldeditor] watch: ${e.message}\n`)
        }
        await sleep(3000)
      }
    }
    void tick()
  }

  /**
   * Stream the pod's log into the run's log file, reconnecting where it left off.
   *
   * A `follow` connection through the API server ends on its own over a long bake (idle timeouts,
   * an apiserver rollout). `timestamps=true` plus `sinceTime` makes the reconnect exact: every
   * line carries an RFC3339 stamp, the last one seen is remembered on the run record, and lines
   * at or before it on reconnect are dropped. Without that, a reconnect either loses the lines
   * written during the gap or repeats the last minute of them.
   *
   * THE STAMP IS SAVED AS IT MOVES, not only when a stream ends. It used to be written only at the
   * end of a stream, and a bake's stream does not end until the bake does. So when this pod was
   * replaced mid-bake (a deploy, 2026-09-30), the record said `lastStamp: null`, the new pod
   * adopted the run and resumed from the very beginning, and the whole log was appended a second
   * time (Rich: "It looks like it ran twice"). Saved at most every SAVE_EVERY_MS, and on SIGTERM
   * by flush().
   */
  async #followPod(run) {
    this.following.set(run.id, run)
    try {
      await this.#followPodLoop(run)
    } finally {
      this.following.delete(run.id)
    }
  }

  async #followPodLoop(run) {
    let savedAt = Date.now()
    for (;;) {
      if (!this.live.has(run.id)) return
      const res = await this.k8s.logStream(run.pod, { follow: true, sinceTime: run.lastStamp })
      if (res.statusCode >= 400) {
        // ContainerCreating answers 400 until there is something to read
        res.resume()
        await sleep(2000)
        if (run.state === 'done' || run.state === 'failed') return
        continue
      }
      const sink = createWriteStream(this.store.logFile(run.id), { flags: 'a' })
      let carry = ''
      await new Promise((resolve) => {
        res.on('data', (chunk) => {
          carry += chunk.toString('utf8')
          const lines = carry.split('\n')
          carry = lines.pop() ?? ''
          let out = ''
          for (const line of lines) {
            const sp = line.indexOf(' ')
            const stamp = sp > 0 ? line.slice(0, sp) : null
            const text = sp > 0 ? line.slice(sp + 1) : line
            if (stamp && run.lastStamp && stamp <= run.lastStamp) continue
            if (stamp) run.lastStamp = stamp
            out += `${text}\n`
          }
          if (out) sink.write(out)
          if (out && Date.now() - savedAt >= SAVE_EVERY_MS) {
            savedAt = Date.now()
            void this.#save(run).catch(() => {})
          }
        })
        res.on('end', resolve)
        res.on('error', resolve)
      })
      sink.end()
      await this.#save(run)
      if (run.state === 'done' || run.state === 'failed') return
      await sleep(1500)
    }
  }

  /* ---- the laptop runner ---------------------------------------------------------------------- */

  /**
   * The same run as a subprocess, so the whole path — define a world, bake it, watch the log,
   * see the site appear — can be exercised with no cluster at all. That is not a convenience: it
   * is how the probe proves the mechanism without spending an hour of USGS bandwidth.
   */
  async #startLocal(run) {
    const sink = createWriteStream(this.store.logFile(run.id), { flags: 'a' })
    const overpass = await this.#overpassFor(run.slug)
    const env = {
      ...process.env,
      CORRIDOR_DATA: this.store.root,
      CORRIDOR_SITES: `${this.store.root}/sites.json`,
      // same rule as the cluster Job: a bake from this editor is a pyramid, on a laptop too
      CORRIDOR_PYRAMID: '1',
      PYTHONUNBUFFERED: '1',
      ...(overpass ? { CORRIDOR_OVERPASS_URL: overpass } : {}),
      ...(this.cfg.bucket
        ? {
            CORRIDOR_S3_BUCKET: this.cfg.bucket,
            CORRIDOR_S3_ENDPOINT: this.cfg.endpoint ?? '',
            CORRIDOR_S3_REGION: this.cfg.region ?? 'auto',
            CORRIDOR_S3_PREFIX: this.cfg.prefix ?? 'corridor',
          }
        : {}),
    }
    const child = spawn(this.cfg.python, ['-m', 'corridor', ...run.args], { cwd: this.cfg.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    // EVERY HANDLER BEFORE THE FIRST await. `spawn` reports a missing interpreter by emitting
    // 'error' on the next tick, and an unhandled 'error' on a ChildProcess throws — so an `await`
    // between the spawn and the handler takes the whole SERVICE down when the python path is
    // wrong. It did: `ENOENT .venv/bin/python` killed the pod rather than failing one run.
    child.on('error', (e) => {
      sink.end()
      void this.#finish(run, 'failed', -1, `could not start ${this.cfg.python}: ${e.message ?? e}`)
    })
    /*
     * THE SIGNAL IS THE ONLY THING THAT SAYS WHAT HAPPENED, and this used to throw it away.
     *
     * Node calls `close(code, signal)`: a process that was KILLED has a null code and a signal,
     * and reporting that as "exited null" tells a person nothing at all. Rich's t-section bake
     * died after twelve minutes and said exactly that; it had been SIGKILLed, and this box's
     * cgroup reported 46 OOM kills (measured: one 213 MiB LAZ tile peaks at 2.44 GB, and there
     * were 3 GB free).
     *
     * SIGKILL is named as out of memory because that is what sends it here — a cancel sends
     * SIGTERM, and nothing else signals a bake. The reasoning stays in this comment; the line a
     * person reads says the thing and stops.
     */
    child.on('close', (code, signal) => {
      sink.end()
      const why = signal === 'SIGKILL'
        ? 'killed — out of memory'
        : signal === 'SIGTERM'
          ? 'stopped'
          : signal
            ? `killed by ${signal}`
            : `exited ${code}`
      void this.#finish(run, code === 0 ? 'done' : 'failed', code, code === 0 ? null : why)
    })
    child.stdout.pipe(sink, { end: false })
    child.stderr.pipe(sink, { end: false })
    this.live.set(run.id, { stop: () => child.kill('SIGTERM') })
    run.state = 'running'
    run.pod = `pid ${child.pid}`
    await this.#save(run)
  }

  /* ---- ending ---------------------------------------------------------------------------------- */

  /**
   * IDEMPOTENT — THE FIRST FINISH WINS — and it is keyed on the ID, not on the object.
   *
   * A cancel signals the child and records `failed — cancelled`. The child's own `close` handler
   * then fires with a null exit code and wrote `failed — exited null` OVER it, so the API answered
   * "cancelled" from the object that call returned while the FILE on the volume said something
   * else, and the reason a run stopped was lost the moment anybody reloaded.
   *
   * Guarding on `run.state` alone does NOT fix that, which is the part worth remembering: `cancel`
   * re-reads the record off the volume, so it holds a DIFFERENT object from the one the child's
   * handler closed over, and both of them pass a check on their own `state`. The set below is the
   * fix — it is keyed on the run id and set synchronously, before the first await, so the second
   * finisher is turned away whichever object it is carrying.
   */
  async #finish(run, state, exit, detail) {
    this.live.get(run.id)?.stop?.()
    this.live.delete(run.id)
    if (this.done.has(run.id)) return this.store.readJson(this.store.runFile(run.id))
    this.done.add(run.id)
    run.state = state
    run.exit = exit
    run.detail = detail
    run.finished = now()
    await this.#append(run.id, `\n=== ${state} ${run.finished}${detail ? ` — ${detail}` : ''}\n`)
    if (state === 'done' && run.kind === 'bake') {
      // the site now exists: give it the world's look (see store.applyLook)
      try {
        const world = await this.store.getWorld(run.slug)
        if (world) await this.store.applyLook(world)
      } catch (e) {
        await this.#append(run.id, `(look not applied: ${e.message ?? e})\n`)
      }
    }
    // Returns the run: `cancel` hands this straight back to the caller, and without the return it
    // answered `{run: undefined}` with a 200 — a cancel that worked and reported nothing.
    return this.#save(run)
  }

  /** Stop a run: delete the Job (pods go with it) or signal the child. */
  async cancel(id) {
    const run = await this.store.readJson(this.store.runFile(id))
    if (!run) throw Object.assign(new Error(`no run ${id}`), { status: 404 })
    if (run.state === 'done' || run.state === 'failed') return run
    this.live.get(id)?.stop?.()
    this.live.delete(id)
    for (const name of run.jobs?.length ? run.jobs : run.job ? [run.job] : []) {
      if (this.k8s.available) await this.k8s.deleteJob(name).catch(() => {})
    }
    return this.#finish(run, 'failed', -1, 'cancelled')
  }

  /**
   * Adopt runs that were live when this pod last stopped.
   *
   * Without this a restart during a bake leaves a run stuck at "running" for ever while the Job
   * carries happily on — the work is fine and only the watcher died. Called once at start-up.
   */
  async reconcile() {
    const adopted = []
    for (const run of await this.store.listRuns(200)) {
      if (run.state === 'done' || run.state === 'failed') continue
      const names = run.jobs?.length ? run.jobs : run.job ? [run.job] : []
      if (run.runner === 'kubernetes' && names.length && this.k8s.available) {
        const jobs = await Promise.all(names.map((n) => this.k8s.getJob(n).catch(() => null)))
        if (jobs.every((j) => !j)) {
          await this.#finish(run, 'failed', -1, 'the Job is gone — the pod restarted and it had already been cleaned up')
          continue
        }
        run.pod = null // re-attach to whatever pod is there now
        run.followed = {}
        if (run.sharded) this.#watchPhase(run)
        else this.#watchJob(run)
        adopted.push(run.id)
      } else {
        // a local child cannot outlive its parent
        await this.#finish(run, 'failed', -1, 'the service restarted while this was running')
      }
    }
    return adopted
  }

  /** Bytes of a run's log from `offset`. The browser's entire streaming protocol. */
  async log(id, offset = 0, limit = 256 * 1024) {
    const file = this.store.logFile(id)
    const size = await stat(file).then((s) => s.size).catch(() => -1)
    if (size < 0) throw Object.assign(new Error(`no log for ${id}`), { status: 404 })
    // A truncated or replaced file (a rebake reusing an id) must not hand back a slice of nothing.
    const from = offset > size ? 0 : offset
    const fh = await open(file, 'r')
    try {
      const want = Math.min(limit, size - from)
      const buf = Buffer.alloc(Math.max(0, want))
      if (want > 0) await fh.read(buf, 0, want, from)
      return { text: buf.toString('utf8'), offset: from + Math.max(0, want), size, truncated: size - from > want }
    } finally {
      await fh.close()
    }
  }

  get(id) {
    return this.store.readJson(this.store.runFile(id))
  }

  list(limit) {
    return this.store.listRuns(limit)
  }

  /**
   * Drop a finished run's record and its log.
   *
   * A run that is still going is refused: deleting the file out from under a Job leaves the bake
   * running and the list unable to say so. Cancel it first; this only removes history.
   */
  async remove(id) {
    const run = await this.get(id)
    if (!run) throw Object.assign(new Error(`no run ${id}`), { status: 404 })
    if (run.state !== 'done' && run.state !== 'failed') {
      throw Object.assign(new Error(`${run.label} is still ${run.state}`), { status: 409 })
    }
    this.live.delete(id)
    this.done.delete(id)
    this.following.delete(id)
    this.finishedHooks.delete(id)
    await rm(this.store.runFile(id), { force: true })
    await rm(this.store.logFile(id), { force: true })
    return { deleted: id }
  }

  /**
   * Every finished run. Ones that are still going stay, so clearing the list cannot stop a bake.
   */
  async clearFinished() {
    const all = await this.store.listRuns(1_000_000)
    const deleted = []
    const kept = []
    for (const run of all) {
      if (run.state === 'done' || run.state === 'failed') {
        await this.remove(run.id)
        deleted.push(run.id)
      } else kept.push(run.id)
    }
    return { deleted: deleted.length, kept: kept.length }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const short = (s) => String(s).replace(/[^a-z0-9-]/g, '').slice(0, 24)
