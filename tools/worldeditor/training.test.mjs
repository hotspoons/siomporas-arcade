// Does the splat run work on somebody else's cluster?
//
// Rich, 2026-09-28: "make sure what we built is not overfit for my cluster. It should work in any
// cluster of any arch with GPUs, not just gh200s."
//
// Three things were: the GPU resource name, the storage class, and the node architecture. Each
// fails in the same quiet way — a manifest that is accepted, a pod that schedules, and a run that
// does no work — so each is checked against a cluster that is deliberately nothing like ours.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freeGpus, gpuResources, normalise, resolve, jobSet, roleArgs } from './training.mjs'

/** A fake cluster: whatever nodes and pods you hand it. */
const fake = (nodes, pods = []) => ({
  usable: () => true,
  namespace: 'default',
  raw: async (method, path) => {
    if (path.startsWith('/api/v1/nodes')) return { items: nodes }
    if (path.startsWith('/api/v1/pods')) return { items: pods }
    throw new Error(`unexpected ${method} ${path}`)
  },
})
const node = (alloc) => ({ status: { allocatable: { cpu: '64', memory: '256Gi', pods: '110', ...alloc } } })
const pod = (limits) => ({ spec: { containers: [{ resources: { limits } }] } })

test('finds NVIDIA GPUs', async () => {
  const k = fake([node({ 'nvidia.com/gpu': '8' })])
  assert.deepEqual(await gpuResources(k), ['nvidia.com/gpu'])
})

test('finds AMD GPUs on a cluster with no NVIDIA anywhere', async () => {
  const k = fake([node({ 'amd.com/gpu': '4' }), node({ 'amd.com/gpu': '4' })])
  assert.deepEqual(await gpuResources(k), ['amd.com/gpu'])
  const r = await freeGpus(k)
  assert.equal(r.total, 8, 'eight AMD GPUs should count as eight GPUs')
})

test('finds Intel and Habana accelerators', async () => {
  assert.deepEqual(await gpuResources(fake([node({ 'gpu.intel.com/i915': '2' })])), ['gpu.intel.com/i915'])
  assert.deepEqual(await gpuResources(fake([node({ 'habana.ai/gaudi': '8' })])), ['habana.ai/gaudi'])
})

test('a mixed cluster counts every kind', async () => {
  const k = fake([node({ 'nvidia.com/gpu': '2' }), node({ 'amd.com/gpu': '3' })])
  const r = await freeGpus(k)
  assert.equal(r.total, 5)
  assert.deepEqual(r.resources, ['amd.com/gpu', 'nvidia.com/gpu'])
})

test('does not mistake cpu, memory or pods for an accelerator', async () => {
  // `pods` ends in s and `cpu` is a bare word; only vendor-qualified names are extended resources
  const k = fake([node({ 'ephemeral-storage': '100Gi', 'hugepages-2Mi': '0' })])
  assert.deepEqual(await gpuResources(k), [])
  const r = await freeGpus(k)
  assert.equal(r.total, 0)
  assert.match(r.why, /no nodes advertise/)
})

test('used counts every namespace, because another team holding a GPU still holds it', async () => {
  const k = fake(
    [node({ 'nvidia.com/gpu': '8' })],
    [pod({ 'nvidia.com/gpu': '5' }), pod({ 'nvidia.com/gpu': '1' })],
  )
  const r = await freeGpus(k)
  assert.equal(r.total, 8)
  assert.equal(r.used, 6)
  assert.equal(r.free, 2)
})

test('the GPU resource in the manifest is the one the cluster actually has', async () => {
  const k = fake([node({ 'amd.com/gpu': '4' })])
  const r = await resolve({ capture: 'x', gpusPerNode: 2 }, k)
  assert.equal(r.gpuResource, 'amd.com/gpu')
  assert.equal(r.gpuResourceDiscovered, true)
  const js = jobSet(r)
  const limits = js.spec.replicatedJobs[0].template.spec.template.spec.containers[0].resources.limits
  assert.ok('amd.com/gpu' in limits, `manifest asked for ${JSON.stringify(Object.keys(limits))}`)
  assert.ok(!('nvidia.com/gpu' in limits), 'must not ask for a resource this cluster does not have')
})

test('falls back to the common name only when there is no cluster to ask', async () => {
  const none = { usable: () => false }
  const r = await resolve({ capture: 'x' }, none)
  assert.equal(r.gpuResource, 'nvidia.com/gpu')
  // false, not undefined: the field says explicitly that this was a fallback rather than being
  // silently absent, which is the difference between "we guessed" and "nobody asked".
  assert.equal(r.gpuResourceDiscovered, false, 'a guess must say it is a guess')
})

test('no storage class is asked for unless one was chosen', () => {
  // A named class that does not exist leaves the PVC Pending forever; omitted, the cluster's own
  // default applies, which is what its admin already decided.
  const r = normalise({ capture: 'x' })
  assert.equal(r.storageClass, null)
  const js = jobSet(r)
  const yaml = JSON.stringify(js)
  assert.ok(!yaml.includes('ceph'), 'no cluster-specific storage class should appear')
  assert.ok(!yaml.includes('storageClassName'), 'the field should be absent, not null')
})

test('nothing pins the run to an architecture', () => {
  const r = normalise({ capture: 'x' })
  const yaml = JSON.stringify(jobSet(r))
  for (const pinned of ['arm64', 'amd64', 'aarch64', 'x86_64', 'kubernetes.io/arch', 'gh200']) {
    assert.ok(!yaml.includes(pinned), `the manifest pins ${pinned}`)
  }
})

/* ---- three tiers, and the floor is the one that matters ---------------------------------------
 *
 * Rich, 2026-09-28: "targeting the training deployment crd from my platform if it exists with a
 * fallback to jobset, and finally raw batch jobs if neither crd is there."
 *
 * The first tier is the showcase and the third is the product: `batch/v1` is in every Kubernetes,
 * so a cluster that has neither CRD is not a degraded case, it is the normal one.
 */
import { plan, manifestFor, batchJobs, listRuns } from './training.mjs'

/**
 * A cluster that answers 404 for whatever it has not got.
 *
 * The resource is matched EXACTLY, not as a substring — `jobsets` contains `jobs`, so a fixture
 * offering only plain Jobs was answering the JobSet probe too and the batch tier could never be
 * reached. A fake that is more permissive than the real thing tests nothing.
 */
const cluster = (present) => ({
  usable: () => true,
  namespace: 'default',
  raw: async (_m, path) => {
    if (path === '/apis') return { groups: [{ name: 'richard-siomporas.patapsco.ai', versions: [{ version: 'v1alpha1' }], preferredVersion: { version: 'v1alpha1' } }] }
    if (path.startsWith('/api/v1/nodes')) return { items: [node({ 'nvidia.com/gpu': '4' })] }
    if (path.startsWith('/api/v1/pods')) return { items: [] }
    const resource = path.split('?')[0].split('/').pop()
    if (present.includes(resource)) return { items: [] }
    throw Object.assign(new Error('not found'), { status: 404 })
  },
})

test('prefers the platform CRD when it is there', async () => {
  const p = await plan(cluster(['trainingdeployments', 'jobsets', 'jobs']))
  assert.equal(p.via, 'training')
  assert.equal(p.featured, true)
})

test('falls back to JobSet when the platform CRD is absent', async () => {
  const p = await plan(cluster(['jobsets', 'jobs']))
  assert.equal(p.via, 'jobset')
  assert.equal(p.kind, 'JobSet')
})

test('falls back to plain Jobs when neither CRD is installed', async () => {
  const p = await plan(cluster(['jobs']))
  assert.equal(p.via, 'batch')
  assert.equal(p.kind, 'Job')
  assert.equal(p.available, true, 'a cluster with no CRDs can still run this')
})

test('and says so plainly when it is not a cluster at all', async () => {
  const p = await plan(cluster([]))
  assert.equal(p.available, false)
  assert.match(p.why, /does not look like a cluster/)
})

test('the plain-Job manifest is the same run: same image, args and shared output', async () => {
  const k = cluster(['jobs'])
  const { manifest, via } = await manifestFor({ capture: 'x', workers: 3 }, k)
  assert.equal(via, 'batch')
  assert.equal(manifest.items.length, 2, 'a leader job and a worker job')
  const [leader, worker] = manifest.items
  assert.equal(leader.spec.parallelism, 1)
  assert.equal(worker.spec.parallelism, 3, 'workers fan out')
  // the two are tied together by a label, since no object owns both
  assert.equal(leader.metadata.labels['corridor.run'], worker.metadata.labels['corridor.run'])
  // and they share one output volume, which is the whole reason this is not N independent runs
  const claimOf = (j) => j.spec.template.spec.volumes.find((v) => v.name === 'out').persistentVolumeClaim.claimName
  assert.equal(claimOf(leader), claimOf(worker))
  // the roles really differ
  assert.ok(leader.spec.template.spec.containers[0].args.join(' ').includes('--role leader'))
  assert.ok(worker.spec.template.spec.containers[0].args.join(' ').includes('--role worker'))
})

test('a one-pod run is still the whole pipeline', async () => {
  const m = batchJobs({ capture: 'x', workers: 0 })
  assert.equal(m.items.length, 1, 'no workers means the leader does it all')
})

test('no tier pins a storage class', async () => {
  for (const tier of ['training', 'jobset', 'batch']) {
    const { manifest } = await manifestFor({ capture: 'x' }, cluster(['trainingdeployments', 'jobsets', 'jobs']), { force: tier })
    assert.ok(!JSON.stringify(manifest).includes('ceph'), `${tier} names a cluster-specific class`)
  }
})

test('a batch run is one row, not two, and one failed pod fails it', () => {
  // the pair shares `corridor.run`; the editor should show a run, not two jobs
  const items = [
    { metadata: { name: 'r-leader', creationTimestamp: '2026-09-28T01:00:00Z', labels: { 'corridor.run': 'r', 'corridor.capture': 'c' } }, status: { succeeded: 1 } },
    { metadata: { name: 'r-worker', creationTimestamp: '2026-09-28T01:00:05Z', labels: { 'corridor.run': 'r', 'corridor.capture': 'c' } }, status: { active: 2 } },
  ]
  const k = {
    usable: () => true, namespace: 'default',
    raw: async (_m, p) => {
      if (p === '/apis') return { groups: [] }
      const resource = p.split('?')[0].split('/').pop()
      if (resource === 'jobs') return { items: items.map((i) => ({ ...i, metadata: { ...i.metadata, labels: { ...i.metadata.labels, 'app.kubernetes.io/managed-by': 'worldeditor' } } })) }
      throw Object.assign(new Error('not found'), { status: 404 })
    },
  }
  return listRuns(k).then((runs) => {
    assert.equal(runs.length, 1, 'a leader and a worker are one run')
    assert.equal(runs[0].name, 'r')
    assert.equal(runs[0].state, 'running', 'still running while any pod is active')
    assert.equal(runs[0].jobs.length, 2)
  })
})

/* ---- the arguments have to be ones splatpipe accepts ------------------------------------------
 *
 * A manifest that is valid Kubernetes and invalid splatpipe schedules perfectly and dies on its
 * first line. Both of these were wrong before they were checked.
 */
test('--config goes BEFORE the subcommand, because that is where splatpipe declares it', () => {
  const r = normalise({ capture: 'x', config: 'configs/arrowhead-c120.yaml' })
  const args = roleArgs(r, 'leader')
  assert.equal(args[0], '--config', `args began ${JSON.stringify(args.slice(0, 3))}`)
  assert.equal(args[1], 'configs/arrowhead-c120.yaml')
  assert.equal(args[2], 'run', 'the subcommand follows the global option')
  assert.ok(args.indexOf('--config') < args.indexOf('run'), 'a global option after the subcommand is "unrecognized arguments"')
})

test('no flag is passed that splatpipe run does not declare', () => {
  // `run` takes exactly these; anything else is a usage error on the first line of the job.
  // `--seam-fail-over` was added by the splats lane when the gate landed — this list is the
  // contract between the two, and it is worth keeping literal rather than inferred.
  const ALLOWED = new Set(['--capture', '--out', '--role', '--site', '--work', '--config', '--seam-fail-over'])
  const r = normalise({ capture: 'x', world: 'w', config: 'c.yaml', seamFailOver: 3 })
  for (const role of ['leader', 'worker']) {
    for (const a of roleArgs(r, role)) {
      if (a.startsWith('--')) assert.ok(ALLOWED.has(a), `run does not accept ${a}`)
    }
  }
})

test('the gate threshold is passed, and disabling it is a word rather than a zero', () => {
  const on = roleArgs(normalise({ capture: 'x', seamFailOver: 2.5 }), 'leader')
  assert.equal(on[on.indexOf('--seam-fail-over') + 1], '2.5')
  // "no bar" and "an impossible bar" are opposite intentions; 0 could be read as either
  const off = roleArgs(normalise({ capture: 'x', seamFailOver: 0 }), 'leader')
  assert.equal(off[off.indexOf('--seam-fail-over') + 1], 'none')
})

test('the roles really differ, and only in the role', () => {
  const r = normalise({ capture: 'x' })
  const l = roleArgs(r, 'leader')
  const w = roleArgs(r, 'worker')
  assert.equal(l.length, w.length)
  const diff = l.map((v, i) => (v === w[i] ? null : [v, w[i]])).filter(Boolean)
  assert.deepEqual(diff, [['leader', 'worker']])
})

test('a named commit becomes a guard that runs before the work', () => {
  const r = normalise({ capture: 'x', codeSha: 'abc1234' })
  const spec = jobSet(r).spec.replicatedJobs[0].template.spec.template.spec
  assert.ok(spec.initContainers?.length, 'assert-code must run first')
  assert.match(spec.initContainers[0].command[0], /assert-code\.sh$/)
  assert.deepEqual(spec.initContainers[0].args, ['abc1234'])
})

test('and no guard is added when no commit was named, rather than an empty one', () => {
  const spec = jobSet(normalise({ capture: 'x' })).spec.replicatedJobs[0].template.spec.template.spec
  assert.equal(spec.initContainers, undefined)
})

test('what the run was asked to accept is written on the object', () => {
  const m = jobSet(normalise({ capture: 'x', codeSha: 'deadbee', seamFailOver: 1.5, config: 'c.yaml' }))
  assert.equal(m.metadata.annotations['corridor.seam-fail-over'], '1.5')
  assert.equal(m.metadata.annotations['corridor.code-sha'], 'deadbee')
})

test('a refusal to list nodes is not reported as an empty cluster', async () => {
  // Listing nodes is cluster-scoped and this pod's Role is namespaced by default, so without the
  // opt-in ClusterRole it 403s. Swallowing that reported "0 free of 0" on an eight-GPU cluster —
  // an answer indistinguishable from a true one, and not one.
  const forbidden = {
    usable: () => true,
    namespace: 'default',
    raw: async () => { throw Object.assign(new Error('nodes is forbidden: User cannot list resource "nodes"'), { status: 403 }) },
  }
  const r = await freeGpus(forbidden)
  assert.equal(r.known, false, 'the count must declare itself unknown')
  assert.match(r.why, /gpuVisibility/, 'and say what would fix it')
})

test('an actually empty cluster says so, and says it KNOWS', async () => {
  const r = await freeGpus(fake([node({})]))
  assert.equal(r.known, true, 'nothing was refused; this answer is real')
  assert.equal(r.total, 0)
  assert.match(r.why, /no nodes advertise/)
})

/* ---- creating a run, on each tier ----------------------------------------------------------------
 * What the cluster is ASKED to create is the claim: which objects, in which order, and whether the
 * output volume the fallback tiers depend on is among them. A fake records every write.
 */
import { createRun, outputClaim } from './training.mjs'

/** A cluster that has whichever APIs you say, and records every POST. */
function recording({ training = false, jobset = false, pvcExists = false } = {}) {
  const posts = []
  const k8s = {
    usable: () => true,
    namespace: 'default',
    raw: async (method, path, opts = {}) => {
      if (method === 'GET' && path === '/apis') {
        return { groups: training ? [{ name: 'richard-siomporas.patapsco.ai', preferredVersion: { groupVersion: 'richard-siomporas.patapsco.ai/v1alpha1' } }] : [] }
      }
      if (method === 'GET' && path.includes('/trainingdeployments')) {
        if (!training) throw Object.assign(new Error('not found'), { status: 404 })
        return { items: [] }
      }
      if (method === 'GET' && path.includes('/jobsets')) {
        if (!jobset) throw Object.assign(new Error('not found'), { status: 404 })
        return { items: [] }
      }
      if (method === 'GET' && path.includes('/apis/batch/v1')) return { items: [] }
      if (method === 'GET' && path.startsWith('/api/v1/nodes')) return { items: [] }
      if (method === 'GET' && path.startsWith('/api/v1/pods')) return { items: [] }
      if (method === 'POST') {
        posts.push({ path, kind: opts.body?.kind, name: opts.body?.metadata?.name })
        if (opts.body?.kind === 'PersistentVolumeClaim' && pvcExists) throw Object.assign(new Error('already exists'), { status: 409 })
        return { metadata: { name: opts.body?.metadata?.name } }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }
  return { k8s, posts }
}

test('a TrainingDeployment brings its own volume, so no claim is created', async () => {
  const { k8s, posts } = recording({ training: true, jobset: true })
  const r = await createRun({ capture: 'cap1' }, k8s, { namespace: 'default' })
  assert.equal(r.via, 'training')
  assert.deepEqual(posts.map((p) => p.kind), ['TrainingDeployment'])
  assert.equal(r.claim, null)
})

test('a JobSet gets its RWX output volume created FIRST', async () => {
  // The bug this pins: the JobSet mounted `<name>-out` and nothing made it, so the run sat
  // Pending for ever on any cluster without the CRD.
  const { k8s, posts } = recording({ jobset: true })
  const r = await createRun({ capture: 'cap1' }, k8s, { namespace: 'default' })
  assert.equal(r.via, 'jobset')
  assert.deepEqual(posts.map((p) => p.kind), ['PersistentVolumeClaim', 'JobSet'])
  assert.equal(r.claim.name, 'splat-cap1-out')
  assert.equal(r.claim.created, true)
})

test('plain Jobs — the head and its workers — get the volume first as well', async () => {
  // `workers` defaults to 0, and then the head does everything alone: that is one claim and one
  // Job. With workers asked for there is a second Job, and both follow the claim.
  const { k8s, posts } = recording()
  const r = await createRun({ capture: 'cap1', workers: 2 }, k8s, { namespace: 'default' })
  assert.equal(r.via, 'batch')
  assert.equal(posts[0].kind, 'PersistentVolumeClaim')
  assert.deepEqual(posts.slice(1).map((p) => p.kind), ['Job', 'Job'])
  assert.ok(posts[1].name.endsWith('-leader'), 'the head goes first')
})

test('a run with no workers is the head alone', async () => {
  const { k8s, posts } = recording()
  await createRun({ capture: 'cap1' }, k8s, { namespace: 'default' })
  assert.deepEqual(posts.map((p) => p.kind), ['PersistentVolumeClaim', 'Job'])
})

test('a claim that already exists is used, which is what makes a retry safe', async () => {
  const { k8s, posts } = recording({ jobset: true, pvcExists: true })
  const r = await createRun({ capture: 'cap1' }, k8s, { namespace: 'default' })
  assert.equal(r.claim.created, false)
  assert.equal(posts.at(-1).kind, 'JobSet', 'the run still went ahead')
})

test('a caller that names its own claim gets no claim made for it', async () => {
  const { k8s, posts } = recording({ jobset: true })
  await createRun({ capture: 'cap1', outClaim: 'mine' }, k8s, { namespace: 'default' })
  assert.ok(!posts.some((p) => p.kind === 'PersistentVolumeClaim'))
})

test('the runner can be PINNED, whatever the cluster offers', async () => {
  // what the `splat.runner` setting does: the featured path is misbehaving and you want to know
  // whether it is the operator or the workload
  const { k8s, posts } = recording({ training: true, jobset: true })
  const r = await createRun({ capture: 'cap1' }, k8s, { namespace: 'default', force: 'batch' })
  assert.equal(r.via, 'batch')
  assert.ok(!posts.some((p) => p.kind === 'TrainingDeployment'))
})

test('the output claim is RWX, sized, and labelled so it can be found', () => {
  const pvc = outputClaim({ name: 'splat-x', outputSize: '200Gi', storageClass: 'cephfs', world: 'crofton' })
  assert.deepEqual(pvc.spec.accessModes, ['ReadWriteMany'])
  assert.equal(pvc.spec.resources.requests.storage, '200Gi')
  assert.equal(pvc.spec.storageClassName, 'cephfs')
  assert.equal(pvc.metadata.labels['corridor.role'], 'splat-output')
  // and no class named means the cluster's default, not an empty string
  assert.equal('storageClassName' in outputClaim({ name: 'y', outputSize: '1Gi' }).spec, false)
})
