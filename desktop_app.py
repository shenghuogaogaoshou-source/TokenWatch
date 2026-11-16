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


def is_tokenwatch(port):
    """端口被占用 ≠ 占用者是本程序：先问一句 /api/config，别把别人的服务当自己开窗口。"""
    import json
    import urllib.request
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:%d/api/config" % port, timeout=2) as r:
            return bool(json.loads(r.read().decode("utf-8")).get("ok"))
    except Exception:
        return False


# ---------------- 窗口图标 ----------------
# Edge --app 窗口的窗口图标（任务栏 / Alt+Tab 用的就是它）来自页面 favicon，
# 而 favicon 在 Edge 自己的资料库里是按 URL 缓存的：换了图但 URL 没变，任务栏会一直
# 显示旧图标。除了把 favicon 换成新地址，这里再把 .ico 直接按 HICON 设到窗口上，
# 两层保险 —— 页面还没加载完时也不至于先闪一下 Edge 的图标。

WM_SETICON = 0x0080
ICON_SMALL, ICON_BIG = 0, 1
IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
_ICON_CACHE = {}


def icon_file():
    """打包后用 _MEIPASS 里的副本；开发时用仓库根目录那份。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    p = os.path.join(base, "tokenwatch.ico")
    return p if os.path.exists(p) else None


def _titled_windows(substr):
    """标题里含 substr 的可见顶层窗口。用 ctypes 手写，不引第三方库。"""
    import ctypes
    from ctypes import wintypes as w
    user32 = ctypes.WinDLL("user32")
    out = []
    proc = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 2)
        user32.GetWindowTextW(hwnd, buf, n + 2)
        if substr.lower() in buf.value.lower():
            out.append(hwnd)
        return True

    user32.EnumWindows(proc(cb), 0)
    return out


def _hICON(path, size):
    key = (path, size)
    if key not in _ICON_CACHE:
        import ctypes
        from ctypes import wintypes as w
        user32 = ctypes.WinDLL("user32")
        # 必须显式声明：LoadImageW 返回的是 64 位句柄，默认 c_int 会被截断成野指针
        user32.LoadImageW.restype = w.HANDLE
        user32.LoadImageW.argtypes = [w.HINSTANCE, w.LPCWSTR, w.UINT,
                                      ctypes.c_int, ctypes.c_int, w.UINT]
        h = user32.LoadImageW(None, path, IMAGE_ICON, size, size, LR_LOADFROMFILE)
        if not h:
            return None
        _ICON_CACHE[key] = h          # 句柄要一直留着，窗口还在用它
    return _ICON_CACHE[key]


def set_window_icon(hwnd, path):
    """按任务栏实际需要的像素尺寸加载，并同时设大/小两个图标。"""
    import ctypes
    from ctypes import wintypes as w
    user32 = ctypes.WinDLL("user32")
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.SendMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
    big = user32.GetSystemMetrics(11) or 32     # SM_CXICON
    small = user32.GetSystemMetrics(49) or 16   # SM_CXSMICON
    ok = False
    for size, which in ((big, ICON_BIG), (small, ICON_SMALL)):
        h = _hICON(path, size)
        if h:
            user32.SendMessageW(hwnd, WM_SETICON, which, h)
            ok = True
    return ok


def watch_window_icon(path, seconds=12.0):
    """Edge 会在 favicon 落库后再刷一次窗口图标，所以隔一会儿补一次，直到窗口关掉。"""
    t0 = time.time()
    while time.time() - t0 < seconds:
        for hwnd in _titled_windows(APP_NAME):
            set_window_icon(hwnd, path)
        # 前 6 秒多补几遍（页面这时才刚加载完），之后收工
        time.sleep(0.4 if time.time() - t0 < 6 else 1.2)


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
    if port_in_use(default_port) and is_tokenwatch(default_port):
        url = "http://127.0.0.1:%d/" % default_port
        logging.info("instance already running, opening window at %s", url)
        if edge:
            open_app_window(url, edge, os.path.join(DATA_DIR, "edge-profile"))
        else:
            import webbrowser
            webbrowser.open(url)
        # 这个进程马上就退，来不及常驻补图标；等几秒把图标设上去再走
        ico = icon_file()
        if ico:
            t = threading.Thread(target=watch_window_icon, args=(ico, 5.0), daemon=True)
            t.start()
            t.join(5.5)
        return

    srv.bootstrap()
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

    # 把任务栏图标设成我们自己的（Edge 的 favicon 缓存可能还留着旧图）
    ico = icon_file()
    if ico:
        threading.Thread(target=watch_window_icon, args=(ico,), daemon=True).start()
        logging.info("window icon watcher started (%s)", ico)

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
