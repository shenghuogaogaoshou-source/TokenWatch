# -*- coding: utf-8 -*-
"""本地用量库（%APPDATA%\\TokenWatch\\usage.db）。

为什么要有自己的库：
- 旧版只读 CC Switch 的 SQLite，用户没装 CC Switch 就什么都看不到；
- 新版的账户来自「各家官网 + 中转站」，跟 CC Switch 已经没有关系；
- 有了本地库才能存历史、做趋势、算区间合计，且不再受别人库结构变化影响。

凭据**不在这里**：仍然集中在 platform_creds.json，键 = account_id。
这样旧的三家（id 就是 deepseek/kimi/zhipu）可以零迁移直接复用。
"""
import json
import os
import sqlite3
import threading
import uuid

from . import paths

# 只有「合计」没有模型明细的账户（如某些中转站只给总额），明细行用这个占位模型名
AGG_MODEL = "__total__"

SCHEMA_VERSION = 1

_DDL = """
CREATE TABLE IF NOT EXISTS accounts (
    id           TEXT PRIMARY KEY,
    driver       TEXT NOT NULL,
    label        TEXT NOT NULL,
    base_url     TEXT DEFAULT '',
    capability   TEXT DEFAULT 'detail',   -- detail / balance_only / catalog_only
    currency     TEXT DEFAULT 'CNY',
    sort_index   INTEGER DEFAULT 100,
    enabled      INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT '',
    last_ok_at   TEXT DEFAULT '',
    last_error   TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_usage (
    account_id  TEXT NOT NULL,
    date        TEXT NOT NULL,            -- YYYY-MM-DD
    model       TEXT NOT NULL,            -- 规范模型 id，如 openai/gpt-6.1
    requests    INTEGER DEFAULT 0,
    input       INTEGER DEFAULT 0,
    output      INTEGER DEFAULT 0,
    cache_read  INTEGER DEFAULT 0,
    cache_write INTEGER DEFAULT 0,
    cost_cny    REAL DEFAULT 0,           -- 全站统一人民币
    cost_native REAL DEFAULT 0,           -- 官网原币种实扣，用于披露
    currency    TEXT DEFAULT 'CNY',
    source      TEXT DEFAULT 'platform',  -- platform / imported / estimated
    PRIMARY KEY (account_id, date, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_date  ON daily_usage(date);
CREATE INDEX IF NOT EXISTS idx_usage_acct  ON daily_usage(account_id, date);

CREATE TABLE IF NOT EXISTS balance_snapshots (
    account_id TEXT NOT NULL,
    ts         TEXT NOT NULL,
    balance    REAL DEFAULT 0,
    currency   TEXT DEFAULT 'CNY',
    PRIMARY KEY (account_id, ts)
);

CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
"""

_init_lock = threading.Lock()
_inited = set()


def conn():
    """每次调用新建连接。服务端是多线程，共享一条连接会踩 check_same_thread。"""
    p = paths.db_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    c = sqlite3.connect(p, timeout=8)
    c.row_factory = sqlite3.Row
    try:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=5000")
    except Exception:
        pass
    init_db(c)
    return c


def init_db(c=None):
    """幂等建表。传连接则复用，不传则自己开一条（调用方负责关）。"""
    own = c is None
    if own:
        p = paths.db_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        c = sqlite3.connect(p, timeout=8)
        c.row_factory = sqlite3.Row
    key = paths.db_path()
    with _init_lock:
        if key not in _inited:
            c.executescript(_DDL)
            c.execute("INSERT OR IGNORE INTO meta(k, v) VALUES('schema_version', ?)",
                      (str(SCHEMA_VERSION),))
            c.commit()
            _inited.add(key)
    if own:
        c.close()


# ---------------- 账户 ----------------

def upsert_account(rec):
    rec = dict(rec or {})
    aid = str(rec.get("id") or "").strip() or uuid.uuid4().hex[:12]
    fields = {
        "id": aid,
        "driver": str(rec.get("driver") or "generic"),
        "label": str(rec.get("label") or aid),
        "base_url": str(rec.get("base_url") or ""),
        "capability": str(rec.get("capability") or "detail"),
        "currency": str(rec.get("currency") or "CNY"),
        "sort_index": (int(rec["sort_index"]) if rec.get("sort_index") is not None else 100),
        "enabled": 1 if rec.get("enabled", True) else 0,
        "created_at": str(rec.get("created_at") or ""),
        "last_ok_at": str(rec.get("last_ok_at") or ""),
        "last_error": str(rec.get("last_error") or ""),
    }
    c = conn()
    try:
        cur = c.execute("SELECT id, created_at FROM accounts WHERE id=?", (aid,)).fetchone()
        if cur:
            # 已存在：不覆盖 created_at / last_ok_at，除非显式传入
            for k in ("created_at", "last_ok_at"):
                if not fields[k]:
                    fields[k] = cur[k] or ""
            c.execute(
                "UPDATE accounts SET driver=?, label=?, base_url=?, capability=?, currency=?, "
                "sort_index=?, enabled=?, created_at=?, last_ok_at=?, last_error=? WHERE id=?",
                (fields["driver"], fields["label"], fields["base_url"], fields["capability"],
                 fields["currency"], fields["sort_index"], fields["enabled"],
                 fields["created_at"], fields["last_ok_at"], fields["last_error"], aid))
        else:
            c.execute(
                "INSERT INTO accounts(id, driver, label, base_url, capability, currency, "
                "sort_index, enabled, created_at, last_ok_at, last_error) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (aid, fields["driver"], fields["label"], fields["base_url"], fields["capability"],
                 fields["currency"], fields["sort_index"], fields["enabled"],
                 fields["created_at"], fields["last_ok_at"], fields["last_error"]))
        c.commit()
    finally:
        c.close()
    return aid


def list_accounts(enabled_only=False):
    c = conn()
    try:
        sql = "SELECT * FROM accounts"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY sort_index, created_at, id"
        return [dict(r) for r in c.execute(sql).fetchall()]
    finally:
        c.close()


def get_account(aid):
    c = conn()
    try:
        r = c.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        return dict(r) if r else None
    finally:
        c.close()


def delete_account(aid):
    c = conn()
    try:
        c.execute("DELETE FROM accounts WHERE id=?", (aid,))
        c.execute("DELETE FROM daily_usage WHERE account_id=?", (aid,))
        c.execute("DELETE FROM balance_snapshots WHERE account_id=?", (aid,))
        c.commit()
    finally:
        c.close()


def touch_account(aid, ok=None, error=""):
    c = conn()
    try:
        now = _now()
        if ok:
            c.execute("UPDATE accounts SET last_ok_at=?, last_error='' WHERE id=?", (now, aid))
        else:
            c.execute("UPDATE accounts SET last_error=? WHERE id=?", (str(error)[:300], aid))
        c.commit()
    finally:
        c.close()


# ---------------- 用量 ----------------

def upsert_usage(account_id, rows, source="platform"):
    """rows: [{date, model, requests, input, output, cache_read, cache_write,
               cost_cny, cost_native, currency}]"""
    if not rows:
        return 0
    c = conn()
    n = 0
    try:
        for r in rows:
            d = str(r.get("date") or "").strip()
            model = str(r.get("model") or AGG_MODEL).strip() or AGG_MODEL
            if not d:
                continue
            c.execute(
                "INSERT INTO daily_usage(account_id, date, model, requests, input, output, "
                "cache_read, cache_write, cost_cny, cost_native, currency, source) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(account_id, date, model) DO UPDATE SET "
                "requests=excluded.requests, input=excluded.input, output=excluded.output, "
                "cache_read=excluded.cache_read, cache_write=excluded.cache_write, "
                "cost_cny=excluded.cost_cny, cost_native=excluded.cost_native, "
                "currency=excluded.currency, source=excluded.source",
                (account_id, d, model,
                 int(r.get("requests") or 0), int(r.get("input") or 0), int(r.get("output") or 0),
                 int(r.get("cache_read") or 0), int(r.get("cache_write") or 0),
                 float(r.get("cost_cny") or 0), float(r.get("cost_native") or 0),
                 str(r.get("currency") or "CNY"), str(r.get("source") or source)))
            n += 1
        c.commit()
    finally:
        c.close()
    return n


def usage_rows(start, end, account_ids=None):
    """返回 [start, end] 闭区间内的逐日逐模型行。"""
    c = conn()
    try:
        sql = ("SELECT account_id, date, model, requests, input, output, cache_read, "
               "cache_write, cost_cny, cost_native, currency, source "
               "FROM daily_usage WHERE date>=? AND date<=?")
        args = [start, end]
        if account_ids:
            sql += " AND account_id IN (%s)" % ",".join("?" * len(account_ids))
            args += list(account_ids)
        sql += " ORDER BY date, account_id, model"
        return [dict(r) for r in c.execute(sql, args).fetchall()]
    finally:
        c.close()


def aggregate(start, end, account_ids=None):
    """一次查询喂给界面的总览/趋势/明细三处，避免口径分裂。"""
    rows = usage_rows(start, end, account_ids)
    by_acct, by_model, by_date = {}, {}, {}
    for r in rows:
        a = by_acct.setdefault(r["account_id"], _zero())
        m = by_model.setdefault(r["model"], _zero())
        d = by_date.setdefault(r["date"], _zero())
        for tgt in (a, m, d):
            for k in ("requests", "input", "output", "cache_read", "cache_write"):
                tgt[k] += r[k]
            tgt["cost"] += r["cost_cny"]
            tgt["cost_native"] += r["cost_native"]
        a["currency"] = r["currency"]
        a["source"] = r["source"]
    return {"by_account": by_acct, "by_model": by_model, "by_date": by_date, "rows": rows}


def _zero():
    return {"requests": 0, "input": 0, "output": 0, "cache_read": 0,
            "cache_write": 0, "cost": 0.0, "cost_native": 0.0}


# ---------------- 余额 ----------------

def add_balance(account_id, value, currency="CNY", ts=None):
    c = conn()
    try:
        c.execute("INSERT OR REPLACE INTO balance_snapshots(account_id, ts, balance, currency) "
                  "VALUES(?,?,?,?)", (account_id, ts or _now(), float(value or 0), currency))
        c.commit()
    finally:
        c.close()


def latest_balances():
    c = conn()
    try:
        rows = c.execute(
            "SELECT b.* FROM balance_snapshots b JOIN "
            "(SELECT account_id, MAX(ts) AS mts FROM balance_snapshots GROUP BY account_id) t "
            "ON b.account_id=t.account_id AND b.ts=t.mts").fetchall()
        return {r["account_id"]: {"balance": r["balance"], "currency": r["currency"],
                                  "ts": r["ts"]} for r in rows}
    finally:
        c.close()


# ---------------- meta ----------------

def meta_get(k, default=None):
    c = conn()
    try:
        r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r["v"] if r else default
    finally:
        c.close()


def meta_set(k, v):
    c = conn()
    try:
        c.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?,?)", (k, str(v)))
        c.commit()
    finally:
        c.close()


def _now():
    import datetime
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
