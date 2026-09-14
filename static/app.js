/* ============================================================
   TokenWatch 前端逻辑 · 纯 vanilla，无外部依赖
   ============================================================ */
"use strict";

/* 提供商视觉识别（色调统一由这里给出；底色为对应浅色） */
const PROVIDER_VIS = [
  { test: /deepseek/i, glyph: "DS", acc: "#4361EE", soft: "#EEF1FE" },
  { test: /kimi|moonshot/i, glyph: "K", acc: "#7A5CFF", soft: "#F3F0FF" },
  { test: /glm|zhipu|bigmodel/i, glyph: "GLM", acc: "#0E9C98", soft: "#E4F7F5" },
  { test: /.*/, glyph: "AI", acc: "#1F2430", soft: "#EFF0F3" },
];
function visFor(name) {
  return PROVIDER_VIS.find((v) => v.test.test(name)) || PROVIDER_VIS[PROVIDER_VIS.length - 1];
}

/* 模型维度的稳定配色（按名称哈希取色，同一模型永远同色） */
const MODEL_PALETTE = ["#4361EE", "#7A5CFF", "#0E9C98", "#F59E0B", "#EF4444",
  "#06B6D4", "#8B5CF6", "#10B981", "#F97316", "#3B82F6", "#EC4899", "#84CC16"];
function colorForModel(name) {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return MODEL_PALETTE[h % MODEL_PALETTE.length];
}

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- 格式化 ---------- */
const N = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
function money(v, cur) {
  const sym = cur === "CNY" ? "¥" : "$";
  let s;
  if (v >= 10000) s = N.format(Math.round(v)) ;
  else if (v >= 100) s = v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else s = v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sym + s;
}
function compactTok(v) {
  if (v == null || isNaN(v)) return "0";
  if (v >= 1e8) return (v / 1e8).toFixed(2).replace(/\.?0+$/, "") + " 亿";
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.?0$/, "") + " 万";
  if (v >= 1000) return (v / 1e3).toFixed(1) + "k";
  return String(Math.round(v));
}
function fullNum(v) {
  return (v || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
/* 美元金额：≥1 保留 2 位，<1 保留 4 位（小额成本可读） */
function fmtUSD(v) {
  v = v || 0;
  const d = Math.abs(v) >= 1 ? 2 : 4;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function todayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
/* 本地时区的 YYYY-MM-DD（toISOString 是 UTC，东八区凌晨会差一天） */
function localISO(offset) {
  const d = new Date();
  d.setDate(d.getDate() - (offset || 0));
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const state = {
  providers: [], recharge: {}, cfg: null, rangeDays: 30, metric: "cost", view: "provider",
  timer: null, platTimer: null, loading: 0, dataMain: null, data7: null, providerSig: null,
  platform: null,      // /api/platform 的响应（统一视图里始终尝试读取）
  platSig: null,       // 平台数据的签名，只有变化才重绘
};

/* ---------- CC Switch 提供商变更监听 ---------- */
function providerSigFrom(provs) {
  return JSON.stringify((provs || []).map((p) => [
    p.id, p.name, p.base_url, (p.models || []).join(","),
  ]));
}
async function watchProviders() {
  try {
    const j = await getJSON("/api/providers");
    if (!j.ok || !Array.isArray(j.providers)) return;
    const sig = providerSigFrom(j.providers);
    if (state.providerSig && sig !== state.providerSig && !state.loading) {
      toast("检测到 CC Switch 提供商变更，正在同步…");
      await refreshAll(true);
    }
  } catch (e) { /* 静默重试 */ }
}
function startProviderWatcher() {
  setInterval(watchProviders, 5000);
}

/* ---------- 主题切换 ---------- */
function initTheme() {
  const saved = localStorage.getItem("tokenwatch-theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  setTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("tokenwatch-theme")) setTheme(e.matches ? "dark" : "light");
  });
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = $("#themeIcon");
  if (icon) {
    icon.innerHTML = theme === "dark"
      ? '<path d="M6 0a6 6 0 1 0 6 6 6 6 0 0 0-6-6Zm0 11a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" fill="currentColor"/>'
      : '<path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" fill="currentColor"/>';
  }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  setTheme(next);
  localStorage.setItem("tokenwatch-theme", next);
}

/* ---------- 网络 ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "保存失败");
  return j;
}

function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  // 强制重启动画
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 3400);
}
function setSync(text, err) {
  $("#syncText").textContent = text;
  $("#syncState").classList.toggle("err", !!err);
  $("#syncDot").style.animation = err ? "none" : "";
}

/* ---------- 数据加载 ---------- */
async function loadConfig() {
  try {
    const j = await getJSON("/api/config");
    if (j.ok) {
      state.cfg = j.config;
      state.recharge = j.recharge_urls || {};
    }
  } catch (e) { /* 默认配置继续 */ }
}

function providerTotals7() {
  /* 近7日 聚合（来自独立请求 data7），含未归属模型 */
  const t = { cost: 0, tok: 0, req: 0 };
  if (!state.data7) return t;
  const per = state.data7.providers || [];
  for (const p of per) {
    const u = p.usage;
    if (!u) continue;
    t.cost += u.totals?.cost || 0;
    t.tok += (u.totals?.input || 0) + (u.totals?.output || 0) +
             (u.totals?.cache_read || 0) + (u.totals?.cache_creation || 0);
    t.req += u.totals?.requests || 0;
  }
  const un = state.data7.usage_unmatched;
  if (un) {
    t.cost += un.cost || 0;
    t.tok += (un.input || 0) + (un.output || 0) + (un.cache_read || 0) + (un.cache_creation || 0);
    t.req += un.requests || 0;
  }
  return t;
}

/* ============================================================
   统一数据来源：官网真实用量优先，未覆盖的自动回落 CC Switch 本地记录
   ============================================================ */

/* 平台侧「有按天明细」（usage 模式）且查询成功的 provider id */
function platformCoveredIds() {
  const s = new Set();
  const u = (state.platform && state.platform.usage) || {};
  for (const pid of Object.keys(u)) {
    const r = u[pid];
    if (r && r.status === "ok" && r.mode === "usage") s.add(pid);
  }
  return s;
}

/* 近 7 日合计：被官网覆盖的家用官网值，其余（含未归属模型）用本地记录 */
function unifiedTotals7() {
  const covered = platformCoveredIds();
  const u = (state.platform && state.platform.usage) || {};
  const t = { cost: 0, tok: 0, req: 0, platN: 0, localN: 0 };
  const acc = (rec) => {
    t.cost += rec.cost || 0;
    t.tok += (rec.input || 0) + (rec.output || 0) +
             (rec.cache_read || 0) + (rec.cache_creation || 0);
    t.req += rec.requests || 0;
  };
  /* 1) 官网口径 */
  for (const pid of covered) {
    const days = u[pid].days || {};
    for (let i = 0; i < 7; i++) {
      const rec = days[localISO(i)];
      if (rec) acc(rec);
    }
    t.platN++;
  }
  /* 2) 本地兜底：仅算未被官网覆盖的提供商 */
  const l7 = (state.data7 && state.data7.providers) || [];
  for (const p of l7) {
    if (covered.has(p.id) || !p.usage || !p.usage.totals) continue;
    acc(p.usage.totals);
    t.localN++;
  }
  /* 3) 未归属模型（官方直连等，官网侧看不到） */
  const un = state.data7 && state.data7.usage_unmatched;
  if (un) acc(un);
  return t;
}

function platformUsageOk() {
  return platformCoveredIds().size > 0;
}

/* 数据来源状态条（统一视图，无切换开关） */
function syncSrcBar() {
  const badge = $("#srcBadge"), hint = $("#srcHint"), cred = $("#srcCredState");
  const plat = state.platform;
  const c = (plat && plat.creds) || {};
  const kinds = Object.keys(c);
  const okN = kinds.filter((k) => c[k] && c[k].configured).length;
  const covered = platformCoveredIds();
  const nProv = (state.providers || []).length;

  if (badge) {
    badge.className = "src-badge" + (covered.size ? " on" : "");
    badge.innerHTML = `<i class="src-dot"></i>` +
      (covered.size ? "官网实时 · " + covered.size + " 家" : "本地记录");
  }
  if (hint) {
    hint.textContent = !plat
      ? "正在读取供应商官网用量…"
      : covered.size
        ? (covered.size < nProv
            ? "已接通 " + covered.size + "/" + nProv + " 家官网接口，其余自动回落本地记录"
            : "全部提供商均已接通官网接口，按账户实际扣费口径显示")
        : "官网用量暂不可得，当前以 CC Switch 本地记录呈现";
  }
  if (!cred) return;
  if (!kinds.length) { cred.textContent = ""; cred.className = "src-credstate"; return; }
  cred.className = "src-credstate " + (covered.size ? "ok" : (okN ? "warn" : ""));
  cred.textContent = okN + "/" + kinds.length + " 家已配置" +
    (okN < kinds.length ? " · 点「平台凭据」补齐" : "");
}

/* 单独轻量刷新官网用量（不重取本地数据），供 60s 实时轮询使用 */
function platSigOf(p) {
  return p ? JSON.stringify(p.usage || {}) + "|" + JSON.stringify(p.creds || {}) : "";
}
async function refreshPlatform(quiet) {
  if (state.loading && quiet) return;
  try {
    const p = await getJSON("/api/platform?days=" + state.rangeDays);
    if (!p || !p.ok) return;
    const sig = platSigOf(p);
    const changed = sig !== state.platSig;
    state.platform = p;
    state.platSig = sig;
    syncSrcBar();
    if (changed) renderAll();
  } catch (e) { /* 静默重试 */ }
}

async function refreshAll(quiet) {
  if (state.loading && quiet) return;
  if (!quiet) {
    $("#btnRefresh").classList.add("loading");
    setSync("刷新中…");
  }
  state.loading++;
  try {
    await loadConfig();
    const days = state.rangeDays;
    /* 官网要逐个直连供应商接口，可能慢；不让它拖住首屏 */
    const platP = getJSON("/api/platform?days=" + days + (quiet ? "" : "&force=1"))
      .catch(() => null);
    const [main, d7] = await Promise.all([
      getJSON("/api/data?days=" + days),
      getJSON("/api/data?days=7"),
    ]);
    if (!main.ok) throw new Error(main.error || "读取失败");
    state.dataMain = main;
    state.data7 = d7.ok ? d7 : null;
    state.providers = main.providers || [];
    state.providerSig = providerSigFrom(state.providers);
    const plat = await Promise.race([
      platP, new Promise((r) => setTimeout(() => r(null), 3500)),
    ]);
    if (plat && plat.ok) { state.platform = plat; state.platSig = platSigOf(plat); }
    syncSrcBar();
    renderAll();
    $("#syncText").textContent = "实时 · " + (main.server_time || "").slice(11, 16) + " 更新";
    if (!quiet) toast("已刷新：官网用量与本地记录均为最新");
    /* 官网数据迟到时补渲染 */
    if (platP && !(plat && plat.ok)) {
      platP.then((p) => {
        if (p && p.ok) {
          const sig = platSigOf(p);
          const changed = sig !== state.platSig;
          state.platform = p;
          state.platSig = sig;
          syncSrcBar();
          if (changed) renderAll();
        }
      });
    }
  } catch (err) {
    console.error(err);
    setSync("连接失败，重试中…", true);
    if (!quiet) toast("刷新失败：" + err.message, true);
    renderError(err.message);
  } finally {
    state.loading--;
    $("#btnRefresh").classList.remove("loading");
  }
}

/* ============================================================
   渲染
   ============================================================ */
function renderAll() {
  renderTape();
  renderProviders();
  renderDetail();
  renderExpiryStrip();
}

/* 票据即将过期的推荐条：把「期限快到期」的提供商排到最前，提示优先使用 / 尽快续票 */
function renderExpiryStrip() {
  const host = $("#expStrip");
  if (!host) return;
  const items = [];
  for (const p of state.providers) {
    const ex = expiryOf(p.id);
    const t = expiryText(ex);
    if (!t || t.day == null) continue;                 // 只标记「有期限」的票据
    const r = platformFor(p.id);
    items.push({ name: p.name, day: t.day, cls: t.cls, tip: t.tip,
                 kind: r && r.kind, txt: t.txt });
  }
  const near = items.filter((x) => x.day <= 7).sort((a, b) => a.day - b.day);
  if (!near.length) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const urgent = near.some((x) => x.day <= 2);
  host.hidden = false;
  host.className = "exp-strip" + (urgent ? " urgent" : "");
  host.innerHTML = `<span class="exp-head">${urgent
    ? "⚠ 有票据即将过期，建议优先使用以下提供商，并尽快更新凭据"
    : "ℹ 票据期限提醒：以下提供商的登录票据将在 7 天内到期"}</span>` +
    near.map((x) => `<span class="exp-chip${x.day <= 2 ? " urgent" : ""}" title="${esc(x.tip || "")}">
        ${esc(x.name)} · ${esc(x.txt.replace("有效期至 ", ""))}</span>`).join("") +
    `<button type="button" class="btn btn-ghost btn-sm" id="expGo">更新凭据</button>`;
  const go = $("#expGo");
  if (go) {
    go.addEventListener("click", () => {
      openPlatformCreds();
      focusPlatform(near[0].kind);
    });
  }
}

function renderError(msg) {
  $("#providers").innerHTML = "";
  const box = el("div", "pcard err-bal");
  box.style.gridColumn = "1 / -1";
  box.innerHTML = `<div class="errbox" style="margin:6px 0"><b>无法读取监控数据</b>　<span>${esc(msg)}</span></div>
    <p style="color:var(--ink-2);font-size:12.5px;line-height:1.8;margin:8px 2px">
      常见原因：<br>
      ① CC Switch 桌面版尚未在本机初始化过（未找到 <code>~/.cc-switch/cc-switch.db</code>）；<br>
      ② 数据库正被其它程序独占写锁（一般不影响，本工具以只读方式打开）；<br>
      ③ 尚未在 CC Switch 中接入任何可用的第三方 API Key。
    </p>`;
  $("#providers").appendChild(box);
}

function renderTape() {
  const provs = state.providers;
  // 可用余额（充值制）
  let cny = 0, usd = 0, planN = 0;
  for (const p of provs) {
    const b = p.balance;
    if (b && b.status === "ok" && b.type === "money") {
      for (const it of b.items || []) {
        if (it.currency === "CNY") cny += it.total; else usd += it.total;
      }
    } else if (b && b.status === "ok" && b.type === "quota_percent") {
      planN++;
    }
  }
  const fx = (state.cfg && state.cfg.usd_cny) || 7.1;
  const totalCny = cny + usd * fx;
  if (totalCny > 0) {
    $("#tapeBalanceV").textContent = money(totalCny, "CNY");
    $("#tapeBalanceF").textContent =
      (cny ? "人民币 " + money(cny, "CNY") : "") +
      (cny && usd ? " + " : "") +
      (usd ? "美元 " + money(usd, "USD") + "（按 ¥" + fx + " 折算）" : "") +
      (planN ? (cny || usd ? "，另有 " : "") + planN + " 个订阅套餐" : "");
  } else if (planN) {
    $("#tapeBalanceV").textContent = planN + " 个";
    $("#tapeBalanceF").textContent = "订阅制套餐（智谱 GLM Coding Plan）额度见卡片";
  } else {
    $("#tapeBalanceV").textContent = "—";
    $("#tapeBalanceF").textContent = "暂无可用余额数据";
  }

  const t7 = unifiedTotals7();
  const anyPlat = t7.platN > 0;
  const noteEl = $("#tapeCost7Note");
  if (noteEl) {
    noteEl.textContent = anyPlat
      ? (t7.localN || t7.req ? "官网 " + t7.platN + " 家实扣口径" : "官网实扣口径")
      : "本地记录";
  }
  $("#tapeCost7V").textContent = "$" + (t7.cost || 0).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cnyEl = $("#tapeCost7Cny");
  if (cnyEl) {
    cnyEl.textContent = (t7.cost > 0)
      ? "≈ " + money(t7.cost * fx, "CNY") + "（按 ¥" + fx + " 折算）"
      : (anyPlat ? "官网侧近 7 天暂无消耗记录" : "暂无消耗记录");
  }
  const srcF = t7.platN
    ? "官网直连 " + t7.platN + " 家" + (t7.localN ? " + 本地兜底 " + t7.localN + " 家" : "")
    : "按 CC Switch 本地记录";
  $("#tapeCost7F").textContent = t7.req
    ? t7.req + " 次请求 · " + srcF
    : (anyPlat ? "最近 7 天官网侧暂无调用" : "最近 7 天暂无调用记录");
  $("#tapeTok7V").textContent = compactTok(t7.tok);
  $("#tapeProviders").textContent = provs.map((p) => p.name).join(" · ") || "—";

  const cur = provs.find((p) => p.is_current) || provs[0];
  $("#tapeActiveV").textContent = provs.length ? "正常 · " + provs.length + " 家" : "未接入";
  $("#tapeActiveF").innerHTML = "数据目录：<span id='tapeDb'>" + esc(shortDb()) + "</span> · " +
    (cur ? "当前：<b>" + esc(cur.name) + "</b>" : "");
  $("#fxRate").textContent = fx;
}
function shortDb() {
  const p = (state.dataMain && state.dataMain.db_path) || "";
  return p.replace(/\\/g, "/").replace(/^.*\/([^/]+)$/, "…/$1");
}

/* ---------- 提供商卡片 ---------- */
function renderProviders() {
  const host = $("#providers");
  host.innerHTML = "";
  if (!state.providers.length) {
    host.appendChild(renderError("未找到需要监控的提供商"));
    return;
  }
  state.providers.forEach((p, i) => {
    host.appendChild(buildCard(p, i));
  });
}

function zeroUsage() {
  return { totals: { requests: 0, success: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, cost: 0 }, models: [], days: {} };
}

/* 取某提供商在官网侧的结果（可能为 null） */
function platformFor(pid) {
  const u = (state.platform && state.platform.usage) || {};
  return u[pid] || null;
}
/* 某提供商的平台凭据（含票据期限），没有则 null */
function credOf(pid) {
  const r = platformFor(pid);
  const kind = r && r.kind;
  const c = (state.platform && state.platform.creds) || {};
  return kind && c[kind] ? c[kind] : null;
}
function expiryOf(pid) {
  const c = credOf(pid);
  return (c && c.expiry) || null;
}
/* 票据期限文案：{txt, day, cls, tip, est} */
function expiryText(ex) {
  if (!ex) return null;
  if (ex.days == null) {
    return {
      txt: ex.long_lived ? "长期有效" : "有效期未知",
      day: null, cls: "dim", tip: ex.source, est: false,
    };
  }
  const d = ex.days;
  const day = d < 0 ? "已过期 " + Math.abs(d) + " 天" : "剩 " + d + " 天";
  const cls = ex.level === "expired" ? "err" : ex.level === "urgent" ? "urgent" : ex.level === "soon" ? "warn" : "";
  return {
    txt: "有效期至 " + String(ex.at || "").slice(5, 10).replace("-", "/") + " · " + day,
    day: d, cls, tip: ex.source, est: !!ex.estimated,
  };
}
/* 提供商卡片用量条：有官网数据就用官网，否则回落本地记录（逐家判定） */
function srcUsageOf(p) {
  const local = (p.usage || zeroUsage()).totals;
  const r = platformFor(p.id);
  if (r && r.status === "ok" && r.mode === "usage" && r.totals) {
    return { totals: r.totals, src: "platform", platform: r };
  }
  return { totals: local, src: "local", pending: r };
}

function buildCard(p, i) {
  const vis = visFor(p.name);
  const u = p.usage || zeroUsage();
  const b = p.balance || {};
  const card = el("article", "pcard");
  card.style.animationDelay = (i * 70) + "ms";
  card.style.setProperty("--acc", vis.acc);
  card.style.setProperty("--acc-soft", vis.soft);
  if (b.status === "ok" && b.type === "money" && b.available === false) card.classList.add("warn-low");
  if (b.status === "ok" && b.type === "money") {
    const main = mainMoney(b);
    const fx = (state.cfg && state.cfg.usd_cny) || 7.1;
    const low = lowFor(p.name);
    const totalCny = main.total + (main.currency === "CNY" ? 0 : 0);
    const cnyTotal = b.items.reduce((s, it) => s + (it.currency === "CNY" ? it.total : it.total * fx), 0);
    if (low > 0 && cnyTotal < low && cnyTotal > 0) {
      card.classList.add("warn-low");
    }
  }

  const models = (p.models && p.models.length ? p.models : ["未指定模型"]);
  const modelTags = models.slice(0, 5).map((m) => `<span class="tag" title="${esc(m)}">${esc(m)}</span>`).join("") +
    (models.length > 5 ? `<span class="tag">+${models.length - 5}</span>` : "");

  /* 头部 */
  const head = el("div", "p-head");
  head.innerHTML = `
    <div class="ident">${esc(vis.glyph)}</div>
    <div class="p-name">
      <h3>${esc(p.name)}${p.is_current ? '<span class="cur">当前使用</span>' : ""}</h3>
      <div class="models">${modelTags}</div>
    </div>`;
  const idx = el("div", "p-idx");
  const siteA = el("a", "link-mini", "官网 ↗");
  siteA.href = p.website_url || "#";
  siteA.target = "_blank"; siteA.rel = "noopener";
  idx.appendChild(siteA);
  head.appendChild(idx);
  card.appendChild(head);

  /* 余额 */
  card.appendChild(buildBalance(p, b));

  /* 用量 strip（按当前数据来源取值） */
  const su = srcUsageOf(p);
  const strip = el("div", "usage-strip");
  const tt = su.totals || zeroUsage().totals;
  const mk = (k, v) => `<div class="ustat"><span class="u-k">${k}</span><span class="u-v">${v}</span></div>`;
  /* 有的平台（如 Kimi）官网只开放金额，没有 token / 请求数口径，别把 0 画成真实值；
     智谱费用账单有 token 和金额、唯独没有请求数，所以单列一条 noReq */
  const costOnly = su.src === "platform" && !!(su.platform && su.platform.cost_only);
  const noReq = su.src === "platform" && !!(su.platform && su.platform.no_requests);
  if (costOnly) strip.classList.add("cost-only");
  strip.innerHTML = costOnly
    ? mk("请求", "—") +
      mk("消耗 USD", fmtUSD(tt.cost)) +
      `<div class="ustat dim"><span class="u-k">官网口径</span><span class="u-v">仅金额</span></div>`
    : mk("请求", noReq ? "—" : fullNum(tt.requests)) +
      mk("输入 tok", compactTok(tt.input)) +
      mk("输出 tok", compactTok(tt.output)) +
      mk("消耗 USD", fmtUSD(tt.cost));
  const stripWrap = el("div", "usage-wrap");
  if (su.src === "platform") {
    const pr = su.platform || {};
    const nat = pr.totals && pr.totals.cost_native;
    const settled = pr.totals && pr.totals.cost_settled;
    const fxr = pr.fx || (state.cfg && state.cfg.usd_cny) || 7.1;
    let natTxt = "";
    if (pr.currency === "CNY" && nat > 0) {
      natTxt = (settled === 0)
        ? ` ｜ 官网计价 ${money(nat, "CNY")}（资源包全额抵扣，实扣 ¥0）`
        : ` ｜ 官网实扣 ${money(nat, "CNY")}（按 ¥${fxr}/USD 折算）`;
    }
    stripWrap.appendChild(el("div", "strip-src",
      (costOnly ? "官网实时 · 账户实际扣费口径（该平台仅提供金额）"
        : noReq ? "官网实时 · 官网账单计价口径（官网不提供请求数）"
          : "官网实时 · 账户实际扣费口径") + natTxt));
  } else {
    const st = su.pending && su.pending.status;
    const det = su.pending && su.pending.detail;
    const why = !su.pending ? "本地记录"
      : st === "nokey" ? "官网未配置凭据 · 本地记录"
      : (st === "quota" || (su.pending && su.pending.mode === "quota"))
        ? "该平台仅有套餐额度（见上方余额）· 明细用本地记录"
      : st === "expired" ? "官网凭据失效 · 本地记录"
      : st === "error" ? "官网读取失败 · 本地记录"
      : "官网区间内无数据 · 本地记录";
    stripWrap.appendChild(el("div", "strip-src muted",
      why + ((st === "empty" || st === "error") && det ? "（" + String(det).slice(0, 60) + "）" : "")));
  }
  stripWrap.appendChild(strip);
  card.appendChild(stripWrap);

  /* 底部操作 */
  const foot = el("div", "p-foot");
  const checked = b.checked_at ? "查于 " + b.checked_at.slice(5, 16) : "";
  const mut = el("span", "muted", checked || "余额未获取");
  foot.appendChild(mut);
  const rechargeUrl = state.recharge[p.name] || defaultRecharge(p.name) || p.website_url || "#";
  const rBtn = el("a", "btn-recharge", "前往充值 ↗");
  rBtn.href = rechargeUrl; rBtn.target = "_blank"; rBtn.rel = "noopener";
  const sBtn = el("a", "btn-site", "平台控制台");
  sBtn.href = p.website_url || "#"; sBtn.target = "_blank"; sBtn.rel = "noopener";
  foot.appendChild(rBtn);
  if (p.website_url) foot.appendChild(sBtn);
  card.appendChild(foot);
  return card;
}

function defaultRecharge(name) {
  const map = {
    DeepSeek: "https://platform.deepseek.com/top_up",
    Kimi: "https://platform.moonshot.cn/console/pay",
    "Zhipu GLM": "https://open.bigmodel.cn/finance/pay",
  };
  for (const k of Object.keys(map)) if (name.toLowerCase().includes(k.toLowerCase())) return map[k];
  return null;
}

function mainMoney(b) {
  const arr = b.items || [];
  const cny = arr.find((x) => x.currency === "CNY");
  return cny || arr[0] || { currency: "CNY", total: 0, granted: 0, topped_up: 0 };
}

/* 余额预警阈值：优先用「按提供商」单独设的金额，未设则回落到全局默认 */
function lowFor(name) {
  const m = (state.cfg && state.cfg.low_balance_by_provider) || {};
  const v = parseFloat(m[name]);
  if (isFinite(v) && v > 0) return v;
  return parseFloat(state.cfg && state.cfg.low_balance_cny) || 0;
}

function buildBalance(p, b) {
  const wrap = el("div");
  if (b.status === "ok") {
    if (b.type === "money") {
      const main = mainMoney(b);
      const fx = (state.cfg && state.cfg.usd_cny) || 7.1;
      const cnyTotal = (b.items || []).reduce((s, it) => s + (it.currency === "CNY" ? it.total : it.total * fx), 0);
      const low = lowFor(p.name);
      const lowFlag = low > 0 && cnyTotal < low && cnyTotal > 0;
      const perProv = !!((state.cfg && state.cfg.low_balance_by_provider) || {})[p.name];
      const div = el("div", "p-balance");
      const box = el("div", "bal-main");
      box.innerHTML = `
        <div class="bal-label">可用余额 <span class="err-tag" ${b.available ? 'style="display:none"' : ""}>⚠ 余额可能不足</span>${
          lowFlag ? `<span class="low-tag" title="${perProv ? "该提供商单独设置的预警阈值" : "全局预警阈值"}">低于预警 ¥${low}</span>` : ""}</div>
        <div class="bal-val${lowFlag ? " warn" : ""}">${money(main.total, main.currency)}<small>${main.currency === "CNY" ? "CNY" : "USD"}</small></div>`;
      div.appendChild(box);
      const pills = el("div", "bal-pills");
      for (const it of b.items || []) {
        const c = it.currency === "CNY" ? "¥" : "$";
        pills.appendChild(el("span", "pill",
          `${c} 充值 <b>${c === "¥" ? money(it.topped_up, "CNY").slice(1) : it.topped_up.toFixed(2)}</b>` +
          (it.granted > 0 ? ` · 赠送 <b>${c === "¥" ? money(it.granted, "CNY").slice(1) : it.granted.toFixed(2)}</b>` : "") +
          (it.currency === "CNY" ? "" : " USD")));
      }
      div.appendChild(pills);
      wrap.appendChild(div);
      /* 资源包余量（智谱等预付费账号）：来自官网费用账单，由用量接口一次拉取时顺带产出，
         余额侧不重复查询账单 */
      const pr = platformFor(p.id);
      if (pr && pr.resource_pack && pr.resource_pack.remaining > 0) {
        const pl = el("div", "est-line");
        pl.innerHTML = `资源包余量 <b>${compactTok(pr.resource_pack.remaining)} tokens</b>
          <span class="src">${esc(String(pr.resource_pack.name || "").slice(0, 26))}</span>`;
        wrap.appendChild(pl);
      }
      if (b.spent_yuan != null) {
        const sl = el("div", "est-line");
        sl.innerHTML = `官网累计消费 <b>${money(b.spent_yuan, "CNY")}</b>` +
          (b.spent_today_yuan > 0 ? ` <span class="src">今日 ${money(b.spent_today_yuan, "CNY")}</span>` : "");
        wrap.appendChild(sl);
      }
      /* 估算可用 token */
      if (p.est) {
        const fx2 = fx;
        const totalCny2 = cnyTotal;
        if (totalCny2 > 0 && p.est.blended_usd_per_m > 0) {
          const estTok = totalCny2 / fx2 / p.est.blended_usd_per_m * 1e6;
          const line = el("div", "est-line");
          line.innerHTML = `≈ <b>${compactTok(estTok)} tokens</b> 可调用
            <span class="src">按 ${p.est.blend_source || "标价"} $${p.est.blended_usd_per_m}/1M</span>`;
          wrap.appendChild(line);
        }
      }
    } else if (b.type === "quota_percent") {
      wrap.appendChild(buildPlan(b, p));
    }
  } else {
    const box = el("div", "errbox");
    const site = p.website_url || "#";
    box.innerHTML = `<b>余额查询失败</b>　<span>${esc((b.detail || "未知错误").slice(0, 90))}</span>
      <a href="${esc(site)}" target="_blank" rel="noopener">前往官网查看余量</a>`;
    wrap.appendChild(box);
  }
  /* 登录票据期限（Kimi 有 exp；智谱按经验有效期估算；DeepSeek 为长效凭据） */
  const exTxt = expiryText(expiryOf(p.id));
  if (exTxt) {
    const ln = el("div", "est-line exp" + (exTxt.cls ? " " + exTxt.cls : ""));
    ln.title = exTxt.tip || "";
    ln.innerHTML = `<span class="exp-key">登录票据</span> <b>${esc(exTxt.txt)}</b>` +
      (exTxt.est ? ` <span class="exp-est" title="${esc(exTxt.tip || "")}">估算</span>` : "") +
      (exTxt.cls === "urgent" || exTxt.cls === "err" || exTxt.cls === "warn"
        ? ` <span class="exp-fix">建议尽快更新凭据</span>` : "");
    wrap.appendChild(ln);
  }
  return wrap;
}

function buildPlan(b, p) {
  const out = el("div");
  const plan = (b.plan || "").toUpperCase();
  const head = el("div", "p-balance");
  const main = el("div", "bal-main");
  const win0 = (b.windows || []).find((w) => w.used_pct != null);
  const pctMain = win0 ? (100 - win0.used_pct) : null;
  main.innerHTML = `
    <div class="bal-label">Coding Plan 套餐额度${plan ? ' · <span style="color:var(--acc);font-weight:700">' + esc(plan) + "</span>" : ""}</div>
    <div class="bal-val">${pctMain != null ? Math.max(0, pctMain) + "%" : "—"}<small> 窗口剩余${win0 ? "（主窗口）" : ""}</small></div>`;
  head.appendChild(main);
  out.appendChild(head);

  const lines = el("div", "planline");
  if (b.windows && b.windows.length) {
    b.windows.forEach((w, i) => {
      if (w.used_pct == null) return;
      const name = planWindowName(w, i, b.windows.length);
      const rem = Math.max(0, 100 - w.used_pct);
      const hot = w.used_pct >= 80;
      const row = el("div", "plan-row");
      row.innerHTML = `
        <div class="pr-top"><span>${esc(name)}${w.reset_at ? " · 重置 " + esc(fmtReset(w.reset_at)) : ""}</span>
        <span>已用 <b style="color:${hot ? "var(--warn)" : "var(--ink)"}">${w.used_pct}%</b> · 余 ${rem}%</span></div>
        <div class="bar"><i class="${hot ? "hot" : ""}" style="width:${Math.min(100, w.used_pct)}%"></i></div>`;
      lines.appendChild(row);
    });
  } else {
    lines.appendChild(el("div", "est-line", "套餐额度接口未返回窗口明细，可前往官网查看。"));
  }
  out.appendChild(lines);
  return out;
}

function planWindowName(w, i, total) {
  const f = w.fields || {};
  const hay = JSON.stringify(f) + " " + (w.type || "");
  if (/week/i.test(hay)) return "本周额度";
  if (/hour|h\d|h_|HOUR/i.test(hay)) return "5 小时窗口";
  if (/month/i.test(hay)) return "本月额度";
  return total > 1 ? "额度窗口 " + (i + 1) : "额度窗口";
}
function fmtReset(v) {
  const s = String(v);
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T ](\d{1,2}):(\d{2})/);
  if (m) return m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
  const d = new Date(/^\d+$/.test(s) ? +s * (s.length === 10 ? 1000 : 1) : s);
  if (!isNaN(d)) return (d.getMonth() + 1) + "-" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return s;
}

/* ---------- 明细：趋势图 + 模型表（统一视图） ---------- */
function renderDetail() {
  if (!state.dataMain) return;
  const pv = $("#platformView");
  if (pv) {
    pv.innerHTML = "";
    const cards = renderPlatformCards();
    if (cards) pv.appendChild(cards);
  }

  const all = mergedProviders();
  const provs = all.filter((p) => Object.keys((p.usage && p.usage.days) || {}).length);
  const nPlat = all.filter((p) => p._src === "platform").length;
  const nLocal = all.length - nPlat;
  const nUnmatched = (state.dataMain.usage_unmatched_models || []).length;
  const nModels = provs.reduce((s, x) => s + ((x.usage.models || []).length), 0) + nUnmatched;
  const fxr = (state.cfg && state.cfg.usd_cny) || 7.1;
  const anyCny = Object.values((state.platform && state.platform.usage) || {})
    .some((r) => r && r.status === "ok" && r.currency === "CNY");
  const anyCostOnly = provs.some((p) => p.usage && p.usage.costOnly);
  const anyNoReq = provs.some((p) => p.usage && p.usage.noRequests && !p.usage.costOnly);

  renderChart(provs, { includeUnmatched: true, emptyHtml: unifiedEmptyHtml() });
  renderModelTable(provs, {
    unmatchedModels: state.dataMain.usage_unmatched_models || [],
    emptyText: unifiedEmptyText(),
    noteText: provs.length
      ? `范围：最近 ${state.rangeDays} 天 · 合成视图：${nPlat} 家取供应商官网实际扣费口径` +
        (nLocal ? `，${nLocal} 家官网未接通、回落本机 CC Switch 记录（估算口径）` : "") +
        (anyCny ? `；官网人民币金额已按 ¥${fxr}/USD 折算` : "") +
        (anyCostOnly ? "；带「金额口径」标记的平台官网只开放消费金额，不提供 token / 请求数" : "") +
        (anyNoReq ? "；带「无请求数」标记的平台官网账单不提供请求数，仅有 token 与金额" : "") +
        `。明细按「提供商 × 模型」展开（${nModels} 条${nUnmatched ? "，含 " + nUnmatched + " 个未归属模型" : ""}）。`
      : unifiedEmptyText(),
  });
}

/* 把官网 usage 结果整理成与 providers 相同的形状，复用图表 / 表格渲染 */
function platUsageShape(r) {
  const noReq = !!(r && r.no_requests);   /* 官网账单不带请求数（智谱费用账单） */
  return {
    totals: r.totals || zeroUsage().totals,
    costOnly: !!(r && r.cost_only),   /* 官网只给金额（Kimi），token / 请求数无口径 */
    noRequests: noReq,
    models: (r.models || []).map((m) => ({
      model: m.model, requests: m.requests, input: m.input,
      output: m.output, cache_read: m.cache_read, cost: m.cost,
      costOnly: !!(r && r.cost_only),
      noRequests: noReq,
    })),
    days: r.days || {},
    model_days: r.model_days || {},
  };
}

/* 合成视图的提供商列表：逐家决定取官网还是本地 */
function mergedProviders() {
  const seen = new Set();
  const out = [];
  for (const p of state.providers) {
    const r = platformFor(p.id);
    const useP = r && r.status === "ok" && r.mode === "usage";
    out.push({
      id: p.id,
      name: p.name,
      usage: useP ? platUsageShape(r) : (p.usage || zeroUsage()),
      _src: useP ? "platform" : "local",
      _pending: useP ? null : r,
    });
    seen.add(p.id);
  }
  /* 官网有、但 CC Switch 列表里没有的（兜底） */
  const u = (state.platform && state.platform.usage) || {};
  for (const pid of Object.keys(u)) {
    if (seen.has(pid)) continue;
    const r = u[pid];
    if (r && r.status === "ok" && r.mode === "usage") {
      out.push({
        id: pid, name: r.provider_name || r.label || "平台",
        usage: platUsageShape(r), _src: "platform", _pending: null,
      });
    }
  }
  return out;
}

function unifiedEmptyHtml() {
  const c = (state.platform && state.platform.creds) || {};
  const anyCfg = Object.values(c).some((x) => x && x.configured);
  const u = (state.platform && state.platform.usage) || {};
  const quotaN = Object.values(u).filter((r) => r && r.status === "ok" && r.mode === "quota").length;
  if (quotaN && !anyCfg) {
    /* 只有套餐额度的平台，本来就不会有按天明细 */
    return "已接通的平台只提供套餐额度，无按天明细<br><span style='font-size:11px;color:var(--ink-3)'>额度窗口见上方卡片</span>";
  }
  if (!anyCfg) {
    return "统计区间内暂无用量记录<br><span style='font-size:11px;color:var(--ink-3)'>在 Claude Code / Codex 中调用后，CC Switch 会记录到本地；点「平台凭据」接通官网后可显示账户实扣口径</span>";
  }
  return "统计区间内暂无用量记录<br><span style='font-size:11px;color:var(--ink-3)'>官网与本机记录均未发现该区间内的调用</span>";
}

function unifiedEmptyText() {
  const c = (state.platform && state.platform.creds) || {};
  const anyCfg = Object.values(c).some((x) => x && x.configured);
  return `统计区间（${state.rangeDays} 天）内暂无模型用量记录——` +
    (anyCfg ? "官网侧与本机 CC Switch 记录均无数据。"
            : "从 CC Switch 启用对应提供商并调用后会出现在这里；点「平台凭据」接通官网可切换为账户实扣口径。");
}

/* 官网侧卡片：额度窗口 / 待配置 / 异常。usage 模式且正常的由图表承担，不出卡 */
function renderPlatformCards() {
  if (!state.platform) return null;          // 还没读到官网数据，不插卡
  const host = el("div", "plat-cards");
  const u = (state.platform && state.platform.usage) || {};
  const ids = Object.keys(u);
  if (!ids.length) {
    host.appendChild(el("div", "plat-card info",
      "CC Switch 中暂无可对应到官网用量的供应商。接入 DeepSeek / Kimi / 智谱 GLM 后会自动出现在这里，届时可逐家接通官网实扣口径。"));
    return host;
  }
  for (const pid of ids) {
    const r = u[pid] || {};
    if (r.mode === "usage" && r.status === "ok") continue;
    host.appendChild(buildPlatformCard(r));
  }
  if (!host.children.length) return null;
  return host;
}

function buildPlatformCard(r) {
  const name = r.provider_name || r.label || "平台";
  const vis = visFor(name);
  const card = el("article", "plat-card");
  card.style.setProperty("--acc", vis.acc);
  card.style.setProperty("--acc-soft", vis.soft);

  const head = el("div", "pc-head");
  const subParts = [];
  if (r.label) subParts.push(esc(r.label));
  if (r.checked_at) subParts.push("查于 " + esc(r.checked_at.slice(5, 16)));
  head.innerHTML = `<span class="pc-glyph">${esc(vis.glyph)}</span>
    <div class="pc-id"><h3>${esc(name)}</h3><div class="pc-sub">平台侧接口${subParts.length ? " · " + subParts.join(" · ") : ""}</div></div>`;
  head.appendChild(platformStatusPill(r.status));
  card.appendChild(head);

  if (r.status === "ok" && r.mode === "quota") card.appendChild(quotaBody(r));
  else if (r.status === "nokey") card.appendChild(guideBody(r));
  else card.appendChild(errBody(r));
  return card;
}

function platformStatusPill(s) {
  const map = {
    ok: ["正常", "ok"], nokey: ["未配置", "warn"], expired: ["凭据失效", "err"],
    error: ["查询失败", "err"], empty: ["区间内无数据", "warn"],
  };
  const m = map[s] || ["未知", "warn"];
  return el("span", "pc-pill " + m[1], m[0]);
}

function quotaBody(r) {
  const out = el("div");
  const wins = (r.windows || []).filter((w) => w.used_pct != null);
  const main = wins[0];
  const head = el("div", "pc-quota-main");
  head.innerHTML = `<span class="q-num">${main ? Math.max(0, 100 - main.used_pct) : "—"}<small>%</small></span>
    <span class="q-cap">主窗口剩余${r.plan ? " · " + esc(String(r.plan).toUpperCase()) : ""}</span>`;
  out.appendChild(head);

  const lines = el("div", "planline");
  wins.forEach((w, i) => {
    const rem = Math.max(0, 100 - w.used_pct);
    const hot = w.used_pct >= 80;
    const row = el("div", "plan-row");
    row.innerHTML = `<div class="pr-top"><span>${esc(w.name || "窗口 " + (i + 1))}${
        w.reset_at ? " · 重置 " + esc(fmtReset(w.reset_at)) : ""}</span>
      <span>已用 <b style="color:${hot ? "var(--warn)" : "var(--ink)"}">${w.used_pct}%</b> · 余 ${rem}%</span></div>
      <div class="bar"><i class="${hot ? "hot" : ""}" style="width:${Math.min(100, w.used_pct)}%"></i></div>`;
    lines.appendChild(row);
  });
  if (!wins.length) lines.appendChild(el("div", "est-line", "平台未返回额度窗口明细，可前往官网查看。"));
  out.appendChild(lines);
  return out;
}

function guideBody(r) {
  const kind = r.kind || "";
  const spec = (state.platform && state.platform.spec && state.platform.spec[kind]) || {};
  const out = el("div");
  out.appendChild(el("p", "pc-note",
    "尚未配置网页登录凭据。配置后此处将显示该平台<b>账户侧的真实用量</b>（供应商实际扣费口径），而不是本机记录。"));
  if (spec.howto && spec.howto.length) {
    const ol = el("ol", "pc-howto");
    ol.innerHTML = spec.howto.map((x) => `<li>${esc(x)}</li>`).join("");
    out.appendChild(ol);
  }
  out.appendChild(platformActs(r, kind, "配置" + (spec.label || "") + "凭据"));
  return out;
}

function errBody(r) {
  const out = el("div");
  const title = r.status === "expired" ? "凭据已失效"
    : r.status === "empty" ? "区间内没有数据" : "查询失败";
  const box = el("div", "errbox");
  box.innerHTML = `<b>${title}</b>　<span>${esc(r.detail || "未知错误")}</span>`;
  out.appendChild(box);
  out.appendChild(platformActs(r, r.kind || "", r.status === "expired" ? "更新凭据" : "检查凭据"));
  return out;
}

function platformActs(r, kind, btnText) {
  const acts = el("div", "pc-acts");
  const b = el("button", "btn btn-primary btn-sm", esc(btnText));
  b.type = "button";
  b.addEventListener("click", () => {
    openPlatformCreds();
    setTimeout(() => focusPlatform(kind), 80);
  });
  acts.appendChild(b);
  const p = state.providers.find((x) => x.id === r.provider_id);
  if (p && p.website_url) {
    const a = el("a", "btn btn-ghost btn-sm", "打开平台 ↗");
    a.href = p.website_url; a.target = "_blank"; a.rel = "noopener";
    acts.appendChild(a);
  }
  return acts;
}

/* 把逐日数据整理成 {date: {seriesKey: value}} + 系列元信息 */
function seriesOfDay(provs, isTok, includeUnmatched) {
  const byModel = state.view === "model";
  const dayMap = {};
  const series = {};
  const valOf = (rec) => isTok
    ? (rec.input || 0) + (rec.output || 0) + (rec.cache_read || 0) + (rec.cache_creation || 0)
    : (rec.cost || 0);
  const add = (d, key, val) => {
    if (!val) return;
    (dayMap[d] || (dayMap[d] = {}))[key] = (dayMap[d][key] || 0) + val;
  };
  const scan = (m, mdays) => {
    series[m] = series[m] || { name: m, acc: colorForModel(m) };
    for (const [d, rec] of Object.entries(mdays || {})) add(d, m, valOf(rec));
  };

  for (const p of provs) {
    if (byModel) {
      for (const [m, mdays] of Object.entries(p.usage.model_days || {})) scan(m, mdays);
    } else {
      series[p.name] = series[p.name] || { name: p.name, acc: visFor(p.name).acc };
      for (const [d, rec] of Object.entries(p.usage.days || {})) add(d, p.name, valOf(rec));
    }
  }
  /* 未归属模型（Codex / 官方直连等）也要进图，否则图会把真实大头漏掉、
     与总览带 / 模型表的口径对不上 */
  if (includeUnmatched !== false) {
    const um = state.dataMain?.usage_unmatched_model_days || {};
    if (byModel) {
      for (const [m, mdays] of Object.entries(um)) scan(m, mdays);
    } else {
      series["未归属"] = series["未归属"] || { name: "未归属", acc: "#64748B" };
      for (const mdays of Object.values(um)) {
        for (const [d, rec] of Object.entries(mdays || {})) add(d, "未归属", valOf(rec));
      }
    }
  }
  return { dayMap, series };
}

function renderChart(provs, opts) {
  opts = opts || {};
  const svg = $("#trendChart");
  const wrap = svg.closest(".chart-wrap");
  const isTok = state.metric === "tokens";
  wrap.querySelector(".chart-empty")?.remove();
  $("#legend").innerHTML = "";

  const { dayMap, series } = seriesOfDay(provs, isTok, opts.includeUnmatched);
  const daysSorted = Object.keys(dayMap).sort();

  if (!provs.length || !daysSorted.length) {
    svg.innerHTML = "";
    $("#legend").innerHTML = "";
    wrap.appendChild(el("div", "chart-empty", opts.emptyHtml ||
      (isTok ? "统计区间内暂无 Token 用量记录"
             : "统计区间内暂无消耗记录<br><span style='font-size:11px;color:var(--ink-3)'>在 Claude Code / Codex 中调用后，CC Switch 会自动记录到本地</span>")));
    return;
  }

  /* 图例：按累计值取前 10 */
  const ranked = Object.keys(series).map((k) => {
    const s = series[k];
    s.total = daysSorted.reduce((acc, d) => acc + (dayMap[d][k] || 0), 0);
    return s;
  }).filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
  const legend = $("#legend");
  for (const s of ranked.slice(0, 10)) {
    legend.appendChild(el("span", "legend-item", `<i style="background:${s.acc}"></i>${esc(s.name)}`));
  }
  if (ranked.length > 10) {
    legend.appendChild(el("span", "legend-item more", `+${ranked.length - 10} 项`));
  }

  const W = 1200, H = 260, padL = 8, padR = 6, padT = 26, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = daysSorted.length;
  const slot = iw / n;
  const bw = Math.max(2, slot * 0.72);
  const totalPerDay = daysSorted.map((d) =>
    Object.values(dayMap[d]).reduce((s, x) => s + x, 0));
  const ymax = niceMax(Math.max(...totalPerDay, isTok ? 0 : 1e-6));

  let g = "";
  for (let t = 0; t <= 4; t++) {
    const y = padT + ih - (ih * t) / 4;
    g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="gline"/>`;
    const lab = isTok ? compactTok(ymax * t / 4) : "$" + (ymax * t / 4).toFixed(ymax < 10 ? 3 : 1);
    g += `<text x="${padL + 4}" y="${y - 4}" class="glab">${lab}</text>`;
  }
  const step = Math.max(1, Math.ceil(n / 26));
  daysSorted.forEach((d, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    const x = padL + i * slot + slot / 2;
    g += `<text x="${x}" y="${H - 6}" class="glab" text-anchor="middle">${d.slice(5)}</text>`;
  });

  /* 渐变色定义 */
  const gradIds = [];
  g += `<defs>`;
  for (const s of ranked) {
    const id = "g" + s.acc.slice(1);
    if (!gradIds.includes(id)) {
      gradIds.push(id);
      g += `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${lighten(s.acc, 18)}"/><stop offset="100%" stop-color="${s.acc}"/></linearGradient>`;
    }
  }
  g += `</defs>`;

  /* 柱子：由底向上叠加，顶部圆角 */
  const tops = [];
  daysSorted.forEach((d, i) => {
    const rec = dayMap[d] || {};
    const segs = Object.keys(rec)
      .map((k) => ({ name: k, acc: series[k].acc, val: rec[k] }))
      .sort((a, b) => b.val - a.val);
    const x = padL + i * slot + (slot - bw) / 2;
    let y0 = padT + ih;
    for (const s of segs) {
      const h = ymax > 0 ? (s.val / ymax) * ih : 0;
      const y = y0 - h;
      const tip = (s.val / (totalPerDay[i] || 1)) * 100;
      const r = Math.min(3.5, Math.max(0.5, h / 2));
      const gid = "g" + s.acc.slice(1);
      g += `<rect class="tbar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(0.5, h).toFixed(2)}" fill="url(#${gid})" rx="${r.toFixed(2)}">
        <title>${esc(s.name)} · ${d}${isTok ? " · " + compactTok(s.val) + " tokens" : " · $" + s.val.toFixed(4)}（占当日 ${tip.toFixed(0)}%）</title></rect>`;
      y0 = y;
    }
    tops.push({ x: x + bw / 2, y: y0 });
  });

  /* 总量趋势线 */
  if (tops.length > 1) {
    const path = tops.map((p, i) => (i === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");
    g += `<path d="${path}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-opacity=".18" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"/>`;
  }

  svg.innerHTML = g;
}

function lighten(hex, percent) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.min(255, Math.round(v + (255 - v) * percent / 100));
  return "#" + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const d = v / p;
  const m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 2.5 ? 2.5 : d <= 5 ? 5 : 10;
  return m * p;
}

function renderModelTable(provs, opts) {
  opts = opts || {};
  const byModel = state.view === "model";
  const unmatched = opts.unmatchedModels != null ? opts.unmatchedModels
    : (state.dataMain?.usage_unmatched_models || []);
  const base = [];

  /* 模型 → 涉及哪些提供商（含未归属），用于「按模型」视图首列 */
  const provsOfModel = {};
  const touch = (model, name, acc) => {
    const arr = provsOfModel[model] || (provsOfModel[model] = []);
    if (!arr.some((x) => x.name === name)) arr.push({ name, acc });
  };

  for (const p of provs) {
    const u = p.usage || zeroUsage();
    const vis = visFor(p.name);
    const lastDay = Object.entries(u.days || {}).filter(([, r]) =>
        r.requests > 0 || r.cost > 0 ||
        ((r.input || 0) + (r.output || 0) + (r.cache_read || 0)) > 0)
      .map(([d]) => d).sort().pop() || null;
    for (const m of u.models || []) {
      touch(m.model, p.name, vis.acc);
      base.push({
        pid: p.id, name: p.name, acc: vis.acc, model: m.model,
        req: m.requests, inp: m.input, out: m.output, cache: m.cache_read,
        cost: m.cost, last: lastDay, costOnly: !!m.costOnly, noReq: !!m.noRequests,
      });
    }
  }
  /* 未归属到任何 CC Switch 提供商的模型（如直连官方 API、Codex 等） */
  for (const m of unmatched) {
    touch(m.model, "未归属", "#64748B");
    base.push({
      pid: "__unmatched__", name: "未归属", acc: "#64748B", model: m.model,
      req: m.requests, inp: m.input, out: m.output, cache: m.cache_read,
      cost: m.cost, last: null,
    });
  }

  /* 按模型汇总：同一模型跨多个提供商的用量合并 */
  let rows = base;
  if (byModel) {
    const agg = {};
    for (const r of base) {
      const o = agg[r.model] || (agg[r.model] = {
        model: r.model, req: 0, inp: 0, out: 0, cache: 0, cost: 0, last: null,
        costOnly: true, noReq: true, provs: provsOfModel[r.model] || [],
      });
      o.req += r.req; o.inp += r.inp; o.out += r.out; o.cache += r.cache; o.cost += r.cost;
      if (!r.costOnly) o.costOnly = false;   /* 只要有一家给出 token 口径，就照常显示 */
      if (!r.noReq) o.noReq = false;         /* 只要有一家给出请求数，就照常显示 */
      if (r.last && (!o.last || r.last > o.last)) o.last = r.last;
    }
    rows = Object.values(agg);
  }
  rows.sort((a, b) => b.cost - a.cost);
  const sumCost = rows.reduce((s, r) => s + r.cost, 0) || 1e-9;

  const tbody = $("#modelRows");
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr class="no-rows"><td colspan="9">${opts.emptyText ||
      `统计区间（${state.rangeDays} 天）内暂无模型用量记录——从 CC Switch 启用对应提供商并调用后会自动出现。`}</td></tr>`;
    $("#tableNote").textContent = opts.noteText || "";
    return;
  }

  const firstCell = (r) => {
    if (!byModel) {
      return `<span class="pname"><i class="pd" style="background:${r.acc}"></i>${esc(r.name)}</span>`;
    }
    return `<span class="pstack">` + (r.provs || []).map((x) =>
      `<span class="pname"><i class="pd" style="background:${x.acc}"></i>${esc(x.name)}</span>`
    ).join("") + `</span>`;
  };

  const tot = { req: 0, inp: 0, out: 0, cache: 0, cost: 0 };
  const anyTok = rows.some((r) => !r.costOnly);
  const anyReq = rows.some((r) => !r.costOnly && !r.noReq);
  const cell = (on, v) => `<td class="num">${on ? fullNum(v) : "—"}</td>`;
  for (const r of rows) {
    tot.req += r.req; tot.inp += r.inp; tot.out += r.out; tot.cache += r.cache; tot.cost += r.cost;
    const pct = (r.cost / sumCost) * 100;
    const barAcc = byModel ? ((r.provs && r.provs[0] && r.provs[0].acc) || "#64748B") : r.acc;
    const tr = el("tr");
    tr.innerHTML = `
      <td>${firstCell(r)}</td>
      <td><span class="mname">${esc(r.model)}</span>${r.costOnly ? '<span class="costonly-tag" title="该平台官网只提供金额，无 token / 请求数口径">金额口径</span>' : ""}${r.noReq && !r.costOnly ? '<span class="costonly-tag" title="该平台官网账单不提供请求数，仅有 token 与金额">无请求数</span>' : ""}</td>
      ${cell(!r.costOnly && !r.noReq, r.req)}
      ${cell(!r.costOnly, r.inp)}
      ${cell(!r.costOnly, r.out)}
      ${cell(!r.costOnly, r.cache)}
      <td class="num cost">${fmtUSD(r.cost)}</td>
      <td class="num">${pct.toFixed(1)}%<span class="bar-mini"><i style="width:${Math.min(100, pct)}%;background:${barAcc}"></i></span></td>
      <td class="num dim">${r.last ? esc(r.last.slice(5)) : "—"}</td>`;
    tbody.appendChild(tr);
  }
  /* 合计行 */
  const trT = el("tr", "total-row");
  trT.innerHTML = `
    <td>${byModel ? "合计" : "全部"}</td>
    <td class="mname">${rows.length} ${byModel ? "个模型" : "条记录"}</td>
    ${cell(anyReq, tot.req)}
    ${cell(anyTok, tot.inp)}
    ${cell(anyTok, tot.out)}
    ${cell(anyTok, tot.cache)}
    <td class="num cost">${fmtUSD(tot.cost)}</td>
    <td class="num">100.0%</td>
    <td class="num dim">—</td>`;
  tbody.appendChild(trT);

  const unr = state.dataMain?.usage_unmatched;
  const unrModels = unmatched.length;
  $("#tableNote").textContent = opts.noteText || ((byModel
    ? `范围：最近 ${state.rangeDays} 天 · 按模型汇总（${rows.length} 个模型），跨提供商的同名模型已合并，首列标注来源。`
    : `范围：最近 ${state.rangeDays} 天 · 按「提供商 × 模型」展开（${rows.length} 条）。`)
    + (unr && unr.requests
      ? ` 含 ${unrModels} 个未归属模型（灰色），通常来自 Claude 官方 / Codex 直连等未在 CC Switch 中配置的通道。`
      : ` 用量与金额来自 CC Switch 本地记录（会话日志 / 代理日志），费用为估算口径。`));
}

/* ---------- 设置 ---------- */
function openSettings() {
  const cfg = state.cfg || {};
  $("#cfgRefresh").value = cfg.refresh_seconds ?? 300;
  $("#cfgLow").value = cfg.low_balance_cny ?? 30;
  $("#cfgDays").value = cfg.days_default ?? 30;
  const box = $("#rechargeEdits");
  box.innerHTML = "";
  const names = state.providers.map((p) => p.name);
  if (!names.length) names.push("DeepSeek", "Kimi", "Zhipu GLM");
  for (const n of names) {
    const row = el("div", "re-edit");
    row.innerHTML = `<span class="re-name">${esc(n)}</span>
      <input type="url" data-name="${esc(n)}" placeholder="https://…" value="${esc(state.recharge[n] || "")}">
      <span class="hint">留空用默认</span>`;
    box.appendChild(row);
  }
  /* 按提供商单独设余额预警金额（留空＝用上面的全局默认） */
  const lbox = $("#lowEdits");
  if (lbox) {
    lbox.innerHTML = "";
    const m = cfg.low_balance_by_provider || {};
    const def = cfg.low_balance_cny ?? 30;
    for (const n of names) {
      const set = m[n] != null && m[n] !== "";
      const row = el("div", "re-edit re-num");
      row.innerHTML = `<span class="re-name">${esc(n)}</span>
        <input type="number" data-name="${esc(n)}" min="0" max="100000" step="1"
          placeholder="默认 ${esc(String(def))}" value="${set ? esc(String(m[n])) : ""}">
        <span class="hint">${set ? "已单独设置" : "留空＝用默认"}</span>`;
      lbox.appendChild(row);
    }
  }
  $("#settingsModal").hidden = false;
}
function closeSettings() { $("#settingsModal").hidden = true; }

async function saveSettings() {
  const payload = {
    refresh_seconds: parseInt($("#cfgRefresh").value, 10) || 300,
    low_balance_cny: parseFloat($("#cfgLow").value) || 0,
    days_default: parseInt($("#cfgDays").value, 10) || 30,
    recharge_urls: {},
    low_balance_by_provider: {},
  };
  document.querySelectorAll("#rechargeEdits .re-edit").forEach((row) => {
    const inp = row.querySelector("input");
    const name = inp.dataset.name;
    const v = inp.value.trim();
    if (v) payload.recharge_urls[name] = v;
  });
  document.querySelectorAll("#lowEdits .re-edit").forEach((row) => {
    const inp = row.querySelector("input");
    const v = inp.value.trim();
    const n = parseFloat(v);
    if (v !== "" && isFinite(n) && n > 0) payload.low_balance_by_provider[inp.dataset.name] = n;
  });
  try {
    await postJSON("/api/config", payload);
    state.recharge = { ...state.recharge, ...payload.recharge_urls };
    state.cfg = { ...(state.cfg || {}), refresh_seconds: payload.refresh_seconds,
      low_balance_cny: payload.low_balance_cny, days_default: payload.days_default,
      low_balance_by_provider: payload.low_balance_by_provider };
    // 同步默认统计天数
    state.rangeDays = payload.days_default;
    document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.days === state.rangeDays));
    closeSettings();
    toast("设置已保存");
    scheduleAuto();
    refreshAll(true);
  } catch (e) {
    toast("保存失败：" + e.message, true);
  }
}

/* ---------- 平台凭据 ---------- */
function openPlatformCreds() {
  buildPlatformForm();
  $("#platformModal").hidden = false;
}
function closePlatformCreds() { $("#platformModal").hidden = true; }

function collectFields(block) {
  const out = {};
  block.querySelectorAll("input[data-key]").forEach((i) => { out[i.dataset.key] = i.value.trim(); });
  return out;
}

function buildPlatformForm() {
  const host = $("#platformForm");
  if (!host) return;
  host.innerHTML = "";
  const plat = state.platform || {};
  const spec = plat.spec || {};
  const creds = plat.creds || {};
  const order = Object.keys(spec);
  if (!order.length) {
    host.appendChild(el("p", "modal-note", "未能读取平台配置，请先刷新页面。"));
    return;
  }
  for (const kind of order) {
    const s = spec[kind] || {};
    const cm = creds[kind] || {};
    const vis = visFor(s.label || kind);
    const block = el("div", "pf-block" + (cm.configured ? " on" : ""));
    block.dataset.kind = kind;
    block.style.setProperty("--acc", vis.acc);
    block.style.setProperty("--acc-soft", vis.soft);

    const head = el("div", "pf-head");
    head.innerHTML = `<span class="pf-glyph">${esc(vis.glyph)}</span>
      <span class="pf-name">${esc(s.label || kind)}</span>
      <span class="pf-badge ${cm.configured ? "ok" : ""}">${cm.configured ? "已配置" : "未配置"}</span>
      <span class="pf-mode">${s.mode === "quota" ? "套餐额度窗口" : "按模型 / 按天明细"}</span>`;
    block.appendChild(head);

    /* 票据期限：Kimi 精确到日（JWT exp）；智谱为经验估算；DeepSeek 为长效凭据 */
    const exT = expiryText(cm.expiry);
    if (exT) {
      const el2 = el("div", "pf-exp" + (exT.cls ? " " + exT.cls : ""));
      el2.title = exT.tip || "";
      el2.innerHTML = `<span class="pf-exp-k">登录票据</span> <b>${esc(exT.txt)}</b>` +
        (exT.est ? `<span class="pf-exp-est">估算</span>` : "") +
        (exT.cls === "warn" || exT.cls === "urgent" || exT.cls === "err"
          ? `<span class="pf-exp-tip">${esc(exT.tip || "")}</span>` : "");
      block.appendChild(el2);
    }

    const fields = el("div", "pf-fields");
    for (const f of (s.fields || [])) {
      const masked = cm.masked ? cm.masked[f.key] : "";
      const row = el("div", "pf-field");
      row.innerHTML = `<label class="pf-label" for="pf-${kind}-${f.key}">${esc(f.label)}</label>
        <input id="pf-${kind}-${f.key}" type="text" data-key="${esc(f.key)}" autocomplete="off"
          spellcheck="false" placeholder="${esc(f.hint || "")}" value="">
        <div class="pf-meta">${masked ? `当前：<code>${esc(masked)}</code> · ` : ""}留空则不修改${cm.configured ? "；三项全空可清除" : ""}</div>`;
      fields.appendChild(row);
    }
    block.appendChild(fields);

    if (s.howto && s.howto.length) {
      const how = el("details", "pf-how");
      how.innerHTML = `<summary>凭据怎么拿？（点开查看步骤）</summary>
        <ol>${s.howto.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
      block.appendChild(how);
    }

    const acts = el("div", "pf-acts");
    const test = el("button", "btn btn-ghost btn-sm", "测试连接");
    const save = el("button", "btn btn-primary btn-sm", "保存");
    const clr = el("button", "btn btn-ghost btn-sm pf-danger", "清除");
    test.type = save.type = clr.type = "button";
    const res = el("span", "pf-res", "");
    acts.appendChild(test); acts.appendChild(save); acts.appendChild(clr); acts.appendChild(res);
    block.appendChild(acts);

    test.addEventListener("click", () => testPlatform(kind, block, res, test));
    save.addEventListener("click", () => savePlatform(kind, block, save));
    clr.addEventListener("click", () => clearPlatform(kind));

    host.appendChild(block);
  }
  $("#platformFootNote").textContent = "凭据仅存本机，不上传、不同步 CC Switch。";
}

function focusPlatform(kind) {
  if (!kind) return;
  const b = document.querySelector('#platformForm .pf-block[data-kind="' + kind + '"]');
  if (!b) return;
  b.scrollIntoView({ block: "center", behavior: "smooth" });
  b.classList.add("flash");
  setTimeout(() => b.classList.remove("flash"), 1300);
  const inp = b.querySelector("input[data-key]");
  if (inp) inp.focus();
}

async function testPlatform(kind, block, resEl, btn) {
  const fields = collectFields(block);
  if (!Object.values(fields).some((v) => v)) {
    toast("请先填写凭据再测试", true);
    return;
  }
  btn.classList.add("loading");
  resEl.className = "pf-res";
  resEl.textContent = "测试中…";
  try {
    const j = await postJSON("/api/platform_test", { kind, fields });
    const r = j.result || {};
    if (r.status === "ok") {
      resEl.className = "pf-res ok";
      resEl.textContent = r.mode === "quota"
        ? "连接成功 · 读到 " + (r.windows || []).length + " 个额度窗口"
        : "连接成功 · " + (r.models || []).length + " 个模型 · " +
          fmtUSD((r.totals && r.totals.cost) || 0) + " 消耗";
    } else {
      resEl.className = "pf-res err";
      resEl.textContent = r.detail || "测试失败";
    }
  } catch (e) {
    resEl.className = "pf-res err";
    resEl.textContent = "测试失败：" + e.message;
  } finally {
    btn.classList.remove("loading");
  }
}

async function savePlatform(kind, block, btn) {
  const fields = collectFields(block);
  btn.classList.add("loading");
  try {
    const j = await postJSON("/api/platform_creds", { kind, fields });
    if (j.creds && state.platform) state.platform.creds = j.creds;
    const label = (state.platform && state.platform.spec && state.platform.spec[kind] &&
      state.platform.spec[kind].label) || "";
    toast("已保存" + label + "凭据，正在拉取官网用量…");
    state.platSig = null;                  // 强制下一次重绘
    buildPlatformForm();
    await refreshAll(true);
  } catch (e) {
    toast("保存失败：" + e.message, true);
  } finally {
    btn.classList.remove("loading");
  }
}

async function clearPlatform(kind) {
  const spec = (state.platform && state.platform.spec && state.platform.spec[kind]) || {};
  const fields = {};
  for (const f of (spec.fields || [])) fields[f.key] = "";
  try {
    const j = await postJSON("/api/platform_creds", { kind, fields });
    if (j.creds && state.platform) state.platform.creds = j.creds;
    toast("已清除凭据");
    buildPlatformForm();
    await refreshAll(true);
  } catch (e) {
    toast("清除失败：" + e.message, true);
  }
}

/* ---------- 定时刷新 ---------- */
function scheduleAuto() {
  if (state.timer) clearInterval(state.timer);
  const sec = (state.cfg && state.cfg.refresh_seconds) || 300;
  if (sec > 0) state.timer = setInterval(() => refreshAll(true), Math.max(30, sec) * 1000);
}
/* 官网用量独立轮询：比本地记录刷新得更勤，保证「实时」 */
function schedulePlatform() {
  if (state.platTimer) clearInterval(state.platTimer);
  state.platTimer = setInterval(() => refreshPlatform(true), 60000);
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $("#btnTheme").addEventListener("click", toggleTheme);
  $("#btnRefresh").addEventListener("click", () => refreshAll(false));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnCloseSettings").addEventListener("click", closeSettings);
  $("#btnCancelSettings").addEventListener("click", closeSettings);
  $("#btnSaveSettings").addEventListener("click", saveSettings);
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#settingsModal").hidden) closeSettings();
    if (e.key === "Escape" && !$("#platformModal").hidden) closePlatformCreds();
  });

  const pc = $("#btnPlatformCreds");
  if (pc) pc.addEventListener("click", openPlatformCreds);
  const pcl = $("#btnClosePlatform");
  if (pcl) pcl.addEventListener("click", closePlatformCreds);
  const pcl2 = $("#btnClosePlatform2");
  if (pcl2) pcl2.addEventListener("click", closePlatformCreds);
  const pm = $("#platformModal");
  if (pm) pm.addEventListener("click", (e) => { if (e.target.id === "platformModal") closePlatformCreds(); });

  $("#rangeSeg").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("#rangeSeg button").forEach((x) => x.classList.toggle("on", x === b));
    state.rangeDays = +b.dataset.days;
    await refreshAll(true);
  });

  $("#viewSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("#viewSeg button").forEach((x) => x.classList.toggle("on", x === b));
    state.view = b.dataset.view;
    const hint = $("#viewHint");
    if (hint) hint.textContent = state.view === "model"
      ? "按模型汇总，跨提供商的同名模型已合并"
      : "按「提供商 × 模型」展开，逐条列出";
    renderDetail();
  });

  document.querySelectorAll(".chart-toggle input").forEach((r) => {
    r.addEventListener("change", () => {
      state.metric = r.value;
      renderDetail();
    });
  });
}

/* ---------- 启动 ---------- */
(async function init() {
  bind();
  initTheme();
  try {
    await loadConfig();
  } catch (e) {}
  const cfg = state.cfg || {};
  const d = parseInt((new URLSearchParams(location.search).get("days")) || "", 10);
  state.rangeDays = (d >= 7 && d <= 365) ? d : (cfg.days_default || 30);
  document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.days === state.rangeDays));
  scheduleAuto();
  schedulePlatform();
  startProviderWatcher();
  await refreshAll(false);
})();
