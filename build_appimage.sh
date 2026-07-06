#!/usr/bin/env bash
# Build the Bynari Insight Linux desktop app as a single-file AppImage.
#
# PyInstaller (onedir, Qt backend bundled) -> dist/Bynari/  ->  AppDir  ->
# appimagetool  ->  Bynari-x86_64.AppImage. Run from the repo root:
#   bash build_appimage.sh
set -euo pipefail
cd "$(dirname "$0")"

APPDIR="build/AppDir"
OUT="Bynari-x86_64.AppImage"
TOOL="$HOME/.local/bin/appimagetool"
# Build with the project's .venv Python — it has pywebview + PyQt6. The system
# Python does NOT, and bundling with it silently produces an exe that crashes at
# launch with "No module named 'webview'". Install PyInstaller into the venv.
VENV_PY=".venv/bin/python"

echo "[1/4] PyInstaller onedir build (using .venv, which has pywebview)…"
"$VENV_PY" -m pip install --quiet --disable-pip-version-check pyinstaller
"$VENV_PY" -m PyInstaller --noconfirm bynari-linux.spec

echo "[2/4] Assembling AppDir…"
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
cp -a dist/Bynari/. "$APPDIR/"
cp packaging/AppRun "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp packaging/bynari.desktop "$APPDIR/bynari.desktop"
cp bynari.png "$APPDIR/bynari.png"

echo "[3/4] Fetching appimagetool (one-time)…"
if [ ! -x "$TOOL" ]; then
  mkdir -p "$(dirname "$TOOL")"
  curl -fL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi

echo "[4/4] Packaging AppImage…"
# --appimage-extract-and-run avoids needing a working FUSE mount on the builder.
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream "$APPDIR" "$OUT"

echo "Done: $(pwd)/$OUT"
ls -lh "$OUT"
