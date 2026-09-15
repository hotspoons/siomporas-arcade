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
import sys

import bpy


def say(tag, payload):
    print("@@ {} {}".format(tag, json.dumps(payload, default=str)), flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="rig_character")
    p.add_argument("--in", dest="src", required=True)
    p.add_argument("--out", dest="dst", required=True)
    p.add_argument("--blrig", default=os.environ.get("BLRIG_DIR", ""))
    p.add_argument("--height", type=float, default=1.7, help="metres, head to floor")
    p.add_argument("--voxel", type=float, default=0.012, help="remesh cell size in metres")
    p.add_argument("--cage-faces", type=int, default=60000)
    p.add_argument("--renders", default="", help="directory for pose renders; skipped if unset")
    p.add_argument("--keep-cage", action="store_true")
    return p.parse_args(argv)


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
        from blrig.skills import rig_biped_rigify
    except ImportError as exc:
        raise SystemExit(
            "blrig not importable ({}). Pass --blrig <path to blmcp_ext/rigging> "
            "or set BLRIG_DIR.".format(exc))

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

    ctx = {"objects": [cage.name]}
    result = rig_biped_rigify.run(ctx)
    say("rig", {"ok": result.get("ok"), "fail": result.get("fail"),
                "character": result.get("character")})
    if not result.get("ok"):
        raise SystemExit("rigging failed: {}".format(result.get("fail")))

    verify = rig_biped_rigify.verify(ctx)
    say("verify", {"ok": verify.get("ok")})
    for check in verify.get("checks", []):
        if not check.get("ok") or "volume" in check["name"]:
            say("check", {"name": check["name"], "ok": check["ok"], "detail": check.get("detail")})

    rig = bpy.data.objects[result["armature"]]
    groups = transfer_weights(cage, obj, rig)
    say("weights", {"vertex_groups_on_mesh": groups})

    if not args.keep_cage:
        bpy.data.objects.remove(cage, do_unlink=True)

    if args.renders:
        os.makedirs(args.renders, exist_ok=True)
        render_poses(obj, rig, args.renders)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=args.dst, export_format="GLB", use_selection=True)
    say("exported", {"path": args.dst, "bytes": os.path.getsize(args.dst)})


main()
