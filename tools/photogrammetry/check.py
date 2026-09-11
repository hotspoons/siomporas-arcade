#!/usr/bin/env python3
"""What am I running on, and which image-to-3D model fits in it.

    python3 check.py

Run this on the pod before anything else. The answer is almost always "one of these GPUs is enough,
use one" — see README.md. NOT RUN: written without a GPU to hand.
"""

from __future__ import annotations

import shutil
import subprocess
import sys

# VRAM a single instance wants, in GB, from the model cards. Approximate, and they move — treat as
# a sanity check rather than a guarantee, and expect texture stages to want more than shape stages.
MODELS = [
    ("SF3D / Stable Fast 3D", 8, "fast and rough; good for checking a silhouette early"),
    ("TRELLIS-image-large", 16, "start here — best all-round, mesh or 3DGS out"),
    ("InstantMesh", 20, "wants 6 views in front of it"),
    ("Hunyuan3D 2.x (+texture)", 40, "slower; the texture stage is the draw"),
]


def nvidia_smi() -> list[tuple[str, int]]:
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True, timeout=20,
        ).stdout
    except (subprocess.SubprocessError, OSError) as e:
        print(f"nvidia-smi failed: {e}")
        return []
    gpus = []
    for line in out.strip().splitlines():
        name, _, mem = line.partition(",")
        try:
            gpus.append((name.strip(), int(mem.strip()) // 1024))
        except ValueError:
            continue
    return gpus


def main() -> None:
    try:
        import torch
        print(f"torch {torch.__version__}   cuda available: {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"torch sees {torch.cuda.device_count()} device(s), built against CUDA {torch.version.cuda}")
    except ImportError:
        print("torch: not installed.  pip install -r requirements.txt")

    gpus = nvidia_smi()
    if not gpus:
        print("\nNo GPU visible. lift_poses.py runs fine here; nothing else in the pipeline will.")
        sys.exit(0)

    print()
    for i, (name, gb) in enumerate(gpus):
        print(f"  [{i}] {name}  {gb} GB")

    biggest = max(gb for _, gb in gpus)
    print(f"\nLargest single GPU: {biggest} GB. Every step is single-GPU inference, so this is the")
    print("number that matters — more cards means more assets at once, never a bigger model.\n")
    for name, want, note in MODELS:
        fits = "yes " if biggest >= want else "no  "
        print(f"  {fits} {name:<26} needs ~{want:>2} GB   {note}")

    if len(gpus) > 1:
        print(f"\n{len(gpus)} GPUs: run {len(gpus)} characters in parallel, one process each. Twelve characters")
        print("is under an hour on one card, so this is a convenience, not a requirement.")


if __name__ == "__main__":
    main()
