// Generic persisted settings: deep-merged over defaults from localStorage,
// change listeners, one `update()` entry point. Games define the shape.

type Listener<T> = (s: T) => void

export class SettingsStore<T extends object> {
  data: T
  readonly key: string
  private readonly listeners = new Set<Listener<T>>()

  constructor(key: string, defaults: T) {
    this.key = key
    this.data = load(key, defaults)
  }

  /** True when something was persisted before this session. */
  static hasStored(key: string): boolean {
    try {
      return localStorage.getItem(key) !== null
    } catch {
      return false
    }
  }

  onChange(fn: Listener<T>): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Mutate via the callback, then persist and notify. */
  update(fn: (d: T) => void): void {
    fn(this.data)
    this.save()
    for (const l of this.listeners) l(this.data)
  }

  save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data))
    } catch {
      /* storage unavailable; settings are session-only */
    }
  }
}

function load<T extends object>(key: string, defaults: T): T {
  const base = structuredClone(defaults)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return deepMerge(base as unknown as Record<string, unknown>, parsed) as unknown as T
  } catch {
    return base
  }
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(over)) {
    const b = base[k]
    const o = over[k]
    if (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o)) {
      base[k] = deepMerge(b as Record<string, unknown>, o as Record<string, unknown>)
    } else if (o !== undefined) {
      base[k] = o
    }
  }
  return base
}
