# Aurora OS build environment: everything iso/build.sh needs on an Ubuntu 24.04 host.
#   docker build -t aurora-os-builder:24.04 -f iso/Dockerfile iso
#   docker run --rm --privileged --network host -v /dev:/dev -v "$PWD":/src -w /src \
#     -e AURORA_OUT_OWNER="$(id -u):$(id -g)" aurora-os-builder:24.04 ./iso/build.sh
# (or simply: make docker-iso). --privileged is required for the overlay/proc/sys mounts and the
# chroot; the repository must live on a local file system that supports overlayfs (ext4/xfs/btrfs).
FROM ubuntu:24.04

ARG NODE_VERSION=22.22.0
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils zstd unzip util-linux \
      debootstrap ubuntu-keyring squashfs-tools xorriso mtools dosfstools \
      grub-common grub-pc-bin grub-efi-amd64-bin \
      librsvg2-bin imagemagick \
 && rm -rf /var/lib/apt/lists/*

# Node.js 22 (npm ci of the shell's runtime dependencies), checked against the release SHASUMS.
RUN set -eux; \
    cd /tmp; \
    f="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${f}\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/node22; \
    tar -xJf "${f}" -C /opt/node22 --strip-components=1; \
    rm -f "${f}" SHASUMS256.txt; \
    /opt/node22/bin/node --version

ENV NODE_BIN=/opt/node22/bin
# The repository is bind-mounted; let git read it regardless of ownership.
RUN git config --system --add safe.directory '*'
