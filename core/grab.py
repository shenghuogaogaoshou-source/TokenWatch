# -*- coding: utf-8 -*-
"""自动读取官网登录态。

做法：用**独立 profile** 起一个带 `--remote-debugging-port` 的 Edge 窗口，
连 Chrome DevTools 协议（CDP），在页面里执行驱动自己的 probe 表达式；
localStorage 读不到时退到 `Network.getCookies`（HttpOnly 的 cookie 也能读）。

为什么要独立 profile：应用窗口用的是 edge-profile，同一个 user-data-dir
起第二个进程时 Edge 会把请求转交给已有实例，调试端口不会生效。
所以登录窗口单独用一个目录，登一次之后凭据在那边长期有效。

只用标准库：WebSocket 客户端是手写的（握手 + 帧编解码），够用就行。
"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

from core import paths

GRAB_PORT_FILE = "grab_port.txt"


# ---------------------------------------------------------------- Edge 启动
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


def profile_dir():
    d = os.path.join(paths.data_dir(), "edge-profile-login")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def _free_port(start=9333):
    for p in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0


def _http_json(port, path, timeout=3):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open("http://127.0.0.1:%d%s" % (port, path), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _alive(port):
    try:
        v = _http_json(port, "/json/version", timeout=1.5)
        return bool(v.get("webSocketDebuggerUrl") or v.get("Browser"))
    except Exception:
        return False


def _remember_port(port):
    try:
        with open(os.path.join(paths.data_dir(), GRAB_PORT_FILE), "w", encoding="utf-8") as f:
            f.write(str(port))
    except Exception:
        pass


def _recall_port():
    try:
        with open(os.path.join(paths.data_dir(), GRAB_PORT_FILE), encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return 0


def ensure_window(url):
    """确保有一个可调试的登录窗口。返回 (port, note)。"""
    port = _recall_port()
    if port and _alive(port):
        return port, "复用已经打开的登录窗口"
    edge = find_edge()
    if not edge:
        raise RuntimeError("没找到 Edge，请手动复制凭据")
    port = _free_port()
    if not port:
        raise RuntimeError("没有空闲端口，请先关掉其它调试程序")
    cmd = [edge,
           "--remote-debugging-port=%d" % port,
           "--user-data-dir=" + profile_dir(),
           "--no-first-run", "--no-default-browser-check",
           "--window-size=1180,860", "--window-position=140,80"]
    if url:
        cmd.append("--new-window")
        cmd.append(url)
    subprocess.Popen(cmd, close_fds=True)
    _remember_port(port)
    t0 = time.time()
    while time.time() - t0 < 25:
        if _alive(port):
            return port, "登录窗口已打开"
        time.sleep(0.4)
    raise RuntimeError("登录窗口没能启动（可能被安全软件拦了）")


# ---------------------------------------------------------------- WebSocket
class WS(object):
    """够用就行的 WebSocket 客户端：只发文本帧，只收文本帧。"""

    def __init__(self, url, timeout=8):
        from urllib.parse import urlparse
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n"
               % (path, u.hostname, u.port or 80, key))
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("DevTools 握手失败")
            buf += chunk
        head, rest = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise IOError("DevTools 拒绝连接")
        self.buf = rest

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError("连接已断开")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _frame(self, opcode, data):
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, obj):
        self._frame(0x1, json.dumps(obj).encode("utf-8"))

    def recv(self):
        payload = b""
        while True:
            b1, b2 = self._read(2)
            fin = b1 & 0x80
            op = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            masked = b2 & 0x80
            mk = self._read(4) if masked else None
            chunk = self._read(n)
            if masked:
                chunk = bytes(x ^ mk[i % 4] for i, x in enumerate(chunk))
            if op == 0x9:                      # ping → pong
                self._frame(0xA, chunk)
                continue
            if op == 0x8:                      # close
                raise IOError("窗口已关闭")
            payload += chunk
            if fin:
                return payload

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def _call(ws, rid, method, params=None, timeout=8):
    ws.send({"id": rid, "method": method, "params": params or {}})
    t0 = time.time()
    while time.time() - t0 < timeout:
        msg = json.loads(ws.recv().decode("utf-8"))
        if msg.get("id") == rid:
            if "error" in msg:
                raise RuntimeError(str(msg["error"].get("message") or msg["error"]))
            return msg.get("result") or {}
    raise RuntimeError("DevTools 没有响应")


# ---------------------------------------------------------------- 取目标页
def _targets(port):
    try:
        return _http_json(port, "/json/list", timeout=2)
    except Exception:
        return []


def _pick_target(port, host):
    """挑一个同站点的页面；没有就挑第一个普通页面。"""
    pages = [t for t in _targets(port) if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    for t in pages:
        if host and host in (t.get("url") or ""):
            return t
    return pages[0] if pages else None


def _host_of(url):
    try:
        from urllib.parse import urlparse
        h = urlparse(url or "").hostname or ""
        return h.replace("www.", "")
    except Exception:
        return ""


# ---------------------------------------------------------------- 主入口
def read_cred(driver_id, meta, timeout=95):
    """返回 {"ok": bool, "value": str, "note": str}。不抛异常。"""
    d = meta or {}
    probe = d.get("probe") or ""
    cookie_name = d.get("cookie_name") or ""
    if not (probe or cookie_name):
        return {"ok": False, "value": "", "note": "这个平台没有可自动读取的登录态，请手动填"}

    login_url = d.get("login_url") or d.get("site") or ""
    try:
        port, note = ensure_window(login_url)
    except Exception as e:
        return {"ok": False, "value": "", "note": str(e)}

    host = _host_of(login_url)
    deadline = time.time() + max(10, timeout)
    last_note = "还没读到，可能还没登录完"
    steered = False          # 复用旧窗口时，把它导到这次要登录的站点（只导一次）
    while time.time() < deadline:
        if not _alive(port):
            return {"ok": False, "value": "",
                    "note": "登录窗口被关掉了，再点一次会重新打开"}
        t = _pick_target(port, host)
        if t and host and host not in (t.get("url") or "") and not steered and login_url:
            steered = True
            try:
                ws_nav = WS(t["webSocketDebuggerUrl"])
                _call(ws_nav, 0, "Page.navigate", {"url": login_url}, timeout=4)
                ws_nav.close()
                time.sleep(2.5)
                continue
            except Exception:
                pass
        if not t:
            time.sleep(1.2)
            continue
        ws = None
        try:
            ws = WS(t["webSocketDebuggerUrl"])
            if probe:
                val = _call(ws, 1, "Runtime.evaluate", {
                    "expression": probe, "returnByValue": True, "awaitPromise": True,
                }).get("result", {}).get("value")
                if isinstance(val, str) and val.strip():
                    return {"ok": True, "value": val.strip(),
                            "note": "从页面登录态读取（%s）" % (t.get("title") or host)}
                if val and not isinstance(val, str):
                    return {"ok": True, "value": str(val),
                            "note": "从页面登录态读取"}
            if cookie_name:
                ck = _call(ws, 2, "Network.getCookies",
                           {"urls": [t.get("url") or login_url]})
                for c in ck.get("cookies") or []:
                    if c.get("name") == cookie_name and (c.get("value") or "").strip():
                        return {"ok": True, "value": c["value"].strip(),
                                "note": "从 cookie 读取" + ("（HttpOnly）" if c.get("httpOnly") else "")}
                last_note = "窗口开着，但还没拿到 %s，确认已经登录完成" % cookie_name
        except Exception as e:
            last_note = "读取中：%s" % e
        finally:
            if ws:
                ws.close()
        time.sleep(1.5)
    return {"ok": False, "value": "", "note": last_note + "（窗口还开着，登录完再点一次）"}


def status():
    """给「我登录窗口还开着吗」用的简单状态。"""
    port = _recall_port()
    return {"window_open": bool(port and _alive(port)), "port": port,
            "profile": profile_dir()}
