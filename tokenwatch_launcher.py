# -*- coding: utf-8 -*-
"""TokenWatch 桌面启动器：双击即拉起真正的 TokenWatch.exe

为什么需要它：PyInstaller onedir 打出来的 `dist/TokenWatch/TokenWatch.exe` 依赖同目录的
`_internal/`。只把那个 exe 复制到桌面是跑不起来的（找不到依赖），所以用一个瘦启动器
负责「定位 + 以正确工作目录拉起」。

查找顺序（不写死任何本机绝对路径）：
1. 启动器同级的 `TokenWatch/TokenWatch.exe`        —— 启动器与 dist 放在一起
2. 启动器同级的 `dist/TokenWatch/TokenWatch.exe`   —— 直接跑在仓库根目录
3. `%APPDATA%\\TokenWatch\\install_path.txt` 里记录的路径
   —— 由「打包桌面版.bat」在打包成功后写入，所以启动器可以被复制到任何地方（比如桌面）

都找不到时给出明确提示，而不是静默失败。
"""
import os
import subprocess
import sys

REL = os.path.join("TokenWatch", "TokenWatch.exe")
APP_NAME = "TokenWatch"


def _appdata_dir():
    base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
    if base:
        return os.path.join(base, APP_NAME)
    up = os.environ.get("USERPROFILE")
    if up:
        return os.path.join(up, "AppData", "Roaming", APP_NAME)
    return os.path.join(os.path.expanduser("~"), "." + APP_NAME)


def _self_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _from_install_record():
    p = os.path.join(_appdata_dir(), "install_path.txt")
    try:
        with open(p, "r", encoding="utf-8-sig") as f:
            cand = f.read().strip().strip('"')
        return cand if cand and os.path.exists(cand) else None
    except Exception:
        return None


def find_exe():
    d = _self_dir()
    for cand in (os.path.join(d, REL), (os.path.join(d, "dist", REL))):
        if os.path.exists(cand):
            return cand
    return _from_install_record()


def main():
    exe = find_exe()
    if not exe:
        msg = ("未找到 TokenWatch.exe。\n\n"
               "请先运行「打包桌面版.bat」完成打包，\n"
               "产物应为 dist\\TokenWatch\\TokenWatch.exe。")
        print(msg)
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "TokenWatch", 0x10)
        except Exception:
            pass
        return 1
    try:
        subprocess.Popen([exe], cwd=os.path.dirname(exe),
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception:
        os.startfile(exe)
    return 0


if __name__ == "__main__":
    sys.exit(main())
