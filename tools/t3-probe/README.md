# t3-probe — driving Namco System 12 headlessly

The 3D counterpart to `tools/sf2-probe`. It boots Tekken 3 in MAME with no video and no sound,
drives it from attract mode into a two-player fight, and reads the board's memory while it plays.

Findings live in `apps/fighter/research/rom/tekken3/README.md`. **Read that first** — it has the
memory map, the numbers, and the four expensive mistakes not to repeat.

    tools/t3-probe/run.sh measure.lua                  # walk, sidestep, jump; writes measure.csv
    node tools/t3-probe/motion.mjs                     # turn that into units per frame

    tools/t3-probe/run.sh walkline.lua                 # dump RAM along a walk
    node tools/t3-probe/walk.mjs                       # which words follow the stick

    tools/t3-probe/run.sh findpair.lua                 # move each player alone
    node tools/t3-probe/pair.mjs                       # the stride between the two fighters

    tools/t3-probe/run.sh findhealth.lua               # land punches
    node tools/t3-probe/hp.mjs                         # which word is health

Environment: `PROBE_SECONDS` (emulated seconds to run — must cover the whole schedule),
`PROBE_TIMEOUT` (wall-clock kill), `PROBE_OUT` (where dumps and CSVs land).

## Why this is not sf2-probe

**No savestates.** MAME reports `savestate="unsupported"` for every System 12 and Model 1/2/3
driver. The 2D harness boots once, saves, and then loads that state for each of several hundred
probes; here every run starts from cold and drives the whole sequence itself. So `lua/common.lua` is
a **schedule**: `M.at(frame, fn)`, `M.tap(frame, player, buttons, len)`, `M.tapCoin`, `M.tapStart`,
and `M.run(each)` to install the frame hook. A probe is a list of things that happen at frame
numbers, not a function that can ask the board a question whenever it likes.

It is cheaper than it sounds — headless the board runs at ~440% of real time, so cold boot to a
live two-player fight is about 30 seconds.

**Main RAM is 4MB and the live half is the top one.** `M.LIVE_BASE`/`M.LIVE_SIZE` point at
`0x200000`–`0x3FFFFF`. Dump that, not the first 2MB, which is code.

**Both start buttons.** `M.tapStart(f, 1)` then `M.tapStart(f + 60, 2)`. Pressing only player two's
starts a game against the machine that looks like versus and is not, and a moving opponent makes
every differential measurement meaningless.

## The method, since it is most of the work

Nearly all of this RAM is per-frame scratch — display lists, vertex and colour buffers, skeleton
transforms — so "a word that changed when I did X" is worth nothing on its own. What works is
demanding several independent behaviours at once:

- **constant through a long quiet period**, sampled at *irregular* gaps so an animation loop cannot
  make two samples agree by accident;
- **moving in proportion to the input** — a walk is constant-speed, so the increments between
  samples must match, not merely share a sign;
- **and stopping when the input stops**, which is what kills the display lists: they keep churning.

`walk.mjs` and `hp.mjs` are both built that way, and the comments in them say which filter is doing
the work. A filter that is silent on known-good data is the only kind worth having: the analogous 2D
check in `scripts/fighter-contact.mjs` was tuned until it said nothing about the four ripped
characters, and the same discipline applies here.

## If you need the debugger

`-debug -debugger none` makes MAME's device debugger reachable from Lua —
`manager.machine.devices[":maincpu"].debug` then has `wpset`, `bpset`, `wplist`. Without `-debug` it
is nil. A write-watchpoint on the health bar's geometry is the intended next step for finding the
logical health value, which differential search could not.

Careful: `wpset` with `nil` for the condition and action **segfaults MAME**. Pass strings.
