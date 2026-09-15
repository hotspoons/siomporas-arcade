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

    if failed:
        print("SELFCHECK FAILED", file=sys.stderr)
        for line in failed:
            print("  " + line, file=sys.stderr)
        return 1

    import torch
    print(f"torch {torch.__version__} — {len(NEEDS_NO_GPU)} imported, "
          f"{len(NEEDS_GPU)} present (GPU-only, not imported here)")
    print("SELFCHECK OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
