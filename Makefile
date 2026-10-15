# Selene OS — top-level Makefile.
#
#   make iso            build out/selene-os-<version>-amd64.iso      (runs iso/build.sh as root)
#   make run            live ISO in QEMU (BIOS) + a 32G virtual disk to install to (created on first use);
#                       the disk boots first once something is installed on it (KVM if usable, else TCG)
#   make run-uefi       same with UEFI firmware (OVMF)
#   make run-disk       boot the installed virtual disk only, BIOS     (run-disk-uefi: UEFI)
#   make run DRY_RUN=1  print the QEMU command line instead of starting the VM (any run* target)
#   make verify-iso     static checks of the ISO: boot records, GRUB menu, casper, image content (root)
#   make smoke-image    run the built image's Electron shell + greeter under Xvfb (no VM; root)
#   make shell-deps     npm ci in shell/ (Electron + test tooling for development)
#   make test           shell smoke test under Xvfb
#   make test-all       every shell test suite (TEST_ARGS="-j 3 --retry --only=files,mail")
#   make docker-iso     build the ISO inside a privileged ubuntu:24.04 container (iso/Dockerfile)
#   make debs           Selene's own packages (aurora-electron, aurora-shell, aurora-base) into out/debs/
#   make repo           signed apt repository out/apt/ from out/debs/ (key: keys/, created once; docs/UPDATES.md)
#   make release VERSION=x.y.z   bump VERSION, build debs + repo, release notes skeleton in docs/releases/
#   make clean          remove the build tree in work/ (chroot layers, ISO tree); keeps cache/, out/
#                       and the VM disk/state in work/qemu/
#   make clean-vm       remove the VM disk and UEFI variables (work/qemu/)
#   make distclean      remove work/, cache/ and out/
#
# Variables (make VAR=value ...):
#   MEM=4096        VM memory in MB            CPUS=4          VM vCPUs
#   DISK=work/qemu/aurora-disk.qcow2            DISK_SIZE=32G   size of a newly created disk
#   ISO=out/selene-os-<version>-amd64.iso       RES=WxH         initial VM screen mode
#   VGA=auto|virtio|virtio-gl|std  display adapter (auto = 3D when the host can; std = most compatible)
#   AUDIO=auto|pipewire|pa|sdl|none
#   BOOT=auto|cd    auto: disk first, CD while the disk is blank; cd: always the live CD first
#   HEADLESS=1      no window (QMP/serial/guest-agent sockets in work/qemu/)
#   QEMU_ARGS="..." extra arguments for tools/qemu-run.sh (see tools/qemu-run.sh --help)
#   BUILD_ARGS="--until system" extra arguments for iso/build.sh (see iso/build.sh --help)
#   Build settings from iso/config.sh, e.g.:
#     make iso SNAPSHOT=0              newest packages from archive.ubuntu.com instead of the pinned snapshot
#     make iso STAMP=20261101T000000Z  another snapshot date      make iso WITH_FIRMWARE=1  (real hardware)

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT        := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
VERSION     := $(or $(shell cat $(ROOT)/VERSION 2>/dev/null),$(shell sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(ROOT)/shell/package.json | head -n1))
ISO         ?= $(ROOT)/out/selene-os-$(VERSION)-amd64.iso
DISK        ?= $(ROOT)/work/qemu/aurora-disk.qcow2
DISK_SIZE   ?= 32G
MEM         ?= 4096
CPUS        ?= 4
VGA         ?= auto
RES         ?=
AUDIO       ?= auto
BOOT        ?= auto
HEADLESS    ?= 0
DRY_RUN     ?= 0
QEMU_ARGS   ?=
BUILD_ARGS  ?=
NODE_BIN    ?= /opt/node22/bin
DOCKER      ?= docker
DOCKER_IMAGE ?= aurora-os-builder:24.04

SUDO := $(if $(filter 0,$(shell id -u)),,sudo -E)
# docker-iso mounts the git work tree that holds aurora-os/ (its .git is in a parent folder), so that git works in the
# container: build id + SOURCE_DATE_EPOCH (iso/config.sh) and the Selene package versions (tools/build-debs.sh: commit
# count). Found without git (make may run as root on a user's tree). Git there never writes: .git is mounted read-only
# and GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing the index.
GIT_TOP := $(shell d='$(ROOT)'; while [ "$$d" != / ] && [ ! -d "$$d/.git" ]; do d=$$(dirname "$$d"); done; [ -d "$$d/.git" ] && echo "$$d")
DOCKER_SRC := $(or $(GIT_TOP),$(ROOT))
DOCKER_WD := /src$(patsubst $(DOCKER_SRC)%,%,$(ROOT))
# Settings forwarded to iso/build.sh when given on the make command line or in the environment.
BUILD_VARS := SNAPSHOT SNAPSHOT_STAMP STAMP MIRROR ARCHIVE_MIRROR WITH_FIRMWARE KERNEL_PACKAGE \
  INSTALL_RECOMMENDS ALLOW_MISSING_PACKAGES ISO_VERSION SQUASHFS_COMP SQUASHFS_LEVEL \
  ELECTRON_VERSION ELECTRON_SHA256 SOURCE_DATE_EPOCH BUILD_CA_BUNDLE
BUILD_ENV := $(foreach v,$(BUILD_VARS),$(if $(filter command line environment,$(origin $(v))),$(v)='$($(v))'))
QEMU_ENV := MEM='$(MEM)' CPUS='$(CPUS)' DISK='$(DISK)' DISK_SIZE='$(DISK_SIZE)' VGA='$(VGA)' RES='$(RES)' AUDIO='$(AUDIO)'
QEMU_FLAGS := $(if $(filter 1,$(HEADLESS)),--headless) $(if $(filter 1,$(DRY_RUN)),--dry-run)
QEMU_RUN := $(QEMU_ENV) $(ROOT)/tools/qemu-run.sh

.PHONY: help iso run run-uefi run-disk run-disk-uefi verify-iso smoke-image shell-deps test test-all docker-iso clean clean-vm distclean

help:
	@sed -n '1,/^$$/p' $(firstword $(MAKEFILE_LIST)) | sed 's/^# \{0,1\}//'

iso:
	$(SUDO) env $(BUILD_ENV) $(ROOT)/iso/build.sh $(BUILD_ARGS)

run:
	$(QEMU_RUN) --iso '$(ISO)' --boot '$(BOOT)' $(QEMU_FLAGS) $(QEMU_ARGS)

run-uefi:
	$(QEMU_RUN) --uefi --iso '$(ISO)' --boot '$(BOOT)' $(QEMU_FLAGS) $(QEMU_ARGS)

run-disk:
	$(QEMU_RUN) --boot disk $(QEMU_FLAGS) $(QEMU_ARGS)

run-disk-uefi:
	$(QEMU_RUN) --uefi --boot disk $(QEMU_FLAGS) $(QEMU_ARGS)

verify-iso:
	$(SUDO) $(ROOT)/tools/verify-iso.sh --iso '$(ISO)'

smoke-image:
	$(SUDO) $(ROOT)/tools/smoke-image.sh --iso '$(ISO)'

shell-deps:
	cd $(ROOT)/shell && PATH="$(NODE_BIN):$$PATH" npm ci --no-audit --no-fund

test:
	@test -d $(ROOT)/shell/node_modules/electron || { echo "run 'make shell-deps' first"; exit 1; }
	cd $(ROOT)/shell && PATH="$(NODE_BIN):$$PATH" xvfb-run -a -s "-screen 0 1600x900x24" node test/smoke.mjs

test-all:
	@test -d $(ROOT)/shell/node_modules/electron || { echo "run 'make shell-deps' first"; exit 1; }
	cd $(ROOT)/shell && PATH="$(NODE_BIN):$$PATH" node test/run-all.mjs $(TEST_ARGS)

docker-iso:
	$(DOCKER) build --network host -t $(DOCKER_IMAGE) -f $(ROOT)/iso/Dockerfile \
	  $(foreach v,https_proxy HTTPS_PROXY http_proxy,$(if $($(v)),--build-arg $(v)='$($(v))')) $(ROOT)/iso
	$(DOCKER) run --rm --privileged --network host -v /dev:/dev -v $(DOCKER_SRC):/src -w $(DOCKER_WD) \
	  $(if $(GIT_TOP),-v $(GIT_TOP)/.git:/src/.git:ro -e GIT_OPTIONAL_LOCKS=0) \
	  -e AURORA_OUT_OWNER=$$(id -u):$$(id -g) \
	  $(foreach v,https_proxy HTTPS_PROXY http_proxy,$(if $($(v)),-e $(v)='$($(v))')) \
	  $(DOCKER_IMAGE) env $(BUILD_ENV) ./iso/build.sh $(BUILD_ARGS)

clean:
	@if [ -d $(ROOT)/work ]; then \
	  $(SUDO) bash -c 'for m in $$(findmnt -rn -o TARGET | grep "^$(ROOT)/work/" | sort -r); do umount "$$m" || umount -l "$$m"; done; \
	    find "$(ROOT)/work" -mindepth 1 -maxdepth 1 ! -name qemu -exec rm -rf {} +'; \
	fi

clean-vm:
	rm -rf $(ROOT)/work/qemu

distclean: clean clean-vm
	$(SUDO) rm -rf $(ROOT)/work $(ROOT)/cache $(ROOT)/out

# ---- Selene self-updates (docs/UPDATES.md) ----------------------------------------------------
.PHONY: debs repo release
debs:
	PATH="$(NODE_BIN):$$PATH" $(ROOT)/tools/build-debs.sh

repo: debs
	$(ROOT)/tools/build-repo.sh

release:
	@$(if $(filter command line,$(origin VERSION)),,echo "usage: make release VERSION=x.y.z"; exit 2)
	PATH="$(NODE_BIN):$$PATH" $(ROOT)/tools/release.sh '$(VERSION)'
