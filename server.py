# -*- coding: utf-8 -*-
"""
TokenWatch · CC Switch 用量 / 余量 / 充值 监控台（本地服务端）
------------------------------------------------------------
- 只读 CC Switch 数据库 (~/.cc-switch/cc-switch.db)，获取全部接入的提供商配置
- 用量统计：读取 CC Switch 本地记录（proxy_request_logs + usage_daily_rollups）
- 余额查询：直连各平台官方接口（DeepSeek / Kimi·Moonshot / 智谱 GLM Coding Plan）
- API Key 仅在本机内存中使用，绝不落盘、绝不下发前端
- 绑定 127.0.0.1，仅本机可访问
仅使用 Python 标准库，无第三方依赖。
"""
import json, os, re, base64, sqlite3, socket, subprocess, sys, time, threading, datetime
import http.server, socketserver, urllib.request, urllib.error

if getattr(sys, "frozen", False):
    BASE_DIR   = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    APP_DIR    = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
    APP_DIR    = BASE_DIR
STATIC_DIR = os.path.join(BASE_DIR, "static")
CONFIG_PATH= (os.environ.get("TOKENWATCH_CONFIG")
              or os.path.join(APP_DIR, "config.json"))
DB_PATH    = os.path.expanduser("~/.cc-switch/cc-switch.db")

DEFAULT_CONFIG = {
    "port": 8733,
    "auto_open": True,
    "refresh_seconds": 300,
    "low_balance_cny": 30.0,          # 全局默认阈值：余额低于该值（元）时高亮预警
    "low_balance_by_provider": {},    # 按提供商单独设阈值：{"DeepSeek": 20, "Kimi": 50}
    "days_default": 30,
    "usd_cny": 7.10,                  # 估算用汇率
    "recharge_urls": {}               # key: 提供商名 → 充值页 URL（可覆盖）
}

# 官方充值页默认值（可被 config.json / 页面设置覆盖）
DEFAULT_RECHARGE = {
    "DeepSeek":  "https://platform.deepseek.com/top_up",
    "Kimi":      "https://platform.moonshot.cn/console/pay",
    "Zhipu GLM": "https://open.bigmodel.cn/finance/pay",
}

# 历史版本里指向首页的旧充值地址，读到后自动替换成直达充值页
LEGACY_RECHARGE = {
    "Kimi":      "https://platform.kimi.com",
    "Zhipu GLM": "https://open.bigmodel.cn",
}

config = dict(DEFAULT_CONFIG)
try:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
            config.update({k: v for k, v in user.items() if k in DEFAULT_CONFIG})
except Exception as e:
    print("[config] 读取失败(使用默认):", e)

# 迁移旧配置中的充值地址到直达充值页
_ru = config.setdefault("recharge_urls", {})
for k, old in LEGACY_RECHARGE.items():
    if _ru.get(k) == old:
        _ru[k] = DEFAULT_RECHARGE[k]
try:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            _disk = json.load(f)
        if _disk.get("recharge_urls") != _ru:
            _disk["recharge_urls"] = _ru
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(_disk, f, ensure_ascii=False, indent=2)
except Exception:
    pass


def save_config():
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("[config] 保存失败:", e)


# ---------------- 数据库只读 ----------------
def connect_db():
    uri = "file:" + DB_PATH.replace("\\", "/") + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def now_iso():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def mask_key(k):
    if not k:
        return ""
    k = str(k)
    return k[:6] + "…" + k[-4:] if len(k) > 12 else "…" + k[-4:]


def env_of(prow):
    try:
        cfg = json.loads(prow["settings_config"] or "{}")
    except Exception:
        cfg = {}
    env = cfg.get("env") or {}
    auth = cfg.get("auth") or {}
    if not isinstance(env, dict):
        env = {}
    if not isinstance(auth, dict):
        auth = {}
    return env, auth, cfg


def detect_kind(name, base_url, api_key, cfg_meta):
    """识别余额查询适配器类型"""
    host = (base_url or "").lower()
    n = (name or "").lower()
    if api_key:
        if "deepseek" in host or "deepseek" in n:
            return "deepseek"
        if "moonshot" in host or "kimi" in n or "moonshot" in n:
            return "moonshot"
        if "bigmodel" in host or "zhipu" in n or n.startswith("glm") or "glm" in n:
            return "zhipu_plan"
    return "unknown"


def provider_models(env, cfg):
    """从配置里收集模型名（含别名清洗）"""
    out, aliases = [], {}
    for k, v in env.items():
        if k.startswith("ANTHROPIC_") and k.endswith("_MODEL") and v:
            base = re.sub(r"\[.*?\]", "", str(v)).strip()
            aliases[str(v)] = base
            if base not in out:
                out.append(base)
    plain = str(env.get("ANTHROPIC_MODEL") or env.get("ANTHROPIC_DEFAULT_SONNET_MODEL") or "")
    base = re.sub(r"\[.*?\]", "", plain).strip()
    if base and base not in out:
        out.insert(0, base)
    return out, aliases


def load_providers():
    """读取并过滤提供商；排除官方 / Codex / Claude 官方相关"""
    try:
        conn = connect_db()
    except Exception as e:
        return None, f"无法打开 CC Switch 数据库: {e}"
    providers = []
    try:
        rows = conn.execute("SELECT * FROM providers ORDER BY sort_index, created_at").fetchall()
    except Exception as e:
        conn.close()
        return None, f"读取 providers 表失败: {e}"
    conn.close()
    for r in rows:
        env, auth, cfg = env_of(r)
        meta = cfg.get("meta") or {}
        # meta 若为字符串解析（表结构版本差异）
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        name = r["name"] or ""
        nid = r["id"] or ""
        nlow = name.lower()
        # ---- 过滤规则：排除官方 / Codex / Claude 官方 / OAuth 托管账号 ----
        if (r["category"] or "").lower() in ("official",):
            continue
        if r["app_type"] in ("claude-desktop", "gemini", "codex"):
            continue
        if nlow in ("codex", "default", "claude", "claude official", "claude desktop official"):
            continue
        if nid in ("claude-official", "codex-official", "default", "claude-desktop-official", "gemini-official"):
            continue
        if meta.get("authBinding") or "oauth" in str(meta.get("providerType", "")).lower():
            continue
        # 取密钥
        key = (env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY")
               or env.get("OPENAI_API_KEY") or auth.get("OPENAI_API_KEY"))
        base = (env.get("ANTHROPIC_BASE_URL") or env.get("OPENAI_BASE_URL")
                or env.get("ANTHROPIC_BASE_URL", "") or "")
        if not key:
            continue
        models, aliases = provider_models(env, cfg)
        is_current = bool(r["is_current"])
        url = (r["website_url"] or "")
        kind = detect_kind(name, base, key, meta)
        providers.append({
            "id": nid, "name": name, "category": r["category"],
            "base_url": base, "api_key_masked": mask_key(key), "_key": key,
            "api_format": meta.get("apiFormat", ""),
            "website_url": url, "is_current": is_current,
            "icon": r["icon"], "kind": kind,
            "models": models, "_aliases": aliases,
            "notes": r["notes"],
            "usage_script": (meta.get("usage_script") if isinstance(meta, dict) else None),
        })
    return providers, None


# ---------------- 用量统计（本地记录合并） ----------------
LOG_COLS = ("model", "input_tokens", "output_tokens", "cache_read_tokens",
            "cache_creation_tokens", "total_cost_usd", "status_code", "created_at")


def norm_model(m):
    if not m:
        return ""
    return re.sub(r"\[.*?\]", "", str(m)).strip()


def provider_for_model(model, provs):
    """把日志里的模型名归属到提供商（按配置模型精确匹配，再按词族前缀兜底）"""
    m = norm_model(model)
    if not m:
        return None
    # 1) 精确（含别名展开）
    for p in provs:
        for mm in p["models"]:
            if m == mm:
                return p
    # 2) 词族前缀：deepseek / kimi / glm …
    for p in provs:
        fam = re.split(r"[-_0-9.].*$", m, 1)[0].lower() if m else ""
        if not fam:
            continue
        pname = p["name"].lower()
        if fam == "deepseek" and "deepseek" in pname:
            return p
        if fam == "kimi" and ("kimi" in pname or "moonshot" in pname):
            return p
        if fam == "glm" and ("glm" in pname or "zhipu" in pname):
            return p
    # 3) 前缀包含（配置模型名是记录模型名的前缀）
    for p in provs:
        for mm in p["models"]:
            if m.startswith(mm) or mm.startswith(m):
                return p
    return None


def epoch_to_iso(ts):
    try:
        ts = float(ts)
        if ts > 1e12:  # ms
            ts = ts / 1000.0
        return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    except Exception:
        return ""


def days_ago_str(n):
    return (datetime.date.today() - datetime.timedelta(days=n)).isoformat()


def collect_usage(provs, days):
    """合并 proxy_request_logs 与 usage_daily_rollups，按提供商/模型/日期聚合"""
    start_d = days_ago_str(days)
    today0 = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    start_ts = int((today0 - datetime.timedelta(days=days)).timestamp())

    empty = {"requests": 0, "success": 0, "input": 0, "output": 0,
             "cache_read": 0, "cache_creation": 0, "cost": 0.0}
    by = {}  # key: (pid, model, date) -> dict  (pid 为归属 provider id, None 表示未归属)
    try:
        conn = connect_db()
        cur = conn.cursor()
        # 原始请求日志
        cur.execute(
            "SELECT model, input_tokens, output_tokens, cache_read_tokens, "
            "cache_creation_tokens, total_cost_usd, status_code, created_at "
            "FROM proxy_request_logs WHERE created_at >= ?", (start_ts,))
        for row in cur.fetchall():
            d = dict(row)
            date = epoch_to_iso(d.get("created_at"))
            if not date:
                continue
            p = provider_for_model(d.get("model"), provs)
            pid = p["id"] if p else "__unmatched__"
            key = (pid, d.get("model") or "", date)
            e = by.setdefault(key, dict(empty))
            e["requests"] += 1
            e["success"] += 1 if (d.get("status_code") or 0) < 400 else 0
            e["input"] += int(d.get("input_tokens") or 0)
            e["output"] += int(d.get("output_tokens") or 0)
            e["cache_read"] += int(d.get("cache_read_tokens") or 0)
            e["cache_creation"] += int(d.get("cache_creation_tokens") or 0)
            try:
                e["cost"] += float(d.get("total_cost_usd") or 0)
            except Exception:
                pass
        # 日报表（补足日志缺失的历史日期）
        cur.execute(
            "SELECT date, model, request_count, success_count, input_tokens, output_tokens, "
            "cache_read_tokens, cache_creation_tokens, total_cost_usd "
            "FROM usage_daily_rollups WHERE date >= ?", (start_d,))
        for row in cur.fetchall():
            d = dict(row)
            date = d["date"]
            if not date:
                continue
            p = provider_for_model(d.get("model"), provs)
            pid = p["id"] if p else "__unmatched__"
            m = d.get("model") or ""
            if (pid, m, date) in by:   # 避免与日志重复计数
                continue
            key = (pid, m, date)
            e = by.setdefault(key, dict(empty))
            e["requests"] += int(d.get("request_count") or 0)
            e["success"] += int(d.get("success_count") or 0)
            e["input"] += int(d.get("input_tokens") or 0)
            e["output"] += int(d.get("output_tokens") or 0)
            e["cache_read"] += int(d.get("cache_read_tokens") or 0)
            e["cache_creation"] += int(d.get("cache_creation_tokens") or 0)
            try:
                e["cost"] += float(d.get("total_cost_usd") or 0)
            except Exception:
                pass
        conn.close()
    except Exception as e:
        return {"error": str(e)}

    # 汇聚输出
    prov_map = {p["id"]: p for p in provs}
    out = {}
    unmatched = dict(empty)
    unmatched_models = {}
    unmatched_model_days = {}   # 未归属模型 × 日期，供前端「按模型」趋势图使用
    days_set = set((datetime.date.today() - datetime.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1))
    for (pid, model, date), e in by.items():
        if pid == "__unmatched__":
            mname = model or "(未知模型)"
            for k in empty:
                unmatched[k] += e[k]
            um = unmatched_models.setdefault(mname, dict(empty))
            um["model"] = mname
            for k in empty:
                um[k] += e[k]
            md = unmatched_model_days.setdefault(mname, {}).setdefault(date, dict(empty))
            for k in empty:
                md[k] += e[k]
            continue
        p = prov_map.get(pid)
        if not p:
            continue
        po = out.setdefault(pid, {"provider_id": pid, "name": p["name"], "kind": p["kind"],
                                   "models": {}, "days": {}, "model_days": {}, "totals": dict(empty)})
        po["days"].setdefault(date, dict(empty))
        po["model_days"].setdefault(model, {}).setdefault(date, dict(empty))
        mo = po["models"].setdefault(model, dict(empty))
        mo["model"] = model
        md = po["model_days"][model][date]
        for k in empty:
            if k == "cost":
                po["totals"]["cost"] += e["cost"]
                po["days"][date]["cost"] += e["cost"]
                mo["cost"] += e["cost"]
                md["cost"] += e["cost"]
            else:
                po["totals"][k] += e[k]
                po["days"][date][k] += e[k]
                mo[k] += e[k]
                md[k] += e[k]
    # 补零日期
    for pid, po in out.items():
        for dd in days_set:
            po["days"].setdefault(dd, dict(empty))
        po["days"] = {dd: po["days"][dd] for dd in sorted(po["days"])}
        for mname, mdays in po["model_days"].items():
            for dd in days_set:
                mdays.setdefault(dd, dict(empty))
            po["model_days"][mname] = {dd: mdays[dd] for dd in sorted(mdays)}
        po["models"] = sorted(po["models"].values(),
                              key=lambda x: x["cost"], reverse=True)
    # 未归属模型补齐零日期，保证趋势图时间轴完整
    for mname, mdays in unmatched_model_days.items():
        for dd in days_set:
            mdays.setdefault(dd, dict(empty))
        unmatched_model_days[mname] = {dd: mdays[dd] for dd in sorted(mdays)}
    # 汇总行
    totals = dict(empty)
    for pid, po in out.items():
        for k in empty:
            totals[k] += po["totals"][k]
    unmatched_list = sorted(unmatched_models.values(), key=lambda x: x.get("cost", 0), reverse=True)
    return {"per_provider": out, "totals": totals, "unmatched": unmatched,
            "unmatched_models": unmatched_list,
            "unmatched_model_days": unmatched_model_days, "days": days}


# ---------------- 余额查询（直连官方接口） ----------------
def http_get(url, headers, timeout=10, retries=1):
    last = None
    for i in range(retries + 1):
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                body = ""
            last = (e.code, body)
            if e.code in (401, 403) and i < retries:
                continue
            return e.code, body
        except Exception as e:
            last = (0, str(e))
            time.sleep(0.5 * (i + 1))
    return last if last else (0, "network error")


def balance_deepseek(p, timeout=12):
    root = re.match(r"^(https?://[^/]+)", p["base_url"] or "")
    host = root.group(1) if root else "https://api.deepseek.com"
    url = host + "/user/balance"
    code, body = http_get(url, {"Authorization": "Bearer " + p["_key"],
                                "Accept": "application/json"}, timeout)
    if code != 200:
        return {"status": "error", "http": code, "detail": body[:200]}
    try:
        j = json.loads(body)
    except Exception:
        return {"status": "error", "http": code, "detail": "响应非 JSON"}
    infos = j.get("balance_infos") or []
    arr = []
    for it in infos:
        arr.append({"currency": it.get("currency"),
                    "total": float(it.get("total_balance") or 0),
                    "granted": float(it.get("granted_balance") or 0),
                    "topped_up": float(it.get("topped_up_balance") or 0)})
    if not arr:
        return {"status": "error", "http": 200, "detail": "无余额信息"}
    return {"status": "ok", "type": "money", "items": arr,
            "available": bool(j.get("is_available", True)),
            "checked_at": now_iso()}


def balance_moonshot(p, timeout=12):
    root = re.match(r"^(https?://[^/]+)", p["base_url"] or "")
    host = root.group(1) if root else "https://api.moonshot.cn"
    url = host + "/v1/users/me/balance"
    code, body = http_get(url, {"Authorization": "Bearer " + p["_key"],
                                "Accept": "application/json"}, timeout)
    if code != 200:
        return {"status": "error", "http": code, "detail": body[:200]}
    try:
        j = json.loads(body)
        d = j.get("data") or j
    except Exception:
        return {"status": "error", "http": code, "detail": "响应非 JSON"}
    def num(k):
        try:
            return float(d.get(k) or 0)
        except Exception:
            return 0.0
    av = num("available_balance")
    return {"status": "ok", "type": "money",
            "currency": "CNY",
            "items": [{"currency": "CNY", "total": av,
                       "granted": num("voucher_balance"),
                       "topped_up": num("cash_balance")}],
            "available": av > 0, "checked_at": now_iso()}


def balance_zhipu(p, timeout=12):
    """智谱：优先用平台凭据里的 JWT 读账户报表（可用余额 / 累计充值 / 累计消费）——
    这是预付费按量账号唯一可信的余额源；未配置平台凭据时，退回用 CC Switch 里的 Key
    探 Coding Plan 套餐额度窗口（只对已订阅套餐的账号有效）。

    注意：这里**只**打账户报表这一个接口。资源包余量来自「费用账单」，由 pu_zhipu
    在拉用量时顺带产出（resource_pack），余额侧不再重复拉一遍账单。
    """
    cred = load_platform_creds().get("zhipu") or {}
    if str(cred.get("jwt_token") or "").strip():
        acct = zhipu_account(cred, timeout)
        if acct:
            return {"status": "ok", "type": "money",
                    "items": [{"currency": "CNY",
                               "total": round(acct["available"], 4),
                               "granted": round(acct["give"], 4),
                               "topped_up": round(acct["recharge"], 4)}],
                    "available": acct["available"] > 0,
                    "spent_yuan": round(acct["total_spend"], 4),
                    "spent_today_yuan": round(acct["today_spend"], 4),
                    "checked_at": now_iso()}

    root = re.match(r"^(https?://[^/]+)", p["base_url"] or "")
    host = root.group(1) if root else "https://open.bigmodel.cn"
    url = host + "/api/monitor/usage/quota/limit"
    headers = {"Authorization": p["_key"], "Accept-Language": "zh-CN,zh",
               "Content-Type": "application/json"}
    code, body = http_get(url, headers, timeout, retries=1)
    if code in (401, 403):  # 尝试 Bearer 形式
        code, body = http_get(url, {"Authorization": "Bearer " + p["_key"],
                                    "Accept-Language": "zh-CN,zh"}, timeout)
    if code != 200:
        return {"status": "error", "http": code, "detail": body[:200]}
    try:
        j = json.loads(body)
    except Exception:
        return {"status": "error", "http": code, "detail": "响应非 JSON"}
    if not (j.get("success") or j.get("code") in (200, 0)):
        msg = str(j.get("msg") or j.get("message") or body)
        detail = msg[:200]
        if "coding plan" in msg.lower() or "codingplan" in msg.lower():
            detail = ("该账号未订阅 GLM Coding Plan（预付费按量模式）。"
                      "在上方「平台凭据」里填入 bigmodel.cn 的登录票据 JWT，即可直接读到官网账户余额。")
        return {"status": "error", "http": code, "detail": detail}
    data = j.get("data") or {}
    limits = data.get("limits") or []
    windows = []
    for it in limits:
        if not isinstance(it, dict):
            continue
        typ = str(it.get("type") or it.get("name") or "").lower()
        pct = it.get("percentage", it.get("percent"))
        w = {"type": typ,
             "used_pct": round(float(pct), 1) if pct is not None else None,
             "reset_at": it.get("nextResetTime") or it.get("next_reset_time") or None,
             "fields": dict(it)}
        # fields 里去掉已结构化字段，避免重复
        for dup in ("type", "name", "percentage", "percent", "nextResetTime", "next_reset_time"):
            w["fields"].pop(dup, None)
        if w["used_pct"] is not None or w["fields"]:
            windows.append(w)
    return {"status": "ok", "type": "quota_percent",
            "plan": data.get("level") or "",
            "windows": windows,
            "checked_at": now_iso()}


def query_balance(prov):
    try:
        if prov["kind"] == "deepseek":
            return balance_deepseek(prov)
        if prov["kind"] == "moonshot":
            return balance_moonshot(prov)
        if prov["kind"] == "zhipu_plan":
            return balance_zhipu(prov)
        return {"status": "error", "type": "unknown", "detail": "该平台暂未内置余额接口"}
    except Exception as e:
        return {"status": "error", "detail": str(e)[:200]}


BAL_CACHE = {"t": 0, "data": None}
BAL_LOCK = threading.Lock()
BAL_TTL = 45

# 提供商签名：一旦 CC Switch 里新增/删除/改名，就强制重查余额
PROV_SIG = {"sig": None}


def provider_signature(provs):
    try:
        return "|".join(sorted(
            f"{p['id']}::{p['name']}::{p['base_url']}::{','.join(p.get('models') or [])}"
            for p in provs
        ))
    except Exception:
        return None


def provider_changed(provs):
    sig = provider_signature(provs)
    if sig is None:
        return False
    changed = PROV_SIG["sig"] is not None and sig != PROV_SIG["sig"]
    PROV_SIG["sig"] = sig
    return changed


def balances_all(providers, force=False):
    global BAL_CACHE
    with BAL_LOCK:
        if not force and BAL_CACHE["data"] and time.time() - BAL_CACHE["t"] < BAL_TTL:
            return BAL_CACHE["data"]
    results = {}
    threads = []
    lock = threading.Lock()
    def work(p):
        r = query_balance(p)
        with lock:
            results[p["id"]] = r
    for p in providers:
        t = threading.Thread(target=work, args=(p,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=20)
    with BAL_LOCK:
        BAL_CACHE = {"t": time.time(), "data": results}
    return results


# ---------------- 折算工具 ----------------
def price_lookup():
    try:
        conn = connect_db()
        rows = conn.execute("SELECT model_id, input_cost_per_million, output_cost_per_million "
                            "FROM model_pricing").fetchall()
        conn.close()
        return {r["model_id"]: (float(r["input_cost_per_million"] or 0),
                                float(r["output_cost_per_million"] or 0)) for r in rows}
    except Exception:
        return {}


def estimate_tokens(provider, prov_usage, price_map):
    """用近 N 天实际用量混合单价折算剩余金额≈可用 token"""
    t = prov_usage.get("totals") or {}
    total_tok = t.get("input", 0) + t.get("output", 0) + t.get("cache_read", 0) + t.get("cache_creation", 0)
    cost = t.get("cost", 0) or 0
    if total_tok > 0 and cost > 0:
        blended = cost / total_tok * 1e6
        source = "实际用量"
    else:  # 无本地记录：按配置模型的官方标价平均
        prices = [price_map.get(m) for m in provider["models"] if m in price_map]
        if prices:
            blended = sum((a + b) / 2 for a, b in prices) / len(prices)
        else:
            blended = 1.0
        source = "模型标价"
    return blended, source


# ---------------- 平台侧用量（浏览器登录凭据） ----------------
# 这些是各平台「网页控制台」自用的内部接口，不属于公开 API，字段可能随平台改版变动，
# 所以解析全部走防御式：取不到就给默认值，绝不抛异常。
#   · DeepSeek  GET  platform.deepseek.com/api/v0/usage/{amount,cost}?month=&year=
#                    凭据 = 网页登录 Token（localStorage.userToken 的 JSON 包装串里取 .value）
#   · Kimi      GET  platform.kimi.com/api?endpoint=<name>&…
#                    endpoint=refreshToken（头 Msh-Authorization: rtoken）自动续期；
#                    endpoint=consumes / organizationAccountInfo / organizationDailyBills 取用量
#                    凭据 = rtoken（长效）+ 组织 ID；access token 到期前自动刷新并落盘
#   · 智谱 GLM   GET  bigmodel.cn/api/finance/expenseBill/expenseBillList?billingMonth=&pageNum=&pageSize=
#                    费用账单（按模型/按天/含输入输出拆分），是预付费余额账号唯一能拿到用量的接口；
#                    GET  bigmodel.cn/api/biz/account/query-customer-account-report  账户余额/累计充值/累计消费
#                    凭据 = 登录票据 JWT（裸 Authorization 头，无需 Bearer；控制台会话票据，约 7 天）
#     ※ 同域的 /monitor/usage/quota/limit 只有「已订阅 GLM Coding Plan」的账号才有数据，
#       预付费按量账号会返回 {"code":500,"msg":"当前用户不存在coding plan"}，故不再作为主口径。
#     ※ 接口路径不带 /api 前缀地写在前端 bundle 的 url: 字面量里，运行时由 baseURL=/api 拼上。
# 注意：www.kimi.com 会按 TLS 指纹拒绝 Python/OpenSSL 握手（platform.kimi.com 正常），
#       故 http_json 在握手失败时会自动换系统 curl 重试。
# 凭据只写入本机 platform_creds.json（尽量 600），不下发前端、不上传。

PLATFORM_CREDS_PATH = (os.environ.get("TOKENWATCH_PLATFORM_CREDS")
                       or os.path.join(os.path.dirname(CONFIG_PATH), "platform_creds.json"))

UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")

PLATFORM_SPEC = {
    "deepseek": {
        "label": "DeepSeek",
        "mode": "usage",          # usage = 有按模型/按天明细
        "fields": [{"key": "token", "label": "网页登录 Token",
                    "hint": "platform.deepseek.com 控制台 F12 → Console 执行 JSON.parse(localStorage.userToken).value"}],
        "howto": [
            "浏览器登录 platform.deepseek.com（注意：这不是 API Key，是网页登录凭据）",
            "按 F12 打开开发者工具，切到 Console 面板",
            "执行 JSON.parse(localStorage.userToken).value 并回车",
            "复制输出的整串字符，粘贴到上面",
        ],
    },
    "kimi": {
        "label": "Kimi",
        "mode": "usage",
        "cost_only": True,        # 官网只给金额，不给 token / 请求数
        "fields": [
            {"key": "refresh_token", "label": "Kimi rtoken（长效，自动续期）",
             "hint": "platform.kimi.com 控制台 F12 → Console 执行 localStorage.rtoken"},
            {"key": "organization", "label": "组织 ID",
             "hint": "F12 → Console 执行 localStorage.currentOrganizationId（形如 org-…）"},
        ],
        "howto": [
            "浏览器登录 platform.kimi.com（Kimi 开放平台控制台）",
            "按 F12 打开开发者工具，切到 Console 面板",
            "执行 localStorage.rtoken 并回车，复制输出的整串（形如 eyJhbGciOi…，不要连引号）",
            "再执行 localStorage.currentOrganizationId，复制 org-… 那一串",
            "填好后点「测试」：能读到余额与消费明细即接通；access token 会由 rtoken 自动续期",
        ],
    },
    "zhipu": {
        "label": "智谱 GLM",
        "mode": "usage",          # 费用账单可给按模型/按天明细（含输入输出拆分）
        "fields": [
            {"key": "jwt_token", "label": "登录票据 JWT",
             "hint": "bigmodel.cn 控制台 F12 → Console 执行 localStorage.getItem('bigmodel_token_production') 或复制 Cookie 里 bigmodel_token_production 的值"},
        ],
        "howto": [
            "浏览器登录 bigmodel.cn（智谱开放平台控制台）",
            "按 F12 打开开发者工具，切到 Console 面板",
            "执行 localStorage.getItem('bigmodel_token_production')，或到 Application → Cookies 里找 bigmodel_token_production",
            "复制那串 eyJhbGciOi… 粘到上面（不用加 Bearer 前缀）",
            "该票据约 7 天有效；过期后界面会提示重新获取。预付费账号靠它读「费用账单」拿到用量",
        ],
    },
}

# CC Switch 的 provider kind → 平台凭据 kind
PLATFORM_KIND_OF = {"deepseek": "deepseek", "moonshot": "kimi", "zhipu_plan": "zhipu"}

_PLATFORM_CREDS = {"data": None}


def load_platform_creds():
    if _PLATFORM_CREDS["data"] is not None:
        return _PLATFORM_CREDS["data"]
    d = {}
    try:
        if os.path.exists(PLATFORM_CREDS_PATH):
            with open(PLATFORM_CREDS_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                for k, v in raw.items():
                    if k in PLATFORM_SPEC and isinstance(v, dict):
                        d[k] = {kk: str(vv) for kk, vv in v.items()
                                if isinstance(vv, (str, int, float))}
    except Exception as e:
        print("[platform_creds] 读取失败:", e)
    _PLATFORM_CREDS["data"] = d
    return d


def save_platform_creds(d):
    _PLATFORM_CREDS["data"] = d
    try:
        with open(PLATFORM_CREDS_PATH, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        try:
            os.chmod(PLATFORM_CREDS_PATH, 0o600)
        except Exception:
            pass
    except Exception as e:
        print("[platform_creds] 保存失败:", e)
        return False
    return True


_PLATFORM_CREDS_LOCK = threading.Lock()


def update_platform_creds(kind, updates):
    """把轮换后的凭据（如 Kimi 刷新出的新 token）写回本机文件并同步内存缓存。"""
    if not updates:
        return False
    with _PLATFORM_CREDS_LOCK:
        cur = load_platform_creds()
        d = dict(cur.get(kind) or {})
        for k, v in updates.items():
            if v is not None and str(v).strip():
                d[k] = str(v).strip()
        d["captured_at"] = now_iso()          # 票据换新 → 估算期限重新起算
        cur[kind] = d
        _PLATFORM_CREDS["data"] = cur
        return save_platform_creds(cur)


# ---------------- 凭据 / 票据有效期 ----------------
# 「票据」＝网页登录态凭据。能不能自动判断期限取决于它是不是 JWT 且带 exp：
#   Kimi  refresh_token  是 JWT，带 exp → 精确到期时间
#   智谱  jwt_token      是 JWT，但**没有 exp**（网页会话票据）→ 按经验有效期估算
#   DeepSeek token       不是 JWT（localStorage 里的不透明串）→ 视为长期有效
CRED_EST_DAYS = {"zhipu": 7}
SOON_DAYS = 7          # 剩余天数 ≤ 该值即视为「即将过期」，需要提醒


def jwt_claims(tok):
    """解出 JWT payload（不验签，只读 exp / 账号标识）。非 JWT 返回 None。"""
    try:
        parts = str(tok or "").split(".")
        if len(parts) < 2:
            return None
        s = parts[1].strip()
        raw = base64.urlsafe_b64decode((s + "=" * (-len(s) % 4)).encode("ascii"))
        j = json.loads(raw.decode("utf-8"))
        return j if isinstance(j, dict) else None
    except Exception:
        return None


def _ts_iso(ts):
    try:
        return datetime.datetime.fromtimestamp(float(ts)).astimezone().isoformat(timespec="seconds")
    except Exception:
        return None


def _days_until(iso_s):
    try:
        dt = datetime.datetime.fromisoformat(iso_s)
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return int((dt - datetime.datetime.now().astimezone()).total_seconds() // 86400)
    except Exception:
        return None


def _cred_captured_at(cred):
    """凭据采集时间：先看保存时记下的 captured_at，缺省退回凭据文件 mtime。"""
    v = str((cred or {}).get("captured_at") or "").strip()
    if v:
        return v
    try:
        return datetime.datetime.fromtimestamp(
            os.path.getmtime(PLATFORM_CREDS_PATH)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _level_of(days):
    if days is None:
        return "unknown"
    if days < 0:
        return "expired"
    if days <= 2:
        return "urgent"
    if days <= SOON_DAYS:
        return "soon"
    return "ok"


def cred_expiry(kind, cred):
    """票据期限 → {at, days, level, source, estimated?} ／ 无期限信息时给 long_lived。"""
    c = cred or {}
    claims_seen = False
    for fk in ("refresh_token", "jwt_token", "token"):     # 长效的放前面
        claims = jwt_claims(c.get(fk))
        if not claims:
            continue
        claims_seen = True
        if claims.get("exp"):
            at = _ts_iso(claims["exp"])
            d = _days_until(at)
            return {"at": at, "days": d, "level": _level_of(d),
                    "source": "JWT 声明（%s.exp）" % fk}
    cap = _cred_captured_at(c)
    est = CRED_EST_DAYS.get(kind)
    if est and cap:
        try:
            at = (datetime.datetime.fromisoformat(cap)
                  + datetime.timedelta(days=est)).isoformat(timespec="seconds")
            d = _days_until(at)
            return {"at": at, "days": d, "level": _level_of(d), "estimated": True,
                    "source": "票据无 exp 声明，按 %d 天经验有效期估算（采集于 %s）" % (est, cap[:10])}
        except Exception:
            pass
    return {"at": None, "days": None, "level": "long",
            "source": "票据无 exp 声明" if claims_seen else "非 JWT 长效凭据，官方未声明有效期",
            "long_lived": not claims_seen}


def creds_meta():
    """下发前端的凭据元信息：只给「是否已配置 + 掩码 + 票据期限」，绝不给原文"""
    d = load_platform_creds()
    out = {}
    for k, spec in PLATFORM_SPEC.items():
        c = d.get(k) or {}
        fields = {}
        filled_all = True
        for f in spec["fields"]:
            v = str(c.get(f["key"]) or "").strip()
            if v:
                fields[f["key"]] = mask_key(v)
            else:
                filled_all = False
        out[k] = {"label": spec["label"], "mode": spec["mode"],
                  "configured": filled_all, "masked": fields}
        if any(str(c.get(f["key"]) or "").strip() for f in spec["fields"]):
            out[k]["expiry"] = cred_expiry(k, c)
    return out


# ---- HTTP 层：urllib 优先，TLS 被拒时自动回退系统 curl ----
def _find_curl():
    import shutil
    for cmd in ("curl", "curl.exe"):
        try:
            w = shutil.which(cmd)
            if w:
                return w
        except Exception:
            pass
    for p in (r"C:\Windows\System32\curl.exe", "/usr/bin/curl"):
        if os.path.exists(p):
            return p
    return None


CURL_BIN = _find_curl()


def http_post(url, headers, body, timeout=15):
    data = (body or "").encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=dict(headers or {}), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return 0, str(e)


def http_curl(url, method="GET", headers=None, body=None, timeout=15):
    """走系统 curl（Schannel 栈）。kimi.com 会重置 OpenSSL 握手，只能用它。"""
    if not CURL_BIN:
        return 0, "系统 curl 不可用"
    cmd = [CURL_BIN, "-sS", "--noproxy", "*", "-m", str(int(timeout)), "-X", method,
           "-w", "\n__HTTP_CODE__%{http_code}"]
    for k, v in (headers or {}).items():
        cmd += ["-H", "%s: %s" % (k, v)]
    if body is not None:
        cmd += ["--data-binary", body]
    cmd.append(url)
    try:
        pr = subprocess.run(cmd, capture_output=True, timeout=timeout + 6)
    except Exception as e:
        return 0, "curl 执行失败: %s" % e
    out = pr.stdout.decode("utf-8", "replace")
    code = 0
    m = re.search(r"\n__HTTP_CODE__(\d{3})\s*$", out)
    if m:
        code = int(m.group(1))
        out = out[:m.start()]
    if not out.strip() and pr.stderr:
        out = pr.stderr.decode("utf-8", "replace")
    return code, out


def http_json(url, method="GET", headers=None, body=None, timeout=15):
    """返回 (http_code, parsed_json|None)。TLS 被拒时自动换 curl 重试。"""
    if method == "GET":
        code, text = http_get(url, dict(headers or {}), timeout)
    else:
        code, text = http_post(url, dict(headers or {}), body or "", timeout)
    if code == 0 or "SSL" in str(text) or "UNEXPECTED_EOF" in str(text):
        c2, t2 = http_curl(url, method, headers, body, timeout)
        if c2:
            code, text = c2, t2
    try:
        return code, json.loads(text)
    except Exception:
        return code, None


# ---- DeepSeek：/api/v0/usage/{amount,cost} ----
_DS_TYPE_MAP = {
    "PROMPT_CACHE_HIT_TOKEN": "cache_read",
    "PROMPT_CACHE_MISS_TOKEN": "input",
    "PROMPT_TOKEN": "_prompt_total",
    "RESPONSE_TOKEN": "output",
    "REQUEST": "requests",
}


def _ds_walk(node, ctx, acc, mode="tokens"):
    """递归收集 {model, usage:[{type, amount}]}，兼容按模型 / 按天两种嵌套层级。"""
    if isinstance(node, dict):
        nctx = dict(ctx)
        for mk in ("model", "model_name", "modelName", "model_id"):
            v = node.get(mk)
            if isinstance(v, str) and v.strip():
                nctx["model"] = v.strip()
                break
        for dk in ("date", "day", "time"):
            v = node.get(dk)
            if isinstance(v, str) and len(v) >= 8:
                nctx["date"] = v[:10]
                break
            if isinstance(v, (int, float)) and v > 1e9:
                nctx["date"] = epoch_to_iso(v)
                break
        key = (nctx.get("model") or "(未知)", nctx.get("date"))
        usage = node.get("usage") or node.get("usages")
        if isinstance(usage, list) and usage and isinstance(usage[0], dict):
            for it in usage:
                if not isinstance(it, dict):
                    continue
                try:
                    amt = float(it.get("amount", it.get("value", it.get("count"))))
                except Exception:
                    continue
                if mode == "cost":
                    b = acc.setdefault(key, {})
                    b["cost"] = b.get("cost", 0.0) + amt
                else:
                    t = str(it.get("type") or it.get("name") or it.get("key") or "").upper()
                    k2 = _DS_TYPE_MAP.get(t)
                    if not k2:
                        continue
                    b = acc.setdefault(key, {})
                    b[k2] = b.get(k2, 0.0) + amt
        for v in node.values():
            if isinstance(v, (dict, list)):
                _ds_walk(v, nctx, acc, mode)
    elif isinstance(node, list):
        for v in node:
            _ds_walk(v, ctx, acc, mode)


def _usd_cny():
    """config 里的美元→人民币汇率（默认 7.1）"""
    try:
        return float(config.get("usd_cny") or 7.1) or 7.1
    except Exception:
        return 7.1


def _to_usd(shape, currency="CNY"):
    """官网金额是人民币，而前端整条链路（趋势图 / 总览带 / 模型表 / 用量条）都是美元口径，
    这里统一折算，并把原始人民币金额留在 totals.cost_native 供界面标注。"""
    rate = _usd_cny()
    if currency != "CNY" or rate <= 0:
        return shape

    def conv(rec):
        if isinstance(rec, dict) and rec.get("cost") is not None:
            try:
                rec["cost"] = round(float(rec["cost"]) / rate, 6)
            except Exception:
                pass

    for rec in (shape.get("days") or {}).values():
        conv(rec)
    for mdays in (shape.get("model_days") or {}).values():
        for rec in (mdays or {}).values():
            conv(rec)
    for m in shape.get("models") or []:
        conv(m)
    tot = shape.get("totals") or {}
    try:
        native = float(tot.get("cost") or 0)
    except Exception:
        native = 0.0
    conv(tot)
    if isinstance(tot, dict):
        tot["cost_native"] = round(native, 6)
    shape["currency"] = currency
    shape["fx"] = rate
    return shape


def pu_deepseek(cred, days):
    token = str((cred or {}).get("token") or "").strip()
    if not token:
        return {"status": "nokey", "detail": "未配置网页登录 Token"}
    hdr = {"Authorization": "Bearer " + token, "User-Agent": UA_BROWSER,
           "x-app-version": "1.0.0", "Accept": "application/json"}
    months, today = set(), datetime.date.today()
    for i in range(days + 1):
        d = today - datetime.timedelta(days=i)
        months.add((d.year, d.month))
    tok_acc, cost_acc, last_err, got_data = {}, {}, None, False
    for (y, m) in sorted(months):
        for path, acc, mode in (("amount", tok_acc, "tokens"), ("cost", cost_acc, "cost")):
            url = "https://platform.deepseek.com/api/v0/usage/%s?month=%d&year=%d" % (path, m, y)
            code, j = http_json(url, "GET", hdr, None, 20)
            if j is None:
                last_err = "HTTP %s 响应无法解析" % code
                continue
            pcode = j.get("code")
            if pcode not in (0, 200, None) or (j.get("data") is None and j.get("biz_data") is None):
                msg = str(j.get("msg") or j.get("message") or "").strip()
                low = msg.lower()
                if code in (401, 403) or "token" in low or "登录" in msg or "auth" in low:
                    return {"status": "expired",
                            "detail": "网页登录凭据无效或已过期，请重新获取（%s）" % (msg or ("HTTP %s" % code))}
                last_err = msg or ("HTTP %s" % code)
                continue
            got_data = True
            _ds_walk(j.get("data") if j.get("data") is not None else j.get("biz_data"), {}, acc, mode)
    if not got_data and not tok_acc and not cost_acc:
        return {"status": "error", "detail": last_err or "平台未返回数据"}
    shape = _build_platform_shape(tok_acc, cost_acc, days)
    if not shape:
        return {"status": "empty", "detail": last_err or "该时间区间内平台侧没有用量记录"}
    return {"status": "ok", "mode": "usage", "checked_at": now_iso(),
            "source": "官网用量接口（by month）", **_to_usd(shape, "CNY")}


def _build_platform_shape(tok_acc, cost_acc, days):
    empty = {"requests": 0, "success": 0, "input": 0, "output": 0,
             "cache_read": 0, "cache_creation": 0, "cost": 0.0}
    days_set = set((datetime.date.today() - datetime.timedelta(days=i)).isoformat()
                   for i in range(days - 1, -1, -1))
    models, by_day, model_days = {}, {}, {}
    for key in set(tok_acc) | set(cost_acc):
        model, date = key
        if not date:
            continue
        if date not in days_set:      # DeepSeek 按月返回，会带上整月/未来日期，裁到请求窗口
            continue
        t = tok_acc.get(key, {})
        c = cost_acc.get(key, {})
        rec = dict(empty)
        cin = int(t.get("input", 0) or 0)
        cr = int(t.get("cache_read", 0) or 0)
        if not cin and not cr and t.get("_prompt_total"):
            cin = int(t["_prompt_total"])
        rec["input"] = cin
        rec["cache_read"] = cr
        rec["output"] = int(t.get("output", 0) or 0)
        rec["requests"] = int(t.get("requests", 0) or 0)
        rec["success"] = rec["requests"]
        rec["cost"] = round(float(c.get("cost", 0) or 0), 6)
        m = models.setdefault(model, dict(empty))
        m["model"] = model
        for k in empty:
            m[k] += rec[k] if k != "cost" else rec["cost"]
        d = by_day.setdefault(date, dict(empty))
        for k in empty:
            d[k] += rec[k] if k != "cost" else rec["cost"]
        md = model_days.setdefault(model, {}).setdefault(date, dict(empty))
        for k in empty:
            md[k] += rec[k] if k != "cost" else rec["cost"]
    if not models:
        return None
    for dd in days_set:
        by_day.setdefault(dd, dict(empty))
    by_day = {k: by_day[k] for k in sorted(by_day)}
    for mn, mdays in model_days.items():
        for dd in days_set:
            mdays.setdefault(dd, dict(empty))
        model_days[mn] = {k: mdays[k] for k in sorted(mdays)}
    # 官网会把「本月无用量」的模型也列出来（全 0），过滤掉免得明细表出现一堆 0 行
    def _has_usage(m):
        return (float(m.get("cost") or 0) > 0 or int(m.get("requests") or 0) > 0
                or int(m.get("input") or 0) > 0 or int(m.get("output") or 0) > 0
                or int(m.get("cache_read") or 0) > 0 or int(m.get("cache_creation") or 0) > 0)

    for mn in [k for k, v in models.items() if not _has_usage(v)]:
        models.pop(mn, None)
        model_days.pop(mn, None)
    model_list = sorted(models.values(), key=lambda x: x.get("cost", 0), reverse=True)
    if not model_list:
        return None
    totals = dict(empty)
    for m in model_list:
        for k in empty:
            totals[k] += m[k] if k != "cost" else m["cost"]
    totals["success"] = totals["requests"]
    return {"models": model_list, "days": by_day, "model_days": model_days,
            "totals": totals, "days_list": sorted(days_set)}


# ---- Kimi：platform.kimi.com 控制台 API（endpoint 风格；access token 由 rtoken 自动续期） ----
#   GET /api?endpoint=refreshToken              头 Msh-Authorization: <rtoken> → 新 access/refresh token
#   GET /api?endpoint=organizationAccountInfo   余额 / 累计充值 / 累计消费
#   GET /api?endpoint=consumes&…&date_type=daily  逐日逐模型消费明细（权威账本）
# 金额单位：1e-5 元。已实测校准：consumes 合计 == accountInfo.use，日账单 == 当日 consumes。
KIMI_API = "https://platform.kimi.com/api"
KIMI_FEE_UNIT = 100000.0
KIMI_REFRESH_AHEAD = 300      # access token 剩余寿命低于该秒数就提前续期


def _kimi_headers(token=None, ms_auth=None):
    h = {"User-Agent": UA_BROWSER, "Accept": "application/json",
         "Origin": "https://platform.kimi.com",
         "Referer": "https://platform.kimi.com/console/account"}
    if token:
        h["Authorization"] = "Bearer " + token
    if ms_auth:
        h["Msh-Authorization"] = ms_auth
    return h


def _kimi_get(endpoint, params=None, token=None, ms_auth=None, timeout=20):
    q = {"endpoint": endpoint}
    q.update(params or {})
    url = KIMI_API + "?" + urllib.parse.urlencode(q)
    return http_json(url, "GET", _kimi_headers(token, ms_auth), None, timeout)


def _jwt_exp(t):
    """取出 JWT 的 exp（秒）；失败返回 0"""
    try:
        import base64
        p = str(t).split(".")[1]
        p += "=" * (-len(p) % 4)
        return float(json.loads(base64.urlsafe_b64decode(p)).get("exp") or 0)
    except Exception:
        return 0.0


def kimi_refresh(cred):
    """用长效 rtoken 换新的 access/refresh token；成功返回 (access, refresh)，否则 None"""
    rtok = str((cred or {}).get("refresh_token") or "").strip()
    if not rtok:
        return None
    code, j = _kimi_get("refreshToken", ms_auth=rtok)
    if not isinstance(j, dict) or int(j.get("code") or 0) != 0:
        return None
    d = j.get("data") or {}
    at = str(d.get("access_token") or "").strip()
    if not at:
        return None
    return at, (str(d.get("refresh_token") or "").strip() or rtok)


def pu_kimi(cred, days):
    c = cred or {}
    at = str(c.get("token") or "").strip()
    rtok = str(c.get("refresh_token") or "").strip()
    org = str(c.get("organization") or "").strip()
    if not rtok and not at:
        return {"status": "nokey", "detail": "未配置 Kimi 网页凭据（rtoken）"}

    # 1) access token 缺失或即将过期 → 用 rtoken 续期，并把轮换后的凭据写回本机
    refreshed = False
    if rtok and (not at or _jwt_exp(at) - time.time() < KIMI_REFRESH_AHEAD):
        got = kimi_refresh(c)
        if got:
            at, new_rt = got
            c["token"], c["refresh_token"] = at, new_rt
            update_platform_creds("kimi", {"token": at, "refresh_token": new_rt})
            refreshed = True
    if not at:
        return {"status": "expired",
                "detail": "Kimi rtoken 已失效，请在「平台凭据」里重新采集"}

    # 2) 组织 ID 缺失时用 userInfo 兜底
    if not org:
        _code, uj = _kimi_get("userInfo", token=at)
        try:
            orgs = (uj.get("data") or {}).get("organizations") or []
            if orgs:
                org = str((orgs[0].get("organization") or {}).get("id") or "")
        except Exception:
            org = ""

    end_ms = int(time.time() * 1000)
    start_ms = int((time.time() - (days + 1) * 86400) * 1000)
    params = {"start": start_ms, "end": end_ms, "date_type": "daily", "oid": org}

    # 3) 消费明细（权威账本，合计 == 账户累计消费）
    code, j = _kimi_get("consumes", params, token=at)
    if not isinstance(j, dict):
        if code in (401, 403):
            return {"status": "expired", "detail": "Kimi 凭据已失效（HTTP %s）" % code}
        return {"status": "error", "detail": "Kimi 接口无响应（HTTP %s）" % code}
    if int(j.get("code") or 0) != 0:
        msg = str(j.get("message") or j.get("msg") or "")
        low = (msg or "").lower()
        if code in (401, 403) or "unauthent" in low or "token" in low:
            return {"status": "expired", "detail": "Kimi 凭据已失效，请重新采集（%s）" % (msg or code)}
        return {"status": "error", "detail": "Kimi 返回异常：%s" % (msg or code)}

    rows = j.get("data")
    if isinstance(rows, dict):
        rows = rows.get("records") or rows.get("list") or []
    rows = rows or []

    empty = {"requests": 0, "success": 0, "input": 0, "output": 0,
             "cache_read": 0, "cache_creation": 0, "cost": 0.0}
    days_set = set((datetime.date.today() - datetime.timedelta(days=i)).isoformat()
                   for i in range(days - 1, -1, -1))
    models, by_day, model_days = {}, {}, {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        d = str(r.get("date") or "")[:10]
        if not d or d not in days_set:
            continue
        try:
            cost = float(r.get("amount") or 0) / KIMI_FEE_UNIT
        except Exception:
            continue
        if cost <= 0:
            continue
        name = str(r.get("product_model_id") or r.get("product_name") or "Kimi").strip()
        by_day.setdefault(d, dict(empty))["cost"] += cost
        model_days.setdefault(name, {}).setdefault(d, dict(empty))["cost"] += cost
        models.setdefault(name, dict(empty, model=name))["cost"] += cost

    if not models:
        return {"status": "empty", "detail": "该时间区间内官网没有消费记录"}

    for dd in days_set:
        by_day.setdefault(dd, dict(empty))
    by_day = {k: by_day[k] for k in sorted(by_day)}
    for mn, mdays in model_days.items():
        for dd in days_set:
            mdays.setdefault(dd, dict(empty))
        model_days[mn] = {k: mdays[k] for k in sorted(mdays)}
    for m in models.values():
        m["cost"] = round(m["cost"], 6)
    for rec in list(by_day.values()) + [x for md in model_days.values() for x in md.values()]:
        rec["cost"] = round(rec["cost"], 6)
    model_list = sorted(models.values(), key=lambda x: x.get("cost", 0), reverse=True)
    totals = dict(empty)
    for m in model_list:
        totals["cost"] += m["cost"]
    totals["cost"] = round(totals["cost"], 6)

    shape = _to_usd({"models": model_list, "days": by_day, "model_days": model_days,
                     "totals": totals, "days_list": sorted(days_set)}, "CNY")
    return {"status": "ok", "mode": "usage", "cost_only": True,
            "checked_at": now_iso(), "refreshed": refreshed, "org": org,
            "source": "官网消费明细（consumes）", **shape}


# ---- 智谱 GLM ----
# 预付费按量账号拿用量的唯一入口是控制台「费用账单」：
#   /api/finance/expenseBill/expenseBillList?billingMonth=YYYY-MM&pageNum=1&pageSize=N
# 每行 = 一条计费记录，带 billingDate / modelCode / tokenType(输入|输出) /
# usageCount+usageUnit(token) / costPrice(元/千token) / settlementAmount / deductAfter。
# 「Tokens包」这类资源包购买行的 usageUnit 是「个」，不是推理用量，必须剔除。
ZHIPU_API = "https://bigmodel.cn/api"
ZH_TOKEN_KIND = (("输出", "output"), ("output", "output"),
                 ("缓存写入", "cache_creation"), ("cache_creation", "cache_creation"),
                 ("缓存", "cache_read"), ("cache", "cache_read"))


def _num(v, default=0.0):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except Exception:
        return default


def _zh_hdr(cred):
    """裸 JWT 即可（实测带上 Bearer 也能过），org/project 可选。"""
    c = cred or {}
    h = {"Authorization": str(c.get("jwt_token") or "").strip(),
         "User-Agent": UA_BROWSER, "Accept": "application/json, text/plain, */*",
         "Content-Type": "application/json",
         "Origin": "https://bigmodel.cn", "Referer": "https://bigmodel.cn/"}
    org = str(c.get("organization") or "").strip()
    proj = str(c.get("project") or "").strip()
    if org:
        h["Bigmodel-Organization"] = org
    if proj:
        h["Bigmodel-Project"] = proj
    return h


def _zh_token_kind(token_type):
    s = str(token_type or "").strip()
    low = s.lower()
    for needle, kind in ZH_TOKEN_KIND:
        if needle in s or needle in low:
            return kind
    return "input"          # 未标注的一律算输入侧，保证「输入+输出」总量不丢


def _zh_row_cost(r):
    """官方金额字段；体验包全额抵扣时它们全是 0，退回按 单价×用量 算计价金额，
    否则「免费额度用量」在图上会恒等于 0，看不出真实消耗规模。"""
    for k in ("settlementAmount", "dueAmount", "originalAmount"):
        v = _num(r.get(k))
        if v > 0:
            return v
    price = _num(r.get("originalCostPrice")) or _num(r.get("costPrice"))
    uc = _num(r.get("usageCount"))
    if price > 0 and uc > 0 and "千token" in str(r.get("costUnit") or ""):
        return price * uc / 1000.0
    return 0.0


def zhipu_account(cred, timeout=20):
    """账户报表：余额 / 累计充值 / 累计消费（拿不到返回 None）"""
    if not str((cred or {}).get("jwt_token") or "").strip():
        return None
    code, j = http_json(ZHIPU_API + "/biz/account/query-customer-account-report",
                        "GET", _zh_hdr(cred), None, timeout)
    if not isinstance(j, dict) or not (j.get("success") or j.get("code") in (0, 200)):
        return None
    d = j.get("data") or {}
    return {"balance": _num(d.get("balance")),
            "available": _num(d.get("availableBalance")),
            "recharge": _num(d.get("rechargeAmount")),
            "give": _num(d.get("giveAmount")),
            "total_spend": _num(d.get("totalSpendAmount")),
            "today_spend": _num(d.get("todaySpendAmount"))}


def zhipu_bills(cred, month, timeout=25):
    """某账期的全部计费记录 → (rows, err)。err 为 None 表示成功。"""
    url = (ZHIPU_API + "/finance/expenseBill/expenseBillList?billingMonth=%s"
           "&pageNum=1&pageSize=1000" % month)
    code, j = http_json(url, "GET", _zh_hdr(cred), None, timeout)
    if not isinstance(j, dict):
        return [], "HTTP %s 响应无法解析" % code
    rows = j.get("rows")
    if isinstance(rows, list):
        return rows, None
    msg = str(j.get("msg") or j.get("message") or "").strip()
    low = msg.lower()
    if code in (401, 403) or "authorization" in low or "身份" in msg or "登录" in msg:
        return [], "__EXPIRED__" + (msg or ("HTTP %s" % code))
    return [], msg or ("HTTP %s" % code)


def pu_zhipu(cred, days):
    c = cred or {}
    if not str(c.get("jwt_token") or "").strip():
        return {"status": "nokey", "detail": "未配置登录票据 JWT"}
    today = datetime.date.today()
    days_set = set((today - datetime.timedelta(days=i)).isoformat() for i in range(days))
    months = sorted({(today - datetime.timedelta(days=i)).strftime("%Y-%m")
                     for i in range(days + 1)})
    tok_acc, cost_acc = {}, {}
    rows_n, settled, last_err, got = 0, 0.0, None, False
    pack_seen, last_usage = {}, None
    for mth in months:
        rows, err = zhipu_bills(c, mth)
        if err:
            if err.startswith("__EXPIRED__"):
                return {"status": "expired",
                        "detail": "登录票据无效或已过期，请重新获取（%s）" % err[11:]}
            last_err = err
            continue
        got = True
        for r in rows:
            if not isinstance(r, dict):
                continue
            date = str(r.get("billingDate") or "")[:10]
            if not date:
                continue
            if str(r.get("usageUnit") or "").strip() != "token":
                continue                      # 资源包/体验包购买行，不是推理用量
            n = int(_num(r.get("usageCount")))
            if n <= 0:
                continue
            if last_usage is None or date > last_usage:
                last_usage = date
            # 资源包余量：与统计窗口无关。同一资源包只减不增 → 取该包所有记录里最小的
            # deductAfter；若账号有多个资源包，取「最近还在用」的那一个。
            left = r.get("deductAfter")
            if left is not None and r.get("tokenResourceName"):
                nm = str(r.get("tokenResourceName"))
                left = int(_num(left))
                pk = pack_seen.setdefault(nm, {"last": "", "left": left})
                if date > pk["last"]:
                    pk["last"] = date
                if left < pk["left"]:
                    pk["left"] = left
            if date not in days_set:
                continue                      # 窗口外的记录只用来报告「最近用量」，不进合计
            model = str(r.get("modelCode") or "").strip()
            if not model:                     # 兜底：从「【glm-5.2】模型推理」里抠模型名
                model = re.sub(r"[【】]|模型推理|Tokens包", "",
                               str(r.get("modelProductName") or "")).strip() or "(未知模型)"
            key = (model, date)
            kind = _zh_token_kind(r.get("tokenType"))
            b = tok_acc.setdefault(key, {})
            b[kind] = b.get(kind, 0) + n
            cc = cost_acc.setdefault(key, {"cost": 0.0})
            cc["cost"] += _zh_row_cost(r)
            rows_n += 1
            settled += _num(r.get("settlementAmount"))
    if not got:
        return {"status": "error", "detail": last_err or "平台未返回账单数据"}
    pack = None
    if pack_seen:
        pname = max(pack_seen, key=lambda n: (pack_seen[n]["last"], -pack_seen[n]["left"]))
        pack = {"name": pname, "remaining": pack_seen[pname]["left"]}
    if not tok_acc:
        d = "该时间区间内官网无模型推理用量记录"
        if last_usage:
            d = "官网最近一次用量是 %s（在近 %d 天窗口外）" % (last_usage, days)
        out = {"status": "empty", "detail": d, "last_usage": last_usage}
        if pack:
            out["resource_pack"] = pack
        return out
    shape = _build_platform_shape(tok_acc, cost_acc, days)
    if not shape:
        out = {"status": "empty", "detail": "该时间区间内官网无用量记录"}
        if pack:
            out["resource_pack"] = pack
        return out
    shape = _to_usd(shape, "CNY")
    shape["totals"]["cost_settled"] = round(settled, 6)
    out = {"status": "ok", "mode": "usage", "no_requests": True, "checked_at": now_iso(),
           "source": "官网费用账单（expenseBillList）", "bill_rows": rows_n, **shape}
    if pack:
        out["resource_pack"] = pack
    return out


# ---- 汇总 ----
PLATFORM_CACHE = {"t": 0, "data": None, "days": None}
PLATFORM_LOCK = threading.Lock()
PLATFORM_TTL = 55   # 小于前端 60s 轮询间隔，保证每轮都拿到新数据，又不至于打爆供应商接口


_FETCHERS = {"deepseek": pu_deepseek, "kimi": pu_kimi, "zhipu": pu_zhipu}


def platform_usage_all(provs, days, force=False):
    with PLATFORM_LOCK:
        if (not force and PLATFORM_CACHE["data"]
                and PLATFORM_CACHE.get("days") == days
                and time.time() - PLATFORM_CACHE["t"] < PLATFORM_TTL):
            return PLATFORM_CACHE["data"]
    creds = load_platform_creds()
    # 注意：结果必须按 CC Switch 的 provider id 作键（前端用 p.id 查），
    # 同一 kind 只查一次，再挂到该 kind 名下第一个 provider 上。
    targets, seen_kind = {}, set()
    for p in provs:
        pk = PLATFORM_KIND_OF.get(p.get("kind"))
        if pk and pk not in seen_kind:
            seen_kind.add(pk)
            targets[p["id"]] = {"provider_id": p["id"], "provider_name": p["name"], "kind": pk}
    results, lock, threads = {}, threading.Lock(), []

    def work(pid, meta):
        fn = _FETCHERS.get(meta["kind"])
        try:
            r = fn(creds.get(meta["kind"]) or {}, days)
        except Exception as e:
            r = {"status": "error", "detail": str(e)[:200]}
        r["provider_id"] = meta["provider_id"]
        r["provider_name"] = meta["provider_name"]
        r["label"] = PLATFORM_SPEC[meta["kind"]]["label"]
        r["kind"] = meta["kind"]
        with lock:
            results[pid] = r

    for pid, meta in targets.items():
        t = threading.Thread(target=work, args=(pid, meta), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=25)
    ordered = {}
    for pid, meta in targets.items():          # 按 CC Switch 中的顺序输出；未取到的给占位
        ordered[pid] = results.get(pid) or {
            "status": "nokey", "detail": "未配置平台凭据",
            "provider_id": meta["provider_id"],
            "provider_name": meta["provider_name"],
            "label": PLATFORM_SPEC[meta["kind"]]["label"],
            "kind": meta["kind"]}
    with PLATFORM_LOCK:
        PLATFORM_CACHE["t"] = time.time()
        PLATFORM_CACHE["data"] = ordered
        PLATFORM_CACHE["days"] = days
    return ordered


# ---------------- HTTP 服务 ----------------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, obj)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._serve_file("index.html", "text/html; charset=utf-8")
            if path.startswith("/static/"):
                name = path[len("/static/"):]
                ctype = "text/plain"
                if name.endswith(".css"):
                    ctype = "text/css; charset=utf-8"
                elif name.endswith(".js"):
                    ctype = "application/javascript; charset=utf-8"
                elif name.endswith(".svg"):
                    ctype = "image/svg+xml"
                return self._serve_file(name, ctype)
            if path == "/api/providers":
                provs, err = load_providers()
                if err:
                    return self._json({"ok": False, "error": err})
                return self._json({"ok": True, "providers": [
                    {k: v for k, v in p.items() if not k.startswith("_")} for p in provs]})
            if path == "/api/balance":
                provs, err = load_providers()
                if err:
                    return self._json({"ok": False, "error": err})
                return self._json({"ok": True, "balance": balances_all(provs)})
            if path == "/api/config":
                return self._json({"ok": True, "config": {
                    k: v for k, v in config.items() if k != "recharge_urls"},
                    "recharge_urls": {**DEFAULT_RECHARGE, **config["recharge_urls"]}})
            if path == "/api/data":
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                try:
                    days = max(1, min(365, int((q.get("days") or ["30"])[0])))
                except Exception:
                    days = 30
                provs, err = load_providers()
                if err:
                    return self._json({"ok": False, "error": err})
                usage = collect_usage(provs, days)
                balances = balances_all(provs, force=provider_changed(provs))
                price_map = price_lookup()
                out_providers = []
                total = {"cny": 0.0, "usd": 0.0, "plan": 0}
                for p in provs:
                    po = usage["per_provider"].get(p["id"])
                    item = {k: v for k, v in p.items() if not k.startswith("_")}
                    item["usage"] = po if po else None
                    item["balance"] = balances.get(p["id"]) or {"status": "error", "detail": "未查询"}
                    # 估算
                    blended, bsrc = estimate_tokens(p, po or {"totals": {}}, price_map)
                    item["est"] = {"blended_usd_per_m": round(blended, 4), "blend_source": bsrc}
                    if item["balance"].get("status") == "ok":
                        b = item["balance"]
                        if b.get("type") == "money":
                            for it in b.get("items") or []:
                                if it["currency"] == "CNY":
                                    total["cny"] += it["total"]
                                else:
                                    total["usd"] += it["total"]
                        else:
                            total["plan"] += 1
                    out_providers.append(item)
                unmatched = usage.get("unmatched")
                return self._json({"ok": True,
                                   "server_time": now_iso(),
                                   "db_path": DB_PATH,
                                   "providers": out_providers,
                                   "usage_totals": usage.get("totals"),
                                   "usage_unmatched": unmatched,
                                   "usage_unmatched_models": usage.get("unmatched_models") or [],
                                   "usage_unmatched_model_days": usage.get("unmatched_model_days") or {},
                                   "total_summary": total,
                                   "days": usage.get("days", days),
                                   "days_n": days})
            if path == "/api/platform":
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                try:
                    days = max(1, min(365, int((q.get("days") or ["30"])[0])))
                except Exception:
                    days = 30
                force = (q.get("force") or ["0"])[0] in ("1", "true", "yes")
                provs, err = load_providers()
                if err:
                    return self._json({"ok": False, "error": err})
                return self._json({"ok": True,
                                   "creds": creds_meta(),
                                   "spec": PLATFORM_SPEC,
                                   "curl_ok": bool(CURL_BIN),
                                   "usage": platform_usage_all(provs, days, force=force),
                                   "days": days})
            if path == "/api/open":
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                url = (q.get("url") or [""])[0]
                if url.startswith(("http://", "https://")):
                    import webbrowser
                    webbrowser.open(url)
                    return self._json({"ok": True})
                return self._json({"ok": False, "error": "bad url"})
            return self._json({"ok": False, "error": "404"}, 404)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._json({"ok": False, "error": str(e)}, 500)
            except Exception:
                pass

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if path == "/api/config":
            for k in ("refresh_seconds", "low_balance_cny", "days_default", "usd_cny"):
                if k in payload:
                    try:
                        config[k] = type(DEFAULT_CONFIG[k])(payload[k])
                    except Exception:
                        pass
            if isinstance(payload.get("recharge_urls"), dict):
                cleaned = {str(k): str(v) for k, v in payload["recharge_urls"].items() if str(v).startswith(("http://", "https://")) or not v}
                config["recharge_urls"] = cleaned
            if isinstance(payload.get("low_balance_by_provider"), dict):
                lbp = {}
                for k, v in payload["low_balance_by_provider"].items():
                    name = str(k).strip()
                    if not name:
                        continue
                    try:
                        amt = float(v)
                    except Exception:
                        continue          # 留空 = 用全局默认，不写入
                    if amt > 0:
                        lbp[name] = round(amt, 2)
                config["low_balance_by_provider"] = lbp
            save_config()
            return self._json({"ok": True})
        if path == "/api/platform_creds":
            kind = str(payload.get("kind") or "")
            if kind not in PLATFORM_SPEC:
                return self._json({"ok": False, "error": "未知平台"})
            creds = dict(load_platform_creds())
            cur = dict(creds.get(kind) or {})
            fields = payload.get("fields")
            if not isinstance(fields, dict):
                return self._json({"ok": False, "error": "缺少 fields"})
            kek = [f["key"] for f in PLATFORM_SPEC[kind]["fields"]]
            before = {k: str(cur.get(k) or "") for k in kek}
            for f in PLATFORM_SPEC[kind]["fields"]:
                k = f["key"]
                if k in fields:
                    v = str(fields[k] or "").strip()
                    if v:
                        cur[k] = v
                    else:
                        cur.pop(k, None)          # 传空串＝清除该项
            # 掩码值原样回传时不覆盖真实值
            for k, v in list(cur.items()):
                if "…" in str(v):
                    if (creds.get(kind) or {}).get(k):
                        cur[k] = creds[kind][k]
                    else:
                        cur.pop(k, None)
            # 票据真的换新了才刷新采集时间（改充值地址之类的空保存不算）
            if {k: str(cur.get(k) or "") for k in kek} != before:
                cur["captured_at"] = now_iso()
            if cur:
                creds[kind] = cur
            else:
                creds.pop(kind, None)
            if not save_platform_creds(creds):
                return self._json({"ok": False, "error": "写入凭据文件失败"})
            with PLATFORM_LOCK:
                PLATFORM_CACHE["t"] = 0
                PLATFORM_CACHE["data"] = None
            return self._json({"ok": True, "creds": creds_meta()})
        if path == "/api/platform_test":
            kind = str(payload.get("kind") or "")
            if kind not in PLATFORM_SPEC:
                return self._json({"ok": False, "error": "未知平台"})
            cred = dict(load_platform_creds().get(kind) or {})
            fields = payload.get("fields")
            if isinstance(fields, dict):          # 允许用「未保存的」新值直接测试
                for f in PLATFORM_SPEC[kind]["fields"]:
                    k = f["key"]
                    if k in fields and str(fields[k] or "").strip() and "…" not in str(fields[k]):
                        cred[k] = str(fields[k]).strip()
            try:
                res = _FETCHERS[kind](cred, 30)
            except Exception as e:
                res = {"status": "error", "detail": str(e)[:200]}
            return self._json({"ok": True, "result": res})
        if path == "/api/refresh":
            provs, err = load_providers()
            if err:
                return self._json({"ok": False, "error": err})
            return self._json({"ok": True, "balance": balances_all(provs, force=True)})
        return self._json({"ok": False, "error": "404"}, 404)

    def _serve_file(self, name, ctype):
        safe = os.path.normpath(name).replace("\\", "/")
        if safe.startswith("..") or "/" in safe:
            return self._json({"ok": False, "error": "forbidden"}, 403)
        fp = os.path.join(STATIC_DIR, safe)
        if not os.path.exists(fp):
            return self._json({"ok": False, "error": "file not found"}, 404)
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


class ReuseServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def pick_port(prefer):
    for port in range(prefer, prefer + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


def start_server(port=None):
    """启动本地 HTTP 服务（可被桌面端复用）。返回 (httpd, port)。"""
    port = pick_port(port if port else int(config.get("port", 8733)))
    httpd = ReuseServer(("127.0.0.1", port), Handler)
    return httpd, port


def main():
    httpd, port = start_server()
    print("=" * 56)
    print("  TokenWatch · CC Switch 用量/余量/充值 监控台")
    print("  地址: http://127.0.0.1:%d" % port)
    print("  数据库: %s" % DB_PATH)
    print("  提示: 关闭本窗口即停止监控；密钥仅在本机使用")
    print("=" * 56)
    if config.get("auto_open"):
        def _open():
            time.sleep(1.0)
            import webbrowser
            try:
                webbrowser.open("http://127.0.0.1:%d" % port)
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
