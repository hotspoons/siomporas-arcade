# HANDOFF — coast

Read MILESTONE.md then DECISIONS.md. `just bridge-dev coast` → http://localhost:5182.
From the shell (`just bridge '<js>' coast`): `apex.sim`, `apex.snap`, `apex.view`
(`apex.view.view = 'cockpit'`), `apex.game.startRun()`, and
`apex.sim.z = apex.sim.stage.metres - 300` to jump to a fork.

Tuning lives in `src/sim/Tuning.ts` (physics, traffic, clock) and
`src/render/RenderTuning.ts` (camera heights, fog, palettes). Stage data is
`src/sim/Stages.ts`; sprite/model mapping is `src/render/models.ts`.
