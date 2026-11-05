#!/bin/sh
# Symlink firmware/libraries/GhostyBoard into the Arduino sketchbook so every
# sketch can `#include <GhostyBoard.h>`. Safe to re-run.
#
# Override the destination with ARDUINO_LIBS, e.g. on Linux:
#   ARDUINO_LIBS="$HOME/Arduino/libraries" firmware/scripts/link-lib.sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LIB_SRC=$(CDPATH= cd -- "$SCRIPT_DIR/../libraries/GhostyBoard" && pwd)
DEST_DIR=${ARDUINO_LIBS:-"$HOME/Documents/Arduino/libraries"}
DEST="$DEST_DIR/GhostyBoard"

mkdir -p "$DEST_DIR"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "skip: $DEST already exists"
else
  ln -s "$LIB_SRC" "$DEST"
  echo "linked: $DEST -> $LIB_SRC"
fi

if [ ! -f "$LIB_SRC/src/secrets.h" ]; then
  echo "next: cp \"$LIB_SRC/src/secrets.h.example\" \"$LIB_SRC/src/secrets.h\" and fill in WiFi + server"
fi
echo "Restart Arduino IDE so it picks up the library."
