# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Bynari Linux desktop app.

Linux has no system web engine, so pywebview's Qt backend (PyQt6 + QtWebEngine)
must be bundled. This
is a ONEDIR build (QtWebEngine's helper process and resources work far more
reliably unpacked than from a onefile temp dir); the dir is then wrapped into an
AppImage.

Build:  .venv/bin/pyinstaller bynari-linux.spec   ->  dist/Bynari/
"""
from PyInstaller.utils.hooks import collect_all

datas = [
    ('index.html', '.'),
    ('app.js', '.'),
    ('styles.css', '.'),
    ('photo_roles.json', '.'),
]
binaries = []
hiddenimports = ['store', 'photo_ingest']

# pywebview, the qtpy shim it selects the binding through, and PyQt6 itself.
for pkg in ('webview', 'qtpy'):
    _d, _b, _h = collect_all(pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

# pywebview's qt backend imports these dynamically (via qtpy), so PyInstaller's
# static analysis needs them pinned — including the QtWebEngine widgets/core that
# carry the bundled Chromium helper + resources via PyInstaller's PyQt6 hooks.
hiddenimports += [
    'PyQt6.QtCore', 'PyQt6.QtGui', 'PyQt6.QtWidgets', 'PyQt6.QtNetwork',
    'PyQt6.QtWebEngineCore', 'PyQt6.QtWebEngineWidgets', 'PyQt6.QtWebChannel',
    'PyQt6.QtPrintSupport',
]

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'PyQt5',            # a stale PyQt5 in the dev venv would confuse qtpy
        # The GTK backend is never used (we force Qt) and its PyGObject hook
        # bundles ~1.5 GB of system icon themes — drop it entirely.
        'gi', 'gtk', 'cairo', 'numpy',
        # Qt modules QtWebEngineWidgets doesn't need.
        'PyQt6.Qt3DCore', 'PyQt6.Qt3DRender', 'PyQt6.Qt3DInput', 'PyQt6.Qt3DAnimation',
        'PyQt6.QtMultimedia', 'PyQt6.QtMultimediaWidgets', 'PyQt6.QtCharts',
        'PyQt6.QtDataVisualization', 'PyQt6.QtBluetooth', 'PyQt6.QtNfc',
        'PyQt6.QtPositioning', 'PyQt6.QtSensors', 'PyQt6.QtSerialPort',
        'PyQt6.QtDesigner', 'PyQt6.QtHelp', 'PyQt6.QtSql', 'PyQt6.QtTest',
        'PyQt6.QtQuick3D', 'PyQt6.QtRemoteObjects',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Bynari',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='Bynari',
)
