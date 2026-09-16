# -*- mode: python ; coding: utf-8 -*-
"""TokenWatch 桌面启动器打包配置（单文件 exe）

路径用 SPECPATH 推导，不要写死本机绝对路径。
用法：
    pyinstaller --noconfirm TokenWatchLauncher.spec
产物 dist/TokenWatchLauncher.exe 是瘦启动器，可复制到桌面等任意位置；
它靠 %APPDATA%\\TokenWatch\\install_path.txt 定位真正的 TokenWatch.exe，
该文件由「打包桌面版.bat」在打包成功后写入 —— 所以要先打主程序，再打启动器。
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
