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
import { knowAbout, languageForPath, loadMonaco } from '../editor/program/codeeditor'

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
export async function outline(path: string, text?: string): Promise<OutlineNode[]> {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) throw new Error(`no such program: ${path}`)
  const worker = await service()
  const client = await worker(uri)
  const tree = (await client.getNavigationTree(uri.toString())) as
    | { text: string; kind: string; spans?: { start: number; length: number }[]; childItems?: unknown[] }
    | undefined
  if (!tree) return []
  const walk = (n: typeof tree): OutlineNode => {
    const span = n?.spans?.[0]
    const from = model.getPositionAt(span?.start ?? 0)
    const to = model.getPositionAt((span?.start ?? 0) + (span?.length ?? 0))
    const kids = (n?.childItems ?? []) as (typeof tree)[]
    return {
      name: n?.text ?? '(anonymous)',
      kind: n?.kind ?? 'unknown',
      line: from.lineNumber,
      endLine: to.lineNumber,
      ...(kids.length ? { children: kids.map(walk) } : {}),
    }
  }
  // The root is the file itself; its children are the declarations.
  const root = walk(tree)
  return root.children ?? []
}

/** What a symbol at a position IS — its type and its doc comment. */
export async function hover(path: string, line: number, column: number, text?: string) {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) throw new Error(`no such program: ${path}`)
  const worker = await service()
  const client = await worker(uri)
  const offset = model.getOffsetAt({ lineNumber: line, column })
  const info = (await client.getQuickInfoAtPosition(uri.toString(), offset)) as { displayParts?: { text: string }[]; documentation?: { text: string }[] } | undefined
  if (!info) return null
  return {
    signature: (info.displayParts ?? []).map((p) => p.text).join(''),
    documentation: (info.documentation ?? []).map((p) => p.text).join('\n') || null,
  }
}

/** Where a symbol is declared — which file, which line. */
export async function definition(path: string, line: number, column: number, text?: string) {
  const monaco = await loadMonaco()
  const uri = await ensure(path, text)
  const model = monaco.editor.getModel(uri)
  if (!model) throw new Error(`no such program: ${path}`)
  const worker = await service()
  const client = await worker(uri)
  const offset = model.getOffsetAt({ lineNumber: line, column })
  const defs = ((await client.getDefinitionAtPosition(uri.toString(), offset)) ?? []) as { fileName: string; textSpan: { start: number } }[]
  return defs.map((d) => {
    const target = monaco.editor.getModel(monaco.Uri.parse(d.fileName))
    const at = target?.getPositionAt(d.textSpan.start)
    return {
      path: d.fileName.replace(/^file:\/\/\//, ''),
      line: at?.lineNumber ?? null,
      column: at?.column ?? null,
    }
  })
}

/** Register every program with the compilation, so cross-file resolution works. */
export async function loadWorkspace(files: { path: string; text: string }[]): Promise<number> {
  return knowAbout(files)
}
