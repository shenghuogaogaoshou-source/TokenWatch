/* ============================================================
   账户：接入向导（三步）+ 单个添加 / 编辑 / 删除
   ------------------------------------------------------------
   三类能力档：
     detail       能采集用量（逐日逐模型）
     balance_only 只能查余额与累计消费
     catalog      只有模型与价格，不能采集（点了会如实告知，不假装能接）
   ============================================================ */
"use strict";

const CAP_LABEL = {
  detail: "可采集明细",
  balance_only: "仅余额",
  catalog: "仅比价",
};
const CAP_GROUPS = [
  ["detail", "能直接采集用量", "登录一次，按天按模型把账拉下来"],
  ["balance_only", "只能查余额", "没有按天明细，但有准确余额"],
  ["catalog", "只能看模型与价格", "官网没开放账户接口 —— 不假装能接"],
];

const ACCT = (function () {
  const $id = (x) => document.getElementById(x);
  const S = { drivers: [], accounts: [], driver: "", id: "", payload: {}, afterModels: [] };

  /* open(id, driverHint, opts)
     - 不带参数：从平台列表开始（原来的行为）
     - 带 driverHint：直接进这家平台的表单（模型页「接入这个模型」用）
     - opts.models：保存成功后把这几个模型写进该账户的开放模型清单 */
  function open(id, driverHint, opts) {
    S.id = id || "";
    S.driver = driverHint || "";
    S.payload = {};
    S.afterModels = ((opts && opts.models) || []).slice();
    $id("acctModal").hidden = false;
    $id("acctTitle").textContent = id ? "账户设置" : "添加账户";
    $id("btnAcctSave").hidden = true;
    $id("btnAcctTest").hidden = true;
    $id("btnAcctDelete").hidden = true;
    load().then(() => {
      if (id) {
        const a = S.accounts.find((x) => x.id === id);
        if (a) {
          S.driver = a.driver || a.kind || "";
          S.payload = { label: a.name, base_url: a.base_url };
          renderForm(S.driver, a);
          return;
        }
      }
      if (driverHint) { renderForm(driverHint, null); return; }
      renderPicker();
    });
  }

  function close() { $id("acctModal").hidden = true; }

  async function load(force) {
    if (S.drivers.length && !force) return;
    try {
      const j = await (await fetch("/api/accounts")).json();
      S.drivers = j.drivers || [];
      S.accounts = j.accounts || [];
    } catch (e) { /* 静默：下面的渲染会显示空态 */ }
  }

  function renderPicker() {
    const body = $id("acctBody");
    body.innerHTML =
      '<p class="acct-tip">选一个平台。能采集明细的只有几家（它们开放了用量接口）；其余平台可以在「模型」页看价格，但读不到你的账户数据 —— 这一点如实标出来，不伪造 0。</p>' +
      CAP_GROUPS.map(([cap, title]) => {
        const list = S.drivers.filter((d) => d.capability === cap);
        if (!list.length) return "";
        return '<div class="acct-group"><div class="acct-gt">' + esc(title) + "</div>" +
          '<div class="acct-grid">' + list.map((d) => {
            const mine = S.accounts.filter((a) => (a.driver || a.kind) === d.id).length;
            return '<button type="button" class="acct-drv' + (cap === "catalog" ? " dim" : "") +
              '" data-drv="' + esc(d.id) + '">' +
              '<i class="acct-dot" style="background:' + esc(d.color) + '"></i>' +
              "<b>" + esc(d.label) + "</b>" +
              "<small>" + (mine ? "已接入 " + mine + " 个" : esc(CAP_LABEL[cap])) + "</small>" +
              "</button>";
          }).join("") + "</div></div>";
      }).join("");

    body.querySelectorAll(".acct-drv").forEach((b) => {
      b.addEventListener("click", () => {
        const d = S.drivers.find((x) => x.id === b.dataset.drv);
        if (!d) return;
        if (d.capability === "catalog") {
          toast("该平台暂不支持采集账户数据，可在「模型」页查看价格");
          return;
        }
        S.driver = d.id;
        S.payload = {};
        renderForm(d.id, null);
      });
    });
  }

  function renderForm(driver, acct) {
    const d = S.drivers.find((x) => x.id === driver);
    if (!d) { renderPicker(); return; }
    const body = $id("acctBody");
    const fields = d.auth || [];
    S.driver = driver;
    S.id = acct ? acct.id : "";

    body.innerHTML =
      '<button type="button" class="acct-back" id="acctBack">← 换一个平台</button>' +
      '<div class="acct-form-head">' +
        '<i class="acct-dot" style="background:' + esc(d.color) + '"></i>' +
        "<b>" + esc(d.label) + "</b>" +
        '<span class="acct-cap">' + esc(CAP_LABEL[d.capability] || "") + "</span>" +
      "</div>" +
      (d.note ? '<p class="acct-note">' + esc(d.note) + "</p>" : "") +
      '<div class="acct-fields">' +
        '<label class="acct-f"><span>显示名称</span><input id="acctLabel" type="text" value="' +
          esc(S.payload.label || (acct ? acct.name : d.label)) + '"></label>' +
        fields.map((f) => (
          '<label class="acct-f"><span>' + esc(f.label) +
          (f.optional ? " <em>可选</em>" : "") + "</span>" +
          '<input id="fld_' + esc(f.key) + '" type="text" autocomplete="off" spellcheck="false" placeholder="' +
          esc(f.hint || "") + '" value=""></label>'
        )).join("") +
      "</div>" +
      (d.login_url || d.grab ? loginBoxHTML(d) : "") +
      '<p class="acct-save-tip">' + (acct ? "留空的字段表示不修改；填新值会覆盖。" : "凭据只写本机，不上传。") + "</p>" +
      '<div class="acct-res" id="acctRes"></div>';

    $id("acctBack").addEventListener("click", () => { S.id = ""; renderPicker(); });
    $id("btnAcctSave").hidden = false;
    $id("btnAcctTest").hidden = false;
    $id("btnAcctDelete").hidden = !acct;
    bindLoginBox();

    if (acct) {
      fields.forEach((f) => {
        const inp = $id("fld_" + f.key);
        if (inp) inp.placeholder = "已保存，留空表示不修改";
      });
    }
  }

  function collect() {
    const out = { label: ($id("acctLabel") || {}).value || "", fields: {}, base_url: "" };
    const d = S.drivers.find((x) => x.id === S.driver) || {};
    (d.auth || []).forEach((f) => {
      const inp = $id("fld_" + f.key);
      if (inp && inp.value.trim()) out.fields[f.key] = inp.value.trim();
    });
    if (out.fields.base_url) out.base_url = out.fields.base_url;
    return out;
  }

  function showRes(msg, ok) {
    const r = $id("acctRes");
    if (!r) return;
    r.className = "acct-res " + (ok ? "ok" : "err");
    r.textContent = msg;
  }

  async function test() {
    const btn = $id("btnAcctTest");
    const c = collect();
    btn.classList.add("loading");
    showRes("正在连接…", true);
    try {
      const j = await postJSON("/api/account_test",
        { driver: S.driver, id: S.id, fields: c.fields });
      const r = (j && j.result) || {};
      if (r.status === "ok" || r.status === "empty") {
        const bal = (r.balance && r.balance.items && r.balance.items[0]) || null;
        showRes("连接成功" + (bal ? " · 余额 " + bal.total + " " + (bal.currency || "CNY") : "") +
          (r.capability === "balance_only" ? " · 该平台只提供余额" : ""), true);
      } else if (r.status === "unavailable") {
        showRes(r.detail || "缺少凭据", false);
      } else {
        showRes(r.detail || "连接失败", false);
      }
    } catch (e) {
      showRes("测试失败：" + e.message, false);
    } finally {
      btn.classList.remove("loading");
    }
  }

  async function save() {
    const btn = $id("btnAcctSave");
    const c = collect();
    btn.classList.add("loading");
    try {
      const j = await postJSON("/api/accounts", {
        action: "add", id: S.id, driver: S.driver,
        label: c.label, base_url: c.base_url, fields: c.fields,
      });
      if (!j.ok) throw new Error(j.error || "保存失败");
      /* 从模型页点进来时，顺手把那个模型记进这个账户的清单 */
      if (S.afterModels.length && j.id) {
        try {
          await postJSON("/api/account_models", { id: j.id, models: S.afterModels });
        } catch (e) { /* 记不上不影响接入本身 */ }
      }
      const marked = S.afterModels.length;
      S.afterModels = [];
      toast(marked ? "已接入，并标好了这 " + marked + " 个模型" : "已保存，正在刷新数据…");
      close();
      if (typeof refreshAll === "function") refreshAll(true);
      if (window.MDL && marked) window.MDL.load();
    } catch (e) {
      showRes(e.message, false);
    } finally {
      btn.classList.remove("loading");
    }
  }

  async function del() {
    if (!S.id) return;
    if (!window.confirm("删除这个账户？它的凭据与已存的使用记录都会一并删除。")) return;
    try {
      const j = await postJSON("/api/accounts", { action: "delete", id: S.id });
      if (!j.ok) throw new Error(j.error || "删除失败");
      toast("已删除账户");
      close();
      if (typeof refreshAll === "function") refreshAll(true);
    } catch (e) {
      showRes(e.message, false);
    }
  }

  function bind() {
    const add = $id("btnAddAccount");
    if (add) add.addEventListener("click", () => open(""));
    const cl = $id("btnCloseAcct");
    if (cl) cl.addEventListener("click", close);
    const sv = $id("btnAcctSave");
    if (sv) sv.addEventListener("click", save);
    const ts = $id("btnAcctTest");
    if (ts) ts.addEventListener("click", test);
    const dl = $id("btnAcctDelete");
    if (dl) dl.addEventListener("click", del);
    const mask = $id("acctModal");
    if (mask) mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  return { open, close };
})();
window.ACCT = ACCT;

/* ============================================================
   接入向导
   ============================================================ */
const WIZ = (function () {
  const $id = (x) => document.getElementById(x);
  const S = {
    step: 1,
    drivers: [],
    accounts: [],
    picked: [],
    forms: {},
    saved: [],
    busy: false,
  };

  function drv(id) { return S.drivers.find((d) => d.id === id) || {}; }

  async function open() {
    S.step = 1; S.picked = []; S.forms = {}; S.saved = []; S.busy = false;
    $id("wizModal").hidden = false;
    $id("wizBody").innerHTML = '<div class="wiz-empty">正在读取平台清单…</div>';
    try {
      const j = await (await fetch("/api/accounts")).json();
      S.drivers = j.drivers || [];
      S.accounts = j.accounts || [];
    } catch (e) {
      $id("wizBody").innerHTML = '<div class="wiz-empty">读取失败：' + esc(e.message) + "</div>";
      return;
    }
    render();
  }

  function close() { $id("wizModal").hidden = true; }

  function renderSteps() {
    const names = ["选平台", "填凭据 / 登录", "确认模型"];
    $id("wizSteps").innerHTML = names.map((n, i) => {
      const k = i + 1;
      const cls = k === S.step ? "on" : (k < S.step ? "done" : "");
      return '<div class="ws ' + cls + '"><i>' + (k < S.step ? "✓" : k) + "</i>" + n + "</div>";
    }).join("");
  }

  function render() {
    renderSteps();
    const prev = $id("wizPrev");
    const next = $id("wizNext");
    const note = $id("wizNote");
    if (S.step === 1) {
      prev.hidden = true;
      next.textContent = "下一步";
      next.disabled = !S.picked.length;
      note.textContent = S.picked.length ? "已选 " + S.picked.length + " 家" : "先勾要接入的平台";
      renderPick();
    } else if (S.step === 2) {
      prev.hidden = false;
      next.textContent = "保存并继续";
      next.disabled = false;
      note.textContent = "凭据只写本机 platform_creds.json";
      renderForms();
    } else {
      prev.hidden = true;
      next.textContent = "完成";
      next.disabled = false;
      note.textContent = "接进来后可以随时在账户页改";
      renderDone();
    }
  }

  /* ---------- 第一步 ---------- */
  function renderPick() {
    const body = $id("wizBody");
    body.innerHTML = CAP_GROUPS.map(([cap, title, help]) => {
      const list = S.drivers.filter((d) => d.capability === cap);
      if (!list.length) return "";
      return '<div class="wiz-group-t">' + esc(title) + "<em>" + esc(help) + "</em></div>" +
        '<div class="wiz-grid">' + list.map((d) => {
          const on = S.picked.includes(d.id);
          const mine = S.accounts.filter((a) => a.driver === d.id).length;
          const dis = cap === "catalog";
          return '<button type="button" class="wiz-drv' + (on ? " on" : "") + (dis ? " dim" : "") +
            '" data-d="' + esc(d.id) + '"' + (dis ? ' title="该平台官网没有开放账户接口，只能比价"' : "") + ">" +
            '<i class="wiz-dot" style="background:' + esc(d.color) + '"></i>' +
            '<span class="wiz-drv-t"><b>' + esc(d.label) + "</b><small>" +
              (mine ? "已接入 " + mine + " 个" : esc(cap === "catalog" ? "只能比价" :
                (cap === "detail" ? "能采集明细" : "只能查余额"))) +
            "</small></span>" +
            '<span class="wiz-ck">✓</span></button>';
        }).join("") + "</div>";
    }).join("") +
      '<p class="pick-hint" style="margin-top:14px">勾选后下一步要填凭据。只能比价的平台（灰掉的那些）' +
      "官网没有开放接口，接进来也读不到你的数据，所以这里不给勾 —— 它们仍会出现在「模型」页用于比价。</p>";

    body.querySelectorAll(".wiz-drv").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.dataset.d;
        const d = drv(id);
        if (d.capability === "catalog") {
          toast("该平台只能比价，读不到账户数据");
          return;
        }
        const i = S.picked.indexOf(id);
        if (i >= 0) S.picked.splice(i, 1);
        else S.picked.push(id);
        render();
      });
    });
  }

  /* ---------- 第二步 ---------- */
  function formOf(id) {
    if (!S.forms[id]) S.forms[id] = { label: "", fields: {}, status: "", msg: "" };
    const f = S.forms[id];
    if (!f.label) {
      const base = drv(id).label || id;
      const n = S.accounts.filter((a) => a.driver === id).length;
      f.label = n ? base + " #" + (n + 1) : base;
    }
    return f;
  }

  function renderForms() {
    const body = $id("wizBody");
    body.innerHTML = S.picked.map((id) => {
      const d = drv(id);
      const f = formOf(id);
      const st = f.status === "ok" ? '<span class="wiz-st ok">已连通</span>'
        : f.status === "err" ? '<span class="wiz-st err">未连通</span>'
        : '<span class="wiz-st">待填写</span>';
      return '<div class="wiz-item' + (f.status === "ok" ? " ok" : f.status === "err" ? " fail" : "") + '">' +
        '<div class="wiz-hd"><i class="wiz-dot" style="background:' + esc(d.color) + '"></i>' +
          "<b>" + esc(d.label) + '</b><span class="wz-cap">' +
          esc(CAP_LABEL[d.capability] || "") + "</span>" + st + "</div>" +
        '<div class="wiz-fields">' +
          '<label class="wiz-f"><span>显示名称</span>' +
            '<input data-d="' + esc(id) + '" data-k="__label" value="' + esc(f.label) + '"></label>' +
          (d.auth || []).map((af) =>
            '<label class="wiz-f"><span>' + esc(af.label) +
            (af.optional ? "<em>可选</em>" : "") + "</span>" +
            '<input data-d="' + esc(id) + '" data-k="' + esc(af.key) + '" autocomplete="off" spellcheck="false"' +
            ' placeholder="' + esc(af.hint || "") + '" value="' +
            esc(f.fields[af.key] || "") + '"></label>').join("") +
          (d.note ? '<p class="wiz-note">' + esc(d.note) + "</p>" : "") +
          loginBoxHTML(d) +
          '<div class="wiz-acts">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-test="' + esc(id) + '">测试连接</button>' +
            '<span class="pick-hint">可以只填一部分，空着的先跳过。</span>' +
          "</div>" +
          '<div class="wiz-res ' + (f.status || "") + '">' + esc(f.msg || "") + "</div>" +
        "</div></div>";
    }).join("");

    body.querySelectorAll("input[data-d]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const f = formOf(inp.dataset.d);
        if (inp.dataset.k === "__label") f.label = inp.value;
        else f.fields[inp.dataset.k] = inp.value;
      });
    });
    body.querySelectorAll("[data-test]").forEach((b) => {
      b.addEventListener("click", () => testOne(b.dataset.test, b));
    });
    bindLoginBox();
  }

  async function testOne(id, btn) {
    const f = formOf(id);
    if (btn) btn.classList.add("loading");
    f.msg = "正在连接…";
    f.status = "";
    paintRes(id, "正在连接…", "");
    try {
      const j = await postJSON("/api/account_test", { driver: id, fields: f.fields });
      const r = (j && j.result) || {};
      if (r.status === "ok" || r.status === "empty") {
        const bal = (r.balance && r.balance.items && r.balance.items[0]) || null;
        f.status = "ok";
        f.msg = "连接成功" + (bal ? " · 余额 " + bal.total + " " + (bal.currency || "CNY") : "") +
          (r.status === "empty" ? " · 本区间没有用量（这不算失败）" : "");
      } else {
        f.status = "err";
        f.msg = r.detail || "连接失败，检查凭据是否填对";
      }
    } catch (e) {
      f.status = "err";
      f.msg = "测试失败：" + e.message;
    } finally {
      if (btn) btn.classList.remove("loading");
      paintRes(id, f.msg, f.status);
      const item = $id("wizBody").querySelector('[data-test="' + id + '"]');
      const box = item && item.closest(".wiz-item");
      if (box) {
        box.classList.toggle("ok", f.status === "ok");
        box.classList.toggle("fail", f.status === "err");
      }
      const st = box && box.querySelector(".wiz-st");
      if (st) {
        st.className = "wiz-st " + (f.status || "");
        st.textContent = f.status === "ok" ? "已连通" : f.status === "err" ? "未连通" : "待填写";
      }
    }
  }

  function paintRes(id, msg, cls) {
    const body = $id("wizBody");
    const btn = body.querySelector('[data-test="' + id + '"]');
    const item = btn && btn.closest(".wiz-item");
    const res = item && item.querySelector(".wiz-res");
    if (res) { res.className = "wiz-res " + (cls || ""); res.textContent = msg || ""; }
  }

  /* ---------- 保存 ---------- */
  async function saveAll() {
    if (S.busy) return;
    const todo = S.picked.filter((id) => {
      const f = formOf(id);
      return Object.values(f.fields).some((v) => String(v || "").trim());
    });
    if (!todo.length) {
      toast("先至少填一家的凭据");
      return;
    }
    S.busy = true;
    const next = $id("wizNext");
    next.classList.add("loading");
    let ok = 0, fail = 0;
    for (const id of todo) {
      const f = formOf(id);
      try {
        const j = await postJSON("/api/accounts", {
          action: "add", driver: id, label: f.label,
          base_url: f.fields.base_url || "", fields: f.fields,
        });
        if (j.ok) {
          ok++;
          if (j.id && !S.saved.some((a) => a.id === j.id)) {
            S.saved.push({ id: j.id, driver: id, label: f.label, models: [] });
          }
        } else { fail++; f.status = "err"; f.msg = j.error || "保存失败"; }
      } catch (e) {
        fail++;
        f.status = "err";
        f.msg = "保存失败：" + e.message;
      }
    }
    S.busy = false;
    next.classList.remove("loading");
    if (!ok) { render(); toast("没有一家保存成功"); return; }
    /* 保存成功后拉一次账户，拿到真实 id（服务端会补 acct-xxx） */
    try {
      const j = await (await fetch("/api/accounts")).json();
      S.accounts = j.accounts || [];
      S.saved = S.picked.filter((id) => S.accounts.some((a) => a.driver === id))
        .map((id) => {
          const a = S.accounts.filter((x) => x.driver === id).pop();
          return { id: a.id, driver: id, label: a.name, models: a.models || [] };
        });
    } catch (e) { /* 拿不到就用本地记录 */ }
    toast(fail ? "已接入 " + ok + " 家，" + fail + " 家失败" : "已接入 " + ok + " 家");
    S.step = 3;
    render();
    if (typeof refreshAll === "function") refreshAll(true);
  }

  /* ---------- 第三步 ---------- */
  function renderDone() {
    const body = $id("wizBody");
    if (!S.saved.length) {
      body.innerHTML = '<div class="wiz-empty">这次没有新增账户。<br>凭据没填的平台上一步已经跳过。</div>';
      return;
    }
    body.innerHTML =
      '<p class="pick-hint" style="margin-bottom:10px">接入完成。' +
      "选一下每个账户开放哪些模型 —— 这一步只影响标注和来源推荐，随时可改。</p>" +
      '<div class="wiz-sum">' + S.saved.map((a) => {
        const d = drv(a.driver);
        return '<div class="wiz-sum-row">' +
          '<i class="wiz-dot" style="background:' + esc(d.color || "#888") + '"></i>' +
          "<b>" + esc(a.label) + "</b>" +
          '<span class="wz-m">' + (a.models.length ? a.models.length + " 个模型" : "不限模型") + "</span>" +
          '<button type="button" class="btn btn-ghost btn-sm" data-pick="' + esc(a.id) + '">选择模型</button>' +
          "</div>";
      }).join("") + "</div>";

    body.querySelectorAll("[data-pick]").forEach((b) => {
      b.addEventListener("click", () => {
        const a = S.saved.find((x) => x.id === b.dataset.pick);
        if (!a || !window.openModelPickFor) return;
        /* 走和账户卡同一个入口：中转站会先去问站点有哪些模型 */
        window.openModelPickFor(
          { id: a.id, name: a.label, driver: a.driver }, a.models || [],
          (arr) => {
            a.models = arr;
            b.closest(".wiz-sum-row").querySelector(".wz-m").textContent =
              arr.length ? arr.length + " 个模型" : "不限模型";
          });
      });
    });
  }

  /* ---------- 底部按钮 ---------- */
  function bind() {
    const op = $id("btnWizard");
    if (op) op.addEventListener("click", open);
    const cl = $id("btnCloseWiz");
    if (cl) cl.addEventListener("click", close);
    const mask = $id("wizModal");
    if (mask) mask.addEventListener("click", (e) => { if (e.target === mask) close(); });

    const next = $id("wizNext");
    if (next) next.addEventListener("click", () => {
      if (S.step === 1) {
        if (!S.picked.length) { toast("先勾选要接入的平台"); return; }
        S.step = 2;
        render();
      } else if (S.step === 2) {
        saveAll();
      } else {
        close();
        if (typeof refreshAll === "function") refreshAll(true);
        if (typeof goPage === "function") goPage("accounts");
      }
    });
    const prev = $id("wizPrev");
    if (prev) prev.addEventListener("click", () => {
      if (S.step === 2) { S.step = 1; render(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  return { open, close };
})();
window.WIZ = WIZ;

/* ============================================================
   共用：凭据获取区（单个添加 / 账户设置 / 接入向导都用它）
   ------------------------------------------------------------
   有 probe / cookie_name 的平台给「自动读取」——后台起一个专属
   Edge 登录窗口，登录完直接把票据读回来；
   只认 API Key 的平台给「打开官网」。
   ============================================================ */
function loginBoxHTML(d) {
  const auto = !!(d.probe || d.cookie_name);
  const key = (d.auth && d.auth[0] && d.auth[0].key) || "";
  const tip = auto
    ? "点「自动读取登录态」会弹出一个登录窗口：在那里面登录一次，凭据自动带回来（下次不用再登）。读不到也可以手动复制命令。"
    : d.login_url
      ? "到这个页面登录后，在「API Keys」里新建一个 Key 复制过来。"
      : "填站点地址与 API Key 即可。";
  return '<div class="wiz-login">' +
    "<p>" + esc(tip) + "</p>" +
    '<div class="wiz-login-acts">' +
      (auto
        ? '<button type="button" class="btn btn-primary btn-sm" data-grab="' + esc(d.id) +
          '" data-key="' + esc(key) + '">自动读取登录态</button>'
        : "") +
      (d.login_url
        ? '<button type="button" class="btn btn-ghost btn-sm" data-open="' + esc(d.login_url) +
          '">' + (auto ? "手动打开官网 ↗" : "打开官网 ↗") + "</button>"
        : "") +
      (d.grab
        ? '<button type="button" class="btn btn-ghost btn-sm" data-copy="' + esc(d.grab) + '">复制取值命令</button>'
        : "") +
    "</div>" +
    '<div class="wiz-login-note" data-grabnote></div>' +
    "</div>";
}

/* 把读到的值填进当前卡片里对应的输入框 */
function fillGrabbedValue(btn, key, value) {
  const scope = btn.closest(".wiz-item, .modal-body, .modal") || document;
  const byKey = key
    ? scope.querySelector('[id="fld_' + key + '"], [data-k="' + key + '"]')
    : null;
  const empty = [...scope.querySelectorAll("input")]
    .find((x) => !x.value.trim() && x.type !== "hidden" && x.id !== "acctLabel");
  const input = byKey || empty;
  if (!input) return false;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  return true;
}

function bindLoginBox() {
  document.querySelectorAll("[data-open]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => {
      const url = b.dataset.open;
      if (!url) return;
      window.open(url, "_blank", "noopener");
    });
  });
  document.querySelectorAll("[data-copy]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", async () => {
      const txt = b.dataset.copy;
      try {
        await navigator.clipboard.writeText(txt);
        toast("命令已复制，到官网页面按 F12 → Console 粘贴");
      } catch (e) {
        window.prompt("复制这段命令，到官网页面 Console 里粘贴：", txt);
      }
    });
  });
  document.querySelectorAll("[data-grab]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => grabInto(b));
  });
}

/* 自动读取：请求会挂最多 ~100 秒（等用户在登录窗口里完成登录） */
async function grabInto(btn) {
  if (btn.dataset.busy) return;
  const note = (btn.closest(".wiz-login") || {}).querySelector
    ? btn.closest(".wiz-login").querySelector("[data-grabnote]")
    : null;
  const say = (msg, cls) => {
    if (!note) return;
    note.className = "wiz-login-note" + (cls ? " " + cls : "");
    note.textContent = msg || "";
  };
  const label = btn.textContent;
  btn.dataset.busy = "1";
  btn.classList.add("loading");
  btn.textContent = "等待登录…";
  say("已弹出登录窗口，请在里面完成登录（不要关窗口）。");
  try {
    const j = await postJSON("/api/grab_cred", { driver: btn.dataset.grab }, 130000);
    if (j.found && j.value) {
      const filled = fillGrabbedValue(btn, btn.dataset.key, j.value);
      say((filled ? "已填入" : "已读到，但没找到输入框") + " · " + (j.note || ""), "ok");
      toast("已读取凭据，点「测试连接」确认能通");
    } else {
      say(j.note || "还没读到，登录完成后可以再点一次", "err");
    }
  } catch (e) {
    say("读取失败：" + e.message, "err");
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove("loading");
    btn.textContent = label;
  }
}
