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
    q: "",
    vendor: "",
    onlySel: false,
    limit: 120,
    sel: new Set(),
  };

  const $id = (x) => document.getElementById(x);

  function loadSel() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(raw)) raw.forEach((x) => S.sel.add(String(x)));
    } catch (e) { /* 忽略坏数据 */ }
  }
  function saveSel() {
    try { localStorage.setItem(KEY, JSON.stringify([...S.sel])); } catch (e) { /* 忽略 */ }
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

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return S.all.filter((m) => {
      if (S.vendor && m.driver !== S.vendor) return false;
      if (S.onlySel && !S.sel.has(m.id)) return false;
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

    host.innerHTML = slice.map((m) => {
      const on = S.sel.has(m.id);
      const pin = (m.cny || {}).in, pout = (m.cny || {}).out;
      const free = pin === 0 && pout === 0;
      return '<label class="mrow' + (on ? " on" : "") + '" data-id="' + m.id + '">' +
        '<input type="checkbox"' + (on ? " checked" : "") + '>' +
        '<span class="mdot" style="background:' + colorOf(m.driver) + '"></span>' +
        '<span class="mrow-n"><b>' + m.name + '</b><small>' + m.id + "</small></span>" +
        '<span class="mrow-v">' + labelOf(m.driver) + "</span>" +
        '<span class="mrow-tag">' + (m.vision ? "视觉" : "文本") + "</span>" +
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

    host.querySelectorAll(".mrow").forEach((row) => {
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
    host.textContent = data.total
      ? data.total + " 个模型 · " + vendors + " 个厂商分组 · 目录更新于 " + (when || "—") +
        (data.stale ? "（缓存已过期，正在用旧数据）" : "")
      : "目录为空";
  }

  async function load(force) {
    if (S.loading) return;
    S.loading = true;
    const btn = $id("mdlRefresh");
    if (btn) btn.classList.add("loading");
    try {
      const r = await fetch("/api/catalog?full=1" + (force ? "&refresh=1" : ""));
      const j = await r.json();
      S.all = (j.models || []).slice();
      S.groups = j.groups || [];
      S.loaded = true;
      renderChips();
      renderMeta(j);
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

  return { load, get loaded() { return S.loaded; }, sel: S.sel };
})();
window.MDL = MDL;
