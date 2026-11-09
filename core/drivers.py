# -*- coding: utf-8 -*-
"""提供商驱动注册表。

为什么要注册表：旧版把「平台」硬编码成三处（PLATFORM_SPEC / _FETCHERS /
PLATFORM_KIND_OF），每加一家要改三个地方，还容易漏。现在统一成一张表：
元数据（名称、颜色、能力档、登录页、凭据字段）+ 一个 fetch 函数。

能力档（capability）决定界面怎么说话，宁可如实说「只能看余额」，
也不要把 0 当成真实用量：
    detail        能给到逐日 / 逐模型的用量
    balance_only  只能查余额与累计消费，没有逐日明细
    catalog       只有模型与价格（公开目录），不能采集账户数据
"""
import json
import urllib.error
import urllib.parse
import urllib.request

DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PROXY = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": "http://127.0.0.1:7890",
                                 "https": "http://127.0.0.1:7890"}))


def _net_msg(e):
    """把底层网络异常翻译成人能看懂的一句话 —— 前端会把它直接显示出来。"""
    s = str(getattr(e, "reason", e) or e)
    low = s.lower()
    if "timed out" in low or "timeout" in low:
        return "连接超时（该地址可能无法从这里访问）"
    if "name or service not known" in low or "getaddrinfo" in low or "nodename" in low:
        return "域名解析失败，检查地址是否写对"
    if "connection refused" in low:
        return "连接被拒绝，检查地址与端口"
    if "certificate" in low or "ssl" in low or "tls" in low:
        return "TLS 握手失败（地址不对，或该站点只接受浏览器访问）"
    return s[:160]


def _get(url, headers=None, timeout=15, data=None):
    """先直连再走系统代理：国内平台直连正常，GitHub/OpenRouter 可能需要代理。"""
    hdr = {"User-Agent": "TokenWatch/2.0", "Accept": "application/json"}
    hdr.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=hdr)
    last = None
    for op in (DIRECT, PROXY):
        try:
            with op.open(req, timeout=timeout) as r:
                raw = r.read(4_000_000).decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(400).decode("utf-8", "replace")
            except Exception:
                pass
            last = RuntimeError("HTTP %s %s" % (e.code, detail[:160]))
            if e.code in (401, 403, 404):
                break                     # 鉴权/路径错，换代理也没用
        except Exception as e:
            last = RuntimeError(_net_msg(e))
    raise last or RuntimeError("请求失败")


def _num(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


def _fail(msg):
    return {"status": "error", "mode": "usage", "detail": str(msg)[:200]}


def _empty(note=""):
    return {"status": "empty", "mode": "usage", "note": note,
            "totals": {"requests": 0, "input": 0, "output": 0, "cache_read": 0,
                       "cache_write": 0, "cost": 0.0},
            "models": [], "days": {}}


# ==========================================================================
# 具体驱动
# ==========================================================================
def fetch_openrouter(cred, days):
    """OpenRouter：/api/v1/credits 给「总充值 - 总消耗」，/api/v1/key 给本次 Key 的用量。
    没有逐日明细接口（activity 需要 provisioning key），所以能力档是 balance_only。"""
    key = str(cred.get("api_key") or "").strip()
    if not key:
        return {"status": "unavailable", "mode": "usage",
                "detail": "填 API Key 后可查余额（OpenRouter 控制台 → Keys）"}
    h = {"Authorization": "Bearer " + key}
    out = {"status": "ok", "mode": "usage", "cost_only": True,
           "source": "OpenRouter /api/v1/credits",
           "checked_at": _now(), "capability": "balance_only"}
    try:
        c = (_get("https://openrouter.ai/api/v1/credits", h).get("data") or {})
        total = _num(c.get("total_credits"))
        used = _num(c.get("total_usage"))
        out["balance"] = {
            "status": "ok", "type": "money", "source": "OpenRouter credits",
            "items": [{"label": "可用余额", "total": round(total - used, 4), "currency": "USD"}],
        }
        out["totals"] = {"requests": 0, "input": 0, "output": 0, "cache_read": 0,
                         "cache_write": 0, "cost": round(used, 4)}
        out["note"] = "OpenRouter 只提供累计消耗，不提供逐日明细"
        out["models"] = []
        out["days"] = {}
        return out
    except Exception as e:
        return _fail(e)


def fetch_relay(cred, days):
    """中转站：兼容 New API / One API 的常见接口。
    /api/user/self 给额度，/api/log/self 给逐条调用记录（能拿到模型名）。
    站点没开日志接口时降级为「仅余额」，不伪造 0。"""
    base = str(cred.get("base_url") or "").strip().rstrip("/")
    key = str(cred.get("api_key") or "").strip()
    if not base:
        return {"status": "unavailable", "mode": "usage", "detail": "填中转站地址（如 https://api.example.com）"}
    if not key:
        return {"status": "unavailable", "mode": "usage", "detail": "填中转站的 API Key"}
    if not base.startswith(("http://", "https://")):
        base = "https://" + base
    h = {"Authorization": "Bearer " + key}
    out = {"status": "ok", "mode": "usage", "source": "中转站 /api/user/self",
           "checked_at": _now(), "capability": "balance_only"}

    quota_per_unit = 500000.0          # New API 默认：1 美元 = 500000 quota
    try:
        st = _get(base + "/api/status", h)
        d = st.get("data") or {}
        quota_per_unit = _num(d.get("quota_per_unit"), quota_per_unit) or quota_per_unit
        out["usd_cny"] = _num(d.get("usd_exchange_rate"), 0) or None
    except Exception:
        pass

    rate = None
    try:
        from . import store
        rate = _num(store.meta_get("usd_cny", 0), 0) or None
    except Exception:
        pass
    fx = rate or out.get("usd_cny") or 7.1

    try:
        me = _get(base + "/api/user/self", h)
        u = me.get("data") or {}
        quota = _num(u.get("quota"))
        used = _num(u.get("used_quota"))
        def cny(q):
            return round(q / quota_per_unit * fx, 4)
        out["balance"] = {
            "status": "ok", "type": "money", "source": "中转站额度",
            "items": [{"label": "可用额度", "total": cny(quota), "currency": "CNY"}],
        }
        out["totals"]["cost"] = cny(used)
        out["totals"].update({"requests": 0, "input": 0, "output": 0,
                              "cache_read": 0, "cache_write": 0})
    except Exception as e:
        return _fail(e)

    # 可用模型清单（OpenAI 兼容 /v1/models）：这是中转站唯一可靠的「我到底能用哪些模型」
    # 来源，拉不到不影响余额与用量，只是模型选择里少一份候选。
    try:
        ml = _get(base + "/v1/models", h)
        items = ml.get("data") or ml.get("models") or []
        ids = []
        for x in items if isinstance(items, list) else []:
            mid = x.get("id") if isinstance(x, dict) else x
            s = str(mid or "").strip()
            if s and s not in ids:
                ids.append(s)
        if ids:
            out["model_list"] = ids[:600]
    except Exception:
        pass

    # 逐条日志：能拿到就按天 / 按模型聚合，拿不到就如实只报累计
    try:
        import datetime
        end = datetime.datetime.now()
        start = end - datetime.timedelta(days=max(1, int(days)))
        qs = urllib.parse.urlencode({
            "p": 0, "page_size": 100, "type": 2,
            "start_timestamp": int(start.timestamp()), "end_timestamp": int(end.timestamp()),
        })
        logs = _get(base + "/api/log/self?" + qs, h)
        rows = logs.get("data") or []
        if isinstance(rows, dict):
            rows = rows.get("items") or rows.get("data") or []
        by_day, by_model = {}, {}
        for r in rows if isinstance(rows, list) else []:
            ts = r.get("created_at") or 0
            day = datetime.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d") if ts else ""
            if not day:
                continue
            cost = _num(r.get("quota")) / quota_per_unit * fx
            mname = str(r.get("model_name") or "unknown")
            pt, ct = int(_num(r.get("prompt_tokens"))), int(_num(r.get("completion_tokens")))
            rec = by_day.setdefault(day, {"cost": 0.0, "requests": 0, "input": 0, "output": 0,
                                          "cache_read": 0, "cache_write": 0})
            rec["cost"] += cost
            rec["requests"] += 1
            rec["input"] += pt
            rec["output"] += ct
            mr = by_model.setdefault(mname, {"model": mname, "cost": 0.0, "requests": 0,
                                             "input": 0, "output": 0, "cache_read": 0})
            mr["cost"] += cost
            mr["requests"] += 1
            mr["input"] += pt
            mr["output"] += ct
        if by_day:
            out["days"] = by_day
            out["models"] = list(by_model.values())
            out["totals"].update({
                "requests": sum(v["requests"] for v in by_day.values()),
                "input": sum(v["input"] for v in by_day.values()),
                "output": sum(v["output"] for v in by_day.values()),
                "cost": round(sum(v["cost"] for v in by_day.values()), 4),
            })
            out["capability"] = "detail"
            out["source"] = "中转站日志 /api/log/self"
        else:
            out["note"] = "该中转站未开放日志接口，仅显示余额与累计消费"
    except Exception:
        out["note"] = "该中转站未开放日志接口，仅显示余额与累计消费"
    return out


def fetch_siliconflow(cred, days):
    """硅基流动：/v1/user/info 给余额，没有按天明细。"""
    key = str(cred.get("api_key") or "").strip()
    if not key:
        return {"status": "unavailable", "mode": "usage", "detail": "填 API Key 后可查余额"}
    try:
        j = _get("https://api.siliconflow.cn/v1/user/info",
                 {"Authorization": "Bearer " + key})
        d = j.get("data") or {}
        bal = _num(d.get("totalBalance") or d.get("balance"))
        return {"status": "ok", "mode": "usage", "cost_only": True,
                "capability": "balance_only", "source": "SiliconFlow /v1/user/info",
                "checked_at": _now(),
                "balance": {"status": "ok", "type": "money", "source": "硅基流动余额",
                            "items": [{"label": "可用余额", "total": round(bal, 4),
                                       "currency": "CNY"}]},
                "totals": {"requests": 0, "input": 0, "output": 0, "cache_read": 0,
                           "cache_write": 0, "cost": 0.0},
                "models": [], "days": {},
                "note": "硅基流动只提供余额，不提供逐日用量"}
    except Exception as e:
        return _fail(e)


def _now():
    import datetime
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ==========================================================================
# 注册表
# ==========================================================================
# capability：detail / balance_only / catalog
# auth：凭据字段（key 与 platform_creds.json 里的字段名一致）
DRIVERS = {
    "deepseek": {
        "label": "DeepSeek", "color": "#4d6bfe", "capability": "detail",
        "login_url": "https://platform.deepseek.com/usage",
        "site": "https://platform.deepseek.com",
        "auth": [
            {"key": "token", "label": "控制台 token", "hint": "登录后 localStorage.userToken.value", "optional": False},
            {"key": "api_key", "label": "API Key（查余额）", "hint": "可留空，余额需 API Key", "optional": True},
        ],
        "note": "控制台给逐日逐模型用量；余额走公开 API /user/balance。",
        # 在官网控制台按 F12 → Console 粘贴这行，值会直接进剪贴板
        "grab": "copy(JSON.parse(localStorage.getItem('userToken')).value)",
    },
    "kimi": {
        "label": "Kimi", "color": "#8a8f98", "capability": "detail",
        "login_url": "https://platform.kimi.com/console",
        "site": "https://platform.kimi.com",
        "auth": [{"key": "refresh_token", "label": "refresh_token", "hint": "控制台登录态里的长期票据"}],
        "note": "票据只有 15 分钟有效期，会自动续期并落盘。",
        "grab": "copy(localStorage.getItem('refresh_token')||(document.cookie.match(/refresh_token=([^;]+)/)||[])[1]||'未找到')",
    },
    "zhipu": {
        "label": "智谱 GLM", "color": "#3b6ef5", "capability": "detail",
        "login_url": "https://bigmodel.cn/finance/expensebill",
        "site": "https://bigmodel.cn",
        "auth": [{"key": "jwt_token", "label": "bigmodel_token_production", "hint": "登录后的 cookie 值"}],
        "note": "用量取费用账单的实扣金额，余额取客户账户报表。",
        "grab": "copy((document.cookie.match(/bigmodel_token_production=([^;]+)/)||[])[1]||'未找到')",
    },
    "openrouter": {
        "label": "OpenRouter", "color": "#6467f2", "capability": "balance_only",
        "login_url": "https://openrouter.ai/settings/keys",
        "site": "https://openrouter.ai",
        "auth": [{"key": "api_key", "label": "API Key", "hint": "sk-or-v1-…"}],
        "note": "一个 Key 通用 451 个模型；只提供累计消耗，没有逐日明细。",
    },
    "siliconflow": {
        "label": "硅基流动", "color": "#7c5cff", "capability": "balance_only",
        "login_url": "https://cloud.siliconflow.cn/account/ak",
        "site": "https://cloud.siliconflow.cn",
        "auth": [{"key": "api_key", "label": "API Key", "hint": "sk-…"}],
        "note": "只能查余额。",
    },
    "relay": {
        "label": "中转站 / 其它", "color": "#6b7280", "capability": "detail",
        "login_url": "", "site": "",
        "auth": [
            {"key": "base_url", "label": "站点地址", "hint": "https://api.example.com"},
            {"key": "api_key", "label": "API Key", "hint": "sk-…"},
        ],
        "note": "兼容 New API / One API：能读额度，开放日志时还能按模型统计。",
    },
    # —— 以下只有模型与价格，不能采集账户数据（需要 AK/SK 或管理密钥）——
    "openai": {"label": "OpenAI", "color": "#10a37f", "capability": "catalog",
               "login_url": "https://platform.openai.com/usage", "site": "https://openai.com",
               "auth": [], "note": "官方用量需要组织管理密钥（Admin Key）。"},
    "anthropic": {"label": "Anthropic", "color": "#d97757", "capability": "catalog",
                  "login_url": "https://console.anthropic.com/usage", "site": "https://anthropic.com",
                  "auth": [], "note": "官方用量需要 Admin Key。"},
    "google": {"label": "Gemini", "color": "#4285f4", "capability": "catalog",
               "login_url": "https://aistudio.google.com/apikey", "site": "https://ai.google.dev",
               "auth": [], "note": "用量需要 GCP 账单权限。"},
    "xai": {"label": "xAI", "color": "#6b7280", "capability": "catalog",
            "login_url": "https://console.x.ai", "site": "https://x.ai",
            "auth": [], "note": "只开放模型列表。"},
    "dashscope": {"label": "通义千问", "color": "#615ced", "capability": "catalog",
                  "login_url": "https://bailian.console.aliyun.com", "site": "https://bailian.aliyun.com",
                  "auth": [], "note": "用量需要阿里云 AK/SK 签名。"},
    "ark": {"label": "豆包", "color": "#1664ff", "capability": "catalog",
            "login_url": "https://console.volcengine.com/ark", "site": "https://www.volcengine.com/product/ark",
            "auth": [], "note": "用量需要火山引擎 AK/SK。"},
    "hunyuan": {"label": "腾讯混元", "color": "#0052d9", "capability": "catalog",
                "login_url": "https://console.cloud.tencent.com/hunyuan", "site": "https://hunyuan.tencent.com",
                "auth": [], "note": "用量需要腾讯云 SecretId/Key。"},
    "qianfan": {"label": "文心一言", "color": "#2932e1", "capability": "catalog",
                "login_url": "https://console.bce.baidu.com/qianfan", "site": "https://yiyan.baidu.com",
                "auth": [], "note": "用量需要百度云 AK/SK。"},
    "minimax": {"label": "MiniMax", "color": "#f23d5c", "capability": "catalog",
                "login_url": "https://platform.minimaxi.com", "site": "https://www.minimaxi.com",
                "auth": [], "note": "没有公开的余额接口。"},
}

# kind → fetch。detail/balance_only 的驱动都在这里；catalog 档没有采集函数。
FETCHERS = {
    "openrouter": fetch_openrouter,
    "relay": fetch_relay,
    "siliconflow": fetch_siliconflow,
}


def meta(driver):
    d = DRIVERS.get(driver)
    if not d:
        return {"label": driver, "color": "#8b8b8b", "capability": "catalog",
                "auth": [], "note": ""}
    return d


def public_list():
    """给 /api/drivers：不带任何凭据，只描述每家能做什么。"""
    out = []
    for k, d in DRIVERS.items():
        out.append({
            "id": k, "label": d["label"], "color": d["color"],
            "capability": d["capability"], "login_url": d.get("login_url", ""),
            "site": d.get("site", ""), "auth": d.get("auth", []),
            "note": d.get("note", ""), "grab": d.get("grab", ""),
        })
    order = {"detail": 0, "balance_only": 1, "catalog": 2}
    out.sort(key=lambda x: (order.get(x["capability"], 3), x["label"]))
    return out
