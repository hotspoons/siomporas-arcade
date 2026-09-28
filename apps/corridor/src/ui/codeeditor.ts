// A real editor for a level's program, with the real types behind it.
//
// Rich, 2026-09-28: "any chance we can pull in a Monaco editor or something like that to improve
// the ux for humans typing? Would be great to have a tool kit to test types and verify everything
// builds and all that too."
//
// WHY MONACO AND NOT A TEXTAREA. The program layer is code (src/program.ts) and its API surface is
// the product — it is what a person reads the types of and what an agent is prompted against. In
// a textarea that surface is invisible: you find out that `api.hide('street-name')` is a typo when
// the level runs and nothing is hidden. With the real declarations loaded, Monaco says so while
// you type, completes `api.` from the actual `GameApi`, and hovers the doc comments that explain
// which of the three kinds of thing each call is.
//
// THE TYPES ARE GENERATED, NOT WRITTEN. `src/generated/program-types.json` is emitted from the
// real sources by scripts/gen-program-types.mjs and a test fails when it is stale. A hand-written
// `.d.ts` is the same class of mistake as a hand-typed width table: correct the day it is written,
// and after that it describes an API that no longer exists.
//
// LAZY. Monaco is a couple of megabytes and most sessions never open a program, so everything here
// is behind a dynamic import and the editor is built on first use.
import type * as Api from 'monaco-editor/editor/editor.api.js'
import type * as Ts from 'monaco-editor/languages/features/typescript/register.js'

/**
 * What this file actually uses, assembled from Monaco's own narrow entry points.
 *
 * NOT `import * from 'monaco-editor'`. In 0.57 the package root registers every language
 * definition it ships — ABAP, Bicep, Cypher, the lot — and moved the TypeScript service from
 * `monaco.languages.typescript` to a top-level namespace with a `{ deprecated: true }` stub left
 * at the old path. A stub that typechecks as an object and has none of the methods is exactly the
 * kind of thing that looks like "the worker did not start".
 */
interface MonacoApi {
  editor: typeof Api.editor
  Uri: typeof Api.Uri
  ts: typeof Ts
}

let monacoPromise: Promise<MonacoApi> | null = null

/**
 * Load Monaco once, with its workers and the program API's declarations.
 *
 * The workers are the part that is easy to get wrong: without `MonacoEnvironment.getWorker` the
 * TypeScript service silently never starts, and the editor looks like a plain text box with
 * syntax colouring — no diagnostics, no completions, and nothing anywhere saying why.
 */
export function loadMonaco(): Promise<MonacoApi> {
  monacoPromise ??= (async () => {
    const api = await import('monaco-editor/editor/editor.api.js')
    // THE LANGUAGE BEFORE THE SERVICE, and not in the same `Promise.all`. The definition registers
    // `typescript` as a language; the feature module attaches the worker-backed service to it and
    // throws "TypeScript not registered!" if it gets there first. Loading them concurrently is a
    // race that wins on a warm cache and loses on a cold one.
    await import('monaco-editor/languages/definitions/typescript/register.js')
    const [ts, editorWorker, tsWorker, types] = await Promise.all([
      import('monaco-editor/languages/features/typescript/register.js'),
      import('monaco-editor/editor/editor.worker.js?worker'),
      import('monaco-editor/languages/features/typescript/ts.worker.js?worker'),
      import('../generated/program-types.json'),
    ])
    ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_id: string, label: string) {
        return label === 'typescript' || label === 'javascript' ? new tsWorker.default() : new editorWorker.default()
      },
    }
    const monaco: MonacoApi = { editor: api.editor, Uri: api.Uri, ts }
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2020, // the newest this build of the service names; ESNext emits the same for what a program uses
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
      noImplicitAny: true,
      lib: ['es2022', 'dom'],
      allowNonTsExtensions: true,
      skipLibCheck: true,
      // NO `paths`. The declarations are laid out as a node_modules tree by
      // scripts/gen-program-types.mjs, which is the one layout the real resolver handles without
      // argument; a `paths` mapping over extra libs resolves the module and then reports that it
      // has no exported members, which reads as "the types did not load" with nothing saying why.
      allowJs: false,
    })
    // a program is authored, run and thrown away; there is no build step to complain to
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false })

    const doc = types.default as ProgramTypes
    for (const [uri, text] of Object.entries(doc.libs)) ts.typescriptDefaults.addExtraLib(text, uri)

    api.editor.defineTheme('corridor', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#0f1216', 'editorGutter.background': '#0f1216' },
    })
    return monaco
  })()
  return monacoPromise
}

interface ProgramTypes {
  version: number
  libs: Record<string, string>
  alias: Record<string, string>
  roots: string[]
}

/** One diagnostic, flattened to what a panel shows. */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  line: number
  column: number
}

export interface CodeEditorOpts {
  host: HTMLElement
  value: string
  /** a stable name; it is the module's URI, so two editors must not share one */
  path: string
  language?: 'typescript' | 'json'
  onChange?: (value: string) => void
  readOnly?: boolean
}

/**
 * A Monaco editor, plus the toolkit: does it parse, does it typecheck, does it compile.
 *
 * `check()` asks the same TypeScript service the squiggles come from, so what the panel reports
 * and what the editor shows cannot disagree. `emit()` is the compile — and it is the honest
 * definition of "does it build", because it is the JavaScript the viewer will actually run.
 */
export class CodeEditor {
  private monaco: MonacoApi | null = null
  private editor: Api.editor.IStandaloneCodeEditor | null = null
  private model: Api.editor.ITextModel | null = null
  private readonly o: CodeEditorOpts
  private ready: Promise<void>

  constructor(o: CodeEditorOpts) {
    this.o = o
    this.ready = this.build()
  }

  private async build() {
    const monaco = await loadMonaco()
    this.monaco = monaco
    const uri = monaco.Uri.parse(`file:///${this.o.path.replace(/^\/+/, '')}`)
    // a model that survives the panel being rebuilt: Monaco keys diagnostics by URI, and creating
    // a second model on the same URI throws
    this.model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(this.o.value, this.o.language ?? 'typescript', uri)
    if (this.model.getValue() !== this.o.value) this.model.setValue(this.o.value)
    this.editor = monaco.editor.create(this.o.host, {
      model: this.model,
      theme: 'corridor',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      readOnly: this.o.readOnly,
      tabSize: 2,
      renderWhitespace: 'selection',
      padding: { top: 10, bottom: 10 },
    })
    if (this.o.onChange) this.model.onDidChangeContent(() => this.o.onChange!(this.model!.getValue()))
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  value(): string {
    return this.model?.getValue() ?? this.o.value
  }

  setValue(text: string): void {
    this.model?.setValue(text)
  }

  focus(): void {
    this.editor?.focus()
  }

  /** Jump to a diagnostic, which is what makes a list of them useful rather than a report. */
  reveal(line: number, column = 1): void {
    this.editor?.revealLineInCenter(line)
    this.editor?.setPosition({ lineNumber: line, column })
    this.editor?.focus()
  }

  dispose(): void {
    this.editor?.dispose()
    // the MODEL is deliberately kept: reopening the same program should not lose its undo history
  }

  /**
   * The TypeScript service, once it exists.
   *
   * `setupTypeScript` is attached to `languages.onLanguage('typescript', …)` and its body is an
   * async import, so the service is NOT ready when the first TypeScript model is created — it is
   * ready a few microtasks later. Asking before then rejects with the string "TypeScript not
   * registered!", which surfaces as an unhandled rejection and an editor that reports no problems
   * at all. There is no event to await, so this waits for it.
   */
  private async service() {
    if (!this.monaco) return null
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        return await this.monaco.ts.getTypeScriptWorker()
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`the TypeScript service never started: ${String(e)}`)
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }

  /**
   * Every syntactic and semantic problem, in source order.
   *
   * Both kinds, because they fail differently: a syntax error means the file is not TypeScript at
   * all, and a semantic one means it is TypeScript that does not mean what it says. A panel that
   * reported only one of them would call a misspelt `api.hide('street-name')` fine.
   */
  async check(): Promise<Diagnostic[]> {
    await this.ready
    if (!this.monaco || !this.model) return []
    const worker = await this.service()
    if (!worker) return []
    const client = await worker(this.model.uri)
    const uri = this.model.uri.toString()
    const [syntactic, semantic] = await Promise.all([client.getSyntacticDiagnostics(uri), client.getSemanticDiagnostics(uri)])
    const out: Diagnostic[] = []
    for (const d of [...syntactic, ...semantic]) {
      const at = this.model.getPositionAt(d.start ?? 0)
      out.push({
        severity: d.category === 1 ? 'error' : d.category === 0 ? 'warning' : 'info',
        message: flatten(d.messageText),
        line: at.lineNumber,
        column: at.column,
      })
    }
    return out.sort((a, b) => a.line - b.line || a.column - b.column)
  }

  /** The JavaScript the viewer would run, or null when it does not compile. */
  async emit(): Promise<string | null> {
    await this.ready
    if (!this.monaco || !this.model) return null
    const worker = await this.service()
    if (!worker) return null
    const client = await worker(this.model.uri)
    const out = await client.getEmitOutput(this.model.uri.toString())
    const js = out.outputFiles?.find((f: { name: string }) => f.name.endsWith('.js'))
    return js?.text ?? null
  }
}

/** Monaco's message chains are nested; a panel wants one string. */
function flatten(m: string | { messageText: string | unknown; next?: unknown[] }): string {
  if (typeof m === 'string') return m
  const head = typeof m.messageText === 'string' ? m.messageText : flatten(m.messageText as never)
  const rest = (m.next ?? []).map((n) => flatten(n as never))
  return [head, ...rest].join(' ')
}
