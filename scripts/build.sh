#!/usr/bin/env bash
set -euo pipefail

# Verify stellar CLI is installed
if ! command -v stellar &> /dev/null; then
  echo "ERROR: stellar CLI not found. Install with: cargo install stellar-cli --locked"
  exit 1
fi

# Verify wasm32-unknown-unknown target is available
if ! rustup target list | grep -q "wasm32-unknown-unknown (installed)"; then
  echo "==> Installing wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

echo "==> Building + optimizing Soroban contracts (wasm32-unknown-unknown, release)"
# `stellar contract build --optimize` supersedes the deprecated
# `stellar contract optimize` command in stellar-cli 25.x.
stellar contract build --optimize

echo "==> Building SDK (TypeScript)"
( cd sdk && npm run build )

echo "==> Done"
