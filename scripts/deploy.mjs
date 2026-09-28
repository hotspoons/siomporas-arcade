#!/usr/bin/env node
// Apply a cluster's deployment, from the files that describe it.
//
// Rich, 2026-09-28: "I don't want to run things deployed via click ops and craft scripts, I want
// to run them using repeatable deployments."
//
// Everything this repo had running on gh200-1 got there through `helm upgrade --set` typed into a
// shell — which means the live state depended on the order somebody ran commands in, nobody could
// review it, and nobody could reproduce it. This reads `deploy/<cluster>/` and applies exactly
// what is written there.
//
//   node scripts/deploy.mjs gh200-1                 # every release for that cluster
//   node scripts/deploy.mjs gh200-1 worldeditor     # one of them
//   node scripts/deploy.mjs gh200-1 --check         # render and diff against live; changes nothing
//   node scripts/deploy.mjs gh200-1 --bump          # rewrite image tags to the newest build
//
// NO `--reuse-values`, ANYWHERE. It keeps the values the PREVIOUS release was installed with, so a
// chart that gains a values block renders it as nil and the upgrade fails — which happened here on
// 2026-09-28 — and it makes the live state a function of history rather than of a file. Each
// release file is the whole input.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const positional = argv.filter((a) => !a.startsWith('--'))
const CLUSTER = positional[0]
const ONLY = positional[1] ?? null
const CHECK = has('--check')
const BUMP = has('--bump')

if (!CLUSTER) {
  console.error('usage: deploy.mjs <cluster> [release] [--check] [--bump]')
  process.exit(2)
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DIR = path.join(ROOT, 'deploy', CLUSTER)
if (!existsSync(DIR)) {
  console.error(`no deploy/${CLUSTER} — the clusters described here are: ${listClusters().join(', ')}`)
  process.exit(1)
}

function listClusters() {
  const d = path.join(ROOT, 'deploy')
  return existsSync(d) ? require('node:fs').readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
}

/** A very small YAML reader: enough for these files, which are flat maps and one list of maps. */
function readYaml(file) {
  const out = {}
  let list = null
  let listKey = null
  let item = null
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const t = line.trim()
    if (t.startsWith('- ')) {
      item = {}
      list.push(item)
      const [k, ...v] = t.slice(2).split(':')
      if (v.length) item[k.trim()] = clean(v.join(':'))
      continue
    }
    const [k, ...v] = t.split(':')
    const value = v.join(':').trim()
    if (indent > 0 && item) { item[k.trim()] = clean(value); continue }
    if (!value) { list = []; listKey = k.trim(); out[listKey] = list; item = null; continue }
    if (indent === 0) { out[k.trim()] = clean(value); list = null; item = null }
  }
  return out
}
const clean = (s) => s.trim().replace(/^["']|["']$/g, '')

const cluster = readYaml(path.join(DIR, 'cluster.yaml'))
const namespace = cluster.namespace ?? 'default'
const releases = (cluster.releases ?? []).filter((r) => !ONLY || r.name === ONLY)
if (!releases.length) {
  console.error(ONLY ? `deploy/${CLUSTER}/cluster.yaml does not list a release called ${ONLY}` : `no releases listed for ${CLUSTER}`)
  process.exit(1)
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Does this image really have a build for that tag?
 *
 * GHCR in two steps: a PAT buys a registry token for one repository, and that token reads the
 * manifest. `HEAD` rather than `GET` because the manifest itself is not wanted, and the Accept
 * headers matter — without them a multi-arch index answers 404 as if the tag did not exist.
 *
 * `null` means the question could not be asked (no credential, no network). That is NOT the same
 * as "no", and bumping is refused rather than guessed either way.
 */
const tokens = new Map()

/** The PAT, once. `git credential fill` shells out and may prompt; asking it per tag is absurd. */
let PAT
function pat() {
  if (PAT !== undefined) return PAT
  try {
    PAT = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
      .split('\n').find((l) => l.startsWith('password='))?.slice('password='.length) ?? null
  } catch {
    PAT = null
  }
  return PAT
}

async function published(image, tag) {
  const p = pat()
  if (!p) return null
  const repo = image.replace(/^ghcr\.io\//, '').replace(/:.*$/, '')
  try {
    if (!tokens.has(repo)) {
      const auth = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`, {
        headers: { Authorization: `Basic ${Buffer.from(`x:${p}`).toString('base64')}` },
      })
      tokens.set(repo, auth.ok ? (await auth.json()).token : null)
    }
    const token = tokens.get(repo)
    if (!token) return null
    const r = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json',
      },
    })
    if (r.status === 200) return true
    if (r.status === 404) return false
    return null
  } catch {
    return null
  }
}

/*
 * --bump rewrites the pinned tags, and it is a deliberate edit to a tracked file rather than
 * something a deploy does behind you.
 *
 * IT ASKS THE REGISTRY, and until 2026-09-28 it only said it did. Every release was rewritten to
 * HEAD's sha whether or not an image had been built for it — and an image is only built when its
 * own paths change, so a commit touching the world editor bumped assetsvc to a tag that has never
 * existed. Deploying that is an ImagePullBackOff, found by a pod rather than by this.
 *
 * AND IT SEARCHES THE HISTORY, not just HEAD. "The newest build" is per release: a commit that
 * only adds a probe builds nothing, and asking about HEAD alone reported "nothing in its paths
 * changed" for every release and left the whole cluster on last week's images — which is worse
 * than the bug above, because it looks like a considered answer. So each release walks back from
 * HEAD to the first ancestor that has an image, which IS the newest build of that release.
 */
if (BUMP) {
  const shas = run('git', ['rev-list', '--max-count=40', '--abbrev=7', '--abbrev-commit', 'HEAD']).trim().split('\n')
  let skipped = 0
  for (const r of releases) {
    const file = path.join(DIR, `${r.name}.yaml`)
    const before = readFileSync(file, 'utf8')
    const at = /\n\s*tag:\s*(sha-[0-9a-f]+)/.exec(before)?.[1] ?? '?'

    // the release file pins only the TAG; the repository is the chart's, so ask the chart. Not a
    // `ghcr.io/hotspoons/<name>` default: a wrong repository answers 404 for every tag and turns
    // this check into a switch that is always off.
    const chart = path.join(ROOT, r.chart, 'values.yaml')
    const repo = existsSync(chart) ? /^\s*repository:\s*(\S+)/m.exec(readFileSync(chart, 'utf8'))?.[1] : null
    if (!repo) {
      console.log(`${r.name}: ${r.chart}/values.yaml names no image repository — left alone`)
      skipped++
      continue
    }

    let found = null
    let unknown = false
    let looked = 0
    for (const sha of shas) {
      looked++
      const exists = await published(repo, `sha-${sha}`)
      // `null` is "could not ask", which is not "no": stop rather than walk the whole history
      // getting the same non-answer and then claim nothing was ever built.
      if (exists === null) { unknown = true; break }
      if (exists) { found = sha; break }
    }
    if (unknown) {
      console.log(`${r.name}: could not ask the registry — left at ${at}`)
      skipped++
      continue
    }
    if (!found) {
      console.log(`${r.name}: no image for any of the last ${shas.length} commits — left at ${at}`)
      skipped++
      continue
    }
    if (at === `sha-${found}`) { console.log(`${r.name}: already sha-${found}, the newest build`); continue }
    writeFileSync(file, before.replace(/(\n\s*tag:\s*)sha-[0-9a-f]+/, `$1sha-${found}`))
    console.log(`${r.name}: ${at} -> sha-${found}${looked > 1 ? `  (HEAD~${looked - 1}, the newest with an image)` : ''}`)
  }
  console.log(skipped ? '\nreview the diff, commit it, then deploy. Releases left alone are already on an image that exists.' : '\nreview the diff, commit it, then deploy.')
  process.exit(0)
}

let failed = 0
for (const r of releases) {
  const values = path.join(DIR, `${r.name}.yaml`)
  if (!existsSync(values)) { console.error(`${r.name}: no ${values.replace(ROOT + '/', '')}`); failed++; continue }
  const args = ['upgrade', '--install', r.name, r.chart, '-n', namespace, '-f', values]
  if (CHECK) {
    // --dry-run against the SERVER, so it is validated by the thing that will run it
    try {
      run('helm', [...args, '--dry-run=server'])
      console.log(`${r.name.padEnd(14)} ok     would apply cleanly`)
    } catch (e) {
      console.log(`${r.name.padEnd(14)} FAILS  ${String(e.stderr ?? e.message).trim().split('\n')[0]}`)
      failed++
    }
    continue
  }
  try {
    const out = run('helm', [...args, '--wait', '--timeout', '5m'])
    const rev = /REVISION: (\d+)/.exec(out)?.[1] ?? '?'
    console.log(`${r.name.padEnd(14)} ok     revision ${rev}`)
  } catch (e) {
    console.log(`${r.name.padEnd(14)} FAILED ${String(e.stderr ?? e.message).trim().split('\n').slice(0, 2).join(' ')}`)
    failed++
  }
}
process.exit(failed ? 1 : 0)
