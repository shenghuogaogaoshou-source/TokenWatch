/* ============================================================
   模型选择器（通用弹窗）
   ------------------------------------------------------------
   三个地方共用它，避免三套逻辑各自跑偏：
   1) 模型页：设置「我关心的模型」（全局，存 localStorage）
   2) 账户卡：设置「这个账户开放哪些模型」（存 accounts.models）
   3) 接入向导：新账户接进来后顺手选开放模型

   约定：空选择 = 不限制（显示全部），而不是「什么都不要」。
   这样默认行为永远和没这个功能时一致，不会一升级就空屏。
   ============================================================ */
"use strict";

const PICKER = (function () {
  const $id = (x) => document.getElementById(x);
  let DATA = null;            // { models, groups } 目录缓存
  let LOADING = null;

  const S = {
    q: "", vendor: "", limit: 100,
    sel: new Set(),
    base: new Set(),          // 打开时的已选（用于「还原」）
    onSave: null,
    title: "",
    hint: "",
    driver: "",               // 只显示该驱动的模型（可选）
  };

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function fmtPrice(v) {
    if (v == null) return "—";
    if (v === 0) return "免费";
    if (v < 0.01) return "¥" + Number(v).toFixed(4);
    if (v < 10) return "¥" + Number(v).toFixed(2);
    return "¥" + Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  }

  async function ensure() {
    if (DATA) return DATA;
    if (LOADING) return LOADING;
    LOADING = (async () => {
      const j = await (await fetch("/api/catalog?full=1")).json();
      DATA = { models: j.models || [], groups: j.groups || [] };
      return DATA;
    })();
    try {
      return await LOADING;
    } finally {
      LOADING = null;
    }
  }

  function pool() {
    const all = (DATA && DATA.models) || [];
    if (!S.driver) return all;
    const mine = all.filter((m) => m.driver === S.driver);
    /* 该驱动在目录里没有模型（中转站、自定义站点）时回退全部，
       否则会给出一个空列表，看起来像坏了 */
    return mine.length ? mine : all;
  }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return pool().filter((m) => {
      if (S.vendor && m.driver !== S.vendor) return false;
      if (!q) return true;
      return (m.name + " " + m.id + " " + (m.vendor || "")).toLowerCase().includes(q);
    });
  }

  /* 已选判断要宽松一点：账户里可能存的是官网账单真名（kimi-k3），
     而目录 id 是 moonshot/kimi-k3 —— 不宽松的话会出现「已选 2 个，列表全没勾」。 */
  function pickedOf(m) {
    if (S.sel.has(m.id)) return true;
    const tail = String(m.id).split("/").pop().toLowerCase();
    for (const x of S.sel) {
      const t = String(x).toLowerCase();
      const xt = t.includes("/") ? t.split("/").pop() : t;
      if (t === String(m.id).toLowerCase() || xt === tail) return true;
    }
    return false;
  }

  function toggle(m) {
    if (pickedOf(m)) {
      const tail = String(m.id).split("/").pop().toLowerCase();
      for (const x of [...S.sel]) {
        const t = String(x).toLowerCase();
        const xt = t.includes("/") ? t.split("/").pop() : t;
        if (t === String(m.id).toLowerCase() || xt === tail) S.sel.delete(x);
      }
    } else {
      S.sel.add(m.id);
    }
  }

  function renderChips() {
    const host = $id("pickVendors");
    if (!host) return;
    /* 已经限定在某个平台时，再给一排厂商 chips 只会出现「全部 9 / Kimi 9」这种废话 */
    if (S.driver) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    const src = pool();
    const counts = {};
    src.forEach((m) => { counts[m.driver] = (counts[m.driver] || 0) + 1; });
    const groups = (DATA && DATA.groups) || [];
    const chips = ['<button type="button" class="pick-chip' + (S.vendor ? "" : " on") +
      '" data-v=""><span>全部</span><em>' + src.length + "</em></button>"];
    groups.forEach((g) => {
      const n = counts[g.driver] || 0;
      if (!n) return;
      chips.push('<button type="button" class="pick-chip' + (S.vendor === g.driver ? " on" : "") +
        '" data-v="' + esc(g.driver) + '"><i style="background:' + esc(g.color) + '"></i>' +
        "<span>" + esc(g.label) + "</span><em>" + n + "</em></button>");
    });
    host.innerHTML = chips.join("");
  }

  function renderList() {
    const host = $id("pickList");
    if (!host) return;
    const rows = filtered();
    const slice = rows.slice(0, S.limit);
    if (!rows.length) {
      host.innerHTML = '<div class="pick-empty">' +
        (pool().length ? "没有符合条件的模型，换个关键词试试。" :
          "目录还没读到，检查网络后重试。") + "</div>";
      return;
    }
    host.innerHTML = slice.map((m) => {
      const on = pickedOf(m);
      const pin = (m.cny || {}).in, pout = (m.cny || {}).out;
      return '<label class="pick-row' + (on ? " on" : "") + '" data-id="' + esc(m.id) + '">' +
        '<input type="checkbox"' + (on ? " checked" : "") + ">" +
        '<span class="pick-n"><b>' + esc(m.name) + "</b><small>" + esc(m.id) + "</small></span>" +
        '<span class="pick-d">' + esc(labelOf(m.driver)) + "</span>" +
        '<span class="pick-p"><b>' + fmtPrice(pin) + "</b><small>入</small></span>" +
        '<span class="pick-p"><b>' + fmtPrice(pout) + "</b><small>出</small></span>" +
        "</label>";
    }).join("") + (rows.length > slice.length
      ? '<div class="pick-more">已显示 ' + slice.length + " / " + rows.length +
        ' 个 · <button type="button" id="pickMore">再加载 100 个</button></div>'
      : "");

    const more = $id("pickMore");
    if (more) more.addEventListener("click", () => { S.limit += 100; renderList(); });

    host.querySelectorAll(".pick-row").forEach((row) => {
      const cb = row.querySelector("input");
      const m = slice.find((x) => x.id === row.dataset.id);
      if (!m) return;
      cb.addEventListener("change", () => {
        toggle(m);
        row.classList.toggle("on", pickedOf(m));
        renderCount();
      });
    });
  }

  function labelOf(driver) {
    const g = ((DATA && DATA.groups) || []).find((x) => x.driver === driver);
    return g ? g.label : driver;
  }

  function renderCount() {
    const n = $id("pickN");
    if (n) n.textContent = S.sel.size;
    const b = $id("pickBtnSave");
    if (b) b.textContent = S.sel.size ? "保存（" + S.sel.size + " 个）" : "保存（不限制）";
  }

  function open(opts) {
    opts = opts || {};
    S.q = "";
    S.vendor = "";
    S.limit = 100;
    S.driver = opts.driver || "";
    S.title = opts.title || "选择模型";
    S.hint = opts.hint || "";
    S.onSave = opts.onSave || null;
    S.sel = new Set((opts.selected || []).map(String));
    S.base = new Set(S.sel);

    const mask = $id("pickModal");
    if (!mask) return;
    $id("pickTitle").textContent = S.title;
    $id("pickHint").textContent = S.hint || "空着不选 = 不限制，显示该来源的全部模型。";
    const q = $id("pickSearch");
    if (q) q.value = "";
    mask.hidden = false;
    renderCount();
    $id("pickList").innerHTML = '<div class="pick-empty">正在读取模型目录…</div>';

    ensure().then(() => {
      renderChips();
      renderList();
      renderCount();
    }).catch((e) => {
      $id("pickList").innerHTML = '<div class="pick-empty">目录读取失败：' + esc(e.message) + "</div>";
    });
  }

  function close() {
    const mask = $id("pickModal");
    if (mask) mask.hidden = true;
  }

  function bind() {
    const q = $id("pickSearch");
    if (q) q.addEventListener("input", () => {
      S.q = q.value; S.limit = 100; renderList();
    });
    const chips = $id("pickVendors");
    if (chips) chips.addEventListener("click", (e) => {
      const b = e.target.closest(".pick-chip");
      if (!b) return;
      S.vendor = b.dataset.v || "";
      S.limit = 100;
      renderChips();
      renderList();
    });
    const all = $id("pickAll");
    if (all) all.addEventListener("click", () => {
      filtered().forEach((m) => S.sel.add(m.id));
      renderList();
      renderCount();
    });
    const clr = $id("pickClear");
    if (clr) clr.addEventListener("click", () => {
      S.sel.clear();
      renderList();
      renderCount();
    });
    const cn = $id("pickCancel");
    if (cn) cn.addEventListener("click", close);
    const sv = $id("pickBtnSave");
    if (sv) sv.addEventListener("click", () => {
      const arr = [...S.sel];
      const fn = S.onSave;
      close();
      if (typeof fn === "function") fn(arr);
    });
    const mask = $id("pickModal");
    if (mask) mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  return { open, close, ensure, invalidate() { DATA = null; } };
})();
window.PICKER = PICKER;
