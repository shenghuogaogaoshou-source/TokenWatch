# -*- coding: utf-8 -*-
"""回归探针：验证三项优化里的服务端口径
1) 智谱费用账单只查一遍（余额侧不再重复拉账单）
2) 资源包余量由用量接口一次产出，且窗口外也能拿到
3) 票据期限解析（Kimi 用 JWT exp / 智谱按经验估算 / DeepSeek 视为长效）
用法：TOKENWATCH_CONFIG=<实盘 config.json> python _check_opts.py
"""
import collections
import json
import os
import sys

import server as S

fails = []


def chk(name, ok, got=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + ("   [" + str(got) + "]" if got != "" else ""))
    if not ok:
        fails.append(name)


print("== 凭据路径 ==")
print("  config :", S.CONFIG_PATH)
print("  creds  :", S.PLATFORM_CREDS_PATH)

calls = collections.Counter()
_orig_bills = S.zhipu_bills


def _spy(cred, month, timeout=25):
    calls[month] += 1
    return _orig_bills(cred, month, timeout)


S.zhipu_bills = _spy

creds = S.load_platform_creds()
days = 30

print("\n== 1) 用量侧：账单查询次数 ==")
res = S.pu_zhipu(creds.get("zhipu") or {}, days)
usage_calls = dict(calls)
n_months = len(usage_calls)
print("  status =", res.get("status"), "| 账期 =", usage_calls)
chk("用量侧每个账期只查一次", all(v == 1 for v in usage_calls.values()), usage_calls)
chk("用量侧确实查了账单", n_months >= 1, n_months)

print("\n== 2) 余额侧：不应再拉账单 ==")
calls.clear()
bal = S.balance_zhipu({"base_url": "https://open.bigmodel.cn", "_key": "x"})
bal_calls = dict(calls)
print("  balance status =", bal.get("status"), "| 账单查询 =", bal_calls or "0 次")
chk("余额侧不再重复拉账单", sum(bal_calls.values()) == 0, bal_calls or "0 次")
chk("余额侧仍拿到可用余额", bal.get("status") == "ok", bal.get("status"))

print("\n== 3) 资源包余量 ==")
pack = res.get("resource_pack")
chk("用量结果里带资源包余量", bool(pack), json.dumps(pack, ensure_ascii=False))
if pack:
    chk("资源包余量为非负整数", isinstance(pack.get("remaining"), int) and pack["remaining"] >= 0,
        pack.get("remaining"))

print("\n== 4) 票据期限 ==")
meta = S.creds_meta()
for k, v in meta.items():
    e = v.get("expiry")
    print("  %-9s configured=%-5s %s" % (k, v.get("configured"),
                                          json.dumps(e, ensure_ascii=False)))
chk("Kimi 期限来自 JWT exp", (meta.get("kimi", {}).get("expiry") or {}).get("source", "").startswith("JWT"),
    (meta.get("kimi", {}).get("expiry") or {}).get("at"))
chk("智谱期限为估算", bool((meta.get("zhipu", {}).get("expiry") or {}).get("estimated")),
    (meta.get("zhipu", {}).get("expiry") or {}).get("at"))
chk("DeepSeek 视为长效", bool((meta.get("deepseek", {}).get("expiry") or {}).get("long_lived")),
    (meta.get("deepseek", {}).get("expiry") or {}).get("source"))

print("\n== 5) 按提供商阈值配置 ==")
chk("config 支持 low_balance_by_provider", "low_balance_by_provider" in S.DEFAULT_CONFIG,
    S.config.get("low_balance_by_provider"))

print("\n>>> " + ("全部通过" if not fails else "%d 项未通过：%s" % (len(fails), "；".join(fails))))
sys.exit(1 if fails else 0)
