# Building the Bynari Linux desktop app

Bynari is a Pywebview shell (`app.py`) wrapping the web UI (`index.html`, `app.js`,
`styles.css`). It targets **Linux only**. Linux has no system web engine, so pywebview's
**Qt backend (PyQt6 + QtWebEngine) is bundled** into the app.

## Run from source

```
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt        # pywebview[qt], Pillow, requests, pyinstaller
python3 app.py
```

Handy dev launches:

```
BYNARI_PAGE=onboarding.html python3 app.py   # jump straight to a screen
BYNARI_GUI=qt python3 app.py                 # force the Qt backend
```

## Build the AppImage (single-file download)

```
bash build_appimage.sh
```

That runs, from the repo root:

1. **PyInstaller** (onedir, via `bynari-linux.spec`) — bundles Python, the Qt WebEngine
   backend, and the web assets into `dist/Bynari/`. Onedir (not onefile) because QtWebEngine's
   helper process and resources run far more reliably unpacked.
2. **AppDir assembly** — `dist/Bynari/` + `packaging/AppRun` + `packaging/bynari.desktop` + icon.
3. **appimagetool** — wraps the AppDir into `Bynari-x86_64.AppImage`.

Prerequisites: the project `.venv` (with `pywebview[qt]` / PyQt6) and `appimagetool` at
`~/.local/bin/appimagetool`.

## Pieces

| File | Role |
|---|---|
| `app.py` | Pywebview shell. `_resource_dir()` finds the bundled web assets under `sys._MEIPASS` when frozen. |
| `bynari-linux.spec` | PyInstaller spec — onedir, bundles PyQt6/QtWebEngine + the web assets → `dist/Bynari/`. |
| `build_appimage.sh` | Full pipeline → `Bynari-x86_64.AppImage`. |
| `packaging/` | `AppRun`, `bynari.desktop` for the AppDir. |

## TODO

- **Branded icon** — the spec/desktop entry use `bynari.png`; a crisper multi-size icon would help.
- **Paid-tier / help gate** — lands in the shell before any screen loads; not part of this build path.
