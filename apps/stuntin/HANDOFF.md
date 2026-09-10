# HANDOFF — stuntin

Read [MILESTONE.md](MILESTONE.md) then [DECISIONS.md](DECISIONS.md).

Start here: `just bridge-dev stuntin`, open http://localhost:5181, drive the
three built-ins, then open the editor and build something with a loop. The
whole feel of the game is `apps/stuntin/src/sim/Tuning.ts` + `Car.ts`; nothing
has been tuned by a human yet.

Useful from the shell (`just bridge '<js>' stuntin`): `apex.sim.car`,
`apex.track.lanes`, `apex.editor.current`, `apex.game.startDrive()`,
`apex.sim.car.placeOn(apex.track.lanes[3], 10, 30)` to teleport.

Known rough edges: the chase camera can still clip road in very tight
geometry; the jump lip is subtle at low speed; tube walls are visual only;
no touch controls; audio never heard.
