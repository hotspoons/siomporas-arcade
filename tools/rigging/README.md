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

Blender publishes **no arm64 build for 5.x**, so this does not run in the aarch64 devcontainer or
on the GH200s. It needs an amd64 box, and no GPU — rigging is CPU work.

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

- **Joint placement is proportional, not anatomical.** blrig fits the metarig by scaling a human
  template to the mesh height; it does not snap knees and elbows to where they actually are. For a
  character with ordinary proportions that is fine. For a stylised one it will not be, and the fix
  — perception-driven joint snapping from cross-section minima — is named as open work in blrig's
  own `PROGRESS.md`. `blrig/perception/sections.py` already computes the cross-sections it needs.
- **No animation.** A rig that deforms is not a fighter. The sprite poses in
  `tools/photogrammetry` are the intended source: `lift_poses.py` solves joint rotations from the
  2D frames, and those rotations want mapping onto these bone names.
- **Not wired into a game.** Output is a `.glb` on disk. Promoting one is deliberate: copy it into
  the owning game's `public/`, and let the existing sprite bake pick it up.
