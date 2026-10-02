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
  languages: typeof Api.languages
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
    /*
     * THE EDITOR'S BEHAVIOUR IS NOT IN THE API.
     *
     * `editor.api.js` is the types, the namespaces and a bare editor widget: it registers NO
     * contributions, so there is no suggest controller, no parameter hints, no hover, no find and
     * no right-click menu. The editor renders, colours text and typechecks — and then Ctrl-Space
     * does nothing at all, which is exactly what it did here (Rich, 2026-09-28: "an LSP for
     * typescript, javascript and json would be nice so we can see what options exist as we type").
     * The language service was fine the whole time; there was nothing on screen to show it.
     *
     * `editor.main.js` fixes that AND registers eighty language definitions, which is the reason
     * this file imports the api rather than the main entry in the first place. So the
     * contributions are named one by one. Each of these is a thing a person expects a code editor
     * to do; anything not listed is a thing this editor deliberately does not have.
     */
    await Promise.all([
      import('monaco-editor/editor/contrib/suggest/browser/suggestController.js'),
      import('monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'),
      import('monaco-editor/editor/contrib/hover/browser/hoverContribution.js'),
      import('monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'),
      import('monaco-editor/editor/contrib/folding/browser/folding.js'),
      import('monaco-editor/editor/contrib/comment/browser/comment.js'),
      import('monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'),
      import('monaco-editor/editor/contrib/find/browser/findController.js'),
      import('monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'),
      import('monaco-editor/editor/contrib/gotoError/browser/gotoError.js'),
      import('monaco-editor/editor/contrib/rename/browser/rename.js'),
      import('monaco-editor/editor/contrib/format/browser/formatActions.js'),
      import('monaco-editor/editor/contrib/snippet/browser/snippetController2.js'),
      import('monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'),
      import('monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'),
      import('monaco-editor/editor/contrib/multicursor/browser/multicursor.js'),
      import('monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'),
      import('monaco-editor/editor/contrib/clipboard/browser/clipboard.js'),
      import('monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'),
      import('monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'),
      import('monaco-editor/editor/contrib/indentation/browser/indentation.js'),
      import('monaco-editor/editor/browser/coreCommands.js'),
      /*
       * AND THE TWO SERVICES THAT CONTRIBUTIONS WE DID NOT ASK FOR NEED.
       *
       * `CodeLensContribution` and `DropIntoEditorController` are registered by the TypeScript
       * feature module, not by anything in the list above — and they are instantiated for every
       * editor, so from the SECOND tab onwards each one threw "depends on UNKNOWN service" into
       * the console. Registering the singletons they want is two imports; the alternative is two
       * errors per editor for a feature nobody uses.
       */
      import('monaco-editor/editor/contrib/codelens/browser/codeLensCache.js'),
      import('monaco-editor/editor/common/services/treeViewsDndService.js'),
    ])
    // THE LANGUAGE BEFORE THE SERVICE, and not in the same `Promise.all`. The definition registers
    // `typescript` as a language; the feature module attaches the worker-backed service to it and
    // throws "TypeScript not registered!" if it gets there first. Loading them concurrently is a
    // race that wins on a warm cache and loses on a cold one.
    await import('monaco-editor/languages/definitions/typescript/register.js')
    // JavaScript is a separate DEFINITION (its own tokenizer) served by the SAME service as
    // TypeScript. JSON is the other way round: no definition module, because its feature brings
    // its own tokenization with it.
    await import('monaco-editor/languages/definitions/javascript/register.js')
    const [ts, , editorWorker, tsWorker, jsonWorker, types] = await Promise.all([
      import('monaco-editor/languages/features/typescript/register.js'),
      import('monaco-editor/languages/features/json/register.js'),
      import('monaco-editor/editor/editor.worker.js?worker'),
      import('monaco-editor/languages/features/typescript/ts.worker.js?worker'),
      import('monaco-editor/languages/features/json/json.worker.js?worker'),
      import('../../generated/program-types.json'),
    ])
    /*
     * ONE WORKER PER LANGUAGE SERVICE, and the label is how Monaco asks for it.
     *
     * A json model whose label falls through to the plain editor worker gets no completions, no
     * schema validation and no formatting — and, as ever here, says nothing about why. Rich,
     * 2026-09-28: "an LSP for typescript, javascript and json would be nice so we can see what
     * options exist as we type."
     */
    ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_id: string, label: string) {
        if (label === 'typescript' || label === 'javascript') return new tsWorker.default()
        if (label === 'json') return new jsonWorker.default()
        return new editorWorker.default()
      },
    }
    const monaco: MonacoApi = { editor: api.editor, Uri: api.Uri, languages: api.languages, ts }
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2020, // the newest this build of the service names; ESNext emits the same for what a program uses
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
      noImplicitAny: true,
      lib: ['es2022', 'dom'],
      allowNonTsExtensions: true,
      // `import data from './lib/tuning.json'` is a normal thing to want now that a file can be
      // JSON, and without this the service reports it as a module that does not exist
      resolveJsonModule: true,
      skipLibCheck: true,
      // NO `paths`. The declarations are laid out as a node_modules tree by
      // scripts/gen-program-types.mjs, which is the one layout the real resolver handles without
      // argument; a `paths` mapping over extra libs resolves the module and then reports that it
      // has no exported members, which reads as "the types did not load" with nothing saying why.
      // ALLOW JS, because `.js` is one of the extensions a file here may have now — and without
      // it the service parses a JavaScript model and then declines to say anything about it.
      allowJs: true,
      checkJs: false, // its diagnostics on untyped JavaScript are noise, not help
    })
    // a program is authored, run and thrown away; there is no build step to complain to
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false })
    ts.javascriptDefaults?.setCompilerOptions?.({ target: ts.ScriptTarget.ES2020, allowJs: true, allowNonTsExtensions: true, lib: ['es2022', 'dom'] })

    const doc = types.default as ProgramTypes
    for (const [uri, text] of Object.entries(doc.libs)) ts.typescriptDefaults.addExtraLib(text, uri)
    registerImportPaths(monaco, Object.keys(doc.alias))

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
/**
 * WHAT CAN GO IN THE QUOTES OF AN IMPORT.
 *
 * TypeScript's own completions do everything else — members, named imports, the core package's
 * exports — but not the module SPECIFIER, because working out what `'./` could be means listing a
 * directory and Monaco's worker has no filesystem to list. Inside the quotes you got the ordinary
 * word suggestions instead, which is worse than nothing: `chaseSpeed` offered as a module path.
 *
 * The editor knows the answer without a filesystem. The core packages are the aliases in the
 * generated declarations, and every other file is a model that already exists — so this offers
 * `@apex/program` and the relative path from here to there, with `.ts` dropped (TypeScript
 * resolves it) and `.json` kept (it does not).
 */
function registerImportPaths(monaco: MonacoApi, packages: string[]): void {
  const provider = {
    triggerCharacters: ["'", '"', '/', '@', '.'],
    provideCompletionItems(model: Api.editor.ITextModel, position: Api.Position) {
      const line = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column })
      // an import (or a re-export, or a dynamic import) whose string is still open
      const m = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"]*)$/.exec(line)
      if (!m) return { suggestions: [] }
      const typed = m[2]
      const word = model.getWordUntilPosition(position)
      void word
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endColumn: position.column,
      }
      const here = model.uri.path.replace(/^\//, '')
      const suggestions: Api.languages.CompletionItem[] = []
      for (const p of packages) {
        suggestions.push({
          label: p,
          kind: monaco.languages.CompletionItemKind.Module,
          detail: 'the game API',
          insertText: p,
          range,
          sortText: `0${p}`,
        })
      }
      for (const other of monaco.editor.getModels()) {
        const there = other.uri.path.replace(/^\//, '')
        if (there === here || !there.startsWith('programs/')) continue
        const rel = relativeSpecifier(here, there)
        if (!rel) continue
        suggestions.push({
          label: rel,
          kind: monaco.languages.CompletionItemKind.File,
          detail: there,
          insertText: rel,
          range,
          sortText: `1${rel}`,
        })
      }
      return { suggestions }
    },
  }
  monaco.languages.registerCompletionItemProvider('typescript', provider)
  monaco.languages.registerCompletionItemProvider('javascript', provider)
}

/**
 * The specifier that gets you from one file to another: `./sibling`, `../lib/thing`.
 *
 * ALWAYS EXPLICITLY RELATIVE. A bare `lib/thing` is a package name to a module resolver, so a
 * suggestion missing the `./` resolves to nothing and reads as a broken import.
 */
export function relativeSpecifier(from: string, to: string): string | null {
  const ext = to.slice(to.lastIndexOf('.'))
  if (!['.ts', '.tsx', '.js', '.mjs', '.json'].includes(ext)) return null
  const a = from.split('/').slice(0, -1)
  const b = to.split('/')
  const name = b.pop()!
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const up = a.length - i
  const parts = [...(up ? Array(up).fill('..') : ['.']), ...b.slice(i), ext === '.json' ? name : name.slice(0, -ext.length)]
  return parts.join('/')
}

/**
 * Make sure the service knows about a file, without opening it.
 *
 * WHY THIS EXISTS: Monaco's TypeScript service only knows the MODELS that have been created. A
 * program that imports `./lib/chase` from a file nobody has clicked on gets "cannot find module",
 * no completions for what that module exports, and no rename across the two — so a multi-file
 * game behaves as if every file were alone (Rich, 2026-09-28: "We need autocompletion for imports
 * and other TS libraries that are part of the core package plus anything referenced from the
 * program's scope").
 *
 * Creating a model is not opening an editor: it costs the text and nothing else, and it is what
 * puts the file in the compilation.
 */
export async function knowAbout(files: { path: string; text: string; language?: string }[]): Promise<number> {
  const monaco = await loadMonaco()
  let made = 0
  for (const f of files) {
    const uri = monaco.Uri.parse(`file:///${f.path.replace(/^\/+/, '')}`)
    const already = monaco.editor.getModel(uri)
    if (already) {
      // an OPEN file's buffer is the truth, including its unsaved edits — never overwrite it here
      continue
    }
    monaco.editor.createModel(f.text, f.language ?? languageForPath(f.path), uri)
    made++
  }
  return made
}

/** Monaco's language id for a path. The one place the mapping lives. */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'))
  if (ext === '.json') return 'json'
  if (ext === '.js' || ext === '.mjs') return 'javascript'
  if (ext === '.ts' || ext === '.tsx') return 'typescript'
  return 'plaintext'
}

/** Forget a file the volume no longer has, so it stops resolving and stops being suggested. */
export async function forget(path: string): Promise<void> {
  const monaco = await loadMonaco()
  monaco.editor.getModel(monaco.Uri.parse(`file:///${path.replace(/^\/+/, '')}`))?.dispose()
}

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
  /** Monaco's language id. From the file's extension — see `languageOf` in programpanel.ts. */
  language?: 'typescript' | 'javascript' | 'json' | 'plaintext'
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
      /*
       * SUGGESTIONS AS YOU TYPE, which is the whole point of having a language service.
       *
       * Monaco's defaults offer them only on an explicit Ctrl-Space or after a trigger character,
       * so an editor with a perfectly good service in it looks like a text box until you know the
       * shortcut. `quickSuggestions` is the "what can go here" list appearing on its own.
       */
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      tabCompletion: 'on',
      parameterHints: { enabled: true },
      fixedOverflowWidgets: true, // the popup must escape a dialog with `overflow: hidden` on it
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

  /**
   * Type something at the caret, as if a person had.
   *
   * `executeEdits` rather than `setValue`: it keeps the undo history, so an id inserted from a
   * list can be undone like anything else, and it leaves the caret after what it inserted.
   */
  insert(text: string): void {
    const ed = this.editor
    const sel = ed?.getSelection()
    if (!ed || !sel) return
    ed.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }])
    ed.focus()
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
