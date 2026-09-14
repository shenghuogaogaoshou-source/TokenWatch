# -*- coding: utf-8 -*-
"""探测各供应商平台侧的用量/配额接口，输出原始响应，用于确定可用数据源。

用法: python probe_usage_api.py [provider ...]
不传参数则探测全部。响应原文会写到 api_probe/ 目录。
"""
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta

OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "api_probe")
os.makedirs(OUTDIR, exist_ok=True)

DB = os.path.expanduser("~/.cc-switch/cc-switch.db")


def load_keys():
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    c.row_factory = sqlite3.Row
    out = {}
    for r in c.execute("SELECT name, settings_config FROM providers"):
        try:
            cfg = json.loads(r["settings_config"] or "{}")
        except Exception:
            continue
        env = cfg.get("env") or {}
        key = (env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY")
               or env.get("OPENAI_API_KEY") or "")
        if key:
            out[r["name"]] = {"key": key, "base": env.get("ANTHROPIC_BASE_URL") or ""}
    return out


def get(url, headers, timeout=15):
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return e.code, body
    except Exception as e:
        return 0, str(e)


def probe(name, label, url, headers):
    code, body = get(url, headers)
    fn = re.sub(r"[^A-Za-z0-9]+", "_", "%s_%s" % (name, label)).strip("_")[:70] + ".json"
    path = os.path.join(OUTDIR, fn)
    with open(path, "w", encoding="utf-8") as f:
        f.write("URL: %s\nHTTP: %s\n\n%s" % (url, code, body))
    print("\n--- %s / %s" % (name, label))
    print("    URL  :", url)
    print("    HTTP :", code)
    print("    BODY :", body[:700].replace("\n", " "))
    return code, body


def main():
    keys = load_keys()
    want = sys.argv[1:] or ["DeepSeek", "Kimi", "Zhipu GLM"]
    now = datetime.now()
    d0 = (now - timedelta(days=1)).strftime("%Y-%m-%d 00:00:00")
    d1 = now.strftime("%Y-%m-%d 23:59:59")

    for name in want:
        p = keys.get(name)
        if not p:
            print("!! 未找到 provider:", name)
            continue
        k = p["key"]
        print("\n" + "=" * 70)
        print("PROVIDER:", name, "| base:", p["base"])

        if name == "DeepSeek":
            probe(name, "user_balance", "https://api.deepseek.com/user/balance",
                  {"Authorization": "Bearer " + k, "Accept": "application/json"})

        if name == "Kimi":
            probe(name, "moonshot_balance", "https://api.moonshot.cn/v1/users/me/balance",
                  {"Authorization": "Bearer " + k, "Accept": "application/json"})
            probe(name, "kimi_coding_usages", "https://api.kimi.com/coding/v1/usages",
                  {"Authorization": "Bearer " + k, "Accept": "application/json"})
            probe(name, "kimi_coding_usages_alt", "https://api.moonshot.cn/coding/v1/usages",
                  {"Authorization": "Bearer " + k, "Accept": "application/json"})

        if name == "Zhipu GLM":
            h = {"Authorization": k, "Accept": "application/json",
                 "Accept-Language": "zh-CN,zh", "Content-Type": "application/json"}
            probe(name, "quota_limit", "https://open.bigmodel.cn/api/monitor/usage/quota/limit", h)
            probe(name, "model_usage_dash", "https://open.bigmodel.cn/api/monitor/usage/model-usage"
                  "?startTime=%s&endTime=%s" % (d0, d1), h)
            probe(name, "model_usage_slash", "https://open.bigmodel.cn/api/monitor/usage/model/usage"
                  "?startTime=%s&endTime=%s" % (d0, d1), h)
            probe(name, "tool_usage", "https://open.bigmodel.cn/api/monitor/usage/tool-usage"
                  "?startTime=%s&endTime=%s" % (d0, d1), h)
            # 带 Bearer 的形式再试一次
            hb = {"Authorization": "Bearer " + k, "Accept-Language": "zh-CN,zh"}
            probe(name, "model_usage_bearer", "https://open.bigmodel.cn/api/monitor/usage/model-usage"
                  "?startTime=%s&endTime=%s" % (d0, d1), hb)

    print("\n原始响应已保存到:", OUTDIR)


if __name__ == "__main__":
    main()
