"""Push baked sites to an S3-compatible bucket, so a Cloudflare Worker can serve them.

Why: the arcade Worker ships its assets inside the Worker and is heading for the 64 MB ceiling.
A corridor is hundreds of MB. Baked once on the cluster (where the storage is), published here,
and the Worker fetches from R2 by key instead of carrying anything.

Configuration is environment only, so the same image runs in the Helm Job and on a laptop:

    CORRIDOR_S3_BUCKET     required
    CORRIDOR_S3_ENDPOINT   R2: https://<account-id>.r2.cloudflarestorage.com  (unset for AWS)
    CORRIDOR_S3_REGION     "auto" for R2 (default)
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   the bucket's token
    CORRIDOR_S3_PREFIX     key prefix, default "corridor"

Idempotent: an object whose size matches is skipped. `index.json` at the prefix root lists every
published site with its manifest, so a client needs one fetch to know what exists. The LAZ is
published too; a Worker should never need it, but a desktop build might.
"""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path

TYPES = {".laz": "application/vnd.laszip", ".tif": "image/tiff", ".geojson": "application/geo+json", ".json": "application/json", ".png": "image/png"}


def _client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("CORRIDOR_S3_ENDPOINT") or None,
        region_name=os.environ.get("CORRIDOR_S3_REGION", "auto"),
        config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 5, "mode": "standard"}),
    )


def sync(sites_dir: Path, slug: str, prefix: str, dry_run: bool = False) -> None:
    bucket = os.environ.get("CORRIDOR_S3_BUCKET")
    if not bucket:
        raise SystemExit("CORRIDOR_S3_BUCKET is not set")
    dirs = sorted(d for d in sites_dir.glob("*") if (d / "manifest.json").exists() and (slug == "all" or d.name == slug))
    if not dirs:
        raise SystemExit(f"nothing to publish under {sites_dir}")
    s3 = None if dry_run else _client()
    existing: dict[str, int] = {}
    if s3:
        pager = s3.get_paginator("list_objects_v2")
        for page in pager.paginate(Bucket=bucket, Prefix=prefix + "/"):
            for o in page.get("Contents", []):
                existing[o["Key"]] = o["Size"]
    sent = skipped = 0
    index = {"sites": []}
    for d in dirs:
        for f in sorted(p for p in d.rglob("*") if p.is_file() and not p.name.endswith(".part")):
            key = f"{prefix}/sites/{d.name}/{f.relative_to(d).as_posix()}"
            size = f.stat().st_size
            if existing.get(key) == size:
                skipped += 1
                continue
            ctype = TYPES.get(f.suffix) or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            print(f"  {'would put' if dry_run else 'put'}  {key}  ({size / 2**20:.1f} MiB)", flush=True)
            if s3:
                s3.upload_file(str(f), bucket, key, ExtraArgs={"ContentType": ctype})
            sent += 1
        index["sites"].append({"slug": d.name, "manifest": json.loads((d / "manifest.json").read_text()), "base": f"{prefix}/sites/{d.name}/"})
    body = json.dumps(index, default=str).encode()
    if s3:
        s3.put_object(Bucket=bucket, Key=f"{prefix}/index.json", Body=body, ContentType="application/json")
    print(f"published {sent} objects, {skipped} unchanged, {len(dirs)} sites -> s3://{bucket}/{prefix}/")
