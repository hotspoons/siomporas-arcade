// Monaco's editor contributions have no types, because they have no exports.
//
// `editor.api.js` registers none of them — no suggest, no hover, no find — so ui/codeeditor.ts
// imports the ones this editor should have, by path, for their side effects. They are modules
// that exist and ship with the package; they simply have no `.d.ts`, because there is nothing to
// describe. A wildcard declaration says "these are real" without inventing a shape for them.
declare module 'monaco-editor/editor/contrib/*'
declare module 'monaco-editor/editor/browser/*'
