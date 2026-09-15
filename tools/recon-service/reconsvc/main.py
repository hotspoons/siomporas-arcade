"""Image set in, 3D asset out.

POST a character's views and get back a mesh. The model is loaded once at startup and reused;
reconstruction is serialised behind a lock because one GPU means one job at a time regardless of
how many requests arrive, and queueing politely beats an out-of-memory crash.

Jobs are async: POST /reconstruct returns a job id immediately, GET /jobs/{id} reports progress,
GET /jobs/{id}/asset streams the .glb. A reconstruction takes tens of seconds, which is too long
to hold an HTTP connection open for a batch of characters.
"""
from __future__ import annotations

import asyncio
import io
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image

ASSET_DIR = Path(os.environ.get("ASSET_DIR", "/assets"))
MODEL_DIR = Path(os.environ.get("MODEL_DIR", "/weights/model"))
MAX_VIEWS = int(os.environ.get("MAX_VIEWS", "8"))

app = FastAPI(title="recon", summary="Image set to rigged-ready 3D asset")

_pipeline: Any = None
_gpu = asyncio.Lock()


@dataclass
class Job:
    id: str
    state: Literal["queued", "running", "done", "failed"] = "queued"
    detail: str = ""
    asset: Path | None = None
    stats: dict = field(default_factory=dict)
    created: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}


def _load_pipeline():
    """Import and load lazily. Importing trellis2 pulls in the compiled CUDA extensions, so an
    import error here is a broken image, not a bad request — we want it visible in /healthz."""
    global _pipeline
    if _pipeline is None:
        from reconsvc import compat

        compat.apply()  # must run before the pipeline import pulls in vendored model code

        from trellis2.pipelines import Trellis2ImageTo3DPipeline

        # Ensure the weights are present and the gated encoder is swapped for the mirror. Safe to
        # re-run: snapshot_download is a no-op once cached, so this only costs anything on a cold
        # volume. See fetch_weights for why the encoder is substituted and why we load by path.
        if not (MODEL_DIR / "pipeline.json").exists():
            from reconsvc.fetch_weights import main as fetch_weights

            fetch_weights()

        # A local directory, never the repo id: from_pretrained's remote path swallows the real
        # error and reports a 401 for a repository that never existed.
        pipe = Trellis2ImageTo3DPipeline.from_pretrained(str(MODEL_DIR))
        pipe.cuda()
        _pipeline = pipe
    return _pipeline


@app.on_event("startup")
async def _startup() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    # Load on a worker thread so the port opens immediately and the readiness probe can see us
    # while several GB of weights move onto the card.
    asyncio.get_running_loop().run_in_executor(None, _load_pipeline)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> JSONResponse:
    ready = _pipeline is not None
    return JSONResponse({"ready": ready}, status_code=200 if ready else 503)


def _export(mesh: Any, path: Path) -> dict:
    import numpy as np
    import torch
    import trimesh

    def arr(x):
        return x.detach().cpu().numpy() if torch.is_tensor(x) else np.asarray(x)

    v, f = arr(mesh.vertices), arr(mesh.faces)
    trimesh.Trimesh(vertices=v, faces=f, process=False).export(path)
    return {"vertices": int(len(v)), "faces": int(len(f))}


def _run_job(job: Job, images: list[Image.Image], seed: int) -> None:
    job.state = "running"
    try:
        pipe = _load_pipeline()
        started = time.time()
        out = pipe.run(images[0] if len(images) == 1 else images, seed=seed)
        mesh = out[0] if isinstance(out, (list, tuple)) else out
        path = ASSET_DIR / f"{job.id}.glb"
        job.stats = _export(mesh, path)
        job.stats["seconds"] = round(time.time() - started, 1)
        job.stats["views"] = len(images)
        job.asset = path
        job.state = "done"
    except Exception as exc:  # surfaced through the job record, not swallowed
        job.state, job.detail = "failed", f"{type(exc).__name__}: {exc}"


async def _serialised(job: Job, images: list[Image.Image], seed: int) -> None:
    async with _gpu:
        await asyncio.get_running_loop().run_in_executor(None, _run_job, job, images, seed)


@app.post("/reconstruct", status_code=202)
async def reconstruct(
    background: BackgroundTasks,
    images: list[UploadFile] = File(..., description="one or more views of a single subject"),
    seed: int = Form(1),
) -> dict:
    if not images:
        raise HTTPException(400, "send at least one image")
    if len(images) > MAX_VIEWS:
        raise HTTPException(400, f"at most {MAX_VIEWS} views per subject")

    loaded: list[Image.Image] = []
    for up in images:
        raw = await up.read()
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception:
            raise HTTPException(400, f"{up.filename!r} is not a readable image")
        # Keep alpha: a keyed cut-out is a better subject mask than any background remover, and
        # discarding it here would throw that away and silently re-guess it.
        loaded.append(im.convert("RGBA") if "A" in im.getbands() else im.convert("RGB"))

    job = Job(id=uuid.uuid4().hex[:12])
    JOBS[job.id] = job
    background.add_task(_serialised, job, loaded, seed)
    return {"job": job.id, "views": len(loaded), "poll": f"/jobs/{job.id}"}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    body = {"job": job.id, "state": job.state, **job.stats}
    if job.detail:
        body["detail"] = job.detail
    if job.state == "done":
        body["asset"] = f"/jobs/{job.id}/asset"
    return body


@app.get("/jobs/{job_id}/asset")
def job_asset(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    if job.state != "done" or job.asset is None:
        raise HTTPException(409, f"job is {job.state}")
    return FileResponse(job.asset, media_type="model/gltf-binary", filename=f"{job.id}.glb")
