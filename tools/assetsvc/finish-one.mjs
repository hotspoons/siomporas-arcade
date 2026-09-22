#!/usr/bin/env node
// Finish ONE glb by explicit path, in a child process.
//
// Two problems this solves, both real:
//
// `tools/assetgen/finish.mjs` is the finisher and stays the finisher — it knows that
// meshoptimizer has to do the simplifying (a collapse decimator rips the UV seams) and that the
// unlit transform must run before Draco (it decompresses to work, so the other order undoes
// itself). But its CLI is built around `--id`, resolving `ext/assetgen/<id>/<id>.glb` out of
// `assets.json`. assetsvc's files live in its catalog under a different tree and have no
// assets.json entry, so that CLI cannot address them. It does export `finish(src, out, opts)`,
// which can.
//
// And that export runs `execFileSync`, three times, for about thirty seconds. Called in-process
// it would block assetsvc's event loop for the whole of it — /health included, which is how you
// get a pod killed by its own liveness probe while it is working perfectly. So it runs here, in a
// child, and the service just waits for the exit code.
//
//   node tools/assetsvc/finish-one.mjs --in <raw.glb> --out <finished.glb> [--ratio N] [--texture N] [--lit]
import { finish } from '../assetgen/finish.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const has = (n) => argv.includes(`--${n}`)

const src = flag('in')
const out = flag('out')
if (!src || !out) {
  console.error('usage: finish-one.mjs --in <raw.glb> --out <finished.glb> [--ratio N] [--texture N] [--lit]')
  process.exit(2)
}

const r = finish(src, out, {
  ratio: Number(flag('ratio', 0.05)),
  texture: Number(flag('texture', 1024)),
  unlit: !has('lit'),
})
console.log(JSON.stringify(r))
