#!/usr/bin/env python3
"""Bring a reconstruction down to a size a game can ship.

    blender -b -P tools/assetgen/decimate.py -- in.glb out.glb [--faces N] [--texture N] [--keep-orm]

WHY. TRELLIS.2 hands back what it sees: the diner came out at 381,828 triangles with two 2048px PBR
maps, 25 MB in one .glb. That is the right thing for the service to return — decimating with the
UVs intact is something only the exporter can do, and it already drops from nearly six million — but
it is two orders of magnitude more than this game can use. Every roadside kind is baked to a sprite
in a cell of at most 256 pixels, from ONE yaw, once. Twenty thousand triangles is already more than
that bake can resolve; four hundred thousand is bytes over the wire and nothing on the screen.

The viewer is the other consumer and it is the demanding one, since it shows these at about 500px
and lets you turn them. That is what the texture budget is set by, not the sprite.

WHY BLENDER AND NOT A MESH LIBRARY. Decimation has to carry the UVs, and the collapse has to respect
the seams or the texture tears along them. Blender's decimate modifier does both, it is already
installed for `tools/rigging`, and it costs one subprocess.

JPEG, NOT PNG, for the baked maps. A photographed reconstruction has no flat colour and no alpha to
protect — the silhouette is geometry here, not a cut-out — so PNG is spending bytes to preserve
noise. The base colour of the diner is 7.2 MB as PNG and under half a megabyte as JPEG at the same
size.
"""

import sys
import bpy


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print(__doc__)
        raise SystemExit(2)

    src, out = argv[0], argv[1]
    faces = int(_flag(argv, "--faces", 20000))
    texture = int(_flag(argv, "--texture", 1024))
    quality = int(_flag(argv, "--quality", 88))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    before = sum(len(o.data.polygons) for o in meshes)

    # One budget across the whole file, shared out by size: a reconstruction is usually one mesh,
    # but if it ever arrives as several, decimating each to the same RATIO would spend the budget
    # on whichever happened to be densest.
    if before > faces:
        for o in meshes:
            share = len(o.data.polygons) / before
            target = max(4, int(faces * share))
            mod = o.modifiers.new("decimate", "DECIMATE")
            mod.ratio = min(1.0, target / max(1, len(o.data.polygons)))
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=mod.name)

    if "--keep-orm" not in argv:
        # Drop everything but base colour. TRELLIS bakes metallic, roughness and a normal map, and
        # the game throws all three away: `SpriteAtlas` flattens shading and clamps metalness on
        # every material it bakes, and the result is a sprite in a cell of at most 256 pixels. The
        # viewer lights them, but a photographed surface already carries its light. Two maps to one
        # is most of the file.
        for mat in bpy.data.materials:
            if not mat.use_nodes:
                continue
            for node in list(mat.node_tree.nodes):
                if node.type != "BSDF_PRINCIPLED":
                    continue
                for slot, value in (("Metallic", 0.0), ("Roughness", 0.9)):
                    inp = node.inputs.get(slot)
                    if inp is None:
                        continue
                    for link in list(inp.links):
                        mat.node_tree.links.remove(link)
                    inp.default_value = value
                normal = node.inputs.get("Normal")
                if normal is not None:
                    for link in list(normal.links):
                        mat.node_tree.links.remove(link)
        for img in list(bpy.data.images):
            if img.users == 0:
                bpy.data.images.remove(img)

    for img in bpy.data.images:
        w, h = img.size
        if max(w, h) > texture:
            scale = texture / max(w, h)
            img.scale(max(1, int(w * scale)), max(1, int(h * scale)))

    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_image_format="JPEG",
        export_jpeg_quality=quality,
        export_yup=True,
    )

    after = sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == "MESH")
    print(f"decimate: {before} -> {after} faces, textures <= {texture}px")


def _flag(argv: list[str], name: str, default):
    return argv[argv.index(name) + 1] if name in argv else default


main()
