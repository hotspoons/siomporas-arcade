// Blender, in the editor: what it has made, and what to make next.
//
// Rich, 2026-09-29: "make it so there's MCP tools that an agent can use to run blender using this
// tool kit but through our UI. And also make it so the UI shows any blender rendered stls or other
// exports."
//
// THE SAME FILES THE AGENT SEES. Every render and export — from this panel, from an MCP client, or
// from a rigger run on the command line — lands in one directory on the volume, and this lists it.
// So when an agent says "I rendered it and the wheels are outside the arches", the picture it is
// talking about is the one on this screen, not a description of one.
//
// WHY THAT MATTERS AND IS NOT DECORATION: the vehicle rigger reported four wheels, correct radii,
// a plausible wheelbase and a green spin check while every wheel hung below and outboard of its
// arch. The numbers were all true. Only the picture showed it.
import { button, el, toast, type Tab } from '../../ui/shell'
import { bodyOf, empty, group, readout, select, textField } from '../../ui/controls'
import { icon } from '../../ui/icons'
import { api, type BlenderOutput, type BlenderStatus } from '../worldedit/api'
import { MeshView } from '../library/meshview'

/** What the 3D viewer can draw. Everything else gets a download and an honest sentence. */
const VIEWABLE = new Set(['glb', 'gltf', 'stl', 'obj', 'ply'])

/** Bytes as something a person reads. */
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`)

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export class BlenderPanel {
  private host: HTMLElement
  private state: BlenderStatus | null = null
  private outputs: BlenderOutput[] = []
  private dir = ''
  private selected: string | null = null
  private mesh: MeshView | null = null
  private busy = ''
  /** what the render/export forms are set to; kept across a redraw so a rebuild is not a reset */
  private shot = { name: 'render', az: 45, el: 20, dist: 2.2 }
  private fmt = 'glb'

  constructor(host: HTMLElement) {
    this.host = host
  }

  async load() {
    this.state = await api.blenderStatus().catch((e) => ({ up: false, why: (e as Error).message }))
    const o = await api.blenderOutputs().catch(() => ({ dir: '', files: [] }))
    this.outputs = o.files
    this.dir = o.dir
    this.render()
  }

  /** Leaving the tab: the preview stops drawing but keeps what it loaded. */
  stop() {
    this.mesh?.stop()
  }

  private async act(what: string, run: () => Promise<unknown>) {
    if (this.busy) return
    this.busy = what
    this.render()
    try {
      await run()
      await this.load()
    } catch (e) {
      toast(`${what}: ${(e as Error).message}`, 'danger', 9000)
      this.busy = ''
      this.render()
    }
    this.busy = ''
  }

  private render() {
    this.host.replaceChildren()
    const wrap = el('div', 'asset-tab')
    wrap.append(this.statusBar())
    const split = el('div', 'asset-split')
    const left = el('div', 'asset-list-box')
    left.append(this.outputList())
    split.append(left, this.detail())
    wrap.append(split)
    this.host.append(wrap)
  }

  /**
   * IS THERE A BLENDER, and if not, the command.
   *
   * The bridge is a separate process from this service, so "not running" is a normal state rather
   * than an error — and the useful thing to show is not "unavailable" but the line to paste. In
   * `--background` mode Blender's timers never fire, so the addon's interactive loop does nothing
   * and only `--command blender_mcp` reaches its blocking one; starting Blender without it gives a
   * running process with nothing listening and no error anywhere.
   */
  private statusBar(): HTMLElement {
    const bar = el('div', 'asset-pane-bar blender-bar')
    const s = this.state
    const dot = el('span', `dot ${s?.up ? 'ok' : 'off'}`)
    const text = el('span', 'blender-status')
    if (s?.up) {
      const meshes = (s.objects ?? []).filter((o) => o.type === 'MESH' && o.name !== 'Icosphere')
      text.textContent = `Blender ${s.version} · ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'} in the scene`
    } else {
      text.textContent = 'no Blender bridge'
    }
    bar.append(dot, text, el('div', 'topbar-spacer'))
    bar.append(button({ label: 'Refresh', icon: 'arrow-path', variant: 'ghost', onClick: () => void this.load() }))
    if (!s?.up) {
      const hint = el('div', 'panel-hint')
      hint.append(icon('information-circle', 14), el('span', '', 'Start it on the machine running the editor:'))
      const cmd = el('pre', 'mono blender-cmd', 'blender --background --online-mode --command blender_mcp')
      const holder = el('div', 'blender-down')
      holder.append(hint, cmd)
      if (s?.why) holder.append(el('p', 'dim', s.why))
      const outer = el('div', 'blender-head')
      outer.append(bar, holder)
      return outer
    }
    return bar
  }

  /** Everything Blender has produced, newest first. One list, whoever made the file. */
  private outputList(): HTMLElement {
    const box = el('div', 'blender-outputs')
    const head = el('div', 'blender-outputs-head')
    head.append(el('strong', '', `Output (${this.outputs.length})`))
    if (this.dir) head.append(el('span', 'rig-note mono', this.dir))
    box.append(head)
    if (!this.outputs.length) {
      box.append(empty('Nothing rendered or exported yet.'))
      return box
    }
    const list = el('div', 'asset-list')
    for (const f of this.outputs) {
      const row = el('button', `asset-row${f.name === this.selected ? ' on' : ''}`)
      const thumb = el('span', 'asset-thumb')
      if (f.kind === 'image') {
        const img = el('img') as HTMLImageElement
        img.src = api.blenderOutputUrl(f.name)
        img.loading = 'lazy'
        thumb.append(img)
      } else {
        thumb.append(icon(f.kind === 'model' ? 'cube' : 'play', 16))
      }
      const t = el('span', 'asset-row-text')
      t.append(el('span', 'nm', f.name), el('span', 'rig-note', `${f.ext} · ${size(f.bytes)} · ${ago(f.at)}`))
      row.append(thumb, t)
      row.onclick = () => { this.selected = f.name; this.render() }
      list.append(row)
    }
    box.append(list)
    return box
  }

  /** The selected file, shown as what it is — and the things you can do next. */
  private detail(): HTMLElement {
    const host = el('div', 'asset-detail blender-detail')
    const f = this.outputs.find((x) => x.name === this.selected)
    if (f) host.append(this.preview(f))
    if (this.state?.up) host.append(this.actions())
    if (!f && !this.state?.up) host.append(empty('Start the bridge to render, or run a rigger from the command line — its output appears here either way.'))
    return host
  }

  private preview(f: BlenderOutput): HTMLElement {
    const g = group(f.name, { collapsed: false })
    const b = bodyOf(g)
    const url = api.blenderOutputUrl(f.name)
    if (f.kind === 'image') {
      const img = el('img', 'blender-preview') as HTMLImageElement
      img.src = url
      b.append(img)
    } else if (VIEWABLE.has(f.ext)) {
      /*
       * EVERY MODEL FORMAT GETS THE SAME VIEWER.
       *
       * The first version of this said an STL "cannot be previewed here" and offered to export a
       * glb instead, which is a message where a viewer should be — three ships an STLLoader and it
       * is four lines. An STL carries no materials, no colour and no rig; that is a fact about the
       * format to state UNDER the model, not a reason to refuse to draw it.
       */
      this.mesh ??= new MeshView({ remember: 'blender' })
      // ITS OWN NAME. `__meshview` belongs to the catalog's viewer and both panels exist at once
      // in the DOM, so sharing the handle means a probe cannot tell which one it is reading.
      ;(window as unknown as { __blenderview?: MeshView }).__blenderview = this.mesh
      if (this.mesh.root.dataset.file !== f.name) {
        this.mesh.root.dataset.file = f.name
        void this.mesh.load(url)
      }
      this.mesh.start()
      b.append(this.mesh.root)
      if (f.ext !== 'glb' && f.ext !== 'gltf') {
        const p = el('p', 'panel-hint')
        p.append(icon('information-circle', 14), el('span', '', f.ext === 'ply'
          ? 'PLY is geometry and, sometimes, vertex colours — no materials and no rig. The grey is the viewer’s.'
          : `${f.ext.toUpperCase()} is geometry only: no materials, no rig. The grey is the viewer’s, not the asset’s.`))
        b.append(p)
      }
    } else {
      const p = el('p', 'panel-hint')
      p.append(icon('information-circle', 14), el('span', '', `${f.ext.toUpperCase()} is not something this viewer draws; download it to open it elsewhere.`))
      b.append(p)
    }
    b.append(readout('size', size(f.bytes)), readout('made', ago(f.at)))
    const acts = el('div', 'panel-actions')
    const dl = el('a', 'btn ghost') as HTMLAnchorElement
    dl.href = url
    dl.download = f.name
    dl.append(icon('arrow-down-tray', 16), el('span', 'btn-label', 'Download'))
    acts.append(dl)
    if (f.ext === 'glb') {
      acts.append(button({
        label: 'Open in Blender',
        icon: 'arrow-top-right-on-square',
        variant: 'ghost',
        disabled: !this.state?.up || !!this.busy,
        // the path on the SERVICE's disk, which is where Blender is too; the browser never sees it
        onClick: () => void this.act('load', () => api.blenderLoad(`${this.dir}/${f.name}`)),
      }))
    }
    b.append(acts)
    return g
  }

  /**
   * Render and export, on whatever is in the live scene.
   *
   * The angles are spherical around the scene's own contents rather than world coordinates, so
   * they work without knowing where anything is: az 0 is the side of a car, 90 the front, and el
   * is degrees above the horizon.
   */
  private actions(): HTMLElement {
    const g = group('The live scene', { collapsed: false })
    const b = bodyOf(g)
    const meshes = (this.state?.objects ?? []).filter((o) => o.type === 'MESH' && o.name !== 'Icosphere')
    b.append(readout('in the scene', meshes.length ? meshes.map((m) => m.name).join(', ') : 'nothing'))

    b.append(textField({ label: 'name', value: this.shot.name, onChange: (v) => { this.shot.name = v } }))
    const nums: [keyof typeof this.shot, string, string][] = [
      ['az', 'around (°)', '0 is the side, 90 the front'],
      ['el', 'above (°)', 'degrees above the horizon'],
      ['dist', 'distance', 'multiples of the subject’s own size'],
    ]
    for (const [k, label, note] of nums) {
      b.append(textField({
        label, type: 'number', note,
        value: String(this.shot[k]),
        onChange: (v) => { const n = Number(v); if (Number.isFinite(n)) (this.shot[k] as number) = n },
      }))
    }
    b.append(button({
      label: this.busy === 'render' ? 'Rendering…' : 'Render',
      icon: 'camera',
      variant: 'primary',
      disabled: !!this.busy || !meshes.length,
      onClick: () => void this.act('render', async () => {
        const r = await api.blenderRender({ ...this.shot })
        this.selected = r.file
      }),
    }))

    b.append(select({
      label: 'export as',
      value: this.fmt,
      options: [
        { value: 'glb', label: 'glb — materials and the rig' },
        { value: 'stl', label: 'stl — triangles only, no rig' },
        { value: 'obj', label: 'obj — materials, no rig' },
        { value: 'ply', label: 'ply — points and triangles' },
      ],
      onChange: (v) => { this.fmt = v; this.render() },
    }))
    b.append(button({
      label: this.busy === 'export' ? 'Exporting…' : 'Export',
      icon: 'document-arrow-down',
      disabled: !!this.busy || !meshes.length,
      onClick: () => void this.act('export', async () => {
        const r = await api.blenderExport({ format: this.fmt, name: this.shot.name })
        this.selected = r.file
      }),
    }))
    return g
  }
}

/** The Blender tab, for the asset library's tab set. */
export function blenderTab(): { tab: Tab; stop: () => void } {
  let panel: BlenderPanel | null = null
  return {
    tab: {
      id: 'blender',
      label: 'Blender',
      icon: 'cube',
      build: (h) => { panel = new BlenderPanel(h); void panel.load() },
    },
    // so the library can stop the preview spinning for nobody when the pane is left, the same way
    // it stops the catalog's
    stop: () => panel?.stop(),
  }
}
