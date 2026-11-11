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
    live: [],                 // 站点实际提供的模型名（中转站用，不走目录）
    liveOnly: false,          // true = 只列站点自己的模型，不掺目录
    allowCustom: false,       // 允许手动敲模型名
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
    /* 中转站：只列站点自己说它有哪些模型。目录里那一堆是别人的菜单，
       在上面勾选对用户毫无意义（他的站点可能根本没有 gpt-5.2）。 */
    if (S.liveOnly) {
      return S.live.map((id) => ({
        id, name: id, driver: "", vendor: "站点", cny: null, __live: true,
      }));
    }
    const all = (DATA && DATA.models) || [];
    if (!S.driver) return all;
    const mine = all.filter((m) => m.driver === S.driver);
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
    /* 已经限定在某个平台 / 只列站点模型时，再给一排厂商 chips 只是废话 */
    if (S.driver || S.liveOnly) { host.hidden = true; host.innerHTML = ""; return; }
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
      host.innerHTML = '<div class="pick-empty">' + (S.liveOnly
        ? "这个站点没返回模型清单。<br>用上面的输入框手动加一个模型名，或者先在站点里确认 /v1/models 是否可用。"
        : (pool().length ? "没有符合条件的模型，换个关键词试试。" :
          "目录还没读到，检查网络后重试。")) + "</div>";
      return;
    }
    host.innerHTML = slice.map((m) => {
      const on = pickedOf(m);
      const pin = (m.cny || {}).in, pout = (m.cny || {}).out;
      /* 站点模型的名字就是 id，再重复一遍没有信息量 */
      const sub = m.__live ? "" : '<small>' + esc(m.id) + "</small>";
      return '<label class="pick-row' + (on ? " on" : "") + '" data-id="' + esc(m.id) + '"' +
        (m.__live ? ' title="站点没有给出单价，按站点计费"' : "") + ">" +
        '<input type="checkbox"' + (on ? " checked" : "") + ">" +
        '<span class="pick-n"><b>' + esc(m.name) + "</b>" + sub + "</span>" +
        '<span class="pick-d">' + esc(m.__live ? "站点" : labelOf(m.driver)) + "</span>" +
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
    S.live = (opts.liveModels || []).map(String);
    S.liveOnly = !!opts.liveOnly;
    S.allowCustom = !!opts.allowCustom;
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
    if (q) {
      q.value = "";
      q.placeholder = S.liveOnly ? "搜索这个站点提供的模型"
        : "搜索模型名或厂商，例如 claude / 通义 / gpt";
    }
    const crow = $id("pickCustomRow");
    if (crow) crow.hidden = !S.allowCustom;
    mask.hidden = false;
    renderCount();
    if (S.liveOnly) {
      /* 站点模型不依赖目录，别为了它去拉 466 条 */
      renderChips();
      renderList();
      return;
    }
    $id("pickList").innerHTML = '<div class="pick-empty">正在读取模型目录…</div>';

    ensure().then(() => {
      renderChips();
      renderList();
      renderCount();
    }).catch((e) => {
      $id("pickList").innerHTML = '<div class="pick-empty">目录读取失败：' + esc(e.message) + "</div>";
    });
  }

  function addCustom() {
    const inp = $id("pickCustom");
    if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    if (!S.live.includes(v)) S.live.push(v);
    S.sel.add(v);
    inp.value = "";
    S.q = "";
    const q = $id("pickSearch");
    if (q) q.value = "";
    renderList();
    renderCount();
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
    /* 手动加模型名：中转站常把模型改叫 gpt-5.2-codex 之类，目录里永远查不到 */
    const addBtn = $id("pickCustomAdd");
    if (addBtn) addBtn.addEventListener("click", addCustom);
    const cin = $id("pickCustom");
    if (cin) cin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addCustom(); }
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
