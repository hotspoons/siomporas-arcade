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
    // the splats lane's entrypoint. Configuration, deliberately: see the note at the top.
    command: run.command ?? (process.env.WORLDEDITOR_SPLAT_COMMAND ? JSON.parse(process.env.WORLDEDITOR_SPLAT_COMMAND) : null),
    args: run.args ?? (process.env.WORLDEDITOR_SPLAT_ARGS ? JSON.parse(process.env.WORLDEDITOR_SPLAT_ARGS) : null),
    claim: run.claim ?? process.env.WORLDEDITOR_CLAIM ?? 'worldeditor-data',
    storageClass: run.storageClass ?? process.env.WORLDEDITOR_SPLAT_STORAGE_CLASS ?? 'ceph-filesystem',
    outputSize: run.outputSize ?? process.env.WORLDEDITOR_SPLAT_OUTPUT_SIZE ?? '500Gi',
    gpuResource: run.gpuResource ?? process.env.WORLDEDITOR_GPU_RESOURCE ?? 'nvidia.com/gpu',
    // extra container limits (memory, cpu) as a plain map; the GPU count is `gpusPerNode`
    limits: run.limits ?? null,
    ttlSeconds: Number(run.ttlSeconds ?? process.env.WORLDEDITOR_SPLAT_TTL ?? 604800),
  }
}

/** The environment a gaussworks container gets, whichever object started it. */
function env(r) {
  return [
    { name: 'CAPTURE_ID', value: r.capture },
    { name: 'CAPTURE_DIR', value: `/data/captures/${r.capture}` },
    { name: 'CAPTURE_MANIFEST', value: `/data/captures/${r.capture}/capture.json` },
    { name: 'WORLD_SLUG', value: r.world ?? '' },
    { name: 'SITE_DIR', value: r.world ? `/data/sites/${r.world}` : '' },
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
            ...(r.command ? { command: r.command } : {}),
            ...(r.args ? { args: r.args } : {}),
            /*
             * `gpusPerNode` IS THE GPU REQUEST. The operator turns it into the container's
             * resource limits itself, and `limits` here is a wrapped ResourceList -- `{ items:
             * {...} }`, not a bare map. Writing the bare map was refused outright by the API
             * server (`unknown field ...resources.limits.nvidia.com/gpu`), which is a better
             * error than most and took one dry run to find. Anything else the run needs -- memory,
             * cpu -- goes through `limits.items`.
             */
            resources: {
              nodes: r.nodes,
              gpusPerNode: r.gpusPerNode,
              ...(r.limits ? { limits: { items: r.limits } } : {}),
            },
            // the footage, read-only: it was uploaded here and nothing in training should edit it
            pvcMounts: [{ name: 'editor-data', claimName: r.claim, path: '/data', readOnly: true }],
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
  const container = {
    name: 'gaussworks',
    image: r.image,
    ...(r.command ? { command: r.command } : {}),
    ...(r.args ? { args: r.args } : {}),
    env: [...env(r), { name: 'PAI_PATH_0', value: '/out' }],
    resources: { limits: { [r.gpuResource]: String(r.gpusPerNode) } },
    volumeMounts: [
      { name: 'editor-data', mountPath: '/data', readOnly: true },
      { name: 'out', mountPath: '/out' },
    ],
  }
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
      replicatedJobs: [
        {
          name: 'train',
          replicas: 1,
          template: {
            spec: {
              parallelism: r.nodes,
              completions: r.nodes,
              backoffLimit: 0,
              template: {
                spec: {
                  restartPolicy: 'Never',
                  containers: [container],
                  volumes: [
                    { name: 'editor-data', persistentVolumeClaim: { claimName: r.claim, readOnly: true } },
                    { name: 'out', emptyDir: {} },
                  ],
                },
              },
            },
          },
        },
      ],
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
