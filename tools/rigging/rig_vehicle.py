# SPDX-License-Identifier: GPL-3.0-or-later
"""
Rig a reconstructed car: free the wheels from the body, and give each one a bone it spins on.

    blender --background --factory-startup --python tools/rigging/rig_vehicle.py -- \
        --in mesh.finished.glb --out rigged.glb [--renders shots/]

WHAT THIS IS FOR. `docs/corridor/PLAN-RIGGING.md`: the engine has never needed bones — it places
four raycast wheels from the wheelbase and the track — so this is a VISUAL feature. An unrigged car
drives exactly as well; its wheel meshes just do not turn. Nothing in here may make an unrigged car
worse, and the script refuses rather than half-rigging.

THE ORDER IS FL, FR, RL, RR and it is the only thing here that cannot be checked downstream.
`apps/corridor/src/vehicles.ts` reads `rig.roles.wheel` in that order; four bones in the wrong
sequence build a car that steers with its back wheels, which reads as "the handling feels weird"
and gets blamed on the profile. Front/rear cannot be known from geometry — a rectangle has no front
— so it is stated in the output for a person to confirm, alongside the guess.
"""

import argparse
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from find_wheels import fit_wheel, say  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="rig_vehicle")
    p.add_argument("--in", dest="src", required=True)
    p.add_argument("--out", dest="dst", default="")
    p.add_argument("--length", type=float, default=4.5, help="metres, nose to tail")
    p.add_argument("--weld", type=float, default=1e-5)
    p.add_argument("--min-share", type=float, default=0.30,
                   help="how much of a corner must lie on the fitted circle to call it a wheel")
    p.add_argument("--bottom", type=float, default=0.45, help="how much of the car's height is 'low'")
    p.add_argument("--outboard", type=float, default=0.80, help="how far out sideways a tyre is")
    p.add_argument("--renders", default="")
    p.add_argument("--dry-run", action="store_true", help="measure and report, write nothing")
    return p.parse_args(argv)


def load(src, length, weld):
    """One mesh, welded, upright, scaled to a real car and sitting on the floor."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh in {}".format(src))
    obj = max(meshes, key=lambda o: len(o.data.vertices))
    for other in meshes:
        if other is not obj:
            bpy.data.objects.remove(other, do_unlink=True)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    raw = len(obj.data.vertices)
    # THE WELD IS NOT OPTIONAL. A vertex per triangle corner means no two faces share a vertex, so
    # every shape test below sees 20,000 disconnected triangles instead of a car.
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=weld)
    bpy.ops.object.mode_set(mode="OBJECT")
    say("welded", {"verts_before": raw, "verts_after": len(obj.data.vertices)})

    # TRELLIS normalises to about a one-metre cube, so the file's units mean nothing. Scale by the
    # longest horizontal extent, which for a car is its length.
    d = obj.dimensions
    horizontal = sorted([(d.x, "x"), (d.y, "y")], reverse=True)
    k = length / horizontal[0][0] if horizontal[0][0] > 1e-6 else 1.0
    obj.scale = (k, k, k)
    bpy.ops.object.transform_apply(scale=True)
    # on the floor, centred in plan
    lo = Vector((min(v.co.x for v in obj.data.vertices),
                 min(v.co.y for v in obj.data.vertices),
                 min(v.co.z for v in obj.data.vertices)))
    hi = Vector((max(v.co.x for v in obj.data.vertices),
                 max(v.co.y for v in obj.data.vertices),
                 max(v.co.z for v in obj.data.vertices)))
    off = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    for v in obj.data.vertices:
        v.co += off
    obj.data.update()
    say("scaled", {"length_m": round(obj.dimensions.y if horizontal[0][1] == "y" else obj.dimensions.x, 3),
                   "axes": {"lon": horizontal[0][1], "lat": horizontal[1][1], "up": "z"},
                   "dimensions": [round(c, 3) for c in obj.dimensions]})
    return obj, horizontal[0][1], horizontal[1][1]


AXIS = {"x": 0, "y": 1, "z": 2}


def corners(obj, lon, lat, bottom=0.45, outboard=0.80):
    """
    The four corner regions, as vertex-index lists.

    Only the bottom `bottom` of the car and only the outboard half of each side: a wheel is low and
    it is at the edge. This is a cheap prefilter, not a decision — the circle fit decides.
    """
    li, ti = AXIS[lon], AXIS[lat]
    co = [v.co for v in obj.data.vertices]
    zs = [c.z for c in co]
    z_cut = min(zs) + bottom * (max(zs) - min(zs))
    ls = [c[li] for c in co]
    l_mid = (min(ls) + max(ls)) / 2
    ts = [c[ti] for c in co]
    t_mid = (min(ts) + max(ts)) / 2
    t_half = (max(ts) - min(ts)) / 2
    out = {}
    for lname, lfwd in (("F", True), ("R", False)):
        for tname, tpos in (("L", True), ("R", False)):
            idx = []
            for i, c in enumerate(co):
                if c.z > z_cut:
                    continue
                if (c[li] > l_mid) != lfwd:
                    continue
                if (c[ti] > t_mid) != tpos:
                    continue
                # THE OUTBOARD BAND ONLY. A corner of a car is mostly sill, door and bumper; the
                # tyre is the part that stands furthest out sideways down there. Fitting the whole
                # corner fitted the wheel ARCH instead — 0.55 m on a car whose wheels are 0.31 m,
                # and only 18% of the points agreeing with it.
                if abs(c[ti] - t_mid) < outboard * t_half:
                    continue
                idx.append(i)
            out[lname + tname] = idx
    return out, li, ti


def find(obj, lon, lat, min_share, bottom=0.45, outboard=0.80):
    """Fit a wheel in each corner. Returns {corner: fit} for the ones that look like wheels."""
    regions, li, ti = corners(obj, lon, lat, bottom=bottom, outboard=outboard)
    co = [v.co for v in obj.data.vertices]
    found = {}
    for name, idx in regions.items():
        if len(idx) < 50:
            say("corner", {"corner": name, "verts": len(idx), "verdict": "too little geometry"})
            continue
        pts = [(co[i][li], co[i].z) for i in idx]
        fit = fit_wheel(pts)
        if fit is None:
            say("corner", {"corner": name, "verts": len(idx), "verdict": "no circle"})
            continue
        # no verdict per corner: the share is reported because it is evidence, but the test
        # that decides is `agree()` over all four, for the reason written there
        say("corner", {"corner": name, "verts": len(idx),
                       "radius_m": round(fit["radius"], 3),
                       "on_the_circle_pct": round(100 * fit["share"], 1)})
        fit["idx"] = idx
        found[name] = fit
    return found, li, ti


def agree(found, li, length):
    """
    Do the four fits describe one car?

    A SHARE THRESHOLD IS THE WRONG TEST and was the first thing tried: the outboard band still holds
    sill and wheel arch, so only a quarter to a third of it lies on the tyre, and any cutoff that
    accepted a real wheel accepted a bumper too. What a real wheel cannot fake is AGREEMENT — four
    independent circle fits landing on the same radius, at four corners that form a rectangle whose
    wheelbase is a sensible fraction of the car. Four wrong fits do not do that by accident.

    Returns (ok, report). The report goes in the log either way, because the numbers are the
    evidence and a refusal without them is not actionable.
    """
    radii = {k: f["radius"] for k, f in found.items()}
    lons = {k: f["centre"][0] for k, f in found.items()}
    zs = {k: f["centre"][1] for k, f in found.items()}
    spread = (max(radii.values()) - min(radii.values())) / max(radii.values())
    front = (lons["FL"] + lons["FR"]) / 2
    rear = (lons["RL"] + lons["RR"]) / 2
    wheelbase = abs(front - rear)
    # the two wheels on an axle share a longitudinal position; a fit that wandered onto a bumper
    # does not
    axle_skew = max(abs(lons["FL"] - lons["FR"]), abs(lons["RL"] - lons["RR"]))
    # and all four sit at the same height, because they are all on the same road
    height_skew = max(zs.values()) - min(zs.values())
    mean_r = sum(radii.values()) / 4
    report = {
        "radius_m": round(mean_r, 3),
        "radius_spread_pct": round(100 * spread, 1),
        "wheelbase_m": round(wheelbase, 3),
        "wheelbase_over_length": round(wheelbase / length, 3),
        "axle_skew_m": round(axle_skew, 3),
        "hub_height_spread_m": round(height_skew, 3),
    }
    fails = []
    if spread > 0.25:
        fails.append("the four radii disagree by {:.0f}%".format(100 * spread))
    if not 0.5 <= wheelbase / length <= 0.75:
        fails.append("wheelbase is {:.0f}% of the length".format(100 * wheelbase / length))
    if axle_skew > 0.25 * mean_r:
        fails.append("the wheels on an axle are {:.2f} m apart lengthways".format(axle_skew))
    if height_skew > 0.5 * mean_r:
        fails.append("the hubs are at {:.2f} m of different heights".format(height_skew))
    report["objections"] = fails
    return (not fails), report


def main():
    args = parse_args()
    obj, lon, lat = load(args.src, args.length, args.weld)
    found, li, ti = find(obj, lon, lat, args.min_share, args.bottom, args.outboard)
    say("found", {"wheels": sorted(found), "count": len(found)})
    if len(found) != 4:
        say("refused", {"why": "found {} wheels, not 4".format(len(found)),
                        "note": "the car stays unrigged, which is a working vehicle"})
        raise SystemExit(0 if args.dry_run else 2)
    ok, report = agree(found, li, args.length)
    say("agreement", report)
    if not ok:
        say("refused", {"why": "the four fits do not describe one car", "objections": report["objections"]})
        raise SystemExit(0 if args.dry_run else 2)
    say("wheels", {"radius_m": report["radius_m"], "wheelbase_m": report["wheelbase_m"]})
    if args.dry_run:
        return

    wheels = separate(obj, found, li, ti)
    if len(wheels) != 4:
        say("refused", {"why": "separated {} wheels, not 4".format(len(wheels))})
        raise SystemExit(2)
    rig, order = build_rig(obj, wheels, li, ti)

    # PROVE IT SPINS BEFORE WRITING IT. A wheel bone that is along the wrong axis sweeps a much
    # bigger box than the wheel; one that accidentally holds part of the body sweeps an enormous
    # one. Turning each wheel a quarter turn and measuring its own bounds is the check that a
    # count of four bones cannot make.
    checks = []
    hub_error = []
    for slot in SLOTS:
        w = wheels[slot]["object"]
        # WHERE IT IS, BEFORE ANYTHING IS TURNED. A wheel parented through the wrong origin sits in
        # the wrong place at REST, and every rotation test in the world still passes on it — span
        # does not notice a translation. This compares the parented wheel against the hub the
        # circle fit found, which is the only fixed point that means anything here.
        cu, cv = wheels[slot]["hub"]
        pts0 = [w.matrix_world @ Vector(c) for c in w.bound_box]
        mid = Vector((sum(p[0] for p in pts0) / 8, sum(p[1] for p in pts0) / 8,
                      sum(p[2] for p in pts0) / 8))
        hub_error.append({"wheel": slot,
                          "off_m": round(math.hypot(mid[li] - cu, mid[2] - cv), 4)})
        # WORLD SPACE. `bound_box` is the object's LOCAL box and a parent bone's rotation does not
        # touch it — the first version of this check read it directly and returned exactly 1.000
        # for all four wheels whatever the bones did, which is a check that cannot fail.
        world = lambda: [w.matrix_world @ Vector(c) for c in w.bound_box]
        span = lambda pts, a: max(p[a] for p in pts) - min(p[a] for p in pts)
        before = world()
        pb = rig.pose.bones["wheel_" + slot.lower()]
        pb.rotation_mode = "XYZ"
        pb.rotation_euler[1] = math.radians(90)
        bpy.context.view_layer.update()
        after = world()
        grew = max((span(after, a) + 1e-9) / (span(before, a) + 1e-9) for a in (0, 1, 2))
        centre = lambda pts: Vector((sum(p[0] for p in pts) / 8, sum(p[1] for p in pts) / 8,
                                     sum(p[2] for p in pts) / 8))
        moved = (centre(after) - centre(before)).length
        pb.rotation_euler[1] = 0
        bpy.context.view_layer.update()
        checks.append({"wheel": slot, "bbox_growth": round(grew, 3),
                       "centre_moved_m": round(moved, 4)})
    say("sits_where_the_hub_is", {"wheels": hub_error})
    say("spin_check", {"quarter_turn": checks,
                       "note": "growth near 1.0 means it turned about its own axle; "
                               "centre_moved near 0 means it turned rather than orbited"})

    mean_r = report["radius_m"]
    worst_rest = max(h["off_m"] for h in hub_error)
    if worst_rest > 0.25 * mean_r:
        say("refused", {"why": "a wheel is parked {:.3f} m from its hub before anything moved"
                               .format(worst_rest)})
        raise SystemExit(2)
    worst = max(c["bbox_growth"] for c in checks)
    if worst > 1.35:
        say("refused", {"why": "a wheel swept {:.2f}x its own box on a quarter turn".format(worst)})
        raise SystemExit(2)
    drift = max(c["centre_moved_m"] for c in checks)
    if drift > 0.15 * mean_r:
        say("refused", {"why": "a wheel's centre travelled {:.3f} m on a quarter turn — it is "
                               "orbiting something, not spinning".format(drift)})
        raise SystemExit(2)

    if args.dst:
        bpy.ops.object.select_all(action="DESELECT")
        for o in [obj, rig] + [wheels[s]["object"] for s in SLOTS]:
            o.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.export_scene.gltf(filepath=args.dst, export_format="GLB", use_selection=True)
        say("exported", {"path": args.dst, "bytes": os.path.getsize(args.dst),
                         "rig": {"roles": {"wheel": order}},
                         "spec": {"wheelRadius": report["radius_m"],
                                  "wheelbase": report["wheelbase_m"]}})



def separate(obj, found, li, ti):
    """
    Cut each wheel out of the body and give it its own object.

    Selection is by the FITTED CIRCLE, not by the prefilter band that produced it: the band was a
    place to look, the circle is the wheel. A vertex belongs to a wheel when it is within the
    fitted radius of the fitted hub in the longitudinal/vertical plane AND on that side of the car.
    """
    out = {}
    for name, fit in found.items():
        cu, cv = fit["centre"]
        r = fit["radius"]
        co = [v.co for v in obj.data.vertices]
        ts = [c[ti] for c in co]
        t_mid = (min(ts) + max(ts)) / 2
        outer = name[1] == "L"
        pick = set()
        for i, c in enumerate(co):
            if (c[ti] > t_mid) != outer:
                continue
            if math.hypot(c[li] - cu, c.z - cv) <= r * 1.04:
                pick.add(i)
        say("picking", {"wheel": name, "verts_in_circle": len(pick),
                        "of_total": len(co), "radius_m": round(r, 3)})
        if len(pick) < 50:
            say("separate", {"wheel": name, "skipped": "too few vertices in the circle"})
            continue
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        # VERTEX MODE, AND DESELECT FIRST. With the mesh select mode left on faces, per-vertex
        # `select` assignments do not drive the selection at all and `separate` took the entire
        # car as the first "wheel" — 65,095 vertices, reported as a success.
        bpy.context.tool_settings.mesh_select_mode = (True, False, False)
        bpy.ops.mesh.select_all(action="DESELECT")
        bm = bmesh.from_edit_mesh(obj.data)
        bm.verts.ensure_lookup_table()
        for v in bm.verts:
            v.select_set(v.index in pick)
        bm.select_flush(True)
        bmesh.update_edit_mesh(obj.data)
        before = set(bpy.data.objects)
        bpy.ops.mesh.separate(type="SELECTED")
        bpy.ops.object.mode_set(mode="OBJECT")
        made = list(set(bpy.data.objects) - before)
        if not made:
            say("separate", {"wheel": name, "skipped": "separate produced nothing"})
            continue
        w = made[0]
        w.name = "wheel_{}".format(name.lower())
        out[name] = {"object": w, "hub": (cu, cv), "radius": r}
        say("separate", {"wheel": name, "object": w.name, "verts": len(w.data.vertices)})
    return out


# FL, FR, RL, RR — the order `apps/corridor/src/vehicles.ts` reads out of `rig.roles.wheel`.
SLOTS = ("FL", "FR", "RL", "RR")


def build_rig(obj, wheels, li, ti):
    """
    A root bone for the body and one bone per wheel, laid along the axle so the wheel spins about
    the bone's own axis. Each wheel object is parented rigidly to its bone — no skinning: a wheel is
    a rigid body and weighting it would only let it deform.
    """
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.object.armature_add(enter_editmode=False, location=(0, 0, 0))
    rig = bpy.context.object
    rig.name = "Rig.Vehicle"
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    for b in list(eb):
        eb.remove(b)
    root = eb.new("body")
    root.head = (0, 0, 0)
    root.tail = (0, 0, 0.4)
    order = []
    for slot in SLOTS:
        w = wheels.get(slot)
        if not w:
            continue
        cu, cv = w["hub"]
        ts = [v.co[ti] for v in w["object"].data.vertices]
        t_c = (min(ts) + max(ts)) / 2
        head = [0.0, 0.0, 0.0]
        head[li] = cu
        head[ti] = t_c
        head[2] = cv
        tail = list(head)
        # ALONG THE AXLE, pointing outboard. The bone's Y axis is head->tail, so a spin is a
        # rotation about the bone's own Y and nothing downstream has to know the car's convention.
        tail[ti] = t_c + (0.12 if t_c > 0 else -0.12)
        b = eb.new("wheel_{}".format(slot.lower()))
        b.head = head
        b.tail = tail
        b.parent = root
        b.use_deform = False
        order.append(b.name)
    bpy.ops.object.mode_set(mode="OBJECT")

    # The body follows the root; each wheel follows its own bone.
    #
    # KEEP THE WORLD TRANSFORM BY RESTORING IT, not by computing a parent inverse. Blender's BONE
    # parenting places the child relative to the bone's TAIL, while `pose_bone.matrix` has its
    # origin at the HEAD — so an inverse built from the pose matrix is off by the whole bone, and
    # every wheel ended up displaced down and outboard of its arch. It looked like the wheels were
    # orbiting when spun; they were not (measured: the centre moves 2 mm), they were simply parked
    # in the wrong place from the moment they were parented, at rest as much as in motion.
    #
    # Assigning `matrix_world` after the parent is set makes Blender solve for the local transform
    # itself, which is correct whatever origin the parent type uses.
    for target, bone in [(obj, "body")] + [(wheels[s]["object"], "wheel_" + s.lower())
                                           for s in SLOTS if s in wheels]:
        keep = target.matrix_world.copy()
        target.parent = rig
        target.parent_type = "BONE"
        target.parent_bone = bone
        bpy.context.view_layer.update()
        target.matrix_world = keep
    say("rig", {"armature": rig.name, "bones": len(rig.data.bones), "wheel_order": order})
    return rig, order


main()
