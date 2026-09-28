// What `GET /api/git` and `GET /api/git/scan` answer.
//
// A file of its own so the API client can name them without importing the panel, which imports the
// DOM — a type-only import that drags a rendering module into every consumer is how a headless
// test ends up needing a document.
//
// NOTE WHAT IS NOT HERE: the credential. The service reports whether one is stored and which host
// it is for, and has no field that could carry the token back.
export interface GitStatus {
  root: string
  repo: boolean
  lfs: boolean
  credential: { set: boolean; kind: string | null; host: string | null; username: string | null }
  remote: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changed: { code: string; file: string }[]
  untracked: number
  lastCommit: string | null
  tracked: string[]
  error: string | null
}

export interface GitScan {
  files: number
  bytes: number
  big: number
  exts: { ext: string; files: number; bytes: number; lfs: boolean }[]
  lfs: string[]
  truncated: boolean
}

