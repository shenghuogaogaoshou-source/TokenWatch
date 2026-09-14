# -*- mode: python ; coding: utf-8 -*-
"""TokenWatch 桌面版打包配置（PyInstaller onedir）

路径一律用 SPECPATH 推导，不写死本机绝对路径 —— 换台机器 clone 下来也能直接打包。
用法：
    pyinstaller --noconfirm TokenWatch.spec
注意：**不要加 --clean**（会去删已存在的 build/TokenWatch，被安全删除机制拦下）。
重打包前请先手动删掉 build/TokenWatch 与 dist/TokenWatch。
"""
import os

HERE = os.path.abspath(SPECPATH)

a = Analysis(
    [os.path.join(HERE, 'desktop_app.py')],
    pathex=[],
    binaries=[],
    datas=[(os.path.join(HERE, 'static'), 'static')],
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
    [],
    exclude_binaries=True,
    name='TokenWatch',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[os.path.join(HERE, 'tokenwatch.ico')],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='TokenWatch',
)
