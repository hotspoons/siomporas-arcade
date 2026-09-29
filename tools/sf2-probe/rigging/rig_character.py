#!/usr/bin/env -S blender --background --factory-startup --python
"""Rig a reconstructed character mesh, headlessly, and keep its textures.

    blender --background --factory-startup --python rig_character.py -- \
        --in mesh.glb --out rigged.glb [--height 1.7] [--voxel 0.012] [--renders DIR]

Input is the kind of mesh TRELLIS.2 produces: textured, UV-mapped, and topologically awful. Output
is that same textured mesh bound to a Rigify control rig.

WHY THE MESH IS REMESHED AND THEN THROWN AWAY
---------------------------------------------
Bone-heat weighting diffuses heat across a closed surface. A reconstruction is not closed — the
Kestrel mesh had 31,755 boundary edges — so the heat escapes through the holes and bones acquire
vertices nowhere near them. The arm bone ends up owning the torso, and posing the arm drags the
body with it. Measured, on this exact mesh, with blrig's own verify:

    upper_arm_fk.L volume ratio   31.451  ->  0.961
    upper_arm_fk.R volume ratio   31.439  ->  0.963
    thigh_fk.L     volume ratio    6.188  ->  0.911

The only difference between those columns is a voxel remesh. It guarantees a watertight manifold
(boundary_edges 0, non_manifold_edges 0) and bone heat immediately behaves.

But a voxel remesh destroys the UVs, so it cannot be the asset. The shape used here is therefore:
remesh a throwaway CAGE, let Rigify and bone-heat weight the cage, transfer those weights onto the
original textured mesh, and bind that to the rig. The cage is deleted. The asset keeps its
texture and gains working deformation.

TWO THINGS THAT WILL WASTE AN HOUR IF YOU DO NOT KNOW THEM
----------------------------------------------------------
* blrig gates character rigging at 10% asymmetry. A reconstruction from a single view is not
  symmetric — this one measured 16.5% — so it must be symmetrised first, which also means
  centring it on its own symmetry plane rather than on its bounding box.
* Rigify limbs are IK-driven by default. Rotating `upper_arm_fk.L` renders *identically to rest*
  until `IK_FK` on the limb's `*_parent` bone is set to 1.0.

Requires Blender >= 5.1 (the blender-agent addon's declared minimum) and blrig on the path via
--blrig or BLRIG_DIR.
"""
import argparse
import json
import math
import os
import re
import sys

import bpy


def say(tag, payload):
    print("@@ {} {}".format(tag, json.dumps(payload, default=str)), flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="rig_character")
    p.add_argument("--in", dest="src", required=True)
    p.add_argument("--out", dest="dst", default="")
    p.add_argument("--blrig", default=os.environ.get("BLRIG_DIR", ""))
    p.add_argument("--height", type=float, default=1.7, help="metres, head to floor")
    p.add_argument("--voxel", type=float, default=0.012, help="remesh cell size in metres")
    p.add_argument("--cage-faces", type=int, default=60000)
    p.add_argument("--renders", default="", help="directory for pose renders; skipped if unset")
    p.add_argument("--keep-cage", action="store_true")
    p.add_argument("--no-face", action="store_true",
                   help="skip the face-weight pass (the cage leaves lips and eyes at zero)")
    p.add_argument("--face-reach", type=float, default=1.6,
                   help="how far a face bone reaches, in multiples of its own length")
    p.add_argument("--metarig", default="human", choices=("human", "basic_human"))
    p.add_argument("--export-joints", default="",
                   help="fit the metarig, write its body joints to this file, and stop. "
                        "Pair with --out to get the mesh the joints belong to.")
    p.add_argument("--joints", default="",
                   help="a corrected joints file to place the metarig from before generating")
    return p.parse_args(argv)


# Which metarig bones a human would place by hand. The full Rigify human metarig is 159 bones and
# most of them are face and fingers — nobody is dragging an ear into position, and Rigify derives
# the deform chain from these anyway.
BODY_JOINT = re.compile(
    r"^(spine(\.\d+)?"
    r"|pelvis\.[LR]|thigh\.[LR]|shin\.[LR]|foot\.[LR]|toe\.[LR]|heel\.02\.[LR]"
    r"|shoulder\.[LR]|upper_arm\.[LR]|forearm\.[LR]|hand\.[LR])$")

# Blender is Z-up; glTF is Y-up, and `export_scene.gltf` converts on the way out. Joints are written
# in the SAME space as the exported mesh so the browser can overlay them without transforming
# anything — the conversion lives here, at the one boundary that knows about both.
def to_gltf(v):
    return [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


def from_gltf(v):
    return (v[0], -v[2], v[1])


def import_and_normalise(src, height):
    """One mesh object, upright, origin-centred, scaled to a real height, transforms applied."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh in {}".format(src))
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "Character"

    # The glTF importer rotates Z-up source data to Y-up on the way in. Rigify wants +Z up, and
    # the metarig fit reads the bounding box, so this has to be undone before anything measures it.
    obj.rotation_euler = (0.0, 0.0, 0.0)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    tallest = max(obj.dimensions)
    if tallest <= 0:
        raise SystemExit("degenerate mesh: zero extent")
    obj.scale = tuple(height / tallest for _ in range(3))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Stand it on the floor. TRELLIS centres its output on the origin, which makes every exported
    # coordinate relative to nothing in particular; with the feet on z=0 a joint's height IS its
    # height, and the joints file can say so truthfully.
    bpy.context.view_layer.update()
    lowest = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    obj.location.z -= lowest
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return obj


def clean(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0005)
    bpy.ops.mesh.dissolve_degenerate()
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def centre_on_symmetry_plane(obj, perception):
    """Centre on the found plane, not the bounding box: a lopsided mesh has a lopsided bbox."""
    import numpy as np
    sym = perception.symmetry_plane(obj)
    normal = sym.get("normal")
    if normal is not None and abs(normal[0]) > 0.9:
        point = np.asarray(sym["point"])
        normal = np.asarray(normal)
        obj.location.x -= float(point @ normal / normal[0])
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return sym.get("asymmetry_pct")


def build_cage(obj, voxel, target_faces):
    """A watertight copy of *obj*, for weighting only. Returns the new object."""
    cage = obj.copy()
    cage.data = obj.data.copy()
    cage.name = "_cage"
    bpy.context.collection.objects.link(cage)
    bpy.context.view_layer.objects.active = cage
    bpy.ops.object.select_all(action="DESELECT")
    cage.select_set(True)

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.symmetrize(direction="POSITIVE_X")
    bpy.ops.object.mode_set(mode="OBJECT")

    mod = cage.modifiers.new("Remesh", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = voxel
    mod.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=mod.name)

    faces = len(cage.data.polygons)
    if faces > target_faces:
        dec = cage.modifiers.new("Decimate", "DECIMATE")
        dec.ratio = target_faces / float(faces)
        bpy.ops.object.modifier_apply(modifier=dec.name)
    return cage


# The face bones a reconstruction can actually drive, and the ones it cannot.
#
# MEASURED on Kestrel before this existed: lip bones with any weight, 0. Eye bones, 0. Brow bones,
# 2 — carrying 45.9 against the jaw's 1,918. The face rig was 173 bones that deformed nothing.
#
# WHY. Bone-heat runs over the voxel-remeshed CAGE, and a cage has no lip seam and no eye socket:
# the mouth is one closed surface and the lids are fused to the face. Heat cannot tell `lip.T` from
# `lip.B` when there is nothing between them, so those bones own nothing. The jaw works because it
# is a large volume; the brows barely work because they are a ridge.
#
# The fix is not a finer cage — the cage must stay watertight, and a closed mouth stays closed at
# any resolution. The face bones do not need heat: they need a local falloff, which can be computed
# on the REAL mesh where the lip line and the lids exist.
FACE_BONES = re.compile(r"^DEF-(lip\.|lips\.|lid\.|brow\.|cheek\.|nose|chin)")

# and the honest limit, worth stating where somebody will read it: the eyes of a single-view
# reconstruction are sculpted SHUT, with the lashes painted on and no eyeball behind them. Lid
# bones can squint and blink-ish; nothing here can make an eye look left, because there is no eye.


def face_weights(obj, armature, reach=1.6, floor=0.02):
    """
    Give the face bones weights, computed on the real mesh rather than inherited from the cage.

    For each face deform bone, every vertex within `reach` bone-lengths of the bone's segment gets
    a weight that falls off with distance. The weight is taken FROM whatever already owns that
    vertex — the head and the jaw — rather than added on top, so the total per vertex stays 1 and
    nothing inflates when posed.

    Returns what it did, per bone, because "the face has weights now" is not a claim anybody should
    accept without the numbers behind it.
    """
    bones = [b for b in armature.data.bones if b.use_deform and FACE_BONES.match(b.name)]
    if not bones:
        return {"bones": 0}
    groups = {b.name: (obj.vertex_groups.get(b.name) or obj.vertex_groups.new(name=b.name))
              for b in bones}
    inv = obj.matrix_world.inverted()
    segs = []
    for b in bones:
        head = inv @ (armature.matrix_world @ b.head_local)
        tail = inv @ (armature.matrix_world @ b.tail_local)
        length = (tail - head).length or 1e-4
        segs.append((b.name, head, tail, length))

    # only the head end of the character is a candidate; a lip bone must not reach an ankle
    zs = [v.co.z for v in obj.data.vertices]
    top = max(zs)
    span = top - min(zs)
    near_head = [v for v in obj.data.vertices if v.co.z > top - 0.22 * span]

    added = {name: 0 for name, _, _, _ in segs}
    for v in near_head:
        contrib = []
        for name, head, tail, length in segs:
            d = _point_to_segment(v.co, head, tail)
            r = reach * length
            if d >= r:
                continue
            w = (1.0 - d / r) ** 2
            if w > floor:
                contrib.append((name, w))
        if not contrib:
            continue
        total = sum(w for _, w in contrib)
        # HOW MUCH OF THIS VERTEX THE FACE MAY CLAIM. Capped, so the head bone keeps enough of the
        # skull to carry it: a vertex entirely owned by lip bones detaches from the head when the
        # head turns.
        claim = min(0.85, total)
        scale = claim / total
        for name, w in contrib:
            groups[name].add([v.index], w * scale, "REPLACE")
            added[name] += 1
        for vg in obj.vertex_groups:
            if vg.name in groups:
                continue
            try:
                had = vg.weight(v.index)
            except RuntimeError:
                continue
            vg.add([v.index], had * (1.0 - claim), "REPLACE")
    # SMOOTH THEM, or the falloffs meet in a seam.
    #
    # Each bone's weight is a radial falloff that stops dead at its reach, so where two of them
    # meet the sum steps rather than blends, and the mesh creases along that step when posed — the
    # first render of a moving mouth showed flat facets around the lips and nose rather than skin.
    # Smoothing is over the face groups only; the body's weights came from bone-heat and are
    # already continuous.
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    for name in groups:
        obj.vertex_groups.active_index = obj.vertex_groups[name].index
        try:
            bpy.ops.object.vertex_group_smooth(group_select_mode="ACTIVE", factor=0.5, repeat=3)
        except RuntimeError:
            pass
    bpy.ops.object.mode_set(mode="OBJECT")

    return {"bones": len(bones), "vertices_touched": sum(1 for _ in near_head),
            "smoothed": len(groups),
            "per_bone": {k: n for k, n in sorted(added.items(), key=lambda kv: -kv[1])[:8]}}


def _point_to_segment(p, a, b):
    ab = b - a
    denom = ab.dot(ab)
    if denom < 1e-12:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / denom))
    return (p - (a + ab * t)).length


def transfer_weights(cage, obj, armature):
    """Copy the cage's bone weights onto the real mesh and bind it to the same armature.

    Uses the Data Transfer MODIFIER, not `bpy.ops.object.data_transfer`. The operator's
    `layers_select_src` only accepts ACTIVE/NAME/INDEX — there is no "all the vertex groups"
    option on it — whereas the modifier exposes `layers_vgroup_select_src='ALL'`, which is what
    transferring 160 deform groups in one pass needs. `datalayout_transfer` creates the matching
    groups on the destination first; without it there is nothing for NAME matching to land on.
    """
    for vg in list(obj.vertex_groups):
        obj.vertex_groups.remove(vg)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    mod = obj.modifiers.new("WeightTransfer", "DATA_TRANSFER")
    mod.object = cage
    mod.use_vert_data = True
    mod.data_types_verts = {"VGROUP_WEIGHTS"}
    # Interpolate across the nearest face rather than snapping to the nearest vertex: the cage is
    # coarser than the mesh, and nearest-vertex leaves visible banding along the limbs.
    mod.vert_mapping = "POLYINTERP_NEAREST"
    mod.layers_vgroup_select_src = "ALL"
    mod.layers_vgroup_select_dst = "NAME"

    bpy.ops.object.datalayout_transfer(modifier=mod.name)
    bpy.ops.object.modifier_apply(modifier=mod.name)

    if obj.parent is not armature:
        obj.parent = armature
        obj.matrix_parent_inverse = armature.matrix_world.inverted()
    if not any(m.type == "ARMATURE" for m in obj.modifiers):
        arm_mod = obj.modifiers.new("Armature", "ARMATURE")
        arm_mod.object = armature
    return len(obj.vertex_groups)


def fit_metarig_for(mesh_obj, kind, blrig):
    """Add a metarig and run blrig's proportional fit against *mesh_obj*. Returns (meta, plan)."""
    perception, rigify, character = blrig
    import numpy as np
    verts, _tris = perception._mesh.mesh_arrays(mesh_obj)
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    sym = perception.symmetry_plane(mesh_obj)
    centre_x = float((lo[0] + hi[0]) * 0.5)
    normal = sym.get("normal")
    if normal is not None and abs(normal[0]) > 0.9:
        point = np.asarray(sym["point"])
        normal = np.asarray(normal)
        centre_x = float(point @ normal / normal[0])
    meta = rigify.add_metarig(kind, name="META-Rig")
    fit = rigify.fit_metarig(meta, lo.tolist(), hi.tolist(), center_x=centre_x)
    return meta, fit


def write_joints(meta, mesh_obj, path, mesh_path, kind):
    """The body joints of the fitted metarig, in the exported mesh's own space."""
    joints = {}
    for bone in meta.data.bones:
        if not BODY_JOINT.match(bone.name):
            continue
        joints[bone.name] = {
            "head": to_gltf(bone.head_local),
            "tail": to_gltf(bone.tail_local),
            "parent": bone.parent.name if bone.parent else None,
            "connected": bool(bone.use_connect),
        }
    height = float(mesh_obj.dimensions.z)
    doc = {
        "format": "apex-metarig-joints/1",
        "source": {"mesh": os.path.basename(mesh_path) if mesh_path else None,
                   "metarig": kind, "written": "by tools/rigging/rig_character.py"},
        "axis": "y-up, matching the exported glb; +y is up and the figure stands on y=0",
        "units": "metres",
        "height": round(height, 4),
        "note": ("Positions from Rigify's PROPORTIONAL fit — a human template scaled to the mesh "
                 "height, which never looks at the mesh. Drag these onto the real anatomy and feed "
                 "the file back with --joints."),
        "joints": joints,
    }
    with open(path, "w") as fh:
        json.dump(doc, fh, indent=2)
    return doc


def apply_joints(meta, path, blrig):
    """Place the metarig's bones from a corrected joints file, before Rigify generates anything.

    This is the whole point of the exercise. `fit_metarig` scales a standard skeleton to the
    character's height and never looks at the mesh, so on anything not shaped like the template the
    joints land wrong — on Kestrel the hands came out at ankle height. Everything downstream
    (Rigify's generation, bone-heat weighting) runs *after* this, so correcting here is the only
    place a fix actually takes.
    """
    _perception, _rigify, _character = blrig
    with open(path) as fh:
        doc = json.load(fh)
    if doc.get("format") != "apex-metarig-joints/1":
        raise SystemExit("unexpected joints format: {!r}".format(doc.get("format")))
    wanted = doc.get("joints", {})

    import bpy as _bpy
    applied, missing, off = 0, [], []
    prev_mode = _bpy.context.object.mode if _bpy.context.object else "OBJECT"
    _bpy.context.view_layer.objects.active = meta
    _bpy.ops.object.mode_set(mode="EDIT")
    try:
        ebones = meta.data.edit_bones
        # Parents first: a connected child's head follows its parent's tail, so setting the parent
        # afterwards would silently undo the child.
        def depth(name):
            n, d = ebones.get(name), 0
            while n is not None and n.parent is not None:
                n, d = n.parent, d + 1
            return d
        for name in sorted(wanted, key=depth):
            eb = ebones.get(name)
            if eb is None:
                missing.append(name)
                continue
            rec = wanted[name]
            eb.head = from_gltf(rec["head"])
            eb.tail = from_gltf(rec["tail"])
            applied += 1
        # Read back: a connected bone can refuse a head that disagrees with its parent's tail, and
        # silently keeping the old position is exactly the failure that would waste an afternoon.
        for name in wanted:
            eb = ebones.get(name)
            if eb is None:
                continue
            want = from_gltf(wanted[name]["head"])
            d = max(abs(eb.head[i] - want[i]) for i in range(3))
            if d > 0.001:
                off.append({"bone": name, "mm": round(d * 1000, 1)})
    finally:
        _bpy.ops.object.mode_set(mode="OBJECT")
        if prev_mode != "OBJECT":
            pass
    return {"applied": applied, "missing": missing, "did_not_take": off}


def render_poses(obj, rig, out_dir):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = scene.render.resolution_y = 480
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.lens = 50

    for pb in rig.pose.bones:
        if "IK_FK" in pb.keys():
            pb["IK_FK"] = 1.0   # or every render comes back identical to rest

    def frame():
        deps = bpy.context.evaluated_depsgraph_get()
        coords = [obj.matrix_world @ v.co for v in obj.evaluated_get(deps).data.vertices]
        xs = [c.x for c in coords]; ys = [c.y for c in coords]; zs = [c.z for c in coords]
        span = max(max(xs) - min(xs), max(zs) - min(zs), 0.1)
        cam.location = ((min(xs) + max(xs)) / 2, min(ys) - (span * 1.9 + 1.0), (min(zs) + max(zs)) / 2)
        cam.rotation_euler = (math.radians(90), 0, 0)

    def pose(pairs):
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="POSE")
        for pb in rig.pose.bones:
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (0, 0, 0)
        for name, axis, deg in pairs:
            pb = rig.pose.bones.get(name)
            if pb is not None:
                setattr(pb.rotation_euler, axis, math.radians(deg))
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.context.view_layer.update()

    shots = (
        ("rest", []),
        ("arms-up", [("upper_arm_fk.L", "x", 75), ("upper_arm_fk.R", "x", 75)]),
        ("leg-fwd", [("thigh_fk.L", "x", -65)]),
        ("elbows", [("forearm_fk.L", "x", 90), ("forearm_fk.R", "x", 90)]),
    )
    for tag, pairs in shots:
        pose(pairs)
        frame()
        scene.render.filepath = os.path.join(out_dir, "pose-{}.png".format(tag))
        bpy.ops.render.render(write_still=True)
        say("render", {"tag": tag, "path": scene.render.filepath})
    pose([])


def main():
    args = parse_args()
    if args.blrig:
        sys.path.insert(0, args.blrig)
    try:
        from blrig import perception
        from blrig.skills import _rigify, rig_biped_rigify
        from blrig.standard import validate_weights
    except ImportError as exc:
        raise SystemExit(
            "blrig not importable ({}). Pass --blrig <path to blmcp_ext/rigging> "
            "or set BLRIG_DIR.".format(exc))
    blrig = (perception, _rigify, None)

    obj = import_and_normalise(args.src, args.height)
    say("imported", {"verts": len(obj.data.vertices), "faces": len(obj.data.polygons),
                     "dims": list(obj.dimensions)})

    clean(obj)
    asym = centre_on_symmetry_plane(obj, perception)
    health = perception.mesh_health(obj)
    say("source", {"asymmetry_pct": asym, "boundary_edges": health["boundary_edges"],
                   "is_closed": health["is_closed"], "issues": health["issues"]})

    cage = build_cage(obj, args.voxel, args.cage_faces)
    cage_health = perception.mesh_health(cage)
    say("cage", {"verts": cage_health["n_verts"], "faces": cage_health["n_faces"],
                 "is_closed": cage_health["is_closed"],
                 "boundary_edges": cage_health["boundary_edges"],
                 "asymmetry_pct": perception.symmetry_plane(cage).get("asymmetry_pct")})
    if not cage_health["is_closed"]:
        say("warning", {"detail": "cage is not watertight; bone heat will leak. "
                                  "Try a larger --voxel."})

    meta, fit = fit_metarig_for(cage, args.metarig, blrig)
    say("metarig", {"kind": args.metarig, "fit_scale": fit["scale"],
                    "bones": len(meta.data.bones)})

    # --- stage one: hand the joints out for correction and stop ---------------------------------
    if args.export_joints:
        if args.dst:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.export_scene.gltf(filepath=args.dst, export_format="GLB", use_selection=True)
            say("exported", {"path": args.dst, "bytes": os.path.getsize(args.dst)})
        doc = write_joints(meta, obj, args.export_joints, args.dst, args.metarig)
        say("joints_written", {"path": args.export_joints, "joints": len(doc["joints"]),
                               "height": doc["height"], "names": sorted(doc["joints"])[:8]})
        return

    # --- stage two: place the metarig from a corrected file, then generate -----------------------
    if args.joints:
        report = apply_joints(meta, args.joints, blrig)
        say("joints_applied", report)
        if report["did_not_take"]:
            say("warning", {"detail": "some bones did not move to the requested head; a connected "
                                      "bone's head follows its parent's tail",
                            "bones": report["did_not_take"][:6]})

    rig = _rigify.generate(meta, "Rig.Biped")
    _rigify.bind_auto_weights(cage, rig)
    weights = validate_weights(cage, rig)
    unweighted = next((e for e in weights["errors"] if e["rule"] == "E_UNWEIGHTED"), None)
    if unweighted is not None:
        raise SystemExit("bone heat failed: {}".format(unweighted["detail"]))
    say("rig", {"armature": rig.name, "bones": len(rig.data.bones),
                "deform": sum(1 for b in rig.data.bones if b.use_deform)})

    ctx = {"objects": [cage.name], "armature": rig.name}
    verify = rig_biped_rigify.verify(ctx)
    say("verify", {"ok": verify.get("ok")})
    for check in verify.get("checks", []):
        if not check.get("ok") or "volume" in check["name"]:
            say("check", {"name": check["name"], "ok": check["ok"], "detail": check.get("detail")})

    groups = transfer_weights(cage, obj, rig)
    say("weights", {"vertex_groups_on_mesh": groups})
    if not args.no_face:
        say("face_weights", face_weights(obj, rig, reach=args.face_reach))

    if not args.keep_cage:
        bpy.data.objects.remove(cage, do_unlink=True)
    if args.renders:
        os.makedirs(args.renders, exist_ok=True)
        render_poses(obj, rig, args.renders)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    """
    EXPORT THE DEFORM BONES ONLY.

    Rigify emits 706 bones and 160 of them deform; the rest are controls, mechanisms and widget
    holders. `export_scene.gltf` defaults to `export_def_bones=False`, which puts EVERY bone in the
    skin — so the .glb carried 706 joints, of which measurement found 73 with any weight at all and
    633 dead. Every consumer then allocates joint matrices for all 706 and skins against them, and
    nothing anywhere says the other 633 do nothing.

    The script already reported the right number ("vertex_groups_on_mesh: 160") which is what made
    this hard to see: Blender held 160 groups and the exporter wrote 706 joints, and the log only
    showed the first.
    """
    bpy.ops.export_scene.gltf(filepath=args.dst, export_format="GLB", use_selection=True,
                              export_def_bones=True)
    say("exported", {"path": args.dst, "bytes": os.path.getsize(args.dst),
                     "skin_joints": sum(1 for b in rig.data.bones if b.use_deform)})


main()
