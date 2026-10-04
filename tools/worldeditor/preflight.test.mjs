// Would preflight actually catch what a DGX Spark cluster is like?
//
// Running it against gh200-1 and seeing green proves only that gh200-1 is fine. A GB10 has 20 Arm
// cores and 128 GB of UNIFIED memory against the GH200's 72 cores and 573 GiB of host RAM beside
// 96 GB of HBM, so the interesting answers are all on a cluster I do not have. This fabricates
// one, and a few ways of getting it wrong, and checks what preflight says.
//
//   node tools/worldeditor/preflight.test.mjs
import { checks, PROFILES, qty } from './preflight.mjs'

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
  if (!ok) failed++
}
const find = (rs, name) => rs.find((r) => r.name === name)

/** six GB10s: 20 cores, 128 GB unified, one GPU each */
const sparks = (over = {}) => ({
  nodes: Array.from({ length: 6 }, (_, i) => ({ name: `spark-${i + 1}`, arch: 'arm64', cpu: 20, mem: 128 * 2 ** 30, gpus: 1 })),
  storageClasses: [{ name: 'local-path', provisioner: 'rancher.io/local-path' }],
  crds: [],
  ingressBodyMiB: 64,
  ...over,
})

console.log('preflight, against a cluster I do not have\n')

/* 1. a bare six-Spark cluster: what actually stops it */
{
  const r = checks(sparks(), PROFILES.spark)
  check('arm64 is fine', find(r, 'architecture').ok, true)
  check('six GPUs is what the profile wants', find(r, 'GPUs').ok, true)
  check('a bake at 8 cpu / 32 GiB fits 20 cores', find(r, 'a bake fits on one node').ok, true)
  // THE ONE THAT MATTERS: local-path is ReadWriteOnce and three things mount this volume at once
  check('local-path is NOT ReadWriteMany', find(r, 'ReadWriteMany storage').ok, false)
  console.log(`       ${find(r, 'ReadWriteMany storage').detail}`)
  check('no CRDs is "could not tell", not a failure', find(r, 'trainingdeployments').ok, null)
  console.log(`       ${find(r, 'trainingdeployments').detail}`)
}

/* 2. the DEFAULT profile on Sparks — which is how somebody would actually first try it */
{
  const r = checks(sparks({ storageClasses: [{ name: 'nfs', provisioner: 'nfs.csi.k8s.io' }] }), PROFILES.default)
  // IT DOES NOT FIT, and that is the honest answer: a Spark has 128 GiB of unified memory and the
  // default bake now asks 384 (the 669 M-point network needs it for surface.measure). The fix
  // names the knob, so the operator learns to use the spark profile's smaller limits rather than
  // getting a Job that never schedules.
  check('the default bake does NOT fit a Spark', find(r, 'a bake fits on one node').ok, false)
  console.log(`       ${find(r, 'a bake fits on one node').detail}`)
  console.log(`       ${find(r, 'a bake fits on one node').fix}`)
}

/* 3. unified memory: a resident model and a bake share one pool */
{
  const tight = { ...PROFILES.spark, modelsResidentGiB: 100 }
  const r = checks(sparks({ storageClasses: [{ name: 'nfs', provisioner: 'nfs.csi.k8s.io' }] }), tight)
  check('100 GiB of models leaves too little to bake', find(r, 'unified memory headroom').ok, false)
  console.log(`       ${find(r, 'unified memory headroom').detail}`)
}

/* 4. an ingress that will 413 in the middle of a capture */
{
  const r = checks(sparks({ ingressBodyMiB: 16 }), PROFILES.spark)
  check('16 MiB against 32 MiB chunks is caught', find(r, 'ingress body limit').ok, false)
  console.log(`       ${find(r, 'ingress body limit').detail}`)
}

/* 5. aggregate capacity is not the same as somewhere to put it */
{
  const many = { nodes: Array.from({ length: 40 }, (_, i) => ({ name: `tiny-${i}`, arch: 'amd64', cpu: 2, mem: 4 * 2 ** 30, gpus: 0 })), storageClasses: [{ name: 'nfs', provisioner: 'nfs.csi.k8s.io' }], crds: [], ingressBodyMiB: 64 }
  const r = checks(many, PROFILES.spark)
  check('80 cores across 40 nodes still cannot host one bake', find(r, 'a bake fits on one node').ok, false)
  check('and no GPUs is caught', find(r, 'GPUs').ok, false)
}

/* the quantity parser, since every number above goes through it */
check('qty 601264960Ki', Math.round(qty('601264960Ki') / 2 ** 30), 573)
check('qty 200m', qty('200m'), 0.2)
check('qty 16', qty('16'), 16)
check('qty 48Gi', qty('48Gi') / 2 ** 30, 48)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
