#!/bin/bash
# Selene OS — make release VERSION=x.y.z (docs/UPDATES.md).
# Bumps VERSION, builds the Selene packages (out/debs) and the signed apt repository (out/apt), and writes a release
# notes skeleton docs/releases/<x.y.z>.md (commits since the previous VERSION bump) to complete before publishing.
set -euo pipefail
AURORA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
v="${1:-}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: make release VERSION=x.y.z" >&2; exit 2; }
old="$(tr -d ' \n' <"$AURORA_ROOT/VERSION")"
if [[ "$v" != "$old" ]]; then
  # The new version must be newer (apt only upgrades to higher versions).
  [[ "$(printf '%s\n%s\n' "$old" "$v" | sort -V | tail -n1)" == "$v" ]] || { echo "release: $v is older than $old" >&2; exit 2; }
fi
since="$(git -C "$AURORA_ROOT" log -1 --format=%H -- VERSION 2>/dev/null || true)"
echo "$v" >"$AURORA_ROOT/VERSION"
"$AURORA_ROOT/tools/build-debs.sh"
"$AURORA_ROOT/tools/build-repo.sh"
notes="$AURORA_ROOT/docs/releases/$v.md"
mkdir -p "$(dirname "$notes")"
if [[ ! -f "$notes" ]]; then
  {
    echo "# Selene OS $v"
    echo
    echo "_$(date -u +%Y-%m-%d) · packages: $(cd "$AURORA_ROOT/out/debs" && ls -1 ./*.deb | sed 's|^\./||' | tr '\n' ' ')_"
    echo
    echo "## Nouveautés / What's new"
    echo
    echo "- (FR) …"
    echo "- (EN) …"
    echo
    echo "## Corrections / Fixes"
    echo
    echo "- …"
    echo
    echo "## Sécurité / Security"
    echo
    echo "- Electron runtime: $(cd "$AURORA_ROOT/out/debs" && ls -1 aurora-electron_*.deb 2>/dev/null | sed "s/^aurora-electron_\(.*\)_.*/\1/")"
    echo
    echo "## Commits"
    echo
    if [[ -n "$since" ]]; then git -C "$AURORA_ROOT" log --format='- %s (%h)' "$since..HEAD"
    else git -C "$AURORA_ROOT" log -20 --format='- %s (%h)'; fi
  } >"$notes"
fi
echo "release $v: out/debs, out/apt (signed), $notes — publish out/apt (docs/UPDATES.md)"
