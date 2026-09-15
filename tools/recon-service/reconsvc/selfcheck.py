#!/usr/bin/env python3
"""Prove the image can import what it just compiled, before it is allowed to be tagged.

nvdiffrast was missing from the Dockerfile for hours: the image built clean, pushed, went Ready,
and would have failed on the first real job with ModuleNotFoundError, because `o_voxel` imports it
at module level and upstream lists it as optional. A build that cannot import its own extensions
has no business being pushed.

Two tiers, and the split is not fussiness:

  imported      torch, cumesh, nvdiffrast, xformers, utils3d, trimesh
  find_spec     o_voxel, flex_gemm

`flex_gemm` calls torch.cuda.get_device_name() AT IMPORT TIME to choose a Triton autotune config,
and `o_voxel` imports flex_gemm — so importing either needs a GPU, which a build container does not
have. `find_spec` locates an installed module without executing it, which still proves the compile
produced something installed and importable-shaped.

Run it again at runtime, where there IS a card, to get the full import.
"""
import importlib
import importlib.util
import sys

NEEDS_NO_GPU = ("torch", "cumesh", "nvdiffrast", "xformers", "utils3d", "trimesh")
NEEDS_GPU = ("o_voxel", "flex_gemm")

# The service's own module. This check did NOT exist when the first image shipped, and the pod
# CrashLoopBackOff'd on startup: uvicorn was asked for `app.main`, and TRELLIS.2 ships its own
# /opt/TRELLIS2/app.py — a Gradio demo — which has to be on PYTHONPATH for `trellis2` to import. A
# plain module beats a namespace package, so `app` resolved to theirs. The package is `reconsvc`
# now, and importing it here means a name collision fails the BUILD instead of the deployment.
SERVICE_MODULE = "reconsvc.main"


def main() -> int:
    failed = []
    for name in NEEDS_NO_GPU:
        try:
            importlib.import_module(name)
        except Exception as exc:
            failed.append(f"{name}: {type(exc).__name__}: {exc}")

    for name in NEEDS_GPU:
        if importlib.util.find_spec(name) is None:
            failed.append(f"{name}: not installed")

    # Import the service itself, and check it is OURS. The pipeline is loaded lazily inside a
    # request, so this costs nothing and needs no GPU.
    try:
        mod = importlib.import_module(SERVICE_MODULE)
        where = getattr(mod, "__file__", "?")
        if "/reconsvc/" not in where:
            failed.append(f"{SERVICE_MODULE}: resolved to {where}, which is not ours")
        elif not hasattr(mod, "app"):
            failed.append(f"{SERVICE_MODULE}: no `app` for uvicorn to serve")
    except Exception as exc:
        failed.append(f"{SERVICE_MODULE}: {type(exc).__name__}: {exc}")

    if failed:
        print("SELFCHECK FAILED", file=sys.stderr)
        for line in failed:
            print("  " + line, file=sys.stderr)
        return 1

    import torch
    print(f"torch {torch.__version__} — {len(NEEDS_NO_GPU)} imported, "
          f"{len(NEEDS_GPU)} present (GPU-only, not imported here), "
          f"{SERVICE_MODULE} serves `app`")
    print("SELFCHECK OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
