// The types a level program is written against, as a bundle Monaco can load.
//
// Rich, 2026-09-28: "any chance we can pull in a Monaco editor or something like that to improve
// the ux for humans typing? Would be great to have a tool kit to test types and verify everything
// builds and all that too."
//
// Monaco's TypeScript worker gives real diagnostics and real completions, but only against the
// declarations it is handed — it cannot read the repo. So this emits them.
//
// GENERATED AND CHECKED IN, with a test that regenerates and compares
// (apps/corridor/test/programtypes.test.ts). The alternative is a hand-written `.d.ts` describing
// the program API, which is the same class of mistake as a hand-typed width table: it is correct
// the day it is written, and after that the editor tells an author about an API that no longer
// exists. Running tsc in the browser over the real sources is the other option and it means
// shipping the whole app's source to every page.
//
//   node scripts/gen-program-types.mjs         # rewrite the bundle
//   node scripts/gen-program-types.mjs --check # exit 1 if it is stale
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
mkdirSync(join(ROOT, 'node_modules/.tmp'), { recursive: true })
const OUT = join(ROOT, 'apps/corridor/src/generated/program-types.json')

/**
 * The modules a program may import, and therefore the roots of the declaration closure.
 *
 * `program.ts` is the API itself. The others are what its types refer to and what a program
 * reaches for when the declarative surface runs out — the components, the world, the spawn
 * helpers, the ECS config shapes.
 */
const ROOTS = [
  'game/session/program.ts', 'game/actors/actors.ts', 'game/actors/actorworld.ts', 'game/session/ecsconfig.ts', 'game/traffic/traffic.ts',
  /*
   * THE THINGS A PROGRAM NAMES. Rich, 2026-09-29: *"make sure everything is listed in the code
   * editor"*. `api.races.get(id)` hands back a `Course`, `api.traffic` talks about zones and
   * `api.stunts` about fixtures — so a program that wants to read one needs its type, and without
   * it the editor underlines a perfectly good line and offers no completion for the field you are
   * reaching for.
   */
  'game/race/races.ts', 'game/race/racerun.ts', 'game/world/zones.ts', 'game/stunt/stunts.ts', 'game/traffic/trafficsets.ts', 'game/vehicle/vehicles.ts',
  /*
   * THE HUNT PRIMITIVE. Rich, 2026-09-29: *"make sure some primitives for object hunting objectives
   * with capture survive"* the removal of Squishy Hunt and Parkour. A program is where one gets
   * built now, so its types have to be reachable from the editor or it may as well not exist.
   */
  'game/session/objectives.ts',
]

/** `@apex/program`, not `@apex/game/program`: the folder is an implementation detail. */
const modName = (r) => r.replace(/\.ts$/, '').split('/').pop()

/** Where a file lands in the virtual filesystem Monaco is given. */
const vpath = (p) => `file:///${p.split('\\').join('/')}`

function emitDeclarations() {
  // INSIDE the repo, not in /tmp: `types: ["vite/client", "webxr"]` in the base config resolves
  // by node module resolution FROM THE CONFIG FILE, so a config in the system temp directory
  // cannot see node_modules and tsc reports two missing type libraries on every run.
  const tmp = mkdtempSync(join(ROOT, 'node_modules/.tmp/corridor-dts-'))
  // the app's own tsconfig, with declarations on and nothing else changed: the point is that these
  // are the types the app actually compiles with
  const cfg = {
    extends: resolve(ROOT, 'tsconfig.base.json'),
    compilerOptions: {
      declaration: true,
      emitDeclarationOnly: true,
      noEmit: false,
      outDir: tmp,
      rootDir: resolve(ROOT, 'apps/corridor/src'),
      tsBuildInfoFile: join(tmp, 'tsbuildinfo'),
      composite: false,
      incremental: false,
      skipLibCheck: true,
    },
    include: [resolve(ROOT, 'apps/corridor/src')],
  }
  const cfgPath = join(tmp, 'tsconfig.dts.json')
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 1))
  try {
    execFileSync('npx', ['tsc', '-p', cfgPath], { cwd: ROOT, stdio: 'pipe' })
  } catch (e) {
    // emitDeclarationOnly reports errors for things it cannot name; the .d.ts files are still
    // written, and the app's own typecheck is what gates correctness. Report and carry on.
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    if (out.trim()) console.warn(`tsc said:\n${out.split('\n').slice(0, 8).join('\n')}`)
  }
  return tmp
}

/** Every relative import in a .d.ts, as a path relative to the src root. */
function importsOf(text, from) {
  const out = []
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    let p = join(dirname(from), m[1]).split('\\').join('/')
    if (!p.endsWith('.d.ts')) p += '.d.ts'
    out.push(p)
  }
  return out
}

function closure(dir) {
  const files = new Map()
  const queue = ROOTS.map((r) => r.replace(/\.ts$/, '.d.ts'))
  while (queue.length) {
    const rel = queue.shift()
    if (files.has(rel)) continue
    const abs = join(dir, rel)
    if (!existsSync(abs)) { console.warn(`no declaration emitted for ${rel}`); continue }
    const text = readFileSync(abs, 'utf8')
    files.set(rel, text)
    for (const dep of importsOf(text, rel)) queue.push(dep)
  }
  return files
}

/** bitecs ships its own declarations; a program calls addEntity, query and friends directly. */
function bitecs() {
  const base = join(ROOT, 'node_modules/bitecs/dist')
  const out = new Map()
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.d.ts')) out.set(`node_modules/bitecs/dist/${relative(base, p).split('\\').join('/')}`, readFileSync(p, 'utf8'))
    }
  }
  walk(base)
  return out
}

function build() {
  const dir = emitDeclarations()
  const libs = {}
  for (const [rel, text] of closure(dir)) libs[vpath(`corridor/${rel}`)] = text
  for (const [rel, text] of bitecs()) libs[vpath(rel)] = text
  rmSync(dir, { recursive: true, force: true })

  /*
   * A NODE_MODULES TREE, not a `paths` mapping.
   *
   * Monaco's TypeScript service runs the real resolver over the files it has been handed, and the
   * one layout it resolves a bare specifier in without argument is `node_modules`. Everything else
   * — `paths` with a baseUrl, `declare module 'x' { export * from '/y' }` — half works: the editor
   * colours the file, reports "has no exported member", and the completions are empty, which reads
   * as "the types did not load" with nothing saying which part.
   *
   * So each importable module becomes a package whose index re-exports the emitted declaration,
   * and bitecs gets the package.json that points at its own.
   */
  const alias = {}
  for (const r of ROOTS) {
    const rel = r.replace(/\.ts$/, '')
    const name = modName(r)
    if (!libs[vpath(`corridor/${rel}.d.ts`)]) continue
    // from node_modules/@apex/<name>/index.d.ts, `../../..` is the root
    libs[vpath(`node_modules/@apex/${name}/index.d.ts`)] = `export * from '../../../corridor/${rel}'\n`
    alias[`@apex/${name}`] = vpath(`corridor/${rel}.d.ts`)
  }
  libs[vpath('node_modules/bitecs/package.json')] = JSON.stringify({ name: 'bitecs', types: 'dist/core/index.d.ts' }, null, 1)

  /*
   * A hash of every SOURCE this was derived from.
   *
   * So a test can tell in a millisecond whether the bundle is stale, instead of running tsc over
   * the whole app — which takes long enough that the test would be skipped, and a stale bundle
   * means the editor describes an API that no longer exists. `--check` re-runs the real thing; the
   * test checks the hashes.
   */
  const sources = {}
  for (const uri of Object.keys(libs)) {
    const m = /^file:\/\/\/corridor\/(.+)\.d\.ts$/.exec(uri)
    if (!m) continue
    const src = join(ROOT, 'apps/corridor/src', `${m[1]}.ts`)
    if (existsSync(src)) sources[`apps/corridor/src/${m[1]}.ts`] = createHash('sha1').update(readFileSync(src)).digest('hex').slice(0, 16)
  }
  return { version: 1, generated: 'scripts/gen-program-types.mjs', sources, libs, alias, roots: ROOTS }
}

const doc = build()
const text = JSON.stringify(doc, null, 1)
if (process.argv.includes('--check')) {
  const was = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (was !== text) {
    console.log(`STALE: ${relative(ROOT, OUT)} differs from the sources — run: node scripts/gen-program-types.mjs`)
    process.exit(1)
  }
  console.log(`current: ${Object.keys(doc.libs).length} declaration files`)
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text)
  console.log(`wrote ${relative(ROOT, OUT)}: ${Object.keys(doc.libs).length} declaration files, ${(text.length / 1024).toFixed(0)} kB`)
  for (const k of Object.keys(doc.alias)) console.log(`  ${k}`)
}
