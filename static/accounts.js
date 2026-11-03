/* ============================================================
   账户：添加 / 编辑 / 删除
   三类能力档：detail（能采集明细）/ balance_only（只能查余额）/ catalog（只能看模型）
   ============================================================ */
"use strict";

const ACCT = (function () {
  const $id = (x) => document.getElementById(x);
  const S = { drivers: [], accounts: [], driver: "", id: "", payload: {} };

  const CAP_LABEL = {
    detail: "可采集明细",
    balance_only: "仅余额",
    catalog: "仅模型比价",
  };

  function open(id) {
    S.id = id || "";
    S.driver = "";
    S.payload = {};
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
    const groups = [
      ["detail", "能直接采集用量（登录一次即可）"],
      ["balance_only", "只能查余额与累计消费"],
      ["catalog", "只有模型与价格，暂不能采集"],
    ];
    body.innerHTML =
      '<p class="acct-tip">选一个平台。能采集明细的只有几家（它们开放了用量接口）；其余平台可以在「模型」页看价格，但读不到你的账户数据 —— 这一点如实标出来，不伪造 0。</p>' +
      groups.map(([cap, title]) => {
        const list = S.drivers.filter((d) => d.capability === cap);
        if (!list.length) return "";
        return '<div class="acct-group"><div class="acct-gt">' + title + "</div>" +
          '<div class="acct-grid">' + list.map((d) => {
            const mine = S.accounts.filter((a) => (a.driver || a.kind) === d.id).length;
            return '<button type="button" class="acct-drv' + (cap === "catalog" ? " dim" : "") +
              '" data-drv="' + d.id + '">' +
              '<i class="acct-dot" style="background:' + d.color + '"></i>' +
              "<b>" + d.label + "</b>" +
              "<small>" + (mine ? "已接入 " + mine + " 个" : CAP_LABEL[cap]) + "</small>" +
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
        '<i class="acct-dot" style="background:' + d.color + '"></i>' +
        "<b>" + d.label + "</b>" +
        '<span class="acct-cap">' + CAP_LABEL[d.capability] + "</span>" +
      "</div>" +
      (d.note ? '<p class="acct-note">' + d.note + "</p>" : "") +
      '<div class="acct-fields">' +
        '<label class="acct-f"><span>显示名称</span><input id="acctLabel" type="text" value="' +
          esc(S.payload.label || (acct ? acct.name : d.label)) + '"></label>' +
        fields.map((f) => (
          '<label class="acct-f"><span>' + f.label +
          (f.optional ? ' <em>可选</em>' : "") + "</span>" +
          '<input id="fld_' + f.key + '" type="text" autocomplete="off" spellcheck="false" placeholder="' +
          esc(f.hint || "") + '" value="' + esc(acct ? "" : "") + '"></label>'
        )).join("") +
      "</div>" +
      '<p class="acct-save-tip">' + (acct ? "留空的字段表示不修改；填新值会覆盖。" : "凭据只写本机，不上传。") + "</p>" +
      '<div class="acct-res" id="acctRes"></div>';

    $id("acctBack").addEventListener("click", () => { S.id = ""; renderPicker(); });
    $id("btnAcctSave").hidden = false;
    $id("btnAcctTest").hidden = false;
    $id("btnAcctDelete").hidden = !acct;

    // 编辑时若凭据已存在，占位显示掩码，避免让人以为丢了
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
      toast("已保存，正在刷新数据…");
      close();
      if (typeof refreshAll === "function") refreshAll(true);
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
