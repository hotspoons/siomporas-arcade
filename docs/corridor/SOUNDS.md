# Sounds

The sampled effects: tyres, crashes, guns, missiles. The engine is a different thing — it is
synthesised by `@apex/enginesim` and has its own bus (GAME-MODE.md, Audio) — and the menu blips
are a third (`ui/uisound.ts`). This is everything that is a recording.

Rich, 2026-10-09: *"find us a free sound bank we can use … different levels of tire squeal based on
turning force, crash and collision noises (a random set of noises that is picked from), explosion
noises for missile, missile launching noises, gun firing noises, gun hitting noises. And make sure
this sound bank is featured in the level editor with the ability to provide custom sounds for any
vehicle, actor, etc. and feature it in the code editor."*

## The bank

`apps/corridor/public/sounds/` — `bank.json` and a folder per slot, written by
`tools/sounds/build.py` from the CC0 sources listed in `tools/sounds/sources.json` (Kenney's
Impact and Sci-fi packs, BigSoundBank's per-file CC0 recordings, two OpenGameArt CC0 packs).
`CREDITS.md` beside it is generated from the same list. Nothing in the CC0 part needs attribution;
it is given anyway. The tyres are Rich's own recordings and are not free (below). The cuts are mono 44.1 kHz, trimmed to their onset, peak-normalised, as `.ogg`
with an `.mp3` twin for browsers that cannot decode Vorbis (Safari); the game picks by
`canPlayType`. 150 clips, 2.9 MB for both formats.

```
tools/sounds/.venv/bin/python -I tools/sounds/build.py          # everything, into public/sounds
tools/sounds/.venv/bin/python -I tools/sounds/build.py gun.fire # one slot
tools/sounds/.venv/bin/python -I tools/sounds/build.py --list
```

(`python3 -m venv tools/sounds/.venv && tools/sounds/.venv/bin/pip install soundfile numpy`
first; the sources download into `tools/sounds/.cache/`, which is ignored.)

### The slots

A slot is named for what the game wants to say, never for where the file came from. The list is
`SOUND_SLOTS` in `src/game/audio/soundbank.ts`; `SLOT_HELP` says what each is for. The bank must
have every one of them (`test/soundbank.test.ts` checks the shipped manifest).

| slot | when |
| --- | --- |
| `tire.squeal.loop` | the player's tyres, every frame: three loops light → heavy, crossfaded by slip (`squealMix`) |
| `tire.skid` | a skid's onset: the squeal level jumping from under 0.25 to over 0.6 in one frame |
| `crash.light` / `crash.medium` / `crash.heavy` | a contact, graded off its peak impulse by `crashSlot` with `CRASH_LIGHT_NS` / `CRASH_HEAVY_NS`; `crash.glass` is laid over a heavy one past 1.5× |
| `crash.soft` | hitting something that is not metal (actors; not wired yet) |
| `explosion`, `explosion.far` | every `boom()` — a missile landing, a program's `api.physics.explode` — two layers with different reach |
| `missile.launch` | `fireMissile` |
| `gun.fire` | each round, from `GunLayer.onFire`, at `SFX_GUN_GAIN`, unplaced (it is where you are) |
| `gun.hit`, `gun.hit.ground`, `gun.hit.glass` | where a round lands: a car or a structure, the road within a hand of the ground, a window (glass not wired yet) |
| `gun.fire.shotgun` | nothing plays it by itself — it exists to be aliased (`slot:gun.fire.shotgun` on a car's `gun.fire`) |

The traffic's own crashes are placed where they happen, in the car's own voice, and rationed to
`SFX_TRAFFIC_CRASH_PER_S` — a pile-up is one roar, not sixty taps. The player's contacts are
played by `watchPlayerImpacts`, at most one tap a sixth of a second (a scrape along a wall reports
a contact every step), a wreck always.

### Rich's own tyres

The BigSoundBank squeal was, in Rich's words, a mouse. The tyre slots are now cut from his own
recordings — the Lotus pirouette at an autocross, the Subaru scrubbing and squealing — kept in
`tools/sounds/own/` (his rights, with permission, **not CC0**; README.md there has the videos and
timestamps, and how to re-cut with yt-dlp + the venv's ffmpeg). `isolate_squeal` in build.py
takes the engine out: a 650 Hz–9 kHz band-pass under the boxer, then a spectral gate learned from
each clip's own run-in. `build.py --spectrograms` writes a PNG per slot into `.cache/` so the cuts
can be checked by eye; the Lotus lines sit clean at 1–2 kHz.

### Levels

Clips are set by loudness, not peak: `LEVELS` in build.py is an RMS target per slot (a wreck −12
dBFS, a tap −20, the squeal loops −22) with the peak held under −1 dBFS. `SFX_MASTER` defaults to
0.6 and the gun's report to 0.35 after the first listen was "way too loud".

## The sound board — `src/editor/library/soundboard.ts`

Because the cuts are made by spectrogram on this side and by ear on Rich's. Any clip — a bank
clip, an `asset:` entry, a URL, a file from the machine — on a waveform: drag a selection (or the
Start/End sliders), gain, pitch, fades, a high-pass and a low-pass (600–800 Hz takes a boxer out
from under a tyre), normalise, and a loop-close crossfade that folds the tail over the head so a
squeal can run. **Play** / **Loop** render the shape through an `OfflineAudioContext` from the
untouched decoded buffer; nothing is destructive. **Trim to selection** makes the selection the
new source so the handles have room again. **Save** writes a 16-bit wav to a catalog asset
(`asset:<id>/<name>`) that any slot can then name; **Download .wav** keeps it. It sits at the top
of the library's Sounds tab, and every slot's Edit box has a **Board** button that opens it in a
dialog with that clip and adds what is saved to the slot.

## Playing it — `src/game/audio/sfx.ts`

One `AudioContext`, made from the first `pointerdown` / `keydown` (the same hook as the engine's)
and never at load; one bus at `SFX_MASTER × master × sfx`; the player's mute combined with the
tab-hidden mute, never replaced by it; the bus ramped before the context is suspended. Clips
decode on first use and are cached by URL; `warm()` decodes a car's slots when drive mode starts.
Placed one-shots get an equal-power `PannerNode` (inverse distance, `SFX_REF_M` / `SFX_MAX_M`);
the listener is the camera, set once a frame in three's frame — no conversion, the impacts are
already in it. Twenty-eight live voices; past that the oldest stops.

`apex.sfx.stats()` over the bridge says whether the bank loaded, what decoded, what failed, how
many voices are live and whether it is muted. `apex.sfx.play('crash.heavy')` plays one.

## Which clip — `src/game/audio/soundbank.ts`

`SoundBank.resolve(slot, scopes)` walks the scopes nearest first — the thing's own document, then
the world's (`sfx.worldScope`, which `api.audio.override` writes), then the bank. The first scope
that *mentions* the slot wins, an empty list included: that is how a document asks for silence.
`pick` never returns the same clip twice running for a slot.

An entry in an override is one of:

| form | means |
| --- | --- |
| `crash-heavy/slam-3` | a bank clip (the `.ogg` is implied; `.mp3` is swapped in where needed) |
| `slot:gun.fire.shotgun` | another slot's clips, resolved under the same scopes |
| `asset:<id>/<file>` | a file uploaded to catalog asset `<id>`, stored as `sounds/<file>` (`PUT /assetsvc/catalog/<id>/sound/<file>`) |
| `https://…`, `/…` | a URL as it is |

## Per vehicle, per actor — the editor

`VehicleDoc.sounds` and `ActorDoc.sounds` are `SoundOverrides`: slot → entries. The validator
(`validateSoundOverrides`) refuses an unknown slot and a non-string entry, nothing more — whether
a file exists is the editor's business, and a clip that will not load plays as silence.

In the library, a vehicle's **Sounds** tab and an actor's **Sounds** group
(`editor/library/soundpicker.ts`) list every slot with what it is for and what it resolves to —
*bank · 18 clips*, *own · 2 clips*, *silent* — each with **Listen**. **Edit** opens the slot's own
list: add a bank clip from the menu, alias another slot, paste a URL, or upload a file (stored under
the build's asset, so a build with no model yet cannot upload — the note says so). **Make it
silent** writes `[]`; **Back to the bank** removes the slot. A weapon's *Fire sound* / *Reload
sound* are the same picker for one clip (`clipField`); they are stored on `WeaponDoc.audio` and
are not yet played by anything.

The **Sounds** tab in the library (`editor/library/sounds.ts`) is the bank itself — every slot,
every clip, a Listen on each, and the credits.

The preview player is a second `Sfx` on its own context, unlocked by the Listen click. It never
touches the game's bus.

## In a program — `api.audio`

```ts
api.audio.play('explosion', { at: { x, y, z }, gain: 0.8 })   // site metres; omit `at` to play at the player
const l = api.audio.loop('tire.squeal.loop'); l.set(0.6); l.stop()
api.audio.override('crash.heavy', ['crash-heavy/slam-1'])     // the world's clips, under every car's own
api.audio.override('crash.heavy', null)                       // back to the bank
api.audio.slots()                                             // [{ slot, desc, clips, loop }]
```

Loops are stopped and overrides put back when the program stops. With no audio host (a dry run,
a test) every call is inert and nothing throws. The host converts site metres to three's frame;
`program.ts` holds no audio code. The MCP `level_vocab` answer carries `sounds.slots` — every slot,
what it is for, and the bank's clip names — so an agent can write a `sounds` block without
guessing.

## Deploying

`deploy.mjs` copies, for every used build, the files its `sounds` entries name on catalog assets
(`asset:<id>/<file>` → `assetsvc/catalog/<id>/file/sounds/<file>`), with audio content types. The
bank itself is under `public/`, so it ships with the app.

## Not done

- `crash.soft` and `gun.hit.glass` have clips and no trigger yet: a soft thud when a car meets an
  actor, glass when a round meets a window (the hit test does not say what it hit).
- `tire.skid` plays on a skid's onset — the squeal level jumping from under 0.25 to over 0.6 in a
  frame, at most one every two seconds. A mounted weapon build's `audio.fire` is laid ahead of
  the vehicle's `gun.fire` (`playerWeaponSounds`); `audio.reload` still plays nothing.
- A missile launch recording. The bank's is Kenney's thruster under a thump — there is no CC0
  missile launch worth the name; Freesound has CC0 candidates (e.g. 211617, 854476) but downloading
  needs an account, which is Rich's to log into.
- Doppler on a missile's flight, a whoosh past the camera; wind at speed.
- Safari has not been heard. The `.mp3` twin is the whole provision for it.
