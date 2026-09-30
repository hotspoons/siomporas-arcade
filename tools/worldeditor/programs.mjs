// A level program, built and checked on the SERVER.
//
// The editor's Program pane does both of these in the browser, with Monaco's TypeScript worker and
// the generated declaration bundle. That is right for a person typing. It is wrong for an agent
// with no tab open and for the viewer, which needs the JavaScript of a program a level names and
// should not have to carry a TypeScript compiler to get it. So the same two questions — does it
// compile, does it typecheck — are answered here, against the SAME bundle
// (apps/corridor/src/generated/program-types.json), so the squiggles and this agree.
//
// The bundle is a virtual filesystem: `file:///node_modules/@apex/program/index.d.ts` and the
// bitecs declarations beside it. Rooted at `/` with node resolution, `import ... from
// '@apex/program'` resolves exactly as it would in a repo, without one.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '../../apps/corridor/src/generated/program-types.json')

let tsMod = null
function ts() {
  if (!tsMod) tsMod = require('typescript')
  return tsMod
}

let libs = null
async function bundle() {
  if (!libs) {
    const doc = JSON.parse(await readFile(BUNDLE, 'utf8'))
    libs = new Map()
    for (const [url, text] of Object.entries(doc.libs)) libs.set(url.replace(/^file:\/\//, ''), text)
  }
  return libs
}

/**
 * The importable modules, by name: `@apex/program` is `program`, and so on. What `program_api`
 * offers, read off the bundle rather than listed here so a new root in gen-program-types.mjs
 * appears without a second edit.
 */
export async function modules() {
  const libs = await bundle()
  return [...libs.keys()].filter((k) => /^\/corridor\/[a-z]+\.d\.ts$/.test(k)).map((k) => k.slice('/corridor/'.length, -'.d.ts'.length)).sort()
}

/**
 * One module's declarations as text — the program API an agent is written against. Rich,
 * 2026-09-30: an agent had to read program.ts out of the repository to learn what `api` could do.
 */
export async function declarations(mod = 'program') {
  const name = String(mod).replace(/^@apex\//, '').replace(/\.d\.ts$/, '')
  const libs = await bundle()
  const text = libs.get(`/corridor/${name}.d.ts`)
  if (text === undefined) throw Object.assign(new Error(`no module "${mod}" — one of ${(await modules()).join(', ')}`), { status: 404 })
  return { module: name, import: `@apex/${name}`, text }
}

/** A short hash of the whole bundle: which API this build checks against. */
export async function apiHash() {
  const { createHash } = await import('node:crypto')
  const h = createHash('sha1')
  for (const [k, v] of [...(await bundle()).entries()].sort()) h.update(k).update('\0').update(v).update('\0')
  return h.digest('hex').slice(0, 12)
}

/** TypeScript to JavaScript, no checking. What the viewer runs. */
export function transpile(source, fileName = 'program.ts') {
  const T = ts()
  const out = T.transpileModule(source, {
    fileName,
    compilerOptions: { module: T.ModuleKind.ESNext, target: T.ScriptTarget.ES2022, sourceMap: false, importsNotUsedAsValues: 0 },
    reportDiagnostics: true,
  })
  const errors = (out.diagnostics ?? []).map((d) => describe(T, d))
  return { js: out.outputText, errors }
}

/**
 * Typecheck one program against the declarations. Returns every diagnostic, with lines.
 *
 * `strict` is on, as it is in the pane: a program that passes here passes there.
 */
export async function check(source, programPath = 'program.ts') {
  const T = ts()
  const files = await bundle()
  const main = '/programs/' + programPath.replace(/^\/+/, '')
  const all = new Map(files)
  all.set(main, source)
  const options = {
    strict: true,
    noEmit: true,
    target: T.ScriptTarget.ES2022,
    module: T.ModuleKind.ESNext,
    moduleResolution: T.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
    allowImportingTsExtensions: true,
  }
  const defaultLibDir = path.dirname(T.getDefaultLibFilePath(options))
  const host = {
    getSourceFile(name, lang) {
      const text = readText(name)
      return text === undefined ? undefined : T.createSourceFile(name, text, lang, true)
    },
    getDefaultLibFileName: (o) => path.join(defaultLibDir, T.getDefaultLibFileName(o)),
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => readText(name) !== undefined,
    readFile: (name) => readText(name),
    directoryExists: (dir) => {
      if (dir === '/' || dir === '') return true
      const p = dir.endsWith('/') ? dir : dir + '/'
      for (const k of all.keys()) if (k.startsWith(p)) return true
      return dir.startsWith(defaultLibDir)
    },
    getDirectories: () => [],
  }
  function readText(name) {
    if (all.has(name)) return all.get(name)
    if (name.startsWith(defaultLibDir)) {
      try { return T.sys.readFile(name) } catch { return undefined }
    }
    return undefined
  }
  const program = T.createProgram([main], options, host)
  const diags = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(), ...program.getOptionsDiagnostics()]
  const problems = diags.map((d) => describe(T, d)).filter((d) => d.file !== null && !d.file.startsWith('/node_modules/'))
  return { ok: problems.every((p) => p.category !== 'error'), problems }
}

function describe(T, d) {
  const message = T.flattenDiagnosticMessageText(d.messageText, '\n')
  const category = T.DiagnosticCategory[d.category].toLowerCase()
  if (!d.file || d.start === undefined) return { file: d.file?.fileName ?? null, line: null, col: null, category, message, code: d.code }
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
  return { file: d.file.fileName, line: line + 1, col: character + 1, category, message, code: d.code }
}
