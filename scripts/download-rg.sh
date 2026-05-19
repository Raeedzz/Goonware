#!/usr/bin/env bash
#
# Downloads ripgrep into src-tauri/binaries/ as a Tauri sidecar binary
# so GLI ships with `rg` baked in — no `brew install ripgrep` required.
#
# Tauri's `bundle.externalBin` mechanism expects the binary name to be
# `<name>-<rust-target-triple>` (e.g. rg-aarch64-apple-darwin). On
# Darwin we always fetch both arm64 and x86_64 because the release
# pipeline builds a universal binary and the bundler refuses to start
# if either target's sidecar is missing. We pull from BurntSushi's
# official releases on GitHub. The script is idempotent — re-runs are
# no-ops once a binary is in place.

set -euo pipefail

VERSION="${RG_VERSION:-14.1.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BIN_DIR"

fetch() {
  local archive="$1"
  local target="$2"
  local dest="$BIN_DIR/rg-$target"
  if [[ -x "$dest" ]]; then
    echo "[download-rg] already present → $dest"
    return
  fi
  local url="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${archive}"
  local tmp
  tmp="$(mktemp -d)"
  echo "[download-rg] fetching $url"
  curl -fsSL "$url" -o "$tmp/rg.tar.gz"
  tar -xzf "$tmp/rg.tar.gz" -C "$tmp"
  local inner
  inner="$(find "$tmp" -name rg -type f -perm -u+x | head -n 1)"
  if [[ -z "$inner" ]]; then
    echo "[download-rg] couldn't find rg binary inside $archive" >&2
    rm -rf "$tmp"
    exit 1
  fi
  cp "$inner" "$dest"
  chmod +x "$dest"
  rm -rf "$tmp"
  echo "[download-rg] installed → $dest"
}

case "$(uname -s)" in
  Darwin)
    # Universal bundle declares both targets — always fetch both.
    fetch "ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz" "aarch64-apple-darwin"
    fetch "ripgrep-${VERSION}-x86_64-apple-darwin.tar.gz"  "x86_64-apple-darwin"
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64)
        fetch "ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz" "x86_64-unknown-linux-gnu"
        ;;
      aarch64)
        fetch "ripgrep-${VERSION}-aarch64-unknown-linux-gnu.tar.gz" "aarch64-unknown-linux-gnu"
        ;;
      *)
        echo "[download-rg] unsupported linux arch: $(uname -m)" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "[download-rg] unsupported host OS: $(uname -s)" >&2
    exit 1
    ;;
esac
