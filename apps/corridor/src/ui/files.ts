// Getting a document out of the page and back in, without a native dialog in the way.
//
// Rich, 2026-09-28, on the editor: "kill native dialogs". These two are the exception the browser
// does not let anybody else do — a file picker and a download both have to be driven by a real
// element and a real click — so they are wrapped once, here, rather than open-coded in every panel
// that has something to export.
//
// The `<input>` does NOT stay in the DOM. Left there, a session accumulates one per export, and a
// dismissed dialog leaves a promise pending forever unless `cancel` is handled — which it is.
import { el } from './shell'

/** Start a download of an object as pretty JSON. */
export function downloadJSON(filename: string, doc: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }))
  const a = el('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  // revoked on the next turn, not immediately: Safari has not started the download yet
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Ask for one JSON file and parse it. `null` when the dialog was dismissed or it was not JSON. */
export function readJSONFile(accept = '.json,application/json'): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const input = el('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.oncancel = () => { input.remove(); resolve(null) }
    input.onchange = async () => {
      const f = input.files?.[0] ?? null
      input.remove()
      if (!f) return resolve(null)
      try {
        resolve(JSON.parse(await f.text()) as Record<string, unknown>)
      } catch {
        resolve(null)
      }
    }
    document.body.append(input)
    input.click()
  })
}
