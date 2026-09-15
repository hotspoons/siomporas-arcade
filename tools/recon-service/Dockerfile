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
# the list to what you will actually run on. The multi-arch workflow passes a different list per
# platform; 9.0 is Hopper, which is what the GH200s are.
#
# ON COVERING PASCAL THROUGH BLACKWELL. Measured against these exact base images with
# `nvcc --list-gpu-arch`, not taken from a changelog:
#
#   CUDA 13.0.1  compute_75 80 86 87 88 89 90 100 103 110 120 121      Turing and up
#   CUDA 12.8.1  compute_50 52 53 60 61 62 70 72 75 80 86 87 89 90 100 101 120
#
# CUDA 13 DROPPED Maxwell, Pascal and Volta outright — sm_60/61 will not compile here at any
# setting, so Pascal is unreachable while this FROM line says 13.x. CUDA 12.8 covers the whole
# range asked for, Pascal (6.0/6.1) through Blackwell (12.0), in one base.
#
# Moving is therefore a base-image change, not an arch-list change, and it is not free: the stack
# proven on the GH200s is CUDA 13.0 with torch 2.13+cu130, and 12.8 means a different torch build
# and a full re-verification of all four extensions. Do it deliberately, on a branch, with a real
# reconstruction run at the end — not as a one-line edit here.
#
# Also weigh what it buys. Every architecture is a separate device-code pass over the same sources:
# the full 12.8 list is sixteen of them against the one this builds today, and the build is already
# tens of minutes. `TORCH_CUDA_ARCH_LIST` accepts a `+PTX` suffix on the newest entry, which lets
# anything newer than the list JIT at first use rather than needing its own pass.
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

# PINNED, and it matters more than it looks. torch is the ABI anchor for all four CUDA extensions
# below, and CuMesh hard-codes `-std=c++17` in its setup.py. torch 2.14's headers require C++20, so
# an unpinned install silently drifts onto a torch that cannot compile them:
#
#   error: #error C++20 or later compatible compiler is required to use PyTorch.
#
# 2.13.0+cu130 is the version this whole stack was verified against on a GH200. Bumping it means
# re-checking all four extensions, and probably patching CuMesh's standard along the way.
RUN pip install --break-system-packages --no-cache-dir \
      torch==2.13.0 torchvision==0.28.0 --index-url https://download.pytorch.org/whl/cu130

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

# nvdiffrast is an OPTIONAL flag in upstream's setup.sh and is not optional here: `o_voxel` imports
# it at module level, so without it the image builds perfectly and then dies on the first request
# with ModuleNotFoundError. The GL/EGL dev headers installed above are what let it build. v0.4.0 is
# the tag TRELLIS.2's own setup.sh pins.
RUN git clone --depth 1 -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git /tmp/nvdiffrast \
 && pip install --break-system-packages --no-build-isolation /tmp/nvdiffrast \
 && rm -rf /tmp/nvdiffrast

# Fail the BUILD, not the first request. Each of these cost an hour to find separately: cumesh needs
# the CUDA-13 patch, o_voxel needs nvdiffrast, flex_gemm is the sparse-conv backend, and importing
# the pipeline is what proves they agree with each other and with this exact torch.
RUN python3 -c "import torch, cumesh, o_voxel, flex_gemm, nvdiffrast, xformers, utils3d; print('torch', torch.__version__); print('EXTENSIONS OK')" \
 && PYTHONPATH=/opt/TRELLIS2 ATTN_BACKEND=sdpa SPARSE_ATTN_BACKEND=xformers \
    python3 -c "from trellis2.pipelines import Trellis2ImageTo3DPipeline; print('PIPELINE OK')"

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
