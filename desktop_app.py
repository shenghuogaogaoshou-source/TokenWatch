# -*- coding: utf-8 -*-
"""
TokenWatch 桌面端入口（Edge 应用窗口版）
- 启动本地服务后，用系统 Edge 的 --app 模式打开一个“无地址栏、无标签页”的应用窗口
- 观感与原生应用一致，且显示可靠性远高于内嵌 WebView；窗口关闭即自动退出
- 若已有一个实例在运行，再次双击只会再开一个窗口（不重复起服务）
"""
import os
import sys
import time
import socket
import logging
import threading
import subprocess

APP_NAME = "TokenWatch"


def _appdata_dir():
    base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
    if base:
        return os.path.join(base, APP_NAME)
    up = os.environ.get("USERPROFILE")
    if up:
        return os.path.join(up, "AppData", "Roaming", APP_NAME)
    return os.path.join(os.path.expanduser("~"), "." + APP_NAME)


if getattr(sys, "frozen", False):
    DATA_DIR = _appdata_dir()
else:
    DATA_DIR = os.path.dirname(os.path.abspath(__file__))
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    pass
os.environ.setdefault("TOKENWATCH_CONFIG", os.path.join(DATA_DIR, "config.json"))

LOG_PATH = os.path.join(DATA_DIR, "tokenwatch.log")
try:
    logging.basicConfig(filename=LOG_PATH, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", encoding="utf-8")
except Exception:
    pass

import server as srv  # noqa: E402


def find_edge():
    cands = []
    for env in ("ProgramFiles(x86)", "ProgramFiles"):
        root = os.environ.get(env)
        if root:
            cands.append(os.path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands.append(os.path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"))
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def open_app_window(url, edge, profile_dir):
    """启动独立 Edge 应用窗口（专属 user-data-dir，关闭窗口可感知）"""
    cmd = [edge, "--app=" + url,
           "--user-data-dir=" + profile_dir,
           "--window-size=1380,900",
           "--window-position=80,60",
           "--no-first-run", "--no-default-browser-check"]
    try:
        if sys.platform == "win32":
            flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
            return subprocess.Popen(cmd, creationflags=flags)
        return subprocess.Popen(cmd)
    except Exception:
        return None


def main():
    default_port = int(srv.config.get("port", 8733))
    edge = find_edge()

    # ---- 已有一个实例在运行？直接开窗口指向它 ----
    if port_in_use(default_port):
        url = "http://127.0.0.1:%d/" % default_port
        logging.info("instance already running, opening window at %s", url)
        if edge:
            open_app_window(url, edge, os.path.join(DATA_DIR, "edge-profile"))
        else:
            import webbrowser
            webbrowser.open(url)
        return

    httpd, port = srv.start_server(port=default_port)
    url = "http://127.0.0.1:%d/" % port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    logging.info("server started at %s (db=%s)", url, srv.DB_PATH)

    # ---- 打开应用窗口 ----
    proc = None
    if edge:
        proc = open_app_window(url, edge, os.path.join(DATA_DIR, "edge-profile"))
        if proc:
            logging.info("Edge app window launched (pid=%s)", proc.pid)
    if proc is None:
        import webbrowser
        webbrowser.open(url)
        logging.warning("Edge not found, opened default browser instead")

    # ---- 等待窗口被关闭后自动退出 ----
    try:
        while True:
            if proc is not None and proc.poll() is not None:
                logging.info("app window closed -> exit")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:
            pass
        logging.info("TokenWatch stopped")


if __name__ == "__main__":
    main()
