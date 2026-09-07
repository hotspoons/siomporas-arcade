# Decisions — drivin

1. **Track-space car physics, not a rigid body.** On a piece the car's state is
   (lane, s, lateral, speed, heading offset, lateral velocity). Curves are
   followed by construction; the player fights the centrifugal term with
   steering and tyre grip, banking adds a gravity term, and a normal-force check
   (`v²·k_up + g·up_y < 0`) decides when you leave the surface — so loops need
   speed and crests launch you. It is deterministic, cheap, and the same idea
   that made the tunnel game testable.
2. **Three regimes: track / air / ground.** Airborne is ballistic with *no*
   player attitude control (nose follows the arc, roll settles level): landings
   are about speed and angle. Ground is flat-world grass driving that rejoins
   a level-0 lane only when heading along it.
3. **Pieces are data + a path function.** Each piece: footprint in cells, ports
   (cell, side, level delta), lanes (`t → point, up hint, roll, surface?`).
   Baking resamples to 1 m with parallel-transport-free frames (the up hint is
   explicit, so loops and helices need no twist fixing).
4. **Ports match on shared grid edges at equal level.** The graph is walked
   from the start piece in driving direction; a piece entered "backwards" gets
   a reversed lane (a ramp driven downhill, a join used as a split).
5. **Laps count only when the start lane is entered from its predecessor.**
   Cutting across the grass is not a lap.
6. **Grip is arcade-high (2.2 g).** Tight 20 m curves are ~70 km/h; wide ones
   ~130; banking buys more. Tuned so the built-in tracks are drivable at speed
   without a sim-racer's discipline.
7. **Crash replay is a pose ring, not a re-simulation.** Six seconds of
   position/forward/up at 120 Hz, played back from a trackside camera.
8. **Tunnels are visual.** The road is the tube's floor; walls bounce you back.
   Riding the tube wall (as in the tunnel game) is a later expansion, as is
   non-tile geometry (real-road stages from gaussworks, see the reminder).
