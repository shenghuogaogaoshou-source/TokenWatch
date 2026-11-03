/* ============================================================
   外壳：四页路由 + 导轨状态 + 总览右侧账户速览
   （数据全部复用 app.js 的 state / mergedProviders，避免二次请求）
   ============================================================ */
"use strict";

const PAGE_META = {
  overview: { title: "总览", sub: "余额实时查询 · 用量以官网实扣口径优先", seg: true },
  accounts: { title: "账户", sub: "一个账户一张卡片 · 凭据只存本机", seg: false },
  models:   { title: "模型", sub: "从公开目录里勾选你实际会用的模型", seg: false },
  pricing:  { title: "定价", sub: "各家官网当前价 · 按你的用量配比折成综合单价", seg: true },
};
let curPage = "overview";

function goPage(name) {
  const meta = PAGE_META[name] || PAGE_META.overview;
  curPage = PAGE_META[name] ? name : "overview";
  document.querySelectorAll(".page").forEach((p) => {
    p.hidden = p.dataset.page !== curPage;
  });
  document.querySelectorAll("#railNav button").forEach((b) => {
    b.classList.toggle("on", b.dataset.page === curPage);
  });
  const t = document.getElementById("pageTitle");
  const s = document.getElementById("pageSub");
  if (t) t.textContent = meta.title;
  if (s) s.textContent = meta.sub;
  const seg = document.getElementById("rangeSeg");
  if (seg) seg.style.display = meta.seg ? "" : "none";
  if (location.hash.slice(1) !== curPage) {
    history.replaceState(null, "", "#" + curPage);
  }
  if (curPage === "models" && window.MDL && !window.MDL.loaded) window.MDL.load();
}

/* 总览右栏：一行一个账户 */
function whyText(p) {
  if (p._why === "platform") return "官网直连 · 实扣口径";
  if (p._why === "empty") return "官网已接通 · 区间无用量";
  if (p._why === "expired") return "票据失效 · 需重新获取";
  return "未接通官网";
}
function dotColor(p) {
  if (p._why === "platform") return "var(--ok)";
  if (p._why === "empty") return "var(--ink-3)";
  if (p._why === "expired") return "var(--up)";
  return "var(--warn)";
}

let ovSig = "";
function renderOvAccounts() {
  const host = document.getElementById("ovAccounts");
  if (!host || typeof mergedProviders !== "function" || !state.dataMain) return;
  const list = mergedProviders();
  const balOf = {};
  (state.dataMain.providers || []).forEach((p) => { balOf[p.id] = p.balance || null; });

  const sig = list.map((p) => p.id + ":" + p._why).join("|") + "#" +
    Object.values(balOf).map((b) => (b && b.status === "ok" ? 1 : 0)).join("");
  if (sig === ovSig) return;
  ovSig = sig;

  if (!list.length) {
    host.innerHTML = '<p class="ov-empty">还没有接入任何账户。到「账户」页填入各平台的登录凭据或 API Key。</p>';
    return;
  }
  host.innerHTML = list.map((p) => {
    const b = balOf[p.id];
    let v = "—", vsub = "余额", cls = "";
    if (b && b.status === "ok" && b.type === "money") {
      const it = (b.items || [])[0];
      if (it) {
        v = (it.currency === "CNY" ? "¥" : it.currency + " ") +
            Number(it.total).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } else {
        v = "0.00"; vsub = "余额";
      }
      const low = typeof lowFor === "function" ? lowFor(p.name) : 0;
      if (low > 0 && it && Number(it.total) < low) cls = " warn";
    } else if (b && b.status === "ok" && b.type === "plan") {
      v = "套餐"; vsub = "订阅制";
    } else {
      v = "—";
      // 这里只有一列宽度，别把错误详情整段塞进来（会截成「未提供 DeepSe」）
      const d = (b && b.detail) ? String(b.detail) : "";
      if (/API\s*Key/i.test(d)) vsub = "需 API Key";
      else if (/未登录|重新登录|票据|令牌|凭据/i.test(d)) vsub = "需重新登录";
      else if (/暂未提供|不支持/i.test(d)) vsub = "无余额接口";
      else vsub = "未接通";
    }
    return '<div class="ov-row">' +
      '<span class="ov-dot" style="background:' + dotColor(p) + '"></span>' +
      '<span class="ov-n"><b>' + esc(p.name) + '</b><small>' + whyText(p) + '</small></span>' +
      '<span class="ov-v' + cls + '">' + esc(v) + '<small>' + vsub + '</small></span>' +
      '</div>';
  }).join("") +
    '<div class="ov-sum"><span>余额合计 · ' + list.length + ' 个账户</span><b>' +
    "¥" + Number((state.dataMain.total_summary || {}).cny || 0)
      .toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    "</b></div>";
}

/* 导轨底部：已接通家数 / 余额合计 */
let railSig = "";
function renderRail() {
  if (!state.dataMain) return;
  const u = (state.platform && state.platform.usage) || {};
  let live = 0;
  Object.keys(u).forEach((k) => {
    const r = u[k];
    if (r && (r.status === "ok" || r.status === "empty")) live++;
  });
  const bal = (state.dataMain.total_summary && state.dataMain.total_summary.cny) || 0;
  const sig = live + "#" + bal.toFixed(2);
  if (sig === railSig) return;
  railSig = sig;
  const l = document.getElementById("railLive");
  const b = document.getElementById("railBal");
  if (l) l.textContent = live + " 家";
  if (b) b.textContent = bal.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* 图表副标题跟随区间 */
function syncCardSubs() {
  const c = document.getElementById("chartSub");
  if (c && typeof rangeText === "function") c.textContent = "按账户堆叠 · " + rangeText() + " · 人民币";
}

function boot() {
  document.querySelectorAll("#railNav button").forEach((b) => {
    b.addEventListener("click", () => goPage(b.dataset.page));
  });
  const start = (location.hash || "").slice(1);
  goPage(PAGE_META[start] ? start : "overview");

  const ac = document.getElementById("btnAccountsCreds");
  if (ac) ac.addEventListener("click", () => { if (typeof openPlatformCreds === "function") openPlatformCreds(); });

  setInterval(() => { renderOvAccounts(); renderRail(); syncCardSubs(); }, 900);
  setTimeout(() => { renderOvAccounts(); renderRail(); }, 300);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
