#!/bin/sh
# Build the `classifai` command line tool and put it where Tauri bundles it into the app
# (src-tauri/binaries/classifai-<target>, see bundle.externalBin). Run by `pnpm tauri dev` (debug)
# and `pnpm tauri build` (release).
set -e
profile="${1:-release}"
root="$(cd "$(dirname "$0")/.." && pwd)"
target="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$profile" = "release" ]; then
  cargo build --release -p classifai-cli --manifest-path "$root/Cargo.toml"
else
  cargo build -p classifai-cli --manifest-path "$root/Cargo.toml"
fi
mkdir -p "$root/src-tauri/binaries"
cp "$root/target/$( [ "$profile" = release ] && echo release || echo debug )/classifai" "$root/src-tauri/binaries/classifai-$target"
