// Does the resolver find a model, and does it still find one when the CRD is deleted?
//
// That is the handoff's own done-when for this step, and it cannot be tested by deleting Rich's
// CRD. So the Kubernetes API is stood in for: the CLUSTER'S REAL ANSWERS are recorded below as
// fixtures, and each rung of the ladder is tested by taking away the rung above it.
//
//   node tools/worldeditor/models.test.mjs
//   node tools/worldeditor/models.test.mjs --live    # against the real cluster, through k8s.mjs
import { ModelResolver } from './models.mjs'

/* ---- fixtures: what `kubectl get` actually returned on gh200-1, 2026-09-27 ----------------- */

const READY = [{ type: 'Ready', status: 'True' }]
const CRDS = [
  { metadata: { name: 'high-brine' }, status: { conditions: READY, endpoints: { external: 'high-brine.richard-siomporas.basedweights.com', internal: 'high-brine-internal-gw.default.svc.cluster.local' } } },
  { metadata: { name: 'zt-qwen' }, status: { conditions: READY, endpoints: { external: 'zt-qwen.richard-siomporas.basedweights.com', internal: 'zt-qwen-internal-gw.default.svc.cluster.local' } } },
]
const SERVICES = [
  'epp-high-brine-high-brine-flux2-dev',
  'epp-zt-qwen-zt-qwen-qwen38-27b',
  'high-brine-high-brine-flux2-dev-lws',
  'high-brine-high-brine-flux2-dev-lws-api',
  'high-brine-internal-gw',
  'model-indexer-high-brine',
  'model-indexer-zt-qwen',
  'recon',
  'zt-qwen-zt-qwen-qwen38-27b-lws-api',
  'worldeditor',
].map((name) => ({ metadata: { name } }))

/*
 * A K8s stand-in that answers with whatever this test wants the cluster to be.
 *
 * It serves the DISCOVERY DOCUMENT too, because finding the group version is part of the path
 * now: the CRD is named `inferencedeployments.richard-siomporas.patapsco.ai` and its group is
 * `richard-siomporas.patapsco.ai` at v1alpha1, and having those two confused is what made the
 * whole CRD rung unreachable from a pod while kubectl worked fine beside it.
 */
const GROUPS = { groups: [{ name: 'richard-siomporas.patapsco.ai', preferredVersion: { groupVersion: 'richard-siomporas.patapsco.ai/v1alpha1' } }] }
const fakeK8s = ({ crds = CRDS, services = SERVICES, broken = false, groups = GROUPS }) => ({
  usable: () => !broken,
  raw: async (_m, p) => {
    if (broken) throw new Error('no api server')
    if (p === '/apis') return groups
    if (p.includes('inferencedeployments')) {
      if (crds === null) throw new Error('the server could not find the requested resource')
      return { items: crds }
    }
    if (p.includes('/services')) return { items: services }
    return {}
  },
})

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) { console.log(`       got  ${JSON.stringify(got)}`); console.log(`       want ${JSON.stringify(want)}`); failed++ }
}
const brief = (r) => ({ via: r.via, url: r.url })

console.log('model resolver\n')

/* 1. everything present: the CRD's own LWS API Service, NOT the gateway (multipart 404s there) */
{
  const r = new ModelResolver(fakeK8s({}), {})
  check('image -> the flux LWS API service', brief(await r.resolve('image')), { via: 'crd', url: 'http://high-brine-high-brine-flux2-dev-lws-api.default.svc:80' })
  check('text  -> the qwen LWS API service', brief(await r.resolve('text')), { via: 'crd', url: 'http://zt-qwen-zt-qwen-qwen38-27b-lws-api.default.svc:80' })
  check('mesh  -> the plain recon Service', brief(await r.resolve('mesh')), { via: 'service', url: 'http://recon.default.svc:80' })
}

/* 2. THE CRD IS DELETED. This is the step's done-when. */
{
  const r = new ModelResolver(fakeK8s({ crds: null }), {})
  check('no CRD: mesh still resolves', brief(await r.resolve('mesh')), { via: 'service', url: 'http://recon.default.svc:80' })
  const img = await r.resolve('image')
  check('no CRD: image says so plainly', img.url, null)
  console.log(`       why: ${img.why}`)
}

/* 2b. the operator's API GROUP is not on this cluster at all -- the real shape of "no CRD" */
{
  const r = new ModelResolver(fakeK8s({ groups: { groups: [] } }), {})
  check('no API group: image says so', (await r.resolve('image')).url, null)
  check('no API group: mesh is unaffected', brief(await r.resolve('mesh')), { via: 'service', url: 'http://recon.default.svc:80' })
}

/* 3. the CRD is there but not Ready: fall past it rather than route into a starting pod */
{
  const notReady = CRDS.map((d) => ({ ...d, status: { ...d.status, conditions: [{ type: 'Ready', status: 'False' }] } }))
  const r = new ModelResolver(fakeK8s({ crds: notReady }), {})
  const img = await r.resolve('image')
  check('not Ready: not used', img.url, null)
}

/* 4. no LWS API Service, but the CRD has a gateway: use it, and say which */
{
  const noApi = SERVICES.filter((s) => !s.metadata.name.endsWith('-lws-api'))
  const r = new ModelResolver(fakeK8s({ services: noApi }), {})
  check('gateway is the second choice', brief(await r.resolve('image')), { via: 'crd-gateway', url: 'http://high-brine-internal-gw.default.svc.cluster.local' })
}

/* 5. no Kubernetes at all -- a laptop. The environment is the only source, and it wins. */
{
  const r = new ModelResolver(fakeK8s({ broken: true }), { MODEL_URL_IMAGE: 'http://127.0.0.1:18090/' })
  check('env override, trailing slash trimmed', brief(await r.resolve('image')), { via: 'env', url: 'http://127.0.0.1:18090' })
  const mesh = await r.resolve('mesh')
  check('and nothing invented for the rest', mesh.url, null)
  console.log(`       why: ${mesh.why}`)
}

/* 6. the environment beats a working cluster, so a port-forward is always reachable */
{
  const r = new ModelResolver(fakeK8s({}), { ASSETSVC_URL_MESH: 'http://127.0.0.1:8500' })
  check('env beats discovery', brief(await r.resolve('mesh')), { via: 'env', url: 'http://127.0.0.1:8500' })
}

if (process.argv.includes('--live')) {
  const { K8s } = await import('./k8s.mjs')
  const r = new ModelResolver(new K8s(process.env), process.env)
  console.log('\nagainst the real cluster:')
  for (const [k, v] of Object.entries(await r.describe())) {
    console.log(`  ${k.padEnd(6)} ${v.url ?? '(none)'}  via ${v.via}${v.detail ? `  [${v.detail}]` : ''}${v.why ? `  ${v.why}` : ''}`)
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
