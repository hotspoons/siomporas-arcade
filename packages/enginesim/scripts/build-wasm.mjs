// Build the engine simulator to WebAssembly.
//
// Nobody needs to run this to work on the game: `wasm/` is committed, because requiring a C++
// toolchain, Flex, Bison and a 1 GB Emscripten SDK to run `npm run dev` would be a poor trade for
// a file that changes about once a quarter. Run it when the pin below moves or the binding in
// `native/` changes.
//
//   node packages/enginesim/scripts/build-wasm.mjs
//   node packages/enginesim/scripts/build-wasm.mjs --cache ~/.cache/enginesim --jobs 8
//
// It fetches a pinned Open Engine Simulator, builds its core and scripting libraries plus our
// binding, and writes `wasm/`. Host tools needed: cmake, ninja, a C++ compiler, flex, bison, git,
// python3. Emscripten it will install itself unless $EMSDK points at one.

import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, tmpdir } from 'node:os'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

/* ---- what we build against ------------------------------------------------------------------- */

// Open Engine Simulator is the community fork of AngeTheGreat's MIT engine-sim. We build against it
// rather than the original for one concrete reason: the original's browser story is a 2022 blog
// post whose patches were never published, whereas this fork carries a maintained Emscripten path
// including the lock-free realtime audio hand-off that `native/apex_enginesim.cpp` binds.
const UPSTREAM = {
  repo: 'https://github.com/zabayone/open-engine-sim.git',
  commit: '9abd876e8521a39ad3b423bf03a4b2325d4f8338',
}
const EMSDK = { repo: 'https://github.com/emscripten-core/emsdk.git', version: 'latest' }

// -msimd128 is not a micro-optimisation here. The exhaust convolution is a naive time-domain FIR
// running thousands of taps per sample per exhaust, and on the measurement box vectorising it moved
// the whole simulation from 1.24x realtime to 2.24x — the difference between crackling and not.
// -ffast-math is safe for this workload and the audio is not bit-reproducible across builds anyway.
const OPTIMISE = ['-O3', '-msimd128', '-ffast-math']

// Everything the JS side calls. KEEPALIVE in the binding would mostly cover this, but naming them
// keeps the linker honest about dead-stripping and makes the surface reviewable in one place.
const EXPORTS = [
  '_malloc', '_free',
  '_es_init', '_es_load', '_es_load_source', '_es_shutdown', '_es_error', '_es_name',
  '_es_render',
  '_es_set_pedal', '_es_set_ignition', '_es_set_starter', '_es_set_clutch', '_es_set_gear',
  '_es_set_follow_rpm', '_es_set_free', '_es_set_sim_frequency',
  '_es_set_ir_limit', '_es_ir_limit',
  '_es_set_audio_param', '_es_get_audio_param',
  '_es_rpm', '_es_pedal', '_es_manifold_pressure', '_es_vehicle_speed', '_es_gear',
  '_es_torque', '_es_power', '_es_cylinders', '_es_redline', '_es_displacement',
  '_es_sim_frequency',
]

/* ---- arguments ------------------------------------------------------------------------------- */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const cache = resolve(flag('--cache', join(tmpdir(), 'apex-enginesim-build')))
const jobs = flag('--jobs', String(Math.max(2, cpus().length)))

const step = (message) => console.log(`\n\u2500\u2500 ${message}`)
const run = (command, commandArgs, options = {}) => {
  execFileSync(command, commandArgs, { stdio: 'inherit', ...options })
}
const capture = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { encoding: 'utf8', ...options }).trim()

for (const tool of ['cmake', 'ninja', 'git', 'flex', 'bison', 'python3']) {
  try {
    capture('which', [tool])
  } catch {
    console.error(`Missing host tool: ${tool}\n` +
      '  Debian/Ubuntu: sudo apt-get install -y cmake ninja-build git flex bison python3 build-essential\n' +
      '  macOS:         brew install cmake ninja flex bison')
    process.exit(1)
  }
}

mkdirSync(cache, { recursive: true })

/* ---- sources --------------------------------------------------------------------------------- */

const upstreamDir = join(cache, 'open-engine-sim')
step(`Open Engine Simulator @ ${UPSTREAM.commit.slice(0, 10)}`)
if (!existsSync(join(upstreamDir, '.git'))) {
  run('git', ['init', '-q', upstreamDir])
  run('git', ['-C', upstreamDir, 'remote', 'add', 'origin', UPSTREAM.repo])
}
let head = null
try { head = capture('git', ['-C', upstreamDir, 'rev-parse', 'HEAD']) } catch { head = null }
if (head !== UPSTREAM.commit) {
  try {
    run('git', ['-C', upstreamDir, 'fetch', '--depth', '1', 'origin', UPSTREAM.commit])
    run('git', ['-C', upstreamDir, 'checkout', '-q', 'FETCH_HEAD'])
  } catch {
    // An older git cannot fetch a bare sha from a server without uploadpack.allowReachableSHA1.
    run('git', ['-C', upstreamDir, 'fetch', 'origin'])
    run('git', ['-C', upstreamDir, 'checkout', '-q', UPSTREAM.commit])
  }
}
run('git', ['-C', upstreamDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1'])

const emsdkDir = process.env.EMSDK || join(cache, 'emsdk')
if (!process.env.EMSDK) {
  step('Emscripten SDK')
  if (!existsSync(join(emsdkDir, 'emsdk'))) {
    run('git', ['clone', '--depth', '1', EMSDK.repo, emsdkDir])
  }
  run(join(emsdkDir, 'emsdk'), ['install', EMSDK.version])
  run(join(emsdkDir, 'emsdk'), ['activate', EMSDK.version])
}
const emscripten = join(emsdkDir, 'upstream', 'emscripten')
const emcc = join(emscripten, 'em++')
const emcmake = join(emscripten, 'emcmake')
if (!existsSync(emcc)) {
  console.error(`No em++ at ${emcc}. Set $EMSDK to an activated Emscripten SDK.`)
  process.exit(1)
}

/* ---- upstream libraries ---------------------------------------------------------------------- */

const buildDir = join(cache, 'build-wasm')
step('Configure and build engine-sim-core, scripting, piranha, solver')
run(emcmake, ['cmake',
  '-S', upstreamDir, '-B', buildDir, '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  `-DCMAKE_CXX_FLAGS_RELEASE=${OPTIMISE.join(' ')} -DNDEBUG`,
  '-DBUILD_TESTING=OFF',
  '-DENGINE_SIM_BUILD_SCRIPTING=ON',
  '-DENGINE_SIM_BUILD_DESKTOP=OFF',
  '-DENGINE_SIM_BUILD_HEADLESS=OFF',
  '-DENGINE_SIM_BUILD_WEB=OFF',
])
run('cmake', ['--build', buildDir, '--target', 'engine-sim-scripting', '-j', jobs])

const libs = [
  'libengine-sim-scripting.a',
  'libengine-sim-core.a',
  'libpiranha.a',
  'libsimple-2d-constraint-solver.a',
].map((name) => join(buildDir, name))
for (const lib of libs) {
  if (!existsSync(lib)) {
    console.error(`Expected ${lib} but the build did not produce it.`)
    process.exit(1)
  }
}

/* ---- assets ---------------------------------------------------------------------------------- */

// Only what a headless simulation reads. The shaders, fonts and authored meshes belong to
// upstream's renderer, which we do not build, and they would be dead weight inside the wasm.
step('Stage assets')
const stage = join(cache, 'stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'assets'), { recursive: true })
for (const directory of ['es', 'engines']) {
  cpSync(join(upstreamDir, 'assets', directory), join(stage, 'assets', directory),
    { recursive: true })
}
const assetBytes = (function measure(path) {
  const info = statSync(path)
  if (!info.isDirectory()) return info.size
  return readdirSync(path).reduce((total, name) => total + measure(join(path, name)), 0)
})(join(stage, 'assets'))
console.log(`   ${(assetBytes / 1e6).toFixed(2)} MB of scripts and impulse responses`)

/* ---- the binding ----------------------------------------------------------------------------- */

step('Compile the binding')
const submodules = join(upstreamDir, 'dependencies', 'submodules')
const objectFile = join(cache, 'apex_enginesim.o')
run(emcc, [
  '-std=c++17', ...OPTIMISE, '-c',
  join(packageRoot, 'native', 'apex_enginesim.cpp'), '-o', objectFile,
  // Piranha is MSVC-flavoured C++ and the solver predates its own portability fixes; these are the
  // same shims upstream's CMake applies to those targets, which our direct compile does not inherit.
  '-D__int64=long', '-D__forceinline=inline',
  '-include', join(upstreamDir, 'cmake', 'EngineSimLegacySolverCompatibility.h'),
  '-I', join(upstreamDir, 'include'),
  '-I', join(upstreamDir, 'scripting', 'include'),
  '-I', submodules,
  '-I', join(submodules, 'piranha', 'include'),
  '-I', join(submodules, 'simple-2d-constraint-solver', 'include'),
])

step('Link')
const outDir = join(packageRoot, 'wasm')
mkdirSync(outDir, { recursive: true })
const output = join(outDir, 'enginesim.js')
run(emcc, [
  ...OPTIMISE, objectFile, ...libs, '-o', output,
  '--embed-file', `${join(stage, 'assets')}@/assets`,
  // MODULARIZE gives a factory rather than top-level side effects, which is what lets the same file
  // be pulled into an AudioWorkletGlobalScope — a scope with no fetch, no document and no
  // importScripts. The host hands the factory `wasmBinary`, so no loading path is ever taken.
  '-sMODULARIZE=1',
  '-sEXPORT_NAME=createEngineSim',
  '-sENVIRONMENT=web,worker,node',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINVOKE_RUN=0',
  '--no-entry',
  '-sEXPORTED_RUNTIME_METHODS=["cwrap","HEAPF32","UTF8ToString"]',
  `-sEXPORTED_FUNCTIONS=${JSON.stringify(EXPORTS)}`,
])

// The Node probe (`measure.mjs`) requires the glue through CommonJS; the browser gets it as a
// classic script inside the worklet bundle. Same bytes, two extensions.
cpSync(output, join(outDir, 'enginesim.cjs'))

// MIT requires the notice to travel with the software, and what we ship is one opaque 1.28 MB
// binary with an engine simulator, a scripting language, a physics solver and a library of engine
// definitions inside it. The licence goes next to it, and is copied here rather than committed by
// hand so a change upstream cannot leave a stale one behind.
cpSync(join(upstreamDir, 'LICENSE'), join(outDir, 'LICENSE-engine-sim.txt'))

/* ---- the catalog ----------------------------------------------------------------------------- */

// Mirrors upstream's rule (cmake/EngineSimEngineCatalog.cmake): a script is directly runnable only
// if it declares the conventional `public node main`. Helper modules like radial.mr are imports.
step('Catalog')
const engines = []
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) { walk(path); continue }
    if (!name.endsWith('.mr')) continue
    const source = readFileSync(path, 'utf8')
    if (!/public\s+node\s+main(\s|\{|$)/m.test(source)) continue
    const relativePath = relative(join(stage, 'assets'), path).split('\\').join('/')
    const [, group, file] = relativePath.match(/^engines\/([^/]+)\/(.+)\.mr$/) ?? []
    if (!group) continue
    const titleize = (value) => value.replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
    engines.push({
      path: relativePath,
      group: titleize(group),
      name: titleize(file.replace(/^\d+_/, '')),
    })
  }
}
walk(join(stage, 'assets', 'engines'))
engines.sort((a, b) => a.path.localeCompare(b.path))
writeFileSync(join(outDir, 'engines.json'), `${JSON.stringify(engines, null, 2)}\n`)

writeFileSync(join(outDir, 'BUILD.json'), `${JSON.stringify({
  upstream: UPSTREAM,
  optimise: OPTIMISE,
  builtAt: new Date().toISOString().slice(0, 10),
}, null, 2)}\n`)

const size = (name) => `${(statSync(join(outDir, name)).size / 1e6).toFixed(2)} MB`
console.log(`\n   wasm/enginesim.wasm  ${size('enginesim.wasm')}`)
console.log(`   wasm/enginesim.js    ${size('enginesim.js')}`)
console.log(`   wasm/engines.json    ${engines.length} engines`)
console.log('\nNext: node packages/enginesim/scripts/measure.mjs')
