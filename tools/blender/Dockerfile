# Blender, as an image of its own.
#
# WHY THIS IS NOT A STAGE IN THE WORLD EDITOR'S DOCKERFILE, which is where it was asked for. Rich,
# 2026-09-29: "make sure blender build step is not bundled with other steps in dockerfile so it
# caches". A separate image is the strongest version of that, and on this cluster it is the only
# version that works:
#
#   * gh200-1 is arm64 end to end, and blender.org publishes NO arm64 build for 5.x. So arm64
#     means compiling Blender from source — the better part of an hour on ten cores.
#   * The world editor's workflow builds both architectures on ONE amd64 runner through QEMU.
#     Compiling Blender under user-mode emulation is ten to twenty times slower, which is past
#     GitHub's six-hour job limit.
#   * A stage in that Dockerfile would cache — until the base image digest moved, and then every
#     world editor build would sit for hours recompiling a Blender nobody changed.
#
# So this image is built on NATIVE runners (amd64 and arm64 each on their own), only when the
# pinned version changes, and the world editor copies `/opt/blender` out of it in seconds.
#
# Both architectures produce the same layout, `/opt/blender/blender` plus `/opt/blender/5.1/`,
# which is what the official tarball unpacks to and what a source build installs into `bin/`.

ARG BLENDER_VERSION=5.1.2
ARG BLENDER_GIT_TAG=v5.1.2
ARG BLENDER_RELEASE_DIR=Blender5.1

# ---- amd64: the official binary ----------------------------------------------------------------
FROM debian:trixie-slim AS build-amd64
ARG BLENDER_VERSION
ARG BLENDER_RELEASE_DIR
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt \
    && curl -fsSL "https://download.blender.org/release/${BLENDER_RELEASE_DIR}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
       | tar -xJ -C /opt \
    && mv "/opt/blender-${BLENDER_VERSION}-linux-x64" /opt/blender

# ---- arm64: from source ------------------------------------------------------------------------
# TRIXIE, because Blender 5.x needs GCC 14 and bookworm ships 12. That is also why the world
# editor's runtime base moved to trixie: a binary built here links against trixie's glibc and will
# not start on bookworm's older one.
FROM debian:trixie AS build-arm64
ARG BLENDER_VERSION
ARG BLENDER_GIT_TAG
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build git git-lfs python3 ca-certificates \
        libx11-dev libxxf86vm-dev libxcursor-dev libxi-dev libxrandr-dev \
        libxinerama-dev libegl-dev libwayland-dev wayland-protocols \
        libxkbcommon-dev libdbus-1-dev linux-libc-dev libsm-dev libvulkan-dev \
    && rm -rf /var/lib/apt/lists/*

# ONE RUN, source to install to cleanup, so the layer holds only the result. Split across steps,
# the source tree and the precompiled libraries — several gigabytes — would each be a layer.
#
# WHAT IS TURNED OFF, and why it is safe for what this image is for (rigging, headless):
#   Cycles     the path tracer. Renders here are Workbench, a rasteriser; Cycles is also the
#              single largest part of the build.
#   USD, Hydra, MaterialX   interchange nobody in this pipeline reads or writes.
# What is deliberately LEFT ON: OpenVDB. The character rigger's watertight cage is a VOXEL remesh,
# and voxel remesh is OpenVDB — switching it off would build a Blender that rigs nothing.
#
# The job count is the memory budget, not the core count: the heavy translation units peak at a
# couple of gigabytes each, and a native arm runner has four cores and sixteen gigabytes.
ARG BUILD_JOBS=4
RUN set -eux; \
    git clone --branch "${BLENDER_GIT_TAG}" --depth 1 https://projects.blender.org/blender/blender.git /src; \
    cd /src; \
    # the 5.1 tag's .gitmodules has no entry for lib-linux_arm64, so `make update` skips it and the
    # build then cannot find its dependencies. Clone the matching release branch of the lib repo.
    git clone --branch "blender-v${BLENDER_VERSION%.*}-release" --depth 1 \
        https://projects.blender.org/blender/lib-linux_arm64.git lib/linux_arm64; \
    make -j"${BUILD_JOBS}" BUILD_DIR=/build \
        BUILD_CMAKE_ARGS="-DWITH_CYCLES=OFF -DWITH_USD=OFF -DWITH_HYDRA=OFF -DWITH_MATERIALX=OFF"; \
    test -x /build/bin/blender; \
    mkdir -p /opt; \
    cp -a /build/bin /opt/blender; \
    rm -rf /src /build

# ---- the result --------------------------------------------------------------------------------
FROM build-${TARGETARCH} AS build

# RUNNABLE, not scratch, so the workflow can smoke it and so a person can `docker run` it to see
# what version is inside. The world editor copies `/opt/blender` out and ignores the rest.
FROM debian:trixie-slim
ARG BLENDER_VERSION
# What Blender needs at runtime even with no display. Mesa's EGL is the important one: Workbench
# renders through an offscreen GL context, and on a node with no GPU in the pod that context is
# llvmpipe — software GL. Without it, `bpy.ops.render.render` fails with a GPU error that reads
# like a driver problem and the rigging agent loses its eyes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 \
        libgl1 libegl1 libegl-mesa0 libgl1-mesa-dri libgbm1 libwayland-client0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/blender /opt/blender
RUN ln -s /opt/blender/blender /usr/local/bin/blender \
    && blender --version | head -n1 | grep -q "Blender ${BLENDER_VERSION}"
LABEL org.opencontainers.image.title="blender" \
      org.opencontainers.image.version="${BLENDER_VERSION}" \
      org.opencontainers.image.description="Blender, headless, amd64 and arm64 — the rigging pipeline's"
ENTRYPOINT ["blender"]
CMD ["--version"]
