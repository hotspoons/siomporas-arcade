// Notice when an authored document changes on disk under an open editor.
//
// "A mode's edits update its overlay while another mode is active" (the 2026-10-10 brief) has two
// halves. Inside the editor every mode's edits already go through its own group, which now stays
// in the scene in every mode (view/emphasis.ts). OUTSIDE it, the world editor's MCP tools write
// zones.json, points.json and courses.json straight to the volume (traffic_zone_add, point_add,
// course_save) — and the editor read each file once, at load, so an agent's five Beltway zones
// were invisible until somebody reloaded the page.
//
// So the editor looks again, every few seconds while it is the thing on screen, and a document
// whose text changed is reloaded into its mode — unless that mode has unsaved edits, which win:
// the editor says so and leaves them alone. Its own saves are re-primed, so they never come back
// as "changed".

/** Reads documents' raw text and remembers it, to say which ones changed since the last look. */
export class DocWatch {
  private seen = new Map<string, string>()
  private base: string

  constructor(base = '') {
    this.base = base
  }

  private async read(path: string): Promise<string | null> {
    try {
      const r = await fetch(`${this.base}${path}`, { cache: 'no-cache' })
      // absent is a state like any other: a document deleted under the editor is a change too
      if (r.status === 404) return ''
      if (!r.ok) return null
      const text = (await r.text()).trimStart()
      // the dev server's SPA fallback answers a missing file with index.html (see schema.ts `load`)
      return text.startsWith('{') ? text : ''
    } catch {
      return null // a network blip is not a change
    }
  }

  /** Remember what these say now, without reporting anything. */
  async prime(paths: string[]): Promise<void> {
    await Promise.all(paths.map(async (p) => {
      const t = await this.read(p)
      if (t !== null) this.seen.set(p, t)
    }))
  }

  /** The paths whose text differs from the last look. A path never looked at is primed, not reported. */
  async changed(paths: string[]): Promise<string[]> {
    const out: string[] = []
    await Promise.all(paths.map(async (p) => {
      const t = await this.read(p)
      if (t === null) return
      const was = this.seen.get(p)
      this.seen.set(p, t)
      if (was !== undefined && was !== t) out.push(p)
    }))
    return out
  }

  clear() {
    this.seen.clear()
  }
}
