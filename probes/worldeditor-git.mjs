// Does the git backing work against a real volume, and does the token stay on the server?
//
// gitrepo.test.mjs proves the pieces against temp directories. This proves the two claims that
// only the running service can answer:
//
//   1. THE TOKEN NEVER COMES BACK. It is PUT once and every subsequent response is searched for
//      it. A panel that can display a token is a panel that puts it in a screenshot, and the way
//      that regresses is somebody adding a field to the status response "so the UI can show which
//      one is set".
//   2. THE CACHE NEVER GOES IN. The real volume is 64 GB and 56 of it is re-fetchable downloads.
//      A repository holding those is one nobody can clone, preserving something a re-bake
//      reproduces.
//
// It runs against a COPY of the volume's layout, not the volume: `git init` on 64 GB of data is
// not a thing to do from a probe.
//
//   node probes/worldeditor-git.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'git-probe-'))
const put = (rel, bytes) => {
  const p = path.join(root, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, Buffer.alloc(bytes))
}
// the shape of the real volume, in miniature
put('worlds/crofton-triangle.json', 400)
put('levels/rooftop.json', 300)
put('programs/rooftop.ts', 900)
put('assets/hero-car.glb', 2_000_000)
put('assets/hero-car.ktx2', 900_000)
put('sites/crofton-triangle/tuning.json', 700)
put('sites/crofton-triangle/presets.json', 500)
put('sites/crofton-triangle/dem_1m.tif', 3_000_000)
put('sites/crofton-triangle/naip_overview.jpg', 800_000)
put('cache/overpass/aaa.json', 5_000_000)
put('cache/naip/bbb.tif', 5_000_000)
put('runs/1234/log.txt', 200)
put('fetch-all.log', 1000)

const PORT = 8791
const TOKEN = 'ghp_probeTOKEN_must_never_leave_the_server'
const service = spawn('node', ['tools/worldeditor/server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, WORLDEDITOR_DATA: root, WORLDEDITOR_PORT: String(PORT), WORLDEDITOR_RUNNER: 'local' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
service.stdout.on('data', (d) => logs.push(String(d)))
service.stderr.on('data', (d) => logs.push(String(d)))

const fail = []
const say = (k, v) => console.log(`${k.padEnd(34)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
const api = async (p, init) => {
  const r = await fetch(`http://localhost:${PORT}/api/git${p}`, { headers: { 'content-type': 'application/json' }, ...init })
  const text = await r.text()
  return { status: r.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

try {
  // wait for it
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(`http://localhost:${PORT}/api/git`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }

  const before = await api('')
  say('not a repository yet', { repo: before.json?.repo, lfs: before.json?.lfs })
  if (before.json?.repo !== false) fail.push('a fresh volume reported itself as a repository')
  if (before.json?.lfs !== true) fail.push('git-lfs is not available to the service')

  const scan = await api('/scan')
  say('scan: files / bytes', [scan.json?.files, scan.json?.bytes])
  say('scan: LFS formats', scan.json?.lfs)
  if (!scan.json?.lfs?.includes('glb') || !scan.json?.lfs?.includes('ktx2')) fail.push(`the scan did not send the big formats to LFS: ${scan.json?.lfs}`)
  if (scan.json?.lfs?.includes('json')) fail.push('the scan sent .json through LFS')
  // 10 MB of cache must not be in the total
  if ((scan.json?.bytes ?? 0) > 8_000_000) fail.push(`the scan counted ${scan.json?.bytes} bytes — the cache is being walked`)

  const init = await api('/init', { method: 'POST', body: JSON.stringify({ remote: 'https://github.com/hotspoons/probe-world.git' }) })
  say('init', { repo: init.json?.repo, remote: init.json?.remote, tracked: init.json?.tracked })
  if (!init.json?.repo) fail.push(`init did not make a repository: ${init.text.slice(0, 200)}`)
  if (!init.json?.tracked?.includes('glb')) fail.push('LFS is not tracking .glb after init')

  const commit = await api('/commit', { method: 'POST', body: JSON.stringify({ message: 'probe' }) })
  say('commit', { committed: commit.json?.committed, files: commit.json?.files })
  if (!commit.json?.committed) fail.push(`the first commit did nothing: ${commit.text.slice(0, 200)}`)

  const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).trim().split('\n')
  say('committed files', tracked.length)
  // the scan is what the panel promises; the commit is what happened. They differ by exactly the
  // two files git itself writes, and any other difference means the panel is lying about the size
  const generated = tracked.filter((f) => f === '.gitattributes' || f === '.gitignore').length
  if (tracked.length - generated !== scan.json?.files) {
    fail.push(`the scan promised ${scan.json?.files} files and ${tracked.length - generated} were committed`)
  }
  const leaked = tracked.filter((f) => f.startsWith('cache/') || f.startsWith('runs/') || f.endsWith('.log') || /dem_1m\.tif|naip_overview\.jpg/.test(f))
  if (leaked.length) fail.push(`these should never be committed: ${leaked.join(', ')}`)
  for (const want of ['worlds/crofton-triangle.json', 'programs/rooftop.ts', 'assets/hero-car.glb', 'sites/crofton-triangle/presets.json']) {
    if (!tracked.includes(want)) fail.push(`${want} was not committed`)
  }

  // the big asset is a pointer, not two megabytes
  const blob = execFileSync('git', ['-C', root, 'show', 'HEAD:assets/hero-car.glb'], { encoding: 'utf8' })
  say('the .glb in the commit is', blob.startsWith('version https://git-lfs') ? 'an LFS pointer' : `${blob.length} bytes of content`)
  if (!blob.startsWith('version https://git-lfs')) fail.push('the .glb went into the repository whole rather than through LFS')

  /* ---- the credential ---- */
  const set = await api('/credential', { method: 'PUT', body: JSON.stringify({ kind: 'https-token', host: 'github.com', username: 'rich', secret: TOKEN }) })
  say('credential stored', set.json)
  if (!set.json?.set) fail.push('the credential was not stored')
  if (set.text.includes(TOKEN)) fail.push('the PUT response echoed the token back')

  for (const [name, r] of [['status', await api('')], ['scan', await api('/scan')], ['init', await api('/init', { method: 'POST', body: '{}' })]]) {
    if (r.text.includes(TOKEN)) fail.push(`${name} returned the token`)
  }
  const st = await api('')
  say('status says', st.json?.credential)
  if (st.json?.credential?.host !== 'github.com' || st.json?.credential?.username !== 'rich') fail.push('the status does not say which credential is stored')

  // on disk it is readable by nobody else, and git will not commit it
  const mode = (await import('node:fs')).statSync(path.join(root, '.git-credentials')).mode & 0o777
  say('credential file mode', mode.toString(8))
  if (mode !== 0o600) fail.push(`the credential file is mode ${mode.toString(8)}`)
  const after = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
  if (after.includes('.git-credentials')) fail.push('git can see the credential file — it is not ignored')

  // a remote that is a command
  const evil = await api('/init', { method: 'POST', body: JSON.stringify({ remote: 'ext::sh -c id' }) })
  say('a command as a remote', evil.status)
  if (evil.status !== 400) fail.push(`a shell command as a remote was accepted (${evil.status})`)

  // pushing with nowhere real to push reports WHY rather than a wall of git output
  const push = await api('/push', { method: 'POST', body: '{}' })
  say('push to a repo that is not there', `${push.status} ${String(push.json?.error ?? '').slice(0, 70)}`)
  if (push.status === 200) fail.push('a push to a nonexistent remote reported success')
  if (!push.json?.error) fail.push('a failed push said nothing about why')
  if (String(push.json?.error ?? '').includes(TOKEN)) fail.push('the push error contained the token')
} finally {
  service.kill()
}

if (!existsSync(path.join(root, '.gitattributes'))) fail.push('no .gitattributes was written')
else say('.gitattributes', readFileSync(path.join(root, '.gitattributes'), 'utf8').trim().split('\n').filter((l) => l.startsWith('*')).join(' '))

if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: the authored half is committed, the cache is not, the big files go through LFS, and the token never leaves the service')
