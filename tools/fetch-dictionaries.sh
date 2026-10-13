#!/usr/bin/env bash
# fetch-dictionaries.sh — refresh the spell-check dictionaries shipped in rootfs/usr/share/aurora/dictionaries.
#
# Selene's spell checker is Chromium's (Electron's) built-in Hunspell, which reads dictionaries in Chromium's
# binary .bdic format, named <lang>-<version>.bdic (the names are compiled into Electron: fr-FR-3-0, en-US-10-1).
# Source: every Electron release publishes the converted Chromium dictionaries as hunspell_dictionaries.zip
# (https://github.com/electron/electron/releases/download/v<version>/hunspell_dictionaries.zip), checked here
# against the release's SHASUMS256.txt. The files are committed, so building the ISO needs no network; at run time
# shell/main/ipc/spell.js copies them into the session's Dictionaries folder and never downloads anything.
# Licences: French (Dicollecte, MPL 2.0), English (SCOWL / Hunspell en_US, BSD-style) — see Chromium's
# third_party/hunspell_dictionaries.
#
# Usage: tools/fetch-dictionaries.sh [electron version]   (default: the version in shell/package.json)
set -euo pipefail
cd "$(dirname "$0")/.."
ver="${1:-$(node -p "require('./shell/package.json').devDependencies.electron")}"
dest=rootfs/usr/share/aurora/dictionaries
files=(fr-FR-3-0.bdic en-US-10-1.bdic)
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/electron/electron/releases/download/v$ver"
curl -fsSL --retry 3 -o "$tmp/hunspell_dictionaries.zip" "$base/hunspell_dictionaries.zip"
curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
want="$(awk '$2 ~ /hunspell_dictionaries\.zip$/ {print $1}' "$tmp/SHASUMS256.txt")"
got="$(sha256sum "$tmp/hunspell_dictionaries.zip" | cut -d' ' -f1)"
[[ -n "$want" && "$want" == "$got" ]] || { echo "checksum mismatch for hunspell_dictionaries.zip ($got, expected $want)" >&2; exit 1; }
mkdir -p "$tmp/x" "$dest"
unzip -q -o "$tmp/hunspell_dictionaries.zip" "${files[@]}" -d "$tmp/x"
for f in "${files[@]}"; do install -m 0644 "$tmp/x/$f" "$dest/$f"; done
echo "dictionaries from Electron $ver:"; (cd "$dest" && sha256sum "${files[@]}")
