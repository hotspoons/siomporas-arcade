# Image-to-3D reconstruction service: TRELLIS.2 on Grace-Hopper (aarch64, CUDA 13).
#
# Why this base rather than a slim runtime: TRELLIS.2 compiles three CUDA extensions at build time
# (CuMesh, o-voxel, FlexGEMM) and they need the full CUDA toolkit headers, not just the runtime.
# Building against a trimmed CUDA install fails deep in the compile with a missing cusparse.h and
# then cusolverDn.h, one at a time, which is a slow way to learn this.
#
# None of TRELLIS.2's extensions ship as prebuilt wheels, which is exactly why it works on arm64
# where TRELLIS 1 cannot: TRELLIS 1 needs spconv, and spconv is x86-only wheels with no source path
# that builds here.
FROM nvidia/cuda:13.0.1-cudnn-devel-ubuntu24.04

# Which GPU architectures nvcc emits code for. Each one costs build time and image size, so keep
# the list to what you will actually run on: 9.0 is Hopper (GH200, H100), 8.0/8.6/8.9 are Ampere
# and Ada, 12.0 is Blackwell. The multi-arch workflow passes a different list per platform.
ARG TORCH_CUDA_ARCH_LIST=9.0

ENV DEBIAN_FRONTEND=noninteractive \
    CUDA_HOME=/usr/local/cuda \
    TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST} \
    MAX_JOBS=16 \
    ATTN_BACKEND=sdpa \
    SPARSE_ATTN_BACKEND=xformers \
    HF_HOME=/weights \
    MODEL_REPO=microsoft/TRELLIS.2-4B \
    MODEL_DIR=/weights/model \
    PYTHONUNBUFFERED=1

# ENCODER_REPO / REMBG_REPO are deliberately NOT set here. app/fetch_weights.py chooses at startup:
# with HF_TOKEN it uses the upstream gated repos, without one it falls back to ungated mirrors and
# prints a loud licence warning. Setting either here would override that decision silently.

# libeigen3-dev: o-voxel includes <Eigen/Dense>; Debian puts it under /usr/include/eigen3.
# The GL/EGL dev packages: utils3d pulls in glcontext, which will not build without them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-dev git build-essential ninja-build \
      libeigen3-dev \
      libgl1-mesa-dev libegl1-mesa-dev libgles2-mesa-dev libx11-dev libxrandr-dev libxi-dev \
    && ln -sfn /usr/include/eigen3/Eigen /usr/include/Eigen \
    && ln -sfn /usr/include/eigen3/unsupported /usr/include/unsupported \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages --no-cache-dir \
      torch torchvision --index-url https://download.pytorch.org/whl/cu130

RUN pip install --break-system-packages --no-cache-dir \
      imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh \
      transformers tensorboard pandas lpips zstandard kornia timm \
      fastapi "uvicorn[standard]" python-multipart pillow huggingface-hub \
      xformers \
 && pip install --break-system-packages --no-cache-dir \
      git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8

WORKDIR /opt
RUN git clone --depth 1 https://github.com/microsoft/TRELLIS.2.git /opt/TRELLIS2

# CuMesh must be installed BEFORE o-voxel. o-voxel declares cumesh as a dependency, so if it is not
# already present pip silently builds its own unpatched copy and the patch below never applies.
#
# The patch: CUDA 13 removed cub::Sum(). Credit to ehuqija217-max in microsoft/TRELLIS.2#19.
RUN git clone --recursive https://github.com/JeffreyXiang/CuMesh.git /tmp/CuMesh \
 && sed -i 's/cub::Sum()/thrust::plus<float>()/g' /tmp/CuMesh/src/atlas.cu \
 && sed -i '1i #include <thrust/functional.h>' /tmp/CuMesh/src/atlas.cu \
 && pip install --break-system-packages --no-build-isolation /tmp/CuMesh \
 && rm -rf /tmp/CuMesh

RUN cp -r /opt/TRELLIS2/o-voxel /tmp/o-voxel \
 && CPATH=/usr/include/eigen3 pip install --break-system-packages --no-build-isolation --no-deps /tmp/o-voxel \
 && rm -rf /tmp/o-voxel

RUN git clone --recursive https://github.com/JeffreyXiang/FlexGEMM.git /tmp/FlexGEMM \
 && pip install --break-system-packages --no-build-isolation /tmp/FlexGEMM \
 && rm -rf /tmp/FlexGEMM

# flash-attn is deliberately NOT installed -- a long, fragile source build on aarch64. Two separate
# attention backends have to be steered away from it:
#   ATTN_BACKEND=sdpa          dense attention, torch's own scaled_dot_product_attention
#   SPARSE_ATTN_BACKEND=xformers  SPARSE attention, which does NOT accept 'sdpa' -- see
#                              trellis2/modules/sparse/config.py, where an unrecognised value is
#                              silently ignored and the flash_attn default stands. xformers has a
#                              working aarch64 wheel; that is why it is in the pip list above.

COPY app /opt/app
ENV PYTHONPATH=/opt/TRELLIS2
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz',timeout=4)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/opt"]
