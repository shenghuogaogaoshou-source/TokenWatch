const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const base = process.argv[2] || 'http://127.0.0.1:8799/';
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#modelRows tr', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const rep = {};
  // 1) 保存一份假凭据，验证「已配置」态 / 失效态
  await page.click('#btnPlatformCreds');
  await page.waitForTimeout(600);
  await page.fill('#pf-deepseek-token', 'sk-bogus-0001');
  await page.click('#platformForm .pf-block[data-kind="deepseek"] .pf-acts .btn-primary');
  await page.waitForTimeout(9000);          // 保存 + 强制拉取（会走网络）
  rep.afterSaveSrc = await page.locator('#srcSeg button.on').getAttribute('data-src');
  rep.credState = (await page.locator('#srcCredState').textContent() || '').trim();
  rep.badge = (await page.locator('#platformForm .pf-block[data-kind="deepseek"] .pf-badge').textContent() || '').trim();
  rep.masked = (await page.locator('#platformForm .pf-block[data-kind="deepseek"] .pf-meta').textContent() || '').trim();
  rep.testHint = (await page.locator('#platformForm .pf-block[data-kind="deepseek"] input').getAttribute('value')) || '';
  await page.screenshot({ path: OUT + '/b1_saved.png' });

  // 2) 关闭弹窗看失效卡
  await page.click('#btnClosePlatform');
  await page.waitForTimeout(600);
  rep.platCard0Head = (await page.locator('#platformView .plat-card').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  rep.pill0 = (await page.locator('#platformView .plat-card').first().locator('.pc-pill').textContent().catch(() => '')) || '';
  rep.guideCards = await page.locator('#platformView .plat-card').count();
  await page.screenshot({ path: OUT + '/b2_expired_card.png', fullPage: true });

  // 3) 清除，恢复原状
  await page.click('#btnPlatformCreds');
  await page.waitForTimeout(600);
  await page.click('#platformForm .pf-block[data-kind="deepseek"] .pf-acts .pf-danger');
  await page.waitForTimeout(7000);
  rep.afterClearBadge = (await page.locator('#platformForm .pf-block[data-kind="deepseek"] .pf-badge').textContent() || '').trim();
  rep.afterClearState = (await page.locator('#srcCredState').textContent() || '').trim();
  await page.screenshot({ path: OUT + '/b3_cleared.png' });

  rep.errs = errs;
  console.log(JSON.stringify(rep, null, 2));
  await browser.close();
})();
