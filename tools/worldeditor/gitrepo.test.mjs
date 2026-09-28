// Does the git backing do the right thing with a volume that is mostly cache?
//
// The one that matters: this runs against a directory holding 64 GB, 56 of it re-fetchable
// downloads. A repository that commits those is a repository nobody can clone, preserving
// something a re-bake reproduces. So the tests check what is EXCLUDED as hard as what is included.
//
// The rest is the shapes that are easy to get wrong and impossible to see: porcelain parsing with
// no upstream, a remote URL that is actually a command, a credential file created world-readable
// and narrowed afterwards.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AUTHORED, BIG_FILE_BYTES, GitRepo, gitattributes, gitignore, hostOf, parseStatus, scan, validRemote } from './gitrepo.mjs'

function volume() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitrepo-'))
  const put = (rel, bytes = 16) => {
    const p = path.join(root, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, Buffer.alloc(bytes))
  }
  return { root, put }
}

test('validRemote takes https and ssh and refuses everything else', () => {
  assert.equal(validRemote('https://github.com/hotspoons/world.git'), null)
  assert.equal(validRemote('https://gitlab.example.com:8443/team/world'), null)
  assert.equal(validRemote('git@github.com:hotspoons/world.git'), null)
  // these are the ones that turn a URL into command execution
  for (const bad of ['ext::sh -c whoami', 'file:///etc/passwd', '--upload-pack=touch /tmp/x', 'https://x.com/a b', '']) {
    assert.ok(validRemote(bad), `${JSON.stringify(bad)} should be refused`)
  }
})

test('hostOf names the host for both forms', () => {
  assert.equal(hostOf('https://github.com/a/b.git'), 'github.com')
  assert.equal(hostOf('git@gitlab.example.com:a/b.git'), 'gitlab.example.com')
  assert.equal(hostOf('nonsense'), null)
})

test('scan measures what is really there, by extension', async () => {
  const { root, put } = volume()
  put('worlds/a.json', 100)
  put('levels/b.json', 200)
  put('assets/car.glb', 5_000_000)
  put('assets/car.png', 300_000)
  put('assets/readme', 10)
  const s = await scan(root)
  assert.equal(s.files, 5)
  assert.equal(s.bytes, 100 + 200 + 5_000_000 + 300_000 + 10)
  assert.deepEqual(s.exts.map((e) => e.ext), ['glb', 'png', 'json', '(none)'])
  assert.deepEqual(s.lfs.sort(), ['glb', 'png'])
  assert.ok(!s.lfs.includes('json'))
})

test('scan sends anything enormous to LFS whatever it is called', async () => {
  const { root, put } = volume()
  put('assets/mystery.dat', BIG_FILE_BYTES + 1)
  const s = await scan(root)
  assert.equal(s.big, 1)
  assert.ok(s.lfs.includes('dat'))
})

test('scan never walks the cache, whatever is in it', async () => {
  // 56 GB of re-fetchable Overpass and NAIP on the real volume
  const { root, put } = volume()
  put('worlds/a.json', 10)
  put('cache/overpass/huge.json', 40_000_000)
  put('cache/naip/tile.tif', 40_000_000)
  const s = await scan(root)
  assert.equal(s.files, 1)
  assert.ok(!s.lfs.includes('tif'))
})

test('scan does not count the bake rasters that sit beside the authored files', async () => {
  // sites/ holds both halves: the bake writes gigabytes of raster into the same directory the
  // editor writes tuning.json into. Counting both made the panel promise a commit twice its size.
  const { root, put } = volume()
  put('sites/crofton/tuning.json', 700)
  put('sites/crofton/presets.json', 500)
  put('sites/crofton/dem_1m.tif', 3_000_000)
  put('sites/crofton/tiles/0_0.ktx2', 2_000_000)
  const s = await scan(root)
  assert.equal(s.files, 2)
  assert.equal(s.bytes, 1200)
  assert.deepEqual(s.lfs, [])
})

test('scan counts the bake when the bake was asked for', async () => {
  const { root, put } = volume()
  put('sites/crofton/tuning.json', 700)
  put('sites/crofton/dem_1m.tif', 3_000_000)
  const s = await scan(root, AUTHORED, { bakes: true })
  assert.equal(s.files, 2)
  assert.ok(s.lfs.includes('tif'))
})

test('gitignore keeps the cache, the logs and the credential file out', () => {
  const ig = gitignore()
  for (const want of ['cache/', 'runs/', '*.log', '.git-credentials']) assert.ok(ig.includes(want), want)
})

test('gitignore keeps the bake out by default and lets the authored files through', () => {
  const ig = gitignore()
  assert.ok(ig.includes('sites/**'))
  assert.ok(ig.includes('!sites/*/tuning.json'))
  assert.ok(ig.includes('!sites/*/presets.json'))
  assert.ok(ig.includes('splats/**'))
})

test('gitignore lets the bake in when it is asked for', () => {
  const ig = gitignore({ bakes: true })
  assert.ok(!ig.includes('sites/**'))
  assert.ok(ig.includes('cache/')) // but never the cache
})

test('gitattributes covers what was found and nothing else', () => {
  assert.equal(gitattributes([]), '')
  const a = gitattributes(['ktx2', 'glb'])
  assert.ok(a.includes('*.glb filter=lfs diff=lfs merge=lfs -text'))
  assert.ok(a.includes('*.ktx2 filter=lfs'))
  assert.ok(!a.includes('*.json'))
})

test('parseStatus reads a branch with no upstream, which is what a fresh repo has', () => {
  const s = parseStatus('## main\n?? worlds/a.json\n')
  assert.equal(s.branch, 'main')
  assert.equal(s.upstream, null)
  assert.equal(s.untracked, 1)
  assert.equal(s.ahead, 0)
})

test('parseStatus reads ahead and behind', () => {
  const s = parseStatus('## main...origin/main [ahead 2, behind 1]\n M worlds/a.json\nA  levels/b.json\n')
  assert.equal(s.upstream, 'origin/main')
  assert.equal(s.ahead, 2)
  assert.equal(s.behind, 1)
  assert.deepEqual(s.changed, [{ code: 'M', file: 'worlds/a.json' }, { code: 'A', file: 'levels/b.json' }])
})

test('parseStatus survives a repo with no commits yet', () => {
  const s = parseStatus('## No commits yet on main\n?? a\n?? b\n')
  assert.equal(s.branch, 'main')
  assert.equal(s.untracked, 2)
})

test('a credential file is never world-readable, not even for an instant', async () => {
  const { root } = volume()
  const repo = new GitRepo(root)
  await repo.setCredential({ kind: 'https-token', host: 'github.com', username: 'rich', secret: 'ghp_secret' })
  const mode = statSync(path.join(root, '.git-credentials')).mode & 0o777
  assert.equal(mode, 0o600, `mode is ${mode.toString(8)}`)
})

test('the stored credential is reported but never returned', async () => {
  const { root } = volume()
  const repo = new GitRepo(root)
  await repo.setCredential({ kind: 'https-token', host: 'github.com', username: 'rich', secret: 'ghp_secret' })
  const info = await repo.credentialInfo()
  assert.deepEqual(info, { set: true, kind: 'https-token', host: 'github.com', username: 'rich' })
  assert.ok(!JSON.stringify(info).includes('ghp_secret'))
  // and the whole status, which is what the panel actually receives
  const st = await repo.status()
  assert.ok(!JSON.stringify(st).includes('ghp_secret'))
})

test('a credential with a newline in it is refused rather than corrupting the file', async () => {
  const { root } = volume()
  const repo = new GitRepo(root)
  await assert.rejects(() => repo.setCredential({ kind: 'https-token', host: 'github.com', username: 'a\nb', secret: 'x' }), /username/)
  await assert.rejects(() => repo.setCredential({ kind: 'https-token', host: 'github.com', username: 'a', secret: 'x\ny' }), /token/)
  await assert.rejects(() => repo.setCredential({ kind: 'https-token', host: 'not a host', username: 'a', secret: 'x' }), /host/)
})

// An Azure DevOps username IS an email address. Refusing one because it has an `@` in it is a
// restriction that comes from the writer's imagination rather than from the format: both halves
// are percent-encoded into the URL, so every character is safe but a newline.
test('an email username and a token full of punctuation still make one line git can read', async () => {
  const { root } = volume()
  const repo = new GitRepo(root)
  await repo.setCredential({ kind: 'https-token', host: 'github.com', username: 'rich@example.com', secret: 'tok@en/with:stuff' })
  const text = readFileSync(path.join(root, '.git-credentials'), 'utf8')
  assert.equal(text.trim().split('\n').length, 1)
  assert.ok(text.endsWith('@github.com\n'), text)
  const info = await repo.credentialInfo()
  assert.equal(info.host, 'github.com')
})

test('clearing a credential removes both kinds', async () => {
  const { root } = volume()
  const repo = new GitRepo(root)
  await repo.setCredential({ kind: 'https-token', host: 'github.com', username: 'rich', secret: 'x' })
  await repo.clearCredential()
  assert.deepEqual(await repo.credentialInfo(), { set: false, kind: null, host: null, username: null })
})

test('status on a volume that is not a repository says so instead of throwing', async () => {
  const { root } = volume()
  const st = await new GitRepo(root).status()
  assert.equal(st.repo, false)
  assert.equal(st.branch, null)
  assert.equal(st.error, null)
})

test('init makes a repository that commits the work and ignores the cache', async () => {
  const { root, put } = volume()
  put('worlds/crofton.json', 40)
  put('programs/rooftop.ts', 60)
  put('assets/car.glb', 1_000)
  put('cache/overpass/huge.json', 4_000_000)
  put('sites/crofton/tuning.json', 30)
  put('sites/crofton/dem_1m.tif', 2_000_000)
  const repo = new GitRepo(root)
  const st = await repo.init({ remote: 'https://github.com/hotspoons/world.git' })
  assert.equal(st.repo, true)
  assert.equal(st.remote, 'https://github.com/hotspoons/world.git')
  assert.ok(st.tracked.includes('glb'), `tracked: ${st.tracked}`)

  const c = await repo.commit('first')
  assert.ok(c, 'nothing was committed')
  const files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).trim().split('\n')
  assert.ok(files.includes('worlds/crofton.json'))
  assert.ok(files.includes('programs/rooftop.ts'))
  assert.ok(files.includes('assets/car.glb'))
  assert.ok(files.includes('sites/crofton/tuning.json'))
  // the two that would make the repository useless
  assert.ok(!files.some((f) => f.startsWith('cache/')), `cache leaked: ${files.filter((f) => f.startsWith('cache/'))}`)
  assert.ok(!files.includes('sites/crofton/dem_1m.tif'), 'the bake raster leaked')
  assert.ok(!files.includes('.git-credentials'))
})

test('committing twice with nothing changed does nothing rather than making an empty commit', async () => {
  const { root, put } = volume()
  put('worlds/a.json', 10)
  const repo = new GitRepo(root)
  await repo.init({})
  assert.ok(await repo.commit('first'))
  assert.equal(await repo.commit('again'), null)
})

test('init is idempotent and picks up a format that appeared later', async () => {
  const { root, put } = volume()
  put('worlds/a.json', 10)
  const repo = new GitRepo(root)
  await repo.init({})
  assert.ok(!(await repo.status()).tracked.includes('ktx2'))
  put('assets/tile.ktx2', 500)
  const st = await repo.init({})
  assert.ok(st.tracked.includes('ktx2'), `tracked: ${st.tracked}`)
})

test('init refuses a remote that is a command', async () => {
  const { root } = volume()
  await assert.rejects(() => new GitRepo(root).init({ remote: 'ext::sh -c id' }), /https/)
})

test('push and commit refuse before there is a repository, rather than failing obscurely', async () => {
  const { root } = volume()
  const repo = new GitRepo(root)
  await assert.rejects(() => repo.commit('x'), /not a repository/)
  await assert.rejects(() => repo.push(), /not a repository/)
})

test('push with no remote says which thing is missing', async () => {
  const { root, put } = volume()
  put('worlds/a.json', 10)
  const repo = new GitRepo(root)
  await repo.init({})
  await repo.commit('first')
  await assert.rejects(() => repo.push(), /no remote/)
})

test('AUTHORED does not name the cache or the bake rasters', () => {
  for (const p of AUTHORED) {
    assert.ok(!p.startsWith('cache'), p)
    assert.ok(p !== 'sites/', p)
  }
})
