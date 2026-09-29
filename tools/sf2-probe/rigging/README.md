# Rigging a reconstruction, headlessly

`tools/recon-service` turns one keyed view of a character into a textured mesh. This turns that
mesh into a rigged character: a Rigify control rig, bone-heat weights, textures intact, exported as
a `.glb` any engine will load.

```bash
blender --background --factory-startup --python rig_character.py -- \
  --in  mesh.glb \
  --out rigged.glb \
  --blrig <path>/blmcp_ext/rigging \
  --renders ./shots          # optional: four posed workbench renders
```

Needs **Blender ≥ 5.1** — the declared minimum of the `blender-agent` addon — and `blrig` from
[Rich-Siomporas/blender-agent](https://projects.blender.org/Rich-Siomporas/blender-agent), branch
`feature/overhaul`. No MCP server, no agent, no LLM: `blrig` is a deterministic library and imports
straight into `blender --background`. The agent harness is for when a human is asking questions;
this path is a script.

Rigging is CPU work; no GPU is wanted anywhere in it.

## Getting Blender 5.1 in the container

Debian ships 4.3 and blender.org publishes **no arm64 binary for 5.x**, so the devcontainer installs
it itself — `.devcontainer/build-blender.sh`, ported from `blender-agent`'s copy and pinned by
`.devcontainer/blender.env`:

- **x86_64** takes the official binary from download.blender.org. Seconds.
- **arm64** clones the pinned tag and builds from source against Blender's own precompiled libraries
  (`projects.blender.org/blender/lib-linux_arm64`), so only the toolchain comes from apt. Tens of
  minutes the first time, incremental after that.

`post-create.sh` starts it in the background, because nothing else in the container waits on it. A
shell tells you where it got to; `just blender-log` shows the tail, `just blender` runs it in the
foreground, and `BLENDER_SKIP_INSTALL=1` opts out. It is idempotent and takes a lock, so running it
twice is a no-op.

Verified on aarch64: the source build produces 5.1.2, and `--export-joints` against
`mesh-arms-clear.glb` reproduces the numbers in this README exactly — 16.5% asymmetry, 315 boundary
edges, a watertight 22k-vert cage at 0.0%, and 27 body joints out. The arm64 build is not a
different answer from the amd64 one.

It symlinks `/usr/local/bin/blender`, which precedes `/usr/bin` on PATH — without that the distro's
4.3 keeps winning and `blender --version` looks fine while this script cannot run.

## The result on Kestrel

```
cage    22,290 verts   watertight    asymmetry 0.0%
rig     706 bones      160 deform    verify ok
export  1 skin / 706 joints, POSITION NORMAL TEXCOORD_0 JOINTS_0 WEIGHTS_0, 2 images
```

## Why there is a throwaway cage

Bone-heat weighting diffuses heat across a closed surface. A reconstruction is not closed, and the
holes let the heat escape, so bones acquire vertices nowhere near them — the arm bone ends up
owning the torso. Posing the arm then drags the body with it. This is not subtle, and blrig's own
`verify` catches it:

| check | rigging the mesh directly | rigging a watertight cage |
|---|---|---|
| `pose_upper_arm_fk.L_volume` | **31.451** | **0.961** |
| `pose_upper_arm_fk.R_volume` | **31.439** | **0.963** |
| `pose_thigh_fk.L_volume` | **6.188** | **0.911** |

A volume ratio of 31 means the mesh inflated thirty-fold when one arm moved. The only difference
between those columns is a voxel remesh.

Worth knowing how little it takes: after merging duplicate vertices this mesh was down to **315**
boundary edges out of 103,000, and 315 holes were still enough to ruin every weight on the figure.
"Mostly closed" is not a thing.

So a voxel remesh produces a guaranteed-watertight **cage**, Rigify and bone-heat weight the cage,
those weights are transferred onto the original mesh, and the cage is deleted. The cage is a
weighting instrument, not an asset — it has no UVs.

**A useful side effect:** blrig gates character rigging at 10% asymmetry and a single-view
reconstruction does not pass (this one measured 16.5%), so something must be symmetrised. Because
it is the *cage* that gets symmetrised and not the mesh, the asset keeps its asymmetric costume —
Kestrel's vest tail stays on one side instead of becoming a skirt — while the rig is still built
from a symmetric body. Symmetrising the mesh itself gives her two tails.

## Things that cost an hour each

- **Rigify limbs are IK-driven by default.** Rotating `upper_arm_fk.L` renders *identically to
  rest* until `IK_FK` on the limb's `*_parent` bone is set to `1.0`. Three renders came back
  byte-identical before this turned up.
- **`bpy.ops.object.data_transfer` cannot transfer all vertex groups.** Its `layers_select_src`
  accepts only `ACTIVE`/`NAME`/`INDEX`. The Data Transfer *modifier* has
  `layers_vgroup_select_src='ALL'`, which is what moving 160 deform groups in one pass needs — and
  `datalayout_transfer` has to create the destination groups first or `NAME` matching lands on
  nothing.
- **The glTF importer rotates Z-up data to Y-up.** Rigify wants +Z up and the metarig fit reads the
  bounding box, so this must be undone and applied before anything measures the mesh.
- **Centre on the symmetry plane, not the bounding box.** A lopsided mesh has a lopsided bbox, and
  `symmetrize` mirrors about the object's X origin.

## What this does not do yet

- **No animation.** A rig that deforms is not a fighter. The sprite poses in
  `tools/photogrammetry` are the intended source: `lift_poses.py` solves joint rotations from the
  2D frames, and those rotations want mapping onto these bone names.
- **Not wired into a game.** Output is a `.glb` on disk. Promoting one is deliberate: copy it into
  the owning game's `public/`, and let the existing sprite bake pick it up.

## Correcting joint positions by hand

blrig fits the metarig by **scaling a human template to the mesh height**. It does not snap knees
and elbows to where they actually are, and re-running does not improve it — for a stylised
character the joints land wrong and stay wrong. (Perception-driven joint snapping from
cross-section minima is named as open work in blrig's own `PROGRESS.md`, and
`blrig/perception/sections.py` already computes the cross-sections it would need.)

Until that exists, the correction is a human looking at it. Open the model viewer —
`apps/arcade/public/models.html`, live at `arcade.siomporas.com/models` — load the mesh, and
**Import** the joints file onto it, or drop the `.json` anywhere on the page. The **Rig** tab in the
right-hand rail is the editor; **Rendering** and **Loaded** are the other two. Everything you do is
kept in the browser and comes back on reload — `?fresh=1` starts clean.

**Pose or Rig.** These are different jobs and the panel is explicitly in one or the other.

- **Pose** rotates joints and lets the skin follow — **Sweep** swings the active joint through
  ±70°, which is how a badly placed joint gives itself away: the limb visibly bends from the
  wrong place. Rotation here is scratch and is never exported.
- **Rig** moves the joints themselves and holds the mesh *still*, by recomputing the skin's bind
  against every edit. That is the right way round: in a bad rig the mesh is what is correct and the
  skeleton is what is wrong. Toggling back to Pose shows what the correction did to the skin.

**Placing many joints at once.** Ctrl+drag — **Cmd**+drag on a Mac, where Ctrl+click is a secondary
click — draws a box over the viewport to select joints. The **Box** button drops the need for a
modifier entirely; Alt+drag still orbits while it is armed, and plain drag always orbits. **Move**
drags the whole selection. **Pivot** — the button, or Alt+Shift+click a joint — pins one joint, and
**Rotate** then swings everything selected around it, which is how a whole limb chain gets re-aimed
in one gesture. Ctrl+Z and Ctrl+Shift+Z undo and redo, one step per gesture.

**Only the selected joints move.** A bone's position is relative to its parent, so moving one
ordinarily carries its entire subtree — pick the three thumb joints, drag, and the rest of the hand
comes with them, which is posing rather than rigging. Every joint below a moved one that was not
itself selected is put back where it was. Selecting a whole hand and dragging still moves it in one
piece; that is what selecting the whole hand means. The holding shows up in the export as small
compensating offsets on those children, which is truthful — their position relative to their parent
really did change — and leaves their world positions where they were.

**Mirror** pairs each joint with its opposite number and applies everything to both sides. The plane
is found from the joints rather than from the mesh, because a single-view reconstruction is
asymmetric on purpose while the skeleton under it is not: each joint is reflected across a candidate
plane, matched against any joint landing within a couple of millimetres, and the plane is refitted
from the median of those midpoints until it settles. On Kestrel's generated rig that pairs 134 of the
160 deform joints and finds 24 more sitting on the plane; on a 26-bone metarig, 28 nodes and 9.
Selecting one side selects both, dragging one drags both symmetrically, and a joint *on* the plane
gets the symmetric half of the gesture so it slides along the plane instead of being pulled off it.
The panel reports where the plane landed and how many joints paired — if that count is low, do not
trust it.

**Which joints.** The panel edits one of two things, and says which:

- **Metarig** — the ~27 head/tail joints of an `apex-metarig-joints/1` file. Heads and tails are
  points, and a connected child's head *is* its parent's tail, so those are merged into a single
  node: drag the elbow and both bones follow, the way Blender's edit mode behaves. Export writes the
  same format straight back for `--joints`, keeping the file's own `format`/`axis`/`units`/`height`
  and adding a `corrected` block recording what was edited against what.
- **Skeleton** — the ~160 `DEF-` deform bones of a rigged `.glb`. Export writes
  `apex-joint-offsets/1`. This is the rig's *output*, so prefer the metarig when you have one.

```json
{
  "format": "apex-joint-offsets/1",
  "source": { "path": "/assets/…/rigged-arms-clear.glb", "url": "https://…", "loaded": "…" },
  "units": "metres, in each bone's parent space",
  "joints": {
    "DEF-thighL": { "offset": [0, -0.03, 0.01], "rest": [...], "corrected": [...], "parent": "DEF-spine" }
  }
}
```

## The loop

`rig_character.py` has both ends and the viewer is the middle:

```bash
# 1. fit the metarig, hand its 27 body joints out for correction, and stop
rig_character.py -- --in mesh.glb --out mesh-for-editing.glb \
                    --export-joints joints.json --blrig <path>

# 2. ...drag the joints onto the real anatomy...

# 3. place the metarig from the corrected file, then generate and weight
rig_character.py -- --in mesh.glb --out rigged.glb --joints joints.json --blrig <path>
```

Step 3 injects between `fit_metarig` and `rigify_generate`, which is the only place a correction
takes: Rigify's generation and bone-heat weighting both run after it.

Step 2 is the viewer: load `mesh-for-editing.glb`, import `joints.json`, drag, export, and the file
that comes out goes straight back into step 3. It is the same document — same format, same bone
names, same axis — so nothing has to be translated between the halves.

Two formats exist and they are not interchangeable:

| | written by | what it describes |
|---|---|---|
| `apex-metarig-joints/1` | `rig_character.py --export-joints`, and the viewer's **Export metarig** | 27 **metarig** bones, head and tail — the rig's *input* |
| `apex-joint-offsets/1` | the viewer's **Export offsets** | offsets on the ~160 generated `DEF-` bones — the rig's *output* |

Only the first closes the loop. The second is for looking at a rig you already have and recording
what is wrong with it; `--joints` does not read it.
