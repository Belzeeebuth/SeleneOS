# Aurora OS — top-level Makefile.
#
#   make iso          build out/aurora-os-<version>-amd64.iso      (runs iso/build.sh as root)
#   make run          boot the ISO in QEMU (BIOS) with a 32G virtual disk (KVM if available, else TCG)
#   make run-uefi     same with UEFI firmware (OVMF)
#   make run-disk     boot the installed virtual disk only
#   make shell-deps   npm ci in shell/ (Electron + test tooling for development)
#   make test         shell smoke test under Xvfb
#   make docker-iso   build the ISO inside a privileged ubuntu:24.04 container
#   make clean        remove work/ (chroot layers, ISO tree, VM state); keeps cache/ and out/
#   make distclean    remove work/, cache/ and out/
#
# Variables (make VAR=value ...):
#   MEM=4096        VM memory in MB            CPUS=4          VM vCPUs
#   DISK=work/qemu/aurora-disk.qcow2            DISK_SIZE=32G   size of a newly created disk
#   ISO=out/aurora-os-<version>-amd64.iso       RES=WxH         VM screen mode
#   VGA=virtio|std  HEADLESS=1 (no window, QMP/serial/guest-agent sockets in work/qemu/)
#   QEMU_ARGS="..." extra arguments for tools/qemu-run.sh
#   BUILD_ARGS="--until system" extra arguments for iso/build.sh
#   Build settings from iso/config.sh can be passed too, e.g. make iso SNAPSHOT=0 WITH_FIRMWARE=1

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT        := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
VERSION     := $(shell sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(ROOT)/shell/package.json | head -n1)
ISO         ?= $(ROOT)/out/aurora-os-$(VERSION)-amd64.iso
DISK        ?= $(ROOT)/work/qemu/aurora-disk.qcow2
DISK_SIZE   ?= 32G
MEM         ?= 4096
CPUS        ?= 4
VGA         ?= virtio
RES         ?=
HEADLESS    ?= 0
QEMU_ARGS   ?=
BUILD_ARGS  ?=
NODE_BIN    ?= /opt/node22/bin
DOCKER      ?= docker
DOCKER_IMAGE ?= aurora-os-builder:24.04

SUDO := $(if $(filter 0,$(shell id -u)),,sudo -E)
# Settings forwarded to iso/build.sh when given on the make command line or in the environment.
BUILD_ENV := $(foreach v,SNAPSHOT SNAPSHOT_STAMP MIRROR WITH_FIRMWARE KERNEL_PACKAGE INSTALL_RECOMMENDS \
  ALLOW_MISSING_PACKAGES ISO_VERSION SQUASHFS_COMP SQUASHFS_LEVEL ELECTRON_VERSION SOURCE_DATE_EPOCH,\
  $(if $(filter command line environment,$(origin $(v))),$(v)='$($(v))'))
QEMU_ENV := MEM='$(MEM)' CPUS='$(CPUS)' DISK='$(DISK)' DISK_SIZE='$(DISK_SIZE)' VGA='$(VGA)' RES='$(RES)'
QEMU_FLAGS := $(if $(filter 1,$(HEADLESS)),--headless)

.PHONY: help iso run run-uefi run-disk shell-deps test docker-iso clean distclean

help:
	@sed -n '1,/^$$/p' $(firstword $(MAKEFILE_LIST)) | sed 's/^# \{0,1\}//'

iso:
	$(SUDO) env $(BUILD_ENV) $(ROOT)/iso/build.sh $(BUILD_ARGS)

run:
	$(QEMU_ENV) $(ROOT)/tools/qemu-run.sh --iso '$(ISO)' $(QEMU_FLAGS) $(QEMU_ARGS)

run-uefi:
	$(QEMU_ENV) $(ROOT)/tools/qemu-run.sh --uefi --iso '$(ISO)' $(QEMU_FLAGS) $(QEMU_ARGS)

run-disk:
	$(QEMU_ENV) $(ROOT)/tools/qemu-run.sh --boot disk $(QEMU_FLAGS) $(QEMU_ARGS)

shell-deps:
	cd $(ROOT)/shell && PATH="$(NODE_BIN):$$PATH" npm ci --no-audit --no-fund

test:
	@test -d $(ROOT)/shell/node_modules/electron || { echo "run 'make shell-deps' first"; exit 1; }
	cd $(ROOT)/shell && PATH="$(NODE_BIN):$$PATH" xvfb-run -a -s "-screen 0 1600x900x24" node test/smoke.mjs

docker-iso:
	$(DOCKER) build -t $(DOCKER_IMAGE) -f $(ROOT)/iso/Dockerfile $(ROOT)/iso
	$(DOCKER) run --rm --privileged -v /dev:/dev -v $(ROOT):/src -w /src \
	  $(foreach v,https_proxy HTTPS_PROXY http_proxy,$(if $($(v)),-e $(v)='$($(v))')) \
	  $(DOCKER_IMAGE) env $(BUILD_ENV) ./iso/build.sh $(BUILD_ARGS)

clean:
	@if [ -d $(ROOT)/work ]; then \
	  $(SUDO) bash -c 'for m in $$(findmnt -rn -o TARGET | grep "^$(ROOT)/work" | sort -r); do umount "$$m" || umount -l "$$m"; done; rm -rf "$(ROOT)/work"'; \
	fi

distclean: clean
	$(SUDO) rm -rf $(ROOT)/cache $(ROOT)/out
