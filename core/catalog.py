# -*- coding: utf-8 -*-
"""模型目录：把「市面上大部分模型」变成一份可勾选的本地清单。

数据源用 OpenRouter 的公开目录（/api/v1/models，无需密钥，实测 451 个模型 / 67 家厂商，
每个都带输入、输出、缓存读、缓存写四档价格）。理由：
- 自己手维护几百条模型和价格不现实，官方一调价就过期；
- OpenRouter 的 id 天然是 `厂商/模型` 形式，正好拿来做「模型名归一化」的主键；
- 覆盖了 OpenAI / Anthropic / Google / DeepSeek / 通义 / 智谱 / Kimi / MiniMax / 腾讯 / 字节 等主流家。

价格单位：OpenRouter 给的是「美元 / token」，这里统一折成「元 / 百万 token」。
缓存 24 小时；拉不到就用旧缓存并标 stale，绝不因为断网把清单清空。
"""
import datetime
import json
import os
import threading
import urllib.error
import urllib.request

from . import paths

CATALOG_URL = "https://openrouter.ai/api/v1/models"
CACHE_HOURS = 24
_lock = threading.Lock()

# OpenRouter 的厂商前缀 → 本应用的驱动 id。没收录的落到 other（仍可展示，只是没有专用驱动）。
VENDOR_TO_DRIVER = {
    "openai": "openai", "~openai": "openai",
    "anthropic": "anthropic", "~anthropic": "anthropic",
    "google": "google", "~google": "google",
    "deepseek": "deepseek", "~deepseek": "deepseek",
    "moonshotai": "kimi", "moonshot": "kimi",
    "z-ai": "zhipu", "zhipu": "zhipu",
    "qwen": "dashscope", "alibaba": "dashscope",
    "minimax": "minimax",
    "x-ai": "xai", "xai": "xai",
    "tencent": "hunyuan",
    "bytedance-seed": "ark", "bytedance": "ark",
    "stepfun": "stepfun",
    "siliconflow": "siliconflow",
    "openrouter": "openrouter",
    "meta": "meta", "meta-llama": "meta",
    "mistralai": "mistral", "cohere": "cohere", "nvidia": "nvidia",
    "amazon": "amazon", "microsoft": "microsoft", "perplexity": "perplexity",
}

DRIVER_META = {
    "deepseek":    {"label": "DeepSeek",     "color": "#4d6bfe"},
    "kimi":        {"label": "Kimi",         "color": "#8a8f98"},
    "zhipu":       {"label": "智谱 GLM",     "color": "#3b6ef5"},
    "openai":      {"label": "OpenAI",       "color": "#10a37f"},
    "anthropic":   {"label": "Anthropic",    "color": "#d97757"},
    "google":      {"label": "Gemini",       "color": "#4285f4"},
    "xai":         {"label": "xAI",          "color": "#6b7280"},
    "dashscope":   {"label": "通义千问",     "color": "#615ced"},
    "ark":         {"label": "豆包",         "color": "#1664ff"},
    "hunyuan":     {"label": "腾讯混元",     "color": "#0052d9"},
    "qianfan":     {"label": "文心一言",     "color": "#2932e1"},
    "minimax":     {"label": "MiniMax",      "color": "#f23d5c"},
    "openrouter":  {"label": "OpenRouter",   "color": "#6467f2"},
    "siliconflow": {"label": "SiliconFlow",  "color": "#7c5cff"},
    "stepfun":     {"label": "阶跃星辰",     "color": "#3d5afe"},
    "meta":        {"label": "Meta",         "color": "#0866ff"},
    "mistral":     {"label": "Mistral",      "color": "#fa520f"},
    "cohere":      {"label": "Cohere",       "color": "#39594d"},
    "nvidia":      {"label": "NVIDIA",       "color": "#76b900"},
    "amazon":      {"label": "Amazon",       "color": "#ff9900"},
    "microsoft":   {"label": "Microsoft",    "color": "#0078d4"},
    "perplexity":  {"label": "Perplexity",   "color": "#20808d"},
    "other":       {"label": "其它国产模型", "color": "#8b8b8b"},
}

_OPENER_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_OPENER_PROXY = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": "http://127.0.0.1:7890",
                                 "https": "http://127.0.0.1:7890"}))


def driver_of(model_id):
    vendor = str(model_id or "").split("/")[0].strip().lower()
    return VENDOR_TO_DRIVER.get(vendor, "other")


def _fetch_usd_cny(default=7.1):
    try:
        from . import store
        return float(store.meta_get("usd_cny", default) or default)
    except Exception:
        return default


def _to_million(v):
    """OpenRouter 的 USD/token → USD/百万 token。0 和「缺字段」要区分开。"""
    if v is None or v == "":
        return None
    try:
        return round(float(v) * 1e6, 6)
    except Exception:
        return None


def _clean_name(raw, mid):
    s = str(raw or "").strip() or mid
    for sep in (": ", " - "):
        if sep in s:
            head, tail = s.split(sep, 1)
            if len(head) <= 24 and tail:
                return tail.strip()
    return s


def _normalize(item, rate):
    mid = str(item.get("id") or "").strip()
    if not mid or "/" not in mid:
        return None
    pricing = item.get("pricing") or {}
    usd = {
        "in": _to_million(pricing.get("prompt")),
        "out": _to_million(pricing.get("completion")),
        "cache_read": _to_million(pricing.get("input_cache_read")),
        "cache_write": _to_million(pricing.get("input_cache_write")),
    }
    cny = {k: (round(v * rate, 4) if v is not None else None) for k, v in usd.items()}
    arch = item.get("architecture") or {}
    mods = arch.get("input_modalities") or []
    return {
        "id": mid,
        "name": _clean_name(item.get("name"), mid),
        "vendor": mid.split("/")[0].lower().lstrip("~"),
        "driver": driver_of(mid),
        "context": int(item.get("context_length") or 0),
        "vision": bool(isinstance(mods, list) and "image" in mods),
        "usd": usd,
        "cny": cny,
        "created": item.get("created") or 0,
    }


def _read_cache():
    p = paths.catalog_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_cache(data):
    p = paths.catalog_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception as e:
        print("[catalog] 写入缓存失败:", e)


def _download():
    req = urllib.request.Request(CATALOG_URL, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0",
        "Accept": "application/json",
    })
    last = None
    for op in (_OPENER_DIRECT, _OPENER_PROXY):
        try:
            with op.open(req, timeout=20) as r:
                raw = r.read(6_000_000).decode("utf-8", "replace")
            return json.loads(raw).get("data") or []
        except Exception as e:
            last = e
    raise last or RuntimeError("无法连接 OpenRouter")


def _age_hours(fetched_at):
    try:
        t = datetime.datetime.fromisoformat(str(fetched_at))
        return (datetime.datetime.now() - t).total_seconds() / 3600.0
    except Exception:
        return 1e9


def refresh(force=False):
    """拉取并落盘。返回 (data, err)。err 为 None 表示本次联网成功。"""
    with _lock:
        cur = _read_cache()
        if cur and not force and _age_hours(cur.get("fetched_at")) < CACHE_HOURS:
            return cur, None
        try:
            raw = _download()
            rate = _fetch_usd_cny()
            models = [m for m in (_normalize(i, rate) for i in raw) if m]
            models.sort(key=lambda m: (m["driver"], -m["context"], m["id"]))
            data = {
                "fetched_at": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                "source": "openrouter",
                "usd_cny": rate,
                "count": len(models),
                "models": models,
            }
            _write_cache(data)
            return data, None
        except Exception as e:
            if cur:
                cur = dict(cur)
                cur["stale"] = True
                cur["error"] = str(e)[:200]
                return cur, str(e)[:200]
            return {"fetched_at": "", "source": "none", "count": 0, "models": [],
                    "stale": True, "error": str(e)[:200]}, str(e)[:200]


def load():
    """只读缓存，不触发联网（供请求路径使用，绝不让 HTTP 线程等网络）。"""
    cur = _read_cache()
    if not cur:
        return {"fetched_at": "", "source": "none", "count": 0, "models": [], "stale": True}
    out = dict(cur)
    out["stale"] = _age_hours(cur.get("fetched_at")) >= CACHE_HOURS
    return out


def summary():
    """给前端的分组概览：每家有多少模型、是否有免费模型。"""
    data = load()
    groups = {}
    for m in data.get("models") or []:
        g = groups.setdefault(m["driver"], {"driver": m["driver"], "count": 0, "free": 0})
        g["count"] += 1
        if (m.get("cny") or {}).get("in") == 0 and (m.get("cny") or {}).get("out") == 0:
            g["free"] += 1
    items = []
    for k, g in groups.items():
        meta = DRIVER_META.get(k) or DRIVER_META["other"]
        items.append({**g, "label": meta["label"], "color": meta["color"]})
    items.sort(key=lambda x: -x["count"])
    return {"fetched_at": data.get("fetched_at", ""), "stale": data.get("stale", True),
            "total": data.get("count", 0), "groups": items}
