/**
 * 合成视图验证：
 *  - 来源切换开关已移除
 *  - 官网能覆盖的家用官网用量；未覆盖/仅套餐额度的回落本地记录
 *  - 总览带、卡片用量条、趋势图、模型表四处口径一致
 * 用法：NODE_PATH=... node test_unified.js <port>
 */
const { chromium } = require("playwright");
const PORT = process.argv[2] || "8799";
const BASE = "http://127.0.0.1:" + PORT;

const ISO = (off) => {
  const d = new Date();
  d.setDate(d.getDate() - off);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

function mkDays(seed, n) {
  const o = {};
  for (let i = 0; i < n; i++) {
    const k = ISO(i);
    o[k] = {
      requests: 20 + ((seed * (i + 3)) % 45),
      input: 90000 + ((seed * 7777 * (i + 1)) % 400000),
      output: 12000 + ((seed * 331 * (i + 1)) % 60000),
      cache_read: 30000 + ((seed * 991 * (i + 1)) % 200000),
      cache_creation: 0,
      cost: +(0.06 + ((seed * 13 * (i + 1)) % 90) / 100).toFixed(4),
    };
  }
  return o;
}
function mkModelDays(models, seed) {
  const out = {};
  models.forEach((m, mi) => { out[m] = mkDays(seed + mi + 1, 14); });
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));

  // 真实 provider id
  const data = await (await fetch(BASE + "/api/data?days=30")).json();
  const byName = {};
  for (const p of data.providers || []) byName[p.name] = p.id;
  const pid = {
    deepseek: byName["DeepSeek"],
    kimi: byName["Kimi"],
    zhipu: byName["Zhipu GLM"],
  };
  if (!pid.deepseek || !pid.kimi || !pid.zhipu) {
    console.error("!! 未能从 /api/data 拿到三家 provider id:", byName);
    process.exit(2);
  }

  const dsModels = ["deepseek-chat", "deepseek-reasoner"];
  const kmModels = ["kimi-k2-0905-preview"];
  const mock = {
    ok: true, days: 30,
    server_time: new Date().toISOString().replace("T", " ").slice(0, 19),
    creds: {
      deepseek: { configured: true, masked: { token: "sk-ab…yz" } },
      kimi: { configured: true, masked: { token: "eyJhb…QifQ" } },
      zhipu: { configured: true, masked: { jwt_token: "eyJhb…KfQ", organization: "org-1…", project: "proj-…" } },
    },
    spec: {
      deepseek: { label: "DeepSeek", mode: "usage", fields: [{ key: "token", label: "网页登录 Token", hint: "" }], howto: ["登录 platform.deepseek.com"] },
      kimi: { label: "Kimi", mode: "usage", fields: [{ key: "token", label: "kimi_token", hint: "" }], howto: ["登录 www.kimi.com"] },
      zhipu: { label: "智谱 GLM", mode: "quota", fields: [{ key: "jwt_token", label: "authorization", hint: "" }], howto: ["登录 bigmodel.cn"] },
    },
    usage: {},
  };
  const dsDays = mkDays(3, 30), kmDays = mkDays(7, 30);
  const sum = (o) => Object.values(o).reduce((a, r) => ({
    requests: a.requests + r.requests, input: a.input + r.input, output: a.output + r.output,
    cache_read: a.cache_read + r.cache_read, cache_creation: 0, cost: a.cost + r.cost,
  }), { requests: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, cost: 0 });

  mock.usage[pid.deepseek] = {
    provider_id: pid.deepseek, provider_name: "DeepSeek", kind: "deepseek", label: "DeepSeek",
    status: "ok", mode: "usage", checked_at: "2026-09-14T10:02:11",
    totals: sum(dsDays), days: dsDays,
    models: dsModels.map((m, i) => ({
      model: m, ...sum(mkDays(3 + i + 1, 30)),
    })),
    model_days: mkModelDays(dsModels, 3),
  };
  mock.usage[pid.kimi] = {
    provider_id: pid.kimi, provider_name: "Kimi", kind: "kimi", label: "Kimi",
    status: "ok", mode: "usage", checked_at: "2026-09-14T10:02:12",
    totals: sum(kmDays), days: kmDays,
    models: kmModels.map((m, i) => ({ model: m, ...sum(mkDays(7 + i + 1, 30)) })),
    model_days: mkModelDays(kmModels, 7),
  };
  // 智谱：仅套餐额度 → 明细回落本地记录
  mock.usage[pid.zhipu] = {
    provider_id: pid.zhipu, provider_name: "Zhipu GLM", kind: "zhipu", label: "智谱 GLM",
    status: "ok", mode: "quota", checked_at: "2026-09-14T10:02:13",
    plan: "glm-coding-pro",
    windows: [
      { name: "5 小时额度", used_pct: 43, reset_at: "2026-09-14 18:00" },
      { name: "本周额度", used_pct: 12, reset_at: "2026-09-20 23:59" },
    ],
  };

  await page.route("**/api/platform*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock) }));

  await page.goto(BASE + "/?days=30", { waitUntil: "networkidle" });
  await page.waitForSelector("#providers .pcard", { timeout: 10000 });
  await page.waitForTimeout(700);

  const res = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const cards = [...document.querySelectorAll("#providers .pcard")].map((c) => ({
      name: c.querySelector("h3")?.textContent.trim(),
      src: c.querySelector(".strip-src")?.textContent.trim() || null,
      req: c.querySelectorAll(".ustat .u-v")[0]?.textContent.trim(),
      cost: c.querySelectorAll(".ustat .u-v")[3]?.textContent.trim(),
    }));
    return {
      hasToggle: !!q("#srcSeg"),
      badge: q("#srcBadge")?.textContent.trim(),
      hint: q("#srcHint")?.textContent.trim(),
      cred: q("#srcCredState")?.textContent.trim(),
      tapeNote: q("#tapeCost7Note")?.textContent.trim(),
      tapeCost: q("#tapeCost7V")?.textContent.trim(),
      tapeFoot: q("#tapeCost7F")?.textContent.trim(),
      tapeTok: q("#tapeTok7V")?.textContent.trim(),
      cards,
      bars: document.querySelectorAll("#trendChart rect.tbar").length,
      legend: [...document.querySelectorAll("#legend .legend-item")].map((x) => x.textContent.trim()),
      rows: [...document.querySelectorAll("#modelRows tr")].map((tr) =>
        [...tr.children].map((td) => td.textContent.trim())),
      tableNote: q("#tableNote")?.textContent.trim(),
      platCards: [...document.querySelectorAll(".plat-card")].map((c) => ({
        name: c.querySelector("h3")?.textContent.trim(),
        pill: c.querySelector(".pc-pill")?.textContent.trim(),
      })),
    };
  });

  // ---- 溢出审计 ----
  const overflow = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll("body *").forEach((e) => {
      if (e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0) {
        const cs = getComputedStyle(e);
        if (cs.overflowX === "hidden" || cs.overflow === "hidden" || cs.textOverflow === "ellipsis") {
          if (e.closest(".trend") || e.tagName === "SVG") return;
          bad.push({ tag: e.tagName, cls: e.className.toString().slice(0, 50),
                     sw: e.scrollWidth, cw: e.clientWidth, t: (e.textContent || "").trim().slice(0, 40) });
        }
      }
    });
    return bad;
  });

  console.log("=== 合成视图检查 ===");
  console.log("来源切换开关已移除 :", res.hasToggle ? "✗ 仍存在 #srcSeg" : "✓");
  console.log("来源徽标           :", res.badge);
  console.log("来源说明           :", res.hint);
  console.log("凭据状态           :", res.cred);
  console.log("总览 7 日口径注记   :", res.tapeNote);
  console.log("总览 7 日消耗       :", res.tapeCost, "|", res.tapeFoot);
  console.log("总览 7 日 Token     :", res.tapeTok);
  console.log("--- 提供商卡片用量条 ---");
  res.cards.forEach((c) => console.log(`  ${String(c.name).padEnd(12)} ${String(c.src).padEnd(38)} req=${c.req} cost=${c.cost}`));
  console.log("--- 官网卡片 ---");
  res.platCards.forEach((c) => console.log(`  ${c.name} [${c.pill}]`));
  console.log("趋势图柱数         :", res.bars);
  console.log("图例               :", res.legend.join(" / "));
  console.log("--- 模型表 ---");
  res.rows.forEach((r) => console.log("  " + r.join(" | ")));
  console.log("表注               :", res.tableNote);
  console.log("控制台错误         :", errors.length ? errors : "无");
  console.log("文字溢出           :", overflow.length ? overflow : "无");

  // ---- 口径一致性：总览带 vs 趋势图（同样取近 7 天） ----
  const consist = await page.evaluate(() => {
    const t = unifiedTotals7();
    const { dayMap } = seriesOfDay(mergedProviders(), false, true);
    let chart7 = 0;
    for (let i = 0; i < 7; i++) {
      const d = localISO(i);
      chart7 += Object.values(dayMap[d] || {}).reduce((s, x) => s + x, 0);
    }
    return { tape: t.cost, chart: +chart7.toFixed(4), platN: t.platN, localN: t.localN };
  });
  const diff = Math.abs(consist.tape - consist.chart);
  const consistOk = diff <= Math.max(0.02, consist.tape * 0.02);

  console.log("=== 口径一致性（近 7 日消耗）===");
  console.log(`  总览带 $${consist.tape.toFixed(2)} vs 趋势图 $${consist.chart.toFixed(2)}  偏差 $${diff.toFixed(4)}  ${consistOk ? "✓ 一致" : "✗ 不一致"}`);
  console.log(`  官网覆盖 ${consist.platN} 家 · 本地兜底 ${consist.localN} 家 · 图例含未归属: ${/未归属/.test(res.legend.join(" ")) ? "✓" : "✗"}`);

  await page.screenshot({ path: "shot_unified_light.png", fullPage: true });
  await page.evaluate(() => localStorage.setItem("tokenwatch-theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: "shot_unified_dark.png", fullPage: true });

  const pass = !res.hasToggle && /官网实时/.test(res.badge || "") &&
               res.cards.some((c) => /官网实时/.test(c.src || "")) &&
               res.cards.some((c) => /套餐额度/.test(c.src || "")) &&
               res.bars > 0 && consistOk && /未归属/.test(res.legend.join(" ")) &&
               !errors.length && !overflow.length;
  console.log("\n结果:", pass ? "PASS" : "FAIL");
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
