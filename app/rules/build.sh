#!/bin/sh
# Builds the rule presets and copies each module beside this script, where the
# web app loads it. A chain names its module by CID, so a rebuild must give the
# same bytes on any machine: rustc keeps source paths in a module, so the
# repository's own path is remapped to a fixed name, and the toolchain is
# pinned in rust-toolchain.toml.
set -eu
cd "$(dirname "$0")"
root=$(cd ../.. && pwd)
RUSTFLAGS="--remap-path-prefix=$root=/hearth --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo" \
  cargo build --release --target wasm32-unknown-unknown "$@"
for m in own_keys write_once; do
  cp "target/wasm32-unknown-unknown/release/$m.wasm" "$m.wasm"
done
