# @apex/enginesim

A combustion engine, simulated, in a Web Audio node.

This is [AngeTheGreat's Engine Simulator](https://github.com/ange-yaghi/engine-sim) — the MIT one —
built to WebAssembly and bound to an `AudioWorkletProcessor`. It is not a sample set and not a
synthesiser approximating an engine. It is the crankshaft, the connecting rods, the combustion
chambers, the cam profiles and the exhaust, solved as a rigid-body system a few thousand times a
second, with the exhaust pressure convolved against a real impulse response. The note you hear at
3000 rpm is what eight cylinders firing 200 times a second through that exhaust actually sounds
like, which is why it never loops, never crossfades, and does the right thing at every RPM in
between — including the ones you only pass through for a tenth of a second.

Two audiences, one audio path:

- **The game** calls `drive(rpm, pedal)` every frame and gets a noise.
- **The asset engine** opens the bench and gets every knob the simulator has.

```ts
import { EngineSim } from '@apex/enginesim'

const engine = await EngineSim.create(audioContext)   // from a click, or it will not play
await engine.load('engines/atg-video-2/07_gm_ls.mr')
engine.connect(audioContext.destination)
engine.drive(3200, 0.7)                                // every frame
```

```
npm run bench -w @apex/enginesim     # the tuning interface, on :5198
```

Two places to turn knobs, for two different jobs. The **bench** voices an engine as an asset: a
dyno, a throttle, every synthesiser parameter, and a sparse preset to copy out. Corridor's **F6
panel** has an `engine` tab for the car you are driving right now — the gearbox, the engine picker
and the same voicing knobs — so you can tune it at speed and paste the JSON back into the defaults
in `apps/corridor/src/tuning.ts`.

## How it is put together

```
   your game                     the audio thread
  ┌──────────────┐              ┌────────────────────────────────────┐
  │ Car (speed)  │              │  worklet.js                        │
  │      ↓       │  AudioParam  │   ┌──────────┐    ┌─────────────┐  │
  │  Drivetrain  │ ──rpm,pedal─▶│   │ Simulator│───▶│ Synthesizer │──┼──▶ output
  │      ↓       │              │   │ (physics)│SPSC│ (convolve)  │  │
  │  EngineSim   │ ◀─telemetry──│   └──────────┘    └─────────────┘  │
  └──────────────┘   postMessage└────────────────────────────────────┘
```

Everything inside the box is one wasm instance in one thread. `es_render()` in
`native/apex_enginesim.cpp` advances the physics exactly as far as the audio callback needs and no
further, so control-to-sound latency is one render quantum.

### Why not upstream's own browser build

Open Engine Simulator already has an Emscripten target, and it is the wrong shape for a game twice
over.

It runs the simulation on the browser frame and the synthesis in an audio worklet, which means two
threads sharing one wasm memory, which means `-pthread`, `SharedArrayBuffer`, and **COOP/COEP
cross-origin isolation on whatever page embeds it**. Corridor loads imagery and tiles from other
origins; isolating the whole document to get engine noise is the tail wagging the dog. Running both
ends in the audio thread costs nothing — a single-producer/single-consumer queue does not care that
the producer and consumer are the same thread — and asks nothing of the page.

The other path, the legacy PCM queue that upstream's headless renderer drives, is
`#if !defined(__EMSCRIPTEN__)`'d out of existence. In a wasm build `pumpAudioRendering()` returns
false and `readAudioOutput()` memsets silence. Port that loop and you get a clean build, a running
simulation, correct RPM telemetry, and no sound at all. That trap is the reason `scripts/measure.mjs`
asserts the audio rather than the API.

### Why the gearbox is ours

engine-sim ships a `Transmission` and a `Vehicle` and will happily drive itself. Using them means
two simulations both deciding how fast the car is going, and they will not agree — corridor's `Car`
has a tyre model, a slide, aero drag and a suspension engine-sim has never heard of. So the car
stays authoritative, `Drivetrain` turns road speed into a crankshaft speed, and the engine is held
there. The combustion is still entirely simulated; only the drivetrain is ours.

`Drivetrain` earns its keep at the gearchange. A shift is the most recognisable sound a car makes
and it is not a jump in pitch: the clutch goes in, the engine drops off load and falls, the next
gear catches it. Interpolating between ratios without that gap is the giveaway of a fake engine.

## What it costs

Measured on the development machine (ARM container, one core), GM LS V8 at 48 kHz, from
`scripts/measure.mjs`:

| | |
|---|---|
| sweep 800→6500 rpm | **2.2× realtime**, 45% of one core |
| budget per 128-frame quantum | 2.67 ms, using 1.19 ms |

That is a real slice of a core, in the audio thread, for one engine. It buys something no sample set
can, and it does not buy a car park full of them — traffic should get recorded samples driven off
the same `Engine` component fields.

The obvious lever looks like the exhaust convolution: it is a naive time-domain FIR running ~7,500
taps per sample per exhaust, some 720 million multiplies a second. **Measured, it is not.** Once
vectorised (`-msimd128`, which on its own moved the whole thing from 1.24× to 2.24×), the entire
range from 7,500 taps down to 512 is worth about 13% of a core, while the solver and synthesis
underneath cost ~33% regardless — and cutting below 2048 taps costs ~20 dB of timbre. So the tail
stays. `setSimFrequency()` is the knob to reach for first; `es_set_ir_limit` exists for a weak
machine, not as a default.

Some engines cost much more than others: the Honda TRX520 asks for a 40 kHz simulation where the
GM LS asks for 10 kHz.

Shipped size: **1.28 MB wasm, 397 kB over the wire gzipped**, including 20 engine definitions, the
Piranha interpreter and the impulse-response library.

## Files

| | |
|---|---|
| `native/apex_enginesim.cpp` | the C API over upstream's core — the only C++ we wrote |
| `src/EngineSim.ts` | the host: node, handshake, controls, telemetry |
| `src/processor.js` | the `AudioWorkletProcessor`; plain JS because it is concatenated after generated glue |
| `src/Drivetrain.ts` | road speed → engine speed, with shifts |
| `src/params.ts` | the tuning knobs, as data; the bench renders this table |
| `bench/` | the tuning interface |
| `wasm/` | **generated and committed** — see below |
| `scripts/build-wasm.mjs` | fetch upstream, build, emit `wasm/` |
| `scripts/bundle-worklet.mjs` | glue + processor → `wasm/worklet.js` |
| `scripts/measure.mjs` | does it make a noise, and is it fast enough (Node) |
| `scripts/verify-browser.mjs` | does it survive a real `AudioWorkletGlobalScope` (Chromium) |
| `scripts/verify-bench.mjs` | are the sliders wired to anything |

`wasm/` is committed on purpose. Requiring a C++ toolchain, Flex, Bison and a 1 GB Emscripten SDK to
run `npm run dev` would be a poor trade for files that change about once a quarter.

## Rebuilding

Only needed when the upstream pin moves or `native/` changes.

```
sudo apt-get install -y cmake ninja-build git flex bison python3 build-essential
node packages/enginesim/scripts/build-wasm.mjs        # installs its own Emscripten
node packages/enginesim/scripts/measure.mjs
node packages/enginesim/scripts/verify-browser.mjs
```

After editing `src/processor.js` alone, `scripts/bundle-worklet.mjs` is enough and takes a second.

Two portability notes worth keeping: Piranha uses MSVC-style in-class template specialisations that
**GCC rejects and Clang accepts**, so the upstream libraries must be built with Clang (Emscripten is
Clang, so the wasm path is fine; a native GCC build of the scripting layer is not). And Emscripten
prunes the set of `Module` properties it reads, so `wasmBinary` is silently ignored — the processor
uses the `instantiateWasm` hook instead, which is in the default set.

## The baked library

One simulated engine costs about 45% of a core. That is the right price for the car you are
sitting in — the note is the actual resonance of the actual cylinders firing at the actual RPM,
so it never loops and never crossfades — and the wrong price for the twenty cars going past.
Those get **packs**: the same engine, the same script, the same synthesizer, recorded at a ladder
of revs and played back on four `AudioBufferSourceNode`s.

```
npm run bake -w @apex/enginesim                        # every engine in the catalog
npm run bake -w @apex/enginesim -- --engine gm_ls      # ones whose path matches
```

It runs in **Node**, not a browser: the same wasm has a CJS build with the C API exposed, and
`es_set_follow_rpm` holds a fixed rev, which is exactly what a baker needs and what a game never
does. The whole catalog is 20 packs, 357 loops and about four minutes.

### Three things it works out rather than being told

**The redline is measured.** `es_cylinders` and `es_displacement` are exported; the rev limit is
not. But follow mode holds the rpm it is given exactly — to the hundredth, at every rev, with zero
drift — right up to the engine's own limiter, where it clamps. So asking for 100,000 rpm and
reading back what happened *is* the redline. Across this catalog that ranges from 3000 (the Merlin
V12 and the radials) to 18000 (the Ferrari 412 T2), which no typed default could have covered.
The first version typed 7000 for everything, and the GM LS then ran at 6500 while its top loop was
cut for 6999 — a permanent click on every traffic car.

**The loop is a whole number of engine cycles.** An engine repeats every two crank revolutions,
whatever the cylinder count, which is 120/rpm seconds; a loop of any other length clicks once per
wrap at a rate that tracks the revs. That length is rarely a whole number of samples, so the
*bake* rpm moves onto the nearest one whose cycle is — at most 1.4 cents away — and `playbackRate`
puts the exact rev back at playback.

**The loop is crossfaded closed, and alignment is what makes that free.** Cycle alignment lines up
the *periodic* part, and this synthesizer is not purely periodic: it has noise in it, and noise
does not repeat. Measured, that left the wrap discontinuity as a random draw from the noise
amplitude — a fixed threshold kept the GM LS at 3422 rpm and dropped it at 4238, kept the LFA at
9000 and dropped it at 5772. Scattered, not systematic, which is the shape of measuring noise
rather than a fault. So one extra cycle is rendered and faded over the head: `out[0]` then
literally *is* the sample that followed `out[N−1]`, and because the two sides are one whole cycle
apart their periodic content is identical, so the fade averages only the noise. The bake asserts
both halves — that the indices close the loop **exactly** (`out[0] === x[N]`, one right answer),
and that a deliberately misaligned crossfade smears several times more than the aligned one, so
the arithmetic is provably what is doing the work rather than luck.

A note on measuring that, because it caught me out twice. Once the loop is crossfaded the wrap is
a *genuine sample step* of the signal, so "how big is the step at the wrap" can no longer fail:
the Audi I5 at 1547 rpm has a legitimate step there larger than its own 99th percentile, and a
threshold on it failed a loop that was closed to the bit. The size of the wrap is recorded per
layer; the exact index comparison is what is enforced.

### Playing one back

`SampledEngine` has the same interface as `EngineSim` — `drive(rpm, pedal)` and an `output` node —
so `SpatialVoice` cannot tell which it is feeding and a traffic car can be promoted to the
simulated voice by swapping one object.

Four sources, not one per layer: the rev is between two layers and the throttle is between closed
and open, so the mix is a bilinear blend of four recordings. Blended equal-gain in both
directions, because they are recordings of the same engine and sum coherently — the same reason
the interior and exterior buses blend linearly in `voice.ts`. Each source starts at a random point
in its loop, so four cars on one street do not phase-lock into a single loud one.

`probes/enginesim-sampled.mjs` measures the **firing frequency** of what comes out: a four-stroke
fires cylinders/2 times per revolution, so at R rpm with C cylinders the fundamental is R·C/120 Hz.
At five revs chosen deliberately between baked layers it lands within 0.11%. The control is a fact
about engines rather than about this code — at one rev, a V12 must fire exactly 1.5x a V8, and it
measures 1.499. Remove the playback rate and every pitch check fails; remove the upper layer from
the blend and the steps across a layer boundary go from 1.17x to 14.9x.

Two notes on measuring that, because both cost a round. An engine's spectrum is a comb of ORDERS
at multiples of half the crank frequency, so a search band of +/-20% around the firing frequency
finds the neighbouring half-order instead and reports a confident "off by -12.5%" twice. And the
level is *not* flat across the rev range: every layer is baked to the same peak, so what varies is
the waveform — a V8 at 550 rpm fires 37 times a second with silence between, at 5800 it is a
continuous tone, and the 30 dB between them is the thing sounding like an engine. What must hold
is that a layer boundary is no bumpier than anywhere else, which is what is asserted.

`packs/` is gitignored: it is a working artefact, and nothing needs twenty engines of traffic.

## Upstream, and the licences

We build against [Open Engine Simulator](https://github.com/zabayone/open-engine-sim), the
community fork, rather than the original. The original's browser story is a
[2022 blog post](https://bobsayshi.lol/blog.html#15-Aug-2022) whose patches were never published;
the fork carries a maintained Emscripten path including the lock-free realtime audio hand-off this
package binds, and keeps upstream attribution and the MIT notices.

Everything we link is MIT, Copyright 2022 Ange Yaghi: `engine-sim` itself, `piranha` (the scripting
language), `simple-2d-constraint-solver` (the physics). The engine definitions and the
impulse-response library shipped inside the wasm come from the same MIT repository. Our own code
here is Apache-2.0 like the rest of this repo. See `CREDITS.md` and `NOTICE` at the root.
