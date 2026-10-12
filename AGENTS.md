# Working in this repository

siomporas-arcade is a collection of games inspired by the 80s and 90s, in TypeScript and
three.js, served as one browser arcade. The games are `apps/arcade` (the shell and lobby that
mounts them), `apps/conduit` (Apex Conduit), `apps/stuntin` (Stuntin'), `apps/coast` (Turbo
Radrun) and `apps/fighter` (Concrete Crown, unlisted). Each app has its own README, MILESTONE, DECISIONS and HANDOFF.

The shared runtime packages are `packages/engine` (`@apex/engine`), `packages/enginesim`
(`@apex/enginesim`) and `packages/stunt-pieces` (`@apex/stunt-pieces`). They are consumed as
TypeScript source, through `"exports": {"./*": "./src/*.ts"}`, with no build step.

## The other consumer

The same three packages are also the engine dependency of
[piedmont](https://github.com/hotspoons/piedmont), a separate repository that was split out of
this one. Piedmont pins a commit of this repo and consumes the packages exactly as the games
here do, so their public surface has to stay stable across a pin. When changing one:

- keep engine changes backwards-compatible, or note the break in the package changelog;
- land the change here (its own branch, review and merge) and tag the commit
  (`engine-vYYYY.MM.DD`) so a pin can be moved to it;
- do not special-case piedmont in the engine.

## Before a push

`npx vitest run` from the repository root is the whole CI test gate: the apps' and packages'
suites, the repo's own `node --test` suites (`scripts`) and `oxlint`, the last two through the
`checks` project in `tools/ci/`. Run it, and gate on its exit status, before every push; CI runs
the same command plus `tsc -b` and the build. `just check` runs the whole thing (lockfile, lint,
`tsc -b`, `vitest`).

`npm install` writes a lockfile that describes only the machine it ran on, and the first thing to
fall over on CI is a native binary that is missing. Regenerate it whole when dependencies change:
`rm package-lock.json && npm install --package-lock-only && npm install`; `npm run check:lockfile`
fails with the missing platforms listed.
