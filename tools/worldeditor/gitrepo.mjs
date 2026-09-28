// Putting a world's code and assets in a git repo, with LFS for the big parts.
//
// Rich, 2026-09-28: "being able to hook the games code base and assets up to a git lfs repo would
// be a nice touch. We'll need a way to manage git credentials to push to a remote repo."
//
// WHAT GOES IN, AND WHAT EMPHATICALLY DOES NOT. The data volume is 64 GB on this machine and 56 GB
// of that is `cache/` — Overpass responses, NAIP tiles, DEM downloads. Every byte of it is
// re-fetchable and none of it is anybody's work. Committing it would be a repository nobody can
// clone to preserve something that a re-bake reproduces.
//
// So the default is the AUTHORED half: the worlds, the levels, the programs, the presets and the
// tuning somebody wrote, plus the asset library. The bake output is opt-in, because a bake is a
// derived artefact — and when it is opted into, it is the reason LFS is here at all.
//
// CREDENTIALS NEVER REACH THE BROWSER. They are written once, server-side, into a file the git
// credential helper reads, and every read path returns whether one is set and what host it is for
// — never the token. A panel that can display a token is a panel that puts it in a screenshot.
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * What is committed by default: what a person made, not what a machine derived.
 *
 * `sites/` is in as a PATTERN rather than wholesale — the bake writes gigabytes of raster into the
 * same directory the editor writes tuning.json and presets.json into, and only the second is work.
 */
export const AUTHORED = [
  'worlds/',
  'levels/',
  'programs/',
  'places/',
  'assets/',
  'sites/*/tuning.json',
  'sites/*/presets.json',
  'sites/*/placements.json',
  'sites/*/adjustments.json',
  'sites/*/structures.json',
  'sites/*/dead_ends.json',
]

/** Never, under any setting: re-fetchable downloads and things with no meaning off this machine. */
export const NEVER = ['cache/', 'runs/', '*.log', '.git-credentials', '.gitcreds', 'node_modules/', '.DS_Store']

/**
 * Extensions that go to LFS when they are present.
 *
 * NOT a guess at what a game holds — these are the formats this pipeline actually writes, read off
 * the volume by `scan()` before anything is committed, so a repository is set up for what is
 * really in it. The list is what `scan` MAY match; what ends up in .gitattributes is what it found.
 */
export const LFS_EXTENSIONS = [
  // rasters and terrain
  'tif', 'tiff', 'png', 'jpg', 'jpeg', 'webp', 'ktx2', 'basis', 'exr', 'hdr', 'npy',
  // geometry and captures
  'glb', 'gltf', 'ply', 'splat', 'ksplat', 'fbx', 'obj', 'blend', 'usdz', 'drc',
  // audio, video, containers
  'wav', 'mp3', 'ogg', 'mp4', 'mov', 'zip', 'tar', 'gz', 'pack', 'bin', 'onnx', 'safetensors',
]

/** Anything at least this big goes to LFS whatever its extension, because something is wrong. */
export const BIG_FILE_BYTES = 8 * 1024 * 1024

const SAFE_REMOTE = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+?)(\.git)?$|^(git@[\w.-]+:[\w./~-]+?)(\.git)?$/

/** A remote URL we are willing to hand to git. Rejects everything that is not an https or ssh URL. */
export function validRemote(url) {
  if (typeof url !== 'string' || !url.trim()) return 'give it a remote URL'
  if (url.length > 512) return 'that URL is too long'
  // `ext::`, `file://`, `--upload-pack=` and friends are how a URL becomes command execution
  if (/^[a-z+]*::|^-|\s/i.test(url)) return 'only https:// and git@host:path remotes are accepted'
  if (!SAFE_REMOTE.test(url.trim())) return 'only https:// and git@host:path remotes are accepted'
  return null
}

/** The host a credential is for, so a panel can say what is stored without showing it. */
export function hostOf(url) {
  const m = /^https:\/\/([\w.-]+)/.exec(url ?? '') ?? /^git@([\w.-]+):/.exec(url ?? '')
  return m ? m[1] : null
}

/**
 * What is actually on the volume, by extension.
 *
 * Measured, not assumed. The .gitattributes this produces covers the formats that are really
 * there, and the report is what the panel shows before anybody presses anything — "this will put
 * 4.2 GB of .ktx2 through LFS" is a thing to know first.
 */
export async function scan(root, includes = AUTHORED, { limit = 200_000, bakes = false } = {}) {
  const byExt = new Map()
  let files = 0
  let bytes = 0
  let big = 0
  const roots = new Set(includes.map((i) => i.split('/')[0]).filter(Boolean))

  /*
   * THE SAME FILTER THE IGNORE FILE APPLIES.
   *
   * `sites/` holds both halves: the bake writes gigabytes of raster into the directory the editor
   * writes tuning.json and presets.json into. Walking the directory wholesale made the panel's
   * "what would be committed" report 6.7 MB where the commit was 3 — which is the wrong direction
   * for a number somebody reads before deciding whether to push over a hotel connection.
   */
  const authoredNames = new Set(
    includes.filter((i) => i.includes('*')).map((i) => i.split('/').pop()),
  )
  const globbed = new Set(includes.filter((i) => i.includes('*')).map((i) => i.split('/')[0]))

  for (const dir of roots) {
    const abs = path.join(root, dir.replace(/\/.*$/, ''))
    if (!existsSync(abs)) continue
    const stack = [abs]
    while (stack.length && files < limit) {
      const d = stack.pop()
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        if (!e.isFile()) continue
        // inside a globbed root, only the named documents count unless the bake was asked for
        if (!bakes && globbed.has(dir.replace(/\/.*$/, '')) && !authoredNames.has(e.name)) continue
        const st = await stat(p).catch(() => null)
        if (!st) continue
        files += 1
        bytes += st.size
        if (st.size >= BIG_FILE_BYTES) big += 1
        const ext = (path.extname(e.name).slice(1) || '(none)').toLowerCase()
        const row = byExt.get(ext) ?? { ext, files: 0, bytes: 0, lfs: LFS_EXTENSIONS.includes(ext) }
        row.files += 1
        row.bytes += st.size
        if (st.size >= BIG_FILE_BYTES) row.lfs = true
        byExt.set(ext, row)
      }
    }
  }
  const exts = [...byExt.values()].sort((a, b) => b.bytes - a.bytes)
  return {
    files,
    bytes,
    big,
    exts,
    lfs: exts.filter((e) => e.lfs && e.ext !== '(none)').map((e) => e.ext),
    truncated: files >= limit,
  }
}

/** The `.gitattributes` for what `scan` found, or the empty string when nothing needs LFS. */
export function gitattributes(lfsExts) {
  if (!lfsExts.length) return ''
  const lines = [
    '# Written by the world editor (tools/worldeditor/gitrepo.mjs).',
    '# These are the formats actually present on this volume, not a guess at what a game holds.',
    '',
    ...[...lfsExts].sort().map((e) => `*.${e} filter=lfs diff=lfs merge=lfs -text`),
    '',
  ]
  return lines.join('\n')
}

/** The `.gitignore`: everything re-fetchable, plus the bake output unless it was asked for. */
export function gitignore({ bakes = false } = {}) {
  const lines = [
    '# Written by the world editor (tools/worldeditor/gitrepo.mjs).',
    '# cache/ is re-fetchable downloads — 56 GB of Overpass, NAIP and DEM on the machine this was',
    '# written on. A repository nobody can clone does not preserve anything.',
    ...NEVER.map((p) => p),
  ]
  if (!bakes) {
    lines.push(
      '',
      '# The bake output. Derived from the world definition, reproducible by re-baking, and the',
      '# reason this volume is measured in gigabytes. Turn `bakes` on to include it — that is what',
      '# LFS is here for — and expect the push to take a while.',
      'sites/**',
      '!sites/*/',
      '!sites/*/tuning.json',
      '!sites/*/presets.json',
      '!sites/*/placements.json',
      '!sites/*/adjustments.json',
      '!sites/*/structures.json',
      '!sites/*/dead_ends.json',
      'splats/**',
    )
  }
  return `${lines.join('\n')}\n`
}

/** Parse `git status --porcelain=v1 -b` into something a panel can show. */
export function parseStatus(text) {
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, changed: [], untracked: 0 }
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      // `main...origin/main [ahead 2, behind 1]`, or `No commits yet on main`
      const m = /^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.+)\])?/.exec(head)
      if (m) {
        out.branch = m[1] === 'HEAD' ? null : m[1]
        out.upstream = m[2] ?? null
        const a = /ahead (\d+)/.exec(m[3] ?? '')
        const b = /behind (\d+)/.exec(m[3] ?? '')
        out.ahead = a ? Number(a[1]) : 0
        out.behind = b ? Number(b[1]) : 0
      }
      continue
    }
    const code = line.slice(0, 2)
    const file = line.slice(3)
    if (code === '??') { out.untracked += 1; continue }
    out.changed.push({ code: code.trim(), file })
  }
  return out
}

/* ---- the repository ----------------------------------------------------------------------- */

/**
 * A git repository on the data volume.
 *
 * Every git call goes through `git()`, which passes the credential configuration on the COMMAND
 * LINE with `-c` rather than writing it into the repo's config. The repo config is on a shared
 * volume and is readable by anything else that mounts it; the command line is this process.
 */
export class GitRepo {
  constructor(root, { env = process.env } = {}) {
    this.root = path.resolve(root)
    this.env = env
    this.credFile = path.join(this.root, '.git-credentials')
    this.keyFile = path.join(this.root, '.git-ssh-key')
  }

  async git(args, { timeoutMs = 120_000, input } = {}) {
    const cfg = []
    if (existsSync(this.credFile)) cfg.push('-c', `credential.helper=store --file=${this.credFile}`)
    // never prompt: a git that asks for a password on a server hangs until the timeout, which
    // looks exactly like a slow network and is not
    const env = { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' }
    if (existsSync(this.keyFile)) env.GIT_SSH_COMMAND = `ssh -i ${this.keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`
    const { stdout, stderr } = await run('git', ['-C', this.root, ...cfg, ...args], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, input })
    return { stdout, stderr }
  }

  get isRepo() {
    return existsSync(path.join(this.root, '.git'))
  }

  /** Everything a panel needs, and nothing that must not leave the server. */
  async status() {
    const out = {
      root: this.root,
      repo: this.isRepo,
      lfs: await lfsAvailable(),
      credential: await this.credentialInfo(),
      remote: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changed: [],
      untracked: 0,
      lastCommit: null,
      tracked: [],
      error: null,
    }
    if (!out.repo) return out
    try {
      out.remote = (await this.git(['remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }))).stdout.trim() || null
      Object.assign(out, parseStatus((await this.git(['status', '--porcelain=v1', '-b'])).stdout))
      const log = await this.git(['log', '-1', '--format=%h %ci %s']).catch(() => ({ stdout: '' }))
      out.lastCommit = log.stdout.trim() || null
      const attrs = await readFile(path.join(this.root, '.gitattributes'), 'utf8').catch(() => '')
      out.tracked = [...attrs.matchAll(/^\*\.(\w+) filter=lfs/gm)].map((m) => m[1])
    } catch (e) {
      out.error = String(e.stderr || e.message || e).slice(0, 400)
    }
    return out
  }

  /** Whether a credential is stored, for which host — never the credential. */
  async credentialInfo() {
    const ssh = existsSync(this.keyFile)
    if (!existsSync(this.credFile)) return { set: ssh, kind: ssh ? 'ssh-key' : null, host: null, username: null }
    const text = await readFile(this.credFile, 'utf8').catch(() => '')
    const m = /^https:\/\/([^:]+):[^@]*@(.+)$/m.exec(text.trim())
    return { set: true, kind: 'https-token', host: m?.[2] ?? null, username: m?.[1] ?? null }
  }

  /**
   * Store a credential. Write-only: nothing reads it back out of here.
   *
   * 0600 before anything is written into it — creating the file and then narrowing it leaves a
   * window in which a token is world-readable on a shared volume, which is the whole thing this
   * is trying not to do.
   */
  async setCredential({ kind, host, username, secret }) {
    if (kind === 'ssh-key') {
      if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(secret ?? '')) throw bad('that does not look like a private key')
      await writeFile(this.keyFile, '', { mode: 0o600 })
      await chmod(this.keyFile, 0o600)
      await writeFile(this.keyFile, secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 })
      return { set: true, kind: 'ssh-key' }
    }
    if (!host || !/^[\w.-]+(:\d+)?$/.test(host)) throw bad('give it a host, like github.com')
    // the username and the token are percent-encoded into the URL, so `@`, `:` and `/` are all
    // safe — an Azure DevOps username IS an email address, and refusing one because it has an `@`
    // is a restriction from the writer's imagination rather than from the format
    if (!username || /[\n\r]/.test(username)) throw bad('give it a username')
    if (!secret || /[\n\r]/.test(secret)) throw bad('give it a token')
    await writeFile(this.credFile, '', { mode: 0o600 })
    await chmod(this.credFile, 0o600)
    await writeFile(this.credFile, `https://${encodeURIComponent(username)}:${encodeURIComponent(secret)}@${host}\n`, { mode: 0o600 })
    return { set: true, kind: 'https-token', host, username }
  }

  async clearCredential() {
    await rm(this.credFile, { force: true })
    await rm(this.keyFile, { force: true })
    return { set: false }
  }

  /**
   * Make it a repository: git init, the ignore and attribute files, LFS, and the remote.
   *
   * Idempotent. Running it again on an existing repo rewrites the generated files and updates the
   * remote, which is what "I added a new asset format" and "we moved the repo" both look like.
   */
  async init({ remote, branch = 'main', bakes = false, name = 'corridor', email = 'corridor@localhost' } = {}) {
    if (remote) {
      const why = validRemote(remote)
      if (why) throw bad(why)
    }
    await mkdir(this.root, { recursive: true })
    if (!this.isRepo) await run('git', ['-C', this.root, 'init', '-b', branch], { env: this.env })
    await this.git(['config', 'user.name', name])
    await this.git(['config', 'user.email', email])
    const found = await scan(this.root, AUTHORED, { bakes })
    await writeFile(path.join(this.root, '.gitignore'), gitignore({ bakes }))
    const attrs = gitattributes(found.lfs)
    if (attrs) await writeFile(path.join(this.root, '.gitattributes'), attrs)
    if (attrs && (await lfsAvailable())) {
      // --local, so this never touches whatever the machine's global git config is
      await this.git(['lfs', 'install', '--local']).catch(() => {})
      if (found.lfs.length) await this.git(['lfs', 'track', ...found.lfs.map((e) => `*.${e}`)]).catch(() => {})
    }
    if (remote) {
      const has = await this.git(['remote', 'get-url', 'origin']).then(() => true).catch(() => false)
      await this.git(['remote', has ? 'set-url' : 'add', 'origin', remote])
    }
    return { ...(await this.status()), scan: found }
  }

  /** Stage everything the ignore file allows and commit it. `null` when there was nothing to do. */
  async commit(message) {
    if (!this.isRepo) throw bad('this volume is not a repository yet')
    if (!message || !String(message).trim()) throw bad('give the commit a message')
    await this.git(['add', '-A'])
    const staged = (await this.git(['diff', '--cached', '--name-only'])).stdout.trim()
    if (!staged) return null
    await this.git(['commit', '-m', String(message).slice(0, 4000)])
    const log = (await this.git(['log', '-1', '--format=%h %s'])).stdout.trim()
    return { commit: log, files: staged.split('\n').length }
  }

  /** Push, and say plainly what git said when it will not. */
  async push({ branch } = {}) {
    if (!this.isRepo) throw bad('this volume is not a repository yet')
    const st = await this.status()
    if (!st.remote) throw bad('no remote is set — add one first')
    const b = branch ?? st.branch
    if (!b) throw bad('there is nothing committed to push yet')
    try {
      const { stdout, stderr } = await this.git(['push', '-u', 'origin', b], { timeoutMs: 30 * 60_000 })
      return { ok: true, branch: b, output: `${stdout}${stderr}`.trim().slice(0, 4000) }
    } catch (e) {
      // the two that actually happen, named rather than left as a wall of git output
      const text = String(e.stderr || e.message || e)
      if (/Authentication failed|could not read Username|Permission denied/i.test(text)) {
        throw bad('the remote refused the credential — check the token and that it may write to this repository', 401)
      }
      if (/rejected.*(fetch first|non-fast-forward)/is.test(text)) {
        throw bad('the remote has commits this volume does not — pull first', 409)
      }
      throw bad(text.slice(0, 1000), 502)
    }
  }

  async pull() {
    if (!this.isRepo) throw bad('this volume is not a repository yet')
    const { stdout, stderr } = await this.git(['pull', '--ff-only'], { timeoutMs: 30 * 60_000 })
    return { output: `${stdout}${stderr}`.trim().slice(0, 4000) }
  }
}

let lfsCached = null
/** Is git-lfs on this machine? Asked once: it is a process spawn and the answer does not change. */
export async function lfsAvailable() {
  if (lfsCached !== null) return lfsCached
  lfsCached = await run('git', ['lfs', 'version']).then(() => true).catch(() => false)
  return lfsCached
}

function bad(msg, status = 400) {
  return Object.assign(new Error(msg), { status })
}
