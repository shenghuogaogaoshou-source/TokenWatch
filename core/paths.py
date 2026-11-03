# -*- coding: utf-8 -*-
"""运行期路径解析。

打包后 exe 位于 dist/TokenWatch/，但**可写数据一律放 %APPDATA%\\TokenWatch**：
exe 目录可能只读（Program Files）、且重新打包会整目录替换，写在那里等于每次都丢。

优先级：环境变量 > %APPDATA%\\TokenWatch。
desktop_app.py 会先 setdefault TOKENWATCH_CONFIG，所以两者实际指向同一个目录。
"""
import os
import sys

APP_NAME = "TokenWatch"


def _appdata():
    base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
    if base:
        return base
    up = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.join(up, "AppData", "Roaming")


def data_dir():
    """配置/凭据/本地库所在目录。"""
    cfg = os.environ.get("TOKENWATCH_CONFIG")
    if cfg:
        d = os.path.dirname(os.path.abspath(cfg))
    else:
        d = os.path.join(_appdata(), APP_NAME)
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def config_path():
    return os.environ.get("TOKENWATCH_CONFIG") or os.path.join(data_dir(), "config.json")


def creds_path():
    return (os.environ.get("TOKENWATCH_PLATFORM_CREDS")
            or os.path.join(data_dir(), "platform_creds.json"))


def db_path():
    return os.environ.get("TOKENWATCH_DB") or os.path.join(data_dir(), "usage.db")


def catalog_path():
    return os.environ.get("TOKENWATCH_CATALOG") or os.path.join(data_dir(), "models_cache.json")


def static_dir():
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "static")


def app_exe_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
