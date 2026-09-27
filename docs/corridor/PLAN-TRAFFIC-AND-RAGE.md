# Traffic, and two games that need it

**Status:** design, 2026-09-27. Rich asked for two mechanics written down:

> One is essentially a tractor beam where you can take someone driving slow in front of you in a
> no passing zone and move them over top of your car and place them behind you on the road.

> The second is a carmageddon style rage simulator where you are stuck in traffic on a major road
> like route 3 in Crofton and you freak out and start firing missiles blindly at cars in front of
> you to clear the way … for your time sensitive goal.

> Of course both require physics and threat of wrecking and all that. We also need real life
> systems simulators to simulate ebbs and flows in traffic at lights.

That last sentence is the real one. Both games are a layer over **other cars that behave like other
cars**, and so is everything else this engine does — the hunt, the parkour, and plain driving. So
this document is mostly about traffic, and then about the two things you can do to it.

---

## 1. The bake already knows how the roads work

This is the part that decides whether the traffic model is real or hand-waved, and it is already
done. Measured on `crofton-triangle`:

| what | how much |
|---|---|
| junctions in the model | **408** |
| signalised | 12 |
| all-way stops | 27 |
| two-way stops (priority) | 369 |
| approaches carrying a lane count | **1,287** |

And per junction the bake carries, from OSM and the geometry:

- **`approaches[]`** — which road, its name and class, its **rank**, its **lane count**, the bearing
  it arrives on, the side (`sgn`), whether it is a **through** movement, whether it must **stop**,
  the **stop line's own position** (`stop_x`, `stop_y`), the approach **width**, and the **phase**
  it belongs to;
- **`phases[]`** — `{ arms, green_s, amber_s, all_red_s, superior }` — and `cycle_s`;
- **`superior`** — which road has priority, which is what a two-way stop means;
- `turn:lanes` from OSM where it exists, which is what tells a car in the left lane that it turns
  left;
- and `branches[].junctions[].with[]` — the roads that meet at a node, which is the **connectivity
  graph** a route is found on.

So a signal plan is **data**, not something to invent: a light cycles because the bake says that
junction has two phases of those lengths, and a car stops at a stop line because the bake put the
line there. Nothing in §2 needs a new data source.

---

## 2. The traffic model

### 2.1 One car following another (the ebbs and flows)

Use the **Intelligent Driver Model** for longitudinal behaviour and **MOBIL** for lane changes.
Both are four decades of traffic engineering in about thirty lines each, and — this is the point —
the stop-and-go waves Rich means by "ebbs and flows" are *emergent* from them. Nobody has to script
a jam: give a hundred IDM drivers a signal that turns red and the queue, the shock wave running
backwards through it, and the platoon that leaves on green all happen by themselves.

Each driver gets a personality (desired speed as a fraction of the limit, headway, politeness,
reaction) drawn from a seed, so the same road is populated the same way twice, and one of them is
always the person doing 38 in a 50.

### 2.2 Junctions

- **Signals**: run the baked `phases` on `cycle_s`. A car approaching a red gets a virtual
  stationary leader at its own stop line — that one trick makes IDM queue correctly with no
  special case.
- **Two-way stops** (369 of the 408 here, so this is the common case): the inferior approach yields.
  Gap acceptance — a driver takes a gap in the superior stream if it is longer than its critical
  gap, which is another personality trait, and which is why an impatient one pulls out in front of
  you.
- **All-way stops**: first-come-first-served on arrival order at the stop line.
- **Turns**: from `turn:lanes` where OSM has it, otherwise by the junction's own geometry.

### 2.3 How much of it is simulated

The same discipline as the rest of the viewer (`gradeNear`, the imagery stream, the tree replant):

- **Full fidelity within ~500 m of the player.** IDM per car, per tick, is nothing — a few hundred
  cars is a fraction of a millisecond.
- **A flow model beyond that.** Roads outside the near zone carry a *density and a mean speed*, not
  cars. Vehicles are spawned at the boundary at the rate that flow implies and despawned when they
  leave it. The point is that when you come back to a road it is as busy as you left it, and that a
  queue at a light you cannot see still drains into the one you can.
- **Seeded and deterministic**, so a probe can assert a jam.

### 2.4 What traffic needs that does not exist yet

Honest list:

- **a routing graph**. `branches[].junctions[].with[]` names the roads that meet; it needs to
  become an actual graph with turn costs. Half a day.
- **a vehicle body that is not the player's car.** `car.ts` is a detailed single-car simulation —
  far more than a traffic agent needs. Agents want a kinematic body that follows a lane, brakes,
  and has a box; only the player's is fully simulated.
- **collision between arbitrary bodies.** Today the car collides with the ground, the road edge and
  trees (`treesNear`). Car-to-car needs a broad phase — the station grid is the obvious home,
  since it is already a spatial index over the road network.
- **a wreck as an obstacle.** A crashed car has to become something other cars route around, which
  is where §4 gets its teeth.

---

## 3. The tractor beam

> "take someone driving slow in front of you in a no passing zone and move them over top of your
> car and place them behind you"

### 3.1 The mechanic

Hold the button with a car ahead, inside range and closing: the beam latches. The target's body
goes **kinematic on a spring** to a hold point above and behind your roof; it rides there while you
drive; releasing sets it down. Set it down badly and it lands on its roof, or on someone else.

Three states with different rules, because the middle one is where the game is:

| state | what it costs you |
|---|---|
| **latching** | you must hold station behind them — closing too fast breaks the lock and taps their bumper |
| **carrying** | the car is on your roof. Your centre of gravity is two metres up and a tonne and a half heavier; `car.ts` already reads roll and pitch from four wheel contacts and computes grip from load, so a raised, heavier mass makes the handling worse **for free and honestly** |
| **placing** | speed match and alignment. Put them down straight, in their lane, facing the way they were going, and nothing happens. Put them down sideways at 40 mph and you have caused what you were trying to avoid |

### 3.2 Why a no-passing zone is the right place for it

Because the bake knows exactly where those are. The road builder already decides where to lay a
**double yellow** (a two-way carriageway paints one; a divided one does not), so "you may not pass
here" is a fact the world already draws. The beam is the answer to a question the road is asking.

Scoring follows from that: using it on a clear road with a dashed line is a stunt; using it on a
blind double-yellow bend behind a tractor is the *point*.

### 3.3 The threat of wrecking

- **Clearance.** The bake carries bridge decks with a measured `clearance_m`. Driving under an
  overpass with a car on your roof is a real question with a real number behind it, and getting it
  wrong shears the load off. This is the single best use of the fact that this world is measured
  rather than invented.
- **Trees.** `treesNear` already gives trunk positions and radii; a carried car is wider and higher
  than you are.
- **The beam's envelope.** Mass × speed × steering rate. Exceed it and the lock breaks — and a car
  released at speed is a projectile, not a gift.
- **The other driver.** They do not enjoy this. On release they brake hard, which the traffic model
  handles as an emergency deceleration, which propagates backwards through everyone behind them:
  the wave you caused arrives at you later.

### 3.4 Depth worth building later

Lift and hold a whole queue (a chain, with the envelope shrinking per car); set a car down on the
verge instead of the road, which is faster but is where the trees are; place one *facing the wrong
way* to make the traffic model deal with it.

---

## 4. The rage simulator

> "stuck in traffic on a major road like route 3 in Crofton and you freak out and start firing
> missiles blindly at cars in front of you to clear the way"

### 4.1 The loop, and the joke inside it

A countdown — a flight, a school pickup, a meeting — and a route that will not make it because
Route 3 at half past five is Route 3 at half past five. A rage meter that fills while you are
stationary and drains while you move. Enough rage and the missiles unlock.

**And firing them makes it worse.** This is the design, not a moral:

- a destroyed car does not disappear. It becomes a **wreck**: a static obstacle in the same spatial
  index the traffic model routes on, occupying the lane it died in;
- the traffic model **reroutes around it**, which means the two lanes behind now merge into one,
  which is a *worse* jam than the one you were in;
- the queue you were in extends backwards past you, so you cannot even turn around;
- police response scales with what you have done, and their cars are more traffic.

So the honest outcome is that blind firing is how you lose, and the player discovers that by doing
it. A patient route — the frontage road, the right turn two junctions back — gets there. The game
is a commentary on the thing it simulates, which is the good kind.

### 4.2 What makes it fun anyway

It has to be *satisfying* to fire, or the lesson lands on nobody:

- ballistic missiles with real arcs, and `car.ts` already knows how to throw a car into the air and
  land it — the launch machinery from the crest-jump work is exactly this;
- cars that flip, roll, and come to rest as obstacles with the shape they landed in;
- secondary effects: a wreck in the oncoming lane, a lorry that jackknifes and blocks both, a
  wrecked car pushed by the ones behind;
- and one legitimate use: a missile can clear a *stalled* lane ahead of a green light that nobody
  is moving through. Occasionally the rage works, which is what makes it a trap.

### 4.3 Scoring

Two numbers that disagree: **time to the goal**, and **what it cost** — vehicles destroyed,
injuries implied, minutes added to everyone else's journey (which the traffic model can actually
compute, because it knows how long its agents took). The end screen shows both. "You made it with
four minutes to spare and added ninety-one minutes to other people's evening."

---

## 5. What to build, in order

Everything below the line is shared; the two games are thin on top of it.

| # | step | done when |
|---|---|---|
| 1 | routing graph from `branches[].junctions[].with[]`, with turn costs | a route between two named roads comes back and is the one a person would drive |
| 2 | traffic agents: IDM + lane following on the baked lanes | cars drive a road at a sensible density and do not overlap |
| 3 | signals from the baked `phases`/`cycle_s`; stop-line queueing | **a probe watches one junction cycle and sees a queue form on red and discharge on green** |
| 4 | priority at two-way stops (gap acceptance) and all-way ordering | inferior approaches wait for a gap and take it |
| 5 | flow model beyond the near zone, spawn/despawn at the boundary | driving away and back finds the road as busy as you left it |
| 6 | car-to-car collision + a wreck that is an obstacle | a wrecked car makes the traffic model route around it |
| 7 | **tractor beam** | lift, carry, place; handling degrades while loaded; clearance shears it off |
| 8 | **rage sim** | countdown, rage meter, missiles, wrecks that make the jam worse, two-number scoring |

Steps 1–5 are the "real life systems simulator" Rich asked for and are worth building whether or
not either game happens: a corridor with traffic on it is a different world from an empty one, and
the hunt and the parkour both get better the moment the roads have cars on them.

### Probes that must exist

- `corridor-traffic-signal.mjs` — watch one baked signal for a full cycle: the queue must **form**
  on red, **discharge** on green, and the discharge rate must be in the region of a real saturation
  flow (about 1,800 vehicles an hour per lane). A traffic model that cannot reproduce that number
  is not simulating traffic, it is animating it.
- `corridor-traffic-jam.mjs` — raise the density until the road jams, and assert a stop-and-go wave
  travels **backwards** through the queue. That is the emergent behaviour the whole model is for.
- `corridor-beam.mjs` — latch, carry, place; assert the handling envelope changes while loaded, and
  that a bridge with a measured clearance takes the load off.
- `corridor-wreck.mjs` — a wreck blocks a lane; assert the flow through that junction drops and the
  route the agents take changes.

---

## 6. Two things the world already has that make this better than it sounds

**Time of day** (`sun.ts`): rush hour is not a difficulty setting, it is half past five. The clock
already runs, and the traffic density can be a function of it — a real morning peak, a real
evening one, an empty road at two in the morning with the lights flashing amber.

**Weather and wetness**: a wet road already lowers grip (`WEATHER_GRIP_SCALE`) and already looks
wet. Rain on Route 3 at five is the worst version of the jam, and every piece of that is already
simulated.
