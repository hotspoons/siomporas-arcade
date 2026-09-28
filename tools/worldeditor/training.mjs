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
    /*
     * THE BAKE CONFIG, settled by experiment by the splats lane: survey resolution with
     * `cell_m: 120`. Seven of eight seams matched to within 3 cm between that and high
     * resolution, and high resolution bought +0.7 dB of PSNR for 5.9x the bytes per square
     * metre — at world scale, the difference between shippable and not.
     */
    config: run.config ?? process.env.WORLDEDITOR_SPLAT_CONFIG ?? null,
    /*
     * THE COMMIT THIS RUN EXPECTS TO FIND ON THE VOLUME.
     *
     * `/workspace/gaussworks` on the PVC is a COPY with no `.git`, and the CUDA images ship no
     * `git`, so a pull fails silently and the job runs whatever was last left there. That does
     * not fail — it SUCCEEDS and hands back a plausible wrong number, which is strictly worse
     * than crashing. `scripts/assert-code.sh <sha>` runs before anything else and exits non-zero
     * on a mismatch; set this and it becomes an init container.
     *
     * Recorded on the object too, so a result can be traced to the code that produced it.
     */
    codeSha: run.codeSha ?? process.env.WORLDEDITOR_SPLAT_CODE_SHA ?? null,
    /*
     * THE SEAM THRESHOLD, in metres. Neighbouring chunks are levelled independently against their
     * own GPS priors, so they can disagree about the height of the same road — a step a driver
     * hits, and the reason splats appear to float. PSNR is nearly blind to it: two worlds over
     * identical ground differed by 0.7 dB and by 3.4 m of worst seam.
     *
     * Passed through to the pipeline, which is where the gate belongs — before training, because
     * the seam answer comes from `poses` and training is the expensive half.
     */
    seamFailOver: run.seamFailOver == null ? Number(process.env.WORLDEDITOR_SPLAT_SEAM_MAX ?? 3.0) : Number(run.seamFailOver),
    claim: run.claim ?? process.env.WORLDEDITOR_CLAIM ?? 'worldeditor-data',
    /*
     * NO DEFAULT STORAGE CLASS. `ceph-filesystem` was one cluster's name for it; on anybody
     * else's it does not exist and the PVC stays Pending forever with a message nobody reads.
     * Omitted, Kubernetes uses the cluster's own default StorageClass, which is the right answer
     * everywhere and is what a cluster admin has already decided.
     */
    storageClass: run.storageClass ?? process.env.WORLDEDITOR_SPLAT_STORAGE_CLASS ?? null,
    outputSize: run.outputSize ?? process.env.WORLDEDITOR_SPLAT_OUTPUT_SIZE ?? '500Gi',
    /* null means "discover it" — see `gpuResources`. NVIDIA is the common case, not the only one. */
    gpuResource: run.gpuResource ?? process.env.WORLDEDITOR_GPU_RESOURCE ?? null,
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
  /*
   * `--config` GOES BEFORE THE SUBCOMMAND, and that is not a style choice.
   *
   * It is declared on splatpipe's MAIN parser, not on `run`'s — so `splatpipe run --config x` is
   * "unrecognized arguments" and the job dies on its first line. It was written the other way
   * here and never fired, because the config defaulted to null; giving it an env default would
   * have armed it on every run.
   *
   * `--seam-fail-over` IS A REAL FLAG NOW (splats lane, f2fd0830). It was not when this was
   * written, and the note here said so; the gate has since been wired into `run` between poses
   * and train, which is where it earns its keep — the seam answer comes from poses and training
   * is the expensive half. A non-zero exit with the worst seam on stdout, and the verdict written
   * to `<chunks>/.seam-gate.json` for the workers to read.
   *
   * `none` disables it. Passing 0 or a negative would be ambiguous — "no bar" and "an impossible
   * bar" are opposite intentions — so anything non-positive is sent as the word.
   */
  const a = []
  if (r.config) a.push('--config', r.config)
  a.push('run', '--capture', `${EDITOR_MOUNT}/captures/${r.capture}`, '--out', '/out', '--role', role)
  if (r.world) a.push('--site', `${EDITOR_MOUNT}/sites/${r.world}`)
  a.push('--seam-fail-over', Number.isFinite(r.seamFailOver) && r.seamFailOver > 0 ? String(r.seamFailOver) : 'none')
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

/**
 * The guard that runs before anything else, when a commit was named.
 *
 * An init container rather than a `&&` in the command: a failed init container is a clear pod
 * status and a clear event, where a shell prefix is a line partway down a log that nobody reads
 * until the numbers look wrong.
 */
function assertCodeInit(r) {
  if (!r.codeSha) return []
  return [{
    name: 'assert-code',
    image: r.image,
    command: ['/workspace/gaussworks/scripts/assert-code.sh'],
    args: [r.codeSha],
    volumeMounts: [{ name: 'out', mountPath: '/out' }],
  }]
}

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
      // What this run was asked to accept and which code it expects. Annotations rather than
      // labels: both can exceed what a label value may hold, and neither is selected on.
      annotations: {
        'corridor.seam-fail-over': String(r.seamFailOver),
        ...(r.codeSha ? { 'corridor.code-sha': r.codeSha } : {}),
        ...(r.config ? { 'corridor.config': r.config } : {}),
      },
    },
    spec: {
      volumeType: 'pvc',
      volumeTag: `${r.name}-volume`,
      dataPvcSpec: {
        accessModes: ['ReadWriteMany'],
        ephemeral: false,
        size: r.outputSize,
        // OMITTED when unset, so the cluster's own default StorageClass applies. An explicit
        // null here is not the same thing: it asks for a PVC with no class at all.
        ...(r.storageClass ? { storageClassName: r.storageClass } : {}),
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
   * merge would find nothing — so it is an RWX claim. WHICH storage class provides RWX is the
   * cluster's business, not ours: no class is named, so the cluster's default applies. RWX itself
   * is not negotiable and is what preflight checks. Without the CRD nobody provisions this claim
   * for us, so it is named and expected to exist.
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
            ...(assertCodeInit(r).length ? { initContainers: assertCodeInit(r) } : {}),
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
      // What this run was asked to accept and which code it expects. Annotations rather than
      // labels: both can exceed what a label value may hold, and neither is selected on.
      annotations: {
        'corridor.seam-fail-over': String(r.seamFailOver),
        ...(r.codeSha ? { 'corridor.code-sha': r.codeSha } : {}),
        ...(r.config ? { 'corridor.config': r.config } : {}),
      },
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
 * The same run as plain batch Jobs, for a cluster with neither CRD.
 *
 * Rich, 2026-09-28: "targeting the training deployment crd from my platform if it exists with a
 * fallback to jobset, and finally raw batch jobs if neither crd is there."
 *
 * Every cluster has `batch/v1`, so this tier always works — which makes it the one that decides
 * whether this is a product or a demo of one platform.
 *
 * TWO JOBS, NOT ONE, and the ordering between them is still none. The leader job is a single pod;
 * the worker job is `parallelism: workers` pods that claim from the same queue. A JobSet would
 * manage the pair as a unit and clean them up together — that is what it is for, and it is why it
 * is preferred — so here the two carry a shared label and are started, watched and deleted as a
 * pair by name. The work itself is identical: the same image, the same args, the same shared
 * output claim.
 */
export function batchJobs(run) {
  const r = normalise(run)
  const js = jobSet(r)
  const outClaim = r.outClaim ?? `${r.name}-out`
  const common = {
    'app.kubernetes.io/managed-by': 'worldeditor',
    'corridor.capture': r.capture,
    // what ties the pair together in the absence of an object that owns both
    'corridor.run': r.name,
    ...(r.world ? { 'corridor.world': r.world } : {}),
  }
  const fromReplicated = (rj) => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: `${r.name}-${rj.name}`, labels: { ...common, 'corridor.role': rj.name } },
    spec: {
      ...rj.template.spec,
      ttlSecondsAfterFinished: r.ttlSeconds,
      template: {
        metadata: { labels: { ...common, 'corridor.role': rj.name } },
        spec: rj.template.spec.template.spec,
      },
    },
  })
  return {
    // A LIST, because there is no single object. The caller creates each and treats the set as
    // the run; `corridor.run` is how they are found again.
    kind: 'List',
    run: r.name,
    items: js.spec.replicatedJobs.map(fromReplicated),
    outClaim,
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
  /*
   * THE FLOOR. `batch/v1` is in every Kubernetes, so if this is not there nothing is, and the
   * honest answer is "not a cluster" rather than "no CRD". Reaching this tier is not a failure —
   * it is the same run, managed by hand instead of by an operator.
   */
  const batch = await has(`/apis/batch/v1/namespaces/${namespace}/jobs?limit=1`)
  if (batch) return { via: 'batch', kind: 'Job', available: true, featured: false, why: 'neither TrainingDeployment nor JobSet is installed; using plain Jobs' }
  return { via: 'none', kind: null, available: false, why: 'no batch/v1 — this does not look like a cluster' }
}

/**
 * Fill in what only the cluster can answer.
 *
 * `normalise` is synchronous and deliberately knows nothing about any particular cluster, so the
 * fields whose right value is a property of the cluster arrive null and are resolved here. The
 * fallback when discovery finds nothing is NVIDIA's name — not because it is the only one, but
 * because a manifest has to be previewable off-cluster and that is the likeliest guess. It is a
 * guess only when there is no cluster to ask.
 */
export async function resolve(run, k8s) {
  const r = normalise(run)
  if (!r.gpuResource) {
    const found = await gpuResources(k8s).catch(() => [])
    r.gpuResource = found[0] ?? 'nvidia.com/gpu'
    r.gpuResourceDiscovered = found.length > 0
  }
  return r
}

/** Build whichever this cluster can run. `force` overrides, for showing the difference. */
export async function manifestFor(run, k8s, { namespace = 'default', force = null } = {}) {
  const KINDS = { training: 'TrainingDeployment', jobset: 'JobSet', batch: 'Job' }
  const p = force ? { via: force, kind: KINDS[force] ?? 'JobSet', available: true } : await plan(k8s, { namespace })
  if (!p.available) throw Object.assign(new Error(p.why), { status: 501 })
  const gv = p.apiVersion ?? (await apiVersionFor(k8s))
  const r = await resolve(run, k8s)
  const manifest = p.via === 'training' ? trainingDeployment(r, gv)
    : p.via === 'batch' ? batchJobs(r)
    : jobSet(r)
  return { ...p, gpuResource: r.gpuResource, manifest }
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

/**
 * Which extended resource this cluster's GPUs are advertised as.
 *
 * NOT `nvidia.com/gpu` BY ASSUMPTION. That is the common one and it is not the only one: AMD
 * advertises `amd.com/gpu`, Intel `gpu.intel.com/i915`, Habana `habana.ai/gaudi`, and a cluster
 * can carry more than one at once. Hard-coding the NVIDIA name means this counts zero free GPUs
 * on somebody else's cluster and silently schedules a run with no accelerator — the failure being
 * a pod that starts, finds no device, and trains nothing.
 *
 * Discovered the same way the count is: by asking the nodes what they have. The pattern is
 * deliberately broad because the vendor prefix is the only stable part of these names.
 */
const GPU_RESOURCE = /(^|\/)(gpu|gaudi|i915|xe)s?$|gpu\.intel\.com|habana\.ai/i

export async function gpuResources(k8s) {
  if (!k8s?.usable?.()) return []
  /*
   * A REFUSAL IS NOT AN EMPTY CLUSTER.
   *
   * Listing nodes is cluster-scoped, and this pod's Role is namespaced by default — so without
   * the opt-in ClusterRole this 403s, and swallowing that reported "0 free of 0" on an
   * eight-GPU cluster. That is the silent-success failure this codebase keeps meeting: an
   * answer that is indistinguishable from a true one and is not. It throws now, and the caller
   * says it could not ask.
   */
  const nodes = await k8s.raw('GET', '/api/v1/nodes')
  const found = new Set()
  for (const node of nodes.items ?? []) {
    for (const [k, v] of Object.entries(node.status?.allocatable ?? {})) {
      // an extended resource is vendor-qualified; `cpu`, `memory`, `pods` are not
      if (k.includes('/') && GPU_RESOURCE.test(k) && Number(v) > 0) found.add(k)
    }
  }
  return [...found].sort()
}

/**
 * Free GPUs, by asking the scheduler: allocatable minus what Running and Pending pods request.
 *
 * `resource` omitted means "whatever this cluster has", summed across every kind it advertises.
 */
export async function freeGpus(k8s, { resource = null } = {}) {
  if (!k8s?.usable?.()) return { free: 0, total: 0, known: false, why: 'not running in a cluster' }
  const num = (v) => (v == null ? 0 : Number(String(v).replace(/[^0-9.]/g, '')) || 0)
  let kinds
  try {
    kinds = resource ? [resource] : await gpuResources(k8s)
  } catch (e) {
    // `known: false` is the load-bearing field. A caller that treats this as "no GPUs" would
    // silently refuse to fan a run out; one that reads `known` offers what was asked for instead.
    return {
      free: 0, total: 0, known: false,
      why: /forbidden|403/i.test(String(e.message ?? e))
        ? 'this service may not list nodes — install the chart with gpuVisibility=true to count free GPUs'
        : `could not ask the scheduler: ${e.message ?? e}`,
    }
  }
  if (!kinds.length) return { free: 0, total: 0, known: true, resources: [], why: 'no nodes advertise a GPU resource' }
  const nodes = await k8s.raw('GET', '/api/v1/nodes')
  let total = 0
  for (const node of nodes.items ?? []) {
    for (const k of kinds) total += num(node.status?.allocatable?.[k])
  }
  // EVERY namespace: a GPU held by another team's workload is not free because it is not ours.
  const pods = await k8s.raw('GET', '/api/v1/pods?fieldSelector=status.phase!=Succeeded,status.phase!=Failed')
  let used = 0
  for (const p of pods.items ?? []) {
    for (const c of [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])]) {
      for (const k of kinds) used += num(c.resources?.limits?.[k] ?? c.resources?.requests?.[k])
    }
  }
  return { free: Math.max(0, total - used), total, used, known: true, resources: kinds }
}

/** Where a run's object lives, whichever kind it is. */
function pathFor(via, apiVersion, namespace, name = '') {
  const base = via === 'training'
    ? `/apis/${apiVersion}/namespaces/${namespace}/trainingdeployments`
    : via === 'batch'
      ? `/apis/batch/v1/namespaces/${namespace}/jobs`
      : `/apis/jobset.x-k8s.io/v1alpha2/namespaces/${namespace}/jobsets`
  return name ? `${base}/${encodeURIComponent(name)}` : base
}

/** The batch tier's run is a pair of Jobs sharing `corridor.run`; roll them into one row. */
function foldBatch(items) {
  const byRun = new Map()
  for (const j of items) {
    const run = j.metadata?.labels?.['corridor.run']
    if (!run) continue
    const prev = byRun.get(run) ?? { name: run, jobs: [], failed: 0, active: 0, succeeded: 0, createdAt: j.metadata.creationTimestamp, capture: j.metadata?.labels?.['corridor.capture'] ?? null, world: j.metadata?.labels?.['corridor.world'] ?? null }
    prev.jobs.push(j.metadata.name)
    prev.failed += j.status?.failed ?? 0
    prev.active += j.status?.active ?? 0
    prev.succeeded += j.status?.succeeded ?? 0
    if (j.metadata.creationTimestamp < prev.createdAt) prev.createdAt = j.metadata.creationTimestamp
    byRun.set(run, prev)
  }
  return [...byRun.values()].map((r) => ({
    ...r,
    // one failed pod fails the run: a half-trained world is worse than none
    state: r.failed > 0 ? 'failed' : r.active > 0 ? 'running' : r.succeeded > 0 ? 'done' : 'starting',
    via: 'batch',
  }))
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
  const r = await resolve(run, k8s)
  const { via, kind, manifest, apiVersion } = await manifestFor(r, k8s, { namespace, force })
  const gv = apiVersion ?? (await apiVersionFor(k8s))
  /*
   * THE BATCH TIER CREATES TWO OBJECTS, because no single one owns both. They go up leader-first
   * — a worker that starts before the chunks exist waits rather than failing, so the order is a
   * courtesy rather than a requirement, but if the second create fails the first is already
   * running and the caller is told which.
   */
  if (via === 'batch') {
    const base = `/apis/batch/v1/namespaces/${namespace}/jobs` + (dryRun ? '?dryRun=All' : '')
    const made = []
    for (const item of manifest.items) {
      const created = await k8s.raw('POST', base, { body: item }).catch((e) => {
        throw Object.assign(new Error(`${item.metadata.name}: ${e.message}${made.length ? ` (${made.join(', ')} already started)` : ''}`), { status: e.status ?? 500 })
      })
      made.push(created?.metadata?.name ?? item.metadata.name)
    }
    return { name: manifest.run, kind, via, namespace, dryRun, jobs: made, capture: r.capture, world: r.world, workers: r.workers, createdAt: new Date().toISOString() }
  }

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
  if (p.via === 'batch') {
    const list = await k8s.raw('GET', `${pathFor(p.via, gv, namespace)}?labelSelector=${encodeURIComponent(`corridor.run=${name}`)}`).catch(() => ({ items: [] }))
    const folded = foldBatch(list.items ?? [])
    return folded[0] ?? { state: 'gone', name }
  }
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
  if (p.via === 'batch') {
    return foldBatch((list.items ?? []).filter((o) => o.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'worldeditor'))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }
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
  if (p.via === 'batch') {
    // a collection delete by label, since the pair has no owner to cascade from
    await k8s.raw('DELETE', `${pathFor(p.via, gv, namespace)}?labelSelector=${encodeURIComponent(`corridor.run=${name}`)}&propagationPolicy=Background`)
    return { deleted: name, via: 'batch' }
  }
  await k8s.raw('DELETE', `${pathFor(p.via, gv, namespace, name)}?propagationPolicy=Background`)
  return { deleted: name }
}
