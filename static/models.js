/* ============================================================
   模型页：公开目录 → 可勾选清单
   数据源 /api/catalog?full=1（服务端 24h 缓存）
   勾选结果存 localStorage，供后续「只统计我用到的模型」使用
   ============================================================ */
"use strict";

const MDL = (function () {
  const KEY = "tokenwatch-models";
  const S = {
    loaded: false,
    loading: false,
    all: [],
    groups: [],
    accounts: [],
    q: "",
    vendor: "",
    onlySel: false,
    onlyAcc: false,
    limit: 120,
    sel: new Set(),
  };

  const $id = (x) => document.getElementById(x);

  /* 表头（跟着 renderList 一起重绘，列宽与 .mrow 网格严丝合缝） */
  const HEAD = '<div class="mrow mrow-h" aria-hidden="true"><span></span><span></span>' +
    "<span>模型</span><span>厂商</span><span>接入</span><span>上下文</span>" +
    "<span>输入 / 百万</span><span>输出 / 百万</span></div>";

  function loadSel() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(raw)) raw.forEach((x) => S.sel.add(String(x)));
    } catch (e) { /* 忽略坏数据 */ }
  }
  function saveSel() {
    try { localStorage.setItem(KEY, JSON.stringify([...S.sel])); } catch (e) { /* 忽略 */ }
    notify();
  }

  /* 通知其他页面：关注清单变了，总览/定价要按新清单重算 */
  function notify() {
    try {
      if (typeof window.onModelSelChange === "function") window.onModelSelChange([...S.sel]);
    } catch (e) { /* 通知失败不影响勾选本身 */ }
  }

  /* 外部整体替换（过滤提示条上的「清除筛选」用） */
  function setSel(arr) {
    S.sel = new Set((arr || []).map(String));
    saveSel();
    renderCount();
    if (S.loaded) renderList();
  }

  function fmtPrice(v) {
    if (v == null) return "—";
    if (v === 0) return "免费";
    if (v < 0.01) return "¥" + v.toFixed(4);
    if (v < 10) return "¥" + v.toFixed(2);
    return "¥" + v.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  }

  function ctxText(n) {
    n = Number(n || 0);
    if (!n) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "K";
    return String(n);
  }

  function colorOf(driver) {
    const g = S.groups.find((x) => x.driver === driver);
    return g ? g.color : "var(--ink-3)";
  }
  function labelOf(driver) {
    const g = S.groups.find((x) => x.driver === driver);
    return g ? g.label : driver;
  }

  /* 哪些已接入账户能提供这个模型：按驱动匹配，或账户显式指定了该模型 */
  function accountsFor(m) {
    const accs = S.accounts || [];
    return accs.filter((a) =>
      (a.driver === m.driver) || ((a.models || []).indexOf(m.id) >= 0));
  }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return S.all.filter((m) => {
      if (S.vendor && m.driver !== S.vendor) return false;
      if (S.onlySel && !S.sel.has(m.id)) return false;
      if (S.onlyAcc && !accountsFor(m).length) return false;
      if (!q) return true;
      return (m.name + " " + m.id + " " + m.vendor).toLowerCase().includes(q);
    });
  }

  function renderChips() {
    const host = $id("mdlVendors");
    if (!host) return;
    const total = S.all.length;
    const chips = ['<button type="button" class="mdl-chip' + (S.vendor ? "" : " on") +
      '" data-v=""><span>全部</span><em>' + total + "</em></button>"];
    S.groups.forEach((g) => {
      chips.push('<button type="button" class="mdl-chip' + (S.vendor === g.driver ? " on" : "") +
        '" data-v="' + g.driver + '"><i style="background:' + g.color + '"></i><span>' +
        g.label + "</span><em>" + g.count + "</em></button>");
    });
    host.innerHTML = chips.join("");
  }

  function renderList() {
    const host = $id("mdlList");
    if (!host) return;
    const rows = filtered();
    const slice = rows.slice(0, S.limit);

    if (!S.all.length) {
      host.innerHTML = '<div class="mdl-more">目录还没拉到。检查网络后点右上角「更新目录」。</div>';
      return;
    }
    if (!rows.length) {
      host.innerHTML = '<div class="mdl-more">没有符合条件的模型。</div>';
      return;
    }

    host.innerHTML = HEAD + slice.map((m) => {
      const on = S.sel.has(m.id);
      const pin = (m.cny || {}).in, pout = (m.cny || {}).out;
      const free = pin === 0 && pout === 0;
      const accs = accountsFor(m);
      const accTip = accs.length
        ? "已接入：" + accs.map((a) => a.name).join("、")
        : "还没接入提供这个模型的账户，只能在「账户」页接入后采集用量";
      return '<label class="mrow' + (on ? " on" : "") + '" data-id="' + m.id + '">' +
        '<input type="checkbox"' + (on ? " checked" : "") + '>' +
        '<span class="mdot" style="background:' + colorOf(m.driver) + '"></span>' +
        '<span class="mrow-n"><b>' + m.name + '</b><small>' + m.id + "</small></span>" +
        '<span class="mrow-v">' + labelOf(m.driver) + "</span>" +
        '<span class="mrow-tag' + (accs.length ? " on" : "") + '" title="' + esc(accTip) + '">' +
          (accs.length ? accs.length + " 个已接" : "未接入") + "</span>" +
        '<span class="mrow-ctx">' + ctxText(m.context) + "</span>" +
        '<span class="mrow-p' + (free ? " free" : "") + '"><b>' + fmtPrice(pin) + "</b><small>输入 / 百万</small></span>" +
        '<span class="mrow-p' + (free ? " free" : "") + '"><b>' + fmtPrice(pout) + "</b><small>输出 / 百万</small></span>" +
        "</label>";
    }).join("") +
      (rows.length > slice.length
        ? '<div class="mdl-more">已显示 ' + slice.length + " / " + rows.length +
          ' 个 · <button type="button" id="mdlMore">再加载 120 个</button></div>'
        : "");

    const more = $id("mdlMore");
    if (more) more.addEventListener("click", () => { S.limit += 120; renderList(); });

    host.querySelectorAll(".mrow[data-id]").forEach((row) => {
      const cb = row.querySelector("input");
      const id = row.dataset.id;
      cb.addEventListener("change", () => {
        if (cb.checked) S.sel.add(id); else S.sel.delete(id);
        row.classList.toggle("on", cb.checked);
        saveSel();
        renderCount();
        if (S.onlySel) renderList();
      });
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT") e.stopPropagation();
      });
    });
  }

  function renderCount() {
    const n = $id("mdlSelN");
    const t = $id("mdlTotalN");
    if (n) n.textContent = S.sel.size;
    if (t) t.textContent = S.all.length;
  }

  function renderMeta(data) {
    const host = $id("mdlMeta");
    if (!host) return;
    const when = (data.fetched_at || "").replace("T", " ").slice(0, 16);
    const vendors = S.groups.length;
    const mine = S.all.filter((m) => accountsFor(m).length).length;
    host.textContent = data.total
      ? data.total + " 个模型 · " + vendors + " 个厂商分组 · 目录更新于 " + (when || "—") +
        (S.accounts.length ? " · 其中 " + mine + " 个有已接入的账户能提供" : " · 还没接入任何账户") +
        (data.stale ? "（缓存已过期，正在用旧数据）" : "")
      : "目录为空";
  }

  /* 官网账单里真实出现过的模型名。
     为什么需要这一块：目录 id（driver/name）与账单里的模型名经常不是同一个字符串，
     勾目录条目会出现「已选 1 个，但命中 0 个」。这里直接给账单真名，勾了必然匹配。 */
  function liveModels() {
    const u = (typeof state !== "undefined" && state.platform && state.platform.usage) || {};
    const map = {};
    for (const pid of Object.keys(u)) {
      const r = u[pid];
      if (!r || !Array.isArray(r.models)) continue;
      const plat = r.provider_name || r.label || pid;
      for (const m of r.models) {
        const name = String(m.model || m.name || "").trim();
        if (!name) continue;
        const cur = map[name] || (map[name] = { name, platform: plat, cost: 0, req: 0 });
        cur.cost += Number(m.cost) || 0;
        cur.req += Number(m.requests) || 0;
      }
    }
    return Object.values(map).sort((a, b) => b.cost - a.cost).slice(0, 30);
  }

  function renderLive() {
    const host = $id("mdlLive");
    if (!host) return;
    const items = liveModels();
    if (!items.length) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    const n = items.filter((x) => S.sel.has(x.name)).length;
    host.innerHTML =
      '<div class="mdl-live-h">你实际用过的模型 · 官网账单真名' +
      "<em>勾这里才能对上账单（已选 " + n + " 个）；勾目录里的变体可能匹配不上</em></div>" +
      '<div class="mdl-live-chips">' + items.map((x) => {
        const on = S.sel.has(x.name);
        return '<button type="button" class="mdl-live-chip' + (on ? " on" : "") +
          '" data-m="' + esc(x.name) + '" title="' + esc(x.platform) + " · 区间累计 ¥" +
          (x.cost || 0).toFixed(2) + '">' + esc(x.name) +
          "<small>" + esc(x.platform) + "</small></button>";
      }).join("") + "</div>";

    host.querySelectorAll(".mdl-live-chip").forEach((b) => {
      b.addEventListener("click", () => {
        const name = b.dataset.m;
        if (S.sel.has(name)) S.sel.delete(name); else S.sel.add(name);
        b.classList.toggle("on", S.sel.has(name));
        saveSel();
        renderCount();
        renderList();
        renderLive();
      });
    });
  }

  async function load(force) {
    if (S.loading) return;
    S.loading = true;
    const btn = $id("mdlRefresh");
    if (btn) btn.classList.add("loading");
    try {
      /* 目录与账户清单一起拉：行里要标「这个模型有没有已接入的账户能提供」 */
      const [jr, ja] = await Promise.all([
        fetch("/api/catalog?full=1" + (force ? "&refresh=1" : "")).then((r) => r.json()),
        fetch("/api/accounts").then((r) => r.json()).catch(() => null),
      ]);
      S.all = (jr.models || []).slice();
      S.groups = jr.groups || [];
      if (ja) S.accounts = ja.accounts || [];
      S.loaded = true;
      renderChips();
      renderMeta(jr);
      renderLive();
      renderList();
      renderCount();
    } catch (e) {
      const host = $id("mdlMeta");
      if (host) host.textContent = "目录读取失败：" + e.message;
    } finally {
      S.loading = false;
      if (btn) btn.classList.remove("loading");
    }
  }

  function bind() {
    loadSel();
    const q = $id("mdlSearch");
    if (q) q.addEventListener("input", () => { S.q = q.value; S.limit = 120; renderList(); });
    const only = $id("mdlOnlySel");
    if (only) only.addEventListener("change", () => {
      S.onlySel = only.checked;
      S.limit = 120;
      renderList();
    });
    const onlyAcc = $id("mdlOnlyAcc");
    if (onlyAcc) onlyAcc.addEventListener("change", () => {
      S.onlyAcc = onlyAcc.checked;
      S.limit = 120;
      renderList();
    });
    const rf = $id("mdlRefresh");
    if (rf) rf.addEventListener("click", () => load(true));
    const chips = $id("mdlVendors");
    if (chips) chips.addEventListener("click", (e) => {
      const b = e.target.closest(".mdl-chip");
      if (!b) return;
      S.vendor = b.dataset.v || "";
      S.limit = 120;
      renderChips();
      renderList();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  return {
    load, setSel, renderLive,
    get loaded() { return S.loaded; },
    get sel() { return S.sel; },
  };
})();
window.MDL = MDL;
