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
// So this reads the COPY lines out of the Dockerfile and checks every import that leaves the app
// against them. Static, so it is a second, not four minutes.
//
//   node probes/worldeditor-imagefiles.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCKERFILE = path.join(ROOT, 'tools/worldeditor/Dockerfile')
const APP = 'apps/corridor'

/** The paths the Dockerfile's FIRST stage copies in — the one that runs `vite build`. */
function copiedPaths(dockerfile) {
  const text = readFileSync(dockerfile, 'utf8')
  // everything up to the second FROM: the build stage
  const stage = text.slice(0, text.indexOf('\nFROM ', text.indexOf('\nFROM ') + 1) + 1)
  const out = []
  for (const line of stage.split('\n')) {
    const m = /^COPY\s+(?:--from=\S+\s+)?(.+)$/.exec(line.trim())
    if (!m) continue
    const parts = m[1].split(/\s+/)
    for (const src of parts.slice(0, -1)) out.push(src.replace(/\/$/, ''))
  }
  return out
}

/** Is this repo-relative path inside something the build stage copied? */
function isCopied(rel, copied) {
  return copied.some((c) => {
    if (c.includes('*')) {
      const re = new RegExp('^' + c.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
      return re.test(rel)
    }
    return rel === c || rel.startsWith(`${c}/`)
  })
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

const copied = copiedPaths(DOCKERFILE)
const files = [
  ...sources(path.join(ROOT, APP, 'src')),
  ...readdirSync(path.join(ROOT, APP)).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, APP, f)),
]

const fail = []
const escaping = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // relative specifiers only: a bare one is a package and npm ci put it there
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const spec = m[1].split('?')[0]
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
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: every import that leaves the app is copied into the image')
