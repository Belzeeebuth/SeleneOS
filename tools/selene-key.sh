#!/bin/bash
# Selene OS — the Selene archive signing key (docs/UPDATES.md).
#
#   tools/selene-key.sh ensure    create the key in keys/gnupg (gitignored) when there is none, and export the public
#                                 keyring to iso/keys/selene-archive-keyring.gpg (committed; shipped in the image)
#   tools/selene-key.sh export    re-export the public keyring only
#   tools/selene-key.sh fpr       print the key's fingerprint
# SELENE_KEYS_DIR overrides keys/ (e.g. a removable disk). The private key never leaves that directory.
set -euo pipefail
AURORA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="${SELENE_KEYS_DIR:-$AURORA_ROOT/keys}"
PUB="${SELENE_KEYRING:-$AURORA_ROOT/iso/keys/selene-archive-keyring.gpg}"
UID_NAME="${SELENE_KEY_UID:-Selene OS Archive Signing Key <selene@selene-os.invalid>}"
export GNUPGHOME="$KEYS_DIR/gnupg"

fpr() { gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}'; }
export_pub() {
  local f; f="$(fpr)"; [[ -n "$f" ]] || { echo "selene-key: no key in $GNUPGHOME" >&2; exit 1; }
  mkdir -p "$(dirname "$PUB")"
  gpg --batch --yes --export "$f" >"$PUB.tmp" && mv "$PUB.tmp" "$PUB"
  echo "selene-key: public keyring $PUB ($f)" >&2
}

case "${1:-ensure}" in
ensure)
  mkdir -p "$KEYS_DIR"; chmod 0700 "$KEYS_DIR"; mkdir -p "$GNUPGHOME"; chmod 0700 "$GNUPGHOME"
  if [[ -z "$(fpr)" ]]; then
    if [[ -s "$PUB" ]]; then
      echo "selene-key: WARNING: $PUB exists but its private key is not in $GNUPGHOME;" \
           "creating a NEW key (installed systems trust the old one: see docs/UPDATES.md, « Key rotation »)" >&2
    fi
    echo "selene-key: creating the Selene archive key in $GNUPGHOME (keep a backup of $KEYS_DIR)" >&2
    gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key "$UID_NAME" rsa4096 sign 5y >/dev/null 2>&1
    export_pub
  elif [[ ! -s "$PUB" ]]; then
    export_pub
  fi
  ;;
export) export_pub ;;
fpr) fpr ;;
*) echo "usage: $0 ensure|export|fpr" >&2; exit 2 ;;
esac
