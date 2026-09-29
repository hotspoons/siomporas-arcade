# SPDX-License-Identifier: GPL-3.0-or-later
"""
Drive a headless Blender, and get a picture back.

    blender --background --online-mode --command blender_mcp      # once, leaves it listening
    python3 tools/rigging/bridge.py shot out.png                  # look at what it has

This is the transport Rich asked for: "a process where an agent, either through MCP or via the
agent bridge, can drive blender over MCP and complete the rigging exercise … and it will require
screengrabs or renders are sent over the wire."

WHY IT IS A SOCKET AND NOT A SUBPROCESS. `blender --background --python script.py` starts a fresh
Blender, runs the file and exits, so every step pays the load again and NOTHING carries between
steps — an agent cannot look, decide, and then act on what it saw. The blender-mcp addon's bridge
keeps one Blender alive with the scene in it; this speaks its protocol directly, and the MCP server
speaks the same one. Anything here is available to an MCP client unchanged.

HEADLESS NEEDS `--command blender_mcp`. In `--background` mode `bpy.app.timers` never fire, so the
addon's interactive poll loop does nothing at all — it has a separate blocking loop reached only
through that CLI command. Starting Blender in the background with the addon enabled and expecting
the bridge is the obvious mistake, and it fails by silence: the process runs, nothing listens.

THE SANDBOX IS REAL AND USEFUL. The addon refuses destructive operators from code it did not write
and names the alternative — `read_factory_settings` is rejected in favour of `read_homefile`, which
is right, because the first resets the user's preferences. It also insists `result` is a dict.
"""

import base64
import json
import os
import socket
import sys

HOST = os.environ.get("BLENDER_MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("BLENDER_MCP_PORT", "9876"))


def call(code, strict_json=False, host=HOST, port=PORT, timeout=900):
    """Run `code` inside the live Blender. Whatever it assigns to `result` comes back."""
    req = json.dumps({"type": "execute", "code": code, "strict_json": strict_json}) + "\0"
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(req.encode())
        buf = b""
        while not buf.endswith(b"\0"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    out = json.loads(buf.rstrip(b"\0").decode())
    if out.get("status") != "ok":
        raise RuntimeError(out.get("message", "blender refused the code"))
    return out.get("result")


_FRAME = r'''
import bpy, base64, math
from mathutils import Vector
scene = bpy.context.scene
# WORKBENCH. There is no GPU and no display on this box, and EEVEE wants both; Workbench is a
# software rasteriser, which is why blrig's own golden-render tier uses it too.
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x, scene.render.resolution_y = {w}, {h}
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "TEXTURE"

subject = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in {exclude!r}]
if not subject:
    raise RuntimeError("nothing to render")
lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
for o in subject:
    for c in o.bound_box:
        p = o.matrix_world @ Vector(c)
        lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
        hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
mid = (lo + hi) / 2
size = max((hi - lo).x, (hi - lo).y, (hi - lo).z) or 1.0

cam_data = bpy.data.cameras.new("shot")
cam = bpy.data.objects.new("shot", cam_data)
bpy.context.collection.objects.link(cam)
scene.camera = cam
az, el = math.radians({az}), math.radians({el})
cam.location = mid + Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az),
                             math.sin(el))) * size * {dist}
cam.rotation_euler = (mid - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.lens = 55

path = "/tmp/_bridge_shot.png"
scene.render.filepath = path
scene.render.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
with open(path, "rb") as fh:
    blob = fh.read()
bpy.data.objects.remove(cam, do_unlink=True)
result = {{"png_b64": base64.b64encode(blob).decode(), "bytes": len(blob),
           "subject": [o.name for o in subject], "size_m": round(size, 3)}}
'''

# Blender's glTF IMPORTER fabricates this; it is never in the file. Measured: an exported rig has
# one mesh node, and importing it yields two objects. Rendering it would put a sphere in the shot.
IMPORT_ARTEFACTS = ("Icosphere",)


def shot(path, az=45.0, el=20.0, dist=2.2, w=640, h=480, exclude=IMPORT_ARTEFACTS):
    """Render the scene from a spherical angle around its own contents, and write the PNG here."""
    res = call(_FRAME.format(az=az, el=el, dist=dist, w=w, h=h, exclude=tuple(exclude)))
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(res["png_b64"]))
    res.pop("png_b64")
    res["path"] = path
    return res


def load(glb):
    """Open a .glb in the live Blender, replacing whatever was there."""
    return call('''
import bpy
bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
bpy.ops.import_scene.gltf(filepath={path!r})
result = {{"objects": [o.name for o in bpy.data.objects]}}
'''.format(path=glb))


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "ping"
    if what == "ping":
        print(json.dumps(call("import bpy\nresult = {'blender': bpy.app.version_string,"
                              " 'background': bpy.app.background,"
                              " 'objects': [o.name for o in bpy.data.objects]}")))
    elif what == "load":
        print(json.dumps(load(sys.argv[2])))
    elif what == "shot":
        kw = dict(a.split("=", 1) for a in sys.argv[3:] if "=" in a)
        print(json.dumps(shot(sys.argv[2], **{k: float(v) if k in ("az", "el", "dist")
                                              else int(v) for k, v in kw.items()})))
    else:
        print(json.dumps(call(sys.stdin.read())))
