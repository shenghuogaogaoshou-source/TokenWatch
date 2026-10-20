// test_real.js —— 用真实官网凭据跑端到端验收（不打桩）：状态条 / 卡片 / 图表 / 模型表
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 截图与验收报告统一落到 shots/（已 gitignore），避免污染仓库根目录
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const BASE = process.argv[2] || 'http://127.0.0.1:8734';
const OUT = [];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

  // 首次进入页面会带 force=1 拉一遍三家官网，冷启动可能要十几秒。
  // 必须等这个响应真正落地再读 DOM，否则会读到「平台数据还没到」的中间态，
  // 误判成「所有家都回落本地记录」（曾经就是这么偶发红的）。
  const platDone = page.waitForResponse(
    (r) => r.url().includes('/api/platform') && r.request().method() === 'GET' && r.status() === 200,
    { timeout: 120000 }).catch(() => null);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await platDone;
  await page.waitForFunction(
    () => document.querySelectorAll('#modelRows tr').length > 0,
    null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const badge = (await page.textContent('#srcBadge').catch(() => '') || '').trim();
  const hint = (await page.textContent('#srcHint').catch(() => '') || '').trim();
  const cred = (await page.textContent('#srcCredState').catch(() => '') || '').trim();

  // 每张提供商卡片的关键信息
  const cards = await page.$$eval('.pcard', (nodes) => nodes.map((n) => ({
    name: (n.querySelector('h3')?.textContent || '').trim(),
    stripSrc: (n.querySelector('.strip-src')?.textContent || '').trim(),
    stats: Array.from(n.querySelectorAll('.ustat')).map((s) => ({
      k: (s.querySelector('.u-k')?.textContent || '').trim(),
      v: (s.querySelector('.u-v')?.textContent || '').trim(),
    })),
    cols: getComputedStyle(n.querySelector('.usage-strip') || n).gridTemplateColumns,
  })));

  const bal = await page.$$eval('.pcard', (nodes) => nodes.map((n) => ({
    name: (n.querySelector('h3')?.textContent || '').trim(),
    text: (n.textContent || '').replace(/\s+/g, ' '),
  })));

  const rows = await page.$$eval('#modelRows tr', (trs) => trs.map((tr) => {
    const td = Array.from(tr.querySelectorAll('td'));
    return { cells: td.map((c) => c.textContent.trim().replace(/\s+/g, ' ')), tag: (tr.querySelector('.costonly-tag')?.textContent || '').trim() };
  }));

  const bars = await page.$$eval('#trendChart rect.bar, #trendChart rect[class*="bar"]', (n) => n.length).catch(() => 0);
  const legend = await page.textContent('#legend').catch(() => '');
  const tableNote = await page.textContent('#tableNote').catch(() => '');
  const tapeCost = (await page.textContent('#tapeCost7V').catch(() => '') || '').trim();
  const nProvApi = await page.evaluate(async () => {
    const r = await fetch('/api/data', { cache: 'no-store' });
    const j = await r.json();
    return (j.providers || []).length;
  }).catch(() => -1);

  const dupNames = (() => {
    const seen = {}, dup = [];
    for (const c of cards) { if (seen[c.name]) dup.push(c.name); seen[c.name] = 1; }
    return dup;
  })();

  // 文字溢出审计（必须在断言前算好）
  const overflow = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('.pcard, .tbl, .src-bar, .tape, .ustat, #modelRows td, .strip-src').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') {
        bad.push({ cls: el.className, sw: el.scrollWidth, cw: el.clientWidth, t: (el.textContent || '').slice(0, 40) });
      }
    });
    return bad;
  });

  const checks = [];
  const add = (name, ok, got) => checks.push({ name, ok: !!ok, got });
  /* 跳过：环境问题（票据过期 / 官网限流）不该把测试判红，但要在输出里留痕 */
  const skip = (name, got) => checks.push({ name, ok: true, skip: true, got });
  add('无 #srcSeg 旧切换器', (await page.$('#srcSeg')) === null, '-');
  add('状态条显示官网实时', /官网实时/.test(badge), badge);
  add('卡片数 == 提供商数', cards.length === nProvApi, cards.length + ' vs ' + nProvApi);
  add('卡片名不重复（无兜底重复条目）', dupNames.length === 0, dupNames.join(',') || '-');
  /* 平台侧原始状态先拿一份：官网限流（429）/ 票据失效都属于环境问题，
     不该被当成代码回归 —— 这时改验「界面有没有如实说明 + 正确回落」。 */
  const plat = await (await fetch(BASE.replace(/\/+$/, '') + '/api/platform?days=30')
    .catch(() => ({ json: async () => ({}) }))).json().catch(() => ({}));
  const recOf = (kind) => Object.values(plat.usage || {}).find((r) => r && r.kind === kind) || {};
  const dsrec = recOf('deepseek');
  if (dsrec.status === 'error') {
    skip('DeepSeek 官网口径断言（本次读取失败：' + String(dsrec.detail || '').slice(0, 36) + '）');
    add('DeepSeek 读取失败时卡片如实标注并回落本地记录',
        cards.some((c) => /DeepSeek/.test(c.name) && /读取失败|凭据失效/.test(c.stripSrc)),
        cards.filter((c) => /DeepSeek/.test(c.name)).map((c) => c.stripSrc).join(' | ') || '-');
  } else {
    add('DeepSeek 卡片走官网口径',
        cards.some((c) => /DeepSeek/.test(c.name) && /官网实时/.test(c.stripSrc)), '-');
  }
  add('Kimi 卡片走官网口径', cards.some((c) => /Kimi/.test(c.name) && /官网实时/.test(c.stripSrc)), '-');
  add('Kimi 卡片标注仅金额', cards.some((c) => /Kimi/.test(c.name) && /仅提供金额/.test(c.stripSrc)), '-');
  add('Kimi 用量条收成 3 格', cards.some((c) => /Kimi/.test(c.name) && (c.cols.match(/px/g) || []).length === 3),
      cards.map((c) => c.name + ':' + (c.cols.match(/px/g) || []).length).join(' '));
  add('官网卡片披露人民币原值', /官网实扣 ¥|官网计价 ¥/.test(cards.map((c) => c.stripSrc).join(' ')), '-');
  /* —— 币种：全站唯一口径是人民币，任何位置都不该再出现 $ —— */
  const moneyTexts = [
    ...cards.map((c) => c.stripSrc + ' ' + c.stats.map((s) => s.k + '=' + s.v).join(' ')),
    ...rows.flatMap((r) => r.cells),
    ...bal.map((b) => b.text),
    tapeCost, tableNote,
  ];
  const dollarLeak = moneyTexts.filter((s) => /\$/.test(String(s)));
  add('全站金额只用人民币（无 $ 残留）', dollarLeak.length === 0,
      dollarLeak.slice(0, 2).map((s) => String(s).slice(0, 60)).join(' | ') || '-');
  add('总览带消耗以 ¥ 开头', /^¥/.test(tapeCost), tapeCost);
  add('明细表消耗列以 ¥ 开头（或 —）',
      rows.length > 0 && rows.every((r) => /^¥/.test(r.cells[6] || '') || (r.cells[6] || '') === '—'),
      rows.map((r) => r.cells[6]).join(' / '));
  add('模型表出现「金额口径」标记', rows.some((r) => r.tag === '金额口径'), '-');
  add('标记行的 token 列显示 — 而非 0',
      rows.filter((r) => r.tag === '金额口径').every((r) => r.cells[2] === '—'), '-');
  /* —— 智谱 GLM：官网费用账单口径（有 token、无请求数） ——
     智谱凭据是控制台会话票据（约 7 天），天然会过期。票据一失效，官网口径本就取不到数，
     这属于用户环境问题、不是代码回归：此时改验「失效提示 + 回落本地记录」，
     官网口径那几条标为跳过，避免一套绿测试被一张过期票据长期拖红。 */
  const zn = (c) => /智谱|GLM/.test(c.name);
  const zrec = recOf('zhipu');
  const zExpired = zrec.status === 'expired';
  const zDown = zrec.status === 'error';
  if (zExpired || zDown) {
    skip('智谱官网口径断言（本次读取失败：' + String(zrec.detail || '').slice(0, 30) + '）');
    add('智谱读取失败时给出可操作提示',
        /票据|重新获取|限流|稍后/.test(zrec.detail || ''), zrec.detail);
    add('智谱读取失败时卡片如实标注并回落本地记录',
        cards.some((c) => zn(c) && /凭据失效|读取失败/.test(c.stripSrc)),
        cards.filter(zn).map((c) => c.stripSrc).join(' | ') || '-');
    add('智谱读取失败时明细表说明回落原因',
        /凭据已失效|官网未接通/.test(tableNote), tableNote.slice(0, 80));
  } else {
    add('智谱卡片走官网口径', cards.some((c) => zn(c) && /官网实时/.test(c.stripSrc)), '-');
    add('智谱卡片标注不提供请求数',
        cards.some((c) => zn(c) && /不提供请求数/.test(c.stripSrc)), '-');
    add('智谱卡片「请求」显示 — 而非 0',
        cards.some((c) => zn(c) && c.stats.some((s) => s.k === '请求' && s.v === '—')), '-');
    add('智谱用量条保留 4 格（有 token 口径）',
        cards.some((c) => zn(c) && (c.cols.match(/px/g) || []).length === 4),
        cards.map((c) => c.name + ':' + (c.cols.match(/px/g) || []).length).join(' '));
    add('智谱卡片有正数 token',
        cards.some((c) => zn(c) && c.stats.some((s) => /tok/.test(s.k) && s.v !== '0' && s.v !== '—')), '-');
    add('智谱模型表出现「无请求数」标记', rows.some((r) => r.tag === '无请求数'), '-');
    add('智谱余额显示官网可用余额（¥ 金额）',
        bal.some((b) => /智谱|GLM/.test(b.name) && /可用余额/.test(b.text) && /¥[\d.]+/.test(b.text)), '-');
  }
  /* 资源包余量：有剩余就必须显示，用尽（remaining=0）就必须不显示。
     账户状态会变，所以断言的是「界面 ⇔ 接口」的一致性，而不是某个固定数值。 */
  const packLeft = (((zrec.resource_pack || {}).remaining) || 0) > 0;
  const packShown = bal.some((b) => /智谱|GLM/.test(b.name) && /资源包余量/.test(b.text));
  add('智谱资源包余量：界面与接口一致（有剩余才显示）', packShown === packLeft,
      '接口 remaining>0? ' + packLeft + ' · 界面显示? ' + packShown);
  /* 状态条的覆盖家数应当等于「真正走了官网」的卡片数（凭据失效的那家不算） */
  const nLive = cards.filter((c) => /官网实时/.test(c.stripSrc)).length;
  add('状态条覆盖家数 == 走官网的卡片数',
      nLive === 0 ? /本地记录/.test(badge)
                  : new RegExp('官网实时 · ' + nLive + ' 家').test(badge), badge);
  /* —— 交付后优化：票据期限标注 —— */
  const expLines = await page.$$eval('.est-line.exp',
    (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  add('卡片标注登录票据期限',
      expLines.some((t) => /有效期至/.test(t)), expLines.join(' | ') || '-');
  add('有票据给出剩余天数/长期有效',
      expLines.some((t) => /剩 \d+ 天|已过期|长期有效/.test(t)), expLines.join(' | ') || '-');
  const stripInfo = await page.$eval('#expStrip', (n) => ({
    shown: !n.hidden, text: n.textContent.replace(/\s+/g, ' ').trim(),
  })).catch(() => null);
  add('票据提醒条元素存在', !!stripInfo, stripInfo ? (stripInfo.shown ? 'shown' : 'hidden') : 'missing');
  add('提醒条内容含提供商与票据状态',
      !stripInfo || !stripInfo.shown ||
      (/剩 \d+ 天|已过期|已失效/.test(stripInfo.text) && /DeepSeek|Kimi|智谱|GLM/.test(stripInfo.text)),
      stripInfo ? (stripInfo.shown ? stripInfo.text.slice(0, 90) : 'hidden') : '-');
  add('趋势图有柱子', bars > 0, String(bars));
  add('表注说明折算与金额口径', /折算/.test(tableNote) && /金额口径/.test(tableNote), '-');
  add('无文字溢出', overflow.length === 0, JSON.stringify(overflow));
  add('无控制台错误', errs.length === 0, errs.join(' | '));

  await page.screenshot({ path: path.join(SHOTS, 'shot_real_light.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'shot_real_dark.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });

  /* —— 交付后优化：按提供商单独设阈值（设置弹窗） —— */
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  const lowNames = await page.$$eval('#lowEdits .re-edit .re-name', (ns) => ns.map((n) => n.textContent.trim()));
  const lowInputs = await page.$$('#lowEdits .re-edit input[type=number]');
  add('设置里有「按提供商阈值」输入行', lowNames.length === cards.length,
      lowNames.join(',') + ' vs ' + cards.length);
  add('每行都是数字输入框', lowInputs.length === cards.length, String(lowInputs.length));
  const lowPh = lowInputs.length ? await lowInputs[0].getAttribute('placeholder') : '';
  add('阈值框提示回落全局默认', /默认/.test(lowPh || ''), lowPh || '-');
  if (lowInputs.length) {
    /* 填一个大到必然触发的值，验证「单家阈值」真的参与预警判定 */
    await lowInputs[0].fill('9999');
    await page.click('#btnSaveSettings');
    await page.waitForTimeout(1400);
    const lbp = await page.evaluate(async () => {
      const j = await (await fetch('/api/config', { cache: 'no-store' })).json();
      return j.config.low_balance_by_provider || {};
    });
    add('按提供商阈值已写入 config.json',
        Object.values(lbp).some((v) => Number(v) === 9999), JSON.stringify(lbp));
    /* 保存后要等界面按新阈值重绘（重绘会顺带刷新一遍数据，慢的时候 1.4s 不够），
       直接等标记出现，别拿固定 sleep 赌时间 */
    await page.waitForFunction(
      () => [...document.querySelectorAll('.bal-label .low-tag')]
        .some((n) => /低于预警 ¥9999/.test(n.textContent || '')),
      null, { timeout: 15000 }).catch(() => {});
    const lowTag = await page.$$eval('.bal-label .low-tag',
      (ns) => ns.map((n) => n.textContent.trim()));
    add('单家阈值触发卡片预警标记', lowTag.some((t) => /低于预警 ¥9999/.test(t)), lowTag.join(' | ') || '-');
    /* 复位，避免污染后续人工查看 */
    await page.click('#btnSettings');
    await page.waitForTimeout(250);
    await (await page.$$('#lowEdits .re-edit input[type=number]'))[0].fill('');
    await page.click('#btnSaveSettings');
    await page.waitForTimeout(1200);
    const lbp2 = await page.evaluate(async () => {
      const j = await (await fetch('/api/config', { cache: 'no-store' })).json();
      return j.config.low_balance_by_provider || {};
    });
    add('清空后回落全局默认（config 里已移除）', Object.keys(lbp2).length === 0, JSON.stringify(lbp2));
  }

  /* —— 平台凭据弹窗里的票据期限 —— */
  await page.click('#btnPlatformCreds');
  await page.waitForTimeout(350);
  const pfExp = await page.$$eval('#platformForm .pf-exp',
    (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  add('平台凭据弹窗标注票据期限', pfExp.length >= 1, pfExp.join(' | ') || '-');
  await page.screenshot({ path: path.join(SHOTS, 'shot_real_platform.png'), fullPage: false });
  await page.click('#btnClosePlatform');

  const report = { base: BASE, badge, hint, cred, cards, rowCount: rows.length, rows, bars, legend: (legend || '').trim(), tableNote, overflow, dupNames, expLines, stripInfo, pfExp, checks, errors: errs };
  fs.writeFileSync(path.join(SHOTS, 'real_report.json'), JSON.stringify(report, null, 1), 'utf-8');

  console.log('== 验收 ==');
  for (const c of checks) {
    const tag = c.skip ? 'SKIP' : (c.ok ? 'PASS' : 'FAIL');
    console.log('  ' + tag + '  ' + c.name + (c.got && c.got !== '-' ? '   [' + c.got + ']' : ''));
  }
  const fails = checks.filter((c) => !c.ok && !c.skip);
  console.log(fails.length ? '\n>>> ' + fails.length + ' 项未通过' : '\n>>> 全部通过');
  console.log('\n== 状态条 ==');
  console.log('  badge :', badge);
  console.log('  hint  :', hint);
  console.log('  cred  :', cred);
  console.log('== 卡片 ==');
  for (const c of cards) {
    console.log('  [' + c.name + '] cols=' + c.cols);
    console.log('      ' + c.stripSrc);
    console.log('      ' + c.stats.map((s) => s.k + '=' + s.v).join('  '));
  }
  console.log('== 余额 ==');
  for (const b of bal) {
    console.log('  [' + b.name + '] ' + b.text.slice(0, 190));
  }
  console.log('== 模型表 (' + rows.length + ' 行) ==');
  for (const r of rows.slice(0, 14)) console.log('  ' + r.cells.join(' | ') + (r.tag ? '   <' + r.tag + '>' : ''));
  console.log('== 图表 ==  bars=' + bars + '  legend=' + (legend || '').trim());
  console.log('== 表注 == ' + (tableNote || '').trim());
  console.log('== 溢出 == ' + (overflow.length ? JSON.stringify(overflow) : '无'));
  console.log('== 票据期限 == ' + (expLines.join(' | ') || '无'));
  console.log('== 提醒条 == ' + (stripInfo ? (stripInfo.shown ? stripInfo.text : 'hidden') : 'missing'));
  console.log('== 凭据弹窗期限 == ' + (pfExp.join(' | ') || '无'));
  console.log('== 控制台错误 == ' + (errs.length ? errs.join(' | ') : '无'));
  await browser.close();
  if (fails.length) process.exitCode = 2;
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
