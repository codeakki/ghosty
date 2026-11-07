#!/bin/bash
# build.sh - build (and optionally flash) the Dabao signer with the Dabao SDK.
#
#   firmware/dabao/build.sh                       build -> ghosty_signer.uf2
#   firmware/dabao/build.sh flash <port>          build + flash (RESET returns to boot1)
#   firmware/dabao/build.sh flash <port> --persistent   run on every power-up
#   firmware/dabao/build.sh host                  build the test signer for this computer
#
# DABAO_SDK points at a checkout of https://github.com/ArmstrongSubero/dabao-sdk with the
# xPack riscv-none-elf-gcc 15.2.0 toolchain unpacked inside it (see its README).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/ghosty_signer"
SDK="${DABAO_SDK:-$HOME/Desktop/code/dabao/dabao-sdk}"

if [ "${1:-}" = "host" ]; then
  cc -O2 -Wall -Wextra \
    -DuECC_SUPPORTS_secp160r1=0 -DuECC_SUPPORTS_secp192r1=0 -DuECC_SUPPORTS_secp224r1=0 \
    -DuECC_SUPPORTS_secp256r1=0 -DuECC_SUPPORTS_secp256k1=1 \
    -o "$SRC/host/host_signer" "$SRC/host/host_signer.c" "$SRC/hl_signer.c" \
    "$SRC/third_party/micro-ecc/uECC.c" "$SRC/third_party/tiny_sha3/sha3.c"
  echo "built $SRC/host/host_signer"
  exit 0
fi

[ -x "$SDK/bao_flash.sh" ] || { echo "Dabao SDK not found at $SDK (set DABAO_SDK)"; exit 1; }

# The SDK builds examples/<name>/<first .c>; link our folder in as an example.
ln -sfn "$SRC" "$SDK/examples/ghosty_signer"
export PATH="${DABAO_VENV:-$HOME/Desktop/code/dabao/.venv}/bin:$PATH"

if [ "${1:-}" = "provision" ]; then
  # One-time: write an existing key (PROVISION_KEY env, 64 hex chars, 0x optional) into the Dabao RRAM.
  # Flashes in normal mode (RESET returns to boot1), then deletes the key header and every build output.
  port="${2:?usage: PROVISION_KEY=<hex> build.sh provision <port>}"
  key="${PROVISION_KEY#0x}"
  [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "PROVISION_KEY must be 64 hex chars"; exit 1; }
  cleanup() { rm -f "$SRC/provision_key.h" "$SDK"/build/ghosty_signer.* "$SDK"/build/main.o "$HERE/ghosty_signer.uf2"; }
  trap cleanup EXIT
  ( umask 077; printf '#define PROVISION_KEY_HEX "%s"\n' "$key" > "$SRC/provision_key.h" )
  unset PROVISION_KEY key
  "$SDK/bao_flash.sh" run "$port" ghosty_signer 2>&1 | grep -vi "key"
  exit 0
fi

if [ "${1:-}" = "flash" ]; then
  port="${2:?usage: build.sh flash <port> [--persistent]}"
  shift 2
  "$SDK/bao_flash.sh" run "$port" ghosty_signer "$@" 2>&1
else
  "$SDK/bao_flash.sh" build ghosty_signer 2>&1
fi
cp "$SDK/build/ghosty_signer.uf2" "$HERE/ghosty_signer.uf2"
echo "uf2: $HERE/ghosty_signer.uf2"
