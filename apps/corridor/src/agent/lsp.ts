// The TypeScript service, headless, for an agent that is not looking at the screen.
//
// WHY NOT `CodeEditor.check()`. That one belongs to a mounted editor and a model somebody opened —
// it answers about the file a person is looking at. An agent asks about a file nobody has opened,
// often one it wrote a second ago, and it asks about ten of them in a row. So this drives the same
// worker without an editor: create the model, ask, done.
//
// IT IS THE SAME COMPILATION, which is the point. `knowAbout` puts every program on the volume
// into the model set, and the program API's declarations are already loaded by `loadMonaco`, so a
// diagnostic here is the diagnostic the person sees — not a second opinion from a bare tsc that
// does not know what `api.physics` is.
//
// WHAT AN AGENT ACTUALLY NEEDS, and it is not "an AST". Rich asked for "an AST view of the code so
// you can make clean edits", and the raw syntax tree is the wrong shape for that: it is enormous,
// it is mostly punctuation, and an agent that reads one still has to guess where a symbol is used.
// What makes an edit clean is knowing the declarations and their spans (outline), what a name
// means (hover), where it is defined (definition) and whether the result compiles (check). Those
// are what this exposes.
import { knowAbout, languageForPath, loadMonaco } from '../ui/codeeditor'

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export interface OutlineNode {
  name: string
  kind: string
  line: number
  endLine: number
  children?: OutlineNode[]
}

const uriFor = async (path: string) => {
  const monaco = await loadMonaco()
  return monaco.Uri.parse(`file:///${path.replace(/^\/+/, '')}`)
}

/**
 * The worker, once it exists.
 *
 * `setupTypeScript` is attached to `onLanguage('typescript')` and its body is an async import, so
 * the service is not ready when the first model is created — asking too early rejects with the
 * string "TypeScript not registered!" and the caller sees an editor with no problems at all rather
 * than an error. There is no event to await. Same wait as CodeEditor.service(), for the same
 * reason; if that ever gets an event, both should use it.
 */
async function service() {
  const monaco = await loadMonaco()
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return await monaco.ts.getTypeScriptWorker()
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`the TypeScript service never started: ${String(e)}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

/**
 * Ensure the file is in the compilation, with this text.
 *
 * An OPEN file's buffer is the truth — `knowAbout` refuses to overwrite one, deliberately, so an
 * agent cannot silently discard somebody's unsaved edits. When the caller passes text for a file
 * that is open, the model is left alone and the diagnostics are about what is on screen. That is
 * the right answer and it is worth knowing: two people editing one file is the case where a silent
 * overwrite would be worst.
 */
async function ensure(path: string, text?: string) {
  const monaco = await loadMonaco()
  const uri = await uriFor(path)
  const existing = monaco.editor.getModel(uri)
  if (!existing && typeof text === 'string') {
    monaco.editor.createModel(text, languageForPath(path), uri)
  } else if (existing && typeof text === 'string' && existing.getValue() !== text) {
    // not open in a visible editor, just stale in the model set — safe to refresh
    existing.setValue(text)
  }
  return uri
}

/**
 * Is the service actually able to answer about this file yet?
 *
 * THE FAIL-SOFT BUG. `getTypeScriptWorker()` resolving does not mean the worker has the file's
 * program built. Ask it for hover at a valid position too early and it answers `null`; ask for a
 * definition and it answers `[]` — and those are EXACTLY what "there is no symbol here" looks
 * like. An agent records the wrong answer and never retries, which is worse than an error.
 *
 * So the file is probed first — diagnostics is the cheapest call that fails rather than shrugging
 * — and anything that cannot answer throws. Never an empty-but-successful shape for a condition
 * that means "ask me again".
 */
async function warm(client: { getSyntacticDiagnostics: (u: string) => Promise<unknown> }, key: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const d = await client.getSyntacticDiagnostics(key)
      if (Array.isArray(d)) return
    } catch {
      /* not built yet */
    }
    if (Date.now() > deadline) {
      throw new Error('the TypeScript service has not finished loading this program yet — call again in a moment')
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

function flatten(m: unknown): string {
  if (typeof m === 'string') return m
  const d = m as { messageText?: unknown; next?: unknown[] }
  const head = typeof d?.messageText === 'string' ? d.messageText : ''
  const rest = Array.isArray(d?.next) ? d.next.map(flatten).join(' ') : ''
  return [head, rest].filter(Boolean).join(' ')
}

/** Every syntactic and semantic problem in one file, in source order. */
export async function check(path: string, text?: string): Promise<LspDiagnostic[]> {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) return [{ severity: 'error', message: `no such program: ${path}`, line: 1, column: 1 }]
  const worker = await service()
  const client = await worker(uri)
  const key = uri.toString()
  // BOTH kinds: a syntax error means it is not TypeScript at all, a semantic one means it is
  // TypeScript that does not mean what it says. Reporting one would call a misspelt api call fine.
  const [syntactic, semantic] = await Promise.all([client.getSyntacticDiagnostics(key), client.getSemanticDiagnostics(key)])
  const out: LspDiagnostic[] = []
  for (const d of [...syntactic, ...semantic] as { start?: number; length?: number; category: number; messageText: unknown }[]) {
    const at = model.getPositionAt(d.start ?? 0)
    const end = model.getPositionAt((d.start ?? 0) + (d.length ?? 0))
    out.push({
      severity: d.category === 1 ? 'error' : d.category === 0 ? 'warning' : 'info',
      message: flatten(d.messageText),
      line: at.lineNumber,
      column: at.column,
      endLine: end.lineNumber,
      endColumn: end.column,
    })
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column)
}

/**
 * The declarations in a file, nested — classes, functions, methods, consts — with their spans.
 *
 * This is the "AST view" in the shape that is actually useful for editing: to change a function
 * you need its name and the lines it occupies, and to avoid clobbering a neighbour you need the
 * same for everything around it. The raw tree would be an order of magnitude more text and would
 * still have to be reduced to this before it could be acted on.
 */
/** TypeScript's word for an import binding. There are 21 of them in a 115-line program. */
const IMPORT_KIND = 'alias'
/** Things that are declared INSIDE a callable: destructured properties, loop counters, temporaries. */
const LOCAL_KINDS = new Set(['var', 'let', 'const', 'property', 'parameter'])
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor', 'getter', 'setter', 'arrow function'])

export async function outline(path: string, text?: string, opts: { imports?: boolean; locals?: boolean } = {}): Promise<OutlineNode[]> {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) throw new Error(`no such program: ${path}`)
  const worker = await service()
  const client = await worker(uri)
  await warm(client, uri.toString())
  const tree = (await client.getNavigationTree(uri.toString())) as
    | { text: string; kind: string; spans?: { start: number; length: number }[]; childItems?: unknown[] }
    | undefined
  if (!tree) return []
  /*
   * WHAT COMES OUT OF getNavigationTree IS NOT AN OUTLINE, it is everything with a name. For a
   * 115-line program that was longer than the file: 21 imports as top-level nodes, every
   * destructured property, and both loop counters as separate `i` entries — burying `setup`,
   * `update` and `teardown`, which are the three things this exists to find.
   *
   * So imports and in-function locals are dropped by DEFAULT and asked for by flag. And children
   * are sorted by LINE rather than the alphabetical order the service returns them in: an outline
   * is a map of the file, and a map that is not in the file's order is a list.
   */
  const walk = (n: typeof tree, insideCallable: boolean): OutlineNode | null => {
    const kind = n?.kind ?? 'unknown'
    if (kind === IMPORT_KIND && !opts.imports) return null
    if (insideCallable && LOCAL_KINDS.has(kind) && !opts.locals) return null

    const span = n?.spans?.[0]
    const from = model.getPositionAt(span?.start ?? 0)
    const to = model.getPositionAt((span?.start ?? 0) + (span?.length ?? 0))
    const kids = (n?.childItems ?? []) as (typeof tree)[]
    const nested = CALLABLE_KINDS.has(kind) || insideCallable
    const children = kids
      .map((k) => walk(k, nested))
      .filter((k): k is OutlineNode => k !== null)
      .sort((a, b) => a.line - b.line)
    return {
      name: n?.text ?? '(anonymous)',
      kind,
      line: from.lineNumber,
      endLine: to.lineNumber,
      ...(children.length ? { children } : {}),
    }
  }
  // The root is the file itself; its children are the declarations.
  const root = walk(tree, false)
  return root?.children ?? []
}

/** What a symbol at a position IS — its type and its doc comment. */
export async function hover(path: string, line: number, column: number, text?: string) {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) throw new Error(`no such program: ${path}`)
  const worker = await service()
  const client = await worker(uri)
  await warm(client, uri.toString())
  const offset = model.getOffsetAt({ lineNumber: line, column })
  const info = (await client.getQuickInfoAtPosition(uri.toString(), offset)) as { displayParts?: { text: string }[]; documentation?: { text: string }[] } | undefined
  if (!info) return null
  return {
    signature: (info.displayParts ?? []).map((p) => p.text).join(''),
    documentation: (info.documentation ?? []).map((p) => p.text).join('\n') || null,
  }
}

/**
 * Line and column for an offset in a file the model set does not have.
 *
 * THE DECLARATIONS ARE NOT MODELS. `loadMonaco` registers the program API's `.d.ts` through
 * `addExtraLib`, which puts them in the COMPILATION but not in `editor.getModel()` — so every
 * definition that landed in one came back with `line: null`, and the single most useful artifact
 * in the system, the API surface an agent writes against, was named by the tool and reachable by
 * nothing. The text is still there to be counted through.
 */
async function positionInLib(fileName: string, offset: number): Promise<{ line: number; column: number } | null> {
  const monaco = await loadMonaco()
  const libs = (monaco.ts.typescriptDefaults.getExtraLibs?.() ?? {}) as Record<string, { content?: string }>
  const text = libs[fileName]?.content
  if (typeof text !== 'string') return null
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - (before.lastIndexOf('\n') + 1) + 1
  return { line, column }
}

/** Where a symbol is declared — which file, which line. */
export async function definition(path: string, line: number, column: number, text?: string) {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) throw new Error(`no such program: ${path}`)
  const worker = await service()
  const client = await worker(uri)
  await warm(client, uri.toString())
  const offset = model.getOffsetAt({ lineNumber: line, column })
  const defs = ((await client.getDefinitionAtPosition(uri.toString(), offset)) ?? []) as { fileName: string; textSpan: { start: number } }[]
  return Promise.all(
    defs.map(async (d) => {
      const target = monaco.editor.getModel(monaco.Uri.parse(d.fileName))
      const at = target?.getPositionAt(d.textSpan.start)
      // a model first; an extra-lib declaration second — both are real places
      const inLib = at ? null : await positionInLib(d.fileName, d.textSpan.start)
      return {
        path: d.fileName.replace(/^file:\/\/\//, ''),
        line: at?.lineNumber ?? inLib?.line ?? null,
        column: at?.column ?? inLib?.column ?? null,
        // `declaration` says why program_read cannot open it: it is a generated .d.ts in the
        // compilation, not a document on the volume. Use code_hover for its signature.
        ...(target ? {} : { declaration: true }),
      }
    }),
  )
}

/** Register every program with the compilation, so cross-file resolution works. */
export async function loadWorkspace(files: { path: string; text: string }[]): Promise<number> {
  return knowAbout(files)
}
