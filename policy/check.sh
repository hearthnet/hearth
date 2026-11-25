#!/bin/sh
# Rebuilds policy/src as chain/policy-v31.wasm was built (paths remapped, so
# any machine gives the same bytes) and says whether the bytes match.
set -eu
cd "$(dirname "$0")"
RUSTFLAGS="--remap-path-prefix=$HOME=/home --remap-path-prefix=$PWD=/hearth/policy" \
  cargo build --release --target wasm32-unknown-unknown
cmp target/wasm32-unknown-unknown/release/hostmarket_policy.wasm ../chain/policy-v31.wasm
echo "chain/policy-v31.wasm is this build of policy/src"
