// Can this cluster run the editor? Asked before anything is installed, and answered with numbers.
//
// Rich, 2026-09-27: "we have a cluster of six dgx Sparks that I will want to get this whole thing
// running on using our platform."
//
// The showcase only works if pointing it at a new cluster is an afternoon, and the way that turns
// into a week is discovering the constraints one failed pod at a time: an image with no manifest
// for the architecture, a storage class that cannot do ReadWriteMany, a bake asking for more CPU
// than a node has, an ingress that refuses the upload halfway through. Every one of those is
// visible in the cluster's own API before anything is installed.
//
//   node tools/worldeditor/preflight.mjs                    # the current kube context
//   node tools/worldeditor/preflight.mjs --profile spark    # against a profile's demands
//   node tools/worldeditor/preflight.mjs --json
//
// WHAT A "spark" IS HERE. A DGX Spark is a GB10: 20 Arm cores and 128 GB of UNIFIED memory, which
// the GPU and the CPU share. That last word is the one that matters — on a GH200 the model sits in
// 96 GB of HBM and the host has 570 GB of its own, and on a Spark a resident model and a running
// bake are spending the same 128 GB. So the profile's demands are not a smaller version of the
// same thing; the headroom check is different in kind.

import { execFileSync } from 'node:child_process'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1]?.startsWith('--') ? true : (process.argv[i + 1] ?? true)) : d
}

/** Kubernetes quantities, as numbers. `601264960Ki` and `16` and `200m` all mean something here. */
export function qty(v) {
  if (v === undefined || v === null) return 0
  const s = String(v)
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2]
  const bin = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 }
  const dec = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 }
  if (unit === 'm') return n / 1000
  if (bin[unit]) return n * bin[unit]
  if (dec[unit]) return n * dec[unit]
  return n
}

const GiB = (b) => b / 2 ** 30

/**
 * What a deployment needs of a cluster.
 *
 * The numbers are the chart's and the bake's, not invented: a bake Job asks 16 CPU and 48 GiB,
 * the service itself is small, and the volume is ReadWriteMany because the bake Job, the training
 * pods and the editor all mount it at once.
 */
export const PROFILES = {
  default: {
    label: 'the cluster this was built on (GH200)',
    nodes: 1,
    bake: { cpu: 16, memGiB: 48 },
    service: { cpu: 2, memGiB: 2 },
    volumeGiB: 500,
    gpusWanted: 1,
    uploadChunkMiB: 32,
  },
  spark: {
    label: 'six DGX Sparks (GB10: 20 Arm cores, 128 GB unified)',
    nodes: 6,
    // A Spark has 20 cores. Asking 16 for a bake leaves four for everything else on that node,
    // including the kubelet — so the profile asks less and says why rather than failing at
    // schedule time with "0/6 nodes are available".
    bake: { cpu: 8, memGiB: 32 },
    service: { cpu: 1, memGiB: 2 },
    volumeGiB: 500,
    gpusWanted: 6,
    uploadChunkMiB: 32,
    // unified memory: a resident model and a running bake share one pool
    unifiedMemory: true,
    modelsResidentGiB: 40,
  },
}

const kubectl = (args) => {
  try {
    return JSON.parse(execFileSync('kubectl', [...args, '-o', 'json'], { maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
  } catch {
    return null
  }
}

/** Every check, as `{ ok, name, detail, fix }`. `ok: null` is "could not tell", which is not a pass. */
export function checks(cluster, profile) {
  const out = []
  const add = (ok, name, detail, fix) => out.push({ ok, name, detail, ...(fix && ok !== true ? { fix } : {}) })

  const nodes = cluster.nodes ?? []
  if (!nodes.length) {
    add(null, 'nodes', 'could not read any nodes', 'check the kube context')
    return out
  }

  // 1. architecture. Every image we publish must have a manifest for it.
  const arches = [...new Set(nodes.map((n) => n.arch))]
  add(
    arches.every((a) => a === 'arm64' || a === 'amd64'),
    'architecture',
    `${arches.join(', ')} across ${nodes.length} node(s)`,
    'our images publish linux/amd64 and linux/arm64; anything else needs a new build target',
  )

  // 2. GPUs
  const gpus = nodes.reduce((n, x) => n + x.gpus, 0)
  add(gpus >= 1, 'GPUs', `${gpus} across ${nodes.length} node(s), ${nodes.filter((n) => n.gpus).length} with at least one`, 'training and the models need at least one; the bake does not')
  if (profile.gpusWanted > gpus) add(false, 'GPUs for this profile', `${gpus} present, ${profile.gpusWanted} wanted`, 'fewer splat workers, or fewer resident models')

  // 3. can a bake Job actually be SCHEDULED? Against one node's allocatable, not the total —
  //    a Job is one pod and a cluster with plenty in aggregate can still have nowhere to put it.
  /*
   * THREE ANSWERS, NOT TWO. "Fits" is arithmetic and the interesting case is between: a bake
   * asking 16 of a Spark's 20 cores schedules perfectly and leaves four for the kubelet, the
   * editor and everything else on that node, so the pod runs and the node thrashes. A check that
   * says only yes or no calls that a pass, which is how "it fits" and "it works" come apart.
   *
   * HEADROOM is the share of a node the biggest single pod may take. Above it, this is a warning
   * with the numbers, not a refusal — it is the operator's call and not mine.
   */
  const HEADROOM = 0.75
  const biggest = nodes.reduce((a, b) => (a.cpu * a.mem > b.cpu * b.mem ? a : b))
  const cpuShare = profile.bake.cpu / biggest.cpu
  const memShare = profile.bake.memGiB / GiB(biggest.mem)
  const fits = cpuShare <= 1 && memShare <= 1
  const roomy = cpuShare <= HEADROOM && memShare <= HEADROOM
  add(
    fits ? (roomy ? true : null) : false,
    'a bake fits on one node',
    `biggest node has ${biggest.cpu} cpu and ${GiB(biggest.mem).toFixed(0)} GiB; the bake asks ${profile.bake.cpu} and ${profile.bake.memGiB}` +
      (fits && !roomy ? ` — that is ${Math.round(Math.max(cpuShare, memShare) * 100)}% of the node, leaving little for anything else on it` : ''),
    fits
      ? 'it will schedule; give the node nothing else to do, or lower worldeditor.bake.resources.limits'
      : `lower worldeditor.bake.resources.limits — a Job that cannot be scheduled reports "0/${nodes.length} nodes are available" and nothing else`,
  )

  // 4. UNIFIED MEMORY. On a Spark the model and the workload are in one pool.
  if (profile.unifiedMemory) {
    const left = GiB(biggest.mem) - profile.modelsResidentGiB
    add(
      left >= profile.bake.memGiB,
      'unified memory headroom',
      `${GiB(biggest.mem).toFixed(0)} GiB total, about ${profile.modelsResidentGiB} for resident models, ${left.toFixed(0)} left for a bake asking ${profile.bake.memGiB}`,
      'on unified memory the GPU and the host share one pool: keep the models on nodes that do not bake, or quantise them',
    )
  }

  // 5. ReadWriteMany. The editor, the bake Job and the training pods mount the volume together.
  const rwx = cluster.storageClasses.filter((s) => /cephfs|nfs|filestore|azurefile|efs|longhorn|juicefs|camberfs|weka|lustre/i.test(`${s.name} ${s.provisioner}`))
  add(
    rwx.length > 0,
    'ReadWriteMany storage',
    rwx.length ? `${rwx.map((s) => s.name).join(', ')}` : `none of ${cluster.storageClasses.map((s) => s.name).join(', ') || '(no storage classes)'} looks like a shared filesystem`,
    'the editor, the bake Job and the training pods mount one volume at once; block storage (RWO) cannot do that',
  )

  // 6. the platform's own objects, each optional and each worth naming
  for (const [kind, why] of [
    ['trainingdeployments.richard-siomporas.patapsco.ai', 'the featured wrapper for splat training'],
    ['jobsets.jobset.x-k8s.io', 'the fallback, and what TrainingDeployment builds'],
    ['inferencedeployments.richard-siomporas.patapsco.ai', 'how the editor finds flux and qwen'],
  ]) {
    const have = cluster.crds.includes(kind)
    add(have ? true : null, kind.split('.')[0], have ? 'installed' : `not installed — ${why}`, 'optional: the editor falls back, and says which path it took')
  }

  /*
   * 7. THE INGRESS BODY LIMIT, which is the one that bites in the middle of a 40 GB upload.
   *
   * THE EDITOR'S OWN INGRESS, not the smallest in the cluster. The first version took the minimum
   * across every ingress and reported a failure that was really `overpass` at 16m — a true number
   * about the wrong object, which is the most expensive kind of check. And the test is headroom
   * and not equality: a 64 MiB chunk against a 64m limit is a coin toss, because what nginx
   * measures is not exactly what the client counted.
   */
  const limit = cluster.ingressBodyMiB
  if (limit === null) {
    add(null, 'ingress body limit', 'no worldeditor ingress yet — set it when you install', 'nginx.ingress.kubernetes.io/proxy-body-size must exceed the upload chunk size')
  } else {
    add(
      limit >= profile.uploadChunkMiB * 1.5,
      'ingress body limit',
      `${limit} MiB on the worldeditor ingress, and chapter uploads send ${profile.uploadChunkMiB} MiB at a time`,
      `raise proxy-body-size to at least ${Math.ceil(profile.uploadChunkMiB * 1.5)}m, or lower WORLDEDITOR_UPLOAD_CHUNK_MIB — a chunk over the limit is a 413 three hours into a capture`,
    )
  }
  return out
}

/** Read the cluster once, so the checks are a pure function of what was read. */
export function readCluster() {
  const n = kubectl(['get', 'nodes'])
  const sc = kubectl(['get', 'storageclass'])
  const crd = kubectl(['get', 'crd'])
  const ing = kubectl(['get', 'ingress', '-A'])
  // the editor's own, by name. Other services' limits are their business.
  const mine = (ing?.items ?? []).filter((i) => /worldeditor/.test(i.metadata?.name ?? ''))
  const bodies = mine
    .map((i) => i.metadata?.annotations?.['nginx.ingress.kubernetes.io/proxy-body-size'])
    .filter(Boolean)
    .map((v) => qty(String(v).replace(/^(\d+)m$/i, '$1Mi')) / 2 ** 20)
  return {
    nodes: (n?.items ?? []).map((x) => ({
      name: x.metadata.name,
      arch: x.status?.nodeInfo?.architecture ?? '?',
      cpu: qty(x.status?.allocatable?.cpu),
      mem: qty(x.status?.allocatable?.memory),
      // ANY GPU RESOURCE, not NVIDIA's alone: AMD advertises amd.com/gpu, Intel gpu.intel.com/i915,
      // Habana habana.ai/gaudi. Counting one vendor reports a GPU cluster as having none.
      gpus: Object.entries(x.status?.allocatable ?? {})
        .filter(([k, v]) => k.includes('/') && /(^|\/)(gpu|gaudi|i915|xe)s?$|gpu\.intel\.com|habana\.ai/i.test(k) && Number(v) > 0)
        .reduce((n, [, v]) => n + Number(v), 0),
    })),
    storageClasses: (sc?.items ?? []).map((x) => ({ name: x.metadata.name, provisioner: x.provisioner })),
    crds: (crd?.items ?? []).map((x) => x.metadata.name),
    ingressBodyMiB: bodies.length ? Math.min(...bodies) : null,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const profile = PROFILES[arg('profile', 'default')] ?? PROFILES.default
  const cluster = readCluster()
  const result = checks(cluster, profile)
  if (arg('json', false)) {
    console.log(JSON.stringify({ profile: arg('profile', 'default'), cluster, checks: result }, null, 1))
  } else {
    console.log(`preflight: ${profile.label}\n`)
    for (const c of result) {
      console.log(`  ${c.ok === true ? 'ok  ' : c.ok === false ? 'NO  ' : '?   '} ${c.name.padEnd(28)} ${c.detail}`)
      if (c.fix) console.log(`      ${c.fix}`)
    }
    const no = result.filter((c) => c.ok === false).length
    console.log(no ? `\n${no} thing(s) would stop this cluster` : '\nnothing here would stop this cluster')
  }
  process.exit(result.some((c) => c.ok === false) ? 1 : 0)
}
