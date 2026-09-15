#!/usr/bin/env python3
"""Fetch the model weights and assemble a directory the pipeline can load.

TRELLIS.2 names two GATED HuggingFace repos:

    facebook/dinov3-vitl16-pretrain-lvd1689m   the image encoder
    briaai/RMBG-2.0                            the background remover

Neither is reachable without an accepted licence and a token, and neither is touched until the
first request arrives -- so without one the service goes Ready and then 401s on a real job.

There are two ways through, and which one you get depends on whether HF_TOKEN is set:

  FRONT DOOR (HF_TOKEN set)  -- the upstream repos are used directly, as their authors intend.
  BACK DOOR  (no HF_TOKEN)   -- ungated community mirrors are used instead. Their weights are
                                byte-identical to the originals (same size and SHA256 across four
                                independent re-uploads of each), so there is no quality cost. What
                                there is, is a LICENCE cost: the mirrors route around the gate, not
                                the terms. Meta's DINOv3 licence and BRIA's RMBG licence still
                                govern these weights and complying with them remains the operator's
                                responsibility. The service says so, loudly, at startup.

Also handled here: Trellis2ImageTo3DPipeline.from_pretrained resolves its sub-checkpoints through
a bare try/except (trellis2/pipelines/base.py:46) whose fallback re-splits a relative path such as
"ckpts/shape_dec_next_dc_f16c32_fp16" into a repo id, producing a 401 for a repository that never
existed and hiding the original error. Pointing it at a local directory avoids the remote path.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MODEL_REPO = os.environ.get("MODEL_REPO", "microsoft/TRELLIS.2-4B")
MODEL_DIR = Path(os.environ.get("MODEL_DIR", "/weights/model"))

UPSTREAM_ENCODER = "facebook/dinov3-vitl16-pretrain-lvd1689m"
UPSTREAM_REMBG = "briaai/RMBG-2.0"
MIRROR_ENCODER = "camenduru/dinov3-vitl16-pretrain-lvd1689m"
MIRROR_REMBG = "camenduru/RMBG-2.0"

GATE_URLS = {
    UPSTREAM_ENCODER: f"https://huggingface.co/{UPSTREAM_ENCODER}",
    UPSTREAM_REMBG: f"https://huggingface.co/{UPSTREAM_REMBG}",
}


def _token() -> str | None:
    for var in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
        val = os.environ.get(var)
        if val and val.strip():
            return val.strip()
    return None


def _banner(lines: list[str], rule: str = "=") -> None:
    width = max(len(x) for x in lines) + 4
    print(rule * width, file=sys.stderr, flush=True)
    for line in lines:
        print(f"  {line}", file=sys.stderr, flush=True)
    print(rule * width, file=sys.stderr, flush=True)


def resolve_repos() -> tuple[str, str]:
    """Pick upstream or mirrors, and say clearly which and why."""
    # An explicit override always wins: an operator who has named a repo has made the decision.
    enc_override = os.environ.get("ENCODER_REPO")
    rem_override = os.environ.get("REMBG_REPO")

    if _token():
        encoder = enc_override or UPSTREAM_ENCODER
        rembg = rem_override or UPSTREAM_REMBG
        _banner([
            "HF_TOKEN present — using the upstream gated repositories.",
            f"  image encoder      {encoder}",
            f"  background remover {rembg}",
            "If a 401 follows, the token is valid but the licence has not been accepted;",
            "accept it at the URLs below with the same account that issued the token.",
            f"  {GATE_URLS[UPSTREAM_ENCODER]}",
            f"  {GATE_URLS[UPSTREAM_REMBG]}",
        ], "-")
        return encoder, rembg

    encoder = enc_override or MIRROR_ENCODER
    rembg = rem_override or MIRROR_REMBG
    _banner([
        "NO HUGGING FACE TOKEN SET — FALLING BACK TO UNGATED COMMUNITY MIRRORS.",
        "",
        "TRELLIS.2 requires two GATED models. Without a token this service uses mirrors whose",
        "weights are byte-identical to the originals. That bypasses the ACCESS GATE. It does NOT",
        "grant you a licence, and it does not make anyone else responsible for your use of these",
        "weights:",
        "",
        f"  image encoder       {encoder}",
        f"      mirrors         {UPSTREAM_ENCODER}",
        f"      licence + access {GATE_URLS[UPSTREAM_ENCODER]}",
        "",
        f"  background remover  {rembg}",
        f"      mirrors         {UPSTREAM_REMBG}",
        f"      licence + access {GATE_URLS[UPSTREAM_REMBG]}",
        "",
        "IT IS YOUR RESPONSIBILITY TO COMPLY WITH META'S AND BRIA'S LICENCE TERMS.",
        "",
        "To go through the front door instead: request access at the two URLs above, mint a read",
        "token at https://huggingface.co/settings/tokens, and give it to the chart:",
        "",
        "  kubectl create secret generic hf-token --from-literal=token=hf_xxx",
        "  helm upgrade --install recon ./chart --set hfToken.secretName=hf-token",
        "",
        "The service then uses the upstream repositories and this warning goes away.",
    ], "!")
    return encoder, rembg


def main() -> None:
    from huggingface_hub import snapshot_download

    encoder_repo, rembg_repo = resolve_repos()
    token = _token()

    snap = Path(snapshot_download(MODEL_REPO, token=token))
    print(f"pipeline weights: {snap}", flush=True)

    # Pull both now rather than on the first request: a failure here is a startup failure with a
    # readable message, instead of a 500 on somebody's job several minutes later.
    print(f"image encoder:    {snapshot_download(encoder_repo, token=token)}", flush=True)
    print(f"background rmvr:  {snapshot_download(rembg_repo, token=token)}", flush=True)

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    ckpts = MODEL_DIR / "ckpts"
    if ckpts.is_symlink() or ckpts.exists():
        ckpts.unlink()
    ckpts.symlink_to(snap / "ckpts")  # symlink, so the 16GB is not duplicated

    cfg = json.loads((snap / "pipeline.json").read_text())
    for key, repo in (("image_cond_model", encoder_repo), ("rembg_model", rembg_repo)):
        args = cfg["args"].get(key, {}).get("args", {})
        if args.get("model_name") != repo:
            print(f"{key}: {args.get('model_name')} -> {repo}", flush=True)
            args["model_name"] = repo
    (MODEL_DIR / "pipeline.json").write_text(json.dumps(cfg, indent=2))
    print(f"MODEL_DIR ready:  {MODEL_DIR}", flush=True)


if __name__ == "__main__":
    main()
