#!/usr/bin/env bash
# Launch the Bynari Insight desktop app with a known-good GUI backend.
# The GTK backend fails to map a window on this stack; Qt (PyQt6 QtWebEngine)
# is the reliable path. Run: setsid nohup bash run_desktop.sh &>/tmp/bynari_app.log &
cd "$(dirname "$0")" || exit 1
export DISPLAY="${DISPLAY:-:0}"
export BYNARI_GUI="${BYNARI_GUI:-qt}"
export QT_API="${QT_API:-pyqt6}"
exec ./.venv/bin/python app.py
