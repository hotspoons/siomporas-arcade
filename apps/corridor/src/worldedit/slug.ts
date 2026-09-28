// A name to the slug it is stored under.
//
// A file of its own and not a helper in define.ts, because define.ts reaches the asset service,
// which reads `location.search` at module scope — so a test that wants only this rule would need a
// browser to get at it.
/**
 * A name to the slug it will be stored under.
 *
 * MUST MATCH `slugify` in tools/worldeditor/geo.mjs, which is what the service actually applies.
 * If they disagree, the form shows one slug and the world is created under another — and the two
 * are checked against each other over a corpus in worldedit-forms.test.ts rather than by reading
 * both and hoping.
 */
export function slugFromName(name: string): string {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
