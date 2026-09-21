# corridor: bake real-road corridors (OSM + DEM + NAIP + lidar + geology) onto a volume, publish to R2.
#
# Pure-Python plus GDAL's CLI. Every dependency ships manylinux wheels for both amd64 and arm64
# (rasterio, laspy, lazrs, shapely, pyproj, scipy), so — unlike the recon image — this builds
# under QEMU in minutes and one workflow can emit both architectures. No CUDA, no compiler.
#
# Data never lives in the image. CORRIDOR_DATA is the mount (a PVC in the chart); sites.json
# rides along so a Job can bake without the photos, which stay on Rich's machine.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt boto3

COPY corridor/ corridor/
COPY sites.json .

RUN useradd -u 10001 -m app && mkdir -p /data && chown app /data
USER 10001

ENV CORRIDOR_DATA=/data \
    CORRIDOR_SITES=/app/sites.json \
    PYTHONUNBUFFERED=1
VOLUME /data

ENTRYPOINT ["python", "-m", "corridor"]
CMD ["report"]
