// A splat training run, as the platform's own object where it can be, and as a plain JobSet where
// it cannot.
//
// Rich, 2026-09-27: "It would be great if we could use the trainingdeployment type as an optional
// (but featured) wrapper for jobset when running splat training jobs."
//
// FEATURED, AND OPTIONAL, ARE BOTH LOAD-BEARING. `TrainingDeployment` is what the platform is for
// — you declare nodes, GPUs per node and where the data is, and the operator brings up the JobSet,
// the volume, the rendezvous and the metrics scraping. That is worth showing off. But this editor
// also has to run on a cluster that does not have the CRD, so the same run description compiles to
// a bare JobSet as well, and the only difference a person sees is which one the badge says.
//
// WHAT WAS LEARNED FROM red-hail, the axolotl fine-tune already on this cluster:
//
//   * `runtime` is documented in the CRD as "for logging only, not for dispatch". So a splat run
//     sets `runtime: gaussworks` for the console and dispatches on `image` + `command`, with none
//     of axolotl's configuration anywhere near it.
//   * `paths` is the good part. Each entry is a place data comes from or goes to, and the
//     operator exposes them as ${PAI_PATH_0}, ${PAI_PATH_1}... in order. An entry with no `uri`
//     and `rw: true` is an output directory on the deployment's own volume.
//   * `pvcMounts` mounts an ARBITRARY PVC. That is how the footage gets in: the editor's volume,
//     where the chapters were uploaded, mounted read-only at /data.
//   * `resources: { nodes, gpusPerNode }` is the multi-node knob, and `nccl`/`rdma`/
//     `rendezvousPort` are there for distributed training without hand-writing any of it.
//   * The status to watch is `completionState` plus conditions StorageReady, ConfigMapsReady,
//     PodsSchedulable, JobSetsReady, Ready. It creates a JobSet named `<name>-<model>-<hash>`,
//     which is where the pods and therefore the logs are.
//
// WHAT THIS FILE DOES NOT DECIDE. The command inside the container is the splats lane's, not
// mine: `ext/gaussworks` is theirs and I have asked them for an entrypoint rather than guessing at
// one (mail 011). Everything here is configuration, so their answer is a value and not a change.

// The operator's API group, and the version it serves TODAY. `v1` was a guess and the API server
// refused it outright -- `no matches for kind "TrainingDeployment" in version ".../v1"` -- which a
// server-side dry run said in one second and reading the CRD name would never have said at all.
// `apiVersionFor` asks the cluster, so this survives v1alpha1 becoming v1.
const GROUP = 'richard-siomporas.patapsco.ai'
const FALLBACK_VERSION = 'v1alpha1'

/** The group version this cluster serves, discovered once. */
export async function apiVersionFor(k8s) {
  try {
    const groups = await k8s.raw('GET', '/apis')
    const g = (groups?.groups ?? []).find((x) => x.name === GROUP)
    return g?.preferredVersion?.groupVersion ?? `${GROUP}/${FALLBACK_VERSION}`
  } catch {
    return `${GROUP}/${FALLBACK_VERSION}`
  }
}

/** What a splat run needs to know. Everything has a default that is honest about being one. */
export function normalise(run = {}) {
  const capture = run.capture ?? run.id
  if (!capture) throw Object.assign(new Error('a splat run needs a capture'), { status: 400 })
  return {
    capture,
    name: run.name ?? `splat-${capture}`.slice(0, 52).replace(/[^a-z0-9-]/g, '-'),
    world: run.world ?? null,
    nodes: Math.max(1, Number(run.nodes ?? 1)),
    gpusPerNode: Math.max(1, Number(run.gpusPerNode ?? 1)),
    image: run.image ?? process.env.WORLDEDITOR_SPLAT_IMAGE ?? 'ghcr.io/hotspoons/gaussworks:latest',
    /*
     * THE ENTRYPOINT, answered by the splats lane (gaussworks 5071e04):
     *
     *     splatpipe run --capture <dir> --out <dir> --role leader|worker
     *
     * Two roles because the pipeline has two shapes. The LEADER ingests, masks and chunks — serial,
     * once, and the only role that reads the video — then merges and writes the LOD levels at the
     * end. A WORKER poses and trains, claiming chunks from a queue.
     *
     * THE WORKER COUNT IS NOT A FUNCTION OF THE FOOTAGE. It is a function of free GPUs: a worker
     * that finds an empty queue finishes, and one that starts before the chunks exist waits. So
     * over-provisioning costs an idle pod rather than a wrong answer, which is exactly the
     * property that makes this safe to hand to a scheduler. The leader works the queue too once
     * it has chunked, so a one-pod run is still the whole pipeline.
     */
    command: run.command ?? (process.env.WORLDEDITOR_SPLAT_COMMAND ? JSON.parse(process.env.WORLDEDITOR_SPLAT_COMMAND) : ['splatpipe']),
    args: run.args ?? (process.env.WORLDEDITOR_SPLAT_ARGS ? JSON.parse(process.env.WORLDEDITOR_SPLAT_ARGS) : null),
    /** extra workers beside the leader. 0 is a complete run on one pod. */
    workers: Math.max(0, Number(run.workers ?? 0)),
    config: run.config ?? null,
    claim: run.claim ?? process.env.WORLDEDITOR_CLAIM ?? 'worldeditor-data',
    storageClass: run.storageClass ?? process.env.WORLDEDITOR_SPLAT_STORAGE_CLASS ?? 'ceph-filesystem',
    outputSize: run.outputSize ?? process.env.WORLDEDITOR_SPLAT_OUTPUT_SIZE ?? '500Gi',
    gpuResource: run.gpuResource ?? process.env.WORLDEDITOR_GPU_RESOURCE ?? 'nvidia.com/gpu',
    // extra container limits (memory, cpu) as a plain map; the GPU count is `gpusPerNode`
    limits: run.limits ?? null,
    /** the RWX claim the pods share as /out; the CRD provisions its own, a bare JobSet does not */
    outClaim: run.outClaim ?? null,
    ttlSeconds: Number(run.ttlSeconds ?? process.env.WORLDEDITOR_SPLAT_TTL ?? 604800),
  }
}

/**
 * `splatpipe run --capture ... --out ... --role <role>`, plus the site when there is one.
 *
 * `--site` is what levelling against `lidar/dtm.tif` needs, and it is load-bearing: with it, the
 * capture is put on the ground (Arrowhead went from floating 5.33 m to a median camera height of
 * 2.32 m against a measured rig height of 2.32 m). Without it the world is internally consistent
 * and absolutely unverified, and gaussworks says so in `world.json`.
 */
export function roleArgs(r, role) {
  if (r.args) return r.args
  const a = ['run', '--capture', `${EDITOR_MOUNT}/captures/${r.capture}`, '--out', '/out', '--role', role]
  if (r.world) a.push('--site', `${EDITOR_MOUNT}/sites/${r.world}`)
  if (r.config) a.push('--config', r.config)
  return a
}

/*
 * WHERE THE EDITOR'S VOLUME IS MOUNTED, AND WHY NOT `/data`.
 *
 * The operator mounts its OWN volume at /data — that is where `paths` are materialised — so a
 * pvcMount there collides, and the failure does not arrive at admission. The API server validates
 * the TrainingDeployment; the JobSet is derived from it afterwards and is what is invalid:
 *
 *   JobSet ... is invalid: volumeMounts[2]: Duplicate value: {"mountPath":"/data"}
 *
 * A server-side dry run of the TrainingDeployment says nothing about this, which is the argument
 * for actually submitting one once.
 */
const EDITOR_MOUNT = '/editor'

/** The environment a gaussworks container gets, whichever object started it. */
function env(r) {
  return [
    { name: 'CAPTURE_ID', value: r.capture },
    { name: 'CAPTURE_DIR', value: `${EDITOR_MOUNT}/captures/${r.capture}` },
    { name: 'CAPTURE_MANIFEST', value: `${EDITOR_MOUNT}/captures/${r.capture}/capture.json` },
    { name: 'WORLD_SLUG', value: r.world ?? '' },
    { name: 'SITE_DIR', value: r.world ? `${EDITOR_MOUNT}/sites/${r.world}` : '' },
    { name: 'OUT_DIR', value: '/out' },
    { name: 'SPLAT_NODES', value: String(r.nodes) },
    { name: 'SPLAT_GPUS_PER_NODE', value: String(r.gpusPerNode) },
  ]
}

/**
 * The platform's object: a TrainingDeployment that wraps a JobSet.
 *
 * `paths[0]` is the output, with no `uri` and `rw: true`, which the operator turns into a
 * writable directory on the deployment's own volume and exposes as ${PAI_PATH_0}. The footage
 * arrives the other way, through `pvcMounts`, because it was uploaded to the editor's volume
 * before this object existed.
 */
export function trainingDeployment(run, apiVersion = `${GROUP}/${FALLBACK_VERSION}`) {
  const r = normalise(run)
  return {
    apiVersion,
    kind: 'TrainingDeployment',
    metadata: {
      name: r.name,
      labels: { 'app.kubernetes.io/managed-by': 'worldeditor', 'corridor.capture': r.capture, ...(r.world ? { 'corridor.world': r.world } : {}) },
    },
    spec: {
      volumeType: 'pvc',
      volumeTag: `${r.name}-volume`,
      dataPvcSpec: {
        accessModes: ['ReadWriteMany'],
        ephemeral: false,
        size: r.outputSize,
        storageClassName: r.storageClass,
      },
      enableObservabilityScraping: true,
      // the JobSet the operator builds. Empty means "as the platform sees fit", which is the
      // whole point of using this instead of writing one.
      jobsetConfig: {},
      training: {
        paths: [{ mountPath: '/out', rw: true, tags: ['splats'] }],
        topologyConfig: {},
        config: {
          runtimeConfig: {
            runtime: 'gaussworks',
            image: r.image,
            command: r.command,
            // the CRD carries a leader/worker split of its own, which is exactly the shape
            // splatpipe has. `nodes` is 1 + workers; rank 0 leads.
            ...(r.workers > 0
              ? { leaderCommand: r.command, leaderArgs: roleArgs(r, 'leader'), workerCommand: r.command, workerArgs: roleArgs(r, 'worker') }
              : { args: roleArgs(r, 'leader') }),
            /*
             * `gpusPerNode` IS THE GPU REQUEST. The operator turns it into the container's
             * resource limits itself, and `limits` here is a wrapped ResourceList -- `{ items:
             * {...} }`, not a bare map. Writing the bare map was refused outright by the API
             * server (`unknown field ...resources.limits.nvidia.com/gpu`), which is a better
             * error than most and took one dry run to find. Anything else the run needs -- memory,
             * cpu -- goes through `limits.items`.
             */
            resources: {
              nodes: r.workers > 0 ? r.workers + 1 : r.nodes,
              gpusPerNode: r.gpusPerNode,
              ...(r.limits ? { limits: { items: r.limits } } : {}),
            },
            // the footage, read-only: it was uploaded here and nothing in training should edit it
            pvcMounts: [{ name: 'editor-data', claimName: r.claim, path: EDITOR_MOUNT, readOnly: true }],
            envVars: { items: env(r) },
            // multi-node rendezvous, which is most of why this object is worth using
            ...(r.nodes > 1 ? { nccl: {}, rendezvousPort: 29500 } : {}),
          },
        },
      },
    },
  }
}

/**
 * The same run as a bare JobSet, for a cluster without the CRD.
 *
 * One replicated job, `nodes` parallel, with the same environment and the same mounts — so a run
 * is the same run and only the object around it differs.
 */
export function jobSet(run) {
  const r = normalise(run)
  const container = (role) => ({
    name: 'gaussworks',
    image: r.image,
    command: r.command,
    args: roleArgs(r, role),
    env: [...env(r), { name: 'PAI_PATH_0', value: '/out' }, { name: 'SPLAT_ROLE', value: role }],
    resources: { limits: { [r.gpuResource]: String(r.gpusPerNode), ...(r.limits ?? {}) } },
    volumeMounts: [
      { name: 'editor-data', mountPath: EDITOR_MOUNT, readOnly: true },
      { name: 'out', mountPath: '/out' },
    ],
  })
  /*
   * THE OUTPUT VOLUME IS SHARED, and that is the whole reason this is not N independent Jobs.
   * The leader chunks, the workers claim chunks and write trained ones back, and the leader
   * merges what they wrote. A per-pod emptyDir would give every pod its own empty /out and the
   * merge would find nothing — so it is an RWX claim, which on this cluster means
   * ceph-filesystem. Without the CRD nobody provisions one for us, so it is named and expected.
   */
  const outClaim = r.outClaim ?? `${r.name}-out`
  const job = (name, role, replicas, parallelism) => ({
    name,
    replicas,
    template: {
      spec: {
        parallelism,
        completions: parallelism,
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [container(role)],
            volumes: [
              { name: 'editor-data', persistentVolumeClaim: { claimName: r.claim, readOnly: true } },
              { name: 'out', persistentVolumeClaim: { claimName: outClaim } },
            ],
          },
        },
      },
    },
  })
  return {
    apiVersion: 'jobset.x-k8s.io/v1alpha2',
    kind: 'JobSet',
    metadata: {
      name: r.name,
      labels: { 'app.kubernetes.io/managed-by': 'worldeditor', 'corridor.capture': r.capture, ...(r.world ? { 'corridor.world': r.world } : {}) },
    },
    spec: {
      ttlSecondsAfterFinished: r.ttlSeconds,
      // one failed pod fails the run: a half-trained splat world is worse than none, and the log
      // is what a person needs, not a retry that overwrites it
      failurePolicy: { maxRestarts: 0 },
      // a worker that finds an empty queue finishes and a worker that starts early waits, so the
      // two jobs need no ordering between them
      replicatedJobs: r.workers > 0 ? [job('leader', 'leader', 1, 1), job('worker', 'worker', 1, r.workers)] : [job('leader', 'leader', 1, 1)],
    },
  }
}

/**
 * Which object this cluster can run, preferring the platform's.
 *
 * Returns `{ via, kind, available }`. `via: 'training'` is the featured path; `via: 'jobset'` is
 * the fallback; `via: 'none'` says plainly that neither CRD is installed, which is a thing to show
 * a person rather than a stack trace.
 */
export async function plan(k8s, { namespace = 'default' } = {}) {
  const has = async (path) => {
    if (!k8s?.usable?.()) return false
    try {
      await k8s.raw('GET', path)
      return true
    } catch {
      return false
    }
  }
  const gv = await apiVersionFor(k8s)
  const training = await has(`/apis/${gv}/namespaces/${namespace}/trainingdeployments?limit=1`)
  if (training) return { via: 'training', kind: 'TrainingDeployment', available: true, featured: true, apiVersion: gv }
  const js = await has(`/apis/jobset.x-k8s.io/v1alpha2/namespaces/${namespace}/jobsets?limit=1`)
  if (js) return { via: 'jobset', kind: 'JobSet', available: true, featured: false, why: 'no TrainingDeployment CRD on this cluster' }
  return { via: 'none', kind: null, available: false, why: 'neither TrainingDeployment nor JobSet is installed' }
}

/** Build whichever this cluster can run. `force` overrides, for showing the difference. */
export async function manifestFor(run, k8s, { namespace = 'default', force = null } = {}) {
  const p = force ? { via: force, kind: force === 'training' ? 'TrainingDeployment' : 'JobSet', available: true } : await plan(k8s, { namespace })
  if (!p.available) throw Object.assign(new Error(p.why), { status: 501 })
  const gv = p.apiVersion ?? (await apiVersionFor(k8s))
  return { ...p, manifest: p.via === 'training' ? trainingDeployment(run, gv) : jobSet(run) }
}

/**
 * One shape for "how is it going", whichever object is underneath.
 *
 * A TrainingDeployment says `completionState` and carries five conditions; a JobSet says
 * `terminalState` and carries its own. The editor should not have to know which it is looking at.
 */
export function readStatus(obj) {
  if (!obj) return { state: 'unknown' }
  if (obj.kind === 'TrainingDeployment') {
    const conds = obj.status?.conditions ?? []
    const cond = (t) => conds.find((c) => c.type === t)
    const done = obj.status?.completionState
    return {
      state: done === 'Failed' ? 'failed' : done === 'Succeeded' || done === 'Completed' ? 'done' : obj.status?.phase === 'Ready' ? 'running' : 'starting',
      phase: obj.status?.phase ?? null,
      completion: done ?? null,
      message: obj.status?.message ?? null,
      // named so a person can see WHICH part is not ready, which is the whole value of conditions
      steps: ['StorageReady', 'ConfigMapsReady', 'PodsSchedulable', 'JobSetsReady', 'Ready'].map((t) => ({ step: t, ok: cond(t)?.status === 'True', why: cond(t)?.message ?? null })),
      via: 'training',
    }
  }
  const term = obj.status?.terminalState
  return {
    state: term === 'Failed' ? 'failed' : term === 'Completed' ? 'done' : 'running',
    completion: term ?? null,
    message: null,
    steps: [],
    via: 'jobset',
  }
}

/*
 * ------------------------------------------------------------------------------------------------
 * ACTUALLY CREATING ONE.
 *
 * Everything above this line builds a manifest and shows it. Nothing submitted it, so the panel's
 * buttons said "Show what would run" and the toast said "not yet created" — an honest label on a
 * feature that did not exist. This is the half that does.
 *
 * The splats lane's handoff decided the shape, and two of its points are load-bearing here:
 *
 *   THE WORKER COUNT IS SET FROM FREE GPUS, ASKED OF THE SCHEDULER. Not from the footage, and
 *   never by grepping pod names — "I got this wrong; Rich was right". A worker that finds an empty
 *   queue exits and one that starts early waits, so over-provisioning costs an idle pod rather
 *   than a wrong answer. That is the property that makes this safe to schedule at all.
 *
 *   A JOB RUNNING STALE CODE DOES NOT FAIL. `/workspace/gaussworks` on the PVC is a copy with no
 *   `.git`, the CUDA images ship no `git`, so a pull fails silently and the job "succeeds" with a
 *   plausible wrong number. `assert-code.sh <sha>` goes FIRST in every job. The editor records the
 *   sha it asked for so a result can be traced to code.
 */

/** Free GPUs, by asking the scheduler: allocatable minus what Running and Pending pods request. */
export async function freeGpus(k8s, { resource = 'nvidia.com/gpu' } = {}) {
  if (!k8s?.usable?.()) return { free: 0, total: 0, why: 'not running in a cluster' }
  const num = (v) => (v == null ? 0 : Number(String(v).replace(/[^0-9.]/g, '')) || 0)
  const nodes = await k8s.raw('GET', '/api/v1/nodes')
  const total = (nodes.items ?? []).reduce((n, node) => n + num(node.status?.allocatable?.[resource]), 0)
  // EVERY namespace: a GPU held by flux or recon is not free just because it is not ours.
  const pods = await k8s.raw('GET', '/api/v1/pods?fieldSelector=status.phase!=Succeeded,status.phase!=Failed')
  let used = 0
  for (const p of pods.items ?? []) {
    for (const c of [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])]) {
      used += num(c.resources?.limits?.[resource] ?? c.resources?.requests?.[resource])
    }
  }
  return { free: Math.max(0, total - used), total, used }
}

/** Where a run's object lives, whichever kind it is. */
function pathFor(via, apiVersion, namespace, name = '') {
  const base = via === 'training'
    ? `/apis/${apiVersion}/namespaces/${namespace}/trainingdeployments`
    : `/apis/jobset.x-k8s.io/v1alpha2/namespaces/${namespace}/jobsets`
  return name ? `${base}/${encodeURIComponent(name)}` : base
}

/**
 * Submit a run.
 *
 * `dryRun` uses the API server's own validation rather than ours — worth having, and worth knowing
 * its limit: a server-side dry run of a TrainingDeployment says nothing about the JobSet derived
 * from it afterwards, which is where the /data mount collision surfaced. It catches shape errors,
 * not consequences.
 */
export async function createRun(run, k8s, { namespace = 'default', force = null, dryRun = false } = {}) {
  const r = normalise(run)
  const { via, kind, manifest, apiVersion } = await manifestFor(r, k8s, { namespace, force })
  const gv = apiVersion ?? (await apiVersionFor(k8s))
  const path = pathFor(via, gv, namespace) + (dryRun ? '?dryRun=All' : '')
  const created = await k8s.raw('POST', path, { body: manifest })
  return {
    name: created?.metadata?.name ?? manifest.metadata.name,
    kind, via, namespace, dryRun,
    capture: r.capture,
    world: r.world,
    workers: r.workers,
    createdAt: created?.metadata?.creationTimestamp ?? new Date().toISOString(),
  }
}

/** One run's status, in the shape `readStatus` produces. */
export async function runStatus(name, k8s, { namespace = 'default' } = {}) {
  const p = await plan(k8s, { namespace })
  if (!p.available) return { state: 'unknown', why: p.why }
  const gv = p.apiVersion ?? (await apiVersionFor(k8s))
  const obj = await k8s.raw('GET', pathFor(p.via, gv, namespace, name)).catch(() => null)
  if (!obj) return { state: 'gone', name }
  return { name, ...readStatus({ kind: p.kind, ...obj }) }
}

/** Every run this editor started, newest first. */
export async function listRuns(k8s, { namespace = 'default' } = {}) {
  const p = await plan(k8s, { namespace })
  if (!p.available) return []
  const gv = p.apiVersion ?? (await apiVersionFor(k8s))
  const list = await k8s.raw('GET', pathFor(p.via, gv, namespace)).catch(() => ({ items: [] }))
  return (list.items ?? [])
    // `managed-by`, which is what the two builders above actually write. `created-by` was a
    // plausible guess that would have returned an empty list forever — a filter matching nothing
    // and an editor that has started nothing look exactly alike.
    .filter((o) => o.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'worldeditor')
    .map((o) => ({
      name: o.metadata.name,
      createdAt: o.metadata.creationTimestamp,
      capture: o.metadata?.labels?.['corridor.capture'] ?? null,
      world: o.metadata?.labels?.['corridor.world'] ?? null,
      ...readStatus({ kind: p.kind, ...o }),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Stop one. Background propagation so the pods go too — an orphan keeps the volume mounted. */
export async function deleteRun(name, k8s, { namespace = 'default' } = {}) {
  const p = await plan(k8s, { namespace })
  if (!p.available) throw Object.assign(new Error(p.why), { status: 501 })
  const gv = p.apiVersion ?? (await apiVersionFor(k8s))
  await k8s.raw('DELETE', `${pathFor(p.via, gv, namespace, name)}?propagationPolicy=Background`)
  return { deleted: name }
}
