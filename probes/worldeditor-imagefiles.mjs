// Does everything the corridor app imports actually get into the image?
//
// `npm run build` on a laptop has the whole repo and never notices an import that reaches outside
// the app. The image's build stage has only what its Dockerfile COPYs, so the same import is a
// missing file there — and the build goes red after a push, a queue and four minutes of buildx.
//
// It has happened twice. The assetsvc image shipped with 136 specs and found none, because it
// never copied `tools/assetlib/`; then the worldeditor image failed on
// `../../../tools/assetlib/specs/buildings-dressing.json`, which the building dressing imports at
// build time and which lives with the asset library that generates it — deliberately, because a
// second copy of a spec is a spec that drifts.
//
// The RUNTIME stage has the same problem from the other direction. It ships no `npm install` on
// purpose — SigV4 by hand, the Kubernetes API by hand — so a BARE import there is only resolvable
// if the package was copied in. The agent tunnel relay added `ws` (a browser's WebSocket cannot
// send the header the platform's tunnel wants, so the service relays the bytes, and node has no
// WebSocket to do it with), the line to copy it was missing, and the service threw on the import
// at startup: `/api/health` answered nothing and the smoke test said "Unexpected end of JSON
// input" — after the image had been pushed.
//
// AND THE BINARIES. A third way to ship a feature that cannot run: shell out to something the
// image does not have. The git LFS support runs `git`, and there was no git in the image at all —
// `/api/git` answered `repo: false, lfs: false` and every action would have failed with ENOENT,
// on the one machine where the volume it pushes actually lives.
//
// So this reads the COPY and RUN lines out of both stages and checks imports and spawned binaries
// against them. Static, so it is a second, not a push and four minutes of buildx.
//
//   node probes/worldeditor-imagefiles.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCKERFILE = path.join(ROOT, 'tools/worldeditor/Dockerfile')
const APP = 'apps/corridor'

/**
 * One stage's text: `which` 0 is the build stage, -1 (or any index) the runtime stage.
 *
 * THE RUNTIME STAGE IS THE LAST ONE, not the second. The Dockerfile grew two stages in between
 * (Blender, and the rigging add-on) on 2026-09-29, and `1` quietly became the Blender copy — no
 * ENTRYPOINT, no COPYs of the service — so this probe reported "names no ENTRYPOINT script" and
 * checked nothing, while the image shipped without `typescript` (Rich, 2026-09-30: HTTP 500 on
 * the first level with a program).
 */
function stageText(dockerfile, which) {
  const text = readFileSync(dockerfile, 'utf8')
  const froms = [...text.matchAll(/^FROM /gm)].map((m) => m.index)
  const i = which < 0 ? froms.length + which : which
  const from = froms[i]
  const to = froms[i + 1] ?? text.length
  return text.slice(from, to)
}

/** What a stage COPYs in. `--from=` sources are destinations in this stage, so they count too. */
function copiedPaths(stage) {
  const out = []
  for (const line of stage.split('\n')) {
    const m = /^COPY\s+(?:--from=(\S+)\s+)?(.+)$/.exec(line.trim())
    if (!m) continue
    const parts = m[2].split(/\s+/)
    if (m[1]) {
      // from another stage: the DESTINATION is what this stage ends up holding
      out.push({ from: m[1], src: parts[0], dest: parts[parts.length - 1].replace(/\/$/, '') })
      continue
    }
    for (const src of parts.slice(0, -1)) out.push({ src: src.replace(/\/$/, ''), dest: parts[parts.length - 1].replace(/\/$/, '') })
  }
  return out
}

/** Is this repo-relative path inside something the stage copied? */
function isCopied(rel, copied) {
  return copied.map((x) => x.src).some((c) => {
    if (c.includes('*')) {
      const re = new RegExp('^' + c.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
      return re.test(rel)
    }
    return rel === c || rel.startsWith(`${c}/`)
  })
}

/**
 * Every import specifier in a file: static, side-effect and dynamic.
 *
 * LINE-ANCHORED for the static forms, because `from '` and `import '` occur in prose all over
 * this codebase's comments — the first version of this reported that the service imports `go` and
 * `' && req.method === '`, having found them in a sentence.
 */
function specifiers(text) {
  const out = []
  for (const m of text.matchAll(/^\s*(?:export\s+\*\s+from|export\s+\{[^}]*\}\s*from|import\s+(?:[^'"()]*?\s+from\s+)?)['"]([^'"]+)['"]/gm)) out.push(m[1])
  // dynamic, which can legitimately sit mid-line — `(?<!\w)` keeps it off `.import(`
  for (const m of text.matchAll(/(?<![\w.])import\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  // and a CommonJS require, which is how programs.mjs loads TypeScript lazily — it is every bit
  // as much a dependency as an import, and it was the one the image was missing
  for (const m of text.matchAll(/(?<![\w.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/** Every source file under the app that a bundler would follow. */
function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx|js|mjs|css|html)$/.test(name)) out.push(p)
  }
  return out
}

const copied = copiedPaths(stageText(DOCKERFILE, 0))
const files = [
  ...sources(path.join(ROOT, APP, 'src')),
  ...readdirSync(path.join(ROOT, APP)).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, APP, f)),
]

const fail = []
const escaping = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // relative specifiers only: a bare one is a package and npm ci put it there
  for (const raw of specifiers(text)) {
    if (!raw.startsWith('.')) continue // a bare one is a package and npm ci put it there
    const spec = raw.split('?')[0]
    const abs = path.resolve(path.dirname(file), spec)
    const rel = path.relative(ROOT, abs)
    if (rel.startsWith(`${APP}/`) || rel.startsWith('..')) continue // inside the app, or outside the repo
    escaping.push({ from: path.relative(ROOT, file), rel })
    // the import may omit its extension
    const found = [rel, `${rel}.ts`, `${rel}.js`, `${rel}.json`, `${rel}/index.ts`].find((c) => existsSync(path.join(ROOT, c)))
    if (!found) { fail.push(`${path.relative(ROOT, file)} imports ${spec}, which does not exist`); continue }
    if (!isCopied(found, copied)) {
      fail.push(`${path.relative(ROOT, file)} imports ${found}, which the image's build stage never copies`)
    }
  }
}

console.log(`Dockerfile copies ${copied.length} paths into the build stage`)
console.log(`${files.length} source files; ${escaping.length} imports reach outside ${APP}/`)
for (const e of escaping) console.log(`  ${e.rel.padEnd(52)} ← ${e.from}`)
// a run that found no escaping imports proves nothing: the check would pass on a repo where the
// scan is broken, which is exactly how this would rot
if (!escaping.length) {
  console.log('\nFAIL: no import reaches outside the app — either the scanner is broken or this check is no longer needed')
  process.exit(1)
}
/* ---- the runtime stage: a bare import needs its package copied in ------------------------- */

const runtime = copiedPaths(stageText(DOCKERFILE, -1))

/**
 * What the service actually loads, from its ENTRYPOINT outwards.
 *
 * The import graph and not a glob of the directory: `probe.mjs` sits beside the service and
 * imports playwright, and a glob calls that a missing dependency. Reachability is the real
 * question — "what does the running service need" — and it also catches a new file added to the
 * graph with a new dependency, which a hand-kept list would not.
 *
 * The entrypoint is read from the Dockerfile for the same reason everything else here is.
 */
function entrypointOf(stage) {
  const m = /^ENTRYPOINT\s+\[(.+)\]/m.exec(stage)
  if (!m) return null
  const args = m[1].split(',').map((a) => a.trim().replace(/^"|"$/g, ''))
  return args.find((a) => a.endsWith('.mjs') || a.endsWith('.js')) ?? null
}

function reachable(entry) {
  const seen = new Set()
  const bare = new Set()
  const queue = [path.join(ROOT, entry)]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) { bare.add(spec); continue }
      const abs = path.resolve(path.dirname(file), spec)
      queue.push(...[abs, `${abs}.mjs`, `${abs}.js`, path.join(abs, 'index.mjs')].filter(existsSync))
    }
  }
  return { files: seen, bare }
}

const entry = entrypointOf(stageText(DOCKERFILE, -1))
if (!entry) {
  fail.push('the Dockerfile names no ENTRYPOINT script, so nothing could be traced')
}
const { files: serviceFiles, bare } = entry ? reachable(entry) : { files: new Set(), bare: new Set() }
// a package is available only if some COPY lands it under node_modules/
const packaged = new Set(
  runtime.filter((c) => /(^|\/)node_modules\//.test(c.dest)).map((c) => c.dest.replace(/^.*node_modules\//, '').replace(/\/$/, '')),
)
console.log(`\n${entry} reaches ${serviceFiles.size} files and imports ${bare.size} packages`)
for (const b of [...bare].sort()) {
  const ok = [...packaged].some((pkg) => b === pkg || b.startsWith(`${pkg}/`))
  console.log(`  ${b.padEnd(52)} ${ok ? 'copied in' : 'NOT IN THE IMAGE'}`)
  if (!ok) fail.push(`${entry} reaches an import of '${b}', which the runtime stage never copies — the service throws on startup`)
}
/*
 * FILES THE SERVICE READS BY PATH, not by import: a `readFile` of something two directories up is
 * invisible to the graph walk and was the third way this image shipped a feature that could not
 * run (program_check: ENOENT on the declaration bundle, 2026-09-30).
 */
const READ_BY_PATH = ['apps/corridor/src/generated/program-types.json', 'packages/enginesim/wasm/engines.json']
for (const f of READ_BY_PATH) {
  const ok = runtime.some((c) => c.src === f || c.dest === f || f.startsWith(`${c.src}/`) || f.startsWith(`${c.dest}/`))
  console.log(`  ${f.padEnd(52)} ${ok ? 'copied in' : 'NOT IN THE IMAGE'}`)
  if (!ok) fail.push(`the service reads ${f} by path and the runtime stage never copies it`)
}
// this half of the check is worth nothing if the graph walk found nothing
if (entry && serviceFiles.size < 5) {
  fail.push(`only ${serviceFiles.size} files were reached from ${entry} — the import graph walk is broken`)
}

/* ---- the binaries the service shells out to ----------------------------------------------- */

/** What an `apt-get install` in the runtime stage puts on the PATH. */
function installed(stage) {
  const out = new Set()
  // a RUN can be line-continued, so the whole stage is searched rather than line by line
  for (const m of stage.matchAll(/apt-get\s+install[^\n]*(?:\\\n[^\n]*)*/g)) {
    const words = m[0].replace(/\\\n/g, ' ').split(/\s+/)
    for (const w of words) {
      if (/^-/.test(w) || /^\\$/.test(w) || ['apt-get', 'install', '&&', 'RUN'].includes(w)) continue
      out.add(w)
    }
  }
  return out
}

/** Every binary a reachable service file spawns by a literal name. */
function spawned(files) {
  const out = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"]([^'"/]+)['"]/g)) {
      out.set(m[1], path.relative(ROOT, file))
    }
    // `run('git', …)` and friends: a promisified execFile behind a one-word alias
    for (const m of text.matchAll(/\brun\s*\(\s*['"]([a-z][\w-]*)['"]\s*,\s*\[/g)) {
      out.set(m[1], path.relative(ROOT, file))
    }
  }
  return out
}

const runtimeStage = stageText(DOCKERFILE, -1)
const pkgs = installed(runtimeStage)
const bins = spawned([...serviceFiles])
// node is the ENTRYPOINT's own interpreter; the bake's python runs in another image entirely, as a
// Job this service creates, and `kubectl` is only used by the preflight probe on a developer's box
const PROVIDED = new Set(['node', 'npm', 'sh', 'python', 'python3', 'kubectl'])
console.log(`\nthe runtime stage installs [${[...pkgs].join(', ') || 'nothing'}]; the service spawns ${bins.size} binaries`)
for (const [bin, from] of [...bins].sort()) {
  if (PROVIDED.has(bin)) { console.log(`  ${bin.padEnd(52)} provided`); continue }
  // a package name is usually the binary name; git-lfs ships `git lfs` as a git subcommand
  const ok = pkgs.has(bin) || [...pkgs].some((pkg) => pkg === bin || pkg.startsWith(`${bin}-`))
  console.log(`  ${bin.padEnd(52)} ${ok ? 'installed' : 'NOT IN THE IMAGE'}  ← ${from}`)
  if (!ok) fail.push(`${from} spawns '${bin}', which the runtime stage never installs — the feature fails with ENOENT`)
}

if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: every import, package and binary the app and service need is in the image')
