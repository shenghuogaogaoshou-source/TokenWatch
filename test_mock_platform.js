/* 用「合成平台数据」驱动前端平台侧视图，验证图表/表格/额度卡渲染 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'shots');

/* 合成 /api/platform 响应：DeepSeek=按模型按天明细，Kimi=额度窗口，智谱=额度窗口 */
function synthetic(days) {
  const Z = { requests: 0, success: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, cost: 0 };
  const dayList = [];
  const d = new Date('2026-09-09T00:00:00');
  for (let i = days - 1; i >= 0; i--) {
    const x = new Date(d); x.setDate(x.getDate() - i);
    dayList.push(x.toISOString().slice(0, 10));
  }
  const mk = (model, day, inp, out, cr, req, cost) =>
    ({ requests: req, success: req, input: inp, output: out, cache_read: cr, cache_creation: 0, cost: cost, model, date: day });

  const seeds = [
    mk('deepseek-chat', dayList[days - 2], 60000, 41000, 200000, 66, 0.1230),
    mk('deepseek-chat', dayList[days - 3], 45000, 30000, 120000, 42, 0.0812),
    mk('deepseek-reasoner', dayList[days - 2], 80000, 52000, 0, 11, 0.2077),
    mk('deepseek-reasoner', dayList[days - 1], 30000, 15000, 0, 5, 0.0910),
    mk('deepseek-chat', dayList[days - 1], 12000, 9000, 30000, 9, 0.0240),
  ];
  const byDay = {}, modelDays = {}, models = {};
  const acc = (t, s) => { for (const q of ['requests', 'input', 'output', 'cache_read', 'cost']) t[q] += s[q]; };
  for (const s of seeds) {
    const b = byDay[s.date] = byDay[s.date] || { ...Z, model: '', date: s.date };
    acc(b, s);
    const md = modelDays[s.model] = modelDays[s.model] || {};
    const mdd = md[s.date] = md[s.date] || { ...Z };
    acc(mdd, s);
    const m = models[s.model] = models[s.model] || { ...Z, model: s.model };
    acc(m, s);
  }
  for (const dd of dayList) { byDay[dd] = byDay[dd] || { ...Z }; for (const mm of Object.keys(modelDays)) modelDays[mm][dd] = modelDays[mm][dd] || { ...Z }; }
  const totals = { ...Z };
  for (const m of Object.values(models)) { totals.requests += m.requests; totals.input += m.input; totals.output += m.output; totals.cache_read += m.cache_read; totals.cost += m.cost; }
  totals.success = totals.requests;

  const spec = {
    deepseek: { label: 'DeepSeek', mode: 'usage', fields: [{ key: 'token', label: '网页登录 Token', hint: 'platform.deepseek.com 控制台' }], howto: ['登录 platform.deepseek.com', 'F12 → Console', '执行 JSON.parse(localStorage.userToken).value', '复制粘贴'] },
    kimi: { label: 'Kimi', mode: 'usage', fields: [{ key: 'token', label: 'kimi_token（JWT）', hint: 'www.kimi.com 请求头' }], howto: ['登录 www.kimi.com', 'F12 → Network', '找 authorization'] },
    zhipu: { label: '智谱 GLM', mode: 'quota', fields: [{ key: 'jwt_token', label: 'authorization（JWT）', hint: 'eyJhbGciOi…' }, { key: 'organization', label: 'bigmodel-organization', hint: 'org-…' }, { key: 'project', label: 'bigmodel-project', hint: 'proj-…' }], howto: ['登录 bigmodel.cn', 'F12 → Network', '复制三个请求头'] },
  };
  return {
    ok: true, days, curl_ok: true, spec,
    creds: {
      deepseek: { label: 'DeepSeek', mode: 'usage', configured: true, masked: { token: 'sk-abcd…wxyz' } },
      kimi: { label: 'Kimi', mode: 'quota', configured: true, masked: { token: 'eyJhbG…9xQ2' } },
      zhipu: { label: '智谱 GLM', mode: 'quota', configured: false, masked: {} },
    },
    usage: {
      'pid-ds': { status: 'ok', mode: 'usage', kind: 'deepseek', label: 'DeepSeek', provider_name: 'DeepSeek', provider_id: 'pid-ds', checked_at: '2026-09-09 00:40:11', models: Object.values(models).sort((a, b) => b.cost - a.cost), days: byDay, model_days: modelDays, totals, days_list: dayList },
      'pid-kimi': { status: 'ok', mode: 'quota', kind: 'kimi', label: 'Kimi', provider_name: 'Kimi', provider_id: 'pid-kimi', checked_at: '2026-09-09 00:40:12', plan: 'pro', windows: [{ name: '本周额度', used_pct: 38.5, reset_at: '2026-09-14 00:00' }, { name: '5 小时窗口', used_pct: 82, reset_at: '2026-09-09 05:00' }] },
      'pid-zp': { status: 'nokey', kind: 'zhipu', detail: '未配置 authorization（JWT）', label: '智谱 GLM', provider_name: 'Zhipu GLM', provider_id: 'pid-zp' },
    },
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const days = 30;
  const payload = synthetic(days);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.route('**/api/platform**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));

  await page.goto(process.argv[2] || 'http://127.0.0.1:8799/', { waitUntil: 'load' });
  await page.waitForSelector('#modelRows tr');
  await page.waitForTimeout(2500);

  const rep = {};
  rep.autoSrc = await page.locator('#srcSeg button.on').getAttribute('data-src');
  rep.credState = (await page.locator('#srcCredState').textContent() || '').trim();
  rep.bars = await page.locator('#trendChart rect.tbar').count();
  rep.rows = await page.locator('#modelRows tr').count();
  rep.legend = (await page.locator('#legend').textContent() || '').trim();
  rep.note = (await page.locator('#tableNote').textContent() || '').trim();
  rep.tapeCost = (await page.locator('#tapeCost7V').textContent() || '').trim();
  rep.tapeNote = (await page.locator('#tapeCost7Note').textContent() || '').trim();
  rep.tapeF = (await page.locator('#tapeCost7F').textContent() || '').trim();
  rep.cards = await page.locator('#platformView .plat-card').count();
  rep.quotaNums = await page.locator('#platformView .q-num').allInnerTexts();
  await page.screenshot({ path: OUT + '/c1_platform_usage.png', fullPage: true });

  // 按模型视图
  await page.click('#viewSeg button[data-view="model"]');
  await page.waitForTimeout(900);
  rep.rowsByModel = await page.locator('#modelRows tr').count();
  rep.firstRow = (await page.locator('#modelRows tr').first().innerText()).replace(/\s+/g, ' ').slice(0, 120);
  await page.screenshot({ path: OUT + '/c2_platform_bymodel.png', fullPage: true });

  // 切换到本地记录，确认互不串数据
  await page.click('#srcSeg button[data-src="local"]');
  await page.waitForTimeout(1200);
  rep.localRows = await page.locator('#modelRows tr').count();
  rep.localNote = (await page.locator('#tableNote').textContent() || '').trim().slice(0, 60);
  rep.localTapeNote = (await page.locator('#tapeCost7Note').textContent() || '').trim();
  await page.screenshot({ path: OUT + '/c3_back_local.png', fullPage: true });

  // 回到平台 + 暗色
  await page.click('#srcSeg button[data-src="platform"]');
  await page.waitForTimeout(900);
  await page.click('#viewSeg button[data-view="provider"]');
  await page.click('#btnTheme');
  await page.waitForTimeout(1100);
  await page.screenshot({ path: OUT + '/c4_platform_dark.png', fullPage: true });

  const ov = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === 'hidden' || cs.overflow === 'hidden') out.push({ cls: (el.className || '').toString().slice(0, 40), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50) });
      }
    });
    return out;
  });
  rep.overflowing = ov;
  rep.errs = errs;
  console.log(JSON.stringify(rep, null, 2));
  await browser.close();
})();
