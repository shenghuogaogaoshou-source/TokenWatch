# -*- mode: python ; coding: utf-8 -*-
"""TokenWatch 桌面启动器打包配置（单文件 exe）

路径用 SPECPATH 推导，不要写死本机绝对路径。
用法：
    pyinstaller --noconfirm TokenWatchLauncher.spec
"""
import os

HERE = os.path.abspath(SPECPATH)

a = Analysis(
    [os.path.join(HERE, 'tokenwatch_launcher.py')],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='TokenWatchLauncher',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[os.path.join(HERE, 'tokenwatch.ico')],
)
