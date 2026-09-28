// A tree of files, with folders — for every pane in this app that lists paths.
//
// Rich, 2026-09-28: "How are you supposed to manage multiple files in the editor, there is no
// folders and no file system and no tabs", then "Files listed in the shell need to have folders
// too, make a folder control we can use for both the program editor and the shell".
//
// ONE CONTROL, TWO CALLERS, and that is the reason it is here rather than inside the program
// panel. The shell projects the editor's documents as `worlds/…`, `levels/…`, `programs/…` — paths
// that are already a hierarchy and were being drawn as a flat list truncated at sixty rows, which
// is a file browser that lies about what is in the machine. The program editor has the same
// problem from the other end: its ids could not contain a slash at all.
//
// THE TREE IS DERIVED, NEVER STORED. Callers hand over a flat list of paths, because that is what
// every store here actually has — a directory listing, a projection, an object prefix. Folders
// exist because paths contain slashes, so a folder cannot be out of date with respect to its
// contents and there is no second thing to keep in step.
//
// What is remembered per caller is which folders are shut, and nothing else. A selection belongs
// to the caller (it is usually a URL or an open tab), and a filter is a question you are asking
// right now rather than a preference.
import { el, button } from './shell'
import { icon, type IconName } from './icons'

export interface FileRow {
  /** slash-separated; the only thing that makes a folder */
  path: string
  /** to the right, dimmed — a size, a date, a state */
  note?: string
  /** a one-character mark before the note: `•` for unsaved, say */
  mark?: string
}

export interface RowAction {
  icon: IconName
  title: string
  danger?: boolean
  onClick: () => void
}

export interface FileTreeOpts {
  /** every file, flat. Called on each render, so the caller keeps no copy in step with this one */
  files: () => FileRow[]
  /** the one that is current, if any */
  selected?: () => string | null
  onOpen: (path: string) => void
  /** buttons at the right of a file row */
  actions?: (path: string) => RowAction[]
  /** buttons at the right of a folder row — "new file here", usually */
  folderActions?: (dir: string) => RowAction[]
  /** where the open/shut folders are remembered; one per caller */
  storageKey: string
  empty?: string
  /** show the filter box from this many files up. The shell has hundreds; a panel has four. */
  filterFrom?: number
}

interface Dir {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: FileRow[]
}

const newDir = (name: string, path: string): Dir => ({ name, path, dirs: new Map(), files: [] })

/**
 * Build the tree from paths.
 *
 * Exported because it is the part with a decision in it and the part worth testing without a
 * browser: a path is split on `/`, everything before the last segment is folders, and a file
 * whose name is empty (a path ending in `/`) is not a file at all.
 */
export function treeOf(files: FileRow[]): Dir {
  const root = newDir('', '')
  for (const f of files) {
    // SPLIT FIRST, DROP THE EMPTIES AFTER. Filtering before taking the last segment loses a
    // trailing slash, and `out/` — which is a folder — became a file called `out` sitting beside
    // the folder of the same name.
    const parts = f.path.split('/')
    const name = parts.pop()
    if (!name) continue
    let at = root
    const walked: string[] = []
    for (const p of parts.filter(Boolean)) {
      walked.push(p)
      const here = walked.join('/')
      if (!at.dirs.has(p)) at.dirs.set(p, newDir(p, here))
      at = at.dirs.get(p)!
    }
    at.files.push({ ...f, path: f.path })
  }
  return root
}

/** How many files are under a folder, at any depth — what its row says about itself. */
export function countIn(d: Dir): number {
  let n = d.files.length
  for (const [, c] of d.dirs) n += countIn(c)
  return n
}

export class FileTree {
  readonly root = el('div', 'filetree')
  private readonly o: FileTreeOpts
  private shut: Set<string>
  private filter = ''

  constructor(o: FileTreeOpts) {
    this.o = o
    this.shut = new Set(this.load())
  }

  private load(): string[] {
    try {
      return JSON.parse(localStorage.getItem(`apex-tree.${this.o.storageKey}`) ?? '[]') as string[]
    } catch {
      return []
    }
  }

  private save(): void {
    try { localStorage.setItem(`apex-tree.${this.o.storageKey}`, JSON.stringify([...this.shut])) } catch { /* private window */ }
  }

  render(): void {
    this.root.replaceChildren()
    const all = this.o.files()
    const selected = this.o.selected?.() ?? null

    if (all.length >= (this.o.filterFrom ?? 14)) this.root.append(this.filterBox(all.length))

    const q = this.filter.trim().toLowerCase()
    const shown = q ? all.filter((f) => f.path.toLowerCase().includes(q)) : all
    if (!shown.length) {
      this.root.append(el('p', 'tree-empty', q ? `nothing matching “${this.filter}”` : (this.o.empty ?? 'nothing here yet')))
      return
    }

    const tree = treeOf(shown)
    // While filtering, everything is open: a match hidden inside a shut folder is a search that
    // says "no results" while holding one.
    this.draw(tree, this.root, 0, selected, !!q)
  }

  private filterBox(total: number): HTMLElement {
    const wrap = el('div', 'tree-filter')
    const i = el('input', 'input wide') as HTMLInputElement
    i.type = 'search'
    i.placeholder = `filter ${total} files`
    i.value = this.filter
    // `input`, not `change`: a filter that only applies when you leave the box is a filter you
    // have to be told about.
    i.oninput = () => {
      this.filter = i.value
      this.render()
      // the box is rebuilt with the rest, so put the caret back where it was
      const again = this.root.querySelector<HTMLInputElement>('.tree-filter input')
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length) }
    }
    wrap.append(icon('magnifying-glass', 14), i)
    return wrap
  }

  private draw(d: Dir, into: HTMLElement, depth: number, selected: string | null, forceOpen: boolean): void {
    for (const dir of [...d.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const open = forceOpen || !this.shut.has(dir.path)
      const row = el('div', 'tree-row tree-dir')
      row.style.setProperty('--depth', String(depth))
      const twist = el('button', 'tree-twist')
      twist.append(icon(open ? 'chevron-down' : 'chevron-right', 14), icon(open ? 'folder-open' : 'folder', 14), el('span', 'tree-name', dir.name))
      twist.append(el('span', 'tree-count', String(countIn(dir))))
      twist.title = open ? `collapse ${dir.path}` : `expand ${dir.path}`
      twist.onclick = () => {
        if (this.shut.has(dir.path)) this.shut.delete(dir.path)
        else this.shut.add(dir.path)
        this.save()
        this.render()
      }
      row.append(twist)
      this.addActions(row, this.o.folderActions?.(dir.path) ?? [])
      into.append(row)
      if (open) this.draw(dir, into, depth + 1, selected, forceOpen)
    }

    for (const f of [...d.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const name = f.path.split('/').pop() ?? f.path
      const row = el('div', `tree-row tree-file${f.path === selected ? ' on' : ''}`)
      row.style.setProperty('--depth', String(depth))
      const open = el('button', 'tree-open')
      open.append(icon('document-text', 14), el('span', 'tree-name', name))
      if (f.mark) open.append(el('span', 'tree-mark', f.mark))
      if (f.note) open.append(el('span', 'tree-note', f.note))
      open.title = f.path
      open.onclick = () => this.o.onOpen(f.path)
      row.append(open)
      this.addActions(row, this.o.actions?.(f.path) ?? [])
      into.append(row)
    }
  }

  private addActions(row: HTMLElement, actions: RowAction[]): void {
    if (!actions.length) return
    const box = el('div', 'tree-actions')
    for (const a of actions) {
      box.append(button({ icon: a.icon, title: a.title, variant: a.danger ? 'danger' : 'ghost', onClick: a.onClick }))
    }
    row.append(box)
  }
}
